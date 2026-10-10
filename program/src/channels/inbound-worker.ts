import { randomBytes } from "node:crypto";

import { createDiscordGateway, type DiscordGateway, type DiscordGatewayStatus, type GatewaySocketFactory, type Timers } from "./discord-gateway.js";
import { inboundConsumerKey, sha256Hex } from "./inbound-http.js";
import { TELEGRAM_WEBHOOK_PREFIX } from "./inbound-routes.js";
import { INBOUND_TEXT_RETENTION_BOUNDS, type InboundRouteRecord, type InboundSettings, type InboundStore } from "./inbound-store.js";
import { TELEGRAM_WEBHOOK_UPDATES } from "./providers/telegram.js";
import type { ChannelProviderId, InboundMessage } from "./providers/types.js";
import type { ChannelProviderRegistry } from "./runtime.js";
import type { ChannelRecord } from "./store.js";

/**
 * The inbound worker's long-lived parts (Channels P2 scope 2.2 item 1) and the owner's inbound switches.
 *
 * - Discord: one gateway connection per bot token, started only while at least one Discord channel has an
 *   enabled route and the bot credential is available; restarted when the owner changes the Message Content
 *   setting; stopped when the last route goes. Consumer lease per token (`discord:<sha256 prefix>`).
 * - Telegram: the owner's first enabled Telegram route sets the webhook (random path segment + secret token,
 *   only their SHA-256 is stored; allowed updates message, channel_post, edited_message, my_chat_member); the
 *   last disabled route deletes it. Before setting, getWebhookInfo must show no webhook of another host/path
 *   (another consumer of the same bot): else `channel_consumer_conflict`.
 * - Slack and Teams receive on their public routes; a route needs the Slack signing secret / the Teams app.
 *
 * Inert mode: without credentials nothing starts (the worker is never reconciled) and the switches refuse.
 */

export const DISCORD_LEASE_TTL_MS = 60_000;
export const DISCORD_LEASE_RENEW_MS = 20_000;

export type InboundSwitchResult =
  | { ok: true; route: InboundRouteRecord; receiver: Record<string, unknown> }
  | { ok: false; status: number; error: string; detail?: string };

export type InboundWorkerDeps = {
  organizationId: string;
  inbound: InboundStore;
  providers: ChannelProviderRegistry;
  now: () => Date;
  instanceId: string;
  /** Credential value while the provider is available, else null (never logged). */
  credential: (provider: ChannelProviderId) => string | null;
  connectionId: (provider: ChannelProviderId) => string | null;
  slackSigningSecretSet: () => boolean;
  teamsConfigured: () => boolean;
  /** `MARKETPLACE_PUBLIC_ORIGIN` (https), for the Telegram webhook URL. */
  publicOrigin: string | null;
  agentConsented: (agentId: string, channel: ChannelRecord) => boolean;
  ingest: (message: InboundMessage) => void;
  /** The id of the pipeline's current sink (`null` until the Buzz bridge plugs in). */
  sinkId?: () => string;
  audit: (eventType: string, actorId: string, metadata: Record<string, unknown>) => void;
  socketFactory?: GatewaySocketFactory;
  timers?: Timers;
  random?: () => number;
};

export type InboundWorker = ReturnType<typeof createInboundWorker>;

const consumerKey = inboundConsumerKey;

type TelegramHealth = { state: "ok" | "conflict" | "unhealthy" | "stale"; detail?: string };

export function createInboundWorker(deps: InboundWorkerDeps) {
  const org = deps.organizationId;
  let gateway: DiscordGateway | null = null;
  let gatewayKey: string | null = null;
  let gatewayStatus: { status: DiscordGatewayStatus; detail?: string } = { status: "stopped" };
  let stopped = false;
  // Telegram webhook changes run one at a time (review F3): enable and disable never interleave their API calls.
  let telegramChain: Promise<unknown> = Promise.resolve();
  const telegramSerial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = telegramChain.then(run, run);
    telegramChain = next.catch(() => undefined);
    return next;
  };
  let telegramHealth: TelegramHealth | null = null;
  const telegramKey = () => {
    const credential = deps.credential("telegram");
    return credential ? consumerKey("telegram", credential) : null;
  };

  const publicOrigin = (() => {
    try {
      const url = new URL(deps.publicOrigin ?? "");
      return url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  })();

  // ----- Discord ---------------------------------------------------------------

  const stopGateway = () => {
    gateway?.stop();
    gateway = null;
    gatewayKey = null;
  };

  const reconcileDiscord = () => {
    if (stopped) return;
    const credential = deps.credential("discord");
    const wanted = credential !== null && deps.inbound.enabledRoutesFor(org, "discord").length > 0;
    if (!wanted) {
      stopGateway();
      gatewayStatus = { status: "stopped" };
      return;
    }
    const settings = deps.inbound.getSettings(org);
    const key = consumerKey("discord", credential);
    if (gateway && gatewayKey === key && gateway.messageContent === settings.discordMessageContent && gateway.status !== "failed") return;
    stopGateway();
    gatewayKey = key;
    gateway = createDiscordGateway({
      token: credential,
      messageContent: settings.discordMessageContent,
      lease: {
        acquire: () => deps.inbound.acquireLease({ consumerKey: key, holder: deps.instanceId, now: deps.now(), ttlMs: DISCORD_LEASE_TTL_MS }),
        release: () => deps.inbound.releaseLease(key, deps.instanceId),
      },
      onMessage: deps.ingest,
      onStatus: (status, detail) => {
        const previous = gatewayStatus.status;
        gatewayStatus = { status, ...(detail ? { detail } : {}) };
        if (status !== previous && (status === "ready" || status === "failed" || status === "waiting_lease")) {
          deps.audit("marketplace.channels.inbound.discord_gateway", "marketplace:inbound", { status, ...(detail ? { detail } : {}) });
        }
      },
      leaseRenewMs: DISCORD_LEASE_RENEW_MS,
      ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
      ...(deps.timers ? { timers: deps.timers } : {}),
      ...(deps.random ? { random: deps.random } : {}),
    });
    gateway.start();
  };

  // ----- Telegram webhook ----------------------------------------------------------

  const telegramWebhookPrefix = () => (publicOrigin ? `${publicOrigin}${TELEGRAM_WEBHOOK_PREFIX}` : null);

  const ensureTelegramWebhook = async (): Promise<{ ok: true } | { ok: false; status: number; error: string; detail?: string }> => {
    const adapter = deps.providers.telegram;
    const credential = deps.credential("telegram");
    const connectionId = deps.connectionId("telegram");
    if (!adapter?.setWebhook || !adapter.webhookInfo || !credential || !connectionId) return { ok: false, status: 503, error: "channel_credential_unavailable" };
    const key = consumerKey("telegram", credential);
    const active = deps.inbound.activeWebhook(org, "telegram");
    if (active && active.consumerKey === key) return { ok: true };
    if (active) {
      // Set for another bot token (review S1): its secret is no longer accepted; this token gets its own webhook.
      deps.inbound.markWebhookDeleted(org, "telegram", deps.now());
      deps.audit("marketplace.channels.inbound.webhook_stale", "marketplace:inbound", { provider: "telegram" });
    }
    const prefix = telegramWebhookPrefix();
    if (!prefix) return { ok: false, status: 409, error: "channel_inbound_public_origin_missing", detail: "MARKETPLACE_PUBLIC_ORIGIN must be an https origin" };
    const info = await adapter.webhookInfo(credential);
    if (!info.ok) return { ok: false, status: info.errorCode === "credential_invalid" ? 409 : 503, error: `channel_${info.errorCode}` };
    // A webhook of another host or path means another consumer of this bot (a second Marketplace, a bot framework).
    if (info.url !== "" && !info.url.startsWith(prefix)) return { ok: false, status: 409, error: "channel_consumer_conflict" };
    const segment = randomBytes(32).toString("base64url");
    const secretToken = randomBytes(32).toString("base64url");
    const url = `${prefix}${segment}`;
    const set = await adapter.setWebhook(credential, { url, secretToken, allowedUpdates: TELEGRAM_WEBHOOK_UPDATES });
    if (set.status !== "sent") return { ok: false, status: set.status === "uncertain" ? 503 : 502, error: "channel_webhook_failed", ...(set.errorCode ? { detail: set.errorCode } : {}) };
    // Re-check after the write (review F3): another consumer may have set its own webhook in between.
    const after = await adapter.webhookInfo(credential);
    if (!after.ok || after.url !== url) {
      telegramHealth = { state: "conflict", detail: after.ok ? "webhook_replaced" : after.errorCode };
      return { ok: false, status: 409, error: "channel_consumer_conflict" };
    }
    deps.inbound.setWebhook({ workspaceSlug: org, provider: "telegram", connectionId, consumerKey: key, pathSha256: sha256Hex(segment), headerSha256: sha256Hex(secretToken), urlOrigin: publicOrigin!, now: deps.now() });
    telegramHealth = { state: "ok" };
    deps.audit("marketplace.channels.inbound.webhook_set", "marketplace:inbound", { provider: "telegram", origin: publicOrigin, allowedUpdates: TELEGRAM_WEBHOOK_UPDATES });
    return { ok: true };
  };

  const removeTelegramWebhookIfUnused = async (): Promise<{ ok: true } | { ok: false; status: number; error: string }> => {
    if (!deps.inbound.activeWebhook(org, "telegram")) return { ok: true };
    if (deps.inbound.enabledRoutesFor(org, "telegram").length > 0) return { ok: true };
    const adapter = deps.providers.telegram;
    const credential = deps.credential("telegram");
    if (!adapter?.deleteWebhook || !credential) return { ok: false, status: 503, error: "channel_credential_unavailable" };
    const removed = await adapter.deleteWebhook(credential);
    if (removed.status !== "sent") return { ok: false, status: 502, error: "channel_webhook_failed" };
    // Re-check after the write (review F3): our URL must be gone.
    const prefix = telegramWebhookPrefix();
    const after = adapter.webhookInfo ? await adapter.webhookInfo(credential) : null;
    if (after && (!after.ok || (prefix !== null && after.url.startsWith(prefix)))) {
      telegramHealth = { state: "unhealthy", detail: after.ok ? "webhook_still_set" : after.errorCode };
      return { ok: false, status: 502, error: "channel_webhook_failed" };
    }
    deps.inbound.markWebhookDeleted(org, "telegram", deps.now());
    telegramHealth = null;
    deps.audit("marketplace.channels.inbound.webhook_deleted", "marketplace:inbound", { provider: "telegram" });
    return { ok: true };
  };

  // ----- owner switches --------------------------------------------------------------

  const receiverView = () => {
    const telegram = deps.inbound.getWebhook(org, "telegram");
    return {
      sink: deps.sinkId?.() ?? "null",
      slack: { signingSecret: deps.slackSigningSecretSet() },
      telegram: {
        ...(telegram ? { webhook: telegram.status, origin: telegram.urlOrigin, setAt: telegram.setAt } : { webhook: "none" }),
        ...(telegramHealth ? { health: telegramHealth.state, ...(telegramHealth.detail ? { healthDetail: telegramHealth.detail } : {}) } : {}),
      },
      discord: { gateway: gatewayStatus.status, ...(gatewayStatus.detail ? { detail: gatewayStatus.detail } : {}), messageContent: deps.inbound.getSettings(org).discordMessageContent },
      teams: { configured: deps.teamsConfigured() },
    };
  };

  /** The owner's per-channel inbound switch. Enabling runs the provider's receiver set-up first; nothing is half-on. */
  const setRoute = (input: { channel: ChannelRecord; enabled: boolean; agentId: string | null; actor: string }): Promise<InboundSwitchResult> =>
    input.channel.provider === "telegram" ? telegramSerial(() => applyRoute(input)) : applyRoute(input);

  /**
   * After start: a Telegram webhook set for another bot token is stale (review S1). It stops accepting updates
   * (the route compares the consumer key) and, while Telegram routes are enabled, this token's webhook is set.
   */
  const reconcileTelegram = () =>
    telegramSerial(async () => {
      const active = deps.inbound.activeWebhook(org, "telegram");
      const key = telegramKey();
      if (!active || !key || active.consumerKey === key) return;
      telegramHealth = { state: "stale" };
      if (deps.inbound.enabledRoutesFor(org, "telegram").length === 0) {
        deps.inbound.markWebhookDeleted(org, "telegram", deps.now());
        deps.audit("marketplace.channels.inbound.webhook_stale", "marketplace:inbound", { provider: "telegram" });
        return;
      }
      const ensured = await ensureTelegramWebhook();
      if (!ensured.ok) telegramHealth = { state: telegramHealth?.state === "conflict" ? "conflict" : "unhealthy", detail: ensured.error };
    });

  const applyRoute = async (input: { channel: ChannelRecord; enabled: boolean; agentId: string | null; actor: string }): Promise<InboundSwitchResult> => {
    const { channel } = input;
    const provider = channel.provider as ChannelProviderId;
    const current = deps.inbound.getRoute(org, channel.id);
    if (!input.enabled) {
      if (!current) return { ok: false, status: 404, error: "channel_inbound_route_not_found" };
      const route = deps.inbound.setRoute({ workspaceSlug: org, channelId: channel.id, agentId: current.agentId, enabled: false, actor: input.actor, now: deps.now() });
      deps.audit("marketplace.channels.inbound.route_disabled", input.actor, { channelId: channel.id, agentId: route.agentId, provider });
      if (provider === "telegram") {
        const removed = await removeTelegramWebhookIfUnused();
        if (!removed.ok) return { ok: true, route, receiver: { ...receiverView(), warning: removed.error } };
      }
      if (provider === "discord") reconcileDiscord();
      return { ok: true, route, receiver: receiverView() };
    }
    const agentId = input.agentId ?? current?.agentId ?? null;
    if (!agentId) return { ok: false, status: 400, error: "channel_inbound_agent_required" };
    if (channel.status !== "active") return { ok: false, status: 409, error: "channel_not_active" };
    const adapter = deps.providers[provider];
    if (!adapter || adapter.capabilities.inbound.mode === "none") return { ok: false, status: 422, error: "channel_capability_unavailable", detail: 'this provider does not declare "inbound"' };
    if (!deps.agentConsented(agentId, channel)) return { ok: false, status: 409, error: "channel_inbound_agent_not_consented" };
    if (provider === "slack" && !deps.slackSigningSecretSet()) return { ok: false, status: 409, error: "channel_inbound_signing_secret_missing" };
    if (provider === "teams" && !deps.teamsConfigured()) return { ok: false, status: 409, error: "channel_credential_unavailable" };
    if (provider === "discord" && !deps.credential("discord")) return { ok: false, status: 503, error: "channel_credential_unavailable" };
    if (provider === "telegram") {
      const ensured = await ensureTelegramWebhook();
      if (!ensured.ok) return ensured;
    }
    const route = deps.inbound.setRoute({ workspaceSlug: org, channelId: channel.id, agentId, enabled: true, actor: input.actor, now: deps.now() });
    deps.audit("marketplace.channels.inbound.route_enabled", input.actor, { channelId: channel.id, agentId, provider });
    if (provider === "discord") reconcileDiscord();
    return { ok: true, route, receiver: receiverView() };
  };

  const updateSettings = (input: { textRetentionDays?: number; discordMessageContent?: boolean; actor: string }): { ok: true; settings: InboundSettings } | { ok: false; status: number; error: string } => {
    if (
      input.textRetentionDays !== undefined &&
      (!Number.isInteger(input.textRetentionDays) || input.textRetentionDays < INBOUND_TEXT_RETENTION_BOUNDS.min || input.textRetentionDays > INBOUND_TEXT_RETENTION_BOUNDS.max)
    ) {
      return { ok: false, status: 422, error: "channel_inbound_retention_invalid" };
    }
    const settings = deps.inbound.updateSettings({ workspaceSlug: org, ...input, now: deps.now() });
    deps.audit("marketplace.channels.inbound.settings_updated", input.actor, { textRetentionDays: settings.textRetentionDays, discordMessageContent: settings.discordMessageContent });
    reconcileDiscord();
    return { ok: true, settings };
  };

  return {
    /** Starts or stops the long-lived parts to match the routes and the current credentials (after boot). */
    async reconcile(): Promise<void> {
      reconcileDiscord();
      await reconcileTelegram();
    },
    setRoute,
    updateSettings,
    receiverView,
    get discordGateway(): DiscordGateway | null {
      return gateway;
    },
    stop(): void {
      stopped = true;
      stopGateway();
    },
  };
}

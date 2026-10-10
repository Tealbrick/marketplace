import type { FastifyInstance } from "fastify";

import type { BlockList } from "node:net";

import { createSourceBudget, createSourceResolver, headerValue, matchesDigest, type SourceRate } from "./inbound-http.js";
import type { InboundStore } from "./inbound-store.js";
import { SLACK_SIGNATURE_MAX_SKEW_SECONDS, acceptSlackEvent, createSlackEventDedupe } from "./providers/slack.js";
import { parseTelegramUpdate, telegramChatsFromUpdate } from "./providers/telegram.js";
import type { ChannelProviderId, InboundMessage } from "./providers/types.js";

/**
 * Public inbound receivers at the Marketplace level (Channels P2 scope 2.2), with the protections of the Teams
 * messaging endpoint: exact paths, a per-source budget and a cheap header check in `onRequest` (before the body
 * is read or parsed, and without waiting for start-up), a small body limit, then full verification. They are
 * not manifest operations (agents never call them) and need no operator session or Portal grant: each request
 * is authenticated by the provider's own proof. Received text is untrusted data.
 *
 * - Slack Events API: `acceptSlackEvent` (signature v0 over the raw body ±5 minutes, the connection's team, the
 *   `event_id` replay store); `url_verification` answers the challenge; retries (`X-Slack-Retry-Num`) are dropped
 *   by the replay store, and the pipeline also de-duplicates by channel + message ts.
 * - Telegram webhook: a random path segment and `X-Telegram-Bot-Api-Secret-Token`, both compared with the
 *   SHA-256 digests Marketplace stored when it called setWebhook. Every update feeds the chats-seen table
 *   (discovery while a webhook is set); messages go to the pipeline (edits are not delivered again).
 */
export const SLACK_EVENTS_PATH = "/api/marketplace/channels/slack/events";
export const TELEGRAM_WEBHOOK_PREFIX = "/api/marketplace/channels/telegram/webhook/";
/** The random path segment: 32 random bytes, base64url (43 characters). */
export const TELEGRAM_WEBHOOK_SEGMENT = /^[A-Za-z0-9_-]{43}$/u;
const TELEGRAM_SECRET_HEADER_SHAPE = /^[A-Za-z0-9_-]{1,256}$/u;
const SLACK_SIGNATURE_SHAPE = /^v0=[0-9a-f]{64}$/u;
const SLACK_TIMESTAMP_SHAPE = /^[0-9]{1,12}$/u;

export function isInboundPublicPath(pathname: string): boolean {
  return pathname === SLACK_EVENTS_PATH || (pathname.startsWith(TELEGRAM_WEBHOOK_PREFIX) && TELEGRAM_WEBHOOK_SEGMENT.test(pathname.slice(TELEGRAM_WEBHOOK_PREFIX.length)));
}

const MAX_BODY_BYTES = 128 * 1024;

/** Slack and Telegram send from a few provider addresses: a burst of 120, then 4 per second, per source. */
export const INBOUND_ROUTE_RATE: SourceRate = Object.freeze({ capacity: 120, refillPerSecond: 4 });

export type InboundRoutesDeps = {
  app: FastifyInstance;
  organizationId: string;
  /** False in inert mode (no channel credential): the routes refuse after the cheap checks and do no work. */
  configured: boolean;
  ready: Promise<void>;
  now: () => Date;
  inbound: InboundStore;
  slackSigningSecret: () => string | null;
  /** The connection's Slack team (auth.test); an event for another team is acknowledged and ignored (review F6). */
  slackTeamId?: () => string | null;
  /** The consumer key of the current Telegram credential (null without one): a webhook set for another token is stale. */
  telegramConsumerKey: () => string | null;
  botIdFor: (provider: ChannelProviderId) => string | null;
  ingest: (message: InboundMessage) => void;
  /**
   * Review R8: resolves once every send to this platform chat that is still in flight has returned and recorded its
   * message ids (bounded). The Telegram self-loop check waits for it before it reads the ids.
   */
  awaitOutbound?: (provider: ChannelProviderId, chatId: string) => Promise<void>;
  rate?: SourceRate;
  clock?: () => number;
  /** Trusted reverse proxies (`MARKETPLACE_TRUSTED_PROXIES`, parsed); null: the socket address is the source. */
  trustedProxies?: BlockList | null;
};

export function registerInboundRoutes(deps: InboundRoutesDeps): void {
  // One budget per route: a flood on one provider's route never spends another's.
  const slackBudget = createSourceBudget(deps.rate ?? INBOUND_ROUTE_RATE, deps.clock);
  const telegramBudget = createSourceBudget(deps.rate ?? INBOUND_ROUTE_RATE, deps.clock);
  const sourceOf = createSourceResolver(deps.trustedProxies ?? null);
  const nowMs = () => (deps.clock ?? (() => deps.now().getTime()))();
  const slackDedupe = createSlackEventDedupe(() => nowMs());
  const hand = (message: InboundMessage) => {
    try {
      deps.ingest(message);
    } catch {
      // The pipeline never blocks the acknowledgement; the provider would only retry the same event.
    }
  };

  // Raw body for the Slack signature, in its own encapsulated scope (only this route reads bytes).
  deps.app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES }, (_request, body, done) => done(null, body));
    scope.post(
      SLACK_EVENTS_PATH,
      {
        bodyLimit: MAX_BODY_BYTES,
        onRequest: async (request, reply) => {
          reply.header("cache-control", "no-store");
          if (!slackBudget.take(sourceOf(request))) {
            await reply.code(429).header("retry-after", "30").send({ error: "slack_rate_limited" });
            return reply;
          }
          const signature = headerValue(request, "x-slack-signature");
          const timestamp = headerValue(request, "x-slack-request-timestamp");
          if (!signature || !timestamp || !SLACK_SIGNATURE_SHAPE.test(signature) || !SLACK_TIMESTAMP_SHAPE.test(timestamp)) {
            await reply.code(401).send({ error: "slack_signature_invalid", reason: "header_missing" });
            return reply;
          }
          if (Math.abs(Math.floor(nowMs() / 1000) - Number(timestamp)) > SLACK_SIGNATURE_MAX_SKEW_SECONDS) {
            await reply.code(401).send({ error: "slack_signature_invalid", reason: "stale" });
            return reply;
          }
          return undefined;
        },
      },
      async (request, reply) => {
        if (!deps.configured) return reply.code(503).send({ error: "channels_slack_inbound_not_configured" });
        await deps.ready;
        const secret = deps.slackSigningSecret();
        if (!secret) return reply.code(503).send({ error: "channels_slack_inbound_not_configured" });
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        // One implementation (the Slack adapter's): signature over the raw body, the connection's team, then the
        // event_id replay store. The reason is a fixed code; the signature and the secret are never echoed or logged.
        const botUserId = deps.botIdFor("slack");
        const decision = acceptSlackEvent({
          signingSecret: secret,
          timestamp: headerValue(request, "x-slack-request-timestamp"),
          signature: headerValue(request, "x-slack-signature"),
          rawBody: raw,
          self: { teamId: deps.slackTeamId?.() ?? "", ...(botUserId ? { botUserId } : {}) },
          dedupe: slackDedupe,
          nowMs: nowMs(),
        });
        if (decision.kind === "rejected") return reply.code(401).send({ error: "slack_signature_invalid", reason: decision.reason });
        if (decision.kind === "url_verification") return reply.code(200).send({ challenge: decision.challenge });
        // A message of another team (or with no team), a duplicate event_id and other events: acknowledged, not routed.
        if (decision.kind === "message") hand(decision.message);
        return reply.code(200).send({});
      },
    );
  });

  /**
   * Review F4: Telegram sends the bot's own channel posts back as `channel_post` updates (sender = the channel, no
   * bot `from`). Such a post is ours when it came via our bot or carries a message id we posted to that chat in
   * the last 48 hours (receipts and the sent-message ledger). Review R8: the update can arrive before our
   * `sendMessage` call returns, so a send still in flight to that chat is awaited (bounded) before the ids are read;
   * the loop breaker's per-sender cap stays as the last guard.
   */
  const ownTelegramChannelPost = async (update: unknown, message: InboundMessage, botId: string | null): Promise<boolean> => {
    const record = update && typeof update === "object" ? (update as Record<string, unknown>) : {};
    const post = (record.channel_post ?? record.edited_channel_post) as Record<string, unknown> | undefined;
    if (!post || typeof post !== "object") return false;
    const viaBot = post.via_bot as { id?: unknown } | undefined;
    if (botId && viaBot && String(viaBot.id) === botId) return true;
    if (deps.awaitOutbound) await deps.awaitOutbound("telegram", message.channelId);
    const since = new Date(deps.now().getTime() - 48 * 3_600_000);
    return deps.inbound.recentOutboundMessageIds(deps.organizationId, "telegram", message.channelId, since).has(message.messageId);
  };

  deps.app.post(
    `${TELEGRAM_WEBHOOK_PREFIX}:segment`,
    {
      bodyLimit: MAX_BODY_BYTES,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!telegramBudget.take(sourceOf(request))) {
          await reply.code(429).header("retry-after", "30").send({ error: "telegram_rate_limited" });
          return reply;
        }
        const pathname = request.url.split("?", 1)[0] ?? "";
        if (!TELEGRAM_WEBHOOK_SEGMENT.test(pathname.slice(TELEGRAM_WEBHOOK_PREFIX.length))) {
          await reply.code(404).send({ error: "not_found" });
          return reply;
        }
        const header = headerValue(request, "x-telegram-bot-api-secret-token");
        if (!header || !TELEGRAM_SECRET_HEADER_SHAPE.test(header)) {
          await reply.code(401).send({ error: "telegram_secret_invalid", reason: "header_missing" });
          return reply;
        }
        // Both digests are checked here, before the body is read or parsed (review F8).
        if (!deps.configured) {
          await reply.code(404).send({ error: "not_found" });
          return reply;
        }
        await deps.ready;
        const webhook = deps.inbound.activeWebhook(deps.organizationId, "telegram");
        const segment = pathname.slice(TELEGRAM_WEBHOOK_PREFIX.length);
        // An unknown or old path, or a webhook set for another bot token (stale, review S1), looks like no route at all.
        const currentKey = deps.telegramConsumerKey();
        if (!webhook || !currentKey || webhook.consumerKey !== currentKey || !matchesDigest(segment, webhook.pathSha256)) {
          await reply.code(404).send({ error: "not_found" });
          return reply;
        }
        if (!matchesDigest(header, webhook.headerSha256)) {
          await reply.code(401).send({ error: "telegram_secret_invalid", reason: "mismatch" });
          return reply;
        }
        return undefined;
      },
    },
    async (request, reply) => {
      const update = request.body;
      const now = deps.now();
      const seen = telegramChatsFromUpdate(update);
      if (seen.leftChatId) deps.inbound.markTelegramChatLeft(deps.organizationId, seen.leftChatId, now);
      if (seen.destinations.length > 0) deps.inbound.recordTelegramDestinations(deps.organizationId, seen.destinations, now);
      const botId = deps.botIdFor("telegram");
      const parsed = parseTelegramUpdate(update, botId ? { botId } : {});
      if (parsed.kind === "message" && !parsed.edited && !(await ownTelegramChannelPost(update, parsed.message, botId))) hand(parsed.message);
      return reply.code(200).send({});
    },
  );
}

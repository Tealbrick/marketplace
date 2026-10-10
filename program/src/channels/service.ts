import { randomUUID } from "node:crypto";

import type { FastifyReply } from "fastify";

import { ConsentedExecutionOutcome, type ExecutionPreparation, type ExecutionTarget } from "../execution-targets.js";
import type { GovernanceActor, GovernedActionRisk } from "../governance.js";
import type { SqliteMarketplaceStore } from "../store.js";
import type { CompanyBoxApproval, ConnectorCapability, ConnectorUsageLedgerEntry, MarketplaceAgentConsent } from "../types.js";
import { NOSTR_MIN_PREFIX_HEX } from "./approvals.js";
import type { BuzzIdentity } from "./buzz-identity.js";
import { createGrantService, type GrantService } from "./grants.js";
import { eventHostAllowed, eventListingStatus, grantCoversPost, maxPendingPerAgent, type PostCampaign } from "./policy.js";
import { wiredCapabilities } from "./providers/capabilities.js";
import { parseTeamsCredential } from "./providers/teams.js";
import { npubEncode } from "./providers/nostr.js";
import type { ActionResult, ChannelCapabilities, ChannelDestination as ProviderDestination, ChannelProvider, ChannelProviderId, DiscoverResult, SendResult } from "./providers/types.js";
import type { PersonRecord } from "./actions-store.js";
import { PERSON_LOOKUPS_PER_DAY, normalizePersonQuery, peoplePolicyLookupRefusal, peoplePolicyRefusal, personLookupOf, type PersonLookup } from "./people.js";
import {
  CHANNEL_PROVIDER_IDS,
  CHANNEL_SECRET_NAME,
  buildChannelPayload,
  channelPluginId,
  checkChannelContent,
  destinationKey,
  isChannelProviderId,
  postOpSpecOf,
  redactSecrets,
  resolveChannelCredential,
  resolveSlackSigningSecret,
  toProviderDestination,
  type ChannelCredential,
  type ChannelPayload,
  type ChannelPostBody,
  type ChannelProviderRegistry,
  type ChannelReadiness,
  type ChannelRefusal,
  type ClassSelection,
} from "./runtime.js";
import { INBOUND_METADATA_RETENTION_MS } from "./inbound-store.js";
import {
  CHANNEL_ATTACHMENTS_SUBDIR,
  channelPostApprovalKey,
  type ChannelPostRecord,
  type ChannelReceiptRecord,
  type ChannelReceiptStatus,
  type ChannelRecord,
  type StandingGrantRecord,
} from "./store.js";

/**
 * Channels execution (spec §6): the channel half of `executeConsentedCall`.
 * The app verifies the Portal consent (shared head) and owns the shared tail
 * (governance → preparation → idempotency → provider call → usage ledger →
 * audit). This service resolves a channel call in the spec order — 3a channel
 * and capability, 3b content, 3c authority (standing grant, owner approval of
 * this exact digest, or a hold), then hands the tail a `channel-native`
 * execution target whose preparation is the 3d caps reservation. Nothing is
 * reserved, held or consumed before every earlier check passed.
 */

export const CHANNEL_SEND_LEASE_MS = 300_000;
/**
 * Internal idempotency key prefix of reply posts. The agent's key (header regex: no colon) is prefixed, so a reply
 * and a plain post can never share a post row, and the reply target is looked up only for reply posts.
 */
export const INBOUND_REPLY_KEY_PREFIX = "inbound-reply:";
/**
 * Routes v2 internal idempotency key prefixes (the agent's key has no colon): a reaction, edit, delete or direct
 * message never shares a post row with a plain post or with each other.
 */
export { ACTION_KEY_PREFIX } from "./store.js";
/** A delete or edit inside a provider window is refused this long before the window ends (the send may take time). */
const ACTION_WINDOW_MARGIN_MS = 60_000;
/** The inbound self-loop check waits at most this long for a send to the same chat to return (review R8). */
export const OUTBOUND_SETTLE_WAIT_MS = 10_000;
/** Receipt retention (§7): 90 days by default. */
export const CHANNEL_RECEIPT_RETENTION_MS = 90 * 86_400_000;
/** Stored attachment bytes per (workspace, agent): 200 MiB (follow-up Q1). */
export const CHANNEL_ATTACHMENT_QUOTA_BYTES = 200 * 1024 * 1024;
/** Uploads per agent in any 24 h window (follow-up Q1). */
export const CHANNEL_ATTACHMENT_UPLOADS_PER_DAY = 50;
/** An attachment no post references is deleted after this (follow-up Q1). */
export const CHANNEL_ATTACHMENT_UNREFERENCED_MS = 86_400_000;
/** Most attachment rows one tick cleans up. */
export const CHANNEL_ATTACHMENT_CLEANUP_BATCH = 100;
export const CHANNEL_SCHEDULER_LEASE_MS = 120_000;
export const CHANNEL_SCHEDULER_INTERVAL_MS = 30_000;
/** A scheduled post more than this late (downtime) is `expired`, never sent. */
export const CHANNEL_SCHEDULE_LATE_MS = 15 * 60_000;
export const CHANNEL_SCHEDULE_MIN_LEAD_MS = 60_000;
export const CHANNEL_SCHEDULE_MAX_LEAD_MS = 30 * 86_400_000;
/** The kit shows at most 16,000 characters of payload; a larger view is refused, never clipped (§6.2). */
export const CHANNEL_PAYLOAD_VIEW_MAX_CHARS = 16_000;
const APPROVAL_TTL_MS = 7 * 86_400_000;
const APPROVAL_MAX_PENDING_PER_AGENT = 50;
const DISCOVERY_TTL_MS = 15 * 60_000;
const FALLBACK_MARK = " · fallback ";
export const OWNER_TEST_TEXT = "Test message from Teal Brick Marketplace Channels. No action is needed.";

export type ConsentedDispatchInput = {
  reply: FastifyReply;
  traceId: string;
  via: "runtime-lease" | "app-grant";
  operationConsentId: string;
  idempotencyKey: string;
  fingerprintSource: unknown;
  pluginId: string;
  provider: string;
  sourceExecutor: ConnectorUsageLedgerEntry["sourceExecutor"];
  actionType: string;
  capability: ConnectorCapability;
  consentId: string;
  leaseId: string;
  actorId: string;
  governance: { actor: GovernanceActor; risk?: GovernedActionRisk; payload: Record<string, unknown> };
  ledgerInput: Record<string, unknown>;
  prepare: () => ExecutionPreparation;
};
export type ConsentedDispatch = (input: ConsentedDispatchInput) => Promise<Record<string, unknown>>;

export type ChannelCallScope = {
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  deploymentId: string;
  agentId: string;
  consentId: string;
  leaseId: string;
};

/** What the routes, the approval queue and the scheduler ask `executeConsentedCall` to do on a channel. */
export type ChannelCallPlan =
  | { selection: ClassSelection; channelId: string; mode: "post" | "schedule"; body: ChannelPostBody }
  | { selection: ClassSelection; channelId: string; mode: "approved-hold"; postId: string; approvalId: string }
  | { selection: ClassSelection; channelId: string; mode: "scheduled-send"; postId: string; claimer: string };

type ExecuteInput = ChannelCallPlan & {
  consent: MarketplaceAgentConsent;
  scope: ChannelCallScope;
  traceId: string;
  reply: FastifyReply;
  via: "runtime-lease" | "app-grant";
  idempotencyKey: string;
  dispatch: ConsentedDispatch;
};

type ChannelExecutionContext = {
  channel: ChannelRecord;
  /** `post` for posts, replies, polls and the owner test; else the routes v2 operation. */
  op: "post" | "react" | "edit" | "delete" | "dm";
  provider: ChannelProvider;
  reserve: () => { ok: true; post: ChannelPostRecord } | { ok: false; statusCode: number; error: string; detail?: Record<string, unknown> };
  send: (post: ChannelPostRecord) => Promise<ReceiptView>;
  release: (post: ChannelPostRecord) => void;
};

export type ReceiptView = {
  resultIds: string[];
  resultUrls: string[];
  status: ChannelReceiptStatus;
  detail: string | null;
  channelId: string;
  postId: string;
  digest: string;
  authority: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  provider: string;
  fallback?: string;
};

type Reply = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

/** Response headers of a `202 approval_pending` (the body is the strict contract shape, so these travel beside it). */
export const POST_ID_HEADER = "tealbrick-post-id";
export const TRACE_ID_HEADER = "x-trace-id";

/** A stand-in reply for calls that have no HTTP request (approval queue, scheduler). */
export function detachedReply(): FastifyReply & { statusCode: number } {
  const reply = {
    statusCode: 200,
    code(status: number) {
      reply.statusCode = status;
      return reply;
    },
    header() {
      return reply;
    },
    headers() {
      return reply;
    },
  };
  return reply as unknown as FastifyReply & { statusCode: number };
}

export function receiptView(receipt: ChannelReceiptRecord): ReceiptView {
  const fallbackAt = receipt.detail?.indexOf(FALLBACK_MARK) ?? -1;
  return {
    resultIds: receipt.resultIds,
    resultUrls: receipt.resultUrls,
    status: receipt.status,
    detail: receipt.detail,
    channelId: receipt.channelId,
    postId: receipt.postId,
    digest: receipt.digest,
    authority: receipt.authority,
    approvedAt: receipt.approvedAt,
    sentAt: receipt.sentAt,
    provider: receipt.provider,
    ...(fallbackAt >= 0 ? { fallback: receipt.detail!.slice(fallbackAt + FALLBACK_MARK.length) } : {}),
  };
}

/** The agent-facing channel response from the shared tail's response (receipt instead of the generic result). */
export function channelResponse(response: Record<string, unknown>): Record<string, unknown> {
  const { result, ...rest } = response as { result?: { details?: { result?: unknown } } } & Record<string, unknown>;
  const receipt = result?.details?.result;
  return { ...rest, ...(receipt !== undefined ? { receipt } : {}) };
}

export type ChannelServiceDeps = {
  store: SqliteMarketplaceStore;
  organizationId: string;
  dataDir: string;
  environment: Record<string, string | undefined>;
  providers: ChannelProviderRegistry;
  now: () => Date;
  eventFetch?: typeof fetch;
  instanceId: string;
  /** The Buzz connection identity (generated key in connector_secret, owner relay URL and NIP-OA tag). */
  buzzIdentity?: BuzzIdentity;
};

export type ChannelService = ReturnType<typeof createChannelService>;

export function createChannelService(deps: ChannelServiceDeps) {
  const store = deps.store;
  const channels = store.channels;
  const org = deps.organizationId;
  const attachmentsDir = `${deps.dataDir}/${CHANNEL_ATTACHMENTS_SUBDIR}`;
  const credentials = new Map<ChannelProviderId, ChannelCredential>();
  const readiness = new Map<ChannelProviderId, ChannelReadiness>();
  const discovered = new Map<ChannelProviderId, { at: number; destinations: Extract<DiscoverResult, { ok: true }>["destinations"] }>();
  const reserver = () => `${deps.instanceId}:${randomUUID().slice(0, 8)}`;

  const grants: GrantService = createGrantService({
    store: channels,
    now: deps.now,
    consentActive: (consentRowId) => store.getMarketplaceAgentConsentById(consentRowId)?.state === "active",
    audit: (eventType, grant, actorId, metadata) =>
      store.recordAudit({
        workspaceSlug: grant.workspaceSlug,
        pluginId: null,
        eventType,
        actorId,
        metadata: { grantId: grant.id, channelId: grant.channelId, agentId: grant.agentId, status: grant.status, digest: grant.digest, ...(metadata ?? {}) },
      }),
  });

  /** Inbound-only secrets (the Slack signing secret), read at start; redacted like the bot tokens. */
  const inboundSecrets: string[] = [];
  /** Every credential value this instance holds, for redaction before anything is written or answered. */
  const secrets = () => [...[...credentials.values()].flatMap((credential) => [credential.value, ...(credential.secrets ?? [])]), ...inboundSecrets];
  const redact = (text: string) => redactSecrets(text, secrets());

  const audit = (eventType: string, post: Pick<ChannelPostRecord, "id" | "channelId" | "agentId" | "digest" | "authority">, provider: string, metadata: Record<string, unknown> = {}) =>
    store.recordAudit({
      workspaceSlug: org,
      pluginId: channelPluginId(provider),
      eventType,
      actorId: post.agentId.startsWith("owner:") ? post.agentId : `agent:${post.agentId}`,
      // Metadata and the payload SHA-256 only (contract §12.8); the text stays in channel_receipt.
      metadata: { channelId: post.channelId, postId: post.id, digest: post.digest, authority: post.authority, provider, ...metadata },
    });

  // ----- connections and readiness (§4.1, §8) -------------------------------

  const readSecret = (pluginId: string, name: string = CHANNEL_SECRET_NAME) => {
    try {
      const value = store.readConnectorSecretValues({ workspaceSlug: org, pluginId })[name];
      if (!value) return null;
      const id = store.listConnectorSecrets({ workspaceSlug: org, pluginId }).find((secret) => secret.name === name)?.id;
      return id ? { value, id } : null;
    } catch {
      return null;
    }
  };

  const buzzCredential = () => deps.buzzIdentity?.credential() ?? null;

  /** Verify one provider credential; upsert the connection row (bot identity only). */
  const bootProvider = async (provider: ChannelProviderId) => {
    const adapter = deps.providers[provider];
    if (!adapter) return;
    const credential = resolveChannelCredential({ provider, environment: deps.environment, readSecret, buzz: buzzCredential });
    if (!credential) {
      credentials.delete(provider);
      readiness.set(provider, "credential_missing");
      return;
    }
    credentials.set(provider, credential);
    let verified;
    try {
      verified = await adapter.verify(credential.value);
    } catch {
      verified = { ok: false as const, reason: "provider_unavailable" as const };
    }
    const existing = store.getConnection(org, channelPluginId(provider));
    if (verified.ok) {
      readiness.set(provider, "available");
      store.upsertConnection({
        workspaceSlug: org,
        pluginId: channelPluginId(provider),
        provider,
        backend: "native",
        state: "connected",
        detail: `${provider} bot verified`,
        metadata: {
          botId: verified.botId,
          botUsername: verified.botUsername,
          ...(verified.teamId ? { teamId: verified.teamId } : {}),
          verifiedAt: deps.now().toISOString(),
          credentialRef: credential.ref,
        },
      });
    } else {
      readiness.set(provider, verified.reason === "provider_unavailable" ? "unavailable" : verified.reason);
      if (existing && verified.reason !== "provider_unavailable") {
        store.upsertConnection({
          workspaceSlug: org,
          pluginId: channelPluginId(provider),
          provider,
          backend: "native",
          state: "blocked",
          detail: `${provider} bot credential is ${verified.reason === "credential_invalid" ? "invalid" : "missing"}`,
          metadata: { ...existing.metadata, credentialRef: credential.ref },
        });
      }
    }
  };

  /** Verify each provider credential once at start. */
  const boot = async () => {
    const signingSecret = resolveSlackSigningSecret({
      environment: deps.environment,
      readSecretValue: (pluginId, name) => {
        try {
          return store.readConnectorSecretValues({ workspaceSlug: org, pluginId })[name] ?? null;
        } catch {
          return null;
        }
      },
    });
    inboundSecrets.splice(0, inboundSecrets.length, ...(signingSecret ? [signingSecret] : []));
    for (const provider of CHANNEL_PROVIDER_IDS) await bootProvider(provider);
  };

  /**
   * Inert mode (reviewer condition): true when at least one provider has a credential (env or
   * connector_secret). Read once at start, like the credentials themselves; no DB writes.
   */
  const configured = CHANNEL_PROVIDER_IDS.some(
    (provider) =>
      Boolean(deps.providers[provider]) && resolveChannelCredential({ provider, environment: deps.environment, readSecret, buzz: buzzCredential }) !== null,
  );

  /**
   * The provider readiness now. Buzz is re-checked against its stored identity on every read: a tag that expired,
   * was revoked or no longer names the pinned owner key makes it `credential_invalid` / `credential_missing` at once.
   */
  const currentReadiness = (provider: ChannelProviderId): ChannelReadiness => {
    const base = readiness.get(provider) ?? "credential_missing";
    if (provider !== "buzz" || base !== "available" || !deps.buzzIdentity) return base;
    const local = deps.buzzIdentity.readiness();
    return local === "available" ? base : local;
  };

  const readinessView = () =>
    Object.fromEntries(CHANNEL_PROVIDER_IDS.filter((provider) => deps.providers[provider]).map((provider) => [provider, currentReadiness(provider)]));

  const providerFor = (provider: string): ChannelProvider | null => (isChannelProviderId(provider) ? deps.providers[provider] ?? null : null);
  /** The effective declaration (adapter ∩ AGENT_WIRED_FEATURES): every agent-facing check and view reads this. */
  const capabilitiesFor = (provider: string): ChannelCapabilities | null => {
    const adapter = providerFor(provider);
    return adapter ? wiredCapabilities(adapter.capabilities) : null;
  };

  // ----- 3a ------------------------------------------------------------------

  const sendable = (channel: ChannelRecord): ChannelRefusal | null => {
    if (channel.status !== "active") return { status: 409, error: "channel_not_active" };
    const provider = providerFor(channel.provider);
    if (!provider) return { status: 422, error: "channel_capability_unavailable" };
    const connection = store.getConnection(org, channelPluginId(channel.provider));
    if (!connection || connection.id !== channel.connectionId || connection.state !== "connected") {
      return { status: 409, error: "channel_connection_unavailable" };
    }
    if (!isChannelProviderId(channel.provider) || !credentials.has(channel.provider) || currentReadiness(channel.provider) !== "available") {
      return { status: 503, error: "channel_credential_unavailable" };
    }
    return null;
  };

  // ----- 3b (with the live confirmed-event check at send time) ---------------

  const contentRefusal = async (channel: ChannelRecord, payload: ChannelPayload, mode: "immediate" | "scheduled", live: boolean) => {
    const caps = capabilitiesFor(channel.provider)!;
    const refusal = checkChannelContent({ payload, policy: channel.policy, caps, mode, now: deps.now() });
    if (refusal) return refusal;
    // A reaction, edit, delete or direct message is not an event announcement (see checkChannelContent).
    if (live && channel.policy.content.requireConfirmedEvent && !payload.action) {
      const ref = payload.campaign.ref;
      if (!ref || !eventHostAllowed(ref, channel.policy.content.listingHosts)) {
        return { status: 422, error: "channel_event_unconfirmed", errors: ["channel_event_unconfirmed"] };
      }
      const live = await eventListingStatus(ref, { listingHosts: channel.policy.content.listingHosts, fetchImpl: deps.eventFetch });
      // A listing that answers 4xx is not confirmed (definitive); a 5xx or a network error is transient (L3).
      if (live === "unreachable") return { status: 503, error: "channel_event_check_unavailable" };
      if (live === "missing") return { status: 422, error: "channel_event_unconfirmed", errors: ["channel_event_unconfirmed"] };
    }
    return null;
  };

  /** Send-time refusals that may clear by themselves: an approved hold keeps its approval for a retry (L3). */
  const TRANSIENT_REFUSALS = new Set(["channel_event_check_unavailable", "channel_credential_unavailable", "channel_connection_unavailable"]);

  const refusalReply = (refusal: ChannelRefusal, traceId: string): Reply => ({
    status: refusal.status,
    body: {
      ok: false,
      schema: 1,
      traceId,
      error: refusal.error,
      ...(refusal.detail ? { detail: refusal.detail } : {}),
      ...(refusal.errors && refusal.errors.length > 1 ? { errors: refusal.errors } : {}),
      ...(refusal.retryAfterSeconds !== undefined ? { retryAfterSeconds: refusal.retryAfterSeconds } : {}),
    },
  });

  /** A reply post (`marketplace.channels.reply`) carries its reply target in `channel_inbound_reply`, keyed like the post. */
  const bodyFromPost = (post: ChannelPostRecord): ChannelPostBody => {
    const link = post.idempotencyKey.startsWith(INBOUND_REPLY_KEY_PREFIX) ? channels.inbound.getReplyLink(org, post.agentId, post.idempotencyKey) : null;
    // Routes v2: the action, person, mentions, markup and poll are kept beside the post, keyed like it.
    const spec = channels.actions.getPostOp(org, post.agentId, post.idempotencyKey);
    return {
      text: post.text,
      attachments: post.attachments,
      campaign: post.campaign,
      sendAt: post.mode === "scheduled" ? post.sendAt : null,
      ...(link ? { replyTo: link.replyTo } : {}),
      ...(spec?.action ? { action: spec.action } : {}),
      ...(spec?.mentions?.length ? { mentions: spec.mentions } : {}),
      ...(spec?.markup ? { markup: spec.markup as ChannelPostBody["markup"] } : {}),
      ...(spec?.poll ? { poll: spec.poll } : {}),
    };
  };

  /**
   * Routes v2 checks that read current state, at hold time and again at send time (definitive refusals):
   * review R3, a reaction, edit or delete acts only on a message Marketplace posted to THIS channel destination
   * (a kept receipt lists its id) for the same agent (spec 2.1: the agent's own message; another agent's post or the
   * owner test is not a target), not yet deleted, and inside the provider's edit or delete window (Telegram: 48 h);
   * review R5, a direct message only to a person the connection's people policy still allows.
   */
  const actionRefusal = (channel: ChannelRecord, payload: ChannelPayload, agentId: string): ChannelRefusal | null => {
    const action = payload.action;
    if (!action) return null;
    if (action.op === "dm") {
      const person = payload.person ? channels.actions.getPerson(org, payload.person.personRef) : null;
      if (!person || person.connectionId !== channel.connectionId || person.agentId !== agentId) return { status: 404, error: "channel_person_not_found" };
      const refused = peoplePolicyRefusal(channels.actions.getPeoplePolicy(org, channel.connectionId), channel.provider, personLookupOf(person), person.platformUserId);
      return refused ? { status: refused.status, error: refused.error } : null;
    }
    const own = channels.actions.ownMessage({ workspaceSlug: org, channelId: channel.id, destinationKey: destinationKey(channel.destination), messageId: action.targetMessageId });
    if (!own || own.agentId !== agentId) return { status: 404, error: "channel_message_not_ours" };
    if (own.removedAt) return { status: 409, error: "channel_message_removed" };
    const caps = capabilitiesFor(channel.provider);
    const windowSeconds = action.op === "delete" ? caps?.delete.windowSeconds : action.op === "edit" ? caps?.edit.windowSeconds : undefined;
    if (windowSeconds !== undefined && deps.now().getTime() - Date.parse(own.sentAt) > windowSeconds * 1000 - ACTION_WINDOW_MARGIN_MS) {
      return { status: 422, error: action.op === "delete" ? "channel_delete_window_passed" : "channel_edit_window_passed" };
    }
    return null;
  };

  const payloadFor = (channel: ChannelRecord, agentId: string, mode: "immediate" | "scheduled", body: ChannelPostBody) =>
    buildChannelPayload({
      store: channels,
      attachmentsDir,
      channel,
      caps: capabilitiesFor(channel.provider)!,
      agentId,
      op: mode === "scheduled" ? "schedule" : "post",
      body,
    });

  // ----- receipts ------------------------------------------------------------

  const writeReceipt = (input: {
    post: ChannelPostRecord;
    channel: ChannelRecord;
    status: ChannelReceiptStatus;
    result?: SendResult;
    payloadText?: string | null;
    fallbacks?: string[];
    approvedAt?: string | null;
    reason?: string | null;
    /** Routes v2: the receipt's first detail part (the operation and its target) instead of the channel destination. */
    label?: string;
  }): ReceiptView => {
    const base = input.label ?? `${input.channel.provider} ${input.channel.destination.type} ${input.channel.destination.title}`;
    const fallback = input.fallbacks && input.fallbacks.length > 0 ? input.fallbacks.join(",") : input.result?.fallback;
    const detailParts = [
      input.result?.detail ? `${base}: ${input.result.detail}` : input.reason ? `${base}: ${input.reason}` : base,
    ];
    const detail = redact(`${detailParts.join("")}${fallback ? `${FALLBACK_MARK}${fallback}` : ""}`);
    const receipt = channels.upsertReceipt({
      postId: input.post.id,
      workspaceSlug: org,
      channelId: input.channel.id,
      agentId: input.post.agentId,
      provider: input.channel.provider,
      digest: input.post.digest,
      authority: input.post.authority,
      status: input.status,
      resultIds: input.result?.resultIds.map(redact) ?? [],
      resultUrls: input.result?.resultUrls.map(redact) ?? [],
      detail,
      text: input.payloadText === undefined || input.payloadText === null ? redact(input.post.text) : redact(input.payloadText),
      approvedAt: input.approvedAt ?? null,
      sentAt: input.status === "sent" ? deps.now().toISOString() : null,
      now: deps.now(),
    });
    return receiptView(receipt);
  };

  const approvedAtFor = (post: ChannelPostRecord): string | null => {
    const authority = post.authority ?? "";
    if (authority.startsWith("grant:")) return channels.getStandingGrant(org, authority.slice(6))?.approvedAt ?? null;
    if (authority.startsWith("approval:")) return store.getCompanyBoxApproval(authority.slice(9))?.decidedAt ?? null;
    if (authority === "owner-test") return post.createdAt;
    return null;
  };

  /** Ends a post that will never be sent (`skipped`, `expired`, `cancelled`), with its receipt. */
  const endPost = (post: ChannelPostRecord, channel: ChannelRecord | null, status: "skipped" | "expired" | "cancelled", reason: string, claimer?: string) => {
    const ended = channels.finishPost(org, post.id, {
      status,
      from: [post.status],
      reason,
      ...(claimer ? { claimer } : {}),
      now: deps.now(),
    });
    if (!ended) return null;
    if (channel) writeReceipt({ post: ended, channel, status, reason });
    audit(`marketplace.channels.post.${status}`, ended, channel?.provider ?? "unknown", { reason });
    return ended;
  };

  /** Cancels a held post and closes its approval atomically (agent or owner), with its receipt. */
  const cancelHeld = (post: ChannelPostRecord, channel: ChannelRecord, actor: string, reason: string) => {
    const ended = channels.cancelHeldPost({ workspaceSlug: org, postId: post.id, reason, decidedBy: `${actor}:cancelled`, now: deps.now() });
    if (!ended) return null;
    writeReceipt({ post: ended, channel, status: "cancelled", reason });
    audit("marketplace.channels.post.cancelled", ended, channel.provider, { reason });
    return ended;
  };

  /** An approval that ended without approving (0.1.19 marks an approval it could not run `failed`). */
  const approvalEndedUnapproved = (state: CompanyBoxApproval["state"]) => state === "failed" || state === "succeeded";

  // ----- send (channel-native target run) ------------------------------------

  // ----- outbound in flight (review R8) ----------------------------------------

  /**
   * Sends to one platform chat that have not returned yet. Telegram can deliver the bot's own channel post back to the
   * webhook before `sendMessage` answers, so the inbound self-loop check waits for these (bounded) and then reads the
   * sent-message ledger, which is written as soon as the provider call returns.
   */
  const inFlight = new Map<string, Set<Promise<unknown>>>();
  const flightKey = (provider: string, chatId: string) => `${provider}|${chatId}`;
  const track = <T>(provider: string, chatId: string, run: () => Promise<T>): Promise<T> => {
    const key = flightKey(provider, chatId);
    const promise = run();
    const set = inFlight.get(key) ?? new Set<Promise<unknown>>();
    set.add(promise);
    inFlight.set(key, set);
    const done = () => {
      set.delete(promise);
      if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
    };
    promise.then(done, done);
    return promise;
  };
  /** Resolves when every send to this chat that was in flight has returned (and recorded its ids), or after the bound. */
  const awaitOutbound = async (provider: string, chatId: string, timeoutMs = OUTBOUND_SETTLE_WAIT_MS): Promise<void> => {
    const set = inFlight.get(flightKey(provider, chatId));
    if (!set || set.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...set]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  };

  // ----- send (channel-native target run) ------------------------------------

  const asSendResult = (result: ActionResult): SendResult => ({
    status: result.status,
    resultIds: [],
    resultUrls: [],
    ...(result.detail ? { detail: result.detail } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  });

  /** The receipt label of a routes v2 operation: what it did and to which message or person (no message text). */
  const actionLabel = (channel: ChannelRecord, payload: ChannelPayload): string | undefined => {
    const action = payload.action;
    const where = `${channel.provider} ${channel.destination.type} ${channel.destination.title}`;
    if (!action) return payload.poll ? `${where} · poll` : undefined;
    if (action.op === "dm") return `${channel.provider} direct message to ${payload.person?.displayName ?? "a person"}`;
    if (action.op === "react") return `${where} · ${action.remove === true ? "remove reaction" : "reaction"} ${action.emoji} on ${action.targetMessageId}`;
    return `${where} · ${action.op} ${action.targetMessageId}`;
  };

  /** One provider call for the payload's operation. Never throws; the caller classifies the result. */
  const providerCall = async (channel: ChannelRecord, post: ChannelPostRecord, payload: ChannelPayload): Promise<SendResult> => {
    const provider = providerFor(channel.provider)!;
    const credential = isChannelProviderId(channel.provider) ? credentials.get(channel.provider)?.value ?? null : null;
    const destination = toProviderDestination(channel);
    const action = payload.action;
    const unsupported = (feature: string): SendResult => ({
      status: "failed",
      resultIds: [],
      resultUrls: [],
      errorCode: "channel_capability_unavailable",
      detail: `the adapter has no ${feature} operation`,
    });
    if (action?.op === "react") {
      if (!provider.react) return unsupported("reaction");
      return asSendResult(await provider.react(credential, destination, action.targetMessageId, action.emoji, action.remove === true ? { remove: true } : {}));
    }
    if (action?.op === "edit") {
      if (!provider.edit) return unsupported("edit");
      return track(channel.provider, destination.externalId, () => provider.edit!(credential, destination, action.targetMessageId, { text: payload.text }));
    }
    if (action?.op === "delete") {
      if (!provider.remove) return unsupported("delete");
      const result = asSendResult(await provider.remove(credential, destination, action.targetMessageId));
      if (result.status === "sent") {
        channels.actions.markMessageRemoved({ workspaceSlug: org, channelId: channel.id, destinationKey: destinationKey(destination), messageId: action.targetMessageId, now: deps.now() });
      }
      return result;
    }
    if (action?.op === "dm") {
      if (!provider.openDirect || !payload.person) return unsupported("direct message");
      // Opening the DM posts nothing; a refusal here means nothing was sent.
      const opened = await provider.openDirect(credential, payload.person.platformUserId);
      if (!opened.ok) return { status: "failed", resultIds: [], resultUrls: [], errorCode: opened.errorCode, detail: opened.detail };
      const personDestination: ProviderDestination = { ...opened.destination, type: "person" };
      return provider.send(credential, personDestination, {
        text: payload.text,
        attachments: payload.attachments,
        ...(payload.mentions ? { mentions: payload.mentions } : {}),
      });
    }
    // A message to the channel destination: its ids are recorded as soon as the call returns (R3 ledger, R8).
    return track(channel.provider, destination.externalId, async () => {
      const result = await provider.send(credential, destination, {
        text: payload.text,
        attachments: payload.attachments,
        ...(payload.replyTo !== undefined ? { replyTo: payload.replyTo } : {}),
        ...(payload.mentions ? { mentions: payload.mentions } : {}),
        ...(payload.markup !== undefined ? { markup: payload.markup } : {}),
        ...(payload.poll ? { poll: payload.poll } : {}),
      });
      if (result.resultIds.length > 0 && result.status !== "failed") {
        channels.actions.recordSentMessages({ workspaceSlug: org, channelId: channel.id, destinationKey: destinationKey(destination), postId: post.id, messageIds: result.resultIds.map(redact), now: deps.now() });
      }
      return result;
    });
  };

  const settleSend = async (channel: ChannelRecord, post: ChannelPostRecord, payload: ChannelPayload): Promise<ReceiptView> => {
    let result: SendResult;
    try {
      result = await providerCall(channel, post, payload);
    } catch {
      // Adapters never throw; if one does after the request left, delivery is unknown.
      result = { status: "uncertain", resultIds: [], resultUrls: [], errorCode: "channel_provider_error", detail: "the provider adapter failed" };
    }
    const status = result.status;
    let finished = channels.finishPost(org, post.id, {
      status,
      from: ["sending"],
      reason: result.errorCode ?? null,
      now: deps.now(),
    });
    if (!finished) {
      // Lease recovery marked it `uncertain` while the call was running; the real outcome is now known.
      const current = channels.getPost(org, post.id);
      finished = current?.status === "uncertain" && status !== "uncertain"
        ? channels.finishPost(org, post.id, { status, from: ["uncertain"], reason: result.errorCode ?? null, now: deps.now() })
        : current;
    }
    const final = finished ?? post;
    // Review R5: the owner approved this exact first message and it was sent, so the person is now approved on this
    // connection; later messages may be covered by a grant with scope.dms (the owner can revoke the person).
    if (status === "sent" && payload.action?.op === "dm" && payload.person && final.authority?.startsWith("approval:")) {
      const person = channels.actions.getPerson(org, payload.person.personRef);
      if (person && person.approvedAt === null) {
        const approval = store.getCompanyBoxApproval(final.authority.slice("approval:".length));
        channels.actions.approvePerson({ workspaceSlug: org, personRef: person.personRef, approvedBy: approval?.decidedBy ?? "owner", postId: final.id, now: deps.now() });
        store.recordAudit({
          workspaceSlug: org,
          pluginId: channelPluginId(channel.provider),
          eventType: "marketplace.channels.person.approved",
          actorId: approval?.decidedBy ?? "owner",
          metadata: { channelId: channel.id, connectionId: channel.connectionId, personRef: person.personRef, postId: final.id, approvalId: final.authority.slice("approval:".length) },
        });
      }
    }
    const label = actionLabel(channel, payload);
    const view = writeReceipt({
      post: final,
      channel,
      status,
      result,
      payloadText: payload.text,
      fallbacks: payload.fallbacks,
      approvedAt: approvedAtFor(final),
      ...(label ? { label } : {}),
    });
    audit(`marketplace.channels.post.${status}`, final, channel.provider, {
      outcome: status,
      op: payload.op,
      ...(payload.action && payload.action.op !== "dm" ? { targetMessageId: payload.action.targetMessageId } : {}),
      ...(payload.person ? { personRef: payload.person.personRef } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(view.fallback ? { fallback: view.fallback } : {}),
      ...(result.partial ? { partial: true } : {}),
    });
    if (status === "sent") return view;
    throw new ConsentedExecutionOutcome(
      status === "failed" ? "channel_send_failed" : "channel_send_uncertain",
      502,
      status === "failed" ? "succeeded" : "reconciliation-required",
      view,
      view.detail ?? undefined,
    );
  };

  const channelNativeTarget: ExecutionTarget<ChannelExecutionContext> = {
    id: "channel-native",
    matches: () => true,
    prepare: (context) => {
      const reserved = context.reserve();
      if (!reserved.ok) {
        return { ok: false, statusCode: reserved.statusCode, error: reserved.error, ...(reserved.detail ? { detail: reserved.detail } : {}) };
      }
      const post = reserved.post;
      return {
        ok: true,
        prepared: {
          toolName: `channel.${context.channel.provider}.${context.op === "post" ? "send" : context.op}`,
          summary: context.op === "post" ? `Posted to ${context.channel.provider} channel ${context.channel.slug}.` : `Ran ${context.op} on ${context.channel.provider} channel ${context.channel.slug}.`,
          run: () => context.send(post),
          release: () => context.release(post),
        },
      };
    },
  };

  const isCapError = (error: string) =>
    error.startsWith("channel_cap_") || error === "channel_min_interval" || error === "channel_edit_min_interval" || error === "channel_phase_duplicate";
  const capsRefusal = (error: string, retryAfterSeconds?: number) => ({
    ok: false as const,
    statusCode: isCapError(error) ? 429 : error === "channel_not_found" ? 404 : 409,
    error,
    ...(retryAfterSeconds !== undefined ? { detail: { retryAfterSeconds } } : {}),
  });

  const dispatchSend = (input: {
    execute: { reply: FastifyReply; traceId: string; via: "runtime-lease" | "app-grant"; dispatch: ConsentedDispatch };
    channel: ChannelRecord;
    operationConsentId: string;
    idempotencyKey: string;
    consentId: string;
    leaseId: string;
    actor: GovernanceActor;
    agentId: string;
    payload: ChannelPayload;
    authority: string;
    reserve: ChannelExecutionContext["reserve"];
    onReleased?: (post: ChannelPostRecord) => void;
  }) => {
    const provider = providerFor(input.channel.provider)!;
    const op = input.payload.action?.op ?? "post";
    const actionType = op === "post" ? "channel.post" : `channel.${op}`;
    const context: ChannelExecutionContext = {
      channel: input.channel,
      op,
      provider,
      reserve: input.reserve,
      send: (post) => settleSend(input.channel, post, input.payload),
      release: (post) => {
        // The idempotency step refused after the reservation: free the slot (failed does not count).
        channels.finishPost(org, post.id, { status: "failed", from: ["sending"], reason: "idempotency_refused", now: deps.now() });
        input.onReleased?.(post);
      },
    };
    return input.execute.dispatch({
      reply: input.execute.reply,
      traceId: input.execute.traceId,
      via: input.execute.via,
      operationConsentId: input.operationConsentId,
      idempotencyKey: input.idempotencyKey,
      fingerprintSource: { consentId: input.consentId, channelId: input.channel.id, digest: input.payload.digest },
      pluginId: channelPluginId(input.channel.provider),
      provider: input.channel.provider,
      sourceExecutor: "native",
      actionType,
      capability: "connector.dispatch",
      consentId: input.consentId,
      leaseId: input.leaseId,
      actorId: input.actor.id,
      governance: {
        actor: input.actor,
        // A delete removes a message from the destination: destructive for Rules (owner mode reads `outward`).
        risk: { write: true, outward: true, destructive: op === "delete" },
        payload: {
          phase: "execute",
          agentId: input.agentId,
          consentId: input.consentId,
          leaseId: input.leaseId,
          // Shapes and the digest only: Rules sees what is approved, not the content.
          action: { type: actionType, channelId: input.channel.id, digest: input.payload.digest, attachments: input.payload.files.length },
          authority: input.authority,
          traceId: input.execute.traceId,
        },
      },
      ledgerInput: { type: actionType, channelId: input.channel.id, digest: input.payload.digest, attachments: input.payload.files.length },
      prepare: () => (channelNativeTarget.matches(context) ? channelNativeTarget.prepare(context) : { ok: false, statusCode: 500, error: "execution_target_unresolved" }),
    });
  };

  // ----- holds (3c) ----------------------------------------------------------

  const insertStatus = (error: string) => (error === "channel_not_found" ? 404 : error === "channel_schedule_backlog_full" ? 429 : 409);
  const approvalKey = channelPostApprovalKey;
  const approvalForPost = (post: ChannelPostRecord) =>
    store.findCompanyBoxApprovalByKey({ workspaceSlug: org, agentId: post.agentId, idempotencyKey: approvalKey(post.id) });

  const payloadView = (payload: ChannelPayload) => ({
    canonical: payload.canonical,
    files: payload.files.map((file) => ({ name: file.name, sha256: file.sha256, contentType: file.contentType })),
  });

  /**
   * K1 (contract alpha.6): the `202` body is exactly `approvalPendingSchema` (strict; no other key):
   * `{error, approvalId, digest, expiresAt, payloadView}`, with `digest = sha256(payloadView.canonical)`.
   * The post id and trace id travel as response headers.
   */
  const pendingReply = (post: ChannelPostRecord, approval: CompanyBoxApproval, payload: ChannelPayload, traceId: string): Reply => ({
    status: 202,
    body: {
      error: "approval_pending",
      approvalId: approval.id,
      digest: post.digest,
      expiresAt: approval.expiresAt,
      payloadView: payloadView(payload),
    },
    headers: { [POST_ID_HEADER]: post.id, [TRACE_ID_HEADER]: traceId },
  });

  /** The approval action key of a held post: its manifest operation (routes v2 operations have their own). */
  const approvalActionKey = (post: ChannelPostRecord, op: ChannelPayload["op"]) =>
    post.mode === "scheduled" ? "channel.schedule" : op === "react" || op === "edit" || op === "delete" || op === "dm" ? `channel.${op}` : "channel.post";

  const ensureApproval = (post: ChannelPostRecord, channel: ChannelRecord, consentRowId: string, op: ChannelPayload["op"]): CompanyBoxApproval => {
    const existing = approvalForPost(post);
    if (existing) return existing;
    const ttlMs = post.mode === "scheduled" && post.sendAt ? Math.max(1, Date.parse(post.sendAt) - Date.now()) : APPROVAL_TTL_MS;
    const actionKey = approvalActionKey(post, op);
    const approval = store.createCompanyBoxApproval({
      workspaceSlug: org,
      pluginId: channelPluginId(channel.provider),
      actionKey,
      capability: "connector.dispatch",
      agentId: post.agentId,
      sourceKind: "channel-consent",
      sourceRef: consentRowId,
      idempotencyKey: approvalKey(post.id),
      fingerprint: post.digest,
      // References only; the owner view reads the post. No content in the approval row.
      arguments: { channelId: channel.id, postId: post.id, digest: post.digest },
      argumentsPreview: `${channel.label} (${channel.provider})${actionKey === "channel.post" || actionKey === "channel.schedule" ? "" : ` · ${actionKey.slice("channel.".length)}`} · digest ${post.digest.slice(0, 12)}`,
      ttlMs,
    });
    store.recordAudit({
      workspaceSlug: org,
      pluginId: channelPluginId(channel.provider),
      eventType: "marketplace.company_box.approval.requested",
      actorId: `agent:${post.agentId}`,
      metadata: { governance: "channel", approvalId: approval.id, actionKey: approval.actionKey, agentId: post.agentId, channelId: channel.id, postId: post.id, digest: post.digest, expiresAt: approval.expiresAt },
    });
    return approval;
  };

  const hold = (input: {
    channel: ChannelRecord;
    consent: MarketplaceAgentConsent;
    mode: "immediate" | "scheduled";
    body: ChannelPostBody;
    payload: ChannelPayload;
    idempotencyKey: string;
    traceId: string;
  }): Reply => {
    if (input.payload.canonical.length > CHANNEL_PAYLOAD_VIEW_MAX_CHARS) {
      return refusalReply({ status: 413, error: "channel_payload_view_too_large" }, input.traceId);
    }
    if (store.countPendingCompanyBoxApprovals({ workspaceSlug: org, agentId: input.consent.agentId }) >= APPROVAL_MAX_PENDING_PER_AGENT) {
      return refusalReply({ status: 429, error: "approval_queue_full" }, input.traceId);
    }
    // Review B1: a Buzz reply approves by digest prefix, so two live holds must never share one. Nothing is
    // consumed; the agent may change the text and retry.
    if (store.hasLiveApprovalWithPrefix({ workspaceSlug: org, prefix: input.payload.digest.slice(0, NOSTR_MIN_PREFIX_HEX) })) {
      return refusalReply({ status: 409, error: "channel_digest_prefix_collision" }, input.traceId);
    }
    const inserted = channels.insertPost({
      workspaceSlug: org,
      channelId: input.channel.id,
      agentId: input.consent.agentId,
      consentId: input.consent.id,
      mode: input.mode,
      sendAt: input.body.sendAt,
      text: input.body.text,
      attachments: input.body.attachments,
      campaign: input.body.campaign,
      digest: input.payload.digest,
      idempotencyKey: input.idempotencyKey,
      status: "held",
      now: deps.now(),
      maxPending: maxPendingPerAgent(input.channel.policy),
    });
    if (!inserted.ok) {
      return refusalReply({ status: insertStatus(inserted.error), error: inserted.error }, input.traceId);
    }
    const approval = ensureApproval(inserted.post, input.channel, input.consent.id, input.payload.op);
    if (inserted.created) audit("marketplace.channels.post.held", inserted.post, input.channel.provider, { approvalId: approval.id });
    return pendingReply(inserted.post, approval, input.payload, input.traceId);
  };

  // ----- replays -------------------------------------------------------------

  const receiptReply = (post: ChannelPostRecord, traceId: string, extra: Record<string, unknown> = {}): Reply => {
    const receipt = channels.getReceiptByPost(org, post.id);
    const view = receipt ? receiptView(receipt) : null;
    const status =
      post.status === "sent" || post.status === "scheduled"
        ? 200
        : post.status === "failed"
          ? 502
          : 409;
    const error =
      post.status === "sent" || post.status === "scheduled"
        ? undefined
        : post.status === "failed"
          ? "channel_send_failed"
          : `channel_post_${post.status}`;
    return {
      status,
      body: { ok: status === 200, schema: 1, traceId, ...(error ? { error } : {}), ...extra, ...(view ? { receipt: view } : {}) },
    };
  };

  // ----- the channel half of executeConsentedCall ------------------------------

  const execute = async (input: ExecuteInput): Promise<Record<string, unknown>> => {
    const { reply, traceId, consent } = input;
    const answer = (result: Reply) => {
      reply.code(result.status);
      if (result.headers) reply.headers(result.headers);
      return result.body;
    };
    const channel = channels.getChannel(org, input.channelId);
    const expected = channel ? channelPluginId(channel.provider) : null;
    if (
      !channel ||
      input.selection.pluginId !== expected ||
      input.selection.accountId !== channel.connectionId ||
      input.selection.actionGroup !== `channel:${channel.slug}`
    ) {
      return answer(refusalReply({ status: 404, error: "channel_not_found" }, traceId));
    }
    if (input.selection.grantClass !== "outward") {
      return answer(refusalReply({ status: 403, error: "channel_outward_consent_required" }, traceId));
    }
    const provider = providerFor(channel.provider);
    if (!provider) return answer(refusalReply({ status: 422, error: "channel_capability_unavailable" }, traceId));
    const execute = { reply, traceId, via: input.via, dispatch: input.dispatch };
    const agentActor: GovernanceActor = { kind: "agent", id: `agent:${consent.agentId}`, attestation: "owner-approval" };
    const base = {
      execute,
      channel,
      operationConsentId: consent.consentId,
      consentId: consent.consentId,
      leaseId: input.scope.leaseId,
      actor: agentActor,
      agentId: consent.agentId,
    };

    if (input.mode === "post" || input.mode === "schedule") {
      const mode = input.mode === "schedule" ? "scheduled" : "immediate";
      const built = payloadFor(channel, consent.agentId, mode, input.body);
      if (!built.ok) return answer(refusalReply(built.refusal, traceId));
      const payload = built.payload;
      // Same key, same post: a replay answers from the stored post; another payload is a conflict.
      const existing = channels.getPostByIdempotencyKey(org, consent.agentId, input.idempotencyKey);
      if (existing) {
        if (existing.channelId !== channel.id || existing.digest !== payload.digest) {
          return answer(refusalReply({ status: 409, error: "channel_idempotency_conflict" }, traceId));
        }
        if (existing.status === "held") {
          const approval = approvalForPost(existing) ?? ensureApproval(existing, channel, consent.id, payload.op);
          if (approval.state === "pending" || approval.state === "resolving") return answer(pendingReply(existing, approval, payload, traceId));
          if (approval.state === "denied") {
            endPost(existing, channel, "skipped", "approval_denied");
            return answer(refusalReply({ status: 403, error: "approval_denied" }, traceId));
          }
          if (approval.state === "expired") {
            endPost(existing, channel, "expired", "approval_expired");
            return answer(refusalReply({ status: 410, error: "approval_expired" }, traceId));
          }
          if (approval.state === "executing" && existing.mode === "immediate") {
            return channelResponse(await approvedHold(input, channel, existing, approval.id, base));
          }
          if (approvalEndedUnapproved(approval.state)) {
            endPost(existing, channel, "skipped", "approval_failed");
            return answer(refusalReply({ status: 409, error: "approval_failed" }, traceId));
          }
          return answer(refusalReply({ status: 409, error: "channel_post_held" }, traceId));
        }
        return answer(receiptReply(existing, traceId, { replayed: true }));
      }
      const notSendable = sendable(channel);
      if (notSendable) return answer(refusalReply(notSendable, traceId));
      const refused = await contentRefusal(channel, payload, mode, mode === "immediate");
      if (refused) return answer(refusalReply(refused, traceId));
      // M2: the owner may have paused the channel during the live check; decide on the current row.
      const fresh = channels.getChannel(org, channel.id);
      if (!fresh || fresh.status !== "active") {
        return answer(refusalReply({ status: 409, error: fresh?.status === "paused" ? "channel_paused" : "channel_not_active" }, traceId));
      }
      // Routes v2: own message (R3), provider window, people policy (R5). Nothing is held or consumed before this.
      const actionRefused = actionRefusal(channel, payload, consent.agentId);
      if (actionRefused) return answer(refusalReply(actionRefused, traceId));
      const facts = {
        mode,
        reply: input.body.replyTo !== undefined,
        ...(payload.action ? { action: payload.action.op } : {}),
        poll: payload.poll !== undefined,
        personApproved: payload.person?.approvedAt != null,
        sendAt: payload.sendAt,
        text: payload.text,
        attachments: payload.files.map((file) => ({ contentType: file.contentType, bytes: file.bytes, sha256: file.sha256, name: file.name })),
        campaign: payload.campaign,
      } as const;
      const grant = grants
        .usableGrants({ channel, agentId: consent.agentId, consentRowId: consent.id })
        .find((candidate) => grantCoversPost({ ...candidate, notBefore: candidate.notBefore }, facts, deps.now()).ok);
      if (!grant) {
        return answer(hold({ channel, consent, mode, body: input.body, payload, idempotencyKey: input.idempotencyKey, traceId }));
      }
      if (mode === "scheduled") {
        const inserted = channels.insertPost({
          workspaceSlug: org,
          channelId: channel.id,
          agentId: consent.agentId,
          consentId: consent.id,
          mode: "scheduled",
          sendAt: payload.sendAt,
          text: input.body.text,
          attachments: input.body.attachments,
          campaign: input.body.campaign,
          digest: payload.digest,
          authority: `grant:${grant.id}`,
          idempotencyKey: input.idempotencyKey,
          status: "scheduled",
          now: deps.now(),
          maxPending: maxPendingPerAgent(channel.policy),
        });
        if (!inserted.ok) return answer(refusalReply({ status: insertStatus(inserted.error), error: inserted.error }, traceId));
        const receipt = writeReceipt({ post: inserted.post, channel, status: "pending", payloadText: payload.text, fallbacks: payload.fallbacks, approvedAt: grant.approvedAt });
        audit("marketplace.channels.post.scheduled", inserted.post, channel.provider, { sendAt: inserted.post.sendAt });
        return answer({ status: 200, body: { ok: true, schema: 1, traceId, receipt } });
      }
      const response = await dispatchSend({
        ...base,
        idempotencyKey: input.idempotencyKey,
        payload,
        authority: `grant:${grant.id}`,
        reserve: () => {
          // R5: a person revoked since the grant check is no longer covered (checked again right before the send).
          if (payload.person && channels.actions.getPerson(org, payload.person.personRef)?.approvedAt == null) return capsRefusal("channel_person_not_approved");
          const reserved = channels.reservePost({
            workspaceSlug: org,
            channelId: channel.id,
            agentId: consent.agentId,
            consentId: consent.id,
            mode: "immediate",
            text: input.body.text,
            attachments: input.body.attachments,
            campaign: input.body.campaign,
            digest: payload.digest,
            authority: `grant:${grant.id}`,
            idempotencyKey: input.idempotencyKey,
            grant: { id: grant.id, caps: grant.caps },
            ceiling: channel.policy.caps,
            now: deps.now(),
            reserver: reserver(),
            leaseMs: CHANNEL_SEND_LEASE_MS,
            live: { consentRowId: consent.id, grantId: grant.id },
          });
          if (!reserved.ok) return capsRefusal(reserved.error, reserved.retryAfterSeconds);
          if (reserved.replayed) return capsRefusal("channel_post_in_progress");
          return { ok: true, post: reserved.post };
        },
      });
      return channelResponse(response);
    }

    if (input.mode === "approved-hold") {
      const post = channels.getPost(org, input.postId);
      if (!post || post.channelId !== channel.id || post.agentId !== consent.agentId) {
        return answer(refusalReply({ status: 404, error: "channel_post_not_found" }, traceId));
      }
      return channelResponse(await approvedHold(input, channel, post, input.approvalId, base));
    }

    // scheduled-send: a claimed `scheduled` post, or a due `held` scheduled post with an approval.
    if (input.mode !== "scheduled-send") return answer(refusalReply({ status: 400, error: "channel_call_invalid" }, traceId));
    const post = channels.getPost(org, input.postId);
    if (!post || post.channelId !== channel.id || post.agentId !== consent.agentId) {
      return answer(refusalReply({ status: 404, error: "channel_post_not_found" }, traceId));
    }
    return channelResponse(await scheduledSend(input, channel, post, base));
  };

  type SendBase = {
    execute: { reply: FastifyReply; traceId: string; via: "runtime-lease" | "app-grant"; dispatch: ConsentedDispatch };
    channel: ChannelRecord;
    operationConsentId: string;
    consentId: string;
    leaseId: string;
    actor: GovernanceActor;
    agentId: string;
  };

  /**
   * Send-time recheck shared by approved holds and scheduled sends (review
   * condition 8b(i)): rebuild the payload from the stored post, the CURRENT
   * channel destination and the attachment bytes on disk, and refuse on any
   * difference from the approved digest; then 3a and 3b (live event check).
   */
  const sendTimeRecheck = async (channel: ChannelRecord, post: ChannelPostRecord): Promise<{ ok: true; payload: ChannelPayload } | { ok: false; refusal: ChannelRefusal; final: boolean }> => {
    const built = payloadFor(channel, post.agentId, post.mode, bodyFromPost(post));
    if (!built.ok) return { ok: false, refusal: built.refusal, final: true };
    if (built.payload.digest !== post.digest) {
      return { ok: false, refusal: { status: 409, error: "channel_digest_mismatch" }, final: true };
    }
    const notSendable = sendable(channel);
    if (notSendable) return { ok: false, refusal: notSendable, final: !TRANSIENT_REFUSALS.has(notSendable.error) };
    const refused = await contentRefusal(channel, built.payload, post.mode, true);
    if (refused) return { ok: false, refusal: refused, final: !TRANSIENT_REFUSALS.has(refused.error) };
    const actionRefused = actionRefusal(channel, built.payload, post.agentId);
    if (actionRefused) return { ok: false, refusal: actionRefused, final: true };
    return { ok: true, payload: built.payload };
  };

  const finishApproval = (approvalId: string, view: unknown, error: string | null) => {
    const approval = store.getCompanyBoxApproval(approvalId);
    if (approval?.state !== "executing") return;
    store.finishCompanyBoxApproval(
      error ? { id: approvalId, state: "failed", error } : { id: approvalId, state: "succeeded", result: view },
    );
  };

  const approvedHold = async (input: { traceId: string; reply: FastifyReply }, channel: ChannelRecord, post: ChannelPostRecord, approvalId: string, base: SendBase) => {
    const approval = store.getCompanyBoxApproval(approvalId);
    if (!approval || approval.fingerprint !== post.digest || approval.sourceKind !== "channel-consent" || approval.idempotencyKey !== approvalKey(post.id)) {
      input.reply.code(409);
      return { ok: false, schema: 1, traceId: input.traceId, error: "channel_approval_invalid" };
    }
    if (post.status !== "held") return receiptReply(post, input.traceId, { replayed: true }).body;
    const refuse = (refusal: ChannelRefusal) => {
      const reply = refusalReply(refusal, input.traceId);
      input.reply.code(reply.status);
      return reply.body;
    };
    /** A definitive refusal ends the hold: the post is skipped (or expired) and the approval failed; the agent must ask again. */
    const endHold = (status: "skipped" | "expired", refusal: ChannelRefusal) => {
      endPost(post, channel, status, refusal.error);
      finishApproval(approvalId, null, refusal.error);
      return refuse(refusal);
    };
    if (approval.state !== "executing") return refuse({ status: 409, error: "channel_approval_invalid" });
    // L4: an approval past its expiry is never used (an immediate hold; a scheduled one expires at sendAt by design).
    if (post.mode === "immediate" && Date.parse(approval.expiresAt) <= deps.now().getTime()) {
      return endHold("expired", { status: 410, error: "approval_expired" });
    }
    const recheck = await sendTimeRecheck(channel, post);
    if (!recheck.ok) {
      // L3: a transient failure leaves the post held and the approval unspent (immediate holds only;
      // a scheduled post at its send time follows §6: skipped with the reason, never a silent retry).
      if (!recheck.final && post.mode === "immediate") return refuse(recheck.refusal);
      return endHold("skipped", recheck.refusal);
    }
    const response = await dispatchSend({
      ...base,
      idempotencyKey: post.idempotencyKey,
      payload: recheck.payload,
      authority: `approval:${approvalId}`,
      reserve: () => {
        const reserved = channels.reserveHeldPost({
          workspaceSlug: org,
          postId: post.id,
          approvalId,
          ceiling: channel.policy.caps,
          now: deps.now(),
          reserver: reserver(),
          leaseMs: CHANNEL_SEND_LEASE_MS,
          live: { consentRowId: post.consentId, grantId: null },
        });
        if (!reserved.ok) {
          if (reserved.error === "channel_post_not_held") return capsRefusal("channel_post_in_progress");
          // M1/M2: caps, a paused channel, a revoked consent or an invalid approval end the hold (skipped,
          // approval failed), the same as the scheduler. The agent must ask again.
          const current = channels.getPost(org, post.id);
          if (current?.status === "held") {
            endPost(current, channel, "skipped", reserved.error);
            finishApproval(approvalId, null, reserved.error);
          }
          return capsRefusal(reserved.error, reserved.retryAfterSeconds);
        }
        return { ok: true, post: reserved.post };
      },
    });
    const receipt = channelResponse(response).receipt as ReceiptView | undefined;
    if (receipt) finishApproval(approvalId, receipt, receipt.status === "sent" ? null : `channel_send_${receipt.status}`);
    return response;
  };

  const scheduledSend = async (input: ExecuteInput, channel: ChannelRecord, post: ChannelPostRecord, base: SendBase) => {
    const claimer = input.mode === "scheduled-send" ? input.claimer : "";
    if (post.status === "held") {
      const approval = approvalForPost(post);
      if (!approval || approval.state !== "executing") {
        input.reply.code(409);
        return { ok: false, schema: 1, traceId: input.traceId, error: "channel_approval_invalid" };
      }
      return approvedHold(input, channel, post, approval.id, base);
    }
    if (post.status !== "scheduled" || post.claimedBy !== claimer) {
      input.reply.code(409);
      return { ok: false, schema: 1, traceId: input.traceId, error: "channel_post_not_claimed" };
    }
    const skip = (refusal: ChannelRefusal) => {
      endPost(post, channel, "skipped", refusal.error, claimer);
      const reply = refusalReply(refusal, input.traceId);
      input.reply.code(reply.status);
      return reply.body;
    };
    const recheck = await sendTimeRecheck(channel, post);
    if (!recheck.ok) return skip(recheck.refusal);
    const grantId = post.authority?.startsWith("grant:") ? post.authority.slice(6) : null;
    const grant = grantId
      ? grants.usableGrants({ channel, agentId: post.agentId, consentRowId: post.consentId }).find((candidate) => candidate.id === grantId)
      : undefined;
    const covered = grant
      ? grantCoversPost(grant, {
          mode: "scheduled",
          sendAt: post.sendAt,
          text: recheck.payload.text,
          attachments: recheck.payload.files.map((file) => ({ contentType: file.contentType, bytes: file.bytes })),
          campaign: post.campaign,
        }, deps.now())
      : { ok: false as const, reasons: ["grant_not_active"] };
    if (!grant || !covered.ok) return skip({ status: 409, error: "channel_grant_invalid", detail: covered.ok ? undefined : covered.reasons.join(",") });
    const activeGrant = grant;
    return dispatchSend({
      ...base,
      idempotencyKey: post.idempotencyKey,
      payload: recheck.payload,
      authority: `grant:${activeGrant.id}`,
      reserve: () => {
        const reserved = channels.reserveScheduledPost({
          workspaceSlug: org,
          postId: post.id,
          claimer,
          grant: { id: activeGrant.id, caps: activeGrant.caps },
          ceiling: channel.policy.caps,
          now: deps.now(),
          leaseMs: CHANNEL_SCHEDULER_LEASE_MS,
          live: { consentRowId: post.consentId, grantId: activeGrant.id },
        });
        if (!reserved.ok) {
          // At send time a cap refusal is final: skipped with the reason, never a silent retry.
          if (reserved.error !== "channel_post_not_claimed") endPost(post, channel, "skipped", reserved.error, claimer);
          return capsRefusal(reserved.error, reserved.retryAfterSeconds);
        }
        return { ok: true, post: reserved.post };
      },
    });
  };

  // ----- owner test send (same dispatch tail, authority owner-test) ----------

  const ownerTest = async (input: {
    channel: ChannelRecord;
    operatorId: string;
    idempotencyKey: string;
    reply: FastifyReply;
    traceId: string;
    dispatch: ConsentedDispatch;
  }) => {
    const { channel } = input;
    const answer = (result: Reply) => {
      input.reply.code(result.status);
      return result.body;
    };
    const agentId = `owner:${input.operatorId}`;
    const notSendable = sendable(channel);
    if (notSendable) return answer(refusalReply(notSendable, input.traceId));
    const body: ChannelPostBody = { text: OWNER_TEST_TEXT, attachments: [], campaign: {}, sendAt: null };
    const built = buildChannelPayload({ store: channels, attachmentsDir, channel, caps: capabilitiesFor(channel.provider)!, agentId, op: "test", body });
    if (!built.ok) return answer(refusalReply(built.refusal, input.traceId));
    const existing = channels.getPostByIdempotencyKey(org, agentId, input.idempotencyKey);
    if (existing) {
      if (existing.channelId !== channel.id || existing.digest !== built.payload.digest) {
        return answer(refusalReply({ status: 409, error: "channel_idempotency_conflict" }, input.traceId));
      }
      return answer(receiptReply(existing, input.traceId, { replayed: true }));
    }
    const response = await dispatchSend({
      execute: { reply: input.reply, traceId: input.traceId, via: "app-grant", dispatch: input.dispatch },
      channel,
      operationConsentId: `owner-test:${channel.id}`,
      idempotencyKey: input.idempotencyKey,
      consentId: "owner-test",
      leaseId: `operator:${input.operatorId}`,
      actor: { kind: "operator", id: input.operatorId },
      agentId,
      payload: built.payload,
      authority: "owner-test",
      reserve: () => {
        const reserved = channels.reservePost({
          workspaceSlug: org,
          channelId: channel.id,
          agentId,
          consentId: "owner-test",
          mode: "immediate",
          text: body.text,
          attachments: [],
          campaign: {},
          digest: built.payload.digest,
          authority: "owner-test",
          idempotencyKey: input.idempotencyKey,
          grant: null,
          ceiling: channel.policy.caps,
          now: deps.now(),
          reserver: reserver(),
          leaseMs: CHANNEL_SEND_LEASE_MS,
          live: { consentRowId: null, grantId: null },
        });
        if (!reserved.ok) return capsRefusal(reserved.error, reserved.retryAfterSeconds);
        if (reserved.replayed) return capsRefusal("channel_post_in_progress");
        return { ok: true, post: reserved.post };
      },
    });
    return channelResponse(response);
  };

  // ----- owner decisions on held posts ----------------------------------------

  /**
   * M1: the owner denies an approval that is already approved (`executing`) while its post is still
   * held (e.g. a transient failure kept it). Atomic with the post state; refused once a send started.
   */
  const denyApprovedHold = (approval: CompanyBoxApproval, decidedBy: string): CompanyBoxApproval | null => {
    const postId = typeof approval.arguments.postId === "string" ? approval.arguments.postId : "";
    const denied = channels.denyApprovedHold({ workspaceSlug: org, approvalId: approval.id, postId, decidedBy, now: deps.now() });
    if (!denied) return null;
    const after = store.getCompanyBoxApproval(approval.id)!;
    onApprovalDenied(after);
    return after;
  };

  /** The owner denied a held channel post: it is skipped with a receipt. */
  const onApprovalDenied = (approval: CompanyBoxApproval) => {
    const postId = typeof approval.arguments.postId === "string" ? approval.arguments.postId : "";
    const post = channels.getPost(org, postId);
    if (post?.status !== "held") return;
    endPost(post, channels.getChannel(org, post.channelId), "skipped", "approval_denied");
  };

  /** The owner resolved an `uncertain` post after checking the destination. */
  const resolveUncertain = (postId: string, status: "sent" | "failed", operatorId: string) => {
    const post = channels.getPost(org, postId);
    if (!post) return { ok: false as const, status: 404, error: "channel_post_not_found" };
    if (post.status !== "uncertain") return { ok: false as const, status: 409, error: "channel_post_not_uncertain" };
    const resolved = channels.finishPost(org, post.id, { status, from: ["uncertain"], reason: `resolved_by_owner_${status}`, now: deps.now() });
    if (!resolved) return { ok: false as const, status: 409, error: "channel_post_not_uncertain" };
    const channel = channels.getChannel(org, post.channelId);
    const previous = channels.getReceiptByPost(org, post.id);
    if (channel) {
      channels.upsertReceipt({
        postId: post.id,
        workspaceSlug: org,
        channelId: post.channelId,
        agentId: post.agentId,
        provider: channel.provider,
        digest: post.digest,
        authority: post.authority,
        status,
        resultIds: previous?.resultIds ?? [],
        resultUrls: previous?.resultUrls ?? [],
        detail: redact(`${previous?.detail ?? channel.provider} · resolved ${status} by owner`),
        text: previous?.text ?? null,
        approvedAt: previous?.approvedAt ?? null,
        sentAt: status === "sent" ? previous?.sentAt ?? deps.now().toISOString() : null,
        now: deps.now(),
      });
    }
    store.recordAudit({
      workspaceSlug: org,
      pluginId: channel ? channelPluginId(channel.provider) : null,
      eventType: "marketplace.channels.post.resolved",
      actorId: operatorId,
      metadata: { channelId: post.channelId, postId: post.id, digest: post.digest, outcome: status },
    });
    return { ok: true as const, post: resolved };
  };

  const cleanupAttachments = (now: Date) =>
    channels.cleanupAttachments({
      rootDir: attachmentsDir,
      now,
      unreferencedAfterMs: CHANNEL_ATTACHMENT_UNREFERENCED_MS,
      retentionMs: CHANNEL_RECEIPT_RETENTION_MS,
      limit: CHANNEL_ATTACHMENT_CLEANUP_BATCH,
    });

  /**
   * Inbound retention. Runs in every scheduler tick, and also bounded at start and on each owner browse, so it
   * runs when the scheduler is off or Channels went inert (review F7).
   */
  const purgeInbound = (now: Date, limit?: number) => {
    const settings = channels.inbound.getSettings(org);
    const purged = channels.inbound.purge({
      workspaceSlug: org,
      textBefore: new Date(now.getTime() - settings.textRetentionDays * 86_400_000),
      rowsBefore: new Date(now.getTime() - INBOUND_METADATA_RETENTION_MS),
      now,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (purged.textPurged > 0 || purged.deleted > 0 || purged.chatsPurged > 0) {
      store.recordAudit({
        workspaceSlug: org,
        pluginId: null,
        eventType: "marketplace.channels.inbound.purged",
        actorId: "marketplace:retention",
        metadata: { textPurged: purged.textPurged, deleted: purged.deleted, chatsPurged: purged.chatsPurged, textRetentionDays: settings.textRetentionDays },
      });
    }
    return purged;
  };

  // ----- scheduler tick (1g) --------------------------------------------------

  /**
   * One scheduler tick (spec §6 "Scheduled posts"). Never re-sends: a row
   * left in `sending` past its lease becomes `uncertain`; a due row is
   * claimed with a guarded UPDATE (lease 120 s) and re-checked at send time;
   * any failure is `skipped` with the reason; more than 15 minutes late is
   * `expired`. `run` sends one claimed post through executeConsentedCall.
   */
  const tick = async (input: {
    now: Date;
    claimer: string;
    run: (post: ChannelPostRecord, consent: MarketplaceAgentConsent, claimer: string) => Promise<void>;
  }) => {
    const report = { recovered: 0, expired: 0, sent: 0, skipped: 0, claimed: 0 };
    // §7 retention: receipts of finished posts older than the retention go; open posts keep theirs (Q2).
    channels.purgeReceipts(org, new Date(input.now.getTime() - CHANNEL_RECEIPT_RETENTION_MS));
    // Routes v2: sent-message rows go with their receipts (or after the retention), and old lookup rows after 2 days.
    channels.actions.purgeSentMessages(org, new Date(input.now.getTime() - CHANNEL_RECEIPT_RETENTION_MS));
    channels.actions.purgeLookups(org, new Date(input.now.getTime() - 2 * 86_400_000));
    // Inbound retention: received text after the owner's retention (default 30 days), metadata rows after 90 days.
    purgeInbound(input.now);
    // Q1: unreferenced attachments after 24 h, finished posts' attachments after purge or retention (bounded).
    cleanupAttachments(input.now);
    for (const post of channels.recoverStaleSending({ now: input.now })) {
      report.recovered += 1;
      const channel = channels.getChannel(post.workspaceSlug, post.channelId);
      if (channel && post.workspaceSlug === org) writeReceipt({ post, channel, status: "uncertain", reason: "send_lease_expired" });
      audit("marketplace.channels.post.uncertain", post, channel?.provider ?? "unknown", { reason: "send_lease_expired" });
    }
    // Holds whose approval ended without an approval (`failed`, e.g. decided by 0.1.19 during a rollback)
    // end as skipped with a receipt, immediate or scheduled; they are never sent.
    for (const post of channels.listPosts(org, { status: "held", limit: 200 })) {
      const approval = approvalForPost(post);
      if (approval && approvalEndedUnapproved(approval.state)) {
        if (endPost(post, channels.getChannel(org, post.channelId), "skipped", "approval_failed")) report.skipped += 1;
        continue;
      }
      if (post.mode !== "immediate") continue;
      if (approval?.state === "expired") endPost(post, channels.getChannel(org, post.channelId), "expired", "approval_expired");
      else if (approval?.state === "denied") endPost(post, channels.getChannel(org, post.channelId), "skipped", "approval_denied");
      else if (approval?.state === "executing" && Date.parse(approval.expiresAt) <= deps.now().getTime()) {
        // L4: approved but never sent before the approval expired.
        if (endPost(post, channels.getChannel(org, post.channelId), "expired", "approval_expired")) {
          finishApproval(approval.id, null, "approval_expired");
          report.expired += 1;
        }
      }
    }
    // L5: lateness is measured per post at the moment it is handled, not at the tick start.
    const late = (post: ChannelPostRecord) => post.sendAt !== null && deps.now().getTime() - Date.parse(post.sendAt) > CHANNEL_SCHEDULE_LATE_MS;
    // Held scheduled posts at their send time: send if approved, else expire (the approval expired at sendAt).
    for (const post of channels.listDueHeldPosts({ now: input.now })) {
      if (post.workspaceSlug !== org) continue;
      const channel = channels.getChannel(org, post.channelId);
      const approval = approvalForPost(post);
      if (late(post) || !approval || approval.state !== "executing") {
        endPost(post, channel, "expired", late(post) ? "send_window_missed" : "approval_not_given");
        if (approval?.state === "executing") finishApproval(approval.id, null, "channel_post_expired");
        report.expired += 1;
        continue;
      }
      const consent = store.getMarketplaceAgentConsentById(post.consentId);
      if (!consent || consent.state !== "active" || !channel) {
        endPost(post, channel, "skipped", "consent_inactive");
        finishApproval(approval.id, null, "approval_authority_revoked");
        report.skipped += 1;
        continue;
      }
      await input.run(post, consent, input.claimer);
      const after = channels.getPost(org, post.id);
      if (after?.status === "sent") report.sent += 1;
      else if (after?.status === "skipped") report.skipped += 1;
    }
    const claimed = channels.claimDuePosts({ now: input.now, claimer: input.claimer, leaseMs: CHANNEL_SCHEDULER_LEASE_MS });
    report.claimed = claimed.length;
    for (const post of claimed) {
      if (post.workspaceSlug !== org) continue;
      const channel = channels.getChannel(org, post.channelId);
      if (late(post)) {
        endPost(post, channel, "expired", "send_window_missed", input.claimer);
        report.expired += 1;
        continue;
      }
      const consent = store.getMarketplaceAgentConsentById(post.consentId);
      if (!consent || consent.state !== "active" || !channel) {
        if (consent && consent.state !== "active") grants.suspendForConsent(org, consent.id);
        endPost(post, channel, "skipped", "consent_inactive", input.claimer);
        report.skipped += 1;
        continue;
      }
      await input.run(post, consent, input.claimer);
      const after = channels.getPost(org, post.id);
      if (after?.status === "sent") report.sent += 1;
      else if (after?.status === "skipped") report.skipped += 1;
    }
    return report;
  };

  // ----- discovery cache (owner) ---------------------------------------------

  const discover = async (provider: ChannelProviderId): Promise<DiscoverResult> => {
    const adapter = deps.providers[provider];
    const credential = credentials.get(provider);
    if (!adapter) return { ok: false, reason: "provider_unavailable" };
    if (!credential) return { ok: false, reason: "credential_missing" };
    // Telegram with the inbound webhook set: getUpdates answers 409, so discovery reads the chats the webhook saw.
    const chatsSeen = (): DiscoverResult => ({
      ok: true,
      destinations: channels.inbound.listTelegramDestinations(org),
      notes: ["Inbound is on: these are the chats where the bot saw a message or was added since. Write a message in a new chat to list it."],
    });
    let result: DiscoverResult;
    if (provider === "telegram" && channels.inbound.activeWebhook(org, "telegram")) {
      result = chatsSeen();
    } else {
      result = await adapter.discover(credential.value);
      if (!result.ok && result.reason === "consumer_conflict" && provider === "telegram" && channels.inbound.listTelegramDestinations(org).length > 0) {
        result = chatsSeen();
      }
    }
    if (result.ok) discovered.set(provider, { at: Date.now(), destinations: result.destinations });
    return result;
  };

  const discoveredDestination = (provider: ChannelProviderId, externalId: string, parentId?: string) => {
    const entry = discovered.get(provider);
    if (!entry || Date.now() - entry.at > DISCOVERY_TTL_MS) return null;
    return entry.destinations.find((destination) => destination.externalId === externalId && (parentId === undefined || destination.parentId === parentId)) ?? null;
  };

  /** The Teams app id and tenant id (never the secret), for the messaging endpoint; null without a usable credential. */
  const teamsIdentity = (): { appId: string; tenantId: string } | null => {
    const credential = credentials.get("teams");
    if (!credential) return null;
    const parsed = parseTeamsCredential(credential.value);
    return parsed.ok ? { appId: parsed.credential.appId, tenantId: parsed.credential.tenantId } : null;
  };

  /** The bot's own platform user id from the verified connection (inbound ignores its own messages). */
  const botIdFor = (provider: ChannelProviderId): string | null => {
    const connection = store.getConnection(org, channelPluginId(provider));
    const botId = connection?.metadata.botId;
    return typeof botId === "string" && botId.length > 0 ? botId : null;
  };

  /** The Slack workspace (auth.test team_id) of the verified connection, or null (review F6). */
  const slackTeamId = (): string | null => {
    const teamId = store.getConnection(org, channelPluginId("slack"))?.metadata.teamId;
    return typeof teamId === "string" && teamId.length > 0 ? teamId : null;
  };

  // ----- people (routes v2, review R5) ----------------------------------------

  /**
   * `marketplace.channel-people.find`: one person by email or handle, server-side only. The connection's people
   * policy is checked before the platform is asked (an agent cannot probe outside the allowlist), finds are capped per
   * agent, and the answer is one opaque reference with a display name, never a list.
   */
  const findPerson = async (input: { channel: ChannelRecord; agentId: string; query: { email?: unknown; handle?: unknown } }): Promise<
    { ok: true; person: PersonRecord } | { ok: false; status: number; error: string; detail?: string }
  > => {
    const { channel } = input;
    const caps = capabilitiesFor(channel.provider);
    const provider = providerFor(channel.provider);
    if (!caps?.dm.open || !provider?.findPerson || !provider.openDirect) return { ok: false, status: 422, error: "channel_capability_unavailable", detail: 'this channel\'s provider does not declare "dm"' };
    if (channel.status !== "active") return { ok: false, status: 409, error: "channel_not_active" };
    const notSendable = sendable(channel);
    if (notSendable) return { ok: false, status: notSendable.status, error: notSendable.error };
    const lookup: PersonLookup | null = normalizePersonQuery(input.query);
    if (!lookup) return { ok: false, status: 400, error: "channel_person_query_invalid", detail: "send exactly one of email or handle" };
    // Slack: this release requests users:read.email only (review R6), so a handle (users.list) cannot be looked up.
    if (channel.provider === "slack" && lookup.kind === "handle") {
      return { ok: false, status: 422, error: "channel_person_query_unsupported", detail: "Slack finds a person by email only" };
    }
    const now = deps.now();
    let lookupId: string | null = null;
    const record = (outcome: string) => {
      if (lookupId) channels.actions.finishLookup(org, lookupId, outcome);
      else channels.actions.recordLookup({ workspaceSlug: org, agentId: input.agentId, connectionId: channel.connectionId, outcome, now });
      store.recordAudit({
        workspaceSlug: org,
        pluginId: channelPluginId(channel.provider),
        eventType: "marketplace.channels.person.lookup",
        actorId: `agent:${input.agentId}`,
        // Metadata only: the query kind and outcome, never the email or handle.
        metadata: { channelId: channel.id, connectionId: channel.connectionId, kind: lookup.kind, outcome },
      });
    };
    const policy = channels.actions.getPeoplePolicy(org, channel.connectionId);
    const refused = peoplePolicyLookupRefusal(policy, channel.provider, lookup);
    if (refused) {
      record(refused.error);
      return { ok: false, status: refused.status, error: refused.error };
    }
    // The cap is checked and the slot taken in one synchronous step, before the platform is asked.
    lookupId = channels.actions.reserveLookup({
      workspaceSlug: org,
      agentId: input.agentId,
      connectionId: channel.connectionId,
      limit: PERSON_LOOKUPS_PER_DAY,
      since: new Date(now.getTime() - 86_400_000),
      now,
    });
    if (!lookupId) return { ok: false, status: 429, error: "channel_person_lookup_cap" };
    const credential = isChannelProviderId(channel.provider) ? credentials.get(channel.provider)?.value ?? null : null;
    let found;
    try {
      found = await provider.findPerson(credential, lookup.kind === "email" ? { email: lookup.value } : { handle: lookup.value });
    } catch {
      found = { ok: false as const, reason: "failed" as const, errorCode: "provider_internal_error", detail: "unexpected adapter error" };
    }
    if (!found.ok) {
      record(found.reason);
      if (found.reason === "not_found") return { ok: false, status: 404, error: "channel_person_not_found" };
      if (found.reason === "ambiguous") return { ok: false, status: 409, error: "channel_person_ambiguous", detail: redact(found.detail) };
      return { ok: false, status: 502, error: "channel_person_lookup_failed", detail: redact(`${found.errorCode}: ${found.detail}`) };
    }
    // The platform id of the person found decides an allowlist (never a display name or nickname).
    const notAllowed = peoplePolicyRefusal(policy, channel.provider, lookup, found.userId);
    if (notAllowed) {
      record(notAllowed.error);
      return { ok: false, status: notAllowed.status, error: notAllowed.error };
    }
    record("found");
    const person = channels.actions.upsertPerson({
      workspaceSlug: org,
      connectionId: channel.connectionId,
      agentId: input.agentId,
      provider: channel.provider,
      platformUserId: found.userId,
      displayName: redact(found.displayName).slice(0, 80) || found.userId,
      lookupKind: lookup.kind,
      lookupValue: lookup.value,
      now,
    });
    return { ok: true, person };
  };

  /**
   * Owner views (Approvals, posts list): what a routes v2 post does, with the excerpt of the target message for an
   * edit, delete or reaction (owner only; the text comes from the target's kept receipt) and the person's display
   * name for a direct message. Null for a plain post.
   */
  const actionView = (post: ChannelPostRecord) => {
    const spec = channels.actions.getPostOp(org, post.agentId, post.idempotencyKey);
    if (!spec || (!spec.action && !spec.poll && !spec.mentions?.length && !spec.markup)) return null;
    const channel = channels.getChannel(org, post.channelId);
    const action = spec.action;
    const base = {
      op: action?.op ?? (spec.poll ? "poll" : "post"),
      ...(spec.mentions?.length ? { mentions: spec.mentions.map((mention) => mention.name ?? mention.userId) } : {}),
      ...(spec.markup ? { markup: spec.markup } : {}),
      ...(spec.poll ? { poll: { question: spec.poll.question, options: spec.poll.options } } : {}),
    };
    if (!action) return base;
    if (action.op === "dm") {
      const person = channels.actions.getPerson(org, action.personRef);
      return {
        ...base,
        person: person
          ? {
              personRef: person.personRef,
              displayName: person.displayName,
              // The immutable platform id (Buzz: npub) beside the user-controlled display name (review of PR #51).
              platformUserId: person.provider === "buzz" ? npubEncode(person.platformUserId) : person.platformUserId,
              lookup: { kind: person.lookupKind, value: person.lookupValue },
              approved: person.approvedAt !== null,
            }
          : null,
      };
    }
    const own = channel
      ? channels.actions.ownMessage({ workspaceSlug: org, channelId: channel.id, destinationKey: destinationKey(channel.destination), messageId: action.targetMessageId })
      : null;
    const points = own?.text ? Array.from(own.text) : [];
    return {
      ...base,
      targetMessageId: action.targetMessageId,
      targetExcerpt: own?.text ? `${points.slice(0, 200).join("")}${points.length > 200 ? "…" : ""}` : null,
      ...(action.op === "react" ? { emoji: action.emoji, remove: action.remove === true } : {}),
    };
  };

  /** The credential value for the inbound worker (gateway, webhook calls), only while the provider is available. */
  const inboundCredential = (provider: ChannelProviderId): string | null =>
    currentReadiness(provider) === "available" ? credentials.get(provider)?.value ?? null : null;

  return {
    configured,
    findPerson,
    awaitOutbound,
    actionView,
    actionRefusal,
    /** Re-reads and re-verifies one provider credential (Buzz identity changes at run time). */
    refreshProvider: bootProvider,
    teamsIdentity,
    botIdFor,
    slackTeamId,
    inboundCredential,
    cleanupAttachments,
    boot,
    readinessView,
    providerFor,
    capabilitiesFor,
    grants,
    execute,
    ownerTest,
    onApprovalDenied,
    denyApprovedHold,
    cancelHeld,
    finishApproval,
    suspendForDestinationChange: (channel: ChannelRecord) => {
      // L6: a new destination changes every digest. Active grants need a new approval, and holds end now.
      const suspended = grants.suspendAll(channel, "destination_changed");
      for (const post of channels.listPosts(org, { channelId: channel.id, status: "held", limit: 1000 })) {
        const approval = approvalForPost(post);
        if (!endPost(post, channel, "skipped", "destination_changed")) continue;
        if (approval?.state === "pending") {
          store.decideCompanyBoxApproval({ id: approval.id, workspaceSlug: org, decision: "deny", decidedBy: "marketplace:destination_changed" });
        } else if (approval?.state === "executing") {
          finishApproval(approval.id, null, "destination_changed");
        }
      }
      return suspended;
    },
    resolveUncertain,
    tick,
    purgeInbound,
    discover,
    discoveredDestination,
    endPost,
    approvalForPost,
    attachmentsDir,
    redact,
    payloadFor,
    bodyFromPost,
  };
}

export type ChannelCampaign = PostCampaign;
export type { StandingGrantRecord };

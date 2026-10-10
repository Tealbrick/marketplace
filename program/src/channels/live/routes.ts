import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseApprovalResolveRequest } from "@tealbrick/contract";
import { z } from "zod";

import type { SqliteMarketplaceStore } from "../../store.js";
import type { CompanyBoxApproval, MarketplaceAgentConsent } from "../../types.js";
import { NOSTR_MIN_PREFIX_HEX } from "../approvals.js";
import { npubEncode } from "../providers/nostr.js";
import { capabilitySupports } from "../providers/capabilities.js";
import type { ChannelCapabilities } from "../providers/types.js";
import { readAttachmentBytes, type ChannelRecord } from "../store.js";
import { LiveGrantProposalSchema, LiveGrantTermsSchema, liveGrantOf, liveGrantView, type LiveGrantService } from "./grants.js";
import type { LiveSessionManager, LiveResult } from "./sessions.js";
import type { LiveGrantRecord, LiveTranscriptRecord } from "./store.js";

/** Manifest operation ids of the live-session operations (agent audience). */
export const LIVE_AGENT_OPERATION = Object.freeze({
  liveGrantsList: "marketplace.channel-live-grants.list",
  liveGrantsPropose: "marketplace.channel-live-grants.propose",
  liveGrantsNarrow: "marketplace.channel-live-grants.narrow",
  liveGrantsWithdraw: "marketplace.channel-live-grants.withdraw",
  liveGrantsResolve: "marketplace.channel-live-grants.resolve",
  liveGrantsCommand: "marketplace.channel-live-grants.command",
  liveJoin: "marketplace.channel-live.join",
  liveLeave: "marketplace.channel-live.leave",
  liveSpeak: "marketplace.channel-live.speak",
  liveTranscript: "marketplace.channel-live.transcript",
} as const);

/** Owner-audience operations (strict owner gate for approve, narrow, resume and the control switch). */
export const LIVE_OWNER_OPERATION = Object.freeze({
  inbox: "marketplace.channel-live-grants.inbox",
  approve: "marketplace.channel-live-grants.approve",
  ownerNarrow: "marketplace.channel-live-grants.restrict",
  decline: "marketplace.channel-live-grants.decline",
  revoke: "marketplace.channel-live-grants.revoke",
  pause: "marketplace.channel-live-grants.pause",
  resume: "marketplace.channel-live-grants.resume",
  control: "marketplace.channel-live-control.update",
  stop: "marketplace.channel-live-sessions.stop",
  ownerTranscript: "marketplace.channel-live-sessions.transcript",
} as const);

/** The CompanyBox hold of one speak-approved clip. */
export const LIVE_CLIP_ACTION = "live.speak-clip";
export const LIVE_CLIP_DIGEST_DOMAIN = "tealbrick-live-clip/v1\n";
const LIVE_CLIP_TTL_MS = 24 * 3_600_000;
const LIVE_CLIP_MAX_BYTES = 512 * 1024;
const LIVE_CLIP_MAX_PENDING = 20;

/** The digest the owner approves for a clip: domain-separated, bound to the grant id and the clip bytes' SHA-256. */
export function liveClipDigest(grantId: string, clipSha256: string): string {
  return createHash("sha256").update(`${LIVE_CLIP_DIGEST_DOMAIN}${grantId}\n${clipSha256}`, "utf8").digest("hex");
}
export const liveClipApprovalKey = (grantId: string, clipSha256: string) => `live-clip.${grantId}.${clipSha256}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GRANT_ID = /^live-[0-9a-f]{16}$/u;
const SESSION_ID = /^lvs_[0-9a-f-]{36}$/u;
const AGENT_PREFIX = "/api/marketplace/v1/agent/channels";
const OWNER_PREFIX = "/api/marketplace/channels/live";

const JoinSchema = z.strictObject({
  grantId: z.string().regex(GRANT_ID),
  huddleId: z.string().regex(UUID),
  modes: z.strictObject({ listen: z.literal(true).optional(), speakApproved: z.literal(true).optional(), speakLive: z.literal(true).optional() }),
});
const SpeakSchema = z.union([
  z.strictObject({ attachmentId: z.string().min(1).max(100) }),
  z.strictObject({ text: z.string().min(1).max(4096), voice: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/u).optional() }),
]);
const CommandSchema = z.strictObject({ event: z.record(z.unknown()) });
const OwnerApproveSchema = z.strictObject({ digest: z.string().regex(/^[0-9a-f]{64}$/u), workspaceSlug: z.string().optional() });
const OwnerNarrowSchema = z.strictObject({ terms: LiveGrantTermsSchema, workspaceSlug: z.string().optional() });
const ControlSchema = z.strictObject({
  paused: z.boolean().optional(),
  commandChannel: z.union([z.string().regex(UUID), z.null()]).optional(),
  workspaceSlug: z.string().optional(),
});

type Caller = { grant: { principalId: string; workspaceId: string | null }; agentId: string };
type Found = { channel: ChannelRecord; consent: MarketplaceAgentConsent; selection: { grantClass: string } };

export type LiveRouteContext = {
  app: FastifyInstance;
  store: SqliteMarketplaceStore;
  organizationId: string;
  now: () => Date;
  grants: LiveGrantService;
  sessions: LiveSessionManager;
  attachmentsDir: string;
  capabilitiesFor: (provider: string) => ChannelCapabilities | null;
  /** Agent gate (grant + operation + configured + ready), or null (the answer is set). */
  agentPreamble: (request: FastifyRequest, reply: FastifyReply, operationId: string) => Promise<Caller | null>;
  agentDenied: (request: FastifyRequest) => Record<string, unknown>;
  consentedChannel: (caller: Caller, channelId: string) => Found | null;
  owner: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string; organizationId: string } | null>;
  ownerDenied: (request: FastifyRequest) => Record<string, unknown>;
  strictOwner: (request: FastifyRequest, reply: FastifyReply) => Promise<{ ok: true; actor: string } | { ok: false; body: Record<string, unknown> }>;
  idempotent: (
    reply: FastifyReply,
    input: { scope: string; key: string; request: unknown },
    run: () => Promise<{ status: number; body: Record<string, unknown> }> | { status: number; body: Record<string, unknown> },
  ) => Promise<Record<string, unknown>>;
  idempotencyKey: (request: FastifyRequest) => string | null;
  /** Live voice is inert without a Buzz identity key. */
  buzzReady: () => boolean;
};

export function registerLiveRoutes(ctx: LiveRouteContext): void {
  const { app, store } = ctx;
  const live = store.channels.live;
  const org = ctx.organizationId;

  const fail = (reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) => {
    reply.code(status);
    return { ok: false, schema: 1, error, ...extra };
  };
  const send = (reply: FastifyReply, result: LiveResult) => {
    reply.code(result.status);
    return result.body;
  };
  const outcomeBody = (outcome: Awaited<ReturnType<LiveGrantService["approveWithProof"]>>, status = 200) =>
    outcome.ok
      ? { status, body: { ok: true, schema: 1, ...(outcome.replayed ? { replayed: true } : {}), grant: grantViewWithUsage(outcome.grant) } }
      : {
          status: outcome.status,
          body: {
            ok: false,
            schema: 1,
            error: outcome.error,
            ...(outcome.fields ? { fields: outcome.fields } : {}),
            ...(outcome.errors ? { errors: outcome.errors } : {}),
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          },
        };
  const grantViewWithUsage = (record: LiveGrantRecord) => liveGrantView(record, { usage: ctx.sessions.usageView(record, liveGrantOf(record)) });

  /** Live features answer only where the provider declares them and Marketplace wires them (Buzz huddles). */
  const liveDeclared = (channel: ChannelRecord, feature: "live.join" | "live.speak" | "live.transcript") => {
    const caps = ctx.capabilitiesFor(channel.provider);
    return Boolean(caps && capabilitySupports(caps, feature));
  };

  const outwardChannel = (caller: Caller, channelId: string, reply: FastifyReply): Found | { error: Record<string, unknown> } => {
    const found = ctx.consentedChannel(caller, channelId);
    if (!found) return { error: fail(reply, 404, "channel_not_found") };
    if (found.selection.grantClass !== "outward") return { error: fail(reply, 403, "channel_outward_consent_required") };
    return found;
  };

  const ownGrant = (caller: Caller, grantId: string) => {
    const record = GRANT_ID.test(grantId) ? live.getGrant(org, grantId) : null;
    return record && record.agentId === caller.agentId ? record : null;
  };

  // ----- agent: grants --------------------------------------------------------------

  app.get(`${AGENT_PREFIX}/live-grants`, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveGrantsList);
    if (!caller) return ctx.agentDenied(request);
    return { ok: true, schema: 1, grants: live.listGrants(org, { agentId: caller.agentId }).map(grantViewWithUsage) };
  });

  app.post(`${AGENT_PREFIX}/:channelId/live-grants`, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveGrantsPropose);
    if (!caller) return ctx.agentDenied(request);
    const key = ctx.idempotencyKey(request);
    if (!key) return fail(reply, 400, "idempotency_key_required");
    if (!ctx.buzzReady()) return fail(reply, 409, "live_buzz_identity_missing");
    const parsed = LiveGrantProposalSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { channelId } = request.params as { channelId: string };
    const found = outwardChannel(caller, channelId, reply);
    if ("error" in found) return found.error;
    if (!liveDeclared(found.channel, "live.join")) return fail(reply, 422, "channel_capability_unavailable", { feature: "live.join" });
    return ctx.idempotent(reply, { scope: `channel-live-grant-propose:${caller.agentId}`, key, request: { channelId, proposal: parsed.data } }, () =>
      outcomeBody(ctx.grants.propose({ channel: found.channel, agentId: caller.agentId, consentRowId: found.consent.id, proposal: parsed.data }), 201),
    );
  });

  app.post(`${AGENT_PREFIX}/live-grants/:grantId/narrow`, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveGrantsNarrow);
    if (!caller) return ctx.agentDenied(request);
    const key = ctx.idempotencyKey(request);
    if (!key) return fail(reply, 400, "idempotency_key_required");
    const parsed = LiveGrantTermsSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { grantId } = request.params as { grantId: string };
    const record = ownGrant(caller, grantId);
    if (!record) return fail(reply, 404, "live_grant_not_found");
    return ctx.idempotent(reply, { scope: `channel-live-grant-narrow:${caller.agentId}`, key, request: { grantId, terms: parsed.data } }, () =>
      outcomeBody(ctx.grants.narrow({ record, terms: parsed.data, actor: "agent", actorId: `agent:${caller.agentId}` })),
    );
  });

  app.post(`${AGENT_PREFIX}/live-grants/:grantId/withdraw`, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveGrantsWithdraw);
    if (!caller) return ctx.agentDenied(request);
    const { grantId } = request.params as { grantId: string };
    const record = ownGrant(caller, grantId);
    if (!record) return fail(reply, 404, "live_grant_not_found");
    const result = outcomeBody(ctx.grants.withdraw(record));
    reply.code(result.status);
    return result.body;
  });

  /**
   * The owner's signed approval of the caller's own pending grant, forwarded by the agent: the K1 body
   * `{approvalId: <grant id>, proof}`. The Buzz conversation is the grant's own (our record), never the request's.
   */
  app.post(`${AGENT_PREFIX}/live-grants/:grantId/resolve`, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveGrantsResolve);
    if (!caller) return ctx.agentDenied(request);
    const key = ctx.idempotencyKey(request);
    if (!key) return fail(reply, 400, "idempotency_key_required");
    const { grantId } = request.params as { grantId: string };
    const resolve = parseApprovalResolveRequest(request.body);
    if (!resolve || resolve.approvalId !== grantId) return fail(reply, 400, "validation_failed");
    const record = ownGrant(caller, grantId);
    if (!record) return fail(reply, 404, "live_grant_not_found");
    if (record.status === "active" && record.approvedDigest === record.digest) return { ok: true, schema: 1, replayed: true, grant: grantViewWithUsage(record) };
    const proof = resolve.proof as Parameters<LiveGrantService["approveWithProof"]>[0]["proof"];
    const outcome = await ctx.grants.approveWithProof({ record, proof });
    const result = outcomeBody(outcome);
    reply.code(result.status);
    return result.body;
  });

  /** A forwarded owner-signed `revoke <id>` / `pause grants` / `resume grants` (any agent may forward; the signature decides). */
  app.post(`${AGENT_PREFIX}/live-grants/commands`, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveGrantsCommand);
    if (!caller) return ctx.agentDenied(request);
    const parsed = CommandSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const outcome = await ctx.grants.ownerCommand({ event: parsed.data.event });
    if (!outcome.ok) return fail(reply, outcome.status, outcome.error, outcome.reason ? { reason: outcome.reason } : {});
    return {
      ok: true,
      schema: 1,
      command: outcome.command,
      // An agent sees its own grant only.
      ...(outcome.grant && outcome.grant.agentId === caller.agentId ? { grant: liveGrantView(outcome.grant) } : {}),
      ...(outcome.paused !== undefined ? { paused: outcome.paused } : {}),
    };
  });

  // ----- agent: sessions --------------------------------------------------------------

  app.post(`${AGENT_PREFIX}/:channelId/live/sessions`, { bodyLimit: 4 * 1024 }, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveJoin);
    if (!caller) return ctx.agentDenied(request);
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    const key = ctx.idempotencyKey(request);
    if (!key) return fail(reply, 400, "idempotency_key_required");
    if (!ctx.buzzReady()) return fail(reply, 409, "live_buzz_identity_missing");
    const parsed = JoinSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { channelId } = request.params as { channelId: string };
    const found = outwardChannel(caller, channelId, reply);
    if ("error" in found) return found.error;
    if (!liveDeclared(found.channel, "live.join")) return fail(reply, 422, "channel_capability_unavailable", { feature: "live.join" });
    return ctx.idempotent(reply, { scope: `channel-live-join:${caller.agentId}`, key, request: { channelId, ...parsed.data } }, () =>
      ctx.sessions.join({ agentId: caller.agentId, channel: found.channel, grantId: parsed.data.grantId, huddleId: parsed.data.huddleId, modes: parsed.data.modes }),
    );
  });

  app.post(`${AGENT_PREFIX}/:channelId/live/sessions/:sessionId/leave`, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveLeave);
    if (!caller) return ctx.agentDenied(request);
    const { channelId, sessionId } = request.params as { channelId: string; sessionId: string };
    if (!SESSION_ID.test(sessionId)) return fail(reply, 404, "live_session_not_found");
    // Leaving only narrows: no consent check beyond owning the session.
    return send(reply, await ctx.sessions.leave({ agentId: caller.agentId, channelId, sessionId }));
  });

  /**
   * speak-approved: `{attachmentId}` of an uploaded Ogg/Opus clip. The first call holds the clip for the owner (the
   * normal approval queue: Marketplace UI, Buzz `approve <prefix>`, TBD) and answers 202; after approval the same
   * clip plays. speak-live: `{text, voice?}` under the grant's speakLive mode.
   */
  app.post(`${AGENT_PREFIX}/:channelId/live/sessions/:sessionId/speak`, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveSpeak);
    if (!caller) return ctx.agentDenied(request);
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    const key = ctx.idempotencyKey(request);
    if (!key) return fail(reply, 400, "idempotency_key_required");
    const parsed = SpeakSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { channelId, sessionId } = request.params as { channelId: string; sessionId: string };
    const found = outwardChannel(caller, channelId, reply);
    if ("error" in found) return found.error;
    if (!liveDeclared(found.channel, "live.speak")) return fail(reply, 422, "channel_capability_unavailable", { feature: "live.speak" });
    const session = SESSION_ID.test(sessionId) ? live.getSession(org, sessionId) : null;
    if (!session || session.agentId !== caller.agentId || session.channelId !== channelId) return fail(reply, 404, "live_session_not_found");
    if ("text" in parsed.data) {
      const data = parsed.data;
      return ctx.idempotent(reply, { scope: `channel-live-speak:${caller.agentId}`, key, request: { sessionId, text: data.text, voice: data.voice ?? null } }, () =>
        ctx.sessions.speakText({ agentId: caller.agentId, channelId, sessionId, text: data.text, ...(data.voice ? { voice: data.voice } : {}) }),
      );
    }
    const attachment = store.channels.getAttachment(org, parsed.data.attachmentId);
    if (!attachment || attachment.createdBy !== caller.agentId) return fail(reply, 404, "channel_attachment_not_found");
    if (attachment.contentType !== "audio/ogg" || attachment.bytes > LIVE_CLIP_MAX_BYTES) return fail(reply, 415, "live_clip_type_invalid", { contentType: "audio/ogg", maxBytes: LIVE_CLIP_MAX_BYTES });
    const clipSha256 = attachment.sha256;
    const digest = liveClipDigest(session.grantId, clipSha256);
    const approvalKey = liveClipApprovalKey(session.grantId, clipSha256);
    const existing = store.findCompanyBoxApprovalByKey({ workspaceSlug: org, agentId: caller.agentId, idempotencyKey: approvalKey });
    if (existing && existing.state === "succeeded" && existing.fingerprint === digest && existing.sourceKind === "live-clip") {
      let bytes: Buffer;
      try {
        bytes = readAttachmentBytes(ctx.attachmentsDir, clipSha256);
      } catch {
        return fail(reply, 410, "channel_attachment_gone");
      }
      return ctx.idempotent(reply, { scope: `channel-live-speak:${caller.agentId}`, key, request: { sessionId, clipSha256 } }, async () => {
        try {
          return await ctx.sessions.speakClip({ agentId: caller.agentId, channelId, sessionId, clip: new Uint8Array(bytes), clipSha256 });
        } finally {
          bytes.fill(0);
        }
      });
    }
    if (existing) {
      if (existing.state === "denied" || existing.state === "failed") return fail(reply, 403, "live_clip_denied", { approvalId: existing.id });
      if (existing.state === "expired") return fail(reply, 410, "live_clip_approval_expired", { approvalId: existing.id });
      reply.code(202);
      return { ok: true, schema: 1, status: "approval_pending", approvalId: existing.id, digest, clipSha256, approvalText: `approve ${digest.slice(0, NOSTR_MIN_PREFIX_HEX)}` };
    }
    // The clip must be playable under the grant before the owner is asked.
    const grantRecord = live.getGrant(org, session.grantId);
    const usable = ctx.grants.usable(grantRecord);
    if (!usable.ok) return fail(reply, 409, "live_grant_not_active", { reason: usable.reason });
    if (!usable.grant.scope.modes.speakApproved || !session.modes.speakApproved) return fail(reply, 403, "live_mode_not_granted", { modes: ["speakApproved"] });
    if (store.countPendingCompanyBoxApprovals({ workspaceSlug: org, agentId: caller.agentId }) >= LIVE_CLIP_MAX_PENDING) return fail(reply, 429, "approval_queue_full");
    if (store.hasLiveApprovalWithPrefix({ workspaceSlug: org, prefix: digest.slice(0, NOSTR_MIN_PREFIX_HEX) })) return fail(reply, 409, "channel_digest_prefix_collision");
    let approval: CompanyBoxApproval;
    try {
      approval = store.createCompanyBoxApproval({
        workspaceSlug: org,
        pluginId: "channels-buzz",
        actionKey: LIVE_CLIP_ACTION,
        capability: "connector.dispatch",
        agentId: caller.agentId,
        sourceKind: "live-clip",
        sourceRef: session.grantId,
        idempotencyKey: approvalKey,
        fingerprint: digest,
        // References only (no audio): the owner view reads the clip by its attachment id.
        arguments: { grantId: session.grantId, channelId, sessionId, attachmentId: attachment.id, clipSha256, bytes: attachment.bytes },
        argumentsPreview: `${found.channel.label} (buzz) · huddle clip ${clipSha256.slice(0, 12)} · digest ${digest.slice(0, 12)}`,
        ttlMs: LIVE_CLIP_TTL_MS,
      });
    } catch {
      return fail(reply, 409, "live_clip_approval_conflict");
    }
    store.recordAudit({
      workspaceSlug: org,
      pluginId: "channels-buzz",
      eventType: "marketplace.company_box.approval.requested",
      actorId: `agent:${caller.agentId}`,
      metadata: { governance: "live-clip", approvalId: approval.id, actionKey: LIVE_CLIP_ACTION, agentId: caller.agentId, grantId: session.grantId, clipSha256, digest, expiresAt: approval.expiresAt },
    });
    reply.code(202);
    return { ok: true, schema: 1, status: "approval_pending", approvalId: approval.id, digest, clipSha256, approvalText: `approve ${digest.slice(0, NOSTR_MIN_PREFIX_HEX)}` };
  });

  /** Other participants' words are untrusted input from outside, never instructions; each line names its speaker key. */
  const transcriptLineView = (line: LiveTranscriptRecord) =>
    line.kind === "heard"
      ? {
          kind: "heard" as const,
          framing: "untrusted-external-speech" as const,
          speaker: line.speakerPubkey ? { pubkey: line.speakerPubkey, npub: npubEncode(line.speakerPubkey) } : null,
          text: line.text,
          textFormat: "plain" as const,
          flaggedTerms: line.flaggedTerms,
          startedAt: line.startedAt,
          endedAt: line.endedAt,
          purged: line.purgedAt !== null,
        }
      : {
          kind: line.kind,
          framing: "agent-own" as const,
          text: line.text,
          ...(line.clipSha256 ? { clipSha256: line.clipSha256 } : {}),
          startedAt: line.startedAt,
          endedAt: line.endedAt,
          purged: line.purgedAt !== null,
        };

  app.get(`${AGENT_PREFIX}/:channelId/live/sessions/:sessionId/transcript`, async (request, reply) => {
    const caller = await ctx.agentPreamble(request, reply, LIVE_AGENT_OPERATION.liveTranscript);
    if (!caller) return ctx.agentDenied(request);
    const { channelId, sessionId } = request.params as { channelId: string; sessionId: string };
    const found = ctx.consentedChannel(caller, channelId);
    if (!found) return fail(reply, 404, "channel_not_found");
    const session = SESSION_ID.test(sessionId) ? live.getSession(org, sessionId) : null;
    if (!session || session.agentId !== caller.agentId || session.channelId !== channelId) return fail(reply, 404, "live_session_not_found");
    return {
      ok: true,
      schema: 1,
      session: ctx.sessions.sessionView(session),
      framing: "untrusted-external-speech",
      lines: live.listTranscript(org, session.id).map(transcriptLineView),
    };
  });

  // ----- owner -------------------------------------------------------------------------

  const ownerGrant = (grantId: string) => (GRANT_ID.test(grantId) ? live.getGrant(org, grantId) : null);

  app.get(OWNER_PREFIX, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    try {
      ctx.sessions.purge(ctx.now());
    } catch {
      // Retention never breaks the owner view.
    }
    const channelLabel = (channelId: string) => store.channels.getChannel(org, channelId)?.label ?? null;
    return {
      ok: true,
      schema: 1,
      control: live.getControl(org),
      buzzReady: ctx.buzzReady(),
      grants: live.listGrants(org).map((record) => ({ ...grantViewWithUsage(record), channelLabel: channelLabel(record.channelId) })),
      sessions: live.listSessions(org, { limit: 50 }).map((session) => ({ ...ctx.sessions.sessionView(session), channelLabel: channelLabel(session.channelId) })),
    };
  });

  app.post(`${OWNER_PREFIX}/grants/:grantId/approve`, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    // Approving widens what an agent may do: the pinned owner's own launch session only.
    const gate = await ctx.strictOwner(request, reply);
    if (!gate.ok) return gate.body;
    const parsed = OwnerApproveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const record = ownerGrant((request.params as { grantId: string }).grantId);
    if (!record) return fail(reply, 404, "live_grant_not_found");
    const result = outcomeBody(ctx.grants.approveInUi({ record, digest: parsed.data.digest, actorId: gate.actor }));
    reply.code(result.status);
    return result.body;
  });

  app.post(`${OWNER_PREFIX}/grants/:grantId/narrow`, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    // The owner may set the consent flags either way: the pinned owner only.
    const gate = await ctx.strictOwner(request, reply);
    if (!gate.ok) return gate.body;
    const parsed = OwnerNarrowSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const record = ownerGrant((request.params as { grantId: string }).grantId);
    if (!record) return fail(reply, 404, "live_grant_not_found");
    const result = outcomeBody(ctx.grants.narrow({ record, terms: parsed.data.terms, actor: "owner", actorId: gate.actor }));
    reply.code(result.status);
    return result.body;
  });

  for (const verb of ["decline", "revoke", "pause"] as const) {
    // Narrowing actions: any owner operator session.
    app.post(`${OWNER_PREFIX}/grants/:grantId/${verb}`, async (request, reply) => {
      const principal = await ctx.owner(request, reply);
      if (!principal) return ctx.ownerDenied(request);
      const record = ownerGrant((request.params as { grantId: string }).grantId);
      if (!record) return fail(reply, 404, "live_grant_not_found");
      const actor = `operator:${principal.id}`;
      const outcome = verb === "decline" ? ctx.grants.decline(record, actor) : verb === "revoke" ? ctx.grants.revoke(record, actor) : ctx.grants.pause(record, actor);
      const result = outcomeBody(outcome);
      reply.code(result.status);
      return result.body;
    });
  }

  app.post(`${OWNER_PREFIX}/grants/:grantId/resume`, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    const gate = await ctx.strictOwner(request, reply);
    if (!gate.ok) return gate.body;
    const record = ownerGrant((request.params as { grantId: string }).grantId);
    if (!record) return fail(reply, 404, "live_grant_not_found");
    const result = outcomeBody(ctx.grants.resume(record, gate.actor));
    reply.code(result.status);
    return result.body;
  });

  /** The owner switch: pausing is open to any owner session; resuming and the command channel need the pinned owner. */
  app.put(`${OWNER_PREFIX}/control`, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    const parsed = ControlSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const widens = parsed.data.paused === false || parsed.data.commandChannel !== undefined;
    let actor = `operator:${principal.id}`;
    if (widens) {
      const gate = await ctx.strictOwner(request, reply);
      if (!gate.ok) return gate.body;
      actor = gate.actor;
    }
    if (parsed.data.commandChannel !== undefined) {
      live.setCommandChannel(org, parsed.data.commandChannel, actor, ctx.now());
      store.recordAudit({ workspaceSlug: org, pluginId: "channels-buzz", eventType: "marketplace.channels.live_control.command_channel", actorId: actor, metadata: { set: parsed.data.commandChannel !== null } });
    }
    if (parsed.data.paused !== undefined) ctx.grants.setPaused(parsed.data.paused, actor, "ui");
    return { ok: true, schema: 1, control: live.getControl(org) };
  });

  app.post(`${OWNER_PREFIX}/sessions/:sessionId/stop`, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    const { sessionId } = request.params as { sessionId: string };
    if (!SESSION_ID.test(sessionId)) return fail(reply, 404, "live_session_not_found");
    return send(reply, await ctx.sessions.stopByOwner({ sessionId, actorId: `operator:${principal.id}` }));
  });

  app.get(`${OWNER_PREFIX}/sessions/:sessionId/transcript`, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    const { sessionId } = request.params as { sessionId: string };
    const session = SESSION_ID.test(sessionId) ? live.getSession(org, sessionId) : null;
    if (!session) return fail(reply, 404, "live_session_not_found");
    return { ok: true, schema: 1, session: ctx.sessions.sessionView(session), lines: live.listTranscript(org, session.id).map(transcriptLineView) };
  });
}

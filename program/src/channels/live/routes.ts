import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { parseApprovalResolveRequest } from "@tealbrick/contract";
import { z } from "zod";

import type { SqliteMarketplaceStore } from "../../store.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE } from "../../operator-auth.js";
import type { CompanyBoxApproval, MarketplaceAgentConsent } from "../../types.js";
import { NOSTR_MIN_PREFIX_HEX } from "../approvals.js";
import { npubEncode } from "../providers/nostr.js";
import { capabilitySupports } from "../providers/capabilities.js";
import type { ChannelCapabilities } from "../providers/types.js";
import { readAttachmentBytes, type ChannelRecord } from "../store.js";
import { forbiddenTermsIn } from "./sessions.js";
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
  clip: "marketplace.channel-live-clips.get",
} as const);

/** The CompanyBox hold of one speak-approved clip. */
export const LIVE_CLIP_ACTION = "live.speak-clip";
export const LIVE_CLIP_DIGEST_DOMAIN = "tealbrick-live-clip/v1\n";
const LIVE_CLIP_TTL_MS = 24 * 3_600_000;
const LIVE_CLIP_MAX_BYTES = 512 * 1024;
const LIVE_CLIP_MAX_PENDING = 20;

/**
 * The digest the owner approves for a clip: domain-separated, bound to the grant DIGEST (a narrowed and re-approved
 * grant invalidates it), the session (expires with it) and the clip bytes' SHA-256 (review H1).
 */
export function liveClipDigest(grantDigest: string, sessionId: string, clipSha256: string): string {
  return createHash("sha256").update(`${LIVE_CLIP_DIGEST_DOMAIN}${grantDigest}\n${sessionId}\n${clipSha256}`, "utf8").digest("hex");
}
export const liveClipApprovalKey = (sessionId: string, clipSha256: string) => `live-clip.${sessionId}.${clipSha256}`;

export const LIVE_CLIP_APPROVAL_TEXT =
  "The owner approves this clip in Marketplace (Approvals) after playing it there; Buzz and TBD replies cannot approve clips.";

/**
 * Calls `onComplete` once the response finished AND exactly `expected` body bytes were handed to it (counted at
 * write/end). A response that closes before finishing (client abort) or writes fewer bytes calls nothing.
 */
export function recordWhenFullySent(
  raw: { write: (...args: never[]) => unknown; end: (...args: never[]) => unknown; once: (event: "finish", listener: () => void) => unknown },
  expected: number,
  onComplete: () => void,
): void {
  let written = 0;
  const count = (chunk: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === "function") return;
    written += chunk instanceof Uint8Array ? chunk.byteLength : Buffer.byteLength(String(chunk));
  };
  const target = raw as unknown as { write: (chunk: unknown, ...rest: unknown[]) => unknown; end: (chunk?: unknown, ...rest: unknown[]) => unknown };
  const write = target.write.bind(raw);
  const end = target.end.bind(raw);
  target.write = (chunk: unknown, ...rest: unknown[]) => {
    count(chunk);
    return write(chunk, ...rest);
  };
  target.end = (chunk?: unknown, ...rest: unknown[]) => {
    count(chunk);
    return end(chunk, ...rest);
  };
  raw.once("finish", () => {
    if (written === expected) onComplete();
  });
}

/** The owner launch session a request belongs to: SHA-256 of the operator session cookie (never the cookie itself). */
export function ownerSessionRef(cookieHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== MARKETPLACE_OPERATOR_SESSION_COOKIE) continue;
    const value = entry.slice(separator + 1).trim();
    return value ? createHash("sha256").update(`tealbrick-live-owner-session/v1\n${value}`, "utf8").digest("hex") : null;
  }
  return null;
}

/**
 * The extra checks before the owner approves a held clip (re-review of PR #53, H1), run BEFORE the hold is claimed so a
 * refusal consumes nothing: the playback route served this hold's EXACT stored clip (full body) to THIS owner launch
 * session after the hold was created and before it expires, and the page reports the SHA-256 of what it played.
 * The strict owner gate itself is checked by the caller.
 */
export function liveClipApprovalRefusal(input: {
  store: SqliteMarketplaceStore;
  approval: CompanyBoxApproval;
  cookieHeader: string | string[] | undefined;
  playedSha256: unknown;
  now: Date;
}): { status: number; error: string } | null {
  const { approval } = input;
  const clipSha256 = String(approval.arguments.clipSha256 ?? "");
  const bytes = Number(approval.arguments.bytes ?? -1);
  if (typeof input.playedSha256 !== "string" || input.playedSha256 !== clipSha256) return { status: 409, error: "live_clip_sha_mismatch" };
  const session = ownerSessionRef(input.cookieHeader);
  const expires = new Date(Math.min(Date.parse(approval.expiresAt), input.now.getTime()));
  if (
    !session ||
    !input.store.channels.live.clipPlayedTo({
      workspaceSlug: approval.workspaceSlug,
      approvalId: approval.id,
      ownerSessionRef: session,
      clipDigest: approval.fingerprint,
      clipSha256,
      bytes,
      notBefore: new Date(approval.createdAt),
      notAfter: expires,
    })
  ) {
    return { status: 409, error: "live_clip_requires_playback" };
  }
  return null;
}

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
  // The agent-stated transcript is shown to the owner with the clip and checked against the forbidden terms.
  z.strictObject({ attachmentId: z.string().min(1).max(100), transcript: z.string().min(1).max(2000) }),
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
   * speak-approved: `{attachmentId, transcript}` of an uploaded Ogg/Opus clip (review H1). The first call holds the
   * clip in the approvals queue: the owner listens to the exact stored bytes (owner playback route, strict owner gate)
   * and reads the agent-stated transcript (forbidden terms refused before any hold). The approved digest binds the
   * grant DIGEST, this session and the clip bytes; it expires with the hold (24 h) or the session, and plays ONCE.
   * speak-live: `{text, voice?}` under the grant's speakLive mode.
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
    const data = parsed.data;
    if (session.status !== "joined" && session.status !== "joining") return fail(reply, 409, "live_session_not_joined");
    const grantRecord = live.getGrant(org, session.grantId);
    const usable = ctx.grants.usable(grantRecord);
    if (!usable.ok) return fail(reply, 409, "live_grant_not_active", { reason: usable.reason });
    // The session belongs to the grant digest it joined under; a narrowed and re-approved grant is a new digest.
    if (usable.record.digest !== session.grantDigest) return fail(reply, 409, "live_grant_not_active", { reason: "grant_changed" });
    if (!usable.grant.scope.modes.speakApproved || !session.modes.speakApproved) return fail(reply, 403, "live_mode_not_granted", { modes: ["speakApproved"] });
    if (/\p{Cf}/u.test(data.transcript) || /[\u115F\u1160\u3164\uFFA0\u2800]/u.test(data.transcript)) return fail(reply, 422, "live_text_hidden_characters");
    const transcript = data.transcript.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim();
    if (!transcript) return fail(reply, 400, "validation_failed");
    if (forbiddenTermsIn(transcript, usable.grant.scope.forbiddenTerms).length > 0) return fail(reply, 422, "live_forbidden_term");
    const attachment = store.channels.getAttachment(org, data.attachmentId);
    if (!attachment || attachment.createdBy !== caller.agentId) return fail(reply, 404, "channel_attachment_not_found");
    if (attachment.contentType !== "audio/ogg" || attachment.bytes > LIVE_CLIP_MAX_BYTES) return fail(reply, 415, "live_clip_type_invalid", { contentType: "audio/ogg", maxBytes: LIVE_CLIP_MAX_BYTES });
    const clipSha256 = attachment.sha256;
    const digest = liveClipDigest(session.grantDigest, session.id, clipSha256);
    const approvalKey = liveClipApprovalKey(session.id, clipSha256);
    const existing = store.findCompanyBoxApprovalByKey({ workspaceSlug: org, agentId: caller.agentId, idempotencyKey: approvalKey });
    const pending = (approval: CompanyBoxApproval) => {
      reply.code(202);
      // A clip is approved only in the Marketplace Approvals view after the owner played it (Buzz/TBD replies are
      // refused for clips), so there is no `approve <prefix>` text to post.
      return { ok: true, schema: 1, status: "approval_pending", approvalId: approval.id, digest, clipSha256, approvalText: LIVE_CLIP_APPROVAL_TEXT };
    };
    if (existing) {
      if (existing.sourceKind !== "live-clip" || existing.fingerprint !== digest) return fail(reply, 409, "live_clip_approval_conflict");
      if (existing.state === "denied" || existing.state === "failed") return fail(reply, 403, "live_clip_denied", { approvalId: existing.id });
      if (existing.state === "expired" || Date.parse(existing.expiresAt) <= Date.now()) return fail(reply, 410, "live_clip_approval_expired", { approvalId: existing.id });
      if (existing.state !== "succeeded") return pending(existing);
      if (existing.arguments.transcript !== transcript) return fail(reply, 409, "live_clip_transcript_mismatch");
      if (live.clipUsed(existing.id)) return fail(reply, 409, "live_clip_already_played", { approvalId: existing.id });
      let bytes: Buffer;
      try {
        bytes = readAttachmentBytes(ctx.attachmentsDir, clipSha256);
      } catch {
        return fail(reply, 410, "channel_attachment_gone");
      }
      return ctx.idempotent(reply, { scope: `channel-live-speak:${caller.agentId}`, key, request: { sessionId, clipSha256 } }, async () => {
        try {
          return await ctx.sessions.speakClip({ agentId: caller.agentId, channelId, sessionId, clip: new Uint8Array(bytes), clipSha256, approvalId: existing.id, transcript });
        } finally {
          bytes.fill(0);
        }
      });
    }
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
        // References and the agent-stated transcript only; the owner plays the stored clip by this approval id.
        arguments: { grantId: session.grantId, grantDigest: session.grantDigest, channelId, sessionId, attachmentId: attachment.id, clipSha256, bytes: attachment.bytes, transcript },
        argumentsPreview: `${found.channel.label} (buzz) · huddle clip ${clipSha256.slice(0, 12)} · "${transcript.slice(0, 80)}" (agent-stated) · digest ${digest.slice(0, 12)}`,
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
      metadata: { governance: "live-clip", approvalId: approval.id, actionKey: LIVE_CLIP_ACTION, agentId: caller.agentId, grantId: session.grantId, sessionId, clipSha256, digest, expiresAt: approval.expiresAt },
    });
    return pending(approval);
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

  /**
   * Owner playback of a held speak-approved clip (review H1): the EXACT stored bytes (SHA-256 checked on read, never
   * re-encoded), `audio/ogg`, inline, no-store, with the SHA-256 in `x-content-sha256`. The pinned owner's own launch
   * session only (the owner UI fetches it with its CSRF header and plays a blob URL).
   */
  // Re-review H1c: only GET serves a clip. HEAD (Fastify adds it to every GET unless told not to) and every other
  // method answer 405 and never record a play.
  app.route({
    method: ["HEAD", "POST", "PUT", "PATCH", "DELETE"],
    url: `${OWNER_PREFIX}/clips/:approvalId`,
    handler: async (_request, reply) => {
      reply.header("allow", "GET").header("cache-control", "no-store");
      return fail(reply, 405, "method_not_allowed");
    },
  });
  app.get(`${OWNER_PREFIX}/clips/:approvalId`, { exposeHeadRoute: false }, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    const gate = await ctx.strictOwner(request, reply);
    if (!gate.ok) return gate.body;
    const { approvalId } = request.params as { approvalId: string };
    const approval = /^[A-Za-z0-9_-]{1,100}$/u.test(approvalId) ? store.getCompanyBoxApproval(approvalId) : null;
    if (!approval || approval.workspaceSlug !== org || approval.sourceKind !== "live-clip") return fail(reply, 404, "live_clip_not_found");
    // Only whole-body playback counts as listened: partial (Range) requests are refused.
    if (request.headers.range !== undefined) return fail(reply, 416, "live_clip_range_unsupported");
    const session = ownerSessionRef(request.headers.cookie);
    if (!session) return fail(reply, 403, "owner_session_required");
    const clipSha256 = String(approval.arguments.clipSha256 ?? "");
    let bytes: Buffer;
    try {
      bytes = readAttachmentBytes(ctx.attachmentsDir, clipSha256);
    } catch {
      return fail(reply, 410, "channel_attachment_gone");
    }
    // Recorded server-side ONLY when the whole body was written and the response finished (an aborted GET leaves no
    // record): this owner session was served these exact bytes for this hold digest.
    const length = bytes.length;
    recordWhenFullySent(reply.raw, length, () => {
      try {
        live.recordClipPlay({ workspaceSlug: org, approvalId: approval.id, ownerSessionRef: session, clipDigest: approval.fingerprint, clipSha256, bytes: length, now: new Date() });
      } catch {
        // No record means no approval; the owner plays it again.
      }
    });
    reply
      .header("content-type", "audio/ogg")
      .header("content-disposition", "inline")
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("x-content-sha256", clipSha256)
      .header("accept-ranges", "none");
    return reply.send(bytes);
  });

  app.get(`${OWNER_PREFIX}/sessions/:sessionId/transcript`, async (request, reply) => {
    const principal = await ctx.owner(request, reply);
    if (!principal) return ctx.ownerDenied(request);
    // L4: what the agent heard is the owner's alone: the pinned owner's own launch session (strict gate, like clip
    // playback), not any operator session.
    const gate = await ctx.strictOwner(request, reply);
    if (!gate.ok) return gate.body;
    const { sessionId } = request.params as { sessionId: string };
    const session = SESSION_ID.test(sessionId) ? live.getSession(org, sessionId) : null;
    if (!session) return fail(reply, 404, "live_session_not_found");
    return { ok: true, schema: 1, session: ctx.sessions.sessionView(session), lines: live.listTranscript(org, session.id).map(transcriptLineView) };
  });
}

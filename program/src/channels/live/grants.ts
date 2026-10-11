import {
  NOSTR_APPROVAL_MAX_AGE_MS,
  NOSTR_FUTURE_SKEW_MS,
  NOSTR_MIN_DIGEST_PREFIX,
  MAX_CLOCK_SKEW_SECONDS,
  assertServerEnforceable,
  canonicalGrant,
  createJwksResolver,
  grantApprovalWindow,
  grantDigest,
  ownerApprovalOptionsFromClaim,
  parseGrant,
  parseOwnerCommand,
  verifyGrantApproval,
  verifyOwnerCommand,
  type JwksResolver,
  type StandingGrant,
} from "@tealbrick/contract";
import { z } from "zod";

import type { ChannelRecord } from "../store.js";
import { newLiveGrantId, type LiveGrantRecord, type LiveGrantStatus, type LiveModes, type LiveStore } from "./store.js";

/**
 * Live-session grants (Channels P2 scope §2.3, contract alpha.8 `@tealbrick/contract/grants`).
 *
 * The agent proposes a live-session grant for one channel's huddles (or one huddle); the server builds the canonical
 * grant (fresh id, server-written description naming the agent and channel slug), validates it with `parseGrant`,
 * `assertServerEnforceable` and `grantApprovalWindow`, and stores `canonicalGrant` + `grantDigest`. Only the owner
 * approves exactly that digest, through:
 *
 * - the Marketplace UI (strict owner gate: the pinned owner's own launch session + CSRF), naming the digest shown;
 * - a Buzz reply `approve grant <≥32 hex>` (`verifyGrantApproval` nostr: the pinned owner Buzz key, and the channel
 *   from OUR pending record, never the request), forwarded by the agent;
 * - a TBD/Portal owner approval assertion (`op = tealbrick:standing-grant`, `approvalId` = the grant id, the pinned
 *   `ownerSubject`), forwarded by the agent.
 *
 * Every proof is single use instance-wide (`marketplace_used_approval_proof`, recorded by the contract's `isUsed`,
 * which it calls last). On success the record stores `result.canonical` exactly as returned (never re-parsed from a
 * request). Any change (agent or owner narrowing) writes a new canonical + digest and needs a new approval; nobody can
 * widen. The owner may set the consent flags either way (the owner's decision, visible in the digest); the agent may
 * only make them stricter. Owner revoke / pause / resume: the UI, or a signed `revoke <id>` / `pause grants` /
 * `resume grants` (`verifyOwnerCommand`, channel from our state).
 */

export const LIVE_DIGEST_PREFIX_MIN = NOSTR_MIN_DIGEST_PREFIX;
if (!(LIVE_DIGEST_PREFIX_MIN >= 32)) throw new Error("contract NOSTR_MIN_DIGEST_PREFIX must be at least 32");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const isoTime = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), "must be an ISO time");

const ModesSchema = z.strictObject({ listen: z.literal(true).optional(), speakApproved: z.literal(true).optional(), speakLive: z.literal(true).optional() });
const CapsSchema = z.strictObject({
  perDay: z.number().int().min(1).max(200),
  perHour: z.number().int().min(1).max(200).optional(),
  minIntervalSeconds: z.number().int().min(1).max(86_400).optional(),
});

/** What the agent proposes. The server adds the id, the description and the target. */
export const LiveGrantProposalSchema = z.strictObject({
  /** A single huddle (its ephemeral channel UUID) instead of every huddle of the channel. */
  huddleId: z.string().regex(UUID).optional(),
  modes: ModesSchema,
  maxSessionMinutes: z.number().int().min(1).max(120),
  maxDayMinutes: z.number().int().min(1).max(1440),
  costCap: z.strictObject({ providerMinutes: z.number().int().min(1).max(44_640) }),
  topic: z.string().min(1).max(500),
  forbiddenTerms: z.array(z.string().min(1).max(200)).max(64).optional(),
  /** Defaults for a new proposal: disclosureNotice ON, perParticipantConsent off (scope §2.3 rule 4). */
  consent: z.strictObject({ disclosureNotice: z.boolean().optional(), perParticipantConsent: z.boolean().optional() }).optional(),
  caps: CapsSchema.optional(),
  expires: isoTime,
});

/** A narrowing: every term restated (the consent block is REQUIRED here); the target never changes. */
export const LiveGrantTermsSchema = z.strictObject({
  modes: ModesSchema,
  maxSessionMinutes: z.number().int().min(1).max(120),
  maxDayMinutes: z.number().int().min(1).max(1440),
  costCap: z.strictObject({ providerMinutes: z.number().int().min(1).max(44_640) }),
  topic: z.string().min(1).max(500),
  forbiddenTerms: z.array(z.string().min(1).max(200)).max(64),
  consent: z.strictObject({ disclosureNotice: z.boolean(), perParticipantConsent: z.boolean() }),
  caps: CapsSchema,
  expires: isoTime,
});

export type LiveGrantProposal = z.infer<typeof LiveGrantProposalSchema>;
export type LiveGrantTerms = z.infer<typeof LiveGrantTermsSchema>;
export type LiveSessionScope = Extract<StandingGrant["scope"], { kind: "live-session" }>;
export type LiveGrant = StandingGrant & { scope: LiveSessionScope };

export type LiveOutcome =
  | { ok: true; grant: LiveGrantRecord; replayed?: boolean }
  | { ok: false; status: number; error: string; fields?: string[]; errors?: readonly string[]; reason?: string };

/** The canonical grant of a record. Our own stored canonical string, checked against its digest (fail closed). */
export function liveGrantOf(record: Pick<LiveGrantRecord, "canonical" | "digest">): LiveGrant | null {
  let value: unknown;
  try {
    value = JSON.parse(record.canonical);
  } catch {
    return null;
  }
  const parsed = parseGrant(value);
  if (!parsed.ok || parsed.grant.scope.kind !== "live-session") return null;
  try {
    if (canonicalGrant(parsed.grant) !== record.canonical || grantDigest(parsed.grant) !== record.digest) return null;
    assertServerEnforceable(parsed.grant);
  } catch {
    return null;
  }
  return parsed.grant as LiveGrant;
}

/**
 * The server-written grant description: names the agent and the channel by its slug (immutable after creation), so
 * the owner-visible, digest-covered text binds the grant to one agent and one channel.
 */
export function liveGrantDescription(agentId: string, channelSlug: string): string {
  return `Live huddle session for agent ${agentId} in channel ${channelSlug}`.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").slice(0, 300);
}

/**
 * Defence in depth (review of PR #53): the canonical grant must still be exactly what the server would write for this
 * record: its id, the description template for `record.agentId` and the channel, a target inside the channel's Buzz
 * conversation, and the approval channel of that conversation. A direct database edit of the record or the grant
 * fails closed. Returns the first mismatching field, or null.
 */
export function liveGrantIntegrityProblem(record: Pick<LiveGrantRecord, "id" | "agentId" | "approvalChannel">, grant: LiveGrant, channel: Pick<ChannelRecord, "slug" | "destination">): string | null {
  if (grant.id !== record.id) return "id";
  if (grant.description !== liveGrantDescription(record.agentId, channel.slug)) return "description";
  const parent = channel.destination.externalId;
  const target = grant.scope.target;
  if (target.voiceChannelId !== undefined) return "target";
  if (target.channelId !== undefined ? target.channelId !== parent : !(target.huddleId && UUID.test(target.huddleId))) return "target";
  if (record.approvalChannel !== parent) return "approvalChannel";
  return null;
}

/** Fields of `next` that are wider than `current` (empty: a narrowing or equal). Consent: see `ownerMaySetConsent`. */
export function wideningFields(current: LiveGrant, next: LiveGrant, input: { ownerMaySetConsent: boolean }): string[] {
  const fields: string[] = [];
  const a = current.scope;
  const b = next.scope;
  if (JSON.stringify(a.target) !== JSON.stringify(b.target)) fields.push("target");
  for (const mode of ["listen", "speakApproved", "speakLive"] as const) if (b.modes[mode] && !a.modes[mode]) fields.push(`modes.${mode}`);
  if (b.maxSessionMinutes > a.maxSessionMinutes) fields.push("maxSessionMinutes");
  if (b.maxDayMinutes > a.maxDayMinutes) fields.push("maxDayMinutes");
  if (b.costCap.providerMinutes > a.costCap.providerMinutes) fields.push("costCap.providerMinutes");
  // A different topic is not provably narrower: it must stay the same.
  if (b.topic !== a.topic) fields.push("topic");
  const terms = new Set(b.forbiddenTerms);
  if (a.forbiddenTerms.some((term) => !terms.has(term))) fields.push("forbiddenTerms");
  if (!input.ownerMaySetConsent) {
    if (a.consent.disclosureNotice && !b.consent.disclosureNotice) fields.push("consent.disclosureNotice");
    if (a.consent.perParticipantConsent && !b.consent.perParticipantConsent) fields.push("consent.perParticipantConsent");
  }
  if (next.caps.perDay > current.caps.perDay) fields.push("caps.perDay");
  if (current.caps.perHour !== undefined && (next.caps.perHour === undefined || next.caps.perHour > current.caps.perHour)) fields.push("caps.perHour");
  if (current.caps.minIntervalSeconds !== undefined && (next.caps.minIntervalSeconds === undefined || next.caps.minIntervalSeconds < current.caps.minIntervalSeconds)) fields.push("caps.minIntervalSeconds");
  if (Date.parse(next.expires) > Date.parse(current.expires)) fields.push("expires");
  if (next.id !== current.id || next.description !== current.description) fields.push("id");
  return fields;
}

/** What the owner and the agent see of a grant: the canonical JSON, the digest and a plain summary. */
export function liveGrantView(record: LiveGrantRecord, extra: { usage?: Record<string, unknown> } = {}) {
  const grant = liveGrantOf(record);
  const scope = grant?.scope ?? null;
  return {
    id: record.id,
    channelId: record.channelId,
    agentId: record.agentId,
    status: record.status,
    digest: record.digest,
    /** The Buzz approval code the owner signs. */
    approvalText: `approve grant ${record.digest.slice(0, LIVE_DIGEST_PREFIX_MIN)}`,
    canonical: record.canonical,
    grant,
    summary: scope
      ? {
          target: scope.target,
          modes: { listen: scope.modes.listen === true, speakApproved: scope.modes.speakApproved === true, speakLive: scope.modes.speakLive === true },
          maxSessionMinutes: scope.maxSessionMinutes,
          maxDayMinutes: scope.maxDayMinutes,
          providerMinutesCap: scope.costCap.providerMinutes,
          topic: scope.topic,
          forbiddenTerms: scope.forbiddenTerms,
          consent: scope.consent,
          caps: grant!.caps,
          expires: grant!.expires,
        }
      : null,
    proposedAt: record.proposedAt,
    approvedAt: record.approvedAt,
    approvalSource: record.approvalSource,
    approvalExpiresAt: record.approvalExpiresAt,
    reason: record.decidedReason,
    providerMinutesUsed: Math.round((record.providerSeconds / 60) * 100) / 100,
    ...(extra.usage ? { usage: extra.usage } : {}),
  };
}

/** The pinned owner material for proof checks, read by the app per request (never from the request). */
export type LiveOwnerBinding = {
  nostr: { ok: true; pubkey: string; fingerprint: string; setAtMs: number } | { ok: false; status: number; error: string };
  portal:
    | { ok: true; issuer: string; jwksUri: string; grantKids: readonly string[]; instanceId: string; deploymentId: string; ownerSubject: string }
    | { ok: false; status: number; error: string };
};

export type LiveGrantServiceDeps = {
  live: LiveStore;
  organizationId: string;
  now: () => Date;
  /** The bound consent row is active AND still an `outward` consent (review L3). */
  consentActive: (consentRowId: string) => boolean;
  channel: (channelId: string) => ChannelRecord | null;
  ownerBinding: () => Promise<LiveOwnerBinding>;
  /** Instance-wide single use: records the proof id; false when it was already used. */
  markUsed: (proofId: string, kind: "nostr" | "portal", expiresAt: Date) => boolean;
  jwksFetch?: typeof fetch;
  audit: (eventType: string, record: LiveGrantRecord, actorId: string, metadata?: Record<string, unknown>) => void;
  auditControl: (eventType: string, actorId: string, metadata?: Record<string, unknown>) => void;
  /** A grant lost its authority: live sessions on it stop now (they also re-check every tick). */
  onGrantChanged?: (grantId: string, reason: string) => void;
  onControlChanged?: (paused: boolean) => void;
};

const NOSTR_REFUSALS: Record<string, { status: number; error: string }> = {
  replayed: { status: 409, error: "live_grant_proof_reused" },
  misconfigured: { status: 503, error: "approval_owner_unbound" },
  wrong_channel: { status: 403, error: "live_grant_proof_invalid" },
  wrong_digest: { status: 409, error: "live_grant_digest_mismatch" },
  wrong_owner: { status: 403, error: "live_grant_proof_invalid" },
  denied: { status: 409, error: "live_grant_denied" },
  expired: { status: 422, error: "live_grant_expired" },
  expires_too_far: { status: 422, error: "live_grant_expires_too_far" },
  invalid_grant: { status: 422, error: "live_grant_invalid" },
};

function approveGrantPrefixes(content: unknown): string[] {
  if (typeof content !== "string") return [];
  return [...content.matchAll(/\bapprove\s+grant\s+([0-9a-fA-F]+)\b/gu)].map((match) => match[1]!.toLowerCase());
}

export type LiveGrantService = ReturnType<typeof createLiveGrantService>;

export function createLiveGrantService(deps: LiveGrantServiceDeps) {
  const { live } = deps;
  const org = deps.organizationId;
  const resolvers = new Map<string, JwksResolver>();

  const build = (input: { id: string; description: string; target: LiveSessionScope["target"]; terms: LiveGrantTerms }): { ok: true; grant: LiveGrant; canonical: string; digest: string } | { ok: false; errors: readonly string[] } => {
    const candidate = {
      id: input.id,
      description: input.description,
      scope: {
        kind: "live-session" as const,
        target: input.target,
        modes: input.terms.modes,
        maxSessionMinutes: input.terms.maxSessionMinutes,
        maxDayMinutes: input.terms.maxDayMinutes,
        costCap: input.terms.costCap,
        topic: input.terms.topic,
        forbiddenTerms: input.terms.forbiddenTerms,
        consent: input.terms.consent,
      },
      caps: input.terms.caps,
      expires: new Date(input.terms.expires).toISOString(),
    };
    const parsed = parseGrant(candidate);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    try {
      assertServerEnforceable(parsed.grant);
      return { ok: true, grant: parsed.grant as LiveGrant, canonical: canonicalGrant(parsed.grant), digest: grantDigest(parsed.grant) };
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : "not server-enforceable"] };
    }
  };

  const windowRefusal = (grant: LiveGrant, at: number): LiveOutcome | null => {
    const window = grantApprovalWindow(grant, at);
    if (window.ok) return null;
    return window.reason === "expired"
      ? { ok: false, status: 422, error: "live_grant_expired" }
      : window.reason === "expires_too_far"
        ? { ok: false, status: 422, error: "live_grant_expires_too_far" }
        : { ok: false, status: 422, error: "live_grant_invalid" };
  };

  const termsOf = (grant: LiveGrant): LiveGrantTerms => ({
    modes: grant.scope.modes,
    maxSessionMinutes: grant.scope.maxSessionMinutes,
    maxDayMinutes: grant.scope.maxDayMinutes,
    costCap: grant.scope.costCap,
    topic: grant.scope.topic,
    forbiddenTerms: grant.scope.forbiddenTerms,
    consent: grant.scope.consent,
    caps: grant.caps,
    expires: grant.expires,
  });

  /** Proposal (agent op `marketplace.channel-live-grants.propose`). The channel must be an active Buzz channel. */
  const propose = (input: { channel: ChannelRecord; agentId: string; consentRowId: string; proposal: LiveGrantProposal }): LiveOutcome => {
    const { channel, proposal } = input;
    if (channel.status !== "active") return { ok: false, status: 409, error: "channel_not_active" };
    if (channel.provider !== "buzz") return { ok: false, status: 422, error: "channel_capability_unavailable" };
    // Live grants follow the channel's standing-grant switch (review L1).
    if (channel.policy.standingGrants !== "allowed") return { ok: false, status: 409, error: "standing_grants_disabled" };
    // Consent (review M1): an agent may only ask for consent at least as strict as the defaults. Turning the
    // disclosure notice off is the owner's decision, in the Marketplace UI behind the strict owner gate.
    if (proposal.consent?.disclosureNotice === false) return { ok: false, status: 422, error: "live_consent_weaker_than_default", fields: ["consent.disclosureNotice"] };
    const parent = channel.destination.externalId;
    if (!UUID.test(parent)) return { ok: false, status: 422, error: "live_target_invalid" };
    const description = liveGrantDescription(input.agentId, channel.slug);
    const terms: LiveGrantTerms = {
      modes: proposal.modes,
      maxSessionMinutes: proposal.maxSessionMinutes,
      maxDayMinutes: proposal.maxDayMinutes,
      costCap: proposal.costCap,
      topic: proposal.topic,
      forbiddenTerms: proposal.forbiddenTerms ?? [],
      consent: { disclosureNotice: proposal.consent?.disclosureNotice ?? true, perParticipantConsent: proposal.consent?.perParticipantConsent ?? false },
      caps: proposal.caps ?? { perDay: 10 },
      expires: proposal.expires,
    };
    const target = proposal.huddleId ? { huddleId: proposal.huddleId } : { channelId: parent };
    // A Buzz reply approves by a 32-hex digest prefix: two live grants must never share one. The id is random,
    // so a (practically impossible) collision just draws a new id.
    let id = newLiveGrantId();
    let built = build({ id, description, target, terms });
    for (let attempt = 0; built.ok && live.digestPrefixMatches(org, built.digest.slice(0, LIVE_DIGEST_PREFIX_MIN), "") > 0; attempt += 1) {
      if (attempt >= 3) return { ok: false, status: 409, error: "live_grant_digest_prefix_collision" };
      id = newLiveGrantId();
      built = build({ id, description, target, terms });
    }
    if (!built.ok) return { ok: false, status: 422, error: "live_grant_invalid", errors: built.errors };
    // Review M1: never wider than the caller's current approved grant for the same target (consent, modes, caps,
    // minutes, cost, forbidden terms, expiry). A wider ask needs the current grant withdrawn first (audited).
    for (const current of live.listGrants(org, { channelId: channel.id, agentId: input.agentId, status: ["active", "paused"] })) {
      const approved = liveGrantOf(current);
      if (!approved || JSON.stringify(approved.scope.target) !== JSON.stringify(built.grant.scope.target)) continue;
      const wider = wideningFields(approved, built.grant, { ownerMaySetConsent: false }).filter((field) => !["id", "topic"].includes(field));
      if (wider.length > 0) return { ok: false, status: 422, error: "live_grant_wider_than_approved", fields: wider, reason: current.id };
    }
    const refusal = windowRefusal(built.grant, deps.now().getTime());
    if (refusal) return refusal;
    const record = live.createGrant({
      id,
      workspaceSlug: org,
      channelId: channel.id,
      agentId: input.agentId,
      consentId: input.consentRowId,
      approvalChannel: parent,
      canonical: built.canonical,
      digest: built.digest,
      now: deps.now(),
    });
    deps.audit("marketplace.channels.live_grant.proposed", record, `agent:${input.agentId}`);
    return { ok: true, grant: record };
  };

  /** Narrowing (agent: consent only stricter; owner: consent either way). Always back to `proposed` with a new digest. */
  const narrow = (input: { record: LiveGrantRecord; terms: LiveGrantTerms; actor: "agent" | "owner"; actorId: string }): LiveOutcome => {
    const { record } = input;
    if (!["proposed", "active", "paused"].includes(record.status)) return { ok: false, status: 409, error: "live_grant_not_narrowable" };
    const current = liveGrantOf(record);
    if (!current) return { ok: false, status: 409, error: "live_grant_corrupt" };
    const built = build({ id: current.id, description: current.description, target: current.scope.target, terms: input.terms });
    if (!built.ok) return { ok: false, status: 422, error: "live_grant_invalid", errors: built.errors };
    const wider = wideningFields(current, built.grant, { ownerMaySetConsent: input.actor === "owner" });
    if (wider.length > 0) return { ok: false, status: 422, error: "live_grant_widening_refused", fields: wider };
    if (built.digest === record.digest) return { ok: true, grant: record, replayed: true };
    if (live.digestPrefixMatches(org, built.digest.slice(0, LIVE_DIGEST_PREFIX_MIN), record.id) > 0) return { ok: false, status: 409, error: "live_grant_digest_prefix_collision" };
    const refusal = windowRefusal(built.grant, deps.now().getTime());
    if (refusal) return refusal;
    const updated = live.updateGrant(
      org,
      record.id,
      { revision: record.revision, status: ["proposed", "active", "paused"] },
      {
        canonical: built.canonical,
        digest: built.digest,
        status: "proposed",
        approvedAt: null,
        approvedBy: null,
        approvalSource: null,
        approvalRef: null,
        approvedDigest: null,
        approvalExpiresAt: null,
        decidedReason: `narrowed_by_${input.actor}`,
      },
      deps.now(),
    );
    if (!updated) return { ok: false, status: 409, error: "live_grant_changed" };
    deps.audit("marketplace.channels.live_grant.narrowed", updated, input.actorId, { previousDigest: record.digest });
    if (record.status !== "proposed") deps.onGrantChanged?.(record.id, "grant_changed");
    return { ok: true, grant: updated };
  };

  const transition = (record: LiveGrantRecord, from: LiveGrantStatus[], to: LiveGrantStatus, reason: string, actorId: string, eventType: string): LiveOutcome => {
    if (record.status === to) return { ok: true, grant: record, replayed: true };
    if (!from.includes(record.status)) return { ok: false, status: 409, error: `live_grant_not_${to === "active" ? "resumable" : to}` };
    const updated = live.updateGrant(org, record.id, { revision: record.revision, status: from }, { status: to, decidedReason: reason }, deps.now());
    if (!updated) return { ok: false, status: 409, error: "live_grant_changed" };
    deps.audit(eventType, updated, actorId, { from: record.status });
    if (to !== "active") deps.onGrantChanged?.(record.id, reason);
    return { ok: true, grant: updated };
  };

  const withdraw = (record: LiveGrantRecord) =>
    transition(record, ["proposed", "active", "paused"], "withdrawn", "withdrawn_by_agent", `agent:${record.agentId}`, "marketplace.channels.live_grant.withdrawn");
  const decline = (record: LiveGrantRecord, actorId: string) =>
    transition(record, ["proposed"], "declined", "declined_by_owner", actorId, "marketplace.channels.live_grant.declined");
  const revoke = (record: LiveGrantRecord, actorId: string, via = "owner") =>
    transition(record, ["proposed", "active", "paused"], "revoked", via === "owner" ? "revoked_by_owner" : `revoked_by_owner_${via}`, actorId, "marketplace.channels.live_grant.revoked");
  const pause = (record: LiveGrantRecord, actorId: string) =>
    transition(record, ["active"], "paused", "paused_by_owner", actorId, "marketplace.channels.live_grant.paused");

  /** Resume a paused grant: still the approved digest, still inside its approval window and expiry. */
  const resume = (record: LiveGrantRecord, actorId: string): LiveOutcome => {
    if (record.status === "active") return { ok: true, grant: record, replayed: true };
    if (record.status !== "paused" || record.approvedDigest !== record.digest) return { ok: false, status: 409, error: "live_grant_not_resumable" };
    if (record.approvalExpiresAt && Date.parse(record.approvalExpiresAt) <= deps.now().getTime()) return { ok: false, status: 409, error: "live_grant_expired" };
    return transition(record, ["paused"], "active", "resumed_by_owner", actorId, "marketplace.channels.live_grant.resumed");
  };

  /** The approval checks every path shares, before any proof is read. */
  const approvable = (record: LiveGrantRecord): { ok: true; grant: LiveGrant; channel: ChannelRecord } | Extract<LiveOutcome, { ok: false }> => {
    if (record.status !== "proposed") return { ok: false, status: 409, error: "live_grant_not_pending" };
    const channel = deps.channel(record.channelId);
    if (!channel || channel.status !== "active") return { ok: false, status: 409, error: "channel_not_active" };
    if (!deps.consentActive(record.consentId)) return { ok: false, status: 409, error: "live_grant_consent_inactive" };
    if (channel.policy.standingGrants !== "allowed") return { ok: false, status: 409, error: "standing_grants_disabled" };
    const grant = liveGrantOf(record);
    if (!grant) return { ok: false, status: 409, error: "live_grant_corrupt" };
    if (integrityFailed(record, grant, channel)) return { ok: false, status: 409, error: "live_grant_corrupt" };
    const refusal = windowRefusal(grant, deps.now().getTime());
    if (refusal && !refusal.ok) return refusal;
    return { ok: true, grant, channel };
  };

  /** Records an integrity failure once per record revision (a session tick would otherwise repeat it). */
  const integrityAudited = new Set<string>();
  const integrityFailed = (record: LiveGrantRecord, grant: LiveGrant, channel: ChannelRecord): boolean => {
    const field = liveGrantIntegrityProblem(record, grant, channel);
    if (!field) return false;
    const key = `${record.id}|${record.revision}|${field}`;
    if (!integrityAudited.has(key)) {
      if (integrityAudited.size > 1000) integrityAudited.clear();
      integrityAudited.add(key);
      deps.audit("marketplace.channels.live_grant.integrity_failed", record, "marketplace", { field });
    }
    return true;
  };

  const activate = (record: LiveGrantRecord, input: { canonical: string; digest: string; approvedAt: number; expiresAt: number; source: "marketplace-ui" | "nostr" | "portal"; ref: string; approvedBy: string }) => {
    // Enforce exactly what the verifier returned: it must be the pending canonical grant (never re-parsed raw JSON).
    if (input.canonical !== record.canonical || input.digest !== record.digest) return null;
    return live.updateGrant(
      org,
      record.id,
      { revision: record.revision, status: ["proposed"] },
      {
        canonical: input.canonical,
        digest: input.digest,
        status: "active",
        approvedAt: new Date(input.approvedAt).toISOString(),
        approvedBy: input.approvedBy,
        approvalSource: input.source,
        approvalRef: input.ref,
        approvedDigest: input.digest,
        approvalExpiresAt: new Date(input.expiresAt).toISOString(),
        decidedReason: null,
      },
      deps.now(),
    );
  };

  /** Marketplace UI approval: the strict owner gate already passed; `digest` must be exactly the one shown. */
  const approveInUi = (input: { record: LiveGrantRecord; digest: string; actorId: string }): LiveOutcome => {
    const { record } = input;
    if (!HEX64.test(input.digest) || input.digest !== record.digest) return { ok: false, status: 409, error: "live_grant_digest_mismatch" };
    const ready = approvable(record);
    if (!ready.ok) return ready;
    const at = deps.now().getTime();
    const window = grantApprovalWindow(ready.grant, at);
    if (!window.ok) return { ok: false, status: 422, error: "live_grant_expired" };
    const updated = activate(record, {
      canonical: canonicalGrant(ready.grant),
      digest: grantDigest(ready.grant),
      approvedAt: at,
      expiresAt: window.expiresAt,
      source: "marketplace-ui",
      ref: `ui:${input.actorId}`,
      approvedBy: input.actorId,
    });
    if (!updated) return { ok: false, status: 409, error: "live_grant_changed" };
    deps.audit("marketplace.channels.live_grant.approved", updated, input.actorId, { source: "marketplace-ui" });
    return { ok: true, grant: updated };
  };

  const resolverFor = (binding: { issuer: string; jwksUri: string; grantKids: readonly string[] }) => {
    const key = `${binding.issuer}|${binding.jwksUri}|${[...binding.grantKids].sort().join(",")}`;
    let resolver = resolvers.get(key);
    if (!resolver) {
      const keys = ownerApprovalOptionsFromClaim(
        { portalIssuer: binding.issuer, jwksUri: binding.jwksUri, grantKids: binding.grantKids },
        { ...(deps.jwksFetch ? { jwks: { fetch: deps.jwksFetch } } : {}) },
      );
      resolver = createJwksResolver(keys.jwks as Parameters<typeof createJwksResolver>[0]);
      if (resolvers.size > 8) resolvers.clear();
      resolvers.set(key, resolver);
    }
    return resolver;
  };

  /**
   * A forwarded owner proof (`{proof: "nostr", event, channel}` or `{proof: "portal", token}`) for the caller's own
   * pending grant. Local refusals (key epoch, digest-prefix ambiguity, unbound owner) come first and burn nothing;
   * the contract verifier records the proof id last.
   */
  const approveWithProof = async (input: { record: LiveGrantRecord; proof: { proof: "nostr"; event: Record<string, unknown>; channel: string } | { proof: "portal"; token: string } }): Promise<LiveOutcome> => {
    const { record, proof } = input;
    const ready = approvable(record);
    if (!ready.ok) return ready;
    const binding = await deps.ownerBinding();
    const nowMs = deps.now().getTime();
    let expected: Parameters<typeof verifyGrantApproval>[0]["expected"];
    if (proof.proof === "nostr") {
      if (!binding.nostr.ok) return { ok: false, status: binding.nostr.status, error: binding.nostr.error };
      const createdAt = typeof proof.event.created_at === "number" ? proof.event.created_at * 1000 : NaN;
      // Signed before the current owner key was set: a proof of an older key epoch.
      if (!(createdAt >= Math.floor(binding.nostr.setAtMs / 1000) * 1000)) return { ok: false, status: 403, error: "live_grant_proof_invalid", reason: "key_changed" };
      const prefixes = approveGrantPrefixes(proof.event.content);
      // Ambiguous: the code names this grant AND another open one (a Buzz reply binds only its prefix).
      const prefix = prefixes.length === 1 ? prefixes[0]! : "";
      if (prefix.length >= LIVE_DIGEST_PREFIX_MIN && record.digest.startsWith(prefix) && live.digestPrefixMatches(org, prefix, record.id) > 0) {
        return { ok: false, status: 409, error: "live_grant_approval_ambiguous" };
      }
      const nostrKey = binding.nostr;
      expected = {
        now: nowMs,
        // The conversation comes from OUR pending record (the channel's Buzz conversation), never from the request.
        nostr: { ownerPubkey: nostrKey.pubkey, channel: record.approvalChannel, maxAgeMs: NOSTR_APPROVAL_MAX_AGE_MS },
        isUsed: (eventId: string) => !deps.markUsed(`nostr:${eventId}`, "nostr", new Date(nowMs + NOSTR_APPROVAL_MAX_AGE_MS + NOSTR_FUTURE_SKEW_MS)),
      };
    } else {
      if (!binding.portal.ok) return { ok: false, status: binding.portal.status, error: binding.portal.error };
      let jwks: JwksResolver;
      try {
        jwks = resolverFor(binding.portal);
      } catch {
        return { ok: false, status: 503, error: "approval_owner_unbound" };
      }
      const portal = binding.portal;
      expected = {
        now: nowMs,
        portal: {
          issuer: portal.issuer,
          jwks,
          instanceId: portal.instanceId,
          deploymentId: portal.deploymentId,
          ownerSubject: portal.ownerSubject,
          approvalId: record.id,
          agent: `tealbrick-agent:${record.agentId}`,
        },
        isUsed: (jti: string, expiresAt?: number) =>
          !deps.markUsed(`portal:${jti}`, "portal", new Date(Math.max(expiresAt ?? nowMs, nowMs) + MAX_CLOCK_SKEW_SECONDS * 1000)),
      };
    }
    let result;
    try {
      result = await verifyGrantApproval({ grant: ready.grant, proof, expected });
    } catch {
      return { ok: false, status: 503, error: "live_grant_proof_unavailable" };
    }
    if (!result.ok) {
      const mapped = NOSTR_REFUSALS[result.reason] ?? { status: 403, error: "live_grant_proof_invalid" };
      return { ok: false, ...mapped, reason: result.reason };
    }
    // A key change during verification invalidates a Buzz proof checked against the old key.
    if (proof.proof === "nostr") {
      const still = await deps.ownerBinding();
      if (!still.nostr.ok || !binding.nostr.ok || still.nostr.fingerprint !== binding.nostr.fingerprint) return { ok: false, status: 409, error: "approval_owner_key_changed" };
    }
    const ref = result.channel === "nostr" ? `nostr:${result.eventId}` : `portal:${result.jti}`;
    const approvedBy =
      result.channel === "nostr" && binding.nostr.ok ? `owner-nostr:${binding.nostr.fingerprint}` : `owner:${String(result.ownerSubject ?? "").replace(/^tealbrick-user:/u, "")}`;
    const updated = activate(record, {
      canonical: result.canonical,
      digest: result.digest,
      approvedAt: result.approvedAt,
      expiresAt: result.expiresAt,
      source: result.channel,
      ref,
      approvedBy,
    });
    if (!updated) return { ok: false, status: 409, error: "live_grant_changed" };
    deps.audit("marketplace.channels.live_grant.approved", updated, approvedBy, { source: result.channel, proofRef: ref });
    return { ok: true, grant: updated };
  };

  /**
   * TODO(review of PR #53, M2): Marketplace should subscribe to the owner command channel itself (inbound relay
   * socket) so a signed `pause grants` / `revoke <id>` applies even when no agent forwards it. Today the command needs
   * a forwarding agent; the owner UI (Pause, Revoke, Stop) does not.
   *
   * A forwarded owner-signed command. `revoke <id>` must be posted in that grant's own approval conversation;
   * `pause grants` / `resume grants` in the owner command channel (owner setting). Both channels are our state.
   */
  const ownerCommand = async (input: { event: Record<string, unknown> }): Promise<
    { ok: true; command: "revoke" | "pause" | "resume"; grant?: LiveGrantRecord; paused?: boolean } | { ok: false; status: number; error: string; reason?: string }
  > => {
    const binding = await deps.ownerBinding();
    if (!binding.nostr.ok) return { ok: false, status: binding.nostr.status, error: binding.nostr.error };
    const createdAt = typeof input.event.created_at === "number" ? input.event.created_at * 1000 : NaN;
    if (!(createdAt >= Math.floor(binding.nostr.setAtMs / 1000) * 1000)) return { ok: false, status: 403, error: "live_command_invalid", reason: "key_changed" };
    // Only to pick which of OUR channels applies; the verifier checks the signed content again.
    const claimed = parseOwnerCommand(typeof input.event.content === "string" ? input.event.content : "");
    if (!claimed) return { ok: false, status: 422, error: "live_command_invalid", reason: "not_a_command" };
    let channel: string | null;
    let target: LiveGrantRecord | null = null;
    if (claimed.command === "revoke") {
      target = claimed.grantId ? live.getGrant(org, claimed.grantId) : null;
      if (!target) return { ok: false, status: 404, error: "live_grant_not_found" };
      channel = target.approvalChannel;
      // Monotonic (review of PR #53, M2): a command signed at or before the grant's last state change is refused.
      if (createdAt <= target.stateChangedAt) return { ok: false, status: 409, error: "live_command_stale", reason: "older_than_last_change" };
    } else {
      const control = live.getControl(org);
      channel = control.commandChannel;
      if (!channel) return { ok: false, status: 409, error: "live_command_channel_unset" };
      // A withheld older `resume grants` can never undo a later pause (UI or command), and vice versa.
      if (createdAt <= control.changedAt) return { ok: false, status: 409, error: "live_command_stale", reason: "older_than_last_change" };
    }
    const nowMs = deps.now().getTime();
    const result = await verifyOwnerCommand({
      event: input.event,
      channel,
      ownerPubkey: binding.nostr.pubkey,
      now: nowMs,
      isUsed: (eventId) => !deps.markUsed(`nostr:${eventId}`, "nostr", new Date(nowMs + NOSTR_APPROVAL_MAX_AGE_MS + NOSTR_FUTURE_SKEW_MS)),
    });
    if (!result.ok) {
      const replayed = /already used/u.test(result.reason);
      return { ok: false, status: replayed ? 409 : 403, error: replayed ? "live_command_reused" : "live_command_invalid", reason: replayed ? "replayed" : "rejected" };
    }
    const actor = `owner-nostr:${binding.nostr.fingerprint}`;
    if (result.command === "revoke") {
      const current = live.getGrant(org, result.grantId ?? "");
      if (!current || current.id !== target?.id) return { ok: false, status: 404, error: "live_grant_not_found" };
      const outcome = revoke(current, actor, "command");
      return outcome.ok ? { ok: true, command: "revoke", grant: outcome.grant } : { ok: false, status: outcome.status, error: outcome.error };
    }
    const paused = result.command === "pause";
    setPaused(paused, actor, "command");
    return { ok: true, command: result.command, paused };
  };

  const setPaused = (paused: boolean, actorId: string, via: "ui" | "command") => {
    // Every change (UI or command) moves the monotonic change time forward to now.
    const control = live.setPaused(org, paused, actorId, deps.now());
    deps.auditControl(paused ? "marketplace.channels.live_grants.paused" : "marketplace.channels.live_grants.resumed", actorId, { via });
    deps.onControlChanged?.(paused);
    return control;
  };

  /**
   * The grant as it may be used NOW, or why not: active, inside its expiry and approval window, the approved digest,
   * the owner switch on, the bound consent active, the channel active. A lasting failure is written back
   * (`expired`). Called at join and by every session tick.
   */
  const usable = (record: LiveGrantRecord | null): { ok: true; grant: LiveGrant; record: LiveGrantRecord } | { ok: false; reason: string } => {
    if (!record) return { ok: false, reason: "grant_missing" };
    if (live.getControl(org).paused) return { ok: false, reason: "grants_paused" };
    if (record.status !== "active") return { ok: false, reason: `grant_${record.status}` };
    if (record.approvedDigest !== record.digest) return { ok: false, reason: "grant_changed" };
    const grant = liveGrantOf(record);
    if (!grant) return { ok: false, reason: "grant_corrupt" };
    const nowMs = deps.now().getTime();
    const expiry = Math.min(Date.parse(grant.expires), record.approvalExpiresAt ? Date.parse(record.approvalExpiresAt) : Infinity);
    if (!(expiry > nowMs)) {
      const expired = live.updateGrant(org, record.id, { revision: record.revision, status: ["active"] }, { status: "expired", decidedReason: "expired" }, deps.now());
      if (expired) deps.audit("marketplace.channels.live_grant.expired", expired, "marketplace");
      return { ok: false, reason: "grant_expired" };
    }
    if (!deps.consentActive(record.consentId)) return { ok: false, reason: "consent_inactive" };
    const channel = deps.channel(record.channelId);
    if (!channel || channel.status !== "active") return { ok: false, reason: channel ? `channel_${channel.status}` : "channel_missing" };
    if (channel.policy.standingGrants !== "allowed") return { ok: false, reason: "standing_grants_disabled" };
    if (integrityFailed(record, grant, channel)) return { ok: false, reason: "grant_integrity_failed" };
    return { ok: true, grant, record };
  };

  return { propose, narrow, withdraw, decline, revoke, pause, resume, approveInUi, approveWithProof, ownerCommand, setPaused, usable, termsOf };
}

export function modesOf(scope: LiveSessionScope): LiveModes {
  return {
    ...(scope.modes.listen ? { listen: true as const } : {}),
    ...(scope.modes.speakApproved ? { speakApproved: true as const } : {}),
    ...(scope.modes.speakLive ? { speakLive: true as const } : {}),
  };
}

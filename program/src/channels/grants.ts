import { z } from "zod";

import {
  GRANT_PHASES,
  grantWithinCeiling,
  isNarrowing,
  standingGrantDigest,
  type ChannelPolicy,
  type StandingGrantTerms,
} from "./policy.js";
import {
  ChannelStoreError,
  type ChannelRecord,
  type ChannelStore,
  type StandingGrantRecord,
  type StandingGrantStatus,
} from "./store.js";

/**
 * Standing grants (Channels spec §4.4). An agent proposes; only the owner
 * approves (as proposed or narrowed); the agent may narrow or withdraw; the
 * owner may decline or revoke. A grant is suspended automatically when its
 * consent ends, the channel is paused or archived, or the ceiling drops below
 * it, and it resumes only through a new owner approval. Never wider than the
 * channel ceiling (C2).
 */

const isoTime = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), "must be an ISO time");

export const GrantCapsSchema = z.strictObject({
  perDay: z.number().int().min(1).max(10_000),
  perHour: z.number().int().min(1).max(10_000).optional(),
  minIntervalSeconds: z.number().int().min(0).max(7 * 86_400),
  onePerPhase: z.boolean(),
});

export const GrantScopeSchema = z.strictObject({
  phases: z.array(z.enum(GRANT_PHASES)).min(1).max(GRANT_PHASES.length).optional(),
  campaignRefs: z.array(z.string().min(1).max(300)).min(1).max(20).optional(),
  files: z.union([
    z.literal(false),
    z.strictObject({
      types: z.array(z.string().min(1).max(100)).max(32).optional(),
      maxBytes: z.number().int().min(1).optional(),
      maxCount: z.number().int().min(0).max(20).optional(),
    }),
  ]),
  maxChars: z.number().int().min(1).max(1_000_000).optional(),
  immediate: z.boolean(),
  scheduled: z.boolean(),
});

export const GrantTermsSchema = z.strictObject({
  caps: GrantCapsSchema,
  scope: GrantScopeSchema,
  notBefore: isoTime.nullable().optional(),
  expires: isoTime,
});

export const GrantProposalSchema = GrantTermsSchema.extend({ purpose: z.string().trim().min(1).max(300) });

export type GrantOutcome =
  | { ok: true; grant: StandingGrantRecord }
  | { ok: false; status: number; error: string; fields?: string[] };

export function grantTerms(grant: StandingGrantRecord): StandingGrantTerms {
  return { caps: grant.caps, scope: grant.scope, notBefore: grant.notBefore, expires: grant.expires };
}

function digestOf(grant: Pick<StandingGrantRecord, "workspaceSlug" | "channelId" | "agentId" | "consentId" | "purpose">, terms: StandingGrantTerms) {
  return standingGrantDigest({
    workspace: grant.workspaceSlug,
    channelId: grant.channelId,
    agentId: grant.agentId,
    consentId: grant.consentId,
    purpose: grant.purpose,
    terms,
  });
}

function normalizeTerms(terms: z.infer<typeof GrantTermsSchema>): StandingGrantTerms {
  return {
    caps: terms.caps,
    scope: terms.scope,
    notBefore: terms.notBefore ? new Date(terms.notBefore).toISOString() : null,
    expires: new Date(terms.expires).toISOString(),
  };
}

export type GrantService = ReturnType<typeof createGrantService>;

export function createGrantService(deps: {
  store: ChannelStore;
  now: () => Date;
  /** Whether the grant's bound consent row is still active. */
  consentActive: (consentRowId: string) => boolean;
  audit: (eventType: string, grant: StandingGrantRecord, actorId: string, metadata?: Record<string, unknown>) => void;
}) {
  const { store } = deps;

  const transition = (
    grant: StandingGrantRecord,
    from: StandingGrantStatus[],
    patch: Parameters<ChannelStore["updateStandingGrant"]>[2],
  ): StandingGrantRecord | null => {
    try {
      return store.updateStandingGrant(grant.workspaceSlug, grant.id, { now: deps.now(), ...patch }, { expectStatus: from });
    } catch (error) {
      if (error instanceof ChannelStoreError) return null;
      throw error;
    }
  };

  /** §4.4 rule 1. The channel must allow standing grants; the proposal must fit the ceiling. */
  const propose = (input: {
    channel: ChannelRecord;
    agentId: string;
    consentRowId: string;
    proposal: z.infer<typeof GrantProposalSchema>;
  }): GrantOutcome => {
    const terms = normalizeTerms(input.proposal);
    if (input.channel.status !== "active") return { ok: false, status: 409, error: "channel_not_active" };
    const fits = grantWithinCeiling(terms, input.channel.policy, { now: deps.now() });
    if (!fits.ok) {
      return fits.error === "standing_grants_disabled"
        ? { ok: false, status: 409, error: "standing_grants_disabled" }
        : { ok: false, status: 422, error: "grant_exceeds_ceiling", fields: fits.fields };
    }
    const created = store.createStandingGrant({
      workspaceSlug: input.channel.workspaceSlug,
      channelId: input.channel.id,
      agentId: input.agentId,
      consentId: input.consentRowId,
      purpose: input.proposal.purpose,
      caps: terms.caps,
      scope: terms.scope,
      notBefore: terms.notBefore ?? null,
      expires: terms.expires,
      now: deps.now(),
    });
    // The proposal digest; approval replaces it with the digest of the final grant.
    const grant = store.updateStandingGrant(created.workspaceSlug, created.id, { digest: digestOf(created, terms), now: deps.now() })!;
    deps.audit("marketplace.channels.grant.proposed", grant, `agent:${input.agentId}`);
    return { ok: true, grant };
  };

  /** §4.4 rule 3: only a subset of the current grant. An active grant stays active (it only loses authority). */
  const narrow = (input: { grant: StandingGrantRecord; channel: ChannelRecord; terms: z.infer<typeof GrantTermsSchema> }): GrantOutcome => {
    const { grant } = input;
    if (!["proposed", "active"].includes(grant.status)) return { ok: false, status: 409, error: "grant_not_narrowable" };
    const terms = normalizeTerms(input.terms);
    const narrower = isNarrowing(grantTerms(grant), terms);
    if (!narrower.ok) return { ok: false, status: 422, error: "grant_widening_refused", fields: narrower.fields };
    const updated = transition(grant, [grant.status], {
      caps: terms.caps,
      scope: terms.scope,
      notBefore: terms.notBefore ?? null,
      expires: terms.expires,
      digest: digestOf(grant, terms),
    });
    if (!updated) return { ok: false, status: 409, error: "grant_changed" };
    deps.audit("marketplace.channels.grant.narrowed", updated, `agent:${grant.agentId}`);
    return { ok: true, grant: updated };
  };

  const withdraw = (grant: StandingGrantRecord): GrantOutcome => {
    const updated = transition(grant, ["proposed", "active", "suspended"], { status: "withdrawn", decidedReason: "withdrawn_by_agent" });
    if (!updated) return { ok: false, status: 409, error: "grant_not_withdrawable" };
    deps.audit("marketplace.channels.grant.withdrawn", updated, `agent:${grant.agentId}`);
    return { ok: true, grant: updated };
  };

  /**
   * §4.4 rule 2 (owner only). Approve as proposed or narrowed (`final` must be
   * a subset of the proposal); the final grant must fit the current ceiling
   * with `expires` at most 90 days after approval, and its consent must still
   * be active. A suspended grant resumes only through this.
   */
  const approve = (input: {
    grant: StandingGrantRecord;
    channel: ChannelRecord;
    final?: z.infer<typeof GrantTermsSchema>;
    approvedBy: string;
  }): GrantOutcome => {
    const { grant, channel } = input;
    if (!["proposed", "suspended"].includes(grant.status)) return { ok: false, status: 409, error: "grant_not_pending" };
    if (channel.status !== "active") return { ok: false, status: 409, error: "channel_not_active" };
    if (!deps.consentActive(grant.consentId)) return { ok: false, status: 409, error: "grant_consent_inactive" };
    const terms = input.final ? normalizeTerms(input.final) : grantTerms(grant);
    if (input.final) {
      const narrower = isNarrowing(grantTerms(grant), terms);
      if (!narrower.ok) return { ok: false, status: 422, error: "grant_widening_refused", fields: narrower.fields };
    }
    const now = deps.now();
    const fits = grantWithinCeiling(terms, channel.policy, { now, approvedAt: now });
    if (!fits.ok) {
      return fits.error === "standing_grants_disabled"
        ? { ok: false, status: 409, error: "standing_grants_disabled" }
        : { ok: false, status: 422, error: "grant_exceeds_ceiling", fields: fits.fields };
    }
    const updated = transition(grant, [grant.status], {
      caps: terms.caps,
      scope: terms.scope,
      notBefore: terms.notBefore ?? null,
      expires: terms.expires,
      status: "active",
      digest: digestOf(grant, terms),
      approvedBy: input.approvedBy,
      approvedAt: now.toISOString(),
      approvalSource: "marketplace-ui",
      decidedReason: null,
    });
    if (!updated) return { ok: false, status: 409, error: "grant_changed" };
    deps.audit("marketplace.channels.grant.approved", updated, input.approvedBy, { narrowed: Boolean(input.final) });
    return { ok: true, grant: updated };
  };

  const decline = (grant: StandingGrantRecord, actorId: string): GrantOutcome => {
    const updated = transition(grant, ["proposed"], { status: "declined", decidedReason: "declined_by_owner" });
    if (!updated) return { ok: false, status: 409, error: "grant_not_pending" };
    deps.audit("marketplace.channels.grant.declined", updated, actorId);
    return { ok: true, grant: updated };
  };

  /** §4.4 rule 4: any time, effective immediately. */
  const revoke = (grant: StandingGrantRecord, actorId: string): GrantOutcome => {
    const updated = transition(grant, ["proposed", "active", "suspended"], { status: "revoked", decidedReason: "revoked_by_owner" });
    if (!updated) return { ok: false, status: 409, error: "grant_not_revocable" };
    deps.audit("marketplace.channels.grant.revoked", updated, actorId);
    return { ok: true, grant: updated };
  };

  const suspend = (grant: StandingGrantRecord, reason: string): StandingGrantRecord | null => {
    const updated = transition(grant, ["active"], { status: "suspended", decidedReason: reason });
    if (updated) deps.audit("marketplace.channels.grant.suspended", updated, "marketplace", { reason });
    return updated;
  };

  /** §4.4 rule 5 after a channel change: pause/archive suspends every active grant; a lowered ceiling the ones it no longer contains. */
  const recheckChannel = (channel: ChannelRecord): StandingGrantRecord[] => {
    const suspended: StandingGrantRecord[] = [];
    for (const grant of store.listStandingGrants(channel.workspaceSlug, { channelId: channel.id, status: "active" })) {
      const reason = channel.status !== "active"
        ? `channel_${channel.status}`
        : !ceilingContains(grant, channel.policy)
          ? "ceiling_lowered"
          : null;
      if (reason) {
        const updated = suspend(grant, reason);
        if (updated) suspended.push(updated);
      }
    }
    return suspended;
  };

  /** Suspends every active grant of a channel (e.g. its destination changed). */
  const suspendAll = (channel: ChannelRecord, reason: string): StandingGrantRecord[] =>
    store
      .listStandingGrants(channel.workspaceSlug, { channelId: channel.id, status: "active" })
      .map((grant) => suspend(grant, reason))
      .filter((grant): grant is StandingGrantRecord => grant !== null);

  /** §4.4 rule 5 when a consent is revoked or no longer active. */
  const suspendForConsent = (workspaceSlug: string, consentRowId: string): StandingGrantRecord[] =>
    store
      .listStandingGrants(workspaceSlug, { status: "active" })
      .filter((grant) => grant.consentId === consentRowId)
      .map((grant) => suspend(grant, "consent_inactive"))
      .filter((grant): grant is StandingGrantRecord => grant !== null);

  const ceilingContains = (grant: StandingGrantRecord, policy: ChannelPolicy) =>
    grantWithinCeiling(grantTerms(grant), policy, {
      now: deps.now(),
      approvedAt: grant.approvedAt,
    }).ok;

  /**
   * The agent's usable grants on a channel, checked lazily at use: bound to
   * this consent, consent active, inside the current ceiling, not expired.
   * A grant that fails a lasting condition is moved to `suspended` or `expired`.
   */
  const usableGrants = (input: { channel: ChannelRecord; agentId: string; consentRowId: string }): StandingGrantRecord[] => {
    const now = deps.now().getTime();
    const usable: StandingGrantRecord[] = [];
    for (const grant of store.listStandingGrants(input.channel.workspaceSlug, {
      channelId: input.channel.id,
      agentId: input.agentId,
      status: "active",
    })) {
      if (Date.parse(grant.expires) <= now) {
        const expired = transition(grant, ["active"], { status: "expired", decidedReason: "expired" });
        if (expired) deps.audit("marketplace.channels.grant.expired", expired, "marketplace");
        continue;
      }
      if (!deps.consentActive(grant.consentId)) {
        suspend(grant, "consent_inactive");
        continue;
      }
      if (input.channel.status !== "active") {
        suspend(grant, `channel_${input.channel.status}`);
        continue;
      }
      if (!ceilingContains(grant, input.channel.policy)) {
        suspend(grant, "ceiling_lowered");
        continue;
      }
      if (grant.consentId !== input.consentRowId) continue;
      usable.push(grant);
    }
    return usable;
  };

  return { propose, narrow, withdraw, approve, decline, revoke, recheckChannel, suspendAll, suspendForConsent, usableGrants };
}

/** What an agent or the owner sees of a grant. */
export function grantView(grant: StandingGrantRecord) {
  return {
    id: grant.id,
    channelId: grant.channelId,
    agentId: grant.agentId,
    purpose: grant.purpose,
    caps: grant.caps,
    scope: grant.scope,
    notBefore: grant.notBefore,
    expires: grant.expires,
    status: grant.status,
    digest: grant.digest,
    proposedAt: grant.proposedAt,
    approvedAt: grant.approvedAt,
    approvalSource: grant.approvalSource,
    reason: grant.decidedReason,
  };
}

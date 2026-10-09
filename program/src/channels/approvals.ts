import { z } from "zod";

/**
 * Owner approval proofs for `marketplace.approvals.resolve` (Channels spec
 * §6 "One approval experience", K1/K2/PO3).
 *
 * The kit forwards an owner decision that it never minted and the model never
 * saw: a Buzz reply (`proof: "nostr"`, an owner-signed Nostr event) or a TBD
 * button press (`proof: "portal"`, a Portal-signed owner approval assertion).
 * Marketplace verifies it locally and binds it to the caller's own held call.
 *
 * TODO(K2, K1): real verification uses `verifyOwnerApproval` from
 * `@tealbrick/kit/owner-approval` (kit 0.3.0-rc.14) for `nostr`, and
 * `verifyOwnerApprovalAssertion` from `@tealbrick/contract` 0.1.0-alpha.6 for
 * `portal`. Neither is published yet (npm has kit rc.13 and contract
 * alpha.5), so the default verifier refuses every proof with
 * `501 approval_proof_unsupported` (fail closed) and tests inject a verifier.
 */

export const OwnerApprovalProofSchema = z.discriminatedUnion("proof", [
  z.strictObject({
    proof: z.literal("nostr"),
    event: z.record(z.unknown()),
    channel: z.string().min(1).max(256),
  }),
  z.strictObject({
    proof: z.literal("portal"),
    token: z.string().min(16).max(8192),
  }),
]);

export type OwnerApprovalProof = z.infer<typeof OwnerApprovalProofSchema>;

/** What Marketplace pins the proof to (from its Portal claim configuration). */
export type OwnerApprovalBinding = {
  portalIssuer: string | null;
  deploymentId: string | null;
  portalOrgId: string | null;
  workspaceId: string | null;
  /** Claimed instance id (`aud = tealbrick-app:<instanceId>` for portal proofs). */
  instanceId: string | null;
  /** Owner Nostr public key, pinned from the Portal claim. Null until the claim carries it. */
  ownerPubkey: string | null;
  /** Owner user id (`sub = tealbrick-user:<userId>` for portal proofs). */
  ownerUserId: string | null;
};

export type OwnerApprovalVerification =
  | {
      ok: true;
      decision: "approve" | "deny";
      /** Nostr event id or JWT `jti`; stored instance-wide so one proof resolves one held call. */
      proofId: string;
      kind: "nostr" | "portal";
      /** Keep the used-proof row at least until the proof itself is no longer valid. */
      expiresAt: string;
      /** Who decided, for the approval record (e.g. `owner:<userId>` or `nostr:<pubkey prefix>`). */
      decidedBy: string;
      /** Portal assertion `device` claim, when present. */
      device?: string;
    }
  | { ok: false; status: number; error: string };

export type OwnerApprovalVerifier = {
  verify(input: {
    proof: OwnerApprovalProof;
    approvalId: string;
    /** The held call's digest (64 hex); the proof must name it. */
    digest: string;
    binding: OwnerApprovalBinding;
    now: Date;
  }): Promise<OwnerApprovalVerification>;
};

/** Fail closed until K1/K2 ship: no proof type is accepted. */
export const unsupportedOwnerApprovalVerifier: OwnerApprovalVerifier = Object.freeze({
  async verify(): Promise<OwnerApprovalVerification> {
    return { ok: false, status: 501, error: "approval_proof_unsupported" };
  },
});

/** The kit's idempotency key for a resolve: `resolve.<approvalId>.<decision>`. */
export const RESOLVE_IDEMPOTENCY_KEY = /^resolve\.([A-Za-z0-9_-]{1,100})\.(approve|deny)$/u;

/** A stale `resolving` claim (a crash during proof verification, before any provider call) may be taken over. */
export const RESOLVE_CLAIM_STALE_MS = 120_000;

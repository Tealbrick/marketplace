import {
  createJwksResolver,
  MAX_CLOCK_SKEW_SECONDS,
  NOSTR_APPROVAL_MAX_AGE_MS,
  NOSTR_FUTURE_SKEW_MS,
  ownerApprovalOptionsFromClaim,
  verifyNostrApprovalProof,
  verifyOwnerApprovalAssertion,
  type ApprovalProof,
  type JwksResolver,
  type OwnerApprovalDenialReason,
} from "@tealbrick/contract";

import { ownerUserIdFromSubject } from "./owner-pin.js";

/**
 * Owner approval proofs for `marketplace.approvals.resolve` (Channels spec §6.3 "One approval experience",
 * contract K1, alpha.6).
 *
 * The harness forwards an owner decision it never minted and the model never saw, as the contract's
 * `approvalResolveRequestSchema` body `{approvalId, proof}`: a Buzz reply (`proof: "nostr"`, an
 * owner-signed NIP-01 event and the conversation it was asked in) or a TBD button press (`proof: "portal"`,
 * a Portal-signed PO3 owner approval assertion). Marketplace verifies it locally with the contract
 * verifiers and binds it to the caller's own held call:
 *
 * - `nostr`: `verifyNostrApprovalProof` with the forwarded event and channel (the `h` tag must equal it),
 *   the held digest, the owner key PINNED ON THE HOLD at creation (it must still be the current key), age
 *   ≤ 15 minutes and single use of the event id. An event signed before the current key was set is refused,
 *   so unused proofs for an old key are dead after a key change.
 * - `portal`: `verifyOwnerApprovalAssertion` with the issuer-pinned grant JWKS from the claim binding
 *   (`ownerApprovalOptionsFromClaim`), `aud = tealbrick-app:<claimed instanceId>`, `dep` = own deployment,
 *   `sub` = the pinned `ownerSubject`, digest, approvalId, operation and agent of this hold, single-use `jti`.
 *
 * `isUsed` only checks; the route records the proof id (`markUsedApprovalProof`, instance-wide, atomic)
 * after every other check, so a refused proof never burns its id.
 */

/** What Marketplace pins the proof to. Every value comes from the app (claim binding, own config, owner setting), never the request. */
export type OwnerApprovalBinding = {
  /** Pinned Portal issuer (claim binding). */
  portalIssuer: string | null;
  /** Own deployment id (`dep`). */
  deploymentId: string | null;
  /** Claimed instance id (`aud = tealbrick-app:<instanceId>`). */
  instanceId: string | null;
  /** `tealbrick-user:<owner userId>` from the claim binding (alpha.7 owner pin). */
  ownerSubject: string | null;
  /** Grant JWKS on the pinned issuer (claim binding, §12.6.5). */
  jwksUri: string | null;
  grantKids: readonly string[];
  /** The owner's Buzz key the hold was pinned to (64 lowercase hex), only when it is still the current key. */
  ownerPubkey: string | null;
  ownerKeyFingerprint: string | null;
  /** When the current key was set (ms); events signed earlier are refused. */
  ownerKeySetAtMs: number | null;
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
      /** Who decided, for the approval record (`owner:<userId>` or `owner-nostr:<key fingerprint>`). */
      decidedBy: string;
      /** Portal assertion `amr` and `device` claims, when present (metadata only). */
      amr?: string[];
      device?: string;
    }
  | { ok: false; status: number; error: string; reason?: string };

export type OwnerApprovalVerifyInput = {
  proof: ApprovalProof;
  approvalId: string;
  /** The held call's digest (64 hex); the proof must name it. */
  digest: string;
  /** The held operation id (`op` of a Portal assertion). */
  operation: string;
  /** The held call's agent principal, `tealbrick-agent:<agentId>`. */
  agent: string;
  binding: OwnerApprovalBinding;
  now: Date;
};

export type OwnerApprovalVerifier = {
  verify(input: OwnerApprovalVerifyInput): Promise<OwnerApprovalVerification>;
};

/**
 * Shortest digest prefix a Buzz reply may approve with (`approve <prefix>`), in hex characters. Contract alpha.7
 * enforces ≥ 32; keep this check until the installed verifier enforces it (alpha.6 accepts 12). The same length
 * is used for the proof-ambiguity check and the hold-collision check (review B1).
 */
export const NOSTR_MIN_PREFIX_HEX = 32;

/** Review B1: other held calls of the workspace that share a proof's prefix count for this long (15 min max age + 5 min skew). */
export const NOSTR_AMBIGUITY_WINDOW_MS = 20 * 60_000;

/** The kit's idempotency key for a resolve: `resolve.<approvalId>.<decision>`. */
export const RESOLVE_IDEMPOTENCY_KEY = /^resolve\.([A-Za-z0-9_-]{1,100})\.(approve|deny)$/u;

/** A stale `resolving` claim (a crash during proof verification, before any provider call) may be taken over. */
export const RESOLVE_CLAIM_STALE_MS = 120_000;

const AMR_ENTRY = /^[A-Za-z0-9._:-]{1,32}$/u;
const MAX_AMR = 8;
const MAX_DEVICE_CHARS = 120;

/** Contract reason → resolve answer. A replayed proof is 409 `approval_proof_reused`; an unreachable key source 503. */
function portalRefusal(reason: OwnerApprovalDenialReason): { ok: false; status: number; error: string; reason: string } {
  if (reason === "replayed") return { ok: false, status: 409, error: "approval_proof_reused", reason };
  if (reason === "jwks_unavailable") return { ok: false, status: 503, error: "approval_proof_unavailable", reason };
  if (reason === "misconfigured") return { ok: false, status: 503, error: "approval_owner_unbound", reason };
  return { ok: false, status: 403, error: "approval_proof_invalid", reason };
}

/** The contract's Nostr reasons are prose; map them to stable codes for the answer and the audit. */
const NOSTR_REASONS: Array<[RegExp, string]> = [
  [/already used/u, "replayed"],
  [/not from the owner/u, "wrong_owner"],
  [/signature/u, "bad_signature"],
  [/approval channel/u, "wrong_channel"],
  [/too old/u, "stale"],
  [/future/u, "not_yet_valid"],
  [/prefix does not match/u, "wrong_digest"],
  [/at least/u, "prefix_too_short"],
  [/more than one/u, "ambiguous"],
  [/kind/u, "wrong_kind"],
  [/id does not match/u, "bad_id"],
  [/not configured/u, "misconfigured"],
];

function nostrRefusal(text: string): { ok: false; status: number; error: string; reason: string } {
  const reason = NOSTR_REASONS.find(([pattern]) => pattern.test(text))?.[1] ?? "malformed";
  if (reason === "replayed") return { ok: false, status: 409, error: "approval_proof_reused", reason };
  if (reason === "misconfigured") return { ok: false, status: 503, error: "approval_owner_unbound", reason };
  return { ok: false, status: 403, error: "approval_proof_invalid", reason };
}

/** Every `approve <hex>` prefix in a Buzz reply, lowercased (the contract accepts exactly one). */
function approvedPrefixes(content: unknown): string[] {
  if (typeof content !== "string") return [];
  return [...content.matchAll(/\bapprove\s+([0-9a-f]+)\b/giu)].map((match) => match[1]!.toLowerCase());
}

function boundedAmr(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === "string" && AMR_ENTRY.test(entry)).slice(0, MAX_AMR);
  return entries.length ? entries : undefined;
}

function boundedDevice(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Display metadata only: printable, single line, bounded.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, MAX_DEVICE_CHARS);
  return cleaned || undefined;
}

/**
 * The real verifier (contract alpha.6). `isUsed(proofId)` must only check (`nostr:<eventId>` /
 * `portal:<jti>`); the route records the id. `jwksFetch` reaches the issuer's grant JWKS (tests inject a fake).
 */
export function createContractOwnerApprovalVerifier(deps: {
  isUsed: (proofId: string) => boolean;
  /**
   * Review B1: true when another held call shares `prefix` with this one: any approval of the workspace (any
   * state) with a different digest created within `NOSTR_AMBIGUITY_WINDOW_MS`, or any other live (pending,
   * resolving, executing) held call of the instance. A Buzz reply binds only its prefix, not the approvalId.
   */
  prefixAmbiguous: (input: { prefix: string; approvalId: string; digest: string; now: Date }) => boolean;
  jwksFetch?: typeof fetch;
}): OwnerApprovalVerifier {
  // One resolver per pinned key source: it caches and pins key material per kid (a changed key under a kid is refused).
  const resolvers = new Map<string, JwksResolver>();
  const resolverFor = (binding: { portalIssuer: string; jwksUri: string; grantKids: readonly string[] }) => {
    const cacheKey = `${binding.portalIssuer}|${binding.jwksUri}|${[...binding.grantKids].sort().join(",")}`;
    let resolver = resolvers.get(cacheKey);
    if (!resolver) {
      const keys = ownerApprovalOptionsFromClaim(
        { portalIssuer: binding.portalIssuer, jwksUri: binding.jwksUri, grantKids: binding.grantKids },
        { ...(deps.jwksFetch ? { jwks: { fetch: deps.jwksFetch } } : {}) },
      );
      resolver = createJwksResolver(keys.jwks as Parameters<typeof createJwksResolver>[0]);
      if (resolvers.size > 8) resolvers.clear();
      resolvers.set(cacheKey, resolver);
    }
    return resolver;
  };

  return Object.freeze({
    async verify(input: OwnerApprovalVerifyInput): Promise<OwnerApprovalVerification> {
      const { proof, binding } = input;
      const nowMs = input.now.getTime();
      if (proof.proof === "nostr") {
        if (!binding.ownerPubkey || !binding.ownerKeyFingerprint || binding.ownerKeySetAtMs === null) {
          return { ok: false, status: 503, error: "approval_owner_unbound" };
        }
        // Review B1: the local 32-hex minimum runs before the contract verifier (alpha.6 accepts 12).
        const event = proof.event as { content?: unknown };
        if (approvedPrefixes(event.content).some((candidate) => candidate.length < NOSTR_MIN_PREFIX_HEX)) {
          return { ok: false, status: 409, error: "approval_proof_prefix_too_short", reason: "prefix_too_short" };
        }
        const result = await verifyNostrApprovalProof({
          event: proof.event,
          channel: proof.channel,
          ownerPubkey: binding.ownerPubkey,
          digest: input.digest,
          maxAgeMs: NOSTR_APPROVAL_MAX_AGE_MS,
          isUsed: (eventId) => deps.isUsed(`nostr:${eventId}`),
          now: nowMs,
        });
        if (!result.ok) return nostrRefusal(result.reason);
        // The contract accepted exactly one `approve <prefix>` naming this digest; bind it to this hold alone.
        const prefixes = approvedPrefixes(proof.event.content);
        const prefix = prefixes.length === 1 ? prefixes[0]! : null;
        if (!prefix || prefix.length < NOSTR_MIN_PREFIX_HEX || !input.digest.startsWith(prefix)) {
          return { ok: false, status: 409, error: "approval_proof_prefix_too_short", reason: "prefix_too_short" };
        }
        if (deps.prefixAmbiguous({ prefix, approvalId: input.approvalId, digest: input.digest, now: input.now })) {
          return { ok: false, status: 409, error: "approval_proof_ambiguous", reason: "ambiguous_prefix" };
        }
        const createdAtMs = proof.event.created_at * 1000;
        // Signed before the current key was set: a proof for the old key epoch (rule 3).
        if (createdAtMs < Math.floor(binding.ownerKeySetAtMs / 1000) * 1000) {
          return { ok: false, status: 403, error: "approval_proof_invalid", reason: "key_changed" };
        }
        return {
          ok: true,
          decision: "approve",
          proofId: result.eventId,
          kind: "nostr",
          expiresAt: new Date(Math.max(createdAtMs, nowMs) + NOSTR_APPROVAL_MAX_AGE_MS + NOSTR_FUTURE_SKEW_MS).toISOString(),
          decidedBy: `owner-nostr:${binding.ownerKeyFingerprint}`,
        };
      }
      const ownerUserId = binding.ownerSubject ? ownerUserIdFromSubject(binding.ownerSubject) : null;
      if (!binding.portalIssuer || !binding.jwksUri || !binding.instanceId || !binding.deploymentId || !ownerUserId) {
        return { ok: false, status: 503, error: "approval_owner_unbound" };
      }
      let jwks: JwksResolver;
      try {
        jwks = resolverFor({ portalIssuer: binding.portalIssuer, jwksUri: binding.jwksUri, grantKids: binding.grantKids });
      } catch {
        return { ok: false, status: 503, error: "approval_owner_unbound", reason: "misconfigured" };
      }
      const result = await verifyOwnerApprovalAssertion(proof.token, {
        issuer: binding.portalIssuer,
        jwks,
        now: () => nowMs,
        instanceId: binding.instanceId,
        deploymentId: binding.deploymentId,
        // alpha.6 adapter (owner-pin.ts): sub = tealbrick-user:<ownerUserId> = the pinned ownerSubject.
        ownerUserId,
        approvalId: input.approvalId,
        digest: input.digest,
        operation: input.operation,
        agent: input.agent,
        isUsed: (jti) => deps.isUsed(`portal:${jti}`),
      });
      if (!result.ok) return portalRefusal(result.reason);
      const claims = result.claims as unknown as Record<string, unknown>;
      const amr = boundedAmr(claims.amr);
      const device = boundedDevice(claims.device);
      return {
        ok: true,
        decision: result.decision,
        proofId: result.jti,
        kind: "portal",
        // Review L3: keep the used jti until exp + the verifier's clock skew (it is accepted until then).
        expiresAt: new Date(Math.max(result.expiresAt, nowMs) + MAX_CLOCK_SKEW_SECONDS * 1000).toISOString(),
        decidedBy: `owner:${ownerUserId}`,
        ...(amr ? { amr } : {}),
        ...(device ? { device } : {}),
      };
    },
  });
}

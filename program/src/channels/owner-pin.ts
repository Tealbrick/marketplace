import { isIssuerJwksUri, isPortalIssuer, USER_PRINCIPAL_PREFIX } from "@tealbrick/contract";

import { parseOwnerNostrPubkey } from "./owner-key.js";

/**
 * Owner pins for `marketplace.approvals.resolve` (Channels spec §6.3), read from the contract claim binding.
 *
 * Contract alpha.7 (tealbrick-packages#80) stores `{ownerSubject, ownerPinnedAt}` in the claim binding
 * (`await claim.store.read()`): pinned from the Core-signed claim, re-pinned only by a NEWER claim
 * (`claimIssuedAt`) and cleared by a claim without it. Marketplace never pins from anything else; in
 * particular the Portal launch credential's `ownerSubject` names the deployment owner and is never used to
 * authorize the caller or to re-pin.
 *
 * TODO(manifest-claim PR, Lead · Miniapps): Marketplace still answers the LEGACY claim path, so no binding
 * exists and `NO_OWNER_PIN` is the default source (resolve answers `approval_owner_unbound` for `portal`
 * proofs). When the manifest-claim handler lands, pass its `claim.store` as `ownerPinSource`; nothing else
 * changes here. This module never touches the claim code.
 *
 * TODO(Portal v2, Lead · Portal): Portal attests the owner's Buzz key through a Buzz-signed challenge and
 * emits `ownerNostrPubkey` in the claim. `readAttestedOwnerNostrPubkey` returns it once the binding carries
 * it (`absent` today); the owner-set key must then equal it (rule 4), else Nostr proofs are refused. An
 * unreadable store or a malformed value is `error`, which also refuses.
 */

/** The claim binding fields Marketplace reads (alpha.7 `ClaimBinding` plus the Portal v2 key). */
export type OwnerClaimBinding = {
  readonly portalIssuer: string;
  readonly instanceId: string;
  readonly jwksUri?: string;
  readonly grantKids?: readonly string[];
  /** alpha.7: `tealbrick-user:<owner userId>` from the Core-signed claim. */
  readonly ownerSubject?: string | null;
  readonly ownerPinnedAt?: number | null;
  /** Portal v2: the owner's Buzz key attested by Portal (64 hex). */
  readonly ownerNostrPubkey?: string | null;
};

/** Structurally the contract `ClaimStore.read` (alpha.7 `claim.store`). */
export type OwnerPinSource = {
  read(): OwnerClaimBinding | null | undefined | Promise<OwnerClaimBinding | null | undefined>;
};

/** Today's source: the legacy claim path stores no binding, so nothing is pinned. */
export const NO_OWNER_PIN: OwnerPinSource = Object.freeze({ read: () => null });

const SUBJECT = /^tealbrick-user:[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const HEX_KEY = /^[0-9a-f]{64}$/u;
const KID = /^[A-Za-z0-9._:-]{1,128}$/u;

/** The pinned owner and the PO3 key source, validated. */
export type OwnerPin = {
  portalIssuer: string;
  instanceId: string;
  jwksUri: string | null;
  grantKids: readonly string[];
  ownerSubject: string;
  ownerPinnedAt: number | null;
};

async function readBinding(source: OwnerPinSource): Promise<OwnerClaimBinding | null> {
  try {
    const binding = await source.read();
    return binding && typeof binding === "object" ? binding : null;
  } catch {
    // An unreadable store pins nothing (fail closed).
    return null;
  }
}

/** The pinned owner, or null when the binding carries no valid `ownerSubject` (refuse: approval_owner_unbound). */
export async function readOwnerPin(source: OwnerPinSource): Promise<OwnerPin | null> {
  const binding = await readBinding(source);
  if (!binding || !isPortalIssuer(binding.portalIssuer)) return null;
  if (typeof binding.instanceId !== "string" || !binding.instanceId) return null;
  if (typeof binding.ownerSubject !== "string" || !SUBJECT.test(binding.ownerSubject)) return null;
  const jwksUri = typeof binding.jwksUri === "string" && isIssuerJwksUri(binding.portalIssuer, binding.jwksUri) ? binding.jwksUri : null;
  const grantKids = Array.isArray(binding.grantKids) ? binding.grantKids.filter((kid): kid is string => typeof kid === "string" && KID.test(kid)) : [];
  return {
    portalIssuer: binding.portalIssuer,
    instanceId: binding.instanceId,
    jwksUri,
    grantKids,
    ownerSubject: binding.ownerSubject,
    ownerPinnedAt: typeof binding.ownerPinnedAt === "number" && Number.isFinite(binding.ownerPinnedAt) ? binding.ownerPinnedAt : null,
  };
}

/**
 * alpha.6 adapter: `verifyOwnerApprovalAssertion` takes `ownerUserId` and checks `sub =
 * tealbrick-user:<ownerUserId>`, which is exactly `ownerSubject`. TODO(contract alpha.7): pass
 * `ownerSubject: pin.ownerSubject` (and only that) to the verifier and drop this adapter.
 */
export function ownerUserIdFromSubject(subject: string): string | null {
  return SUBJECT.test(subject) ? subject.slice(USER_PRINCIPAL_PREFIX.length) : null;
}

/**
 * Portal v2 attestation of the owner's Buzz key. `absent`: the binding carries no `ownerNostrPubkey` (today,
 * always). `attested`: a valid key (64 hex or npub, normalised lowercase hex). `error` (review B2): the store
 * could not be read or the field is malformed; callers treat it as a mismatch and refuse (fail closed), never
 * as "no attestation".
 */
export type OwnerKeyAttestation = { status: "absent" } | { status: "attested"; pubkey: string } | { status: "error" };

export async function readAttestedOwnerNostrPubkey(source: OwnerPinSource): Promise<OwnerKeyAttestation> {
  let binding: OwnerClaimBinding | null | undefined;
  try {
    binding = await source.read();
  } catch {
    return { status: "error" };
  }
  if (binding === null || binding === undefined) return { status: "absent" };
  if (typeof binding !== "object") return { status: "error" };
  const value = binding.ownerNostrPubkey;
  if (value === undefined || value === null) return { status: "absent" };
  const parsed = parseOwnerNostrPubkey(value);
  return parsed.ok && HEX_KEY.test(parsed.pubkey) ? { status: "attested", pubkey: parsed.pubkey } : { status: "error" };
}

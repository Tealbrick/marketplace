import { isIssuerJwksUri, isOwnerSubject, isPortalIssuer, type ClaimBinding } from "@tealbrick/contract";

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
 * The source is the manifest-claim handler's `claim.store` (`createManifestClaim(...).store`, the binding file
 * beside the claim identity); the app passes it as `ownerPinSource`. Without a claim identity directory there
 * is no binding and `NO_OWNER_PIN` applies (resolve answers `approval_owner_unbound` for `portal` proofs).
 *
 * TODO(Portal v2, Lead · Portal): Portal attests the owner's Buzz key through a Buzz-signed challenge and
 * emits `ownerNostrPubkey` in the claim. `readAttestedOwnerNostrPubkey` returns it once the binding carries
 * it (`absent` today); the owner-set key must then equal it (rule 4), else Nostr proofs are refused. An
 * unreadable store or a malformed value is `error`, which also refuses.
 */

/**
 * The claim binding fields Marketplace reads: the alpha.7 contract `ClaimBinding` (`ownerSubject`,
 * `ownerPinnedAt`) plus the Portal v2 key. A cleared pin has no `ownerSubject`; `null` is read the same way.
 */
export type OwnerClaimBinding = Pick<ClaimBinding, "portalIssuer" | "instanceId" | "jwksUri" | "grantKids"> & {
  /** `tealbrick-user:<owner id>` from the newest Core-signed claim (`OWNER_SUBJECT_PATTERN`). */
  readonly ownerSubject?: ClaimBinding["ownerSubject"] | null;
  /** High-water mark of the pin (`claimIssuedAt` of the newest accepted claim, ms). */
  readonly ownerPinnedAt?: ClaimBinding["ownerPinnedAt"] | null;
  /** Portal v2: the owner's Buzz key attested by Portal (64 hex). */
  readonly ownerNostrPubkey?: string | null;
};

/** Structurally the contract `ClaimStore.read` (alpha.7 `claim.store`). */
export type OwnerPinSource = {
  read(): OwnerClaimBinding | null | undefined | Promise<OwnerClaimBinding | null | undefined>;
};

/** No claim binding (no claim identity directory): nothing is pinned. */
export const NO_OWNER_PIN: OwnerPinSource = Object.freeze({ read: () => null });

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
  // The contract's own pattern (`OWNER_SUBJECT_PATTERN`): the pin is passed to the verifier as is.
  if (!isOwnerSubject(binding.ownerSubject)) return null;
  const jwksUri = typeof binding.jwksUri === "string" && isIssuerJwksUri(binding.portalIssuer, binding.jwksUri) ? binding.jwksUri : null;
  const grantKids = Array.isArray(binding.grantKids) ? binding.grantKids.filter((kid): kid is string => typeof kid === "string" && KID.test(kid)) : [];
  return {
    portalIssuer: binding.portalIssuer,
    instanceId: binding.instanceId,
    jwksUri,
    grantKids,
    ownerSubject: binding.ownerSubject as string,
    ownerPinnedAt: typeof binding.ownerPinnedAt === "number" && Number.isSafeInteger(binding.ownerPinnedAt) ? binding.ownerPinnedAt : null,
  };
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

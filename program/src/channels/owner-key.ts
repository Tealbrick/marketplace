import { createHash } from "node:crypto";

/**
 * The owner's Buzz (Nostr) key, v1 (Channels spec §6.3 "Owner pins"): an app-owned, owner-only Marketplace
 * setting `approvals.ownerNostrPubkey`. It is never a manifest setting (Portal's settings relay must not be
 * able to write it), never a provider-env or account field, and only an owner operator session from a Portal
 * launch ticket may change it.
 *
 * Accepted input: 64 hex characters (either case; stored lowercase) or a NIP-19 `npub1…` string (bech32
 * with its checksum verified). `nsec`, any other prefix, whitespace inside the value and free text are
 * refused. Only the fingerprint (the first 16 hex of sha256 over the 32 key bytes) is ever shown or audited.
 */

export const OWNER_NOSTR_KEY_SETTING = "approvals.ownerNostrPubkey";
export const OWNER_KEY_FINGERPRINT_CHARS = 16;

const HEX_KEY = /^[0-9a-fA-F]{64}$/u;
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
/** BIP-173 limit (NIP-19 strings for a 32-byte key are 63 characters). */
const BECH32_MAX_LENGTH = 90;

export type OwnerKeyParse = { ok: true; pubkey: string } | { ok: false; error: "owner_key_invalid" };

function polymod(values: readonly number[]) {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) if ((top >>> bit) & 1) checksum ^= BECH32_GENERATOR[bit]!;
  }
  return checksum;
}

function hrpExpand(hrp: string) {
  const codes = [...hrp].map((char) => char.charCodeAt(0));
  return [...codes.map((code) => code >>> 5), 0, ...codes.map((code) => code & 31)];
}

/** Strict BIP-173 bech32 (not bech32m) decode: one case, valid charset, valid checksum. Null otherwise. */
export function decodeBech32(value: string): { hrp: string; words: number[] } | null {
  if (value.length < 8 || value.length > BECH32_MAX_LENGTH) return null;
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) return null;
  const lower = value.toLowerCase();
  const separator = lower.lastIndexOf("1");
  if (separator < 1 || separator + 7 > lower.length) return null;
  const hrp = lower.slice(0, separator);
  if ([...hrp].some((char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126)) return null;
  const data: number[] = [];
  for (const char of lower.slice(separator + 1)) {
    const index = BECH32_CHARSET.indexOf(char);
    if (index < 0) return null;
    data.push(index);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) return null;
  return { hrp, words: data.slice(0, -6) };
}

/** 5-bit words to bytes; refuses non-zero or over-long padding (BIP-173). */
function wordsToBytes(words: readonly number[]): Buffer | null {
  let accumulator = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const word of words) {
    accumulator = (accumulator << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits >= 5 || accumulator !== 0) return null;
  return Buffer.from(bytes);
}

/** Normalise an owner Nostr public key: 64 hex (lowercased) or `npub1…`. Everything else is refused. */
export function parseOwnerNostrPubkey(input: unknown): OwnerKeyParse {
  const refused = { ok: false, error: "owner_key_invalid" } as const;
  if (typeof input !== "string") return refused;
  if (HEX_KEY.test(input)) return { ok: true, pubkey: input.toLowerCase() };
  const decoded = decodeBech32(input);
  if (!decoded || decoded.hrp !== "npub") return refused;
  const bytes = wordsToBytes(decoded.words);
  if (!bytes || bytes.length !== 32) return refused;
  return { ok: true, pubkey: bytes.toString("hex") };
}

/** First 16 hex of sha256 over the 32 key bytes. Shown and audited instead of the key. */
export function ownerKeyFingerprint(pubkey: string): string {
  return createHash("sha256").update(Buffer.from(pubkey, "hex")).digest("hex").slice(0, OWNER_KEY_FINGERPRINT_CHARS);
}

export type OwnerKeySource = "owner-session" | "portal-attested";
export type OwnerKeyStatus = "unset" | "ok" | "mismatch";

/** What the owner UI and the Approvals view show: fingerprints only, never the key. */
export type OwnerKeyView = {
  setting: typeof OWNER_NOSTR_KEY_SETTING;
  fingerprint: string | null;
  ownerKeySource: OwnerKeySource | null;
  ownerKeyStatus: OwnerKeyStatus;
  /** Fingerprint of the Portal-attested key (Portal v2), when Portal attests one. */
  attestedFingerprint: string | null;
  setAt: string | null;
};

/**
 * The trust state of the configured key against the Portal-attested one (rule 4): no configured key is
 * `unset`; a configured key with no attestation is `ok` from the owner session; an equal attestation makes
 * it `portal-attested`; a different one is `mismatch` (Nostr proofs are refused until the owner fixes it).
 */
export function ownerKeyView(configured: { pubkey: string; setAt: string } | null, attested: string | null): OwnerKeyView {
  const attestedFingerprint = attested ? ownerKeyFingerprint(attested) : null;
  if (!configured) {
    return { setting: OWNER_NOSTR_KEY_SETTING, fingerprint: null, ownerKeySource: null, ownerKeyStatus: "unset", attestedFingerprint, setAt: null };
  }
  const fingerprint = ownerKeyFingerprint(configured.pubkey);
  const matches = attested !== null && attested === configured.pubkey;
  return {
    setting: OWNER_NOSTR_KEY_SETTING,
    fingerprint,
    ownerKeySource: matches ? "portal-attested" : "owner-session",
    ownerKeyStatus: attested !== null && !matches ? "mismatch" : "ok",
    attestedFingerprint,
    setAt: configured.setAt,
  };
}

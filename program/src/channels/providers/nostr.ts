import { createHash, randomBytes, randomUUID } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { nostrEventId, nostrSignatureValid } from "@tealbrick/contract/nostr-approval";

import { decodeBech32, parseOwnerNostrPubkey } from "../owner-key.js";

// Nostr primitives for the Buzz adapter, the Buzz identity and the relay socket. BIP-340 keys and signatures
// through `@noble/curves` (the version @tealbrick/contract already ships); event ids and signature checks through
// the @tealbrick/contract helpers. A secret key is a 64-hex string held only by the caller: nothing here logs,
// stores or returns it.

export const HEX64 = /^[0-9a-f]{64}$/u;
const SIG_HEX = /^[0-9a-f]{128}$/u;

export type NostrEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type UnsignedEvent = { kind: number; created_at: number; tags: string[][]; content: string };

/** A new random secp256k1 secret key (64 hex). */
export function generateSecretKey(random?: () => Uint8Array): string {
  const bytes = random ? random() : schnorr.utils.randomSecretKey();
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error("nostr_key_invalid");
  const hex = Buffer.from(bytes).toString("hex");
  bytes.fill(0);
  // Validates the scalar range (throws for 0 or >= n).
  schnorr.getPublicKey(Buffer.from(hex, "hex"));
  return hex;
}

/** x-only public key (64 hex) of a secret key, or null when the secret is not a usable key. */
export function publicKeyOf(secretHex: string): string | null {
  if (typeof secretHex !== "string" || !HEX64.test(secretHex)) return null;
  const secret = Buffer.from(secretHex, "hex");
  try {
    return Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
  } catch {
    return null;
  } finally {
    secret.fill(0);
  }
}

/** Signs an event with the secret key: NIP-01 id (contract helper) and a BIP-340 signature with fresh aux randomness. */
export function signEvent(secretHex: string, input: UnsignedEvent): NostrEvent {
  const pubkey = publicKeyOf(secretHex);
  if (!pubkey) throw new Error("nostr_key_invalid");
  const unsigned = { pubkey, created_at: input.created_at, kind: input.kind, tags: input.tags, content: input.content };
  const id = nostrEventId(unsigned);
  const secret = Buffer.from(secretHex, "hex");
  try {
    const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), secret, randomBytes(32))).toString("hex");
    return { id, ...unsigned, sig };
  } finally {
    secret.fill(0);
  }
}

/** Shape, recomputed id and BIP-340 signature (contract helpers). Untrusted input. */
export function verifyEvent(value: unknown): value is NostrEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (
    typeof event.id !== "string" ||
    typeof event.pubkey !== "string" ||
    !HEX64.test(event.pubkey) ||
    typeof event.sig !== "string" ||
    !SIG_HEX.test(event.sig) ||
    typeof event.kind !== "number" ||
    !Number.isInteger(event.kind) ||
    event.kind < 0 ||
    event.kind > 65_535 ||
    typeof event.created_at !== "number" ||
    !Number.isSafeInteger(event.created_at) ||
    typeof event.content !== "string" ||
    !Array.isArray(event.tags) ||
    !event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
  ) {
    return false;
  }
  const typed = event as unknown as NostrEvent;
  return nostrEventId(typed) === typed.id && nostrSignatureValid(typed);
}

// ---------------------------------------------------------------- NIP-19 npub

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let bit = 0; bit < 5; bit += 1) if ((top >>> bit) & 1) checksum ^= BECH32_GENERATOR[bit]!;
  }
  return checksum;
}

/** NIP-19 `npub1…` for a 64-hex public key. */
export function npubEncode(pubkeyHex: string): string {
  if (!HEX64.test(pubkeyHex)) throw new Error("nostr_pubkey_invalid");
  const words: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of Buffer.from(pubkeyHex, "hex")) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((accumulator >>> bits) & 31);
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits > 0) words.push((accumulator << (5 - bits)) & 31);
  const hrp = "npub";
  const expanded = [...[...hrp].map((char) => char.charCodeAt(0) >>> 5), 0, ...[...hrp].map((char) => char.charCodeAt(0) & 31)];
  const checksum = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const tail = Array.from({ length: 6 }, (_unused, index) => (checksum >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...words, ...tail].map((word) => BECH32_CHARSET[word]).join("")}`;
}

/** 64 hex (lowercased) or a checksummed `npub1…` to 64 hex; null otherwise (never an `nsec`). */
export function parsePubkey(input: unknown): string | null {
  const parsed = parseOwnerNostrPubkey(typeof input === "string" ? input.trim() : input);
  return parsed.ok ? parsed.pubkey : null;
}

/** Short display form of a public key: `npub1abcd…wxyz`. */
export function shortNpub(pubkeyHex: string): string {
  const npub = npubEncode(pubkeyHex);
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

/** True for any bech32 string with the given prefix (e.g. a stray `nsec` pasted into a field). */
export function isBech32With(value: string, hrp: string): boolean {
  return decodeBech32(value)?.hrp === hrp;
}

// ---------------------------------------------------------------- NIP-OA owner attestation

/** Longest end date the owner may sign (Coordinator, 2026-10-10): 90 days. */
export const NIP_OA_MAX_LIFETIME_SECONDS = 90 * 86_400;
/** The owner screen reminds the owner to renew the tag this long before its end date. */
export const NIP_OA_RENEWAL_REMINDER_SECONDS = 14 * 86_400;
const MAX_U32 = 4_294_967_295;
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]{0,9})$/u;

export type AuthConditions = {
  /** `kind=` clauses (conjunctive: two different kinds authorise no event). */
  kinds: number[];
  /** The smallest `created_at<T` (exclusive end), when present. */
  before?: number;
  /** The largest `created_at>T` (exclusive start), when present. */
  after?: number;
};

/** NIP-OA conditions grammar: `''` or `clause(&clause)*`; clauses `kind=<n>`, `created_at<<t>`, `created_at><t>`. */
export function parseAuthConditions(conditions: string): AuthConditions | null {
  if (typeof conditions !== "string" || conditions.length > 1024) return null;
  const parsed: AuthConditions = { kinds: [] };
  if (conditions === "") return parsed;
  if (!/^[\x21-\x7e]+$/u.test(conditions)) return null;
  for (const clause of conditions.split("&")) {
    const match = /^(kind=|created_at<|created_at>)(.+)$/u.exec(clause);
    if (!match || !CANONICAL_DECIMAL.test(match[2]!)) return null;
    const value = Number(match[2]);
    if (match[1] === "kind=") {
      if (value > 65_535) return null;
      parsed.kinds.push(value);
    } else {
      if (value > MAX_U32) return null;
      if (match[1] === "created_at<") parsed.before = parsed.before === undefined ? value : Math.min(parsed.before, value);
      else parsed.after = parsed.after === undefined ? value : Math.max(parsed.after, value);
    }
  }
  return parsed;
}

/** The exact NIP-OA preimage the owner signs: `nostr:agent-auth:<agent pubkey hex>:<conditions>`. */
export function authPreimage(agentPubkey: string, conditions: string): string {
  return `nostr:agent-auth:${agentPubkey}:${conditions}`;
}

export type AuthTagFailure =
  | "auth_tag_malformed"
  | "auth_tag_conditions_invalid"
  | "auth_tag_self_attested"
  | "auth_tag_signature_invalid"
  | "auth_tag_wrong_owner"
  | "auth_tag_end_missing"
  | "auth_tag_too_long"
  | "auth_tag_expired"
  | "auth_tag_not_yet_valid"
  | "auth_tag_kinds_unsatisfiable";

export type VerifiedAuthTag = {
  tag: [string, string, string, string];
  /** Canonical JSON of the four-element tag (what is stored and sent in `x-auth-tag`). */
  json: string;
  /** SHA-256 of `json` (audited instead of the tag). */
  sha256: string;
  ownerPubkey: string;
  conditions: string;
  parsed: AuthConditions;
  /** Unix seconds: events must have `created_at` < this. */
  expiresAt: number;
};

export type AuthTagCheck = { ok: true; value: VerifiedAuthTag } | { ok: false; reason: AuthTagFailure };

/** Parses the owner's pasted tag: a JSON array string or an array. Shape only. */
export function parseAuthTag(input: unknown): [string, string, string, string] | null {
  let value = input;
  if (typeof input === "string") {
    if (input.length > 4096) return null;
    try {
      value = JSON.parse(input.trim());
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value) || value.length !== 4 || !value.every((part) => typeof part === "string")) return null;
  const [name, owner, conditions, sig] = value as [string, string, string, string];
  if (name !== "auth" || !HEX64.test(owner) || !SIG_HEX.test(sig)) return null;
  return [name, owner, conditions, sig];
}

/**
 * Verifies an owner's NIP-OA tag for the agent key (docs/nips/NIP-OA.md): four elements, lowercase hex owner key,
 * owner ≠ agent, valid conditions grammar, BIP-340 signature by the owner over SHA256(`nostr:agent-auth:` ||
 * agent || `:` || conditions) using the conditions string verbatim. Marketplace rules on top: when an owner
 * Buzz key is pinned the tag's owner must equal it; the conditions must carry an end (`created_at<T`) with
 * now < T ≤ now + 90 days; a `created_at>` start must have passed; at most one distinct `kind=` value.
 */
export function verifyAuthTag(input: { tag: unknown; agentPubkey: string; pinnedOwner?: string | null; nowSeconds: number }): AuthTagCheck {
  const fail = (reason: AuthTagFailure): AuthTagCheck => ({ ok: false, reason });
  const tag = parseAuthTag(input.tag);
  if (!tag || !HEX64.test(input.agentPubkey)) return fail("auth_tag_malformed");
  const [, ownerPubkey, conditions, sig] = tag;
  const parsed = parseAuthConditions(conditions);
  if (!parsed) return fail("auth_tag_conditions_invalid");
  if (ownerPubkey === input.agentPubkey) return fail("auth_tag_self_attested");
  const digest = createHash("sha256").update(authPreimage(input.agentPubkey, conditions), "utf8").digest();
  let signed = false;
  try {
    signed = schnorr.verify(Buffer.from(sig, "hex"), digest, Buffer.from(ownerPubkey, "hex"));
  } catch {
    signed = false;
  }
  if (!signed) return fail("auth_tag_signature_invalid");
  if (input.pinnedOwner && input.pinnedOwner !== ownerPubkey) return fail("auth_tag_wrong_owner");
  if (new Set(parsed.kinds).size > 1) return fail("auth_tag_kinds_unsatisfiable");
  if (parsed.before === undefined) return fail("auth_tag_end_missing");
  if (parsed.before > input.nowSeconds + NIP_OA_MAX_LIFETIME_SECONDS) return fail("auth_tag_too_long");
  if (parsed.before <= input.nowSeconds) return fail("auth_tag_expired");
  if (parsed.after !== undefined && parsed.after >= input.nowSeconds) return fail("auth_tag_not_yet_valid");
  const json = JSON.stringify(tag);
  return {
    ok: true,
    value: { tag, json, sha256: createHash("sha256").update(json, "utf8").digest("hex"), ownerPubkey, conditions, parsed, expiresAt: parsed.before },
  };
}

/** May an event of this kind and time carry the tag (NIP-OA event conditions)? */
export function authTagAllows(parsed: AuthConditions, kind: number, createdAt: number): boolean {
  if (parsed.kinds.some((value) => value !== kind)) return false;
  if (parsed.before !== undefined && !(createdAt < parsed.before)) return false;
  if (parsed.after !== undefined && !(createdAt > parsed.after)) return false;
  return true;
}

// ---------------------------------------------------------------- HTTP auth (NIP-98, Blossom) and NIP-42

/**
 * NIP-98 `Authorization` value for one request: kind 27235 with `u` (exact URL), `method`, a fresh `nonce`
 * (the relay rejects replays) and `payload` = SHA-256 hex of the body when there is one. Base64 (standard).
 */
export function nip98Authorization(secretHex: string, input: { url: string; method: string; body?: string | Uint8Array; nowSeconds: number }): string {
  const tags: string[][] = [
    ["u", input.url],
    ["method", input.method.toUpperCase()],
    ["nonce", randomUUID()],
  ];
  if (input.body !== undefined) {
    tags.push(["payload", createHash("sha256").update(input.body).digest("hex")]);
  }
  const event = signEvent(secretHex, { kind: 27235, created_at: input.nowSeconds, tags, content: "" });
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

/**
 * Blossom (BUD-02) upload `Authorization` value: kind 24242 with `t=upload`, `x` = SHA-256 of the bytes, an
 * `expiration` and the relay `server` authority, base64url without padding (as the Buzz CLI sends it).
 */
export function blossomUploadAuthorization(secretHex: string, input: { sha256: string; server: string; nowSeconds: number; ttlSeconds: number }): string {
  const event = signEvent(secretHex, {
    kind: 24242,
    created_at: input.nowSeconds,
    tags: [
      ["t", "upload"],
      ["x", input.sha256],
      ["expiration", String(input.nowSeconds + input.ttlSeconds)],
      ["server", input.server],
    ],
    content: "Upload file",
  });
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}`;
}

/** NIP-42 AUTH event (kind 22242) with the relay URL, the challenge and, for NIP-AA admission, the owner's tag. */
export function authEvent(secretHex: string, input: { relayUrl: string; challenge: string; authTag: readonly string[] | null; nowSeconds: number }): NostrEvent {
  const tags: string[][] = [
    ["relay", input.relayUrl],
    ["challenge", input.challenge],
  ];
  if (input.authTag) tags.push([...input.authTag]);
  return signEvent(secretHex, { kind: 22242, created_at: input.nowSeconds, tags, content: "" });
}

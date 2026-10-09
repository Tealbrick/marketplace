// Test-only: owner approval proofs signed locally (BIP-340 Nostr events, PO3 Ed25519 assertions). Never imported by runtime code.
import { createHash, generateKeyPairSync, randomUUID, sign, type JsonWebKey, type KeyObject } from "node:crypto";

import { nostrEventId, OWNER_APPROVAL_HEADER_TYP, OWNER_APPROVAL_TYP } from "@tealbrick/contract";

import { NOSTR_MIN_PREFIX_HEX } from "./approvals.js";
import type { OwnerClaimBinding, OwnerPinSource } from "./owner-pin.js";

// ----- secp256k1 / BIP-340 (BigInt; slow but dependency-free, enough for tests) -----------------

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G: Point = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
type Point = [bigint, bigint] | null;

const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function inv(a: bigint) {
  let result = 1n;
  let base = mod(a);
  let exponent = P - 2n;
  while (exponent > 0n) {
    if (exponent & 1n) result = mod(result * base);
    base = mod(base * base);
    exponent >>= 1n;
  }
  return result;
}
function add(a: Point, b: Point): Point {
  if (!a) return b;
  if (!b) return a;
  if (a[0] === b[0] && mod(a[1] + b[1]) === 0n) return null;
  const slope = a[0] === b[0] && a[1] === b[1] ? mod(3n * a[0] * a[0] * inv(2n * a[1])) : mod((b[1] - a[1]) * inv(b[0] - a[0]));
  const x = mod(slope * slope - a[0] - b[0]);
  return [x, mod(slope * (a[0] - x) - a[1])];
}
function mul(k: bigint, point: Point): Point {
  let result: Point = null;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = add(addend, addend);
    k >>= 1n;
  }
  return result;
}
const toBytes = (value: bigint) => Buffer.from(value.toString(16).padStart(64, "0"), "hex");
const toInt = (bytes: Buffer) => BigInt(`0x${bytes.toString("hex")}`);
const tagged = (tag: string, ...parts: Buffer[]) => {
  const tagHash = createHash("sha256").update(tag).digest();
  return createHash("sha256").update(Buffer.concat([tagHash, tagHash, ...parts])).digest();
};

export type NostrKey = { secret: bigint; pubkey: string };

/** A deterministic owner key from a seed (any string). */
export function nostrKey(seed: string): NostrKey {
  const secret = mod(toInt(createHash("sha256").update(seed).digest()), N - 1n) + 1n;
  return { secret, pubkey: toBytes(mul(secret, G)![0]).toString("hex") };
}

/** BIP-340 Schnorr signature over a 32-byte message. */
export function schnorrSign(message: Buffer, key: NostrKey): string {
  const point = mul(key.secret, G)!;
  const d = point[1] % 2n === 0n ? key.secret : N - key.secret;
  const px = toBytes(point[0]);
  const aux = Buffer.alloc(32, 7);
  const t = toBytes(d ^ toInt(tagged("BIP0340/aux", aux)));
  const k0 = mod(toInt(tagged("BIP0340/nonce", t, px, message)), N);
  const r = mul(k0, G)!;
  const k = r[1] % 2n === 0n ? k0 : N - k0;
  const e = mod(toInt(tagged("BIP0340/challenge", toBytes(r[0]), px, message)), N);
  return Buffer.concat([toBytes(r[0]), toBytes(mod(k + e * d, N))]).toString("hex");
}

/** An owner-signed Buzz reply `approve <prefix>` in `channel`, exactly as the kit forwards it. */
export function signedApproval(input: { key: NostrKey; channel: string; digest: string; prefixLength?: number; createdAt?: number; content?: string; kind?: number }) {
  const unsigned = {
    pubkey: input.key.pubkey,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    kind: input.kind ?? 9,
    tags: [["h", input.channel]],
    content: input.content ?? `approve ${input.digest.slice(0, input.prefixLength ?? NOSTR_MIN_PREFIX_HEX)}`,
  };
  const id = nostrEventId(unsigned);
  return { id, ...unsigned, sig: schnorrSign(Buffer.from(id, "hex"), input.key) };
}

// ----- PO3 owner approval assertions (Ed25519 JWKS) -----------------------------------------

export type PortalSigner = { kid: string; jwk: JsonWebKey & { kid: string; alg: string; use: string }; privateKey: KeyObject };

export function portalSigner(kid = "grant-key-1"): PortalSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { kid, jwk: { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid, alg: "EdDSA", use: "sig" }, privateKey };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A compact JWS signed with the signer (header and claims as given). */
export function signJws(signer: PortalSigner, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const input = `${b64({ alg: "EdDSA", kid: signer.kid, ...header })}.${b64(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), signer.privateKey).toString("base64url")}`;
}

export type OwnerAssertionClaims = {
  iss: string;
  sub: string;
  aud: string;
  dep: string;
  approvalId: string;
  digest: string;
  decision: "approve" | "deny";
  op: string;
  agent: string;
  jti?: string;
  iat?: number;
  exp?: number;
  amr?: string[];
  device?: string;
};

/** A Portal-minted owner approval assertion (header and payload typ per contract alpha.6). */
export function ownerAssertion(signer: PortalSigner, claims: OwnerAssertionClaims, header: Record<string, unknown> = {}): string {
  const iat = claims.iat ?? Math.floor(Date.now() / 1000);
  return signJws(signer, { typ: OWNER_APPROVAL_HEADER_TYP, ...header }, { typ: OWNER_APPROVAL_TYP, jti: randomUUID(), ...claims, iat, exp: claims.exp ?? iat + 120 });
}

/** A claim binding with the alpha.7 owner pin, as `claim.store.read()` will return it. */
export function seededPin(binding: Partial<OwnerClaimBinding> & Pick<OwnerClaimBinding, "portalIssuer">): OwnerPinSource & { current: OwnerClaimBinding } {
  const source = {
    current: { instanceId: "instance-1", ownerSubject: "tealbrick-user:owner-1", ownerPinnedAt: Date.now(), ...binding } as OwnerClaimBinding,
    read: () => source.current,
  };
  return source;
}

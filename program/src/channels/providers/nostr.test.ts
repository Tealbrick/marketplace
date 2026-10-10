import { createHash } from "node:crypto";

import { nostrEventId, nostrSignatureValid } from "@tealbrick/contract/nostr-approval";
import { describe, expect, it } from "vitest";

import { signAuthTag } from "./buzz-test-relay.js";
import {
  NIP_OA_MAX_LIFETIME_SECONDS,
  authEvent,
  authPreimage,
  authTagAllows,
  blossomUploadAuthorization,
  generateSecretKey,
  nip98Authorization,
  npubEncode,
  parseAuthConditions,
  parsePubkey,
  publicKeyOf,
  signEvent,
  verifyAuthTag,
  verifyEvent,
} from "./nostr.js";

// NIP-OA test vector (docs/nips/NIP-OA.md in block/buzz): owner secret 1, agent secret 2.
const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const AGENT_SECRET = "0000000000000000000000000000000000000000000000000000000000000002";
const AGENT = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const VECTOR_TAG = [
  "auth",
  OWNER,
  "kind=1&created_at<1713957000",
  "8b7df2575caf0a108374f8471722b233c53f9ff827a8b0f91861966c3b9dd5cb2e189eae9f49d72187674c2f5bd244145e10ff86c9f257ffe65a1ee5f108b369",
];
const VECTOR_NOW = 1713956400;
const NOW = 1_790_000_000;

describe("nostr keys and events", () => {
  it("derives the NIP-OA vector public keys and encodes npub (NIP-19 example)", () => {
    expect(publicKeyOf(OWNER_SECRET)).toBe(OWNER);
    expect(publicKeyOf(AGENT_SECRET)).toBe(AGENT);
    expect(npubEncode("7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e")).toBe("npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg");
    expect(parsePubkey("npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg")).toBe("7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e");
    expect(parsePubkey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5")).toBeNull();
    expect(publicKeyOf("00".repeat(32))).toBeNull();
  });

  it("generates distinct valid keys and signs events whose id and signature verify with the contract helpers", () => {
    const one = generateSecretKey();
    const two = generateSecretKey();
    expect(one).not.toBe(two);
    const event = signEvent(one, { kind: 9, created_at: NOW, tags: [["h", "00000000-0000-4000-8000-000000000000"]], content: "hello\nworld \"quoted\"" });
    expect(event.pubkey).toBe(publicKeyOf(one));
    expect(nostrEventId(event)).toBe(event.id);
    expect(nostrSignatureValid(event)).toBe(true);
    expect(verifyEvent(event)).toBe(true);
    expect(verifyEvent({ ...event, content: "tampered" })).toBe(false);
    expect(verifyEvent({ ...event, sig: "0".repeat(128) })).toBe(false);
    expect(JSON.stringify(event)).not.toContain(one);
  });
});

describe("NIP-OA owner attestation", () => {
  it("verifies the spec test vector (preimage, SHA-256 and BIP-340 signature)", () => {
    expect(authPreimage(AGENT, "kind=1&created_at<1713957000")).toBe(
      "nostr:agent-auth:c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5:kind=1&created_at<1713957000",
    );
    expect(createHash("sha256").update(authPreimage(AGENT, "kind=1&created_at<1713957000")).digest("hex")).toBe(
      "08cdecd55af4c28d3801fd69615dcf5cc04fab3bc134b38a840bf157197069a6",
    );
    const checked = verifyAuthTag({ tag: VECTOR_TAG, agentPubkey: AGENT, nowSeconds: VECTOR_NOW });
    expect(checked).toMatchObject({ ok: true, value: { ownerPubkey: OWNER, expiresAt: 1713957000, parsed: { kinds: [1], before: 1713957000 } } });
    // Accepted from the pasted JSON string too.
    expect(verifyAuthTag({ tag: JSON.stringify(VECTOR_TAG), agentPubkey: AGENT, nowSeconds: VECTOR_NOW }).ok).toBe(true);
  });

  it("accepts a good tag and refuses wrong owner, expired, over 90 days, bad signature and wrong agent", () => {
    const end = NOW + 30 * 86_400;
    const good = signAuthTag(OWNER_SECRET, AGENT, `created_at<${end}`);
    expect(verifyAuthTag({ tag: good, agentPubkey: AGENT, pinnedOwner: OWNER, nowSeconds: NOW })).toMatchObject({ ok: true, value: { expiresAt: end } });
    const otherOwner = "ff".repeat(32).slice(0, 62) + "01";
    expect(verifyAuthTag({ tag: good, agentPubkey: AGENT, pinnedOwner: otherOwner, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_wrong_owner" });
    expect(verifyAuthTag({ tag: good, agentPubkey: AGENT, nowSeconds: end })).toEqual({ ok: false, reason: "auth_tag_expired" });
    const tooLong = signAuthTag(OWNER_SECRET, AGENT, `created_at<${NOW + NIP_OA_MAX_LIFETIME_SECONDS + 1}`);
    expect(verifyAuthTag({ tag: tooLong, agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_too_long" });
    const exactly90 = signAuthTag(OWNER_SECRET, AGENT, `created_at<${NOW + NIP_OA_MAX_LIFETIME_SECONDS}`);
    expect(verifyAuthTag({ tag: exactly90, agentPubkey: AGENT, nowSeconds: NOW }).ok).toBe(true);
    const badSig = [...good];
    badSig[3] = `${good[3]!.slice(0, 127)}${good[3]!.endsWith("0") ? "1" : "0"}`;
    expect(verifyAuthTag({ tag: badSig, agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_signature_invalid" });
    const forOtherAgent = signAuthTag(OWNER_SECRET, publicKeyOf(generateSecretKey())!, `created_at<${end}`);
    expect(verifyAuthTag({ tag: forOtherAgent, agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_signature_invalid" });
  });

  it("refuses a missing end date, self-attestation, malformed tags and conditions, and unsatisfiable kinds", () => {
    expect(verifyAuthTag({ tag: signAuthTag(OWNER_SECRET, AGENT, "kind=9"), agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_end_missing" });
    expect(verifyAuthTag({ tag: signAuthTag(AGENT_SECRET, AGENT, `created_at<${NOW + 100}`), agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_self_attested" });
    expect(verifyAuthTag({ tag: ["auth", OWNER, "x"], agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_malformed" });
    expect(verifyAuthTag({ tag: "not json", agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_malformed" });
    expect(verifyAuthTag({ tag: ["auth", OWNER.toUpperCase(), "", "a".repeat(128)], agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_malformed" });
    for (const conditions of ["kind=1&", "kind=01", "&kind=1", "kind=1&&kind=2", "kind = 1", "kind=70000", "created_at<4294967296", "foo=1"]) {
      expect(parseAuthConditions(conditions), conditions).toBeNull();
      expect(verifyAuthTag({ tag: ["auth", OWNER, conditions, "a".repeat(128)], agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_conditions_invalid" });
    }
    const twoKinds = signAuthTag(OWNER_SECRET, AGENT, `kind=9&kind=7&created_at<${NOW + 100}`);
    expect(verifyAuthTag({ tag: twoKinds, agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_kinds_unsatisfiable" });
    const later = signAuthTag(OWNER_SECRET, AGENT, `created_at>${NOW + 10}&created_at<${NOW + 100}`);
    expect(verifyAuthTag({ tag: later, agentPubkey: AGENT, nowSeconds: NOW })).toEqual({ ok: false, reason: "auth_tag_not_yet_valid" });
  });

  it("evaluates event conditions: kind and the created_at window", () => {
    const parsed = parseAuthConditions(`kind=9&created_at<${NOW + 100}`)!;
    expect(authTagAllows(parsed, 9, NOW)).toBe(true);
    expect(authTagAllows(parsed, 7, NOW)).toBe(false);
    expect(authTagAllows(parsed, 9, NOW + 100)).toBe(false);
    expect(authTagAllows(parseAuthConditions(`created_at<${NOW + 100}`)!, 40003, NOW)).toBe(true);
  });
});

describe("HTTP and relay auth events", () => {
  it("builds a NIP-98 header: kind 27235, exact u, method, nonce, payload hash, valid signature", () => {
    const secret = generateSecretKey();
    const body = JSON.stringify([{ kinds: [0] }]);
    const header = nip98Authorization(secret, { url: "https://relay.buzz.test/query", method: "post", body, nowSeconds: NOW });
    expect(header.startsWith("Nostr ")).toBe(true);
    const event = JSON.parse(Buffer.from(header.slice(6), "base64").toString("utf8"));
    expect(verifyEvent(event)).toBe(true);
    expect(event).toMatchObject({ kind: 27235, created_at: NOW, content: "", pubkey: publicKeyOf(secret) });
    expect(event.tags[0]).toEqual(["u", "https://relay.buzz.test/query"]);
    expect(event.tags[1]).toEqual(["method", "POST"]);
    expect(event.tags[2][0]).toBe("nonce");
    expect(event.tags[3]).toEqual(["payload", createHash("sha256").update(body).digest("hex")]);
    const second = JSON.parse(Buffer.from(nip98Authorization(secret, { url: "https://relay.buzz.test/query", method: "POST", body, nowSeconds: NOW }).slice(6), "base64").toString("utf8"));
    expect(second.id).not.toBe(event.id);
    expect(header).not.toContain(secret);
  });

  it("builds Blossom upload auth (base64url, kind 24242) and the NIP-42 AUTH event with the owner tag", () => {
    const secret = generateSecretKey();
    const sha = "ab".repeat(32);
    const header = blossomUploadAuthorization(secret, { sha256: sha, server: "relay.buzz.test", nowSeconds: NOW, ttlSeconds: 600 });
    expect(header).not.toMatch(/[+/=]/u);
    const upload = JSON.parse(Buffer.from(header.slice(6), "base64url").toString("utf8"));
    expect(verifyEvent(upload)).toBe(true);
    expect(upload.tags).toEqual([["t", "upload"], ["x", sha], ["expiration", String(NOW + 600)], ["server", "relay.buzz.test"]]);
    const tag = signAuthTag(OWNER_SECRET, publicKeyOf(secret)!, `created_at<${NOW + 100}`);
    const auth = authEvent(secret, { relayUrl: "wss://relay.buzz.test", challenge: "c-1", authTag: tag, nowSeconds: NOW });
    expect(verifyEvent(auth)).toBe(true);
    expect(auth.kind).toBe(22242);
    expect(auth.tags).toEqual([["relay", "wss://relay.buzz.test"], ["challenge", "c-1"], tag]);
  });
});

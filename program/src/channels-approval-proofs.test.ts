import { afterEach, describe, expect, it } from "vitest";

import {
  appHoldOf,
  approvalPendingSchema,
  generateEmergencyCode,
  harnessDefersToApp,
  nostrSignatureValid,
  parseApprovalPending,
  payloadViewSchema,
} from "@tealbrick/contract";

import { nostrKey, ownerAssertion, portalSigner, seededPin, signedApproval, signJws, type NostrKey, type OwnerAssertionClaims, type PortalSigner } from "./channels/approval-test-support.js";
import { GRANT_ALL, PORTAL, SERVICE, TENANT, channelFixture, type ChannelFixture } from "./channels/app-fixture.js";
import { ownerKeyFingerprint, parseOwnerNostrPubkey } from "./channels/owner-key.js";
import type { OwnerClaimBinding, OwnerPinSource } from "./channels/owner-pin.js";
import { MARKETPLACE_MANIFEST } from "./contract.js";
import { MarketplaceOperatorSessionManager } from "./operator-auth.js";

/**
 * K1 owner approval proofs end to end with the REAL contract verifiers (Channels spec §6.3): locally signed
 * BIP-340 Buzz replies and locally minted Ed25519 PO3 assertions, the owner Buzz key setting and its pins.
 * No network: the grant JWKS is served by the fixture's fake Portal fetch.
 */

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

const ORIGIN = "https://marketplace.fixture.invalid";
/** A browser origin the test environment allows for operator mutations. */
const BROWSER = "http://localhost:5173";
const CHANNEL = "6f9c2a1e-4b7d-4c3a-9e2f-0a1b2c3d4e5f";
const OTHER_CHANNEL = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const JWKS_PATH = "/api/grant-jwks";
const OWNER = nostrKey("owner-buzz-key");
const OTHER = nostrKey("someone-else");

let counter = 0;
const key = () => `proof-key-${String(++counter).padStart(6, "0")}`;
const ticket = () => `${String(++counter).padStart(6, "0")}${"t".repeat(37)}`;

type SetupOptions = { pin?: OwnerPinSource | null; signer?: PortalSigner; approvalTrusted?: boolean; options?: Record<string, unknown>; environment?: Record<string, string>; channel?: boolean };

async function setup(input: SetupOptions = {}) {
  const signer = input.signer ?? portalSigner();
  const pin = input.pin === null ? undefined : (input.pin ?? seededPin({ portalIssuer: PORTAL, jwksUri: `${PORTAL}${JWKS_PATH}`, grantKids: [signer.kid] }));
  const f = await channelFixture({
    ...(input.approvalTrusted !== undefined ? { approvalTrusted: input.approvalTrusted } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    options: { ...(pin ? { ownerPinSource: pin } : {}), ...(input.options ?? {}) },
  });
  fixtures.push(f);
  let jwksFetches = 0;
  f.portalReplies.set(JWKS_PATH, () => {
    jwksFetches += 1;
    return new Response(JSON.stringify({ keys: [signer.jwk] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  f.portalReplies.set("/api/deployment-browser/redeem", () =>
    new Response(
      JSON.stringify({
        schema: 1,
        authorized: true,
        product: "marketplace",
        deploymentId: "deployment-1",
        workspaceId: TENANT,
        orgId: "portal-org-1",
        productTenantId: TENANT,
        userId: "owner-1",
        endpoint: ORIGIN,
        session: "s".repeat(43),
        expiresAt: Date.now() + 3_600_000,
      }),
      { status: 200 },
    ),
  );
  const channel = input.channel === false ? null! : await f.createChannel({ slug: "community" });
  if (channel) f.consentFor("agent-1", channel);

  /** The owner's own Marketplace session, opened by a real Portal launch ticket (cookie + CSRF). */
  const ownerLogin = async () => {
    const launched = await f.app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: { origin: PORTAL, "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${ticket()}`,
    });
    expect(launched.statusCode, launched.body).toBe(303);
    const cookie = String(launched.headers["set-cookie"]).split(";", 1)[0]!;
    const session = await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session", headers: { cookie } });
    return { cookie, csrf: session.json().session.csrfToken as string };
  };
  const putKey = (pubkey: string, headers: Record<string, string>) =>
    f.app.inject({ method: "PUT", url: "/api/marketplace/approvals/owner-key", headers: { origin: BROWSER, ...headers }, payload: { pubkey } });
  const setKey = async (pubkey: string) => {
    const { cookie, csrf } = await ownerLogin();
    const response = await putKey(pubkey, { cookie, "x-csrf-token": csrf });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };
  const hold = async (text = "Held for a signed approval") => {
    const held = await f.post(channel.id, { text }, key());
    expect(held.statusCode, held.body).toBe(202);
    return { approvalId: held.json().approvalId as string, digest: held.json().digest as string, postId: held.headers["tealbrick-post-id"] as string, body: held.json() };
  };
  const resolve = (approvalId: string, proof: Record<string, unknown>, decision: "approve" | "deny" = "approve") =>
    f.agent("POST", `/api/marketplace/v1/agent/approvals/${approvalId}/resolve`, { key: `resolve.${approvalId}.${decision}`, payload: { approvalId, proof } });
  const nostr = (approvalId: string, event: unknown, forwardedChannel = CHANNEL) => resolve(approvalId, { proof: "nostr", event, channel: forwardedChannel });
  const claims = (held: { approvalId: string; digest: string }, extra: Partial<OwnerAssertionClaims> = {}): OwnerAssertionClaims => ({
    iss: PORTAL,
    sub: "tealbrick-user:owner-1",
    aud: "tealbrick-app:instance-1",
    dep: "deployment-1",
    approvalId: held.approvalId,
    digest: held.digest,
    decision: "approve",
    op: "marketplace.channels.post",
    agent: "tealbrick-agent:agent-1",
    amr: ["passkey"],
    device: "Martin's Mac",
    ...extra,
  });
  const portal = (held: { approvalId: string; digest: string }, extra: Partial<OwnerAssertionClaims> = {}, decision: "approve" | "deny" = "approve") =>
    resolve(held.approvalId, { proof: "portal", token: ownerAssertion(signer, claims(held, { decision, ...extra })) }, decision);
  const state = (approvalId: string) => f.store.getCompanyBoxApproval(approvalId)!.state;
  const audit = () => f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }) as Array<{ event_type: string; actor_id: string | null; metadata: string }>;
  return { f, signer, pin, channel, ownerLogin, putKey, setKey, hold, resolve, nostr, portal, claims, state, audit, jwksFetches: () => jwksFetches };
}

const approve = (held: { digest: string }, k: NostrKey = OWNER, extra: Partial<Parameters<typeof signedApproval>[0]> = {}) =>
  signedApproval({ key: k, channel: CHANNEL, digest: held.digest, ...extra });

describe("test support", () => {
  it("signs BIP-340 events the contract accepts", () => {
    const event = signedApproval({ key: OWNER, channel: CHANNEL, digest: "a".repeat(64) });
    expect(nostrSignatureValid(event)).toBe(true);
    expect(nostrSignatureValid({ ...event, sig: signedApproval({ key: OTHER, channel: CHANNEL, digest: "a".repeat(64) }).sig })).toBe(false);
  });
});

describe("proof: nostr (verifyNostrApprovalProof)", () => {
  it("approves with the owner's signed reply in the forwarded channel and sends once", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    const held = await t.hold();
    const ok = await t.nostr(held.approvalId, approve(held));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ decision: "approve", receipt: { status: "sent", digest: held.digest } });
    expect(t.f.telegram.sends).toHaveLength(1);
    expect(t.f.store.getCompanyBoxApproval(held.approvalId)!.decidedBy).toBe(`owner-nostr:${ownerKeyFingerprint(OWNER.pubkey)}`);
  });

  it("refuses a reply whose h tag is not the forwarded channel", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    const held = await t.hold();
    const refused = await t.nostr(held.approvalId, approve(held), OTHER_CHANNEL);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "approval_proof_invalid", reason: "wrong_channel" });
    expect(t.state(held.approvalId)).toBe("pending");
    expect(t.f.telegram.sends).toHaveLength(0);
  });

  it("refuses a reply signed by a foreign key", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    const held = await t.hold();
    const refused = await t.nostr(held.approvalId, approve(held, OTHER));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "approval_proof_invalid", reason: "wrong_owner" });
    expect(t.state(held.approvalId)).toBe("pending");
  });

  it("refuses a stale reply (> 15 minutes)", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    const held = await t.hold();
    const refused = await t.nostr(held.approvalId, approve(held, OWNER, { createdAt: Math.floor(Date.now() / 1000) - 16 * 60 }));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ reason: "stale" });
  });

  it("refuses a digest prefix of another call", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    const held = await t.hold();
    const wrong = `${held.digest[0] === "0" ? "1" : "0"}${held.digest.slice(1, 12)}`;
    const refused = await t.nostr(held.approvalId, approve(held, OWNER, { content: `approve ${wrong}` }));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ reason: "wrong_digest" });
    expect(t.state(held.approvalId)).toBe("pending");
  });

  it("uses an event id once, instance-wide", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    // Same text, same channel: two holds with the same digest; one owner event approves only one of them.
    const first = await t.hold("Same text twice");
    const second = await t.hold("Same text twice");
    expect(second.digest).toBe(first.digest);
    const event = approve(first);
    expect((await t.nostr(first.approvalId, event)).statusCode).toBe(200);
    const reused = await t.nostr(second.approvalId, event);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: "approval_proof_reused" });
    expect(t.state(second.approvalId)).toBe("pending");
    expect(t.f.telegram.sends).toHaveLength(1);
  });

  it("refuses when no owner key is set, and for a hold made before the key was set", async () => {
    const t = await setup();
    const before = await t.hold();
    const unbound = await t.nostr(before.approvalId, approve(before));
    expect(unbound.statusCode).toBe(503);
    expect(unbound.json()).toMatchObject({ error: "approval_owner_unbound" });
    await t.setKey(OWNER.pubkey);
    const unpinned = await t.nostr(before.approvalId, approve(before));
    expect(unpinned.statusCode).toBe(409);
    expect(unpinned.json()).toMatchObject({ error: "approval_owner_key_changed" });
    expect(t.state(before.approvalId)).toBe("pending");
  });
});

describe("owner key change (§6.3 key v1 conditions)", () => {
  it("invalidates pending holds of the old key, audits old/new fingerprints, and kills unused old-key proofs", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    const held = await t.hold();
    const oldProof = approve(held, OWNER, { createdAt: Math.floor(Date.now() / 1000) - 5 });
    const changed = await t.setKey(OTHER.pubkey);
    expect(changed).toMatchObject({ changed: true, invalidatedHolds: 1, ownerKey: { fingerprint: ownerKeyFingerprint(OTHER.pubkey) } });
    expect(JSON.stringify(changed)).not.toContain(OTHER.pubkey);
    // Neither the old key's proof nor the new key's reply approves a hold made under the old key.
    for (const event of [oldProof, approve(held, OTHER)]) {
      const refused = await t.nostr(held.approvalId, event);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ error: "approval_owner_key_changed" });
    }
    expect(t.state(held.approvalId)).toBe("pending");
    const view = await t.f.owner("GET", `/api/marketplace/company-box/approvals/${held.approvalId}`);
    expect(view.json().approval.ownerKey).toEqual({ fingerprint: ownerKeyFingerprint(OWNER.pubkey), status: "key_changed" });
    // Back to the first key: a re-request is pinned again, but the proof signed before the change stays dead.
    await t.setKey(OWNER.pubkey);
    const again = await t.hold();
    expect(again.digest).toBe(held.digest);
    const dead = await t.nostr(again.approvalId, oldProof);
    expect(dead.statusCode).toBe(403);
    expect(dead.json()).toMatchObject({ reason: "key_changed" });
    expect((await t.nostr(again.approvalId, approve(again))).statusCode).toBe(200);
    // The owner UI still approves the invalidated hold.
    const owner = await t.f.owner("POST", `/api/marketplace/company-box/approvals/${held.approvalId}/approve`, {});
    expect(owner.json()).toMatchObject({ approval: { state: "succeeded" } });
    const changes = t.audit().filter((row) => row.event_type === "marketplace.approvals.owner_key.changed").map((row) => ({ actor: row.actor_id, ...JSON.parse(row.metadata) }));
    expect(changes.map(({ change, oldFingerprint, newFingerprint, actor }) => ({ change, oldFingerprint, newFingerprint, actor })).reverse()).toEqual([
      { change: "set", oldFingerprint: null, newFingerprint: ownerKeyFingerprint(OWNER.pubkey), actor: "operator:owner-1" },
      { change: "change", oldFingerprint: ownerKeyFingerprint(OWNER.pubkey), newFingerprint: ownerKeyFingerprint(OTHER.pubkey), actor: "operator:owner-1" },
      { change: "change", oldFingerprint: ownerKeyFingerprint(OTHER.pubkey), newFingerprint: ownerKeyFingerprint(OWNER.pubkey), actor: "operator:owner-1" },
    ]);
    expect(changes.every((row) => typeof row.at === "string")).toBe(true);
    const all = JSON.stringify(t.audit());
    expect(all).not.toContain(OWNER.pubkey);
    expect(all).not.toContain(OTHER.pubkey);
  });

  it("clears the key (audited) and then refuses Buzz proofs as unbound", async () => {
    const t = await setup();
    await t.setKey(OWNER.pubkey);
    const held = await t.hold();
    const { cookie, csrf } = await t.ownerLogin();
    const cleared = await t.f.app.inject({ method: "DELETE", url: "/api/marketplace/approvals/owner-key", headers: { origin: BROWSER, cookie, "x-csrf-token": csrf } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ changed: true, invalidatedHolds: 1, ownerKey: { fingerprint: null, ownerKeyStatus: "unset" } });
    const refused = await t.nostr(held.approvalId, approve(held));
    expect(refused.json()).toMatchObject({ error: "approval_owner_unbound" });
    const last = t.audit().find((row) => row.event_type === "marketplace.approvals.owner_key.changed")!;
    expect(JSON.parse(last.metadata)).toMatchObject({ change: "clear", oldFingerprint: ownerKeyFingerprint(OWNER.pubkey), newFingerprint: null });
  });
});

describe("owner key setting: owner launch session only", () => {
  it("refuses agents, the service bearer, the settings relay, the emergency and access-token sessions, the test bypass and a missing CSRF token", async () => {
    const CODE = generateEmergencyCode();
    const t = await setup({
      environment: { TEALBRICK_EMERGENCY_CODE: CODE },
      options: { operatorSessionManager: new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234", operatorId: "operator-1", organizationId: TENANT }) },
      channel: false,
    });
    const refusals: Array<[string, Record<string, string>]> = [];
    refusals.push(["agent tbag_ grant", { authorization: `Bearer ${GRANT_ALL}` }]);
    refusals.push(["service bearer", { authorization: `Bearer ${SERVICE}` }]);
    const relay = await t.f.app.inject({ method: "POST", url: "/auth/launch", headers: { "content-type": "application/json" }, payload: { ticket: ticket(), purpose: "settings" } });
    expect(relay.statusCode, relay.body).toBe(200);
    refusals.push(["settings relay bearer", { authorization: `Bearer ${relay.json().settingsBearer as string}` }]);
    const emergency = await t.f.app.inject({ method: "POST", url: "/auth/emergency", headers: { "content-type": "application/json", accept: "application/json" }, payload: { code: CODE } });
    expect(emergency.statusCode).toBe(200);
    refusals.push(["emergency bearer", { authorization: `Bearer ${(emergency.json() as { sessionToken: string }).sessionToken}` }]);
    const unlocked = t.f.operatorSessions.exchange("marketplace-operator-token-1234", "test-client");
    refusals.push(["operator access-token session", { cookie: `dg_marketplace_operator_session=${unlocked.token}`, "x-csrf-token": unlocked.status.csrfToken! }]);
    const owner = await t.ownerLogin();
    refusals.push(["owner session without CSRF", { cookie: owner.cookie }]);
    refusals.push(["owner session with a wrong CSRF", { cookie: owner.cookie, "x-csrf-token": "x".repeat(32) }]);
    for (const [label, headers] of refusals) {
      const response = await t.putKey(OWNER.pubkey, headers);
      expect(response.statusCode, `${label}: ${response.body}`).toBeGreaterThanOrEqual(401);
      expect(response.statusCode, label).toBeLessThan(404);
    }
    expect(t.f.store.channels.getOwnerKey(TENANT)).toBeNull();
    expect((await t.putKey(OWNER.pubkey, { cookie: owner.cookie, "x-csrf-token": owner.csrf })).statusCode).toBe(200);
    expect(t.f.store.channels.getOwnerKey(TENANT)?.pubkey).toBe(OWNER.pubkey);
  });

  it("refuses the test bypass (no launch session) and a launch user who is not the pinned owner", async () => {
    const t = await setup();
    const bypass = await t.putKey(OWNER.pubkey, {});
    expect(bypass.statusCode).toBe(403);
    expect(bypass.json()).toMatchObject({ error: "owner_session_required" });
    const signer = portalSigner();
    const notOwner = await setup({ signer, pin: seededPin({ portalIssuer: PORTAL, jwksUri: `${PORTAL}${JWKS_PATH}`, grantKids: [signer.kid], ownerSubject: "tealbrick-user:someone-else" }) });
    const session = await notOwner.ownerLogin();
    const refused = await notOwner.putKey(OWNER.pubkey, { cookie: session.cookie, "x-csrf-token": session.csrf });
    expect(refused.statusCode).toBe(403);
  });

  it("is not a manifest setting: Portal's settings relay cannot write it", async () => {
    const fields = MARKETPLACE_MANIFEST.settings?.groups.flatMap((group) => group.fields.map((field) => field.key)) ?? [];
    expect(fields).not.toContain("approvals.ownerNostrPubkey");
    const t = await setup();
    const relay = await t.f.app.inject({ method: "POST", url: "/auth/launch", headers: { "content-type": "application/json" }, payload: { ticket: ticket(), purpose: "settings" } });
    const write = await t.f.app.inject({
      method: "PUT",
      url: "/.well-known/tealbrick/settings",
      headers: { authorization: `Bearer ${relay.json().settingsBearer as string}` },
      payload: { values: { "approvals.ownerNostrPubkey": OWNER.pubkey } },
    });
    expect(write.statusCode).toBeGreaterThanOrEqual(400);
    expect(t.f.store.channels.getOwnerKey(TENANT)).toBeNull();
  });

  it("accepts 64 hex (normalised lowercase) or npub1; refuses nsec, bad checksums, whitespace and free text", async () => {
    // NIP-19 test vectors.
    expect(parseOwnerNostrPubkey("npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg")).toEqual({ ok: true, pubkey: "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e" });
    expect(parseOwnerNostrPubkey("7E7E9C42A91BFEF19FA929E5FDA1B72E0EBC1A4C1141673E2794234D86ADDF4E")).toEqual({ ok: true, pubkey: "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e" });
    for (const bad of [
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
      "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjpth",
      "NPUB10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg",
      ` ${"a".repeat(64)}`,
      `${"a".repeat(32)} ${"a".repeat(31)}`,
      "a".repeat(63),
      "a".repeat(65),
      "my owner key please",
      "",
    ]) {
      expect(parseOwnerNostrPubkey(bad), bad).toEqual({ ok: false, error: "owner_key_invalid" });
    }
    const t = await setup();
    const { cookie, csrf } = await t.ownerLogin();
    const refused = await t.putKey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5", { cookie, "x-csrf-token": csrf });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "owner_key_invalid" });
    const accepted = await t.putKey("npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg", { cookie, "x-csrf-token": csrf });
    expect(accepted.json().ownerKey).toMatchObject({ fingerprint: ownerKeyFingerprint("7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e") });
    expect(accepted.json().ownerKey.fingerprint).toHaveLength(16);
    expect(accepted.body).not.toContain("7e7e9c42");
  });
});

describe("owner key trust source (Portal v2 attestation)", () => {
  const pinWith = (signer: PortalSigner, ownerNostrPubkey?: string): OwnerPinSource & { current: OwnerClaimBinding } =>
    seededPin({ portalIssuer: PORTAL, jwksUri: `${PORTAL}${JWKS_PATH}`, grantKids: [signer.kid], ...(ownerNostrPubkey ? { ownerNostrPubkey } : {}) });

  it("owner-session today; portal-attested when the attestation matches; mismatch refuses Buzz proofs", async () => {
    const plain = await setup();
    await plain.setKey(OWNER.pubkey);
    const view = (t: Awaited<ReturnType<typeof setup>>) => t.f.owner("GET", "/api/marketplace/company-box/approvals").then((response) => response.json().ownerKey);
    expect(await view(plain)).toMatchObject({ fingerprint: ownerKeyFingerprint(OWNER.pubkey), ownerKeySource: "owner-session", ownerKeyStatus: "ok" });

    const signer = portalSigner();
    const attested = await setup({ signer, pin: pinWith(signer, OWNER.pubkey.toUpperCase()) });
    await attested.setKey(OWNER.pubkey);
    expect(await view(attested)).toMatchObject({ ownerKeySource: "portal-attested", ownerKeyStatus: "ok" });
    const held = await attested.hold();
    expect((await attested.nostr(held.approvalId, approve(held))).statusCode).toBe(200);

    const other = portalSigner();
    const mismatch = await setup({ signer: other, pin: pinWith(other, OTHER.pubkey) });
    await mismatch.setKey(OWNER.pubkey);
    const status = await mismatch.f.owner("GET", "/api/marketplace/approvals/owner-key");
    expect(status.json().ownerKey).toMatchObject({ ownerKeySource: "owner-session", ownerKeyStatus: "mismatch", attestedFingerprint: ownerKeyFingerprint(OTHER.pubkey) });
    const mismatchHold = await mismatch.hold();
    const refused = await mismatch.nostr(mismatchHold.approvalId, approve(mismatchHold));
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: "approval_owner_key_mismatch" });
    expect(mismatch.state(mismatchHold.approvalId)).toBe("pending");
    expect(mismatch.f.telegram.sends).toHaveLength(0);
  });
});

describe("proof: portal (verifyOwnerApprovalAssertion)", () => {
  it("approves with a Portal owner assertion and stores amr/device on the approval", async () => {
    const t = await setup();
    const held = await t.hold();
    const ok = await t.portal(held);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(t.f.telegram.sends).toHaveLength(1);
    const view = await t.f.owner("GET", `/api/marketplace/company-box/approvals/${held.approvalId}`);
    expect(view.json().approval).toMatchObject({ decidedBy: "owner:owner-1", proof: { kind: "portal", amr: ["passkey"], device: "Martin's Mac" } });
    expect(t.jwksFetches()).toBe(1);
  });

  it("refuses an L2 grant JWT (type separation)", async () => {
    const t = await setup();
    const held = await t.hold();
    const grantJwt = signJws(t.signer, { typ: "JWT" }, { ...t.claims(held), typ: "tealbrick-app-grant", jti: "grant-jti-1", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120 });
    const refused = await t.resolve(held.approvalId, { proof: "portal", token: grantJwt });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "approval_proof_invalid", reason: "wrong_header_type" });
    // Right header, wrong payload typ.
    const payloadTyp = signJws(t.signer, { typ: "tealbrick-owner-approval+jwt" }, { ...t.claims(held), typ: "tealbrick-app-grant", jti: "grant-jti-2", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120 });
    expect((await t.resolve(held.approvalId, { proof: "portal", token: payloadTyp })).json()).toMatchObject({ reason: "wrong_type" });
    expect(t.state(held.approvalId)).toBe("pending");
  });

  it("refuses wrong aud, dep, sub, digest, operation and agent, and an expired assertion", async () => {
    const t = await setup();
    const held = await t.hold();
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[Partial<OwnerAssertionClaims>, string]> = [
      [{ aud: "tealbrick-app:another-instance" }, "wrong_audience"],
      [{ dep: "deployment-2" }, "wrong_deployment"],
      [{ sub: "tealbrick-user:someone-else" }, "wrong_subject"],
      [{ digest: "0".repeat(64) }, "wrong_digest"],
      [{ op: "marketplace.channels.schedule" }, "wrong_operation"],
      [{ agent: "tealbrick-agent:agent-2" }, "wrong_agent"],
      [{ iat: now - 400, exp: now - 200 }, "expired"],
    ];
    for (const [extra, reason] of cases) {
      const refused = await t.portal(held, extra);
      expect(refused.statusCode, reason).toBe(403);
      expect(refused.json(), reason).toMatchObject({ error: "approval_proof_invalid", reason });
    }
    expect(t.state(held.approvalId)).toBe("pending");
    expect(t.f.telegram.sends).toHaveLength(0);
  });

  it("uses a jti once, and a refused token never burns it", async () => {
    const t = await setup();
    const first = await t.hold("First");
    const second = await t.hold("Second");
    // Refused (wrong digest) with jti J, then valid with the same J: still accepted.
    expect((await t.portal(first, { jti: "jti-shared-1", digest: second.digest })).statusCode).toBe(403);
    expect((await t.portal(first, { jti: "jti-shared-1" })).statusCode).toBe(200);
    const reused = await t.portal(second, { jti: "jti-shared-1" });
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ error: "approval_proof_reused" });
    expect(t.state(second.approvalId)).toBe("pending");
  });

  it("a signed deny skips the post with no provider call", async () => {
    const t = await setup();
    const held = await t.hold();
    const denied = await t.portal(held, {}, "deny");
    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.json()).toMatchObject({ decision: "deny", status: "denied" });
    expect(t.f.store.channels.getPost(TENANT, held.postId)).toMatchObject({ status: "skipped", reason: "approval_denied" });
    expect(t.f.telegram.sends).toHaveLength(0);
  });

  it("two concurrent valid resolves: one provider call, one 409", async () => {
    const t = await setup();
    const held = await t.hold();
    const answers = await Promise.all([t.portal(held), t.portal(held), t.portal(held)]);
    // Exactly one resolve runs the call; the others are 409 approval_already_resolved or, once it finished,
    // the replay of the stored answer under the same `resolve.<approvalId>.approve` key.
    const winners = answers.filter((answer) => answer.statusCode === 200 && answer.json().replayed !== true);
    expect(winners).toHaveLength(1);
    for (const answer of answers.filter((entry) => !winners.includes(entry))) {
      if (answer.statusCode === 409) expect(answer.json()).toMatchObject({ error: "approval_already_resolved" });
      else expect(answer.json()).toMatchObject({ replayed: true });
    }
    expect(t.f.telegram.sends).toHaveLength(1);
  });

  it("answers approval_owner_unbound when nothing is pinned (today's legacy claim path)", async () => {
    const t = await setup({ pin: null });
    const held = await t.hold();
    const refused = await t.portal(held);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: "approval_owner_unbound" });
    expect(t.state(held.approvalId)).toBe("pending");
    // A binding without ownerSubject (cleared by a newer claim without it) pins nothing either.
    const signer = portalSigner();
    const cleared = await setup({ signer, pin: seededPin({ portalIssuer: PORTAL, jwksUri: `${PORTAL}${JWKS_PATH}`, grantKids: [signer.kid], ownerSubject: null }) });
    const clearedHold = await cleared.hold();
    expect((await cleared.portal(clearedHold)).json()).toMatchObject({ error: "approval_owner_unbound" });
    expect(t.jwksFetches() + cleared.jwksFetches()).toBe(0);
  });
});

describe("K1 202 and app authority", () => {
  it("answers 202 approval_pending in the strict contract shape (immediate and scheduled)", async () => {
    const t = await setup();
    const immediate = await t.hold();
    expect(approvalPendingSchema.safeParse(immediate.body).success).toBe(true);
    expect(payloadViewSchema.safeParse(immediate.body.payloadView).success).toBe(true);
    expect(parseApprovalPending(immediate.body)).toMatchObject({ ok: true });
    expect(Object.keys(immediate.body).sort()).toEqual(["approvalId", "digest", "error", "expiresAt", "payloadView"]);
    const scheduled = await t.f.agent("POST", `/api/marketplace/v1/agent/channels/${t.channel.id}/scheduled`, {
      key: key(),
      payload: { text: "Later", sendAt: new Date(t.f.now + 3_600_000).toISOString() },
    });
    expect(scheduled.statusCode, scheduled.body).toBe(202);
    expect(parseApprovalPending(scheduled.json())).toMatchObject({ ok: true });
    expect(scheduled.headers["tealbrick-post-id"]).toEqual(expect.any(String));
  });

  it("declares app authority on post and schedule; the harness defers only with Portal's trust flag", () => {
    const op = (id: string) => MARKETPLACE_MANIFEST.operations.find((operation) => operation.id === id)!;
    for (const id of ["marketplace.channels.post", "marketplace.channels.schedule"]) {
      expect(op(id)).toMatchObject({ approvalAuthority: "app", appHold: true, effects: "external-effects" });
      expect(appHoldOf(MARKETPLACE_MANIFEST, op(id))).toEqual({ resolveOperation: "marketplace.approvals.resolve" });
    }
    // channels.test is owner audience: the contract refuses app authority there (no harness ever calls it).
    expect(op("marketplace.channels.test").approvalAuthority).toBeUndefined();
    const post = op("marketplace.channels.post");
    const base = { effects: post.effects, approvalAuthority: post.approvalAuthority, appHold: post.appHold, resolveOperation: MARKETPLACE_MANIFEST.approvals?.resolveOperation };
    expect(harnessDefersToApp({ ...base, configTrusted: undefined, grantTrusted: undefined })).toBe(false);
    expect(harnessDefersToApp({ ...base, configTrusted: true, grantTrusted: undefined })).toBe(false);
    expect(harnessDefersToApp({ ...base, configTrusted: true, grantTrusted: false })).toBe(false);
    expect(harnessDefersToApp({ ...base, configTrusted: true, grantTrusted: true })).toBe(true);
    // Without app authority or without external effects the flag changes nothing.
    expect(harnessDefersToApp({ ...base, approvalAuthority: "harness", configTrusted: true, grantTrusted: true })).toBe(false);
    expect(harnessDefersToApp({ ...base, effects: "writes-app-state", configTrusted: true, grantTrusted: true })).toBe(false);
    const owner = op("marketplace.channels.test");
    expect(harnessDefersToApp({ effects: owner.effects, approvalAuthority: owner.approvalAuthority, appHold: owner.appHold, resolveOperation: base.resolveOperation, configTrusted: true, grantTrusted: true })).toBe(false);
  });

  it("holds the same way with or without Portal's approvalTrusted flag (Marketplace never relies on the harness)", async () => {
    for (const approvalTrusted of [undefined, false, true]) {
      const t = await setup(approvalTrusted === undefined ? {} : { approvalTrusted });
      const held = await t.f.post(t.channel.id, { text: "Held either way" }, key());
      expect(held.statusCode, String(approvalTrusted)).toBe(202);
      expect(parseApprovalPending(held.json())).toMatchObject({ ok: true });
      expect(t.f.telegram.sends).toHaveLength(0);
    }
  });
});

import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CONTRACT_VERSION, CONTRACT_VERSION_HEADER, l2GrantOptionsFromClaim } from "@tealbrick/contract";
import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { MARKETPLACE_MANIFEST } from "./contract.js";
import { INSTANCE_CLAIM_IDENTITY_FILE } from "./instance-claim.js";
import { readOwnerPin } from "./channels/owner-pin.js";
import { createFileClaimStore, INSTANCE_CLAIM_BINDING_FILE, MANIFEST_CLAIM_PATH } from "./manifest-claim.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];
const internalToken = "marketplace-internal-secret-fixture";
const proofToken = "p".repeat(43);
const issuer = "https://portal.fixture.invalid";
const companyId = "workspace-community";
const jwksUri = `${issuer}/api/runtime/app-grant/jwks`;
const grantKids = ["grant-key-1", "grant-key-2"];
const LEGACY_CLAIM_PATH = "/api/tealbrick/claim";

async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-manifest-claim-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function build(dataDir: string, overrides: { instanceClaimDir?: string | null; environment?: Record<string, string> } = {}) {
  const store = new SqliteMarketplaceStore(path.join(dataDir, "marketplace.sqlite"));
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: internalToken,
    instanceClaimDir: overrides.instanceClaimDir === null ? undefined : (overrides.instanceClaimDir ?? dataDir),
    environment: overrides.environment ?? {
      MARKETPLACE_ORGANIZATION_ID: companyId,
      MARKETPLACE_PORTAL_URL: issuer,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: proofToken,
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: companyId,
    },
  });
  return {
    app,
    store,
    async close() {
      await app.close();
      store.close();
    },
  };
}

// What Portal Core sends to a manifest app (portal-core #113): the instance credential in
// x-knowledge-instance-token, never Bearer.
const coreHeaders = { "x-knowledge-instance-token": internalToken };
const nonce = () => randomUUID().replaceAll("-", "");
const anchored = (n = nonce()) => ({ portalIssuer: issuer, nonce: n, companyId, jwksUri, grantKids });
const OWNER_SUBJECT = "tealbrick-user:owner-1";
/** What Core sends to a contract ≥ alpha.7 app: the anchored claim plus the owner pin. */
/** `ownerSubject: null` sends none (an ordered clear). */
const owned = (claimIssuedAt: number, ownerSubject: string | null = OWNER_SUBJECT, n = nonce()) => ({
  ...anchored(n),
  ...(ownerSubject !== null ? { ownerSubject } : {}),
  claimIssuedAt,
});

function decode(jwt: string) {
  const [header, payload, signature] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString()),
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature!, "base64url"),
  };
}

function verifies(proof: string, publicJwk: object) {
  const jwt = decode(proof);
  return verify(null, Buffer.from(jwt.signed), createPublicKey({ key: publicJwk as never, format: "jwk" }), jwt.signature);
}

const sha256 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

describe("manifest claim (tealbrick.miniapp/v1) on /.well-known/tealbrick/claim", () => {
  it("(a) GET returns exactly {instanceId, publicJwk} with the instance token and 401 without", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const ok = await app.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const body = ok.json();
    expect(Object.keys(body).sort()).toEqual(["instanceId", "publicJwk"]);
    expect(body.instanceId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(body.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) });

    // Parity with the legacy route: the internal bearer and the Portal instance proof are accepted too.
    for (const headers of [{ authorization: `Bearer ${internalToken}` }, { "x-tealbrick-instance-proof": proofToken }]) {
      const response = await app.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(body);
    }
    const refused = [
      {},
      { "x-knowledge-instance-token": "wrong-token-value" },
      { authorization: "Bearer wrong-token-value" },
      { authorization: `Bearer ${proofToken}` },
      { "x-tealbrick-instance-proof": internalToken },
    ];
    for (const headers of refused) {
      for (const method of ["GET", "POST"] as const) {
        const response = await app.app.inject({ method, url: MANIFEST_CLAIM_PATH, headers, ...(method === "POST" ? { payload: anchored() } : {}) });
        expect(response.statusCode).toBe(401);
        expect(response.body).not.toContain("instanceId");
        expect(response.body).not.toContain("proof");
      }
    }
    expect((await app.app.inject({ method: "HEAD", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).statusCode).toBe(405);
    // Browser sessions, cookies and origins are refused even with a valid credential.
    for (const extra of [{ origin: issuer }, { cookie: "dg_marketplace_operator_session=x" }]) {
      for (const method of ["GET", "POST"] as const) {
        const response = await app.app.inject({ method, url: MANIFEST_CLAIM_PATH, headers: { ...coreHeaders, ...extra }, ...(method === "POST" ? { payload: anchored() } : {}) });
        expect(response.statusCode).toBe(403);
        expect(response.body).not.toContain("proof");
      }
    }
    await app.close();
  });

  it("(b) POST returns only {proof}: an EdDSA JWT with exactly the required claims, aud = issuer, nonce echoed", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const identity = (await app.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).json();
    const challenge = anchored();
    const before = Math.floor(Date.now() / 1000);
    const response = await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: challenge });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(Object.keys(body)).toEqual(["proof"]);
    const jwt = decode(body.proof);
    expect(jwt.header).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(Object.keys(jwt.payload).sort()).toEqual(["aud", "companyId", "exp", "iat", "instanceId", "nonce", "typ", "version"]);
    expect(jwt.payload).toMatchObject({
      typ: "tealbrick-app-claim",
      version: 1,
      aud: issuer,
      nonce: challenge.nonce,
      instanceId: identity.instanceId,
      companyId,
    });
    expect(jwt.payload.iat).toBeGreaterThanOrEqual(before);
    expect(jwt.payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(jwt.payload.exp - jwt.payload.iat).toBe(300);
    expect(verifies(body.proof, identity.publicJwk)).toBe(true);
    expect(verify(null, Buffer.from(`${jwt.signed}x`), createPublicKey({ key: identity.publicJwk, format: "jwk" }), jwt.signature)).toBe(false);

    // Idempotent retry with the same nonce; the same nonce for another body is refused.
    const retry = await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: challenge });
    expect(retry.json()).toEqual(body);

    // Core falls back to an un-anchored claim; it is served too.
    const plain = await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: { portalIssuer: issuer, nonce: nonce(), companyId } });
    expect(plain.statusCode).toBe(200);
    expect(verifies(plain.json().proof, identity.publicJwk)).toBe(true);
    await app.close();
  });

  it("(b) enforces companyId = MARKETPLACE_ORGANIZATION_ID, the configured issuer and the anchor rules", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const post = (payload: unknown) => app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: payload as object });
    const refusals: Array<[unknown, number, string]> = [
      [{ ...anchored(), companyId: "workspace-other" }, 409, "tenant_mismatch"],
      [{ ...anchored(), portalIssuer: "https://other.fixture.invalid", jwksUri: "https://other.fixture.invalid/jwks" }, 403, "issuer_not_allowed"],
      [{ ...anchored(), jwksUri: "https://other.fixture.invalid/jwks" }, 400, "invalid_claim_request"],
      [{ ...anchored(), grantKids: [] }, 400, "invalid_claim_request"],
      [{ portalIssuer: issuer, nonce: nonce(), companyId, grantKids }, 400, "invalid_claim_request"],
      [{ ...anchored(), nonce: "short" }, 400, "invalid_claim_request"],
      [{ ...anchored(), portalIssuer: `${issuer}/` }, 400, "invalid_claim_request"],
      [{ ...anchored(), extra: true }, 400, "invalid_claim_request"],
      [{ portalIssuer: issuer, nonce: nonce() }, 400, "invalid_claim_request"],
    ];
    for (const [payload, status, error] of refusals) {
      const response = await post(payload);
      expect([response.statusCode, response.json().error]).toEqual([status, error]);
      expect(response.body).not.toContain("proof");
    }
    expect(await readdir(dir)).not.toContain(INSTANCE_CLAIM_BINDING_FILE);
    await app.close();
  });

  it("stores the anchors durably the way the kit expects, so L2 grants can be verified against them", async () => {
    const dir = await tempDir();
    const first = await build(dir);
    const identity = (await first.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).json();
    expect((await first.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: anchored() })).statusCode).toBe(200);
    const file = path.join(dir, INSTANCE_CLAIM_BINDING_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = createFileClaimStore(dir).read();
    expect(stored).toMatchObject({ portalIssuer: issuer, tenantId: companyId, instanceId: identity.instanceId, jwksUri, grantKids });
    await first.close();

    // After a restart, a claim without anchors keeps the pinned ones.
    const second = await build(dir);
    expect((await second.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: { portalIssuer: issuer, nonce: nonce(), companyId } })).statusCode).toBe(200);
    const binding = createFileClaimStore(dir).read()!;
    expect(binding).toMatchObject({ jwksUri, grantKids, claimedAt: stored!.claimedAt });
    const l2 = l2GrantOptionsFromClaim(binding, {
      manifest: MARKETPLACE_MANIFEST,
      introspect: { wire: "app-grant-v1", url: `${issuer}/api/runtime/app-grant/introspect`, deploymentId: "deployment-1", product: "marketplace", instanceProof: proofToken, tenantId: companyId },
    } as never);
    expect(l2).toMatchObject({ mode: "l2", issuer, appInstanceId: identity.instanceId, jwks: { url: jwksUri, pinnedKids: grantKids, acceptNewKids: true } });
    await second.close();
  });

  it("fails closed on a malformed binding file and never replaces it", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const file = path.join(dir, INSTANCE_CLAIM_BINDING_FILE);
    await writeFile(file, "{not json", { mode: 0o600 });
    const response = await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: anchored() });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("proof");
    expect(await readFile(file, "utf8")).toBe("{not json");
    await app.close();
  });

  it("answers 503 without an identity directory or without a configured Portal scope", async () => {
    const dir = await tempDir();
    const noIdentity = await build(dir, { instanceClaimDir: null });
    expect((await noIdentity.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH })).statusCode).toBe(401);
    expect((await noIdentity.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).statusCode).toBe(503);
    expect((await noIdentity.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: anchored() })).statusCode).toBe(503);
    await noIdentity.close();

    const unscopedDir = await tempDir();
    const unscoped = await build(unscopedDir, { environment: { MARKETPLACE_PORTAL_URL: issuer } });
    expect((await unscoped.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).statusCode).toBe(200);
    expect((await unscoped.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, payload: anchored() })).statusCode).toBe(401);
    const refused = await unscoped.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: anchored() });
    expect([refused.statusCode, refused.json().error]).toEqual([503, "claim_scope_unconfigured"]);
    await unscoped.close();
  });
});

describe("contract alpha.7: version header and owner pin (ownerSubject)", () => {
  it("GET answers with x-tealbrick-contract = the installed kit version (0.1.0-alpha.8); the legacy GET does not", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    expect(CONTRACT_VERSION_HEADER).toBe("x-tealbrick-contract");
    expect(CONTRACT_VERSION).toBe("0.1.0-alpha.8");
    const ok = await app.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers[CONTRACT_VERSION_HEADER]).toBe(CONTRACT_VERSION);
    expect(ok.json()).not.toHaveProperty(CONTRACT_VERSION_HEADER);
    // A refused GET says nothing about the contract.
    expect((await app.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH })).headers[CONTRACT_VERSION_HEADER]).toBeUndefined();
    // The legacy route cannot take ownerSubject, so it never claims alpha.7.
    expect((await app.app.inject({ method: "GET", url: LEGACY_CLAIM_PATH, headers: coreHeaders })).headers[CONTRACT_VERSION_HEADER]).toBeUndefined();
    await app.close();
  });

  it("accepts ownerSubject with claimIssuedAt, signs it with the SAME identity and persists ownerSubject + ownerPinnedAt", async () => {
    const dir = await tempDir();
    const identityFile = path.join(dir, INSTANCE_CLAIM_IDENTITY_FILE);
    const app = await build(dir);
    const identity = (await app.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).json();
    const digest = await sha256(identityFile);
    const issuedAt = Date.now() - 1_000;
    const response = await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: owned(issuedAt) });
    expect(response.statusCode, response.body).toBe(200);
    const jwt = decode(response.json().proof);
    expect(jwt.payload).toMatchObject({ instanceId: identity.instanceId, ownerSubject: OWNER_SUBJECT, claimIssuedAt: issuedAt, aud: issuer, companyId });
    expect(verifies(response.json().proof, identity.publicJwk)).toBe(true);

    const binding = createFileClaimStore(dir).read();
    expect(binding).toMatchObject({ instanceId: identity.instanceId, ownerSubject: OWNER_SUBJECT, ownerPinnedAt: issuedAt, jwksUri, grantKids });
    expect(Object.keys(JSON.parse(await readFile(path.join(dir, INSTANCE_CLAIM_BINDING_FILE), "utf8"))).sort()).toEqual(
      ["claimedAt", "grantKids", "instanceId", "jwksUri", "lastClaimAt", "ownerPinnedAt", "ownerSubject", "portalIssuer", "tenantId", "version"],
    );
    // The owner pin reads it straight from the claim binding.
    expect(await readOwnerPin(createFileClaimStore(dir))).toMatchObject({ ownerSubject: OWNER_SUBJECT, ownerPinnedAt: issuedAt, instanceId: identity.instanceId, jwksUri });
    await app.close();

    // Restart: same identity (never a new key), the pin survives.
    const again = await build(dir);
    expect((await again.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).json()).toEqual(identity);
    expect(createFileClaimStore(dir).read()).toMatchObject({ ownerSubject: OWNER_SUBJECT, ownerPinnedAt: issuedAt });
    await again.close();
    expect(await sha256(identityFile)).toBe(digest);
    expect((await readdir(dir)).filter((name) => !name.startsWith("marketplace.sqlite")).sort()).toEqual([INSTANCE_CLAIM_BINDING_FILE, INSTANCE_CLAIM_IDENTITY_FILE].sort());
  });

  it("orders the pin by claimIssuedAt: stale claims write nothing, a newer claim re-pins, a newer claim without ownerSubject clears", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const post = (payload: unknown) => app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: payload as object });
    const t0 = Date.now() - 60_000;
    expect((await post(owned(t0))).statusCode).toBe(200);

    const stale = await post(owned(t0 - 1, "tealbrick-user:old-owner"));
    expect([stale.statusCode, stale.json().error]).toEqual([409, "stale_claim"]);
    expect(stale.body).not.toContain("proof");
    const sameStampOtherOwner = await post(owned(t0, "tealbrick-user:other"));
    expect([sameStampOtherOwner.statusCode, sameStampOtherOwner.json().error]).toEqual([409, "stale_claim"]);
    expect(createFileClaimStore(dir).read()).toMatchObject({ ownerSubject: OWNER_SUBJECT, ownerPinnedAt: t0 });

    // Ownership transfer: a newer claim replaces the owner.
    expect((await post(owned(t0 + 1_000, "tealbrick-user:owner-2"))).statusCode).toBe(200);
    expect(createFileClaimStore(dir).read()).toMatchObject({ ownerSubject: "tealbrick-user:owner-2", ownerPinnedAt: t0 + 1_000 });

    // A newer claim without ownerSubject clears the pin and keeps the high-water mark.
    expect((await post(owned(t0 + 2_000, null))).statusCode).toBe(200);
    const cleared = createFileClaimStore(dir).read()!;
    expect(cleared.ownerSubject).toBeUndefined();
    expect(cleared.ownerPinnedAt).toBe(t0 + 2_000);
    expect(await readOwnerPin(createFileClaimStore(dir))).toBeNull();
    // ...so the old owner's claim cannot be replayed after the clear.
    expect((await post(owned(t0 + 1_000, "tealbrick-user:owner-2"))).json().error).toBe("stale_claim");
    expect(createFileClaimStore(dir).read()!.ownerSubject).toBeUndefined();

    // An older-style claim without claimIssuedAt can only clear, never set.
    expect((await post(owned(t0 + 3_000))).statusCode).toBe(200);
    expect((await post(anchored())).statusCode).toBe(200);
    expect(createFileClaimStore(dir).read()).toMatchObject({ ownerPinnedAt: t0 + 3_000 });
    expect(createFileClaimStore(dir).read()!.ownerSubject).toBeUndefined();
    await app.close();
  });

  it("refuses a malformed owner pin in the request (400) and in the binding file (500, never replaced; no pin read)", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const post = (payload: unknown) => app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: payload as object });
    for (const payload of [
      { ...anchored(), ownerSubject: OWNER_SUBJECT }, // ownerSubject needs claimIssuedAt
      owned(Date.now(), "owner-1"),
      owned(Date.now(), "tealbrick-user:"),
      owned(Date.now(), "tealbrick-agent:agent-1"),
      { ...anchored(), claimIssuedAt: -1 },
      { ...anchored(), claimIssuedAt: 1.5 },
      owned(Date.now() + 10 * 60_000), // more than 5 minutes ahead of the app clock
    ]) {
      const response = await post(payload);
      expect([response.statusCode, response.json().error], JSON.stringify(payload)).toEqual([400, "invalid_claim_request"]);
    }
    expect(await readdir(dir)).not.toContain(INSTANCE_CLAIM_BINDING_FILE);

    const file = path.join(dir, INSTANCE_CLAIM_BINDING_FILE);
    for (const owner of [{ ownerSubject: "owner-1" }, { ownerSubject: "tealbrick-user:owner-1", ownerPinnedAt: "soon" }, { ownerPinnedAt: 0 }]) {
      const content = JSON.stringify({ version: 1, portalIssuer: issuer, tenantId: companyId, instanceId: "x", claimedAt: 1, lastClaimAt: 1, ...owner });
      await writeFile(file, content, { mode: 0o600 });
      const response = await post(owned(Date.now()));
      expect(response.statusCode).toBe(500);
      expect(await readFile(file, "utf8")).toBe(content);
      expect(await readOwnerPin(createFileClaimStore(dir))).toBeNull();
    }
    await app.close();
  });

  it("the legacy /api/tealbrick/claim is unchanged: it refuses ownerSubject and writes no binding", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const response = await app.app.inject({ method: "POST", url: LEGACY_CLAIM_PATH, headers: coreHeaders, payload: { portalIssuer: issuer, nonce: nonce(), companyId, ownerSubject: OWNER_SUBJECT, claimIssuedAt: Date.now() } });
    expect([response.statusCode, response.json().error]).toEqual([400, "invalid_claim_challenge"]);
    expect(await readdir(dir)).not.toContain(INSTANCE_CLAIM_BINDING_FILE);
    await app.close();
  });
});

describe("one claim identity on both protocols", () => {
  it("(c) serves the SAME instanceId and publicJwk on the legacy and the manifest path; both proofs verify with it", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const manifest = (await app.app.inject({ method: "GET", url: MANIFEST_CLAIM_PATH, headers: coreHeaders })).json();
    const legacy = (await app.app.inject({ method: "GET", url: LEGACY_CLAIM_PATH, headers: coreHeaders })).json();
    expect(manifest).toEqual(legacy);

    const legacyProof = (await app.app.inject({ method: "POST", url: LEGACY_CLAIM_PATH, headers: coreHeaders, payload: { portalIssuer: issuer, nonce: nonce(), companyId } })).json();
    expect(legacyProof.instanceId).toBe(manifest.instanceId);
    expect(legacyProof.publicJwk).toEqual(manifest.publicJwk);
    const manifestProof = (await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: anchored() })).json();
    for (const proof of [legacyProof.proof, manifestProof.proof]) {
      expect(verifies(proof, manifest.publicJwk)).toBe(true);
      expect(decode(proof).payload.instanceId).toBe(manifest.instanceId);
    }
    await app.close();
  });

  it("(d) upgrade: a data dir written by the previous release keeps its identity, byte for byte", async () => {
    const dir = await tempDir();
    // Exactly what Marketplace <= 0.1.19 writes (instance-claim.ts): {version: 1, instanceId, privateJwk}, mode 0600.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const previousInstanceId = randomUUID();
    const identityFile = path.join(dir, INSTANCE_CLAIM_IDENTITY_FILE);
    await writeFile(identityFile, JSON.stringify({ version: 1, instanceId: previousInstanceId, privateJwk: privateKey.export({ format: "jwk" }) }), { mode: 0o600 });
    new SqliteMarketplaceStore(path.join(dir, "marketplace.sqlite")).close();
    const digest = await sha256(identityFile);
    const { mtimeMs } = await stat(identityFile);
    const previousJwk = publicKey.export({ format: "jwk" });

    const app = await build(dir);
    for (const url of [MANIFEST_CLAIM_PATH, LEGACY_CLAIM_PATH]) {
      const identity = (await app.app.inject({ method: "GET", url, headers: coreHeaders })).json();
      expect(identity).toEqual({ instanceId: previousInstanceId, publicJwk: { kty: "OKP", crv: "Ed25519", x: previousJwk.x } });
    }
    const proof = (await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: anchored() })).json().proof;
    expect(verifies(proof, previousJwk)).toBe(true);
    await app.close();
    expect(await sha256(identityFile)).toBe(digest);
    expect((await stat(identityFile)).mtimeMs).toBe(mtimeMs);
  });

  it("(e) the legacy path is unchanged: Marketplace answer shape, Marketplace errors, no anchors, no binding", async () => {
    const dir = await tempDir();
    const app = await build(dir);
    const ok = await app.app.inject({ method: "POST", url: LEGACY_CLAIM_PATH, headers: coreHeaders, payload: { portalIssuer: issuer, nonce: nonce(), companyId } });
    expect(Object.keys(ok.json()).sort()).toEqual(["companyId", "instanceId", "proof", "publicJwk"]);
    const anchoredLegacy = await app.app.inject({ method: "POST", url: LEGACY_CLAIM_PATH, headers: coreHeaders, payload: anchored() });
    expect([anchoredLegacy.statusCode, anchoredLegacy.json().error]).toEqual([400, "invalid_claim_challenge"]);
    const wrongCompany = await app.app.inject({ method: "POST", url: LEGACY_CLAIM_PATH, headers: coreHeaders, payload: { portalIssuer: issuer, nonce: nonce(), companyId: "workspace-other" } });
    expect([wrongCompany.statusCode, wrongCompany.json().error]).toEqual([403, "claim_scope_unknown"]);
    const anonymous = await app.app.inject({ method: "GET", url: LEGACY_CLAIM_PATH });
    expect([anonymous.statusCode, anonymous.json().error]).toEqual([401, "claim_instance_auth_required"]);
    expect(await readdir(dir)).not.toContain(INSTANCE_CLAIM_BINDING_FILE);
    await app.close();
  });

  it("(f) never creates a second key file: one identity file, unchanged, across both protocols and restarts", async () => {
    const dir = await tempDir();
    for (let round = 0; round < 2; round += 1) {
      const app = await build(dir);
      for (const url of [MANIFEST_CLAIM_PATH, LEGACY_CLAIM_PATH]) {
        await app.app.inject({ method: "GET", url, headers: coreHeaders });
      }
      await app.app.inject({ method: "POST", url: LEGACY_CLAIM_PATH, headers: coreHeaders, payload: { portalIssuer: issuer, nonce: nonce(), companyId } });
      await app.app.inject({ method: "POST", url: MANIFEST_CLAIM_PATH, headers: coreHeaders, payload: anchored() });
      await app.close();
    }
    const files = (await readdir(dir)).filter((name) => !name.startsWith("marketplace.sqlite"));
    expect(files.sort()).toEqual([INSTANCE_CLAIM_BINDING_FILE, INSTANCE_CLAIM_IDENTITY_FILE].sort());
    const identity = JSON.parse(await readFile(path.join(dir, INSTANCE_CLAIM_IDENTITY_FILE), "utf8"));
    const binding = await readFile(path.join(dir, INSTANCE_CLAIM_BINDING_FILE), "utf8");
    expect(binding).not.toContain(identity.privateJwk.d);
    expect(binding).not.toMatch(/"(d|privateJwk|x)"\s*:/u);
    expect(Object.keys(JSON.parse(binding)).sort()).toEqual(["claimedAt", "grantKids", "instanceId", "jwksUri", "lastClaimAt", "portalIssuer", "tenantId", "version"]);
  });
});

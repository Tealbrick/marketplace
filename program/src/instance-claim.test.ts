import { createPublicKey, verify } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { INSTANCE_CLAIM_IDENTITY_FILE, MarketplaceInstanceClaim } from "./instance-claim.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];
const internalToken = "marketplace-internal-secret-fixture";
const proofToken = "p".repeat(43);
const issuer = "https://portal.fixture.invalid";
const companyId = "workspace-community";
const nonce = "n".repeat(43);

async function tempDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-instance-claim-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function build(dataDir: string, overrides: { instanceClaimDir?: string | null } = {}) {
  const store = new SqliteMarketplaceStore(path.join(dataDir, "marketplace.sqlite"));
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: internalToken,
    instanceClaimDir: overrides.instanceClaimDir === null ? undefined : (overrides.instanceClaimDir ?? dataDir),
    environment: {
      MARKETPLACE_ORGANIZATION_ID: companyId,
      MARKETPLACE_PORTAL_URL: issuer,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: proofToken,
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: companyId,
    },
  });
  return { app, store };
}

const bearer = { authorization: `Bearer ${internalToken}` };
const challenge = { portalIssuer: issuer, nonce, companyId };

function decode(jwt: string) {
  const [header, payload, signature] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString()),
    signed: `${header}.${payload}`,
    signature: Buffer.from(signature!, "base64url"),
  };
}

const WELL_KNOWN_CLAIM_PATH = "/.well-known/tealbrick/claim";
const ALIAS_CLAIM_PATH = "/api/tealbrick/claim";

// The canonical well-known path and the /api alias are the same handlers: the
// whole suite runs against both.
describe.each([WELL_KNOWN_CLAIM_PATH, ALIAS_CLAIM_PATH])("Marketplace instance claim at %s", (claimPath) => {
  it("keeps the same identity across a restart over the same data dir", async () => {
    const dir = await tempDir();
    const first = await build(dir);
    const before = (await first.app.inject({ method: "GET", url: claimPath, headers: bearer })).json();
    await first.app.close();
    first.store.close();
    const second = await build(dir);
    const after = (await second.app.inject({ method: "GET", url: claimPath, headers: bearer })).json();
    await second.app.close();
    second.store.close();
    expect(after).toEqual(before);
    expect(before.instanceId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(before.publicJwk).toEqual({ kty: "OKP", crv: "Ed25519", x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u) });
    const file = path.join(dir, INSTANCE_CLAIM_IDENTITY_FILE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("signs a JWT that verifies with the published key and has exactly the expected shape", async () => {
    const dir = await tempDir();
    const { app, store } = await build(dir);
    const identity = (await app.inject({ method: "GET", url: claimPath, headers: bearer })).json();
    const before = Math.floor(Date.now() / 1000);
    const response = await app.inject({ method: "POST", url: claimPath, headers: bearer, payload: challenge });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["companyId", "instanceId", "proof", "publicJwk"]);
    expect(body.publicJwk).toEqual(identity.publicJwk);
    const jwt = decode(body.proof);
    expect(jwt.header).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(Object.keys(jwt.payload).sort()).toEqual(
      ["aud", "companyId", "exp", "iat", "instanceId", "nonce", "typ", "version"],
    );
    expect(jwt.payload).toMatchObject({
      typ: "tealbrick-app-claim", version: 1, aud: issuer, nonce,
      instanceId: identity.instanceId, companyId,
    });
    expect(jwt.payload.iat).toBeGreaterThanOrEqual(before);
    expect(jwt.payload.exp - jwt.payload.iat).toBe(300);
    const key = createPublicKey({ key: identity.publicJwk, format: "jwk" });
    expect(verify(null, Buffer.from(jwt.signed), key, jwt.signature)).toBe(true);
    expect(verify(null, Buffer.from(`${jwt.signed}x`), key, jwt.signature)).toBe(false);
    await app.close();
    store.close();
  });

  it("accepts the other Portal-held credentials and rejects everything else with 401", async () => {
    const dir = await tempDir();
    const { app, store } = await build(dir);
    const ok = [
      { "x-knowledge-instance-token": internalToken },
      { "x-tealbrick-instance-proof": proofToken },
    ];
    for (const headers of ok) {
      expect((await app.inject({ method: "GET", url: claimPath, headers })).statusCode).toBe(200);
    }
    const bad = [
      {},
      { authorization: "Bearer wrong-token-value" },
      { authorization: `Bearer ${proofToken}` },
      { "x-knowledge-instance-token": "wrong-token-value" },
      { "x-tealbrick-instance-proof": internalToken },
    ];
    for (const headers of bad) {
      const get = await app.inject({ method: "GET", url: claimPath, headers });
      const post = await app.inject({ method: "POST", url: claimPath, headers, payload: challenge });
      expect([get.statusCode, post.statusCode]).toEqual([401, 401]);
      expect(get.body).not.toContain("instanceId");
    }
    await app.close();
    store.close();
  });

  it("never accepts a browser origin or cookie, even with a valid token", async () => {
    const dir = await tempDir();
    const { app, store } = await build(dir);
    for (const extra of [{ origin: "https://evil.invalid" }, { cookie: "dg_marketplace_operator_session=x" }]) {
      const get = await app.inject({ method: "GET", url: claimPath, headers: { ...bearer, ...extra } });
      expect(get.statusCode).toBe(403);
    }
    // An operator session cookie alone is not a credential.
    const cookieOnly = await app.inject({
      method: "POST", url: claimPath,
      headers: { cookie: "dg_marketplace_operator_session=x" }, payload: challenge,
    });
    expect(cookieOnly.statusCode).toBe(403);
    await app.close();
    store.close();
  });

  it("rejects a wrong company, a wrong issuer and malformed challenges", async () => {
    const dir = await tempDir();
    const { app, store } = await build(dir);
    const post = (payload: unknown) => app.inject({ method: "POST", url: claimPath, headers: bearer, payload: payload as object });
    expect((await post({ ...challenge, companyId: "workspace-other" })).statusCode).toBe(403);
    expect((await post({ ...challenge, portalIssuer: "https://other.fixture.invalid" })).statusCode).toBe(403);
    expect((await post({ ...challenge, portalIssuer: `${issuer}/` })).statusCode).toBe(400);
    expect((await post({ ...challenge, nonce: "short" })).statusCode).toBe(400);
    expect((await post({ ...challenge, extra: true })).statusCode).toBe(400);
    expect((await post({ portalIssuer: issuer, nonce })).statusCode).toBe(400);
    expect((await post({ ...challenge, companyId: "" })).statusCode).toBe(400);
    const none = await app.inject({ method: "POST", url: claimPath, headers: bearer });
    expect(none.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("never exposes private key material", async () => {
    const dir = await tempDir();
    const { app, store } = await build(dir);
    const stored = JSON.parse(await readFile(path.join(dir, INSTANCE_CLAIM_IDENTITY_FILE), "utf8"));
    expect(typeof stored.privateJwk.d).toBe("string");
    const responses = [
      await app.inject({ method: "GET", url: claimPath, headers: bearer }),
      await app.inject({ method: "POST", url: claimPath, headers: bearer, payload: challenge }),
      await app.inject({ method: "POST", url: claimPath, headers: bearer, payload: { ...challenge, companyId: "x" } }),
    ];
    for (const response of responses) {
      expect(response.body).not.toContain(stored.privateJwk.d);
      expect(JSON.stringify(response.json())).not.toMatch(/"d"\s*:/u);
    }
    expect(Object.keys(responses[0]!.json().publicJwk).sort()).toEqual(["crv", "kty", "x"]);
    await app.close();
    store.close();
  });

  it("answers 503 when no identity directory is configured and does not sign without a scope", async () => {
    const dir = await tempDir();
    const noIdentity = await build(dir, { instanceClaimDir: null });
    expect((await noIdentity.app.inject({ method: "GET", url: claimPath, headers: bearer })).statusCode).toBe(503);
    await noIdentity.app.close();
    noIdentity.store.close();

    const unscoped = await tempDir();
    const store = new SqliteMarketplaceStore(path.join(unscoped, "marketplace.sqlite"));
    const app = await buildMarketplaceApp({
      store, internalAuthToken: internalToken, instanceClaimDir: unscoped,
      environment: { MARKETPLACE_PORTAL_URL: issuer },
    });
    const response = await app.inject({ method: "POST", url: claimPath, headers: bearer, payload: challenge });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("claim_scope_unconfigured");
    await app.close();
    store.close();
  });

  it("fails closed on unsafe or malformed identity storage", async () => {
    const loose = await tempDir();
    new MarketplaceInstanceClaim(loose);
    await chmod(path.join(loose, INSTANCE_CLAIM_IDENTITY_FILE), 0o644);
    expect(() => new MarketplaceInstanceClaim(loose)).toThrow("Unsafe");
    const broken = await tempDir();
    await writeFile(path.join(broken, INSTANCE_CLAIM_IDENTITY_FILE), "{}", { mode: 0o600 });
    expect(() => new MarketplaceInstanceClaim(broken)).toThrow("Invalid");
  });
});

describe("Marketplace instance claim path equivalence", () => {
  it("serves identical identity and valid proofs on the well-known path and the alias", async () => {
    const dir = await tempDir();
    const { app, store } = await build(dir);
    const [wellKnown, alias] = await Promise.all([WELL_KNOWN_CLAIM_PATH, ALIAS_CLAIM_PATH].map(
      (url) => app.inject({ method: "GET", url, headers: bearer }),
    ));
    expect(wellKnown.statusCode).toBe(200);
    expect(wellKnown.json()).toEqual(alias.json());
    const identity = wellKnown.json();
    const key = createPublicKey({ key: identity.publicJwk, format: "jwk" });
    for (const url of [WELL_KNOWN_CLAIM_PATH, ALIAS_CLAIM_PATH]) {
      const response = await app.inject({ method: "POST", url, headers: bearer, payload: challenge });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.instanceId).toBe(identity.instanceId);
      expect(body.publicJwk).toEqual(identity.publicJwk);
      const jwt = decode(body.proof);
      expect(verify(null, Buffer.from(jwt.signed), key, jwt.signature)).toBe(true);
      expect(jwt.payload).toMatchObject({ typ: "tealbrick-app-claim", nonce, aud: issuer, instanceId: identity.instanceId, companyId });
    }
    await app.close();
    store.close();
  });

  it("protects the well-known path exactly like the alias: anonymous 401, cookie or origin 403", async () => {
    const dir = await tempDir();
    const { app, store } = await build(dir);
    const attempts: Array<[string, Record<string, string>]> = [
      ["anonymous", {}],
      ["operator cookie only", { cookie: "dg_marketplace_operator_session=x" }],
      ["origin with credential", { ...bearer, origin: "https://evil.invalid" }],
      ["cookie with credential", { ...bearer, cookie: "dg_marketplace_operator_session=x" }],
      ["wrong bearer", { authorization: "Bearer wrong-token-value" }],
    ];
    for (const [, headers] of attempts) {
      for (const method of ["GET", "POST"] as const) {
        const [wellKnown, alias] = await Promise.all([WELL_KNOWN_CLAIM_PATH, ALIAS_CLAIM_PATH].map(
          (url) => app.inject({ method, url, headers, ...(method === "POST" ? { payload: challenge } : {}) }),
        ));
        expect(wellKnown.statusCode).toBe(alias.statusCode);
        expect(wellKnown.body).toBe(alias.body);
        expect([401, 403]).toContain(wellKnown.statusCode);
        expect(wellKnown.body).not.toContain("instanceId");
      }
    }
    expect((await app.inject({ method: "GET", url: WELL_KNOWN_CLAIM_PATH })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: WELL_KNOWN_CLAIM_PATH, headers: { origin: "https://evil.invalid" } })).statusCode).toBe(403);
    await app.close();
    store.close();
  });
});

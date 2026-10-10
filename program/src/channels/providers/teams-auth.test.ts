import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";

import { resolveRuntime } from "./common.js";
import { BOT_FRAMEWORK_OPENID_URL, createBotFrameworkVerifier, isAllowedServiceUrl } from "./teams-auth.js";
import { createFakeClock, jsonResponse } from "./test-support.js";

const APP_ID = "11111111-2222-4333-8444-555555555555";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";

const signer = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string, endorsements: string[] = ["msteams", "webchat"]) {
  return { kty: "RSA", use: "sig", kid, ...key.export({ format: "jwk" }), endorsements };
}

function token(claims: Record<string, unknown>, options: { kid?: string; key?: KeyObject; alg?: string } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? "key-1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), options.key ?? signer.privateKey).toString("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}

function setup(keys: unknown[] = [jwk(signer.publicKey, "key-1")], metadata: unknown = { issuer: "https://api.botframework.com", jwks_uri: JWKS_URL }) {
  const clock = createFakeClock(1_800_000_000_000);
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === BOT_FRAMEWORK_OPENID_URL) return jsonResponse(200, metadata);
    if (url === JWKS_URL) return jsonResponse(200, { keys });
    return jsonResponse(404, {});
  }) as typeof fetch;
  const verifier = createBotFrameworkVerifier(resolveRuntime({ fetchImpl, now: clock.now, sleep: clock.sleep }));
  const nowSeconds = Math.floor(clock.now() / 1000);
  // Bot Connector tokens carry the lowercase `serviceurl` claim.
  const claims: Record<string, unknown> = { iss: "https://api.botframework.com", aud: APP_ID, serviceurl: SERVICE_URL, nbf: nowSeconds - 10, exp: nowSeconds + 3600 };
  const activity = { serviceUrl: SERVICE_URL, channelId: "msteams" };
  return { verifier, clock, requests, claims, activity };
}

describe("isAllowedServiceUrl", () => {
  it("accepts only https Bot Connector hosts on the allowlist", () => {
    expect(isAllowedServiceUrl("https://smba.trafficmanager.net/amer/")).toBe(true);
    expect(isAllowedServiceUrl("https://smba.trafficmanager.net/teams/")).toBe(true);
    expect(isAllowedServiceUrl("https://smba.infra.gcc.teams.microsoft.com/teams")).toBe(true);
    for (const value of [
      "http://smba.trafficmanager.net/amer/",
      "https://smba.trafficmanager.net.evil.example/amer/",
      "https://evil.example/smba.trafficmanager.net/",
      "https://user:pass@smba.trafficmanager.net/amer/",
      "https://smba.trafficmanager.net:8443/amer/",
      "https://smba.trafficmanager.net/amer/?x=1",
      "https://smba.infra.gov.teams.microsoft.us/teams",
      "not a url",
      42,
    ]) {
      expect(isAllowedServiceUrl(value), String(value)).toBe(false);
    }
  });
});

describe("Bot Framework JWT verification", () => {
  it("accepts a token signed by an endorsed Bot Framework key with the right issuer, audience and serviceUrl", async () => {
    const { verifier, claims, activity, requests } = setup();
    const result = await verifier.verify({ authorization: token(claims), appId: APP_ID, activity });
    expect(result).toEqual({ ok: true, claims: { iss: claims.iss, aud: APP_ID, serviceUrl: SERVICE_URL, exp: claims.exp, nbf: claims.nbf } });
    expect(requests).toEqual([BOT_FRAMEWORK_OPENID_URL, JWKS_URL]);
    // Keys are cached.
    await verifier.verify({ authorization: token(claims), appId: APP_ID, activity });
    expect(requests).toHaveLength(2);
  });

  it("reads the lowercase serviceurl claim first and accepts serviceUrl as a fallback", async () => {
    const { verifier, claims, activity } = setup();
    const { serviceurl, ...rest } = claims;
    expect((await verifier.verify({ authorization: token({ ...rest, serviceUrl: serviceurl }), appId: APP_ID, activity })).ok).toBe(true);
    // The lowercase claim wins: a matching camel-case claim does not rescue a wrong lowercase one.
    expect(await verifier.verify({ authorization: token({ ...claims, serviceurl: "https://smba.trafficmanager.net/emea/", serviceUrl: SERVICE_URL }), appId: APP_ID, activity })).toEqual({
      ok: false,
      status: 401,
      reason: "token_service_url",
    });
    expect(await verifier.verify({ authorization: token(rest), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_service_url" });
  });

  it("rejects missing, malformed, wrong-algorithm, wrong-issuer, wrong-audience and expired tokens", async () => {
    const { verifier, claims, activity, clock } = setup();
    const nowSeconds = Math.floor(clock.now() / 1000);
    const cases: Array<[string | undefined, string]> = [
      [undefined, "token_missing"],
      ["Basic abc", "token_missing"],
      ["Bearer a.b.c", "token_malformed"],
      [token(claims, { alg: "HS256" }), "token_algorithm"],
      [token({ ...claims, iss: "https://sts.windows.net/x/" }), "token_issuer"],
      [token({ ...claims, aud: "22222222-2222-4333-8444-555555555555" }), "token_audience"],
      [token({ ...claims, exp: nowSeconds - 301 }), "token_expired"],
      [token({ ...claims, nbf: nowSeconds + 301 }), "token_not_yet_valid"],
    ];
    for (const [authorization, reason] of cases) {
      expect(await verifier.verify({ authorization, appId: APP_ID, activity }), reason).toEqual({ ok: false, status: 401, reason });
    }
  });

  it("allows five minutes of clock skew", async () => {
    const { verifier, claims, activity, clock } = setup();
    const nowSeconds = Math.floor(clock.now() / 1000);
    expect((await verifier.verify({ authorization: token({ ...claims, exp: nowSeconds - 200 }), appId: APP_ID, activity })).ok).toBe(true);
  });

  it("rejects a serviceUrl claim that differs from the activity (401, before the signature is checked)", async () => {
    const { verifier, claims, activity } = setup();
    expect(await verifier.verify({ authorization: token(claims), appId: APP_ID, activity: { ...activity, serviceUrl: "https://smba.trafficmanager.net/emea/" } })).toEqual({
      ok: false,
      status: 401,
      reason: "token_service_url",
    });
  });

  it("reads the activity lazily, only after issuer, audience and validity pass, and answers 400 only for a validly signed token", async () => {
    const { verifier, claims, requests } = setup();
    let reads = 0;
    const unreadable = () => {
      reads += 1;
      return undefined;
    };
    // Claim failures never read the body.
    expect(await verifier.verify({ authorization: token({ ...claims, iss: "x" }), appId: APP_ID, activity: unreadable })).toEqual({ ok: false, status: 401, reason: "token_issuer" });
    expect(reads).toBe(0);
    // An unreadable activity with a forged signature, an unknown kid or cold keys: 401, and no key refresh.
    expect(await verifier.verify({ authorization: token(claims, { key: stranger.privateKey }), appId: APP_ID, activity: unreadable })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
    expect(requests).toEqual([]);
    expect(await verifier.verify({ authorization: token(claims), appId: APP_ID, activity: { serviceUrl: SERVICE_URL, channelId: "msteams" } })).toMatchObject({ ok: true });
    expect(await verifier.verify({ authorization: token(claims, { key: stranger.privateKey }), appId: APP_ID, activity: unreadable })).toEqual({ ok: false, status: 401, reason: "token_signature" });
    expect(await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity: unreadable })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
    expect(requests).toHaveLength(2);
    // A valid token with an unreadable activity is the only 400.
    expect(await verifier.verify({ authorization: token(claims), appId: APP_ID, activity: unreadable })).toEqual({ ok: false, status: 400, reason: "activity_invalid" });
    expect(reads).toBe(4);
  });

  it("rejects a forged signature and an unknown key", async () => {
    const { verifier, claims, activity } = setup();
    expect(await verifier.verify({ authorization: token(claims, { key: stranger.privateKey }), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_signature" });
    const tampered = token(claims).split(".");
    tampered[1] = Buffer.from(JSON.stringify({ ...claims, aud: APP_ID, extra: true })).toString("base64url");
    expect(await verifier.verify({ authorization: tampered.join("."), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_signature" });
    expect(await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
  });

  it("refreshes the keys for an unknown kid at most once per kid per five minutes", async () => {
    const { verifier, claims, activity, requests, clock } = setup();
    await verifier.verify({ authorization: token(claims), appId: APP_ID, activity });
    clock.advance(60_000);
    await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity });
    expect(requests).toHaveLength(4);
    clock.advance(60_000);
    await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity });
    expect(requests).toHaveLength(4);
    clock.advance(5 * 60_000);
    await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity });
    expect(requests).toHaveLength(6);
  });

  it("does not let forged random-kid tokens block a real key rotation", async () => {
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let keys = [jwk(signer.publicKey, "key-1")];
    const clock = createFakeClock(1_800_000_000_000);
    let fetches = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === BOT_FRAMEWORK_OPENID_URL) return jsonResponse(200, { jwks_uri: JWKS_URL });
      fetches += 1;
      return jsonResponse(200, { keys });
    }) as typeof fetch;
    const verifier = createBotFrameworkVerifier(resolveRuntime({ fetchImpl, now: clock.now, sleep: clock.sleep }));
    const nowSeconds = Math.floor(clock.now() / 1000);
    const claims = { iss: "https://api.botframework.com", aud: APP_ID, serviceurl: SERVICE_URL, nbf: nowSeconds - 10, exp: nowSeconds + 3600 };
    const activity = { serviceUrl: SERVICE_URL, channelId: "msteams" };
    expect((await verifier.verify({ authorization: token(claims), appId: APP_ID, activity })).ok).toBe(true);
    // The same forged kid, repeated: one refresh only.
    clock.advance(40_000);
    for (let index = 0; index < 10; index += 1) {
      expect(await verifier.verify({ authorization: token(claims, { kid: "random-0", key: stranger.privateKey }), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
    }
    expect(fetches).toBe(2);
    // Many different forged kids: capped, and the real rotation right after still gets its refresh.
    for (let index = 1; index < 4; index += 1) {
      clock.advance(31_000);
      await verifier.verify({ authorization: token(claims, { kid: `random-${index}`, key: stranger.privateKey }), appId: APP_ID, activity });
    }
    keys = [jwk(signer.publicKey, "key-1"), jwk(rotated.publicKey, "key-2")];
    clock.advance(31_000);
    const real = await verifier.verify({ authorization: token(claims, { kid: "key-2", key: rotated.privateKey }), appId: APP_ID, activity });
    expect(real.ok).toBe(true);
  });

  it("caps unknown-kid refreshes per five minutes across all kids", async () => {
    const { verifier, claims, activity, requests, clock } = setup();
    await verifier.verify({ authorization: token(claims), appId: APP_ID, activity });
    clock.advance(31_000);
    const before = requests.length;
    for (let index = 0; index < 20; index += 1) {
      await verifier.verify({ authorization: token(claims, { kid: `random-${index}`, key: stranger.privateKey }), appId: APP_ID, activity });
      clock.advance(1000);
    }
    // 20 kids in 20 s, 30 s apart at most: bounded by the attempt spacing and the global cap (6 per window).
    expect((requests.length - before) / 2).toBeLessThanOrEqual(6);
    expect(requests.length - before).toBeGreaterThan(0);
  });

  it("refreshes keys older than 15 minutes on an unknown kid even when the per-kid and global limits are spent", async () => {
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let keys = [jwk(signer.publicKey, "key-1")];
    const clock = createFakeClock(1_800_000_000_000);
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input) === BOT_FRAMEWORK_OPENID_URL ? jsonResponse(200, { jwks_uri: JWKS_URL }) : jsonResponse(200, { keys })) as typeof fetch;
    const verifier = createBotFrameworkVerifier(resolveRuntime({ fetchImpl, now: clock.now, sleep: clock.sleep }));
    const nowSeconds = Math.floor(clock.now() / 1000);
    const claims = { iss: "https://api.botframework.com", aud: APP_ID, serviceurl: SERVICE_URL, nbf: nowSeconds - 10, exp: nowSeconds + 4 * 3600 };
    const activity = { serviceUrl: SERVICE_URL, channelId: "msteams" };
    await verifier.verify({ authorization: token(claims), appId: APP_ID, activity });
    // Spend the global cap and the per-kid slot of the future real kid inside one five-minute window.
    for (let index = 0; index < 8; index += 1) {
      clock.advance(31_000);
      await verifier.verify({ authorization: token(claims, { kid: index === 7 ? "key-2" : `random-${index}`, key: stranger.privateKey }), appId: APP_ID, activity });
    }
    keys = [jwk(signer.publicKey, "key-1"), jwk(rotated.publicKey, "key-2")];
    clock.advance(10_000);
    expect(await verifier.verify({ authorization: token(claims, { kid: "key-2", key: rotated.privateKey }), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
    clock.advance(16 * 60_000);
    const fresh = Math.floor(clock.now() / 1000);
    const later = { ...claims, nbf: fresh - 10, exp: fresh + 3600 };
    expect((await verifier.verify({ authorization: token(later, { kid: "key-2", key: rotated.privateKey }), appId: APP_ID, activity })).ok).toBe(true);
  });

  it("fetches keys at most once per five minutes while the metadata fetch fails", async () => {
    const clock = createFakeClock(1_800_000_000_000);
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return jsonResponse(500, {});
    }) as typeof fetch;
    const verifier = createBotFrameworkVerifier(resolveRuntime({ fetchImpl, now: clock.now, sleep: clock.sleep }));
    const nowSeconds = Math.floor(clock.now() / 1000);
    const claims = { iss: "https://api.botframework.com", aud: APP_ID, serviceurl: SERVICE_URL, exp: nowSeconds + 3600 };
    const activity = { serviceUrl: SERVICE_URL, channelId: "msteams" };
    for (let index = 0; index < 20; index += 1) {
      const result = await verifier.verify({ authorization: token(claims, { kid: `forged-${index}`, key: stranger.privateKey }), appId: APP_ID, activity });
      expect(result).toEqual({ ok: false, status: 503, reason: "signing_keys_unavailable" });
      clock.advance(1000);
    }
    expect(requests).toBe(1);
    clock.advance(5 * 60_000);
    await verifier.verify({ authorization: token(claims, { key: stranger.privateKey }), appId: APP_ID, activity });
    expect(requests).toBe(2);
  });

  it("keeps stale keys usable and does not refetch per request while a refresh fails", async () => {
    let failing = false;
    const clock = createFakeClock(1_800_000_000_000);
    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (failing) return jsonResponse(503, {});
      if (url === BOT_FRAMEWORK_OPENID_URL) return jsonResponse(200, { jwks_uri: JWKS_URL });
      return jsonResponse(200, { keys: [jwk(signer.publicKey, "key-1")] });
    }) as typeof fetch;
    const verifier = createBotFrameworkVerifier(resolveRuntime({ fetchImpl, now: clock.now, sleep: clock.sleep }));
    const activity = { serviceUrl: SERVICE_URL, channelId: "msteams" };
    const fresh = () => ({ iss: "https://api.botframework.com", aud: APP_ID, serviceurl: SERVICE_URL, exp: Math.floor(clock.now() / 1000) + 3600 });
    expect((await verifier.verify({ authorization: token(fresh()), appId: APP_ID, activity })).ok).toBe(true);
    failing = true;
    clock.advance(25 * 3_600_000);
    const before = requests.length;
    for (let index = 0; index < 10; index += 1) {
      await verifier.verify({ authorization: token(fresh(), { key: stranger.privateKey }), appId: APP_ID, activity });
    }
    expect(requests.length - before).toBe(1);
    expect((await verifier.verify({ authorization: token(fresh()), appId: APP_ID, activity })).ok).toBe(true);
  });

  it("requires the msteams endorsement on the key and the msteams channel on the activity (403)", async () => {
    const unendorsed = setup([jwk(signer.publicKey, "key-1", ["webchat"])]);
    expect(await unendorsed.verifier.verify({ authorization: token(unendorsed.claims), appId: APP_ID, activity: unendorsed.activity })).toEqual({
      ok: false,
      status: 403,
      reason: "token_endorsement",
    });
    const other = setup();
    expect(await other.verifier.verify({ authorization: token(other.claims), appId: APP_ID, activity: { ...other.activity, channelId: "webchat" } })).toEqual({
      ok: false,
      status: 403,
      reason: "token_endorsement",
    });
  });

  it("answers 401, with no JWKS fetch, for forged public claims and an unreadable activity; 400 only for a valid token", async () => {
    const { verifier, claims, requests } = setup();
    const garbage = () => undefined;
    // Cold cache: a forged token (public claims, unknown signer) is a 401 and fetches nothing.
    expect(await verifier.verify({ authorization: token(claims, { key: stranger.privateKey }), appId: APP_ID, activity: garbage })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
    expect(await verifier.verify({ authorization: token(claims, { kid: "random-kid", key: stranger.privateKey }), appId: APP_ID, activity: garbage })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
    expect(requests).toEqual([]);
    // Warm cache: forged signature on a cached kid is 401 token_signature, an unknown kid is 401, no refresh.
    await verifier.verify({ authorization: token(claims), appId: APP_ID, activity: { serviceUrl: SERVICE_URL, channelId: "msteams" } });
    const warm = requests.length;
    expect(await verifier.verify({ authorization: token(claims, { key: stranger.privateKey }), appId: APP_ID, activity: garbage })).toEqual({ ok: false, status: 401, reason: "token_signature" });
    expect(await verifier.verify({ authorization: token(claims, { kid: "random-kid", key: stranger.privateKey }), appId: APP_ID, activity: garbage })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
    expect(requests).toHaveLength(warm);
    // A validly signed token with the same unreadable activity: 400.
    expect(await verifier.verify({ authorization: token(claims), appId: APP_ID, activity: garbage })).toEqual({ ok: false, status: 400, reason: "activity_invalid" });
  });

  it("never follows a jwks_uri off login.botframework.com and answers 503 without keys", async () => {
    const { verifier, claims, activity, requests } = setup(undefined, { jwks_uri: "https://evil.example/keys" });
    expect(await verifier.verify({ authorization: token(claims), appId: APP_ID, activity })).toEqual({ ok: false, status: 503, reason: "signing_keys_unavailable" });
    expect(requests).toEqual([BOT_FRAMEWORK_OPENID_URL]);
  });
});

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
  const claims = { iss: "https://api.botframework.com", aud: APP_ID, serviceUrl: SERVICE_URL, nbf: nowSeconds - 10, exp: nowSeconds + 3600 };
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

  it("rejects a serviceUrl claim that differs from the activity (403)", async () => {
    const { verifier, claims, activity } = setup();
    expect(await verifier.verify({ authorization: token(claims), appId: APP_ID, activity: { ...activity, serviceUrl: "https://smba.trafficmanager.net/emea/" } })).toEqual({
      ok: false,
      status: 403,
      reason: "token_service_url",
    });
  });

  it("rejects a forged signature and an unknown key", async () => {
    const { verifier, claims, activity } = setup();
    expect(await verifier.verify({ authorization: token(claims, { key: stranger.privateKey }), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_signature" });
    const tampered = token(claims).split(".");
    tampered[1] = Buffer.from(JSON.stringify({ ...claims, aud: APP_ID, extra: true })).toString("base64url");
    expect(await verifier.verify({ authorization: tampered.join("."), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_signature" });
    expect(await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity })).toEqual({ ok: false, status: 401, reason: "token_key_unknown" });
  });

  it("refreshes the keys for an unknown kid at most once per five minutes", async () => {
    const { verifier, claims, activity, requests, clock } = setup();
    await verifier.verify({ authorization: token(claims), appId: APP_ID, activity });
    clock.advance(60_000);
    await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity });
    expect(requests).toHaveLength(2);
    clock.advance(5 * 60_000);
    await verifier.verify({ authorization: token(claims, { kid: "key-9" }), appId: APP_ID, activity });
    expect(requests).toHaveLength(4);
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

  it("never follows a jwks_uri off login.botframework.com and answers 503 without keys", async () => {
    const { verifier, claims, activity, requests } = setup(undefined, { jwks_uri: "https://evil.example/keys" });
    expect(await verifier.verify({ authorization: token(claims), appId: APP_ID, activity })).toEqual({ ok: false, status: 503, reason: "signing_keys_unavailable" });
    expect(requests).toEqual([BOT_FRAMEWORK_OPENID_URL]);
  });
});

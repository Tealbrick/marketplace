import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from "node:crypto";

import { asRecord, httpRequest, isSuccess, type ProviderRuntime } from "./common.js";

// Microsoft Teams auth helpers (Bot Framework REST, single-tenant Azure Bot). node:crypto only, no new
// dependencies. Two directions:
// 1. Marketplace -> Bot Connector / Graph: OAuth client credentials at the bot's own tenant, cached until
//    five minutes before expiry. The token is never logged and never part of a returned value.
// 2. Bot Connector -> Marketplace (the messaging endpoint): RS256 JWT verification against the Bot
//    Framework OpenID keys, issuer, audience = app id, validity window, `serviceUrl` claim and the
//    `msteams` channel endorsement.
// Docs: https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication

export const BOT_FRAMEWORK_SCOPE = "https://api.botframework.com/.default";
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
export const BOT_FRAMEWORK_OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";
const JWKS_HOST = "login.botframework.com";
const LOGIN_BASE = "https://login.microsoftonline.com";

/** A cached access token is renewed this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Industry-standard clock skew for the inbound token validity window (Bot Framework docs). */
export const JWT_CLOCK_SKEW_SECONDS = 300;
/** The Bot Framework keys document is refreshed at least once per day (docs: "at least once every 24 hours"). */
export const JWKS_MAX_AGE_MS = 24 * 3_600_000;
/**
 * An unknown `kid` refreshes the keys at most once per `kid` in this window, and a fetch that failed blocks further
 * unknown-`kid` refreshes for the same window. A forged token with a random `kid` (the app id is public) therefore
 * only spends its own `kid`'s slot, never the slot of a real key rotation.
 */
export const JWKS_MIN_REFRESH_MS = 5 * 60_000;
/** Most unknown-`kid` refreshes in one `JWKS_MIN_REFRESH_MS` window, whatever the `kid`s are. */
export const JWKS_MAX_REFRESHES_PER_WINDOW = 6;
/** Keys older than this are refreshed on an unknown `kid` even when the per-`kid` and global limits are spent. */
export const JWKS_FORCE_REFRESH_AGE_MS = 15 * 60_000;
/** Whatever the reason, two fetch attempts are never closer than this (an outage never turns into one fetch per request). */
export const JWKS_MIN_ATTEMPT_SPACING_MS = 30_000;
/** Recently missed `kid`s remembered for the per-`kid` limit (least recently missed dropped first). */
export const JWKS_MISSED_KIDS_MAX = 128;

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Bot Connector service hosts Marketplace accepts in a `serviceUrl` (public cloud and GCC; both use the
 * public Bot Framework token issuer). GCC High, DoD and 21Vianet use other auth clouds and are not supported.
 * Docs: https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
 */
export const TEAMS_SERVICE_HOSTS: readonly string[] = ["smba.trafficmanager.net", "smba.infra.gcc.teams.microsoft.com"];

/** True for an https Bot Connector service URL on the allowlist (no credentials, no port, no query, no fragment). */
export function isAllowedServiceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    TEAMS_SERVICE_HOSTS.includes(url.hostname.toLowerCase()) &&
    /^\/[A-Za-z0-9._~/-]*$/u.test(url.pathname)
  );
}

/** `https://smba.trafficmanager.net/amer/` -> `https://smba.trafficmanager.net/amer` (for joining API paths). */
export function serviceBase(serviceUrl: string): string {
  return serviceUrl.replace(/\/+$/u, "");
}

export type TeamsCredential = { appId: string; appSecret: string; tenantId: string };

// ---------------------------------------------------------------- Outbound tokens

export type TokenResult = { ok: true; token: string } | { ok: false; reason: "credential_invalid" | "provider_unavailable" };

export type TokenCache = {
  get(credential: TeamsCredential, scope: string): Promise<TokenResult>;
  invalidate(credential: TeamsCredential, scope: string): void;
};

function cacheKey(credential: TeamsCredential, scope: string): string {
  // The secret is part of the key (a rotated secret gets a new token) but only as a digest.
  return createHash("sha256").update(`${credential.tenantId}\u0000${credential.appId}\u0000${credential.appSecret}\u0000${scope}`).digest("hex");
}

/** Client-credentials tokens at `login.microsoftonline.com/<tenant>`, cached until expiry minus five minutes. */
export function createTokenCache(runtime: ProviderRuntime): TokenCache {
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<TokenResult>>();

  async function fetchToken(credential: TeamsCredential, scope: string, key: string): Promise<TokenResult> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credential.appId,
      client_secret: credential.appSecret,
      scope,
    });
    const result = await httpRequest(runtime, `${LOGIN_BASE}/${encodeURIComponent(credential.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      body: body.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    if (result.kind !== "response") return { ok: false, reason: "provider_unavailable" };
    const json = asRecord(result.json);
    if (result.status === 400 || result.status === 401) {
      // invalid_client (wrong secret), unauthorized_client, invalid_request (unknown tenant or app id).
      const error = typeof json?.error === "string" ? json.error : "";
      return ["invalid_client", "unauthorized_client", "invalid_request", "invalid_grant", "invalid_scope"].includes(error) || result.status === 401
        ? { ok: false, reason: "credential_invalid" }
        : { ok: false, reason: "provider_unavailable" };
    }
    if (!isSuccess(result) || !json || typeof json.access_token !== "string" || !/^[\x21-\x7e]{16,8192}$/u.test(json.access_token)) {
      return { ok: false, reason: "provider_unavailable" };
    }
    const seconds = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in);
    const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3_600_000;
    cache.set(key, { token: json.access_token, expiresAt: runtime.now() + lifetimeMs - TOKEN_REFRESH_MARGIN_MS });
    return { ok: true, token: json.access_token };
  }

  return {
    async get(credential, scope) {
      const key = cacheKey(credential, scope);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > runtime.now()) return { ok: true, token: cached.token };
      cache.delete(key);
      const running = inflight.get(key);
      if (running) return running;
      const next = fetchToken(credential, scope, key).finally(() => inflight.delete(key));
      inflight.set(key, next);
      return next;
    },
    invalidate(credential, scope) {
      cache.delete(cacheKey(credential, scope));
    },
  };
}

// ---------------------------------------------------------------- Inbound JWT

export type BotFrameworkClaims = { iss: string; aud: string; serviceUrl: string; exp: number; nbf?: number };

/**
 * The service URL claim. Bot Connector tokens carry it as lowercase `serviceurl` (Bot Framework SDK
 * `AuthenticationConstants.ServiceUrlClaim`); `serviceUrl` is accepted as a fallback.
 */
export function serviceUrlClaim(claims: Record<string, unknown>): string | undefined {
  if (typeof claims.serviceurl === "string") return claims.serviceurl;
  return typeof claims.serviceUrl === "string" ? claims.serviceUrl : undefined;
}

export type BotFrameworkVerifyResult =
  | { ok: true; claims: BotFrameworkClaims }
  | { ok: false; status: 400 | 401 | 403 | 503; reason: string };

/** What the verifier needs from the activity: its `serviceUrl` and `channelId`. */
export type BotFrameworkActivityFacts = { serviceUrl: unknown; channelId: unknown };

export type BotFrameworkVerifier = {
  /**
   * `activity` may be a function that reads the facts from the request body. The verifier calls it only after the
   * token's issuer, audience and validity checks passed; it returns undefined for a body that is not an activity.
   * Until the signature is verified every failure is a 401 (the body is never an oracle); an unreadable activity
   * with a validly signed token is a 400 `activity_invalid`.
   */
  verify(input: {
    authorization: string | undefined;
    appId: string;
    activity: BotFrameworkActivityFacts | (() => BotFrameworkActivityFacts | undefined);
  }): Promise<BotFrameworkVerifyResult>;
};

type SigningKey = { key: KeyObject; endorsements: string[] };

function base64UrlJson(part: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(part)) return undefined;
  try {
    return asRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function toSigningKey(raw: unknown): [string, SigningKey] | undefined {
  const jwk = asRecord(raw);
  if (!jwk || typeof jwk.kid !== "string" || jwk.kid.length === 0 || jwk.kid.length > 200) return undefined;
  if (jwk.kty !== undefined && jwk.kty !== "RSA") return undefined;
  const endorsements = Array.isArray(jwk.endorsements) ? jwk.endorsements.filter((value): value is string => typeof value === "string") : [];
  try {
    let key: KeyObject;
    if (typeof jwk.n === "string" && typeof jwk.e === "string") {
      key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e } as JsonWebKey, format: "jwk" });
    } else if (Array.isArray(jwk.x5c) && typeof jwk.x5c[0] === "string" && /^[A-Za-z0-9+/=]+$/u.test(jwk.x5c[0])) {
      const body = jwk.x5c[0].match(/.{1,64}/gu)?.join("\n") ?? "";
      key = createPublicKey(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`);
    } else {
      return undefined;
    }
    if (key.asymmetricKeyType !== "rsa") return undefined;
    return [jwk.kid, { key, endorsements }];
  } catch {
    return undefined;
  }
}

/**
 * Bot Framework token verifier for the Teams messaging endpoint. Keys come from the Bot Framework OpenID
 * metadata (the `jwks_uri` must stay on login.botframework.com), cached for 24 hours. An unknown `kid` refreshes
 * them at most once per `kid` per five minutes and at most `JWKS_MAX_REFRESHES_PER_WINDOW` times per five
 * minutes in all, and only after the token's issuer, audience, validity and `serviceUrl` checks passed. Keys
 * older than 15 minutes are refreshed on an unknown `kid` regardless of those limits (but never closer than
 * `JWKS_MIN_ATTEMPT_SPACING_MS` apart).
 */
export function createBotFrameworkVerifier(runtime: ProviderRuntime): BotFrameworkVerifier {
  let keys = new Map<string, SigningKey>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  // Every attempt counts, success or failure (F2).
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let failedAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<boolean> | null = null;
  const missedKids = new Map<string, number>();
  let windowAttempts: number[] = [];

  async function refresh(): Promise<boolean> {
    attemptedAt = runtime.now();
    const metadata = await httpRequest(runtime, BOT_FRAMEWORK_OPENID_URL, { method: "GET" });
    const document = metadata.kind === "response" && isSuccess(metadata) ? asRecord(metadata.json) : undefined;
    const jwksUri = typeof document?.jwks_uri === "string" ? document.jwks_uri : "";
    let parsed: URL;
    try {
      parsed = new URL(jwksUri);
    } catch {
      return false;
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== JWKS_HOST || parsed.port !== "" || parsed.username !== "") return false;
    const jwks = await httpRequest(runtime, parsed.toString(), { method: "GET" });
    const list = jwks.kind === "response" && isSuccess(jwks) ? asRecord(jwks.json)?.keys : undefined;
    if (!Array.isArray(list)) return false;
    const next = new Map<string, SigningKey>();
    for (const raw of list.slice(0, 100)) {
      const entry = toSigningKey(raw);
      if (entry) next.set(entry[0], entry[1]);
    }
    if (next.size === 0) return false;
    keys = next;
    fetchedAt = runtime.now();
    return true;
  }

  function refreshOnce(): Promise<boolean> {
    refreshing ??= refresh()
      .catch(() => false)
      .then((ok) => {
        if (!ok) failedAt = runtime.now();
        return ok;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  /** Decides whether this lookup may start a fetch, and records the attempt against the limits it used. */
  function mayRefresh(kid: string, now: number): boolean {
    const known = keys.has(kid);
    const age = now - fetchedAt;
    const spaced = now - attemptedAt >= JWKS_MIN_ATTEMPT_SPACING_MS;
    if (known) return age > JWKS_MAX_AGE_MS && spaced;
    const forced = age > JWKS_FORCE_REFRESH_AGE_MS && spaced;
    const lastMiss = missedKids.get(kid);
    windowAttempts = windowAttempts.filter((at) => now - at < JWKS_MIN_REFRESH_MS);
    const limited =
      spaced &&
      now - failedAt >= JWKS_MIN_REFRESH_MS &&
      (lastMiss === undefined || now - lastMiss >= JWKS_MIN_REFRESH_MS) &&
      windowAttempts.length < JWKS_MAX_REFRESHES_PER_WINDOW;
    if (!forced && !limited) return false;
    if (!forced) windowAttempts.push(now);
    missedKids.delete(kid);
    missedKids.set(kid, now);
    while (missedKids.size > JWKS_MISSED_KIDS_MAX) missedKids.delete(missedKids.keys().next().value as string);
    return true;
  }

  async function keyFor(kid: string): Promise<SigningKey | undefined | "unavailable"> {
    if (refreshing) await refreshing;
    else if (mayRefresh(kid, runtime.now())) await refreshOnce();
    if (keys.size === 0) return "unavailable";
    // Stale keys stay usable while a refresh is failing; Microsoft rotates keys with overlap.
    return keys.get(kid);
  }

  return {
    async verify({ authorization, appId, activity: activitySource }) {
      const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(authorization?.trim() ?? "");
      if (!match) return { ok: false, status: 401, reason: "token_missing" };
      const [, headerPart, payloadPart, signaturePart] = match as unknown as [string, string, string, string];
      const header = base64UrlJson(headerPart);
      const claims = base64UrlJson(payloadPart);
      if (!header || !claims) return { ok: false, status: 401, reason: "token_malformed" };
      if (header.alg !== "RS256" || typeof header.kid !== "string") return { ok: false, status: 401, reason: "token_algorithm" };
      if (claims.iss !== BOT_FRAMEWORK_ISSUER) return { ok: false, status: 401, reason: "token_issuer" };
      const audience = claims.aud;
      if (!(audience === appId || (Array.isArray(audience) && audience.length === 1 && audience[0] === appId))) {
        return { ok: false, status: 401, reason: "token_audience" };
      }
      const nowSeconds = Math.floor(runtime.now() / 1000);
      if (typeof claims.exp !== "number" || claims.exp + JWT_CLOCK_SKEW_SECONDS < nowSeconds) return { ok: false, status: 401, reason: "token_expired" };
      if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - JWT_CLOCK_SKEW_SECONDS > nowSeconds)) {
        return { ok: false, status: 401, reason: "token_not_yet_valid" };
      }
      const claimedServiceUrl = serviceUrlClaim(claims);
      if (claimedServiceUrl === undefined) return { ok: false, status: 401, reason: "token_service_url" };
      // The body is read only now, after the token's own claims passed.
      const activity = typeof activitySource === "function" ? activitySource() : activitySource;
      if (activity && claimedServiceUrl !== activity.serviceUrl) return { ok: false, status: 401, reason: "token_service_url" };
      // Without a readable activity the token cannot pass the serviceUrl check, so it never causes a key refresh.
      const key = activity ? await keyFor(header.kid) : keys.get(header.kid);
      if (key === "unavailable") return { ok: false, status: 503, reason: "signing_keys_unavailable" };
      if (!key) return { ok: false, status: 401, reason: "token_key_unknown" };
      const signature = Buffer.from(signaturePart, "base64url");
      let valid = false;
      try {
        valid = verifySignature("RSA-SHA256", Buffer.from(`${headerPart}.${payloadPart}`), key.key, signature);
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, status: 401, reason: "token_signature" };
      if (!activity) return { ok: false, status: 400, reason: "activity_invalid" };
      // The key must be endorsed for the channel the activity claims to come from (docs: 403 otherwise).
      if (activity.channelId !== "msteams" || !key.endorsements.includes("msteams")) {
        return { ok: false, status: 403, reason: "token_endorsement" };
      }
      return {
        ok: true,
        claims: {
          iss: claims.iss,
          aud: appId,
          serviceUrl: claimedServiceUrl,
          exp: claims.exp,
          ...(typeof claims.nbf === "number" ? { nbf: claims.nbf } : {}),
        },
      };
    },
  };
}

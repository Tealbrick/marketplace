import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MARKETPLACE_OPERATOR_SESSION_COOKIE = "dg_marketplace_operator_session";

export interface MarketplacePrincipal {
  readonly kind: "operator" | "service";
  readonly id: string;
  readonly organizationId: string;
  /** Display-only workspace label from the Portal launch; never used for scoping. */
  readonly organizationName?: string;
}

/** How an operator session was opened: a Portal launch ticket, or the deployment's operator access token. */
export type MarketplaceOperatorSessionSource = "portal-launch" | "access-token";

interface MarketplaceOperatorSession {
  readonly tokenDigest: Buffer;
  readonly csrfToken: string;
  readonly principal: MarketplacePrincipal;
  readonly expiresAtMs: number;
  readonly source: MarketplaceOperatorSessionSource;
}

export interface MarketplaceOperatorSessionStatus {
  readonly configured: boolean;
  readonly authenticated: boolean;
  readonly mode: "session" | "test_bypass" | "unconfigured";
  readonly principal: MarketplacePrincipal | null;
  readonly csrfToken: string | null;
  readonly expiresAt: string | null;
}

export interface MarketplaceOperatorSessionManagerOptions {
  readonly accessToken?: string | null;
  readonly operatorId?: string | null;
  readonly organizationId?: string | null;
  readonly sessionTtlMs?: number;
  readonly allowUnauthenticated?: boolean;
  readonly now?: () => number;
}

export class MarketplaceAuthenticationError extends Error {
  constructor(
    readonly code: "operator_auth_unconfigured" | "operator_unauthorized" | "operator_rate_limited",
    readonly statusCode: 401 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest();
}

function matchesDigest(actual: string, expectedDigest: Buffer | null) {
  if (!actual || !expectedDigest) return false;
  const actualDigest = digest(actual);
  return actualDigest.length === expectedDigest.length && timingSafeEqual(actualDigest, expectedDigest);
}

export function marketplaceSecretMatches(actual: string, expected: string | null | undefined) {
  const normalized = expected?.trim() ?? "";
  return Boolean(normalized && matchesDigest(actual.trim(), digest(normalized)));
}

function cookieValue(cookieHeader: string | string[] | undefined, name: string) {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join(";") : cookieHeader;
  if (!header) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(entry.slice(separator + 1).trim());
  }
  return null;
}

function boundedTtl(value: number | undefined) {
  const fallback = 20 * 60 * 1_000;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value ?? fallback), 60_000), 8 * 60 * 60 * 1_000);
}

export class MarketplaceOperatorSessionManager {
  private readonly accessTokenDigest: Buffer | null;
  private readonly principal: MarketplacePrincipal;
  private readonly ttlMs: number;
  private readonly allowUnauthenticated: boolean;
  private readonly now: () => number;
  private readonly sessions = new Map<string, MarketplaceOperatorSession>();
  private readonly failedLogins = new Map<string, { count: number; resetAtMs: number }>();

  constructor(options: MarketplaceOperatorSessionManagerOptions = {}) {
    const accessToken = options.accessToken?.trim() ?? "";
    this.accessTokenDigest = accessToken.length >= 16 ? digest(accessToken) : null;
    this.principal = {
      kind: "operator",
      id: options.operatorId?.trim() || "operator",
      organizationId: options.organizationId?.trim() || "default",
    };
    this.ttlMs = boundedTtl(options.sessionTtlMs);
    this.allowUnauthenticated = options.allowUnauthenticated === true;
    this.now = options.now ?? Date.now;
  }

  static fromEnvironment(options: { readonly allowUnauthenticated?: boolean } = {}) {
    const ttlSeconds = Number.parseInt(process.env.MARKETPLACE_OPERATOR_SESSION_TTL_SECONDS ?? "", 10);
    return new MarketplaceOperatorSessionManager({
      accessToken: process.env.MARKETPLACE_OPERATOR_ACCESS_TOKEN,
      operatorId: process.env.MARKETPLACE_OPERATOR_ID,
      // TEALBRICK_TENANT_ID is the contract name for the same workspace binding.
      organizationId: process.env.MARKETPLACE_ORGANIZATION_ID ?? process.env.TEALBRICK_TENANT_ID,
      sessionTtlMs: Number.isFinite(ttlSeconds) ? ttlSeconds * 1_000 : undefined,
      allowUnauthenticated: options.allowUnauthenticated,
    });
  }

  status(cookieHeader?: string | string[]): MarketplaceOperatorSessionStatus {
    const session = this.sessionForCookie(cookieHeader);
    if (session) return this.statusForSession(session);
    if (this.allowUnauthenticated) {
      return {
        configured: true,
        authenticated: true,
        mode: "test_bypass",
        principal: this.principal,
        csrfToken: null,
        expiresAt: null,
      };
    }
    if (!this.accessTokenDigest) {
      return {
        configured: false,
        authenticated: false,
        mode: "unconfigured",
        principal: null,
        csrfToken: null,
        expiresAt: null,
      };
    }
    return {
      configured: true,
      authenticated: false,
      mode: "session",
      principal: null,
      csrfToken: null,
      expiresAt: null,
    };
  }

  exchange(accessToken: string, clientKey: string) {
    if (!this.accessTokenDigest) {
      throw new MarketplaceAuthenticationError(
        "operator_auth_unconfigured",
        503,
        "Marketplace operator access is not configured.",
      );
    }
    const now = this.now();
    const failed = this.failedLogins.get(clientKey);
    if (failed && failed.resetAtMs > now && failed.count >= 5) {
      throw new MarketplaceAuthenticationError(
        "operator_rate_limited",
        429,
        "Too many failed unlock attempts. Try again shortly.",
      );
    }
    if (!matchesDigest(accessToken.trim(), this.accessTokenDigest)) {
      const window = failed && failed.resetAtMs > now ? failed : { count: 0, resetAtMs: now + 60_000 };
      window.count += 1;
      this.failedLogins.set(clientKey, window);
      throw new MarketplaceAuthenticationError("operator_unauthorized", 401, "The operator access token is invalid.");
    }
    this.failedLogins.delete(clientKey);
    return this.createSession(this.principal, "access-token");
  }

  issuePortalSession(input: { readonly id: string; readonly organizationId: string; readonly organizationName?: string | null }) {
    const id = input.id.trim();
    const organizationId = input.organizationId.trim();
    if (!id || !organizationId) {
      throw new Error("Portal launch identity must include an operator and organization.");
    }
    const organizationName = input.organizationName?.trim();
    return this.createSession({ kind: "operator", id, organizationId, ...(organizationName ? { organizationName } : {}) }, "portal-launch");
  }

  /**
   * The owner's own session from a Portal launch ticket, with its CSRF token checked here (never bypassed,
   * also not in test mode). Null for anything else: no cookie, an access-token session, the test bypass,
   * a missing or wrong CSRF token. Used by owner-only app state such as the owner Buzz key (§6.3).
   */
  ownerLaunchSession(cookieHeader: string | string[] | undefined, csrfToken: string | string[] | undefined): MarketplacePrincipal | null {
    const session = this.sessionForCookie(cookieHeader);
    if (!session || session.source !== "portal-launch") return null;
    const actual = Array.isArray(csrfToken) ? (csrfToken.length === 1 ? csrfToken[0] : undefined) : csrfToken;
    if (!actual || !matchesDigest(actual, digest(session.csrfToken))) return null;
    return session.principal;
  }

  authenticate(cookieHeader?: string | string[]) {
    if (this.allowUnauthenticated) return this.principal;
    return this.sessionForCookie(cookieHeader)?.principal ?? null;
  }

  csrfMatches(cookieHeader: string | string[] | undefined, csrfToken: string | string[] | undefined) {
    if (this.allowUnauthenticated) return true;
    const session = this.sessionForCookie(cookieHeader);
    const actual = Array.isArray(csrfToken) ? csrfToken[0] : csrfToken;
    return Boolean(session && actual && matchesDigest(actual, digest(session.csrfToken)));
  }

  revoke(cookieHeader?: string | string[]) {
    const token = cookieValue(cookieHeader, MARKETPLACE_OPERATOR_SESSION_COOKIE);
    if (!token) return false;
    return this.sessions.delete(token.slice(0, 16));
  }

  sessionCookie(token: string, secure: boolean, sameSite: "Strict" | "Lax" = "Strict") {
    return `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${Math.floor(this.ttlMs / 1_000)}${secure ? "; Secure" : ""}`;
  }

  clearCookie(secure: boolean) {
    return `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
  }

  private statusForSession(session: MarketplaceOperatorSession): MarketplaceOperatorSessionStatus {
    return {
      configured: true,
      authenticated: true,
      mode: "session",
      principal: session.principal,
      csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
    };
  }

  private createSession(principal: MarketplacePrincipal, source: MarketplaceOperatorSessionSource) {
    this.pruneExpired();
    const now = this.now();
    const token = randomBytes(32).toString("base64url");
    const session: MarketplaceOperatorSession = {
      tokenDigest: digest(token),
      csrfToken: randomBytes(24).toString("base64url"),
      principal,
      expiresAtMs: now + this.ttlMs,
      source,
    };
    this.sessions.set(token.slice(0, 16), session);
    return { token, status: this.statusForSession(session) };
  }

  private sessionForCookie(cookieHeader?: string | string[]) {
    const token = cookieValue(cookieHeader, MARKETPLACE_OPERATOR_SESSION_COOKIE);
    if (!token) return null;
    const key = token.slice(0, 16);
    const session = this.sessions.get(key);
    if (!session || !matchesDigest(token, session.tokenDigest)) return null;
    if (session.expiresAtMs <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  private pruneExpired() {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAtMs <= now) this.sessions.delete(key);
    }
  }
}

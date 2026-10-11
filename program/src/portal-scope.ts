import { agentPolicyFrom } from "./agent-approval-mode.js";
import { createPublicKey, verify as verifySignature } from "node:crypto";

type JsonObject = Record<string, unknown>;

type PortalJwk = JsonObject & {
  kid?: string;
  alg?: string;
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
};

type PortalJwt = {
  header: JsonObject;
  claims: JsonObject;
  signedBytes: Buffer;
  signature: Buffer;
};

export type PortalAgentScope = {
  organizationId: string;
  agentId: string;
  attachmentId: string;
  capabilities: string[];
  expiresAt: number;
  /** Portal's raw `agentPolicy` claim when the verified attachment / agent token carries one (agent-approval-mode.ts). */
  agentPolicy?: unknown;
};

export type PortalAgentScopeVerifier = (input: {
  agentToken: string;
  attachmentToken: string;
  audience: string;
  requiredCapability: string;
}) => Promise<PortalAgentScope>;

export class PortalScopeError extends Error {
  constructor(
    readonly code:
    | "portal_identity_unconfigured"
    | "portal_identity_unavailable"
    | "portal_token_invalid"
    | "portal_capability_denied",
    readonly statusCode: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = "PortalScopeError";
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      `Portal token is missing ${label}.`,
    );
  }
  return value.trim();
}

function base64UrlJson(value: string, label: string): JsonObject {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return asObject(JSON.parse(decoded));
  } catch {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      `Portal token has invalid ${label}.`,
    );
  }
}

function parseJwt(token: string): PortalJwt {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      "Portal token is not a compact JWT.",
    );
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [
    string,
    string,
    string,
  ];
  return {
    header: base64UrlJson(encodedHeader, "header"),
    claims: base64UrlJson(encodedClaims, "claims"),
    signedBytes: Buffer.from(`${encodedHeader}.${encodedClaims}`),
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function numericClaim(claims: JsonObject, name: string) {
  const value = claims[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      `Portal token is missing numeric ${name}.`,
    );
  }
  return value;
}

function audienceMatches(value: unknown, expected: string) {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

function verifyJwt(
  token: string,
  issuer: string,
  jwks: PortalJwk[],
  options: { audience?: string; nowSeconds: number },
) {
  const jwt = parseJwt(token);
  if (jwt.header.alg !== "ES256") {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      "Marketplace accepts only Portal ES256 tokens.",
    );
  }
  const keyId = requiredString(jwt.header.kid, "key id");
  const jwk = jwks.find((candidate) => candidate.kid === keyId);
  if (!jwk) {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      "Portal token key is not published by the configured issuer.",
    );
  }
  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    if (
      !verifySignature(
        "sha256",
        jwt.signedBytes,
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        jwt.signature,
      )
    ) {
      throw new Error("signature mismatch");
    }
  } catch {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      "Portal token signature is invalid.",
    );
  }

  const tokenIssuer = requiredString(jwt.claims.iss, "issuer");
  if (tokenIssuer !== issuer) {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      "Portal token issuer does not match Marketplace configuration.",
    );
  }
  const issuedAt = numericClaim(jwt.claims, "iat");
  const expiresAt = numericClaim(jwt.claims, "exp");
  if (issuedAt > options.nowSeconds + 30 || expiresAt <= options.nowSeconds) {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      "Portal token is not currently valid.",
    );
  }
  if (options.audience && !audienceMatches(jwt.claims.aud, options.audience)) {
    throw new PortalScopeError(
      "portal_token_invalid",
      401,
      "Portal attachment audience does not match Marketplace.",
    );
  }
  return { claims: jwt.claims, issuedAt, expiresAt };
}

export function createPortalAgentScopeVerifier(input: {
  issuer?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
}): PortalAgentScopeVerifier {
  const issuer = input.issuer?.trim().replace(/\/$/u, "") || null;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => Date.now());
  const cacheTtlMs = input.cacheTtlMs ?? 5 * 60_000;
  let cachedJwks: { keys: PortalJwk[]; expiresAt: number } | null = null;

  const loadJwks = async () => {
    if (!issuer) {
      throw new PortalScopeError(
        "portal_identity_unconfigured",
        503,
        "MARKETPLACE_PORTAL_ISSUER_URL is required for agent-scoped Marketplace access.",
      );
    }
    if (cachedJwks && cachedJwks.expiresAt > now()) {
      return cachedJwks.keys;
    }
    let response: Response;
    try {
      response = await fetchImpl(`${issuer}/api/jwks`);
    } catch {
      throw new PortalScopeError(
        "portal_identity_unavailable",
        503,
        "Portal JWKS could not be reached.",
      );
    }
    if (!response.ok) {
      throw new PortalScopeError(
        "portal_identity_unavailable",
        503,
        "Portal JWKS could not be loaded.",
      );
    }
    const payload = asObject(await response.json());
    const keys = Array.isArray(payload.keys)
      ? payload.keys.map(asObject).filter((key) => key.kid)
      : [];
    if (!keys.length) {
      throw new PortalScopeError(
        "portal_identity_unavailable",
        503,
        "Portal JWKS did not publish a usable key.",
      );
    }
    cachedJwks = { keys, expiresAt: now() + cacheTtlMs };
    return keys;
  };

  return async ({ agentToken, attachmentToken, audience, requiredCapability }) => {
    if (!issuer) {
      throw new PortalScopeError(
        "portal_identity_unconfigured",
        503,
        "MARKETPLACE_PORTAL_ISSUER_URL is required for agent-scoped Marketplace access.",
      );
    }
    if (!agentToken.trim() || !attachmentToken.trim()) {
      throw new PortalScopeError(
        "portal_token_invalid",
        401,
        "Portal agent and attachment tokens are required.",
      );
    }
    const jwks = await loadJwks();
    const nowSeconds = Math.floor(now() / 1000);
    const agent = verifyJwt(agentToken, issuer, jwks, { nowSeconds });
    const attachment = verifyJwt(attachmentToken, issuer, jwks, {
      audience,
      nowSeconds,
    });
    if (agent.claims.kind !== "agent") {
      throw new PortalScopeError(
        "portal_token_invalid",
        401,
        "The Portal credential is not an agent credential.",
      );
    }
    if (attachment.claims.typ !== "attachment" || attachment.claims.status !== "active") {
      throw new PortalScopeError(
        "portal_token_invalid",
        401,
        "The Portal credential is not an active attachment.",
      );
    }
    const agentId = requiredString(agent.claims.sub, "agent subject");
    const attachmentAgentId = requiredString(attachment.claims.sub, "attachment subject");
    if (agentId !== attachmentAgentId) {
      throw new PortalScopeError(
        "portal_token_invalid",
        401,
        "Portal agent and attachment subjects do not match.",
      );
    }
    if (attachment.expiresAt - attachment.issuedAt > 300) {
      throw new PortalScopeError(
        "portal_token_invalid",
        401,
        "Portal attachment lifetime exceeds the supported 300-second contract.",
      );
    }
    const organizationId = requiredString(
      agent.claims.org ?? attachment.claims.orgId ?? attachment.claims.org,
      "organization",
    );
    const attachmentOrganizationId = requiredString(
      attachment.claims.orgId ?? attachment.claims.org,
      "attachment organization",
    );
    if (organizationId !== attachmentOrganizationId) {
      throw new PortalScopeError(
        "portal_token_invalid",
        401,
        "Portal agent and attachment organizations do not match.",
      );
    }
    const capabilities = Array.isArray(attachment.claims.capabilities)
      ? attachment.claims.capabilities.filter(
          (capability): capability is string =>
            typeof capability === "string" && Boolean(capability.trim()),
        )
      : [];
    if (!capabilities.includes(requiredCapability)) {
      throw new PortalScopeError(
        "portal_capability_denied",
        403,
        "Portal attachment does not grant the requested Marketplace capability.",
      );
    }
    return {
      organizationId,
      agentId,
      attachmentId: requiredString(attachment.claims.jti, "attachment id"),
      capabilities,
      expiresAt: Math.min(agent.expiresAt, attachment.expiresAt),
      ...(agentPolicyFrom(attachment.claims, agent.claims) !== undefined ? { agentPolicy: agentPolicyFrom(attachment.claims, agent.claims) } : {}),
    };
  };
}

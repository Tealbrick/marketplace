import { createPublicKey, verify as verifySignature } from "node:crypto";

import {
  createPortalHandoffClient,
  PortalHandoffError,
  type MarketplacePortalSelection,
} from "./portal-handoff.js";
import type { ConnectorCapability } from "./types.js";

type JsonObject = Record<string, unknown>;

type PortalRuntimeScope = {
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  deploymentId: string;
  agentId: string;
  consentId: string;
  leaseId: string;
  capabilities: string[];
  expiresAt: number;
};

export class PortalRuntimeScopeError extends Error {
  constructor(
    readonly code:
      | "portal_runtime_unconfigured"
      | "portal_runtime_unavailable"
      | "portal_runtime_invalid"
      | "portal_runtime_denied",
    readonly statusCode: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = "PortalRuntimeScopeError";
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PortalRuntimeScopeError(
      "portal_runtime_invalid",
      401,
      `Runtime lease is missing ${label}.`,
    );
  }
  return value.trim();
}

function numericClaim(claims: JsonObject, label: string) {
  const value = claims[label];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PortalRuntimeScopeError(
      "portal_runtime_invalid",
      401,
      `Runtime lease is missing numeric ${label}.`,
    );
  }
  return value;
}

function audienceMatches(value: unknown, expected: string) {
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

function parseJwt(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new PortalRuntimeScopeError(
      "portal_runtime_invalid",
      401,
      "Runtime lease is not a compact JWT.",
    );
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  try {
    return {
      header: object(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"))),
      claims: object(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8"))),
      signedBytes: Buffer.from(`${encodedHeader}.${encodedClaims}`),
      signature: Buffer.from(encodedSignature, "base64url"),
    };
  } catch {
    throw new PortalRuntimeScopeError(
      "portal_runtime_invalid",
      401,
      "Runtime lease has invalid JWT JSON.",
    );
  }
}

export type PortalRuntimeScopeVerifier = (input: {
  attachmentToken: string;
  selection: MarketplacePortalSelection;
  requiredCapability: ConnectorCapability;
}) => Promise<PortalRuntimeScope>;

export function createPortalRuntimeScopeVerifier(input: {
  issuer?: string | null;
  instanceProof?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
}): PortalRuntimeScopeVerifier {
  const issuer = input.issuer?.trim().replace(/\/$/u, "") || null;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => Date.now());
  const cacheTtlMs = input.cacheTtlMs ?? 5 * 60_000;
  let cachedJwks: { keys: JsonObject[]; expiresAt: number } | null = null;
  const client = createPortalHandoffClient({
    issuer,
    instanceProof: input.instanceProof,
    fetchImpl,
  });

  const loadJwks = async () => {
    if (!issuer || !input.instanceProof?.trim()) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_unconfigured",
        503,
        "Marketplace Portal issuer and instance proof are required for runtime leases.",
      );
    }
    if (cachedJwks && cachedJwks.expiresAt > now()) return cachedJwks.keys;
    let response: Response;
    try {
      response = await fetchImpl(`${issuer}/api/jwks`);
    } catch {
      throw new PortalRuntimeScopeError(
        "portal_runtime_unavailable",
        503,
        "Portal JWKS could not be reached.",
      );
    }
    if (!response.ok) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_unavailable",
        503,
        "Portal JWKS could not be loaded.",
      );
    }
    const payload = object(await response.json());
    const keys = Array.isArray(payload.keys)
      ? payload.keys.map(object).filter((key) => typeof key.kid === "string")
      : [];
    if (!keys.length) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_unavailable",
        503,
        "Portal JWKS did not publish a usable key.",
      );
    }
    cachedJwks = { keys, expiresAt: now() + cacheTtlMs };
    return keys;
  };

  return async ({ attachmentToken, selection, requiredCapability }) => {
    if (!issuer || !input.instanceProof?.trim()) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_unconfigured",
        503,
        "Marketplace Portal issuer and instance proof are required for runtime leases.",
      );
    }
    if (!attachmentToken.trim()) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_invalid",
        401,
        "A Portal runtime lease is required.",
      );
    }
    const jwt = parseJwt(attachmentToken);
    if (jwt.header.alg !== "ES256") {
      throw new PortalRuntimeScopeError(
        "portal_runtime_invalid",
        401,
        "Marketplace accepts only Portal ES256 runtime leases.",
      );
    }
    const keyId = requiredString(jwt.header.kid, "key id");
    const jwk = (await loadJwks()).find((candidate) => candidate.kid === keyId);
    if (!jwk) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_invalid",
        401,
        "Runtime lease key is not published by Portal.",
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
      throw new PortalRuntimeScopeError(
        "portal_runtime_invalid",
        401,
        "Runtime lease signature is invalid.",
      );
    }
    const claims = jwt.claims;
    if (
      requiredString(claims.iss, "issuer") !== issuer ||
      !audienceMatches(claims.aud, "marketplace") ||
      claims.typ !== "attachment" ||
      claims.purpose !== "marketplace-runtime" ||
      claims.kind !== undefined ||
      claims.status !== "active"
    ) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_invalid",
        401,
        "Runtime lease claims are not valid for Marketplace.",
      );
    }
    const nowSeconds = Math.floor(now() / 1000);
    const issuedAt = numericClaim(claims, "iat");
    const expiresAt = numericClaim(claims, "exp");
    if (issuedAt > nowSeconds || expiresAt <= nowSeconds || expiresAt - issuedAt > 300) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_invalid",
        401,
        "Runtime lease is expired or exceeds the supported lifetime.",
      );
    }
    const deploymentId = requiredString(claims.deploymentId, "deployment id");
    const agentId = requiredString(claims.sub, "agent subject");
    const consentId = requiredString(claims.consentId, "consent id");
    const leaseId = requiredString(claims.jti, "lease id");
    const capabilities = Array.isArray(claims.capabilities)
      ? claims.capabilities.filter(
          (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
        )
      : [];
    if (!capabilities.includes(requiredCapability)) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_denied",
        403,
        "Runtime lease does not grant the requested Marketplace capability.",
      );
    }
    let introspected: Awaited<ReturnType<ReturnType<typeof createPortalHandoffClient>["introspect"]>>;
    try {
      introspected = await client.introspect({
        deploymentId,
        attachment: attachmentToken,
        selection,
      });
    } catch (error) {
      if (error instanceof PortalHandoffError) {
        const mapped =
          error.code === "portal_handoff_unavailable"
            ? "portal_runtime_unavailable"
            : error.statusCode === 401
              ? "portal_runtime_invalid"
              : "portal_runtime_denied";
        throw new PortalRuntimeScopeError(mapped, mapped === "portal_runtime_unavailable" ? 503 : error.statusCode === 401 ? 401 : 403, "Portal runtime authorization was denied.");
      }
      throw error;
    }
    if (
      introspected.deploymentId !== deploymentId ||
      introspected.agentId !== agentId ||
      introspected.consentId !== consentId ||
      introspected.leaseId !== leaseId ||
      introspected.portalOrgId !== requiredString(claims.orgId ?? claims.org, "organization") ||
      introspected.productTenantId !== requiredString(claims.productTenantId, "product tenant") ||
      introspected.workspaceId !== requiredString(claims.workspaceId, "workspace") ||
      introspected.expiresAt > expiresAt * 1000 ||
      !introspected.capabilities.includes(requiredCapability)
    ) {
      throw new PortalRuntimeScopeError(
        "portal_runtime_denied",
        403,
        "Portal runtime authorization does not match the attested lease.",
      );
    }
    return {
      portalOrgId: introspected.portalOrgId,
      productTenantId: introspected.productTenantId,
      workspaceId: introspected.workspaceId,
      deploymentId: introspected.deploymentId,
      agentId: introspected.agentId,
      consentId: introspected.consentId,
      leaseId: introspected.leaseId,
      capabilities: introspected.capabilities,
      expiresAt: introspected.expiresAt,
    };
  };
}

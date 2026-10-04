import type { ConnectorCapability } from "./types.js";

export const MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION =
  "tealbrick.marketplace.operator-handoff.v1.1" as const;

/**
 * Portal selection. v1.1 is the five identity keys (capability observe is
 * implied); Portal Core contract v1.2 additionally accepts `capability`.
 * Marketplace sends `capability` only for non-observe actions, so observe
 * selections stay byte-identical for Portal deployments that predate v1.2.
 */
export type MarketplacePortalSelection = {
  pluginId: string;
  actionKey: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  capability?: ConnectorCapability;
};

export type MarketplacePortalConsentEnvelope = {
  schema: 1;
  authorized: boolean;
  product: "marketplace";
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  deploymentId: string;
  userId: string;
  agentId: string;
  consentId: string | null;
  consentRevision: number;
  state: "pending" | "active" | "revoked" | "approved" | "denied";
  capabilities: ConnectorCapability[];
  requiredActions: string[];
  selection: MarketplacePortalSelection;
};

export type MarketplacePortalLaunchSession = {
  schema: 1;
  authorized: true;
  product: "marketplace";
  deploymentId: string;
  workspaceId: string;
  portalOrgId: string;
  productTenantId: string;
  userId: string;
  endpoint: string;
  session: string;
  expiresAt: number;
};

export type MarketplacePortalGrantRequest = {
  requestId: string;
  approvalUrl: string;
  expiresAt: number;
};

export type MarketplacePortalIntrospection = {
  schema: 1;
  authorized: true;
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  deploymentId: string;
  agentId: string;
  consentId: string;
  consentRevision: number;
  leaseId: string;
  capabilities: ConnectorCapability[];
  expiresAt: number;
};

export class PortalHandoffError extends Error {
  constructor(
    readonly code:
      | "portal_handoff_unconfigured"
      | "portal_handoff_unavailable"
      | "portal_handoff_denied"
      | "portal_handoff_invalid",
    readonly statusCode: 400 | 401 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "PortalHandoffError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PortalHandoffError(
      "portal_handoff_invalid",
      503,
      `Portal handoff response is missing ${label}.`,
    );
  }
  return value.trim();
}

function opaque(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function numberValue(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PortalHandoffError(
      "portal_handoff_invalid",
      503,
      `Portal handoff response is missing numeric ${label}.`,
    );
  }
  return value;
}

function capabilities(value: unknown): ConnectorCapability[] {
  if (!Array.isArray(value)) {
    throw new PortalHandoffError(
      "portal_handoff_invalid",
      503,
      "Portal handoff response has invalid capabilities.",
    );
  }
  return value.filter(
    (entry): entry is ConnectorCapability =>
      entry === "connector.observe" ||
      entry === "connector.dispatch" ||
      entry === "connector.admin",
  );
}

function selection(value: unknown): MarketplacePortalSelection {
  const input = object(value);
  const result: MarketplacePortalSelection = {
    pluginId: requiredString(input.pluginId, "selection.pluginId"),
    actionKey: requiredString(input.actionKey, "selection.actionKey"),
    accountId: requiredString(input.accountId, "selection.accountId"),
    resourceKind: requiredString(input.resourceKind, "selection.resourceKind"),
    resourceRef: requiredString(input.resourceRef, "selection.resourceRef"),
  };
  if (input.capability !== undefined && input.capability !== null) {
    if (
      input.capability !== "connector.observe" &&
      input.capability !== "connector.dispatch" &&
      input.capability !== "connector.admin"
    ) {
      throw new PortalHandoffError(
        "portal_handoff_invalid",
        503,
        "Portal handoff response has an invalid selection capability.",
      );
    }
    result.capability = input.capability;
  }
  if (result.resourceRef !== `account:${result.accountId}`) {
    throw new PortalHandoffError(
      "portal_handoff_invalid",
      503,
      "Portal handoff response has an invalid resource binding.",
    );
  }
  return result;
}

function consentEnvelope(value: unknown): MarketplacePortalConsentEnvelope {
  const input = object(value);
  if (
    input.schema !== 1 ||
    input.authorized !== true ||
    input.product !== "marketplace"
  ) {
    throw new PortalHandoffError(
      "portal_handoff_invalid",
      503,
      "Portal handoff response is not an authorized Marketplace envelope.",
    );
  }
  const state = input.state;
  if (
    state !== "pending" &&
    state !== "active" &&
    state !== "revoked" &&
    state !== "approved" &&
    state !== "denied"
  ) {
    throw new PortalHandoffError(
      "portal_handoff_invalid",
      503,
      "Portal handoff response has an invalid consent state.",
    );
  }
  return {
    schema: 1,
    authorized: true,
    product: "marketplace",
    portalOrgId: requiredString(input.portalOrgId, "portalOrgId"),
    productTenantId: requiredString(input.productTenantId, "productTenantId"),
    workspaceId: requiredString(input.workspaceId, "workspaceId"),
    deploymentId: requiredString(input.deploymentId, "deploymentId"),
    userId: requiredString(input.userId, "userId"),
    agentId: requiredString(input.agentId, "agentId"),
    consentId:
      input.consentId === null
        ? null
        : requiredString(input.consentId, "consentId"),
    consentRevision: Math.max(1, Math.floor(numberValue(input.consentRevision, "consentRevision"))),
    state,
    capabilities: capabilities(input.capabilities),
    requiredActions: Array.isArray(input.requiredActions)
      ? input.requiredActions.filter(
          (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
        )
      : [],
    selection: selection(input.selection),
  };
}

export function createPortalHandoffClient(input: {
  issuer?: string | null;
  instanceProof?: string | null;
  fetchImpl?: typeof fetch;
}): {
  redeemLaunchTicket(input: { deploymentId: string; ticket: string }): Promise<MarketplacePortalLaunchSession>;
  requestGrant(input: {
    deploymentId: string;
    session: string;
    agentId: string;
    selection: MarketplacePortalSelection;
    idempotencyKey: string;
  }): Promise<MarketplacePortalGrantRequest>;
  redeemGrant(input: {
    deploymentId: string;
    session: string;
    requestId: string;
  }): Promise<MarketplacePortalConsentEnvelope>;
  receipt(input: {
    deploymentId: string;
    session: string;
    requestId: string;
  }): Promise<MarketplacePortalConsentEnvelope>;
  introspect(input: {
    deploymentId: string;
    attachment: string;
    selection: MarketplacePortalSelection;
  }): Promise<MarketplacePortalIntrospection>;
} {
  const issuer = input.issuer?.trim().replace(/\/$/u, "") || null;
  const instanceProof = input.instanceProof?.trim() || null;
  const fetchImpl = input.fetchImpl ?? fetch;

  async function post(path: string, body: Record<string, unknown>) {
    if (!issuer || !instanceProof) {
      throw new PortalHandoffError(
        "portal_handoff_unconfigured",
        503,
        "Marketplace Portal issuer and instance proof are required.",
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${issuer}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-tealbrick-instance-proof": instanceProof,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new PortalHandoffError(
        "portal_handoff_unavailable",
        503,
        "Portal handoff is unavailable.",
      );
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const code = object(payload).error;
      const status = [400, 401, 403, 409].includes(response.status)
        ? (response.status as 400 | 401 | 403 | 409)
        : 503;
      throw new PortalHandoffError(
        status === 503 ? "portal_handoff_unavailable" : "portal_handoff_denied",
        status,
        typeof code === "string" && code ? code : "Portal handoff was denied.",
      );
    }
    return object(payload);
  }

  return {
    async redeemLaunchTicket(request) {
      const payload = await post("/api/deployment-browser/redeem", {
        schema: 1,
        product: "marketplace",
        deploymentId: request.deploymentId,
        ticket: request.ticket,
      });
      if (
        payload.schema !== 1 ||
        payload.authorized !== true ||
        payload.product !== "marketplace" ||
        !opaque(payload.session)
      ) {
        throw new PortalHandoffError(
          "portal_handoff_invalid",
          503,
          "Portal launch did not return a valid Marketplace session.",
        );
      }
      return {
        schema: 1,
        authorized: true,
        product: "marketplace",
        deploymentId: requiredString(payload.deploymentId, "deploymentId"),
        workspaceId: requiredString(payload.workspaceId, "workspaceId"),
        portalOrgId: requiredString(payload.orgId, "orgId"),
        productTenantId: requiredString(payload.productTenantId, "productTenantId"),
        userId: requiredString(payload.userId, "userId"),
        endpoint: requiredString(payload.endpoint, "endpoint"),
        session: payload.session as string,
        expiresAt: numberValue(payload.expiresAt, "expiresAt"),
      };
    },
    async requestGrant(request) {
      const payload = await post("/api/deployment-browser/grant-request", {
        schema: 1,
        product: "marketplace",
        deploymentId: request.deploymentId,
        session: request.session,
        agentId: request.agentId,
        selection: request.selection,
        idempotencyKey: request.idempotencyKey,
      });
      if (!opaque(payload.requestId)) {
        throw new PortalHandoffError(
          "portal_handoff_invalid",
          503,
          "Portal grant request did not return an opaque request id.",
        );
      }
      return {
        requestId: payload.requestId as string,
        approvalUrl: requiredString(payload.approvalUrl, "approvalUrl"),
        expiresAt: numberValue(payload.expiresAt, "expiresAt"),
      };
    },
    async redeemGrant(request) {
      const payload = await post("/api/deployment-browser/grant-redeem", {
        schema: 1,
        product: "marketplace",
        deploymentId: request.deploymentId,
        session: request.session,
        requestId: request.requestId,
      });
      return consentEnvelope(payload);
    },
    async receipt(request) {
      const payload = await post("/api/deployment-browser/grant-receipt", {
        schema: 1,
        product: "marketplace",
        deploymentId: request.deploymentId,
        session: request.session,
        requestId: request.requestId,
      });
      return consentEnvelope(payload);
    },
    async introspect(request) {
      const payload = await post("/api/deployment-browser/grant-introspect", {
        schema: 1,
        product: "marketplace",
        deploymentId: request.deploymentId,
        attachment: request.attachment,
        selection: request.selection,
      });
      if (payload.schema !== 1 || payload.authorized !== true) {
        throw new PortalHandoffError(
          "portal_handoff_invalid",
          503,
          "Portal introspection did not return an authorized response.",
        );
      }
      return {
        schema: 1,
        authorized: true,
        portalOrgId: requiredString(payload.portalOrgId, "portalOrgId"),
        productTenantId: requiredString(payload.productTenantId, "productTenantId"),
        workspaceId: requiredString(payload.workspaceId, "workspaceId"),
        deploymentId: requiredString(payload.deploymentId, "deploymentId"),
        agentId: requiredString(payload.agentId, "agentId"),
        consentId: requiredString(payload.consentId, "consentId"),
        consentRevision: Math.max(1, Math.floor(numberValue(payload.consentRevision, "consentRevision"))),
        leaseId: requiredString(payload.leaseId, "leaseId"),
        capabilities: capabilities(payload.capabilities),
        expiresAt: numberValue(payload.expiresAt, "expiresAt"),
      };
    },
  };
}

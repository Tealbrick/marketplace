export type RulesReadinessConfiguration = {
  baseUrl: string;
  internalAuthToken?: string;
  companyId?: string;
};

export type RulesReadinessPrincipal = {
  active: true;
  kind: "scoped-evaluation";
  credentialId: string;
  companyId: string;
  workspaceSlug: string;
  clientId: "marketplace";
  targetKind: "plugin";
  allowedMethods: ["doppelganger.rules.evaluate"];
  allowedRuleKeys: ["marketplace.plugin"];
  expiresAt: string;
};

const RULES_INTROSPECTION_PATH = "/api/rules/gateway/introspect";

export { RULES_INTROSPECTION_PATH };

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the Rules-side authenticated principal response. This is metadata
 * about the scoped evaluation credential, not a business-policy decision.
 */
export function parseRulesReadinessPrincipal(input: {
  response: unknown;
  organizationId: string;
  expectedCompanyId?: string;
}): RulesReadinessPrincipal {
  const response = objectValue(input.response);
  const principal = objectValue(response?.principal);
  const expectedCompanyId = input.expectedCompanyId ?? input.organizationId;
  const allowedMethods = principal?.allowedMethods;
  const allowedRuleKeys = principal?.allowedRuleKeys;
  const expiresAt = principal?.expiresAt;

  if (
    response?.ok !== true ||
    principal?.active !== true ||
    principal?.kind !== "scoped-evaluation" ||
    principal?.clientId !== "marketplace" ||
    principal?.targetKind !== "plugin" ||
    principal?.companyId !== expectedCompanyId ||
    principal?.workspaceSlug !== input.organizationId ||
    !nonEmptyString(principal.credentialId) ||
    !Array.isArray(allowedMethods) ||
    allowedMethods.length !== 1 ||
    allowedMethods[0] !== "doppelganger.rules.evaluate" ||
    !Array.isArray(allowedRuleKeys) ||
    allowedRuleKeys.length !== 1 ||
    allowedRuleKeys[0] !== "marketplace.plugin" ||
    !nonEmptyString(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  ) {
    throw new Error("rules_readiness_principal_invalid");
  }

  return {
    active: true,
    kind: "scoped-evaluation",
    credentialId: principal.credentialId,
    companyId: principal.companyId,
    workspaceSlug: principal.workspaceSlug,
    clientId: "marketplace",
    targetKind: "plugin",
    allowedMethods: ["doppelganger.rules.evaluate"],
    allowedRuleKeys: ["marketplace.plugin"],
    expiresAt,
  };
}

import type { MarketplaceConfig } from "./config.js";
import type { RulesClient, RulesDecision } from "./types.js";

const OPERATOR_CONFIRMED_CONNECTOR_OPERATIONS = new Set([
  "install",
  "uninstall",
  "register",
  "unregister",
  "composio.connect",
  "composio.import",
  "connector.connection.register",
  "capability.bind",
  "action.bind",
  "hub.mcp.create",
  "hub.mcp.update",
  "hub.mcp.delete",
  "hub.lifecycle.install",
  "hub.lifecycle.enable",
  "hub.lifecycle.disable",
  "hub.lifecycle.reload",
  "hub.lifecycle.uninstall",
]);

const AGENT_ENABLED_CONNECTOR_CAPABILITIES = new Set([
  "connector.observe",
  "connector.dispatch",
]);

function roleForActor(actorId: string): "agent" | "operator" {
  const normalized = actorId.trim().toLowerCase();
  return normalized === "agent" ||
    normalized === "doppelganger-agent" ||
    normalized.startsWith("agent-") ||
    normalized.startsWith("agent:")
    ? "agent"
    : "operator";
}

function isMissingPolicyDenial(reason: unknown): reason is string {
  return (
    typeof reason === "string" &&
    reason.includes("no live ruleset matched this request")
  );
}

function failedClosedDecision(reason: string): RulesDecision {
  return {
    effect: "deny",
    reason,
  };
}

function isAgentGrantPolicyPath(input: {
  operation: string;
  payload: Record<string, unknown>;
}) {
  const contractVersion = input.payload.contractVersion;
  return (
    input.operation === "execute" &&
    (typeof input.payload.agentGrantId === "string" ||
      contractVersion === "doppelganger.marketplace.agent-connector-grant.v1" ||
      (typeof contractVersion === "string" &&
        contractVersion.startsWith("tealbrick.marketplace.operator-handoff.v1.")))
  );
}

export function makeRulesClient(
  config: MarketplaceConfig,
): RulesClient | undefined {
  const rules = config.rules;
  if (!rules) {
    return undefined;
  }

  return async (input) => {
    try {
      const companyId = rules.companyId ?? input.workspaceSlug;
      const actorRole = roleForActor(input.actorId);
      const response = await fetch(
        new URL("/api/rules/gateway/evaluate", rules.baseUrl),
        {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(rules.internalAuthToken
            ? { authorization: `Bearer ${rules.internalAuthToken}` }
            : {}),
        },
        body: JSON.stringify({
          method: "doppelganger.rules.evaluate",
          params: {
            companyId,
            ruleKey: "marketplace.plugin",
            operation: input.operation,
            actor: {
              kind: actorRole,
              id: input.actorId,
              roles: [actorRole],
              companyId,
            },
            target: {
              kind: "plugin",
              id: input.pluginId,
              pluginId: input.pluginId,
              capability: input.capability,
              companyId,
            },
            payload: {
              ...input.payload,
              capability: input.capability,
              pluginId: input.pluginId,
            },
            runtimeContext: {
              surface: "capabilities.plugins",
              lane: actorRole,
              session: {
                sessionKey: `marketplace:${input.workspaceSlug}`,
              },
            },
          },
        }),
        },
      );
      const parsed = (await response.json().catch(() => ({}))) as {
        allowed?: unknown;
        effect?: unknown;
        decisionId?: unknown;
        id?: unknown;
        traceId?: unknown;
        reason?: unknown;
      };

      if (!response.ok) {
        return failedClosedDecision(
          `Rules request failed closed with HTTP ${response.status}.`,
        );
      }
      const effect =
        parsed.allowed === true
          ? "allow"
          : parsed.allowed === false
            ? "deny"
            : parsed.effect;
      if (effect !== "allow" && effect !== "deny" && effect !== "review") {
        return failedClosedDecision(
          "Rules response was invalid; failed closed.",
        );
      }

      if (
        effect === "deny" &&
        input.actorId === "operator" &&
        input.capability === "connector.admin" &&
        OPERATOR_CONFIRMED_CONNECTOR_OPERATIONS.has(input.operation) &&
        isMissingPolicyDenial(parsed.reason)
      ) {
        return {
          effect: "allow",
          decisionId: `operator-confirmed:${input.operation}:${input.pluginId}`,
          reason:
            "Operator-confirmed connector lifecycle action; no explicit Rules policy matched.",
        };
      }

      if (
        effect === "deny" &&
        actorRole === "agent" &&
        input.operation === "execute" &&
        AGENT_ENABLED_CONNECTOR_CAPABILITIES.has(input.capability) &&
        !isAgentGrantPolicyPath(input) &&
        isMissingPolicyDenial(parsed.reason)
      ) {
        return {
          effect: "allow",
          decisionId: `operator-enabled:execute:${input.pluginId}`,
          reason:
            "Operator-enabled connector action and capability binding remain authoritative when no explicit Rules policy matched.",
        };
      }

      return {
        effect,
        ...(typeof parsed.decisionId === "string"
          ? { decisionId: parsed.decisionId }
          : typeof parsed.id === "string"
            ? { decisionId: parsed.id }
            : typeof parsed.traceId === "string"
              ? { decisionId: parsed.traceId }
              : {}),
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      };
    } catch (error) {
      return failedClosedDecision(
        error instanceof Error
          ? `Rules request failed closed: ${error.message}`
          : "Rules request failed closed.",
      );
    }
  };
}

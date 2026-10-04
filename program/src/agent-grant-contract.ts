import {
  AGENT_FORBIDDEN_ARGUMENTS,
  type AgentActionCatalogEntry,
} from "./agent-action-catalog.js";
import type { AgentConnectorGrant } from "./types.js";

export const MARKETPLACE_AGENT_GRANT_CONTRACT_VERSION =
  "doppelganger.marketplace.agent-connector-grant.v1" as const;

/**
 * Bind a scoped grant's action to the live published catalog entry.
 *
 * `entry` must come from `resolvePublishedAgentAction` for the grant's
 * workspace, plugin and action at call time; `null` means the action is no
 * longer published (uninstalled, disconnected, disabled, or unknown).
 */
export function applyScopedResource(input: {
  action: Record<string, unknown>;
  grant: Pick<
    AgentConnectorGrant,
    "pluginId" | "actionKey" | "accountId" | "resourceKind" | "resourceRef"
  >;
  entry: AgentActionCatalogEntry | null;
}) {
  const { entry, grant } = input;
  if (
    !entry ||
    entry.pluginId !== grant.pluginId ||
    entry.actionKey !== grant.actionKey ||
    grant.resourceKind !== entry.resourceKind ||
    !grant.accountId.trim() ||
    grant.resourceRef !== `account:${grant.accountId}`
  ) {
    return { ok: false as const, error: "resource_mapping_unsupported" };
  }
  if (!entry.accounts.some((account) => account.accountId === grant.accountId)) {
    return { ok: false as const, error: "agent_grant_connection_mismatch" };
  }
  const unsupportedArguments = Object.keys(input.action).filter(
    (key) =>
      key !== "type" &&
      (AGENT_FORBIDDEN_ARGUMENTS.has(key) ||
        (entry.allowedArguments !== null && !entry.allowedArguments.includes(key))),
  );
  if (unsupportedArguments.length > 0) {
    return { ok: false as const, error: "provider_argument_invalid" };
  }
  return {
    ok: true as const,
    action: input.action,
  };
}

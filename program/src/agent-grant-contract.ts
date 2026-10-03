import type { AgentConnectorGrant } from "./types.js";

export const MARKETPLACE_AGENT_GRANT_CONTRACT_VERSION =
  "doppelganger.marketplace.agent-connector-grant.v1" as const;

export type ScopedResourceMapping = {
  resourceKind: string;
  providerArgument: string | null;
  mode: "connected-account";
  allowedArguments: readonly string[];
};

const SUPPORTED_RESOURCE_MAPPING: {
  pluginId: string;
  actionKey: string;
  toolName: string;
  capability: "connector.observe";
  resourceKind: string;
  providerArgument: string | null;
  mode: "connected-account";
  allowedArguments: readonly string[];
} = {
  pluginId: "github-composio",
  actionKey: "github.list.repositories",
  toolName: "GITHUB_LIST_REPOSITORIES",
  capability: "connector.observe",
  resourceKind: "github.connected-account",
  providerArgument: null,
  mode: "connected-account",
  allowedArguments: [
    "page",
    "sort",
    "type",
    "since",
    "before",
    "per_page",
    "direction",
    "visibility",
    "affiliation",
  ],
};

export function scopedResourceMapping(input: {
  pluginId: string;
  actionKey: string;
}) {
  if (
    input.pluginId !== SUPPORTED_RESOURCE_MAPPING.pluginId ||
    input.actionKey !== SUPPORTED_RESOURCE_MAPPING.actionKey
  ) {
    return null;
  }
  return {
    resourceKind: SUPPORTED_RESOURCE_MAPPING.resourceKind,
    providerArgument: SUPPORTED_RESOURCE_MAPPING.providerArgument,
    mode: SUPPORTED_RESOURCE_MAPPING.mode,
    allowedArguments: SUPPORTED_RESOURCE_MAPPING.allowedArguments,
    capability: SUPPORTED_RESOURCE_MAPPING.capability,
    toolName: SUPPORTED_RESOURCE_MAPPING.toolName,
  } satisfies ScopedResourceMapping & {
    capability: "connector.observe";
    toolName: string;
  };
}

export function applyScopedResource(input: {
  action: Record<string, unknown>;
  grant: AgentConnectorGrant;
}) {
  const mapping = scopedResourceMapping({
    pluginId: input.grant.pluginId,
    actionKey: input.grant.actionKey,
  });
  if (
    !mapping ||
    input.grant.resourceKind !== mapping.resourceKind ||
    input.grant.resourceRef !== `account:${input.grant.accountId}` ||
    !input.grant.resourceRef.trim()
  ) {
    return { ok: false as const, error: "resource_mapping_unsupported" };
  }
  const unsupportedArguments = Object.keys(input.action).filter(
    (key) => key !== "type" && !mapping.allowedArguments.includes(key),
  );
  if (unsupportedArguments.length > 0) {
    return { ok: false as const, error: "provider_argument_invalid" };
  }
  return {
    ok: true as const,
    action: input.action,
  };
}

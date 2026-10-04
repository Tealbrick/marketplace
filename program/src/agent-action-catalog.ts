import { resolveActionRequirement } from "./connectors.js";
import {
  customMcpManifest,
  customMcpToolForAction,
  listingIsOperatorCustomMcp,
} from "./custom-mcp.js";
import type { SqliteMarketplaceStore } from "./store.js";
import type {
  ConnectorCapability,
  ConnectorConnection,
  MarketplaceListing,
} from "./types.js";

/**
 * The Marketplace-published agent action catalog.
 *
 * An entry exists only while the workspace can actually use the action:
 * the listing is registered, installed and enabled, executable for agents,
 * connected to an account, the action is enabled, and the capability binding
 * the action requires is enabled. Every grant, consent and runtime path
 * resolves against this live state, so uninstalling, disconnecting or
 * disabling an action revokes its usability without touching stored grants.
 */
export const MARKETPLACE_AGENT_ACTION_CATALOG_CONTRACT_VERSION =
  "doppelganger.marketplace.agent-action-catalog.v1" as const;

/** Selection-contract identifier shapes shared with the Portal handoff. */
export const AGENT_SELECTION_PLUGIN_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/u;
export const AGENT_SELECTION_ACTION_KEY_PATTERN =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,7}$/u;
export const AGENT_SELECTION_ACTION_KEY_MAX_LENGTH = 128;
export const AGENT_SELECTION_RESOURCE_KIND_PATTERN =
  /^[a-z0-9][a-z0-9-]{0,63}\.connected-account$/u;
export const AGENT_SELECTION_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_:-]{1,128}$/u;

/**
 * Provider arguments that would re-target a call at a different account or
 * identity. The connected account is always supplied by Marketplace from the
 * live connection, never by the caller.
 */
export const AGENT_FORBIDDEN_ARGUMENTS: ReadonlySet<string> = new Set([
  "connected_account_id",
  "connectedAccountId",
  "connected_account",
  "user_id",
  "userId",
  "entity_id",
  "entityId",
]);

export type AgentActionCatalogAccount = {
  accountId: string;
  label?: string;
};

export type AgentActionCatalogEntry = {
  pluginId: string;
  pluginName: string;
  provider: string;
  actionKey: string;
  label: string;
  description: string;
  capability: ConnectorCapability;
  resourceKind: string;
  mode: "connected-account";
  accounts: AgentActionCatalogAccount[];
  allowedArguments: string[] | null;
  toolName: string;
};

export type AgentActionCatalogStore = Pick<
  SqliteMarketplaceStore,
  | "listListingsForWorkspace"
  | "getListingForWorkspace"
  | "isRegistered"
  | "getInstall"
  | "getConnection"
  | "isActionEnabled"
  | "listEnabledBindings"
>;

/**
 * Legacy published GitHub repository-list action. Existing Portal consents
 * and Marketplace grants were minted against exactly this tool, resource kind
 * and argument allowlist, so the entry stays byte-for-byte stable.
 */
const LEGACY_GITHUB_LIST_REPOSITORIES = {
  pluginId: "github-composio",
  actionKey: "github.list.repositories",
  toolName: "GITHUB_LIST_REPOSITORIES",
  resourceKind: "github.connected-account",
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
} as const;

/**
 * Synthetic account for custom MCP connectors. They authenticate with
 * operator-configured headers rather than a provider account, so the
 * connector itself is the one account an agent can be scoped to.
 */
export const CUSTOM_MCP_AGENT_ACCOUNT_ID = "connector" as const;

/** Operator custom MCP connector owned by `workspaceSlug`. */
export function listingIsAgentCustomMcp(
  listing: MarketplaceListing,
  workspaceSlug: string,
) {
  return (
    listing.executionOwner === "mcp" &&
    listingIsOperatorCustomMcp(listing) &&
    listing.ownerWorkspaceSlug === workspaceSlug
  );
}

/**
 * Whether Marketplace can execute this listing's actions on behalf of an
 * agent in `workspaceSlug`: Composio-backed listings, and operator custom
 * MCP connectors owned by that workspace. Another workspace's custom
 * connector is never executable.
 */
export function listingExecutableForAgents(
  listing: MarketplaceListing,
  workspaceSlug: string,
) {
  return (
    listing.executionOwner === "composio" ||
    listingIsAgentCustomMcp(listing, workspaceSlug)
  );
}

/**
 * The account an agent grant binds to for this listing's live connection:
 * the Composio connected account, or the synthetic connector account for a
 * custom MCP connector whose last tool refresh succeeded. `undefined` when
 * nothing usable is connected.
 */
export function agentAccountIdForConnection(input: {
  listing: MarketplaceListing;
  workspaceSlug: string;
  connection: ConnectorConnection | null | undefined;
}) {
  if (input.connection?.state !== "connected") return undefined;
  if (listingIsAgentCustomMcp(input.listing, input.workspaceSlug)) {
    return customMcpManifest(input.listing).lastRefresh?.ok === true
      ? CUSTOM_MCP_AGENT_ACCOUNT_ID
      : undefined;
  }
  return connectedAccountIdFromConnection(input.connection);
}

export function connectedAccountIdFromConnection(
  connection: { metadata: Record<string, unknown> } | null | undefined,
) {
  const value =
    connection?.metadata.connectedAccountId ??
    connection?.metadata.connected_account_id ??
    connection?.metadata.connectionId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The capability a Portal selection carries; absent means observe (v1.1). */
export function selectionCapability(selection: {
  capability?: ConnectorCapability | null;
}): ConnectorCapability {
  return selection.capability ?? "connector.observe";
}

export function agentResourceKindForProvider(provider: string) {
  return `${provider}.connected-account`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function composioToolRecord(listing: MarketplaceListing, actionKey: string) {
  const composio = recordValue(listing.manifest.composio);
  const tools = Array.isArray(composio?.tools) ? composio.tools : [];
  for (const tool of tools) {
    const record = recordValue(tool);
    if (record?.action === actionKey) return record;
  }
  return undefined;
}

function allowedArgumentsFromTool(tool: Record<string, unknown> | undefined) {
  const names = tool?.inputArguments;
  if (!Array.isArray(names)) return null;
  return allowedArgumentNames(names);
}

function allowedArgumentNames(names: readonly unknown[]) {
  return [
    ...new Set(
      names.filter(
        (name): name is string =>
          typeof name === "string" &&
          Boolean(name.trim()) &&
          name !== "type" &&
          !AGENT_FORBIDDEN_ARGUMENTS.has(name),
      ),
    ),
  ];
}

function accountLabel(connection: ConnectorConnection) {
  return (
    stringValue(connection.metadata.accountLabel) ??
    stringValue(connection.metadata.accountName)
  );
}

function selectionShapeIsValid(input: {
  pluginId: string;
  actionKey: string;
  resourceKind: string;
}) {
  return (
    AGENT_SELECTION_PLUGIN_ID_PATTERN.test(input.pluginId) &&
    input.actionKey.length <= AGENT_SELECTION_ACTION_KEY_MAX_LENGTH &&
    AGENT_SELECTION_ACTION_KEY_PATTERN.test(input.actionKey) &&
    AGENT_SELECTION_RESOURCE_KIND_PATTERN.test(input.resourceKind)
  );
}

function entriesForListing(input: {
  store: AgentActionCatalogStore;
  workspaceSlug: string;
  listing: MarketplaceListing;
  enabledCapabilities: ReadonlySet<string>;
  onlyActionKey?: string;
}): AgentActionCatalogEntry[] {
  const { store, workspaceSlug, listing } = input;
  if (!listingExecutableForAgents(listing, workspaceSlug)) return [];
  if (!store.isRegistered(listing.pluginId)) return [];
  const install = store.getInstall(workspaceSlug, listing.pluginId);
  if (!install?.enabled || install.lifecycle !== "installed") return [];
  const connection = store.getConnection(workspaceSlug, listing.pluginId);
  const accountId = agentAccountIdForConnection({ listing, workspaceSlug, connection });
  if (
    !connection ||
    !accountId ||
    !AGENT_SELECTION_ACCOUNT_ID_PATTERN.test(accountId)
  ) {
    return [];
  }
  const customMcp = listingIsAgentCustomMcp(listing, workspaceSlug);
  const label = customMcp ? listing.displayName : accountLabel(connection);
  const account: AgentActionCatalogAccount = label
    ? { accountId, label }
    : { accountId };
  const actionKeys = input.onlyActionKey
    ? listing.actions.filter((action) => action === input.onlyActionKey)
    : listing.actions;
  return actionKeys.flatMap((actionKey) => {
    if (
      !store.isActionEnabled({
        workspaceSlug,
        pluginId: listing.pluginId,
        actionKey,
      })
    ) {
      return [];
    }
    const requirement = resolveActionRequirement(listing, actionKey);
    if (!requirement || requirement.kind !== listing.provider) return [];
    if (!input.enabledCapabilities.has(`${listing.pluginId}\u0000${requirement.capability}`)) {
      return [];
    }
    const legacy =
      listing.pluginId === LEGACY_GITHUB_LIST_REPOSITORIES.pluginId &&
      actionKey === LEGACY_GITHUB_LIST_REPOSITORIES.actionKey;
    const resourceKind = legacy
      ? LEGACY_GITHUB_LIST_REPOSITORIES.resourceKind
      : agentResourceKindForProvider(listing.provider);
    if (!selectionShapeIsValid({ pluginId: listing.pluginId, actionKey, resourceKind })) {
      return [];
    }
    if (customMcp) {
      const mcpTool = customMcpToolForAction(listing, actionKey);
      if (!mcpTool) return [];
      const properties = mcpTool.inputSchema.properties;
      return [
        {
          pluginId: listing.pluginId,
          pluginName: listing.displayName,
          provider: listing.provider,
          actionKey,
          label: mcpTool.title ?? mcpTool.name,
          description: mcpTool.description ?? "",
          capability: requirement.capability,
          resourceKind,
          mode: "connected-account" as const,
          accounts: [account],
          allowedArguments:
            properties && typeof properties === "object" && !Array.isArray(properties)
              ? allowedArgumentNames(Object.keys(properties))
              : null,
          toolName: mcpTool.name,
        },
      ];
    }
    const tool = composioToolRecord(listing, actionKey);
    return [
      {
        pluginId: listing.pluginId,
        pluginName: listing.displayName,
        provider: listing.provider,
        actionKey,
        label: stringValue(tool?.displayName) ?? actionKey,
        description: stringValue(tool?.description) ?? "",
        capability: requirement.capability,
        resourceKind,
        mode: "connected-account" as const,
        accounts: [account],
        allowedArguments: legacy
          ? [...LEGACY_GITHUB_LIST_REPOSITORIES.allowedArguments]
          : allowedArgumentsFromTool(tool),
        toolName: legacy
          ? LEGACY_GITHUB_LIST_REPOSITORIES.toolName
          : (stringValue(tool?.toolName) ?? actionKey),
      },
    ];
  });
}

function enabledCapabilityKeys(store: AgentActionCatalogStore, workspaceSlug: string) {
  return new Set(
    store
      .listEnabledBindings(workspaceSlug)
      .map((binding) => `${binding.pluginId}\u0000${binding.capability}`),
  );
}

export function publishedAgentActionCatalog(input: {
  store: AgentActionCatalogStore;
  workspaceSlug: string;
}): AgentActionCatalogEntry[] {
  const enabledCapabilities = enabledCapabilityKeys(input.store, input.workspaceSlug);
  return input.store
    .listListingsForWorkspace(input.workspaceSlug)
    .flatMap((listing) =>
      entriesForListing({
        store: input.store,
        workspaceSlug: input.workspaceSlug,
        listing,
        enabledCapabilities,
      }),
    )
    .sort(
      (left, right) =>
        left.pluginName.localeCompare(right.pluginName) ||
        left.pluginId.localeCompare(right.pluginId) ||
        left.label.localeCompare(right.label) ||
        left.actionKey.localeCompare(right.actionKey),
    );
}

export function resolvePublishedAgentAction(input: {
  store: AgentActionCatalogStore;
  workspaceSlug: string;
  pluginId: string;
  actionKey: string;
}): AgentActionCatalogEntry | null {
  const listing = input.store.getListingForWorkspace(input.pluginId, input.workspaceSlug);
  if (!listing) return null;
  return (
    entriesForListing({
      store: input.store,
      workspaceSlug: input.workspaceSlug,
      listing,
      enabledCapabilities: enabledCapabilityKeys(input.store, input.workspaceSlug),
      onlyActionKey: input.actionKey,
    })[0] ?? null
  );
}

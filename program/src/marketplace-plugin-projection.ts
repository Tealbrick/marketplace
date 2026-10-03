import type {
  ConnectorConnection,
  MarketplaceListing,
  PluginRuntimeSourceDescriptor,
} from "./types.js";
import { SqliteMarketplaceStore } from "./store.js";

const SCHEMA_VERSION = "doppelganger.marketplace.plugin-record.v1" as const;
const REGISTRY_PROXY_BASE =
  "/api/plugins/doppelganger-registry/proxy/marketplace";

type PluginLifecycle = "available" | "installed";
type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "auth-required"
  | "error";
type PluginAction = "install" | "configure" | "uninstall" | "authenticate";

export type MarketplacePluginProjectionRecord = Readonly<Record<string, unknown>> & {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly recordId: string;
  readonly providerId: "marketplace";
  readonly pluginId: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly kind: "native" | "mcp";
  readonly lifecycle: PluginLifecycle;
  readonly enabled: boolean;
  readonly required: false;
  readonly connection: {
    readonly state: ConnectionState;
    readonly detail: string;
  };
  readonly contributions: readonly [];
  readonly adapter:
    | {
        readonly type: "native";
        readonly native: {
          readonly provider: string;
          readonly runtimeSources: readonly Record<string, unknown>[];
        };
      }
    | {
        readonly type: "mcp";
        readonly mcp: {
          readonly transport: "stdio";
          readonly config: Readonly<Record<string, unknown>>;
        };
      };
  readonly capabilities: readonly string[];
  readonly actions: readonly string[];
  readonly allowedActions: readonly PluginAction[];
  readonly settingsSurfaceIds: readonly [];
  readonly registry: {
    readonly authority: "doppelganger-registry";
    readonly unitId: string;
    readonly contributionIds: readonly [];
  };
  readonly custom: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MarketplacePluginActionDescriptor = Readonly<Record<string, unknown>> & {
  readonly actionId: string;
  readonly ownerRecordId: string;
  readonly operation: PluginAction;
  readonly label: string;
  readonly endpoint: string;
  readonly method: "POST";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly destructive?: boolean;
};

function isAuthRequired(listing: MarketplaceListing) {
  return (
    listing.source === "composio" &&
    listing.authOwner === "composio" &&
    listing.pluginId !== "composio-bootstrap"
  );
}

function connectionProjection(
  listing: MarketplaceListing,
  connection: ConnectorConnection | null,
) {
  const authRequired = isAuthRequired(listing);
  if (!connection) {
    return authRequired
      ? {
          state: "auth-required" as const,
          detail: `Connect ${listing.displayName} before using its actions.`,
        }
      : {
          state: "connected" as const,
          detail: "No external-account connection is required.",
        };
  }
  const state: ConnectionState =
    connection.state === "connected"
      ? "connected"
      : connection.state === "pending"
        ? "connecting"
        : connection.state === "blocked"
          ? "error"
          : authRequired
            ? "auth-required"
            : "disconnected";
  return { state, detail: connection.detail };
}

function safeRuntimeSource(source: PluginRuntimeSourceDescriptor) {
  return {
    runtimeSourceId: source.runtimeSourceId,
    kind: source.kind,
    label: source.label,
    ...(source.primary === undefined ? {} : { primary: source.primary }),
    ...(source.toolkitSlug ? { toolkitSlug: source.toolkitSlug } : {}),
    ...(source.mcpServerId ? { mcpServerId: source.mcpServerId } : {}),
    ...(source.sidecarId ? { sidecarId: source.sidecarId } : {}),
  };
}

function adapterFor(listing: MarketplaceListing) {
  const sources = (listing.runtimeSources ?? []).map(safeRuntimeSource);
  if (listing.source === "mcp") {
    const primary = sources[0] ?? {};
    return {
      type: "mcp" as const,
      mcp: {
        transport: "stdio" as const,
        config: primary,
      },
    };
  }
  return {
    type: "native" as const,
    native: {
      provider: listing.provider,
      runtimeSources: sources,
    },
  };
}

function listingVersion(listing: MarketplaceListing) {
  const version = listing.manifest.version;
  return typeof version === "string" && version.trim() ? version.trim() : "0.1.0";
}

function actionEndpoint(pluginId: string, action: string) {
  return (
    REGISTRY_PROXY_BASE +
    "/api/marketplace/plugins/" +
    encodeURIComponent(pluginId) +
    "/" +
    action
  );
}

function actionDescriptors(input: {
  listing: MarketplaceListing;
  workspaceSlug: string;
  installed: boolean;
  connectionState: ConnectionState;
}) {
  const { listing, workspaceSlug, installed, connectionState } = input;
  const recordId = `plugin:${listing.pluginId}`;
  if (!installed) {
    return [
      {
        actionId: `${recordId}:install`,
        ownerRecordId: recordId,
        operation: "install" as const,
        label: "Install",
        endpoint: actionEndpoint(listing.pluginId, "install"),
        method: "POST" as const,
        payload: { workspaceSlug, actorId: "operator" },
      },
    ];
  }

  const actions: MarketplacePluginActionDescriptor[] = [];
  if (isAuthRequired(listing) && connectionState !== "connected") {
    actions.push({
      actionId: `${recordId}:authenticate`,
      ownerRecordId: recordId,
      operation: "authenticate",
      label: "Connect",
      endpoint: actionEndpoint(listing.pluginId, "connection"),
      method: "POST",
      payload: {
        workspaceSlug,
        actorId: "operator",
        provider: listing.provider,
        toolkit: listing.provider,
        backend: "composio",
      },
    });
  }
  if (listing.actions[0]) {
    actions.push({
      actionId: `${recordId}:configure`,
      ownerRecordId: recordId,
      operation: "configure",
      label: "Configure tools",
      endpoint: actionEndpoint(listing.pluginId, "action-binding"),
      method: "POST",
      payload: {
        workspaceSlug,
        actorId: "operator",
        actionKey: listing.actions[0],
        enabled: true,
      },
    });
  }
  actions.push({
    actionId: `${recordId}:uninstall`,
    ownerRecordId: recordId,
    operation: "uninstall",
    label: "Uninstall",
    endpoint: actionEndpoint(listing.pluginId, "uninstall"),
    method: "POST",
    payload: { workspaceSlug, actorId: "operator" },
    destructive: true,
  });
  return actions;
}

export function projectMarketplacePlugins(
  store: SqliteMarketplaceStore,
  workspaceSlug: string,
) {
  const pluginRecords: MarketplacePluginProjectionRecord[] = [];
  const actions: MarketplacePluginActionDescriptor[] = [];

  for (const listing of store.listListings()) {
    const install = store.getInstall(workspaceSlug, listing.pluginId);
    const installed =
      install?.enabled === true && install.lifecycle === "installed";
    const connection = connectionProjection(
      listing,
      store.getConnection(workspaceSlug, listing.pluginId),
    );
    const ownedActions = actionDescriptors({
      listing,
      workspaceSlug,
      installed,
      connectionState: connection.state,
    });
    const recordId = `plugin:${listing.pluginId}`;
    pluginRecords.push({
      schemaVersion: SCHEMA_VERSION,
      recordId,
      providerId: "marketplace",
      pluginId: listing.pluginId,
      displayName: listing.displayName,
      description: listing.description,
      version: listingVersion(listing),
      kind: listing.source === "mcp" ? "mcp" : "native",
      lifecycle: installed ? "installed" : "available",
      enabled: installed,
      required: false,
      connection,
      contributions: [],
      adapter: adapterFor(listing),
      capabilities: listing.capabilities,
      actions: listing.actions,
      allowedActions: ownedActions.map((action) => action.operation),
      settingsSurfaceIds: [],
      registry: {
        authority: "doppelganger-registry",
        unitId: listing.pluginId,
        contributionIds: [],
      },
      custom: listing.manifest.role === "composio-imported-plugin",
      createdAt: listing.createdAt,
      updatedAt: install?.updatedAt ?? listing.updatedAt,
    });
    actions.push(...ownedActions);
  }

  const recordIds = pluginRecords.map((record) => record.recordId);
  const actionIds = actions.map((action) => action.actionId);
  if (new Set(recordIds).size !== recordIds.length) {
    throw new Error("Duplicate Marketplace Plugin record ownership.");
  }
  if (new Set(actionIds).size !== actionIds.length) {
    throw new Error("Duplicate Marketplace Plugin action ownership.");
  }
  const owners = new Set(recordIds);
  if (actions.some((action) => !owners.has(action.ownerRecordId))) {
    throw new Error("Marketplace Plugin action has no owning record.");
  }

  return { pluginRecords, actions };
}

import type { SqliteMarketplaceStore } from "./store.js";
import type {
  ConnectorCapability,
  ConnectorConnectionState,
  MarketplaceConnectionState,
  MarketplaceActionDescriptor,
  MarketplaceCapabilitiesHostProjection,
  MarketplaceExtensionContribution,
  MarketplaceExtensionRecord,
  MarketplaceGatewayRegistrySnapshot,
  MarketplaceListing,
  MarketplaceMcpAdapterConfig,
  MarketplacePluginAction,
  MarketplacePluginRecord,
  MarketplaceSettingsSurface,
} from "./types.js";
import {
  MARKETPLACE_PLUGIN_RECORD_VERSION,
  MARKETPLACE_SETTINGS_SURFACE_VERSION,
} from "./types.js";

export const MARKETPLACE_HUB_UNIT = {
  unitId: "marketplace",
  version: "0.2.0",
  enabled: true,
  required: true,
} as const;

export const HDDA_MARKETPLACE_PROXY_BASE =
  "/api/plugins/doppelganger-registry/proxy/marketplace";

export const MARKETPLACE_CAPABILITY_PROJECTION = {
  gatewayPluginId: "doppelganger-registry",
  recordsPath: `${HDDA_MARKETPLACE_PROXY_BASE}/api/plugins/marketplace-hub/records`,
} as const;

type JsonRecord = Record<string, unknown>;

export type McpPluginInput = {
  pluginId: string;
  displayName: string;
  description?: string;
  version?: string;
  transport: MarketplaceMcpAdapterConfig["transport"];
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  config?: JsonRecord;
  contributions?: MarketplaceExtensionContribution[];
  capabilities?: ConnectorCapability[];
  actions?: string[];
};

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : [];
}

function skillsHubMetadata(listing: MarketplaceListing): JsonRecord {
  return recordValue(listing.manifest.skillsHub) ?? {};
}

export function listingIsRequired(listing: MarketplaceListing): boolean {
  const hub = skillsHubMetadata(listing);
  const directSystem = recordValue(listing.manifest.system);
  const doppelganger = recordValue(listing.manifest.doppelganger);
  const doppelgangerSystem = recordValue(doppelganger?.system);
  return (
    hub.required === true ||
    directSystem?.required === true ||
    doppelgangerSystem?.required === true
  );
}

export function listingIsCustomMcp(listing: MarketplaceListing): boolean {
  return listing.source === "mcp" && skillsHubMetadata(listing).custom === true;
}

function extensionContributions(
  listing: MarketplaceListing,
): MarketplaceExtensionContribution[] {
  const hub = skillsHubMetadata(listing);
  const contributions = Array.isArray(hub.contributions)
    ? hub.contributions
    : [];
  return contributions.flatMap((value) => {
    const contribution = recordValue(value);
    const id = stringValue(contribution?.id);
    const label = stringValue(contribution?.label);
    const routeSegment = stringValue(contribution?.routeSegment);
    const mount = stringValue(contribution?.mount);
    const settings = recordValue(contribution?.settings);
    if (
      !id ||
      !label ||
      !routeSegment ||
      !["workspace", "right-rail", "settings-panel", "overlay"].includes(
        mount ?? "",
      )
    ) {
      return [];
    }
    return [
      {
        id,
        type: "extension-surface" as const,
        label,
        mount: mount as MarketplaceExtensionContribution["mount"],
        routeSegment,
        ...(stringValue(contribution?.region)
          ? { region: stringValue(contribution?.region) }
          : {}),
        ...(stringValue(contribution?.minHostSdk)
          ? { minHostSdk: stringValue(contribution?.minHostSdk) }
          : {}),
        ...(settings
          ? {
              settings: {
                ...(stringValue(settings.settingsSurfaceId)
                  ? {
                      settingsSurfaceId: stringValue(
                        settings.settingsSurfaceId,
                      ),
                    }
                  : {}),
                ...(stringValue(settings.title)
                  ? { title: stringValue(settings.title) }
                  : {}),
                ...(stringValue(settings.description)
                  ? { description: stringValue(settings.description) }
                  : {}),
                ...(recordValue(settings.schema)
                  ? { schema: recordValue(settings.schema) }
                  : {}),
                ...(recordValue(settings.uiSchema)
                  ? { uiSchema: recordValue(settings.uiSchema) }
                  : {}),
              },
            }
          : {}),
        enabled: contribution?.enabled !== false,
      },
    ];
  });
}

export function marketplaceMcpAdapterConfig(
  listing: MarketplaceListing,
  includeSensitive = false,
): MarketplaceMcpAdapterConfig {
  const hub = skillsHubMetadata(listing);
  const adapter = recordValue(hub.adapter);
  const mcp = recordValue(adapter?.mcp);
  const transport = stringValue(mcp?.transport);
  return {
    transport:
      transport === "sse" || transport === "streamable-http"
        ? transport
        : "stdio",
    ...(stringValue(mcp?.command)
      ? { command: stringValue(mcp?.command) }
      : {}),
    ...(stringArray(mcp?.args).length > 0
      ? { args: stringArray(mcp?.args) }
      : {}),
    ...(stringValue(mcp?.url) ? { url: stringValue(mcp?.url) } : {}),
    ...(stringValue(mcp?.cwd) ? { cwd: stringValue(mcp?.cwd) } : {}),
    ...(includeSensitive && recordValue(mcp?.env)
      ? {
          env: Object.fromEntries(
            Object.entries(recordValue(mcp?.env)!).map(([key, value]) => [
              key,
              String(value),
            ]),
          ),
        }
      : {}),
    ...(includeSensitive && recordValue(mcp?.headers)
      ? {
          headers: Object.fromEntries(
            Object.entries(recordValue(mcp?.headers)!).map(([key, value]) => [
              key,
              String(value),
            ]),
          ),
        }
      : {}),
    config: recordValue(mcp?.config) ?? {},
  };
}

function connectionState(
  listing: MarketplaceListing,
  state: ConnectorConnectionState | undefined,
): MarketplaceConnectionState {
  if (state === "connected") return "connected";
  if (state === "pending") return "connecting";
  if (state === "blocked") return "error";
  if (state === "disconnected") return "disconnected";
  if (listing.authOwner === "nango" || listing.authOwner === "composio") {
    return "auth-required";
  }
  return "disconnected";
}

function allowedActions(input: {
  installed: boolean;
  enabled: boolean;
  required: boolean;
  custom: boolean;
  connectFirst: boolean;
  composioAuth: boolean;
  connectionState: MarketplaceConnectionState;
}): MarketplacePluginAction[] {
  if (!input.installed) {
    if (input.connectFirst && input.connectionState !== "connected") {
      return ["authenticate"];
    }
    return [
      "install",
      ...(input.custom ? (["configure", "update", "delete"] as const) : []),
    ];
  }
  return [
    ...(input.composioAuth &&
    (input.connectionState === "auth-required" ||
      input.connectionState === "connecting" ||
      input.connectionState === "error")
      ? (["authenticate"] as const)
      : []),
    ...(input.enabled
      ? input.required
        ? []
        : (["disable"] as const)
      : (["enable"] as const)),
    ...(input.custom ? (["configure", "update"] as const) : []),
    "reload",
    ...(input.required ? [] : (["uninstall"] as const)),
  ];
}

function pluginRecordId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

function listingIconUrl(listing: MarketplaceListing): string | undefined {
  const manifest = recordValue(listing.manifest);
  const composio = recordValue(manifest?.composio);
  const catalog = recordValue(composio?.catalog);
  const candidate = stringValue(catalog?.logoUrl);
  if (!candidate) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function pluginSettingsSurfaceId(pluginId: string): string {
  return `marketplace.plugin.${pluginId}.settings`;
}

function extensionRecordId(pluginId: string, contributionId: string): string {
  return `extension:${pluginId}:${contributionId}`;
}

function extensionSettingsSurfaceId(
  pluginId: string,
  contribution: MarketplaceExtensionContribution,
): string {
  return (
    contribution.settings?.settingsSurfaceId ??
    `marketplace.extension.${pluginId}.${contribution.id}.settings`
  );
}

const EMPTY_SETTINGS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

function pluginSettingsSurface(
  record: MarketplacePluginRecord,
): MarketplaceSettingsSurface {
  const isMcp = record.adapter.type === "mcp";
  return {
    schemaVersion: MARKETPLACE_SETTINGS_SURFACE_VERSION,
    settingsSurfaceId: pluginSettingsSurfaceId(record.pluginId),
    ownerRecordId: record.recordId,
    presentation: "modal",
    title: `${record.displayName} settings`,
    description: isMcp
      ? "MCP adapter configuration contributed by Marketplace."
      : "Plugin settings contributed by Marketplace.",
    jsonSchema: isMcp
      ? {
          type: "object",
          additionalProperties: false,
          properties: {
            displayName: { type: "string" },
            description: { type: "string" },
            transport: { enum: ["stdio", "sse", "streamable-http"] },
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            url: { type: "string", format: "uri" },
            cwd: { type: "string" },
            config: { type: "object" },
          },
        }
      : EMPTY_SETTINGS_SCHEMA,
    allowedActions: record.allowedActions.filter(
      (action) => action === "configure" || action === "update",
    ),
    ...(record.allowedActions.includes("configure")
      ? { submitActionId: `${record.recordId}:configure` }
      : {}),
  };
}

function extensionSettingsSurface(input: {
  extension: MarketplaceExtensionRecord;
  contribution: MarketplaceExtensionContribution;
}): MarketplaceSettingsSurface {
  const settings = input.contribution.settings;
  return {
    schemaVersion: MARKETPLACE_SETTINGS_SURFACE_VERSION,
    settingsSurfaceId: input.extension.settingsSurfaceId!,
    ownerRecordId: input.extension.recordId,
    presentation: "modal",
    title: settings?.title ?? `${input.extension.displayName} settings`,
    description:
      settings?.description ??
      "Extension settings contributed by its owning Plugin.",
    jsonSchema: settings?.schema ?? EMPTY_SETTINGS_SCHEMA,
    ...(settings?.uiSchema ? { uiSchema: settings.uiSchema } : {}),
    allowedActions: [],
  };
}

function extensionRecord(
  plugin: MarketplacePluginRecord,
  contribution: MarketplaceExtensionContribution,
): MarketplaceExtensionRecord {
  return {
    recordId: extensionRecordId(plugin.pluginId, contribution.id),
    providerId: "marketplace",
    ownerPluginId: plugin.pluginId,
    displayName: contribution.label,
    description: `Contributed by ${plugin.displayName}.`,
    visible: contribution.enabled,
    enabled: plugin.enabled && contribution.enabled,
    required: plugin.required,
    status: plugin.connection,
    ...(contribution.settings
      ? {
          settingsSurfaceId: extensionSettingsSurfaceId(
            plugin.pluginId,
            contribution,
          ),
        }
      : {}),
    capabilities: plugin.capabilities,
  };
}

function actionLabel(action: MarketplacePluginAction): string {
  if (action === "authenticate") return "Connect";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function pluginActions(
  record: MarketplacePluginRecord,
  workspaceSlug: string,
): MarketplaceActionDescriptor[] {
  return record.allowedActions
    .map((operation) => {
      if (operation === "authenticate") {
        const provider =
          record.adapter.type === "native"
            ? record.adapter.native.provider
            : record.providerId;
        return {
          actionId: `${record.recordId}:${operation}`,
          ownerRecordId: record.recordId,
          operation,
          label: actionLabel(operation),
          endpoint: `${HDDA_MARKETPLACE_PROXY_BASE}/api/marketplace/plugins/${encodeURIComponent(record.pluginId)}/connection`,
          method: "POST",
          payload: {
            workspaceSlug,
            actorId: "operator",
            provider,
            backend: "composio",
            toolkit: provider,
          },
        } satisfies MarketplaceActionDescriptor;
      }
      const settingsAction =
        operation === "configure" || operation === "update";
      const destructive = operation === "uninstall" || operation === "delete";
      const pluginPath = `${HDDA_MARKETPLACE_PROXY_BASE}/api/marketplace/hub/plugins/${encodeURIComponent(record.pluginId)}`;
      return {
        actionId: `${record.recordId}:${operation}`,
        ownerRecordId: record.recordId,
        operation,
        label:
          operation === "install" && record.connection.state === "connected"
            ? "Enable"
            : actionLabel(operation),
        endpoint:
          settingsAction || operation === "delete"
            ? `${pluginPath}?workspaceSlug=${encodeURIComponent(workspaceSlug)}`
            : `${pluginPath}/lifecycle`,
        method:
          operation === "delete" ? "DELETE" : settingsAction ? "PATCH" : "POST",
        ...(!settingsAction && operation !== "delete"
          ? {
              payload: {
                workspaceSlug,
                actorId: "operator",
                action: operation,
              },
            }
          : {}),
        ...(destructive ? { destructive: true } : {}),
      } satisfies MarketplaceActionDescriptor;
    });
}

function extensionActions(
  _record: MarketplaceExtensionRecord,
): MarketplaceActionDescriptor[] {
  return [];
}

function assertUniqueOwnership(input: {
  label: string;
  values: readonly string[];
}): void {
  const seen = new Set<string>();
  for (const value of input.values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${input.label} ownership: ${value}`);
    }
    seen.add(value);
  }
}

export function marketplacePluginRecord(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  listing: MarketplaceListing;
}): MarketplacePluginRecord {
  const install = input.store.getInstall(
    input.workspaceSlug,
    input.listing.pluginId,
  );
  const installed = install?.lifecycle === "installed";
  const enabled = installed && install?.enabled === true;
  const required = listingIsRequired(input.listing);
  const custom = listingIsCustomMcp(input.listing);
  const connection = input.store.getConnection(
    input.workspaceSlug,
    input.listing.pluginId,
  );
  const state = connectionState(input.listing, connection?.state);
  const contributions = extensionContributions(input.listing);
  const hub = skillsHubMetadata(input.listing);
  const connectFirst =
    stringValue(recordValue(input.listing.manifest)?.role) ===
    "composio-catalog-connector";
  const unitId = stringValue(hub.unitId) ?? input.listing.pluginId;
  const version = stringValue(input.listing.manifest.version) ?? "0.1.0";

  return {
    schemaVersion: MARKETPLACE_PLUGIN_RECORD_VERSION,
    recordId: pluginRecordId(input.listing.pluginId),
    providerId: "marketplace",
    pluginId: input.listing.pluginId,
    displayName: input.listing.displayName,
    description: input.listing.description,
    ...(listingIconUrl(input.listing)
      ? { iconUrl: listingIconUrl(input.listing) }
      : {}),
    version,
    kind: input.listing.source === "mcp" ? "mcp" : "native",
    lifecycle: installed ? "installed" : "available",
    enabled,
    required,
    connection: {
      state,
      detail:
        connection?.detail ??
        (state === "auth-required"
          ? "External authentication requires the permissioned HDDA auth flow."
          : state === "connected"
            ? "Connected."
            : "No active connection."),
    },
    contributions,
    adapter:
      input.listing.source === "mcp"
        ? { type: "mcp", mcp: marketplaceMcpAdapterConfig(input.listing) }
        : {
            type: "native",
            native: {
              provider: input.listing.provider,
              runtimeSources: input.listing.runtimeSources ?? [],
            },
          },
    capabilities: input.listing.capabilities,
    actions: input.listing.actions,
    allowedActions: allowedActions({
      installed,
      enabled,
      required,
      custom,
      connectFirst,
      composioAuth: input.listing.authOwner === "composio",
      connectionState: state,
    }),
    settingsSurfaceIds:
      input.listing.source === "mcp"
        ? [pluginSettingsSurfaceId(input.listing.pluginId)]
        : [],
    registry: {
      authority: "doppelganger-registry",
      unitId,
      contributionIds: contributions.map((contribution) => contribution.id),
    },
    custom,
    createdAt: input.listing.createdAt,
    updatedAt: input.listing.updatedAt,
  };
}

export function marketplacePluginRecords(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
}): MarketplacePluginRecord[] {
  return input.store
    .listListings()
    .map((listing) => marketplacePluginRecord({ ...input, listing }));
}

/** Host-composable projection for the Capabilities entry. The Desktop shell
 * renders the structural tabs, records, action slots, and generic modal host;
 * Marketplace only contributes its governed data and typed settings surfaces. */
export function marketplaceCapabilitiesHostProjection(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
}): MarketplaceCapabilitiesHostProjection {
  const pluginRecords = marketplacePluginRecords(input);
  const extensionRecords = pluginRecords.flatMap((plugin) =>
    plugin.contributions.map((contribution) =>
      extensionRecord(plugin, contribution),
    ),
  );
  const extensionContributionIds = pluginRecords.flatMap((plugin) =>
    plugin.contributions.map((contribution) => contribution.id),
  );
  const settingsSurfaces = [
    ...pluginRecords
      .filter((record) => record.adapter.type === "mcp")
      .map(pluginSettingsSurface),
    ...extensionRecords.flatMap((extension) => {
      const owner = pluginRecords.find(
        (plugin) => plugin.pluginId === extension.ownerPluginId,
      );
      if (!owner) {
        throw new Error(
          `Missing Plugin owner for Extension record ${extension.recordId}`,
        );
      }
      const contribution = owner.contributions.find(
        (candidate) =>
          extensionRecordId(owner.pluginId, candidate.id) ===
          extension.recordId,
      );
      if (!contribution) {
        throw new Error(
          `Missing Extension contribution for record ${extension.recordId}`,
        );
      }
      return contribution.settings
        ? [extensionSettingsSurface({ extension, contribution })]
        : [];
    }),
  ];
  const actions = [
    ...pluginRecords.flatMap((record) => pluginActions(record, input.workspaceSlug)),
    ...extensionRecords.flatMap(extensionActions),
  ];

  assertUniqueOwnership({
    label: "Plugin record",
    values: pluginRecords.map((record) => record.recordId),
  });
  assertUniqueOwnership({
    label: "Extension record",
    values: extensionRecords.map((record) => record.recordId),
  });
  assertUniqueOwnership({
    label: "Extension contribution",
    values: extensionContributionIds,
  });
  assertUniqueOwnership({
    label: "action",
    values: actions.map((action) => action.actionId),
  });
  assertUniqueOwnership({
    label: "settings surface",
    values: settingsSurfaces.map((surface) => surface.settingsSurfaceId),
  });

  return {
    host: {
      entry: "capabilities",
      tabs: ["skills", "plugins", "extensions"],
      lifecycleAuthority: "marketplace",
      directHermesRole: "underlying-adapters-only",
    },
    pluginRecords,
    extensionRecords,
    actions,
    settingsSurfaces,
  };
}

export function mcpListingFromInput(
  input: McpPluginInput,
  existing?: MarketplaceListing,
): MarketplaceListing {
  const now = new Date().toISOString();
  const capabilities = input.capabilities ?? [
    "connector.observe",
    "connector.dispatch",
  ];
  const actions = input.actions ?? ["mcp.tools.list", "mcp.tools.call"];
  const adapter = {
    transport: input.transport,
    ...(input.command ? { command: input.command } : {}),
    ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.headers ? { headers: input.headers } : {}),
    config: input.config ?? {},
  };
  return {
    pluginId: input.pluginId,
    displayName: input.displayName,
    kind: "toolset",
    provider: input.pluginId,
    description:
      input.description ?? "Custom Plugin using an MCP transport adapter.",
    capabilities,
    actions,
    source: "mcp",
    authOwner: "program",
    executionOwner: "mcp",
    runtimeSources: [
      {
        runtimeSourceId: `${input.pluginId}-mcp`,
        kind: "mcp",
        label: `${input.displayName} MCP adapter`,
        primary: true,
        mcpServerId: input.pluginId,
      },
    ],
    enabledByDefault: false,
    manifest: {
      version:
        input.version ?? stringValue(existing?.manifest.version) ?? "0.1.0",
      kind: "plugin",
      actionRequirements: Object.fromEntries(
        actions.map((action) => [
          action,
          {
            kind: "mcp",
            capability: action.endsWith(".call")
              ? "connector.dispatch"
              : "connector.observe",
          },
        ]),
      ),
      skillsHub: {
        custom: true,
        required: false,
        unitId: input.pluginId,
        contributions: input.contributions ?? [],
        adapter: { type: "mcp", mcp: adapter },
      },
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function reconcileGatewayRegistry(
  snapshot: MarketplaceGatewayRegistrySnapshot,
) {
  const issues: Array<{ code: string; detail: string }> = [];
  const unit = snapshot.units.find(
    (candidate) => candidate.unitId === MARKETPLACE_HUB_UNIT.unitId,
  );
  if (!unit) {
    issues.push({
      code: "marketplace-unit-missing",
      detail: "The Marketplace unit is absent.",
    });
  } else {
    if (!unit.enabled) {
      issues.push({
        code: "required-unit-disabled",
        detail: "The required Marketplace unit must remain enabled.",
      });
    }
    if (unit.required !== true) {
      issues.push({
        code: "required-policy-missing",
        detail: "The gateway registry must mark Marketplace as required.",
      });
    }
    if (!unit.capabilityProjection) {
      issues.push({
        code: "capabilities-projection-missing",
        detail:
          "The required Marketplace unit must declare its gateway projection.",
      });
    } else if (
      unit.capabilityProjection.gatewayPluginId !==
        MARKETPLACE_CAPABILITY_PROJECTION.gatewayPluginId ||
      unit.capabilityProjection.recordsPath !==
        MARKETPLACE_CAPABILITY_PROJECTION.recordsPath
    ) {
      issues.push({
        code: "capabilities-projection-mismatch",
        detail:
          "The Marketplace projection must use the mounted marketplace-hub gateway adapter and its records route.",
      });
    }
  }

  for (const contribution of snapshot.contributions) {
    if (
      contribution.mount === "hub-tab" ||
      contribution.type === "hub-family-filler"
    ) {
      issues.push({
        code: "duplicate-top-level-tab",
        detail: `${contribution.id} attempts to replace or append a Capabilities tab.`,
      });
    }
    if (
      ["mcp", "toolsets", "hub"].includes(
        (contribution.family ?? contribution.routeSegment ?? "").toLowerCase(),
      )
    ) {
      issues.push({
        code: "unexpected-top-level-category",
        detail: `${contribution.label} must be represented as a Plugin, not a top-level Hub category.`,
      });
    }
  }
  return {
    ok: issues.length === 0,
    authority: "doppelganger-registry" as const,
    writesRegistry: false,
    expected: {
      unit: MARKETPLACE_HUB_UNIT,
      capabilityProjection: MARKETPLACE_CAPABILITY_PROJECTION,
      entry: "capabilities" as const,
      tabs: ["skills", "plugins", "extensions"] as const,
      projectionEndpoint: MARKETPLACE_CAPABILITY_PROJECTION.recordsPath,
      contributionMode: "gateway-projected-records" as const,
      lifecycleAuthority: "marketplace" as const,
    },
    observedRevision: snapshot.revision,
    issues,
  };
}

export const CONNECTOR_CAPABILITIES = [
  "connector.observe",
  "connector.dispatch",
  "connector.admin",
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export const CONNECTOR_KINDS = [
  "github",
  "coolify",
  "cloudflare",
  "telegram",
  "whatsapp",
] as const;

export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const PLUGIN_RUNTIME_SOURCE_KINDS = [
  "composio",
  "mcp",
  "nango",
  "activepieces",
  "native-api",
  "cli",
  "sidecar",
] as const;

export type PluginRuntimeSourceKind =
  (typeof PLUGIN_RUNTIME_SOURCE_KINDS)[number];

export type PluginRuntimeSourceDescriptor = {
  runtimeSourceId: string;
  kind: PluginRuntimeSourceKind;
  label: string;
  primary?: boolean;
  endpoint?: string;
  toolkitSlug?: string;
  mcpServerId?: string;
  sidecarId?: string;
  requiredEnv?: string[];
};

export type RulesDecision = {
  effect: "allow" | "deny" | "review";
  decisionId?: string;
  reason?: string;
};

export type RulesClient = (input: {
  workspaceSlug: string;
  operation: string;
  capability: ConnectorCapability;
  pluginId: string;
  actorId: string;
  payload: Record<string, unknown>;
}) => Promise<RulesDecision>;

export type MarketplaceEventEnvelope = {
  id: string;
  type: string;
  traceId: string;
  sourceProgram: "marketplace";
  workspaceSlug: string | null;
  pluginId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type MarketplaceListing = {
  pluginId: string;
  displayName: string;
  kind: "connector" | "toolset" | "observer" | "module";
  provider: string;
  description: string;
  capabilities: ConnectorCapability[];
  actions: string[];
  source: "native" | "activepieces" | "composio" | "nango" | "mcp";
  authOwner: "nango" | "program" | "external" | "composio";
  executionOwner: "native" | "activepieces" | "composio" | "mcp";
  runtimeSources?: PluginRuntimeSourceDescriptor[];
  enabledByDefault: boolean;
  manifest: Record<string, unknown>;
  /**
   * Set only for listings owned by one workspace (operator custom MCP
   * connectors). Absent for global catalog and Hub-registered listings.
   */
  ownerWorkspaceSlug?: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceSkillDeclaration = {
  skillId: string;
  skillName?: string;
  displayName: string;
  description?: string;
  sourcePath?: string;
  skillRoot?: string;
  requiresConnectors: string[];
};

export type WorkspacePluginInstall = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  enabled: boolean;
  lifecycle: "installed" | "disabled" | "uninstalled";
  installedAt: string;
  updatedAt: string;
};

export type CapabilityBinding = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  capability: ConnectorCapability;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ActionBinding = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  actionKey: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorConnectionState =
  | "pending"
  | "connected"
  | "blocked"
  | "disconnected";

export type ConnectorConnection = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  provider: string;
  backend: "nango" | "activepieces" | "composio" | "native" | "mcp";
  state: ConnectorConnectionState;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AgentConnectorGrant = {
  id: string;
  workspaceSlug: string;
  agentId: string;
  pluginId: string;
  actionKey: string;
  capability: ConnectorCapability;
  connectionId: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  attachmentId: string;
  state: "active" | "revoked";
  expiresAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MarketplacePortalHandoffSession = {
  id: string;
  portalIssuer: string;
  deploymentId: string;
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  userId: string;
  sessionToken: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAgentConsent = {
  id: string;
  portalIssuer: string;
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  deploymentId: string;
  userId: string;
  agentId: string;
  consentId: string;
  consentRevision: number;
  pluginId: string;
  actionKey: string;
  capability: ConnectorCapability;
  connectionId: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  state: "active" | "revoked";
  capabilities: ConnectorCapability[];
  requiredActions: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceRuntimeOperation = {
  id: string;
  consentId: string;
  idempotencyKey: string;
  fingerprint: string;
  status: "pending" | "succeeded" | "reconciliation-required";
  response: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplacePortalGrantRequest = {
  id: string;
  portalIssuer: string;
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  deploymentId: string;
  agentId: string;
  requestId: string;
  approvalUrl: string;
  expiresAt: string;
  idempotencyKey: string;
  selection: {
    pluginId: string;
    actionKey: string;
    accountId: string;
    resourceKind: string;
    resourceRef: string;
  };
  state: "pending" | "redeemed" | "denied" | "expired";
  consentId: string | null;
  createdAt: string;
  updatedAt: string;
};

export const MARKETPLACE_PLUGIN_RECORD_VERSION =
  "doppelganger.marketplace.plugin-record.v1" as const;
export const MARKETPLACE_SETTINGS_SURFACE_VERSION =
  "doppelganger.capability-settings.v1" as const;

export const MARKETPLACE_PLUGIN_KINDS = ["native", "mcp"] as const;
export type MarketplacePluginKind = (typeof MARKETPLACE_PLUGIN_KINDS)[number];

export const MARKETPLACE_PLUGIN_LIFECYCLES = [
  "available",
  "installing",
  "installed",
  "error",
  "uninstalling",
] as const;
export type MarketplacePluginLifecycle =
  (typeof MARKETPLACE_PLUGIN_LIFECYCLES)[number];

export const MARKETPLACE_CONNECTION_STATES = [
  "disconnected",
  "connecting",
  "connected",
  "auth-required",
  "error",
] as const;
export type MarketplaceConnectionState =
  (typeof MARKETPLACE_CONNECTION_STATES)[number];

export type MarketplaceExtensionContribution = {
  id: string;
  type: "extension-surface";
  label: string;
  mount: "workspace" | "right-rail" | "settings-panel" | "overlay";
  routeSegment: string;
  region?: string;
  minHostSdk?: string;
  settings?: {
    settingsSurfaceId?: string;
    title?: string;
    description?: string;
    schema?: Record<string, unknown>;
    uiSchema?: Record<string, unknown>;
  };
  enabled: boolean;
};

export type MarketplaceMcpAdapterConfig = {
  transport: "stdio" | "sse" | "streamable-http";
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  config: Record<string, unknown>;
};

export type MarketplacePluginAdapter =
  | {
      type: "native";
      native: {
        provider: string;
        runtimeSources: PluginRuntimeSourceDescriptor[];
      };
    }
  | {
      type: "mcp";
      mcp: MarketplaceMcpAdapterConfig;
    };

export type MarketplacePluginAction =
  | "install"
  | "enable"
  | "disable"
  | "configure"
  | "update"
  | "reload"
  | "uninstall"
  | "delete"
  | "authenticate";

export type MarketplacePluginRecord = {
  schemaVersion: typeof MARKETPLACE_PLUGIN_RECORD_VERSION;
  recordId: string;
  providerId: "marketplace";
  pluginId: string;
  displayName: string;
  description: string;
  iconUrl?: string;
  version: string;
  kind: MarketplacePluginKind;
  lifecycle: MarketplacePluginLifecycle;
  enabled: boolean;
  required: boolean;
  connection: {
    state: MarketplaceConnectionState;
    detail: string;
  };
  contributions: MarketplaceExtensionContribution[];
  adapter: MarketplacePluginAdapter;
  capabilities: ConnectorCapability[];
  actions: string[];
  allowedActions: MarketplacePluginAction[];
  settingsSurfaceIds: string[];
  registry: {
    authority: "doppelganger-registry";
    unitId: string;
    contributionIds: string[];
  };
  custom: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceExtensionRecord = {
  recordId: string;
  providerId: string;
  ownerPluginId: string;
  displayName: string;
  description: string;
  visible: boolean;
  enabled: boolean;
  required: boolean;
  status: {
    state: MarketplaceConnectionState;
    detail: string;
  };
  settingsSurfaceId?: string;
  capabilities: string[];
};

export type MarketplaceSettingsSurface = {
  schemaVersion: typeof MARKETPLACE_SETTINGS_SURFACE_VERSION;
  settingsSurfaceId: string;
  ownerRecordId: string;
  presentation: "modal";
  title: string;
  description?: string;
  jsonSchema: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
  submitActionId?: string;
  allowedActions: MarketplacePluginAction[];
};

export type MarketplaceActionDescriptor = {
  actionId: string;
  ownerRecordId: string;
  operation: MarketplacePluginAction;
  label: string;
  endpoint: string;
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  transport?: "gateway" | "desktop-runtime-bridge";
  payload?: Record<string, unknown>;
  destructive?: boolean;
};

export type MarketplaceCapabilitiesHostProjection = {
  host: {
    entry: "capabilities";
    tabs: ["skills", "plugins", "extensions"];
    lifecycleAuthority: "marketplace";
    directHermesRole: "underlying-adapters-only";
  };
  pluginRecords: MarketplacePluginRecord[];
  extensionRecords: MarketplaceExtensionRecord[];
  actions: MarketplaceActionDescriptor[];
  settingsSurfaces: MarketplaceSettingsSurface[];
};

export type MarketplaceGatewayRegistrySnapshot = {
  contractVersion: string;
  revision: number;
  units: Array<{
    unitId: string;
    version: string;
    enabled: boolean;
    required?: boolean;
    capabilityProjection?: {
      gatewayPluginId: string;
      recordsPath: string;
    };
  }>;
  contributions: Array<{
    id: string;
    unitId: string;
    type: string;
    label: string;
    providerId?: string;
    recordEndpoint?: string;
    settingsSurfaceSchema?: string;
    family?: string;
    region?: string;
    mount?: string;
    routeSegment?: string;
  }>;
  flags?: { developerMode?: boolean };
};

export type CredentialRef = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  providerHint: string;
  secretRefKey: string;
  externalRef: string | null;
  state: "pending" | "active" | "blocked" | "revoked";
  detail: string;
  metadata: Record<string, unknown>;
  configuredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ComposioImportRecord = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  toolkit: string;
  importedActionKeys: string[];
  lifecycle: "imported" | "enabled" | "disabled" | "failed";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorUsageLedgerEntry = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  provider: string;
  sourceExecutor: "composio" | "native" | "activepieces" | "mcp";
  sourceActionKey: string;
  productCapabilityKey: string;
  inputShape: Record<string, unknown>;
  outputShape: Record<string, unknown>;
  scopesUsed: string[];
  status: "succeeded" | "failed";
  runId: string | null;
  sessionId: string | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AgentSessionCorrelation = {
  id: string;
  workspaceSlug: string;
  appThreadId: string;
  provider: string;
  providerInstanceId: string;
  remoteSessionId: string;
  hermesLiveSessionId: string | null;
  hermesStoredSessionId: string | null;
  profile: string | null;
  runtimeMode: string | null;
  cwd: string | null;
  source: string;
  eventType: string;
  metadata: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type MarketplaceBrokerGrant = {
  id: string;
  workspaceSlug: string;
  requesterMiniappId: string;
  pluginId: string;
  actionKeys: string[];
  capabilities: ConnectorCapability[];
  tokenHash: string;
  state: "active" | "consumed" | "revoked" | "expired";
  expiresAt: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorPromotionCandidate = {
  id: string;
  workspaceSlug: string;
  provider: string;
  sourceActionKey: string;
  productCapabilityKey: string;
  usageCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  sampleLedgerEntryIds: string[];
  commonInputShape: Record<string, unknown>;
  commonOutputShape: Record<string, unknown>;
  recommendedState: "promotion_candidate" | "contract_defined";
};

export type ProviderExecutionInput = {
  workspaceSlug: string;
  pluginId: string;
  provider: string;
  capability: ConnectorCapability;
  action: Record<string, unknown>;
  traceId: string;
};

export type ProviderExecutionResult = {
  summary: string;
  details: Record<string, unknown>;
};

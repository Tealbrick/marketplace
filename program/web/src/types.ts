export type ProviderState = "healthy" | "degraded" | "missing";

export interface ProviderHealth {
  state: ProviderState;
  configured: boolean;
  reachable: boolean;
  mode: "external";
  detail: string;
  env: string[];
  baseUrl: string | null;
  statusCode: number | null;
  checkedAt: string | null;
  error: string | null;
}

export type BrowserProviderHealth = Pick<
  ProviderHealth,
  "state" | "configured" | "reachable" | "mode" | "detail" | "statusCode" | "checkedAt"
>;

export interface MarketplaceListing {
  pluginId: string;
  displayName: string;
  kind: string;
  provider: string;
  description: string;
  capabilities: Array<"connector.observe" | "connector.dispatch" | "connector.admin">;
  actions: string[];
  source: "native" | "activepieces" | "composio" | "nango" | "mcp";
  authOwner: string;
  executionOwner: string;
  enabledByDefault: boolean;
  manifest: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PluginInstall {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  enabled: boolean;
  lifecycle: "installed" | "disabled" | "uninstalled";
  installedAt: string;
  updatedAt: string;
}

export interface PluginConnection {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  provider: string;
  backend: "nango" | "activepieces" | "composio" | "native" | "mcp";
  state: "pending" | "connected" | "blocked" | "disconnected";
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ToolSelectionAction {
  actionKey: string;
  displayName: string;
  description: string;
  toolName: string;
  capability: "connector.observe" | "connector.dispatch" | "connector.admin";
  enabled: boolean;
}

export interface PluginCard {
  addon: { addonId: string; pluginId: string; displayName: string; version: string; kind: string; enabled: boolean };
  state: {
    status: string;
    ready: boolean;
    registered: boolean;
    installed: boolean;
    enabled: boolean;
    authRequired: boolean;
    apps: Array<{ appId: string; backend: string; state: string; detail: string }>;
    diagnostics: string[];
    refreshedAt: string;
  };
  description: string;
  developerName: string;
  marketplaceName: string;
  capabilityLabels: string[];
  primaryAction: string;
  runtimeSource: string;
  toolCoverageCount: number;
  provenance: string;
  sourceLabel: string;
  dependencyFlags: string[];
  hostAffordances: string[];
  parityGaps: string[];
  installPlan: { addonId: string; steps: Array<{ kind: string; label: string; status: string; detail: string }> };
  toolSelection: { total: number; enabled: number; disabled: number; actions: ToolSelectionAction[] };
  listing: MarketplaceListing;
  install: Pick<PluginInstall, "enabled" | "lifecycle" | "updatedAt"> | null;
  connection: Pick<PluginConnection, "provider" | "backend" | "state" | "detail" | "updatedAt"> | null;
}

export interface CardsResponse {
  workspaceSlug: string;
  providers: Record<"nango" | "activepieces" | "composio", ProviderHealth>;
  cards: PluginCard[];
}

export interface PluginSummary {
  pluginId: string;
  displayName: string;
  description: string;
  kind: string;
  provider: string;
  source: MarketplaceListing["source"];
  sourceLabel: string;
  runtimeSource: string;
  status: string;
  ready: boolean;
  registered: boolean;
  installed: boolean;
  authRequired: boolean;
  toolCount: number;
  install: Pick<PluginInstall, "enabled" | "lifecycle" | "updatedAt"> | null;
  connection: Pick<PluginConnection, "provider" | "backend" | "state" | "detail" | "updatedAt"> | null;
}

export interface ConnectionSummary {
  pluginId: string;
  displayName: string;
  provider: string;
  backend: PluginConnection["backend"];
  state: PluginConnection["state"];
  detail: string;
  updatedAt: string;
}

export interface CardsSummaryResponse {
  workspaceSlug: string;
  providers: Record<"nango" | "activepieces" | "composio", BrowserProviderHealth>;
  total: number;
  filteredTotal: number;
  installedTotal: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  sources: MarketplaceListing["source"][];
  connections: ConnectionSummary[];
  items: PluginSummary[];
}

export interface CardDetailResponse {
  workspaceSlug: string;
  providers: Record<"nango" | "activepieces" | "composio", BrowserProviderHealth>;
  card: PluginCard;
}

export interface AgentGrantSelection {
  pluginId: string;
  actionKey: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
}

export type AgentGrantState = "active" | "revoked";

export type HandoffRequestState = "pending" | "redeemed" | "denied" | "expired";

export interface AgentGrantSummary {
  id: string;
  workspaceSlug: string;
  agentId: string;
  pluginId: string;
  actionKey: string;
  capability: "connector.observe" | "connector.dispatch" | "connector.admin";
  connectionId: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  state: AgentGrantState;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  consentId?: string;
  deploymentId?: string;
  durableConsent?: boolean;
}

export interface AgentConsentSummary {
  id: string;
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
  capability: AgentGrantSummary["capability"];
  connectionId: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  state: AgentGrantState;
  capabilities: AgentGrantSummary["capability"][];
  requiredActions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HandoffRequestSummary {
  id: string;
  portalOrgId: string;
  productTenantId: string;
  workspaceId: string;
  deploymentId: string;
  agentId: string;
  requestId: string;
  approvalUrl: string;
  expiresAt: string;
  idempotencyKey: string;
  selection: AgentGrantSelection;
  state: HandoffRequestState;
  consentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGrantsResponse {
  contractVersion: string;
  workspaceSlug: string;
  grants: AgentGrantSummary[];
  handoffRequests: HandoffRequestSummary[];
  consents: AgentConsentSummary[];
  handoffContractVersion: string;
  grantCreation: {
    available: false;
    code: "portal_handoff_required";
    detail: string;
  };
}

export interface AgentGrantRequestResponse {
  ok: true;
  schema: 1;
  contractVersion: string;
  authority: "marketplace_operator_session" | "marketplace_service_bearer";
  request: { requestId: string; approvalUrl: string; expiresAt: number };
  projection: HandoffRequestSummary;
}

export interface AgentGrantRedeemResponse {
  ok: true;
  schema: 1;
  contractVersion: string;
  authority: "marketplace_operator_session" | "marketplace_service_bearer";
  traceId: string;
  reconciled: boolean;
  created: boolean;
  consent: AgentConsentSummary;
  projection?: HandoffRequestSummary;
}

export interface FrontendBootstrap {
  program: { id: string; name: string; version: string };
  authorization: {
    browserOperatorRoutes: string;
    hubRoutesRequireBearer: true;
    crossAppRoutesRequireBearer: true;
    credentialExposedToBrowser: false;
    operatorSessionRequired: true;
  };
  surfaces: { standalone: string; embed: string; openapi: string };
  contractGaps: Record<string, string>;
}

export interface OperatorSession {
  configured: boolean;
  authenticated: boolean;
  mode: "session" | "test_bypass" | "unconfigured";
  principal: { kind: "operator"; id: string; organizationId: string } | null;
  csrfToken: string | null;
  expiresAt: string | null;
}

export interface AuditResponse {
  usage: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
}

export interface ProviderSettings {
  ok: boolean;
  values: {
    composioBaseUrl: string;
    composioDefaultUserId: string;
    composioDefaultConnectedAccountId: string;
  };
  status: { composioApiKey: { configured: boolean; source: string | null; keyTail: string | null; fingerprint: string | null } };
  provider: ProviderHealth;
}

export type RulesConnectionStatus = "connected" | "not-connected" | "unavailable";

export type RuntimeHealth = {
  ok: boolean;
  program: "ok";
  rules: RulesConnectionStatus;
  checkedAt: string;
};

export type ConnectorCapabilityName = "connector.observe" | "connector.dispatch" | "connector.admin";

export interface CustomConnectorTool {
  name: string;
  action: string;
  title: string | null;
  description: string | null;
  capability: ConnectorCapabilityName;
}

/** Browser-safe custom MCP connector view; secret values are never included. */
export interface CustomConnector {
  pluginId: string;
  displayName: string;
  description: string;
  transport: "streamable-http" | "sse";
  /** Origin and path only. */
  url: string;
  headers: Array<{ name: string; value: string }>;
  secretHeaders: Array<{ name: string; configured: boolean; fingerprint: string }>;
  tools: CustomConnectorTool[];
  lastRefresh: { at: string; ok: boolean; errorCode: string | null } | null;
  install: { installed: boolean; enabled: boolean; lifecycle: PluginInstall["lifecycle"] | null };
  connection: { state: PluginConnection["state"]; detail: string; updatedAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomConnectorsResponse {
  ok: true;
  workspaceSlug: string;
  secretStoreAvailable: boolean;
  items: CustomConnector[];
}

export interface CustomConnectorCreate {
  displayName: string;
  description?: string;
  transport: CustomConnector["transport"];
  url: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string>;
}

export interface CustomConnectorPatch {
  displayName?: string;
  description?: string;
  transport?: CustomConnector["transport"];
  url?: string;
  headers?: Record<string, string>;
  /** string = replace, null = remove, omitted = keep. */
  secretHeaders?: Record<string, string | null>;
}

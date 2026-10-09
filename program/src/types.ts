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
  /** `openapi`: Company Box REST adapter over a vendored OpenAPI spec. */
  source: "native" | "activepieces" | "composio" | "nango" | "mcp" | "openapi";
  authOwner: "nango" | "program" | "external" | "composio";
  executionOwner: "native" | "activepieces" | "composio" | "mcp" | "openapi";
  runtimeSources?: PluginRuntimeSourceDescriptor[];
  enabledByDefault: boolean;
  manifest: Record<string, unknown>;
  /**
   * Set only for listings owned by one workspace (operator custom MCP
   * connectors). Absent for global catalog listings.
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
  backend: "nango" | "activepieces" | "composio" | "native" | "mcp" | "openapi";
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
  selection:
    | {
        pluginId: string;
        actionKey: string;
        accountId: string;
        resourceKind: string;
        resourceRef: string;
      }
    | {
        /** Handoff v1.4 class selection, stored label-free. */
        pluginId: string;
        accountId: string;
        resourceKind: string;
        resourceRef: string;
        grantClass: "read" | "write" | "outward";
        actionGroup?: string;
      };
  state: "pending" | "redeemed" | "denied" | "expired";
  consentId: string | null;
  createdAt: string;
  updatedAt: string;
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
  sourceExecutor: "composio" | "native" | "activepieces" | "mcp" | "openapi";
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

export type CompanyBoxApprovalState =
  | "pending"
  /** An agent's owner-signed proof is being verified (single-shot claim; no provider call yet). */
  | "resolving"
  | "executing"
  | "succeeded"
  | "failed"
  | "denied"
  | "expired";

/** An agent's outward call held for the workspace owner (owner approval mode). */
export type CompanyBoxApproval = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  actionKey: string;
  capability: ConnectorCapability;
  agentId: string;
  /** How the agent's authority was proven: a stored grant or a Portal consent. */
  sourceKind: "agent-grant" | "runtime-lease" | "channel-consent";
  sourceRef: string;
  idempotencyKey: string | null;
  fingerprint: string;
  arguments: Record<string, unknown>;
  argumentsPreview: string;
  state: CompanyBoxApprovalState;
  /** Bounded (64 KB) stored result; larger results keep bytes + sha256 only. */
  result: unknown;
  error: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

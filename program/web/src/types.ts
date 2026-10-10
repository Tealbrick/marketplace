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

/**
 * How a connector can be connected, derived by the Program
 * (`program/src/connect-mode.ts`). The browser only displays it.
 */
export type ConnectMode =
  | "connected"
  | "no_auth"
  | "ready_auth_config"
  | "ready_managed"
  | "ready_user_key"
  | "needs_auth_config"
  | "needs_credentials"
  | "not_supported";

export interface ConnectInfo {
  /** Composio toolkit slug the auth config must belong to. */
  toolkit: string;
  authSchemes: string[];
  managedAuthSchemes: string[];
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
  /** Optional so an older Program without connect modes still renders. */
  connectMode?: ConnectMode;
  connectInfo?: ConnectInfo | null;
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
  connectMode?: ConnectMode;
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
  /** Per-mode counts after search/source/installed filters, before the mode filter. */
  connectModeCounts?: Partial<Record<ConnectMode, number>>;
  connections: ConnectionSummary[];
  items: PluginSummary[];
}

export interface CardDetailResponse {
  workspaceSlug: string;
  providers: Record<"nango" | "activepieces" | "composio", BrowserProviderHealth>;
  card: PluginCard;
}

export type ConnectorCapability = "connector.observe" | "connector.dispatch" | "connector.admin";

export interface AgentGrantSelection {
  pluginId: string;
  actionKey: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  /** Selection v1.2; absent means observe. */
  capability?: ConnectorCapability;
}

export interface AgentActionCatalogEntry {
  pluginId: string;
  pluginName: string;
  provider: string;
  actionKey: string;
  label: string;
  description: string;
  capability: ConnectorCapability;
  resourceKind: string;
  mode: "connected-account";
  accounts: Array<{ accountId: string; label?: string }>;
  allowedArguments: string[] | null;
  toolName: string;
}

export interface AgentActionCatalogResponse {
  contractVersion: string;
  workspaceSlug: string;
  actions: AgentActionCatalogEntry[];
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
  mode: "session" | "test_bypass" | "unconfigured" | "emergency";
  principal: { kind: "operator"; id: string; organizationId: string; organizationName?: string } | null;
  csrfToken: string | null;
  expiresAt: string | null;
  /** True when the break-glass emergency code is set up for this Marketplace (contract 12.3.3). */
  emergencyLogin?: boolean;
  /** Present while the signed-in session is a break-glass emergency session; the UI must show the banner. */
  emergency?: { banner: string };
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

/** "owner" when no Rules service is configured: the owner approves changes. */
export type GovernanceMode = "rules" | "owner";

export type RuntimeHealth = {
  ok: boolean;
  program: "ok";
  rules: RulesConnectionStatus;
  governance?: GovernanceMode;
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

export type CompanyBoxCredentialKey = "token" | "username" | "password" | "apiKey";

/** One Company Box entry and this workspace's state. Credential values are never included. */
export interface CompanyBoxEntry {
  id: string;
  displayName: string;
  description: string;
  category: string | null;
  source: "openapi" | "mcp";
  appVersion: string;
  homepage: string | null;
  baseUrlExample: string | null;
  auth: { type: "none" | "header" | "basic" | "query"; fields: Array<{ key: CompanyBoxCredentialKey; label: string; secret: boolean }> };
  coverage: { unit: "operations" | "tools"; total: number; exposed: number; excluded: number };
  exposure: "direct" | "discovery";
  outward: number;
  destructive: number;
  healthOperation: string | null;
  pluginId: string | null;
  installed: boolean;
  connection: { state: PluginConnection["state"]; detail: string; updatedAt: string; baseUrl: string | null } | null;
  credentials: Array<{ key: CompanyBoxCredentialKey; label: string; secret: boolean; configured: boolean; fingerprint?: string }>;
}

export interface CompanyBoxResponse {
  ok: true;
  workspaceSlug: string;
  collection: { id: string; label: string; description: string };
  secretStoreAvailable: boolean;
  entries: CompanyBoxEntry[];
  unavailable: Array<{ id: string; code: string }>;
}

export interface CompanyBoxSetup {
  baseUrl: string;
  /** Omitted keys keep the saved value. */
  credentials?: Partial<Record<CompanyBoxCredentialKey, string>>;
}

export interface CompanyBoxResult {
  ok: boolean;
  error?: string;
  entry: CompanyBoxEntry;
}

/** An agent's outward call held for the owner. Full arguments stay on the server. */
export interface CompanyBoxApproval {
  id: string;
  pluginId: string;
  app: string;
  actionKey: string;
  operation: { title: string; method: string | null; path: string | null };
  capability: ConnectorCapabilityName;
  agentId: string;
  argumentsPreview: string;
  state: "pending" | "resolving" | "executing" | "succeeded" | "failed" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  error: string | null;
  result?: unknown;
  /** Present when the held call is a channel post. */
  channel?: ChannelApprovalSummary;
}

export interface CompanyBoxApprovalsResponse {
  ok: true;
  workspaceSlug: string;
  pendingCount: number;
  /** The owner's Buzz approval key (fingerprint, trust source, status; never the key). */
  ownerKey?: OwnerKeyView;
  approvals: CompanyBoxApproval[];
}

/** Owner Buzz approval key (Channels spec §6.3): app-owned, owner-only; the UI only ever sees the fingerprint. */
export interface OwnerKeyView {
  setting: "approvals.ownerNostrPubkey";
  fingerprint: string | null;
  ownerKeySource: "owner-session" | "portal-attested" | null;
  ownerKeyStatus: "unset" | "ok" | "mismatch" | "error";
  attestedFingerprint: string | null;
  setAt: string | null;
  /** `unbound` until Portal confirms the deployment owner (claim `ownerSubject`); the key cannot be set before. */
  ownerPin?: "pinned" | "unbound";
}

export interface OwnerKeyResponse {
  ok: true;
  ownerKey: OwnerKeyView;
  changed?: boolean;
  invalidatedHolds?: number;
}

// ----- Channels (spec docs/channels-spec.md v0.2, owner audience) -----------

export type ChannelProviderId = "telegram" | "discord" | "slack" | "teams" | "buzz";
export type ChannelReadiness = "available" | "credential_missing" | "credential_invalid" | "paused" | "unavailable";
export type ChannelStatus = "draft" | "active" | "paused" | "archived";
export type GrantPhase = "announce" | "reminder" | "recap" | "update";

export interface ChannelDestination {
  type: string;
  externalId: string;
  /** Untrusted provider text. Always rendered as plain text. */
  title: string;
  url?: string;
  parentId?: string;
}

export interface ChannelScheduleWindow {
  timeZone: string;
  start: string;
  end: string;
  days?: number[];
}

export interface ChannelPolicy {
  standingGrants: "disabled" | "allowed";
  caps: {
    perDay: number;
    perHour?: number;
    minIntervalSeconds: number;
    onePerPhase: boolean;
    /** Routes v2: reactions, edits and deletes have their own caps (never the post caps). */
    actions?: { reactionsPerDay: number; editsPerDay: number; editMinIntervalSeconds: number; deletesPerDay: number };
  };
  content: {
    maxChars?: number;
    files: { allowed: boolean; types: string[]; maxBytes: number; maxCount: number };
    requireConfirmedEvent: boolean;
    listingHosts: string[];
    denyPatterns: string[];
  };
  schedule: { window?: ChannelScheduleWindow };
}

export type ChannelMediaCapability = { types: string[]; maxBytes: number } | false;

/** What agents can send on one channel: the provider declaration narrowed by the channel policy. */
export interface ChannelEffectiveCapabilities {
  channelCapabilities: number;
  text: { maxChars: number; captionMaxChars?: number };
  markup: string;
  mentions: { users: boolean; broadcast: "suppressed" } | "suppressed";
  image: ChannelMediaCapability;
  file: ChannelMediaCapability;
  audio: ChannelMediaCapability;
  video: ChannelMediaCapability;
  voice: ({ native: true; types: string[]; maxBytes: number; maxSeconds?: number }) | ({ fallback: string; types: string[]; maxBytes: number }) | false;
  maxAttachments: number;
  thread: { replies: boolean; topics: boolean; forum?: boolean } | false;
  schedule: { native: boolean };
  limits: { perChatPerSecond?: number; perChatPerMinute?: number; retryAfter: string };
  // Capability model v2 (channelCapabilities: 2). Absent in a v1 answer: the owner screen then shows them as not available.
  dm?: { open: boolean; maxMembers: number };
  reactions?: { add: boolean; remove: boolean; custom: boolean } | boolean;
  edit?: { own: boolean; windowSeconds?: number } | boolean;
  delete?: { own: boolean; windowSeconds?: number } | boolean;
  canvas?: boolean;
  presence?: { typing: boolean; status: boolean };
  ephemeral?: boolean;
  live?: { join: boolean; listen: boolean; speak: boolean; transcript: boolean; maxSessionMinutes: number } | false;
  inbound?: { mode: "socket" | "webhook" | "poll" | "none"; dedupe: boolean } | string;
  /** Markups a post may ask for besides `markup` (Telegram: markdown-v2). */
  markupOptions?: string[];
  poll?: { questionMaxChars: number; minOptions: number; maxOptions: number; optionMaxChars: number; multiple: boolean; durationHours?: { min: number; max: number; default: number } } | false;
}

export interface GrantCaps { perDay: number; perHour?: number; minIntervalSeconds: number; onePerPhase: boolean }
export type GrantFileScope = false | { types?: string[]; maxBytes?: number; maxCount?: number };
/** Optional grant scope flags: absent or false = not covered (the operation waits for the owner). */
export type GrantScopeFlag = "replies" | "reactions" | "edits" | "deletes" | "polls" | "dms";

export interface GrantScope extends Partial<Record<GrantScopeFlag, boolean>> {
  phases?: GrantPhase[];
  campaignRefs?: string[];
  files: GrantFileScope;
  maxChars?: number;
  immediate: boolean;
  scheduled: boolean;
}
export interface GrantTerms { caps: GrantCaps; scope: GrantScope; notBefore?: string | null; expires: string }

export type StandingGrantStatus = "proposed" | "active" | "suspended" | "withdrawn" | "revoked" | "expired" | "declined";

export interface StandingGrantView extends GrantTerms {
  id: string;
  channelId: string;
  agentId: string;
  purpose: string;
  notBefore: string | null;
  status: StandingGrantStatus;
  digest: string;
  proposedAt: string;
  approvedAt: string | null;
  approvalSource: string | null;
  reason: string | null;
}

/** A Portal v1.4 class selection narrowed to one channel ("Grant to agent"). */
export interface ChannelGrantSelection {
  pluginId: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  grantClass: "outward" | "read";
  actionGroup: string;
  /** Display-only, plain text ≤ 80; Portal never stores it. */
  actionGroupLabel?: string;
}

export interface ChannelView {
  id: string;
  workspaceSlug: string;
  slug: string;
  label: string;
  kind: string;
  provider: string;
  connectionId: string;
  destination: ChannelDestination;
  audience: string;
  language: string;
  purpose: string;
  policy: ChannelPolicy;
  status: ChannelStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  capabilities: ChannelEffectiveCapabilities | null;
  usageToday: number;
  grants: StandingGrantView[];
  grantSelection: ChannelGrantSelection;
}

export interface ChannelConnectionView {
  connectionId: string;
  state: string;
  botUsername: string | null;
  verifiedAt: string | null;
  /** Routes v2: who agents may send direct messages to on this connection. */
  peoplePolicy?: PeoplePolicyView;
}

export type PeoplePolicyMode = "none" | "allowlist" | "workspace";

export interface PeoplePolicyView {
  mode: PeoplePolicyMode;
  /** Exact emails or handles (lowercase). */
  people: string[];
  /** Email domains. */
  domains: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

/** A person an agent found on a connection (owner view only). */
export interface ChannelPersonView {
  personRef: string;
  /** People and their approvals are per agent: each agent's first message to a person waits for the owner. */
  agentId: string;
  provider: string;
  displayName: string;
  platformUserId: string;
  lookup: { kind: "email" | "handle"; value: string };
  approved: boolean;
  approvedAt: string | null;
  approvedPostId: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

/** What a routes v2 post does (owner views): a reaction, edit, delete, DM, poll, or a post with mentions or markup. */
export interface ChannelActionView {
  op: "post" | "poll" | "react" | "edit" | "delete" | "dm";
  mentions?: string[];
  markup?: string;
  poll?: { question: string; options: string[] };
  targetMessageId?: string;
  /** The first 200 characters of the target message (from its kept receipt), or null when it is gone. */
  targetExcerpt?: string | null;
  emoji?: string;
  remove?: boolean;
  person?: { personRef: string; displayName: string; platformUserId?: string; lookup?: { kind: "email" | "handle"; value: string }; approved: boolean } | null;
}

export interface UncertainChannelPost {
  id: string;
  channelId: string;
  agentId: string;
  digest: string;
  reason: string | null;
  updatedAt: string;
}

export type ChannelMediaDeclaration = { types: string[]; maxBytes: number };

/** A provider's static capability declaration (spec §3.1), from the owner browse answer. */
export interface ChannelProviderCapabilities {
  text: { maxChars: number; captionMaxChars?: number };
  markup: string;
  channelCapabilities?: number;
  image: (ChannelMediaDeclaration & { albumMax?: number }) | false;
  file: ChannelMediaDeclaration | false;
  audio: ChannelMediaDeclaration | false;
  voice: (ChannelMediaDeclaration & ({ native: true; maxSeconds?: number } | { fallback: string })) | false;
  video: ChannelMediaDeclaration | false;
  /** v2: direct messages (the people panel shows for providers that offer them). */
  dm?: { open: boolean; maxMembers: number };
}

export interface ChannelProviderEntry {
  id: string;
  readiness: ChannelReadiness;
  /** Present once the provider has a credential (not `credential_missing`). */
  capabilities?: ChannelProviderCapabilities | null;
  /** Channel kinds this provider serves. */
  kinds?: string[];
}

/** The Buzz connection identity (owner view): never the secret key. */
export interface BuzzIdentityView {
  key: { present: boolean; npub: string | null; pubkeyHex: string | null; createdAt: string | null };
  relay: { url: string | null; httpBase: string | null };
  authTag: {
    status: "missing" | "valid" | "invalid" | "expired";
    reason?: string;
    sha256: string | null;
    ownerNpub: string | null;
    ownerFingerprint: string | null;
    conditions: string | null;
    expiresAt: string | null;
    daysLeft: number | null;
    renewalDue: boolean;
    setAt: string | null;
    /** Event kinds the tag lets Marketplace publish. */
    allowsKinds: number[];
  };
  readiness: "available" | "credential_missing" | "credential_invalid";
  /** The only kinds Marketplace ever signs with the agent key. */
  signableKinds: number[];
  signing: { preimage: string; suggestedConditions: string; maxDays: number; reminderDays: number } | null;
  pinnedOwner: { set: boolean; fingerprint: string | null };
  secretStore: "available" | "unavailable";
}

export interface BuzzIdentityResponse {
  ok: true;
  schema: 1;
  changed?: boolean;
  buzz: BuzzIdentityView;
  /** Inert mode: the first identity takes effect after Marketplace restarts. */
  appliesAfterRestart?: boolean;
}

/** Inert mode: no channel credentials are configured, so only provider readiness is reported. */
export interface ChannelsInertResponse {
  ok: true;
  schema: 1;
  configured: false;
  providers: ChannelProviderEntry[];
  /** Present when the Buzz provider is loaded (the identity can be set up in inert mode). */
  buzz?: BuzzIdentityView;
}

export interface ChannelsBrowseResponse {
  ok: true;
  schema: 1;
  configured: true;
  providers: ChannelProviderEntry[];
  readiness: Partial<Record<ChannelProviderId, ChannelReadiness>>;
  connections: Partial<Record<ChannelProviderId, ChannelConnectionView | null>>;
  channels: ChannelView[];
  pendingGrants: StandingGrantView[];
  uncertainPosts: UncertainChannelPost[];
  buzz?: BuzzIdentityView;
}

export type ChannelsBrowseAnswer = ChannelsBrowseResponse | ChannelsInertResponse;

export type ChannelPostStatus = "held" | "scheduled" | "sending" | "sent" | "failed" | "uncertain" | "skipped" | "cancelled" | "expired";

/** An owner posts-list row (marketplace.channel-posts.list); never the text. */
export interface ChannelPostSummary {
  id: string;
  channelId: string;
  channel: { slug: string; label: string; provider: string } | null;
  agentId: string;
  mode: "immediate" | "scheduled";
  status: ChannelPostStatus;
  sendAt: string | null;
  digestPrefix: string;
  authority: string | null;
  reason: string | null;
  attachments: number;
  approval?: { id: string; state: string; expiresAt: string };
  action?: ChannelActionView;
  createdAt: string;
}

export interface ChannelDiscoverResponse {
  ok: true;
  schema: 1;
  provider: ChannelProviderId;
  destinations: ChannelDestination[];
  /** Owner-facing remarks written by Marketplace, e.g. Teams private channels left out. */
  notes?: string[];
}

export type ChannelReceiptStatus = "sent" | "failed" | "uncertain" | "pending" | "skipped" | "cancelled" | "expired";

export interface ChannelReceipt {
  resultIds: string[];
  resultUrls: string[];
  status: ChannelReceiptStatus;
  detail: string | null;
  channelId: string;
  postId: string;
  digest: string;
  authority: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  provider: string;
  fallback?: string;
}

export interface ChannelReceiptExport extends ChannelReceipt {
  agentId: string;
  text: string | null;
  createdAt: string;
}

export interface ChannelCreateInput {
  provider: ChannelProviderId;
  slug: string;
  label: string;
  kind?: string;
  destination: { externalId: string; parentId?: string };
  audience?: string;
  language?: string;
  purpose?: string;
  policy?: ChannelPolicyInput;
}

export interface ChannelPolicyInput {
  standingGrants?: ChannelPolicy["standingGrants"];
  caps?: Partial<ChannelPolicy["caps"]>;
  content?: Partial<Omit<ChannelPolicy["content"], "files">> & { files?: Partial<ChannelPolicy["content"]["files"]> };
  schedule?: { window?: ChannelScheduleWindow };
}

/** The held channel post in an approvals list item (never the text). */
export interface ChannelApprovalSummary {
  channelId: string | null;
  label: string | null;
  provider: string | null;
  postId: string | null;
  postStatus: string | null;
  mode: "immediate" | "scheduled" | null;
  sendAt: string | null;
  digest: string;
  digestPrefix: string;
  /** Routes v2: the operation kind with its emoji, target excerpt or person. Null for a plain post. */
  action?: ChannelActionView | null;
}

/** The exact payload the digest covers, on the owner detail view of a channel hold. */
export type ChannelPayloadView =
  | {
      digest: string;
      matchesHeldDigest: boolean;
      text: string;
      canonical: string;
      files: Array<{ name: string; sha256: string; contentType: string; kind: string; bytes: number }>;
      fallbacks: string[];
      op?: string;
      action?: ChannelActionView | null;
    }
  | { error: string };

// ----- Live sessions (Channels P2 scope 2.3): live-session grants and Buzz huddle sessions -----

export type LiveGrantStatus = "proposed" | "active" | "paused" | "revoked" | "expired" | "declined" | "withdrawn";

export type LiveGrantSummary = {
  target: { channelId?: string; huddleId?: string; voiceChannelId?: string };
  modes: { listen: boolean; speakApproved: boolean; speakLive: boolean };
  maxSessionMinutes: number;
  maxDayMinutes: number;
  providerMinutesCap: number;
  topic: string;
  forbiddenTerms: string[];
  consent: { disclosureNotice: boolean; perParticipantConsent: boolean };
  caps: { perDay: number; perHour?: number; minIntervalSeconds?: number };
  expires: string;
};

export type LiveGrantUsage = {
  minutesToday: number;
  maxDayMinutes: number | null;
  minutesInSession: number;
  maxSessionMinutes: number | null;
  providerMinutes: number;
  providerMinutesCap: number | null;
  activeSessionId: string | null;
};

export type LiveGrantView = {
  id: string;
  channelId: string;
  channelLabel?: string | null;
  agentId: string;
  status: LiveGrantStatus;
  digest: string;
  approvalText: string;
  canonical: string;
  summary: LiveGrantSummary | null;
  proposedAt: string;
  approvedAt: string | null;
  approvalSource: "marketplace-ui" | "nostr" | "portal" | null;
  approvalExpiresAt: string | null;
  reason: string | null;
  providerMinutesUsed: number;
  usage?: LiveGrantUsage;
};

export type LiveSessionView = {
  sessionId: string;
  grantId: string;
  channelId: string;
  channelLabel?: string | null;
  agentId: string;
  huddleId: string;
  modes: { listen?: true; speakApproved?: true; speakLive?: true };
  status: "joining" | "joined" | "left" | "failed";
  startedAt: string;
  joinedAt: string | null;
  leftAt: string | null;
  endReason: string | null;
  minutesListened: number;
  minutesSpoken: number;
  providerMinutes: number;
  disclosureEventId: string | null;
  peers: number | null;
};

export type LiveTranscriptLine = {
  kind: "heard" | "said" | "notice";
  framing: "untrusted-external-speech" | "agent-own";
  speaker?: { pubkey: string; npub: string } | null;
  text: string;
  clipSha256?: string;
  flaggedTerms?: string[];
  startedAt: string;
  endedAt: string;
  purged: boolean;
};

export type LiveOverview = {
  ok: true;
  control: { paused: boolean; pausedAt: string | null; pausedBy: string | null; commandChannel: string | null; updatedAt: string | null };
  buzzReady: boolean;
  grants: LiveGrantView[];
  sessions: LiveSessionView[];
};

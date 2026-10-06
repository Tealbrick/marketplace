import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import {
  buildComposioCatalogListing,
  buildComposioListingFromTools,
  composioToolNameForAction,
  defaultSkillsForComposioToolkit,
  normalizeComposioTools,
  normalizeConnectorSlug,
  resolveActionRequirement,
  type ComposioListingTool,
} from "./connectors.js";
import {
  createComposioAuthLink,
  executeComposioTool,
  fetchActivepiecesCatalog,
  fetchComposioCatalog,
  fetchComposioConnectedAccounts,
  fetchComposioToolkitTools,
  readProviderHealth,
  readProviderHealthWithReachability,
  type ProviderEnvironment,
} from "./provider-health.js";
import {
  ConnectorSecretStoreUnavailableError,
  SqliteMarketplaceStore,
} from "./store.js";
import {
  assertHeaderSets,
  bindCustomMcpForWorkspace,
  customConnectorView,
  customMcpListing,
  customMcpManifest,
  customMcpPluginId,
  customMcpToolForAction,
  CustomMcpCreateSchema,
  CustomMcpInputError,
  CustomMcpPatchSchema,
  normalizePlainHeaders,
  normalizeSecretHeaderChanges,
  requestsStdioTransport,
  toolRecordsFromRemote,
  type CustomMcpManifest,
} from "./custom-mcp.js";
import {
  callMcpTool,
  listMcpTools,
  MCP_MAX_TOOLS,
  McpRemoteError,
} from "./mcp-remote-client.js";
import {
  companyBoxCatalogDir,
  companyBoxDirectMaxOperations,
  companyBoxListing,
  companyBoxManifest,
  companyBoxMcpToolRisk,
  listingIsCompanyBoxOpenApi,
  loadCompanyBoxCatalog,
  retiredCompanyBoxListing,
  runtimeAuthFor,
  searchAgentOperations,
  type AgentOperation,
  type CompanyBoxCatalog,
  type CompiledMcpEntry,
  type CompiledOpenApiEntry,
} from "./company-box.js";
import {
  callOpenApiOperation,
  OpenApiCallError,
  companyBoxMaxUploadBytes,
  validateOpenApiArguments,
} from "./openapi-http.js";
import { registerCompanyBoxRoutes } from "./company-box-routes.js";
import { OPENAPI_TOOL_SCHEMA_MAX_BYTES } from "./openapi-adapter.js";
import { outputDigest } from "./usage-ledger.js";
import { tailnetHealth } from "./tailnet.js";
import {
  checkMcpUrlSyntax,
  McpUrlPolicyError,
  type McpLookup,
} from "./mcp-url-policy.js";
import {
  assertComposioApiKeyFormat,
  composioKeyFingerprint,
  MarketplaceProviderSettingsStore,
  ProviderSettingsError,
} from "./provider-settings.js";
import {
  listingIsCustomMcp,
  listingIsOperatorCustomMcp,
  listingIsRequired,
  marketplaceCapabilitiesHostProjection,
  marketplacePluginRecord,
  marketplaceMcpAdapterConfig,
  mcpListingFromInput,
  reconcileGatewayRegistry,
} from "./hub.js";
import {
  projectExtensionSettings,
  type CapabilitiesHostProjection,
} from "./extension-settings-projection.js";
import { registerMarketplaceFrontend } from "./frontend.js";
import {
  governanceModeFor,
  ownerGovernedDecision,
  type GovernanceActor,
  type GovernedActionRisk,
  type GovernanceMode,
} from "./governance.js";
import { MARKETPLACE_VERSION } from "./version.js";
import {
  MarketplaceAuthenticationError,
  MarketplaceOperatorSessionManager,
  marketplaceSecretMatches,
  type MarketplacePrincipal,
} from "./operator-auth.js";
import {
  applyScopedResource,
  MARKETPLACE_AGENT_GRANT_CONTRACT_VERSION,
} from "./agent-grant-contract.js";
import {
  AGENT_SELECTION_ACCOUNT_ID_PATTERN,
  AGENT_SELECTION_ACTION_KEY_MAX_LENGTH,
  AGENT_SELECTION_ACTION_KEY_PATTERN,
  AGENT_SELECTION_PLUGIN_ID_PATTERN,
  AGENT_SELECTION_RESOURCE_KIND_PATTERN,
  agentAccountIdForConnection,
  connectedAccountIdFromConnection,
  listingExecutableForAgents,
  MARKETPLACE_AGENT_ACTION_CATALOG_CONTRACT_VERSION,
  publishedAgentActionCatalog,
  publishedAgentActionsForListing,
  resolvePublishedAgentAction,
  selectionCapability,
  type AgentActionCatalogEntry,
} from "./agent-action-catalog.js";
import {
  createPortalAgentScopeVerifier,
  PortalScopeError,
  type PortalAgentScope,
  type PortalAgentScopeVerifier,
} from "./portal-scope.js";
import {
  createPortalHandoffClient,
  MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
  PortalHandoffError,
  type MarketplacePortalSelection,
} from "./portal-handoff.js";
import {
  createPortalRuntimeScopeVerifier,
  PortalRuntimeScopeError,
  type PortalRuntimeScopeVerifier,
} from "./portal-runtime-scope.js";
import { resolvePortalRuntimeConfiguration } from "./portal-config.js";
import { acceptedIds, compatDebugEnabled, LEGACY_IDS } from "./legacy-ids.js";
import {
  parseRulesReadinessPrincipal,
  RULES_INTROSPECTION_PATH,
  type RulesReadinessConfiguration,
} from "./rules-readiness.js";
import type {
  AgentConnectorGrant,
  CompanyBoxApproval,
  ConnectorCapability,
  MarketplaceGatewayRegistrySnapshot,
  MarketplaceListing,
  MarketplacePortalGrantRequest,
  MarketplaceSkillDeclaration,
  RulesClient,
} from "./types.js";

const WorkspaceQuerySchema = z.object({
  workspaceSlug: z.string().trim().min(1).default("default"),
});

const CardsSummaryQuerySchema = WorkspaceQuerySchema.extend({
  search: z.string().trim().max(200).default(""),
  source: z
    .enum(["all", "native", "activepieces", "composio", "nango", "mcp", "openapi"])
    .default("all"),
  installed: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(60),
});

/**
 * Composio API base URLs are restricted to HTTPS composio.dev hosts. A
 * deployment may add exact extra origins through
 * MARKETPLACE_COMPOSIO_ALLOWED_ORIGINS (for example a local fixture); nothing
 * else is reachable with the provider key attached.
 */
export function allowedComposioOrigin(value: string, env: Record<string, string | undefined> = process.env) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol === "https:" &&
    (hostname === "composio.dev" || hostname.endsWith(".composio.dev"))
  ) {
    return true;
  }
  const configured = new Set(
    (env.MARKETPLACE_COMPOSIO_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  return configured.has(parsed.origin);
}

const ComposioProviderSettingsSchema = z.object({
  composioApiKey: z
    .string()
    .trim()
    .max(512)
    .refine(
      (value) => value === "" || /^[\x21-\x7E]+$/u.test(value),
      "Composio API key must contain printable ASCII without spaces or line breaks.",
    )
    .optional(),
  composioBaseUrl: z
    .string()
    .trim()
    .refine(
      (value) => allowedComposioOrigin(value),
      "Composio base URL must be an https://*.composio.dev address or an explicitly allowlisted origin.",
    ),
  composioDefaultUserId: z.string().trim().min(1),
  composioDefaultConnectedAccountId: z.string().trim().optional().default(""),
});

const ComposioProviderSettingsRequestSchema = z.object({
  settings: ComposioProviderSettingsSchema,
});

const InstallInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  actorId: z.string().trim().min(1).default("operator"),
});

const HubAuthQuerySchema = z.object({
  workspaceSlug: z.string().trim().min(1).default("default"),
});

const SettingsSurfaceDeclarationSchema = z.object({
  settingsSurfaceId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  schema: z.record(z.unknown()).optional(),
  uiSchema: z.record(z.unknown()).optional(),
});

const ExtensionContributionSchema = z.object({
  id: z.string().trim().min(1),
  type: z.literal("extension-surface").default("extension-surface"),
  label: z.string().trim().min(1),
  mount: z.enum(["workspace", "right-rail", "settings-panel", "overlay"]),
  routeSegment: z.string().trim().min(1),
  region: z.string().trim().min(1).optional(),
  minHostSdk: z.string().trim().min(1).optional(),
  settings: SettingsSurfaceDeclarationSchema.optional(),
  enabled: z.boolean().default(true),
});

const McpPluginFieldsSchema = z.object({
  workspaceSlug: z.string().trim().min(1).default("default"),
  actorId: z.string().trim().min(1).default("operator"),
  pluginId: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
  transport: z.enum(["stdio", "sse", "streamable-http"]),
  command: z.string().trim().min(1).optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  cwd: z.string().trim().min(1).optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  config: z.record(z.unknown()).optional(),
  contributions: z.array(ExtensionContributionSchema).optional(),
  capabilities: z
    .array(
      z.enum(["connector.observe", "connector.dispatch", "connector.admin"]),
    )
    .optional(),
  actions: z.array(z.string().trim().min(1)).optional(),
});

const McpPluginSchema = McpPluginFieldsSchema.superRefine((value, context) => {
  if (value.transport === "stdio" && !value.command) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "stdio MCP Plugins require a command.",
    });
  }
  if (value.transport !== "stdio" && !value.url) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "Network MCP Plugins require a URL.",
    });
  }
  const contributionIds =
    value.contributions?.map((contribution) => contribution.id) ?? [];
  if (new Set(contributionIds).size !== contributionIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributions"],
      message: "Each contributed Extension surface requires a unique id.",
    });
  }
});

const McpPluginUpdateSchema = McpPluginFieldsSchema.omit({
  workspaceSlug: true,
  actorId: true,
  pluginId: true,
}).partial();

const HubLifecycleSchema = z.object({
  workspaceSlug: z.string().trim().min(1).default("default"),
  actorId: z.string().trim().min(1).default("operator"),
  action: z.enum(["install", "enable", "disable", "reload", "uninstall"]),
});

const GatewayRegistrySnapshotSchema = z.object({
  contractVersion: z.string().trim().min(1),
  revision: z.coerce.number().int().nonnegative(),
  units: z.array(
    z.object({
      unitId: z.string().trim().min(1),
      version: z.string().trim().min(1),
      enabled: z.boolean(),
      required: z.boolean().optional(),
    }),
  ),
  contributions: z.array(
    z.object({
      id: z.string().trim().min(1),
      unitId: z.string().trim().min(1),
      type: z.string().trim().min(1),
      label: z.string().trim().min(1),
      family: z.string().optional(),
      region: z.string().optional(),
      mount: z.string().optional(),
      routeSegment: z.string().optional(),
    }),
  ),
  flags: z.object({ developerMode: z.boolean().optional() }).optional(),
});

const BindingInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  actorId: z.string().trim().min(1).default("operator"),
  capability: z.enum([
    "connector.observe",
    "connector.dispatch",
    "connector.admin",
  ]),
  enabled: z.boolean().default(true),
});

const ActionBindingInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  actorId: z.string().trim().min(1).default("operator"),
  actionKey: z.string().trim().min(1),
  enabled: z.boolean().default(true),
});

const ConnectionInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  actorId: z.string().trim().min(1).default("operator"),
  provider: z.string().trim().min(1),
  backend: z
    .enum(["nango", "activepieces", "composio", "native"])
    .default("composio"),
  credentialRef: z.string().trim().min(1).optional(),
  toolkit: z.string().trim().min(1).optional(),
  authConfigId: z.string().trim().min(1).optional(),
  callbackUrl: z.string().trim().min(1).optional(),
  callbackBaseUrl: z.string().trim().min(1).optional(),
  userId: z.string().trim().min(1).optional(),
  alias: z.string().trim().min(1).optional(),
  connectionData: z.record(z.unknown()).optional(),
});

const ExecuteInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  actorId: z.string().trim().min(1).default("operator"),
  capability: z.enum([
    "connector.observe",
    "connector.dispatch",
    "connector.admin",
  ]),
  action: z.object({ type: z.string().trim().min(1) }).passthrough(),
  runId: z.string().trim().min(1).optional().nullable(),
  sessionId: z.string().trim().min(1).optional().nullable(),
  agentGrantId: z.string().trim().min(1).optional(),
  resourceRef: z.string().trim().min(1).optional(),
  /** Company Box: deduplicates held outward calls per agent. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u).optional(),
});

const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u);

const AgentGrantInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  actionKey: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  resourceKind: z.string().trim().min(1),
  resourceRef: z.string().trim().min(1),
});

const PortalIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z0-9_:-]{1,128}$/u);

const ConnectorCapabilitySchema = z.enum([
  "connector.observe",
  "connector.dispatch",
  "connector.admin",
]);

// Selection v1.2: the v1.1 five identity keys plus an optional capability.
// Which pluginId/actionKey/resourceKind values are usable is decided by the
// published agent action catalog, not by this schema.
const PortalSelectionSchema = z
  .strictObject({
    pluginId: z.string().regex(AGENT_SELECTION_PLUGIN_ID_PATTERN),
    actionKey: z
      .string()
      .max(AGENT_SELECTION_ACTION_KEY_MAX_LENGTH)
      .regex(AGENT_SELECTION_ACTION_KEY_PATTERN),
    accountId: z.string().regex(AGENT_SELECTION_ACCOUNT_ID_PATTERN),
    resourceKind: z.string().regex(AGENT_SELECTION_RESOURCE_KIND_PATTERN),
    resourceRef: z
      .string()
      .regex(/^account:[A-Za-z0-9_:-]{1,128}$/u),
    capability: ConnectorCapabilitySchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.resourceRef !== `account:${value.accountId}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resourceRef"],
        message: "resourceRef must bind exactly to accountId.",
      });
    }
  });

const PortalHandoffRequestSchema = z.strictObject({
  deploymentId: PortalIdentifierSchema,
  agentId: PortalIdentifierSchema,
  selection: PortalSelectionSchema,
  idempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/u),
});

const PortalHandoffRedeemSchema = z.strictObject({
  deploymentId: PortalIdentifierSchema,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

const RuntimeComposioExecuteSchema = z.strictObject({
  schema: z.literal(1),
  consentId: PortalIdentifierSchema,
  selection: PortalSelectionSchema,
  input: z.record(z.unknown()),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/u),
});

const AgentCapabilitiesQuerySchema = WorkspaceQuerySchema.extend({
  grantId: z.string().trim().min(1).optional(),
});

const AgentGrantListQuerySchema = WorkspaceQuerySchema.extend({
  agentId: z.string().trim().min(1).optional(),
  pluginId: z.string().trim().min(1).optional(),
  state: z.enum(["active", "revoked"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const BrokerGrantInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  actorId: z.string().trim().min(1).default("operator"),
  requesterMiniappId: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  actionKeys: z.array(z.string().trim().min(1)).min(1),
  ttlSeconds: z.coerce.number().int().positive().max(900).default(300),
  metadata: z.record(z.unknown()).default({}),
});

const BrokerExecuteInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  requesterMiniappId: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  brokerToken: z.string().trim().min(1),
  action: z.object({ type: z.string().trim().min(1) }).passthrough(),
  runId: z.string().trim().min(1).optional().nullable(),
  sessionId: z.string().trim().min(1).optional().nullable(),
});

// Emitted (and stored/forwarded) id stays the legacy one during the
// Tealbrick transition; requests may use either spelling. See legacy-ids.ts.
const CROSS_APP_MARKETPLACE_BROKER_EXECUTE_CONTRACT_VERSION =
  LEGACY_IDS["tealbrick.cross-app.marketplace.broker-execute.v1"];

const CrossAppBrokerExecuteInputSchema = z.object({
  contractVersion: z
    .enum(acceptedIds("tealbrick.cross-app.marketplace.broker-execute.v1"))
    .transform(() => CROSS_APP_MARKETPLACE_BROKER_EXECUTE_CONTRACT_VERSION),
  sourceMiniappId: z.string().trim().min(1),
  requesterMiniappId: z.string().trim().min(1).optional(),
  sourceId: z.string().trim().min(1),
  eventType: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
  traceId: z.string().trim().min(1),
  workspaceSlug: z.string().trim().min(1),
  pluginId: z.string().trim().min(1),
  action: z.object({ type: z.string().trim().min(1) }).passthrough(),
  runId: z.string().trim().min(1).optional().nullable(),
  sessionId: z.string().trim().min(1).optional().nullable(),
  ttlSeconds: z.coerce.number().int().positive().max(900).default(300),
  metadata: z.record(z.unknown()).default({}),
});

const AuditQuerySchema = z.object({
  workspaceSlug: z.string().trim().min(1).optional(),
  pluginId: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const SessionCorrelationInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1).default("default"),
  appThreadId: z.string().trim().min(1),
  provider: z.string().trim().min(1).default("hermes"),
  providerInstanceId: z.string().trim().min(1),
  remoteSessionId: z.string().trim().min(1).optional(),
  hermesLiveSessionId: z.string().trim().min(1).optional().nullable(),
  hermesStoredSessionId: z.string().trim().min(1).optional().nullable(),
  profile: z.string().trim().min(1).optional().nullable(),
  runtimeMode: z.string().trim().min(1).optional().nullable(),
  cwd: z.string().trim().min(1).optional().nullable(),
  source: z.string().trim().min(1).default("doppelganger-app"),
  eventType: z.string().trim().min(1).default("session.observed"),
  metadata: z.record(z.unknown()).default({}),
});

const SessionCorrelationQuerySchema = z.object({
  workspaceSlug: z.string().trim().min(1).default("default"),
  appThreadId: z.string().trim().min(1).optional(),
  remoteSessionId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

const SkillDeclarationSchema = z.object({
  skillId: z.string().trim().min(1),
  skillName: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  sourcePath: z.string().trim().min(1).optional(),
  skillRoot: z.string().trim().min(1).optional(),
  requiresConnectors: z.array(z.string().trim().min(1)).default([]),
});

const ComposioImportInputSchema = z.object({
  workspaceSlug: z.string().trim().min(1),
  actorId: z.string().trim().min(1).default("operator"),
  toolkit: z.string().trim().min(1),
  pluginId: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  tools: z.array(z.record(z.unknown())).optional(),
  actionKeys: z.array(z.string().trim().min(1)).optional(),
  skills: z.array(SkillDeclarationSchema).optional(),
  autoEnable: z.boolean().default(true),
  bindCapabilities: z
    .array(
      z.enum(["connector.observe", "connector.dispatch", "connector.admin"]),
    )
    .optional(),
});

const ComposioToolsQuerySchema = z.object({
  toolkit: z.string().trim().min(1),
  limit: z.coerce.number().int().positive().max(250).default(50),
});

const ComposioCallbackQuerySchema = z.object({
  state: z.string().trim().min(1),
  status: z.string().trim().min(1).optional(),
  connected_account_id: z.string().trim().min(1).optional(),
  connectedAccountId: z.string().trim().min(1).optional(),
  connection_id: z.string().trim().min(1).optional(),
  account_id: z.string().trim().min(1).optional(),
  error: z.string().trim().min(1).optional(),
});

const PortalLaunchFormSchema = z.strictObject({
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

export type BuildMarketplaceAppOptions = {
  store: SqliteMarketplaceStore;
  internalAuthToken?: string | null;
  microappsRoot?: string;
  rulesClient?: RulesClient;
  providerFetch?: typeof fetch;
  /** Outbound fetch for operator custom MCP servers (tests inject a fake). */
  mcpFetch?: typeof fetch;
  /** DNS lookup used by the MCP URL policy (tests inject a resolver). */
  mcpLookup?: McpLookup;
  env?: ProviderEnvironment;
  debug?: boolean;
  logPath?: string;
  providerSettings?: MarketplaceProviderSettingsStore;
  operatorSessionManager?: MarketplaceOperatorSessionManager;
  allowUnauthenticatedOperator?: boolean;
  organizationId?: string;
  portalIssuerUrl?: string | null;
  portalAttachmentAudience?: string;
  portalFetch?: typeof fetch;
  environment?: ProviderEnvironment;
  agentScopeVerifier?: PortalAgentScopeVerifier;
  portalInstanceProof?: string | null;
  portalRuntimeScopeVerifier?: PortalRuntimeScopeVerifier;
  rules?: RulesReadinessConfiguration;
  /** Company Box catalog directory (default MARKETPLACE_COMPANY_BOX_DIR or program/catalog/company-box). */
  companyBoxCatalogDir?: string;
  /** Pre-compiled Company Box catalog (tests); wins over companyBoxCatalogDir. */
  companyBoxCatalog?: CompanyBoxCatalog;
  /** Outbound fetch for Company Box REST apps (tests inject a fake); defaults to mcpFetch. */
  companyBoxFetch?: typeof fetch;
};

type RulesGateInput = {
  reply: FastifyReply;
  workspaceSlug: string;
  operation: string;
  capability: ConnectorCapability;
  pluginId: string;
  /** Sent to Rules unchanged; never used for owner-mode decisions. */
  actorId: string;
  payload: Record<string, unknown>;
  /** Authenticated actor resolved from the request principal or Portal attestation. */
  actor: GovernanceActor | null;
  /** Declared risk of an execute; Rules receives it as `payload.risk`. */
  risk?: GovernedActionRisk;
  governance: GovernanceMode;
  rulesClient?: RulesClient;
  store: SqliteMarketplaceStore;
};

function configuredAllowedOrigins(
  env: Record<string, string | undefined> = process.env,
) {
  return new Set(
    (env.MARKETPLACE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function allowedCorsOrigin(
  origin: unknown,
  env: Record<string, string | undefined> = process.env,
) {
  if (typeof origin !== "string" || !origin.trim()) {
    return null;
  }
  const configured = configuredAllowedOrigins(env);
  if (configured.has(origin)) {
    return origin;
  }
  try {
    const url = new URL(origin);
    if (
      env.NODE_ENV === "test" &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

function corsHeadersForOrigin(
  origin: unknown,
  env: Record<string, string | undefined> = process.env,
) {
  const allowedOrigin = allowedCorsOrigin(origin, env);
  if (!allowedOrigin) {
    return {};
  }
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,x-trace-id,authorization,x-csrf-token,x-tealbrick-agent-token,x-tealbrick-attachment",
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

async function enforceRules(input: RulesGateInput) {
  if (input.governance === "owner") {
    const owner = ownerGovernedDecision({
      operation: input.operation,
      capability: input.capability,
      pluginId: input.pluginId,
      actor: input.actor,
      ...(input.risk ? { risk: input.risk } : {}),
    });
    // Audit the decision basis only: never the action payload or secrets.
    input.store.recordAudit({
      workspaceSlug: input.workspaceSlug,
      pluginId: input.pluginId,
      eventType:
        owner.effect === "allow"
          ? "marketplace.governance.owner_approved"
          : "marketplace.governance.owner_denied",
      actorId: input.actor?.id ?? null,
      rulesDecisionId: owner.effect === "allow" ? owner.decisionId : null,
      metadata: {
        governance: "owner",
        operation: input.operation,
        capability: input.capability,
        actorKind: input.actor?.kind ?? null,
        ...(input.actor?.kind === "agent"
          ? { attestation: input.actor.attestation }
          : {}),
        ...(owner.effect === "allow" ? { basis: owner.basis } : {}),
        ...(input.risk ? { risk: input.risk } : {}),
      },
    });
    if (owner.effect === "allow") {
      return {
        effect: "allow" as const,
        decisionId: owner.decisionId,
        reason: owner.reason,
      };
    }
    input.reply.code(403);
    return {
      ok: false,
      error: owner.error,
      governance: "owner" as const,
      governedCapability: input.capability,
      detail: owner.reason,
    };
  }
  if (!input.rulesClient) {
    input.reply.code(503);
    return {
      ok: false,
      error: "rules_unavailable",
      governedCapability: input.capability,
      detail:
        "Rules Approvals is required for connector admin, dispatch, generation, and execution.",
    };
  }

  const decision = await input.rulesClient({
    workspaceSlug: input.workspaceSlug,
    operation: input.operation,
    capability: input.capability,
    pluginId: input.pluginId,
    actorId: input.actorId,
    payload: input.risk ? { ...input.payload, risk: input.risk } : input.payload,
  });
  if (decision.effect === "allow") {
    return decision;
  }
  input.reply.code(decision.effect === "deny" ? 403 : 409);
  return {
    ok: false,
    error:
      decision.effect === "deny" ? "rules_denied" : "rules_review_required",
    governedCapability: input.capability,
    rules: decision,
  };
}

function traceIdFrom(request: {
  headers: Record<string, unknown>;
  body?: unknown;
}) {
  const header = request.headers["x-trace-id"];
  if (typeof header === "string" && header.trim()) {
    return header.trim();
  }
  if (
    Array.isArray(header) &&
    typeof header[0] === "string" &&
    header[0].trim()
  ) {
    return header[0].trim();
  }
  const body = request.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>).traceId;
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function bearerTokenFrom(request: { headers: Record<string, unknown> }) {
  const value = request.headers.authorization;
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1]?.trim() || null;
}

function secureRequest(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedProtocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.protocol === "https" || forwardedProtocol?.split(",", 1)[0]?.trim() === "https";
}

function isMutation(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function marketplacePublicPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/embed" ||
    pathname === "/healthz" ||
    pathname === "/api/portal/readiness" ||
    pathname === "/status" ||
    pathname === "/bootstrap.json" ||
    pathname === "/openapi.json" ||
    pathname === "/swagger.json" ||
    pathname === "/auth/launch" ||
    pathname === "/api/marketplace/auth/session" ||
    pathname.startsWith("/assets/") ||
    /^\/api\/marketplace\/plugins\/[^/]+\/oauth\/composio\/callback$/u.test(pathname)
  );
}

function bindMarketplacePrincipalScope(request: FastifyRequest, principal: MarketplacePrincipal) {
  const pathname = request.url.split("?", 1)[0] ?? request.url;
  const strictBodyPaths = new Set([
    "/api/marketplace/v1/agent/grants/request",
    "/api/marketplace/v1/agent/grants/redeem",
    "/api/marketplace/v1/runtime/composio/execute",
  ]);
  for (const value of [request.query, request.body]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (value === request.body && strictBodyPaths.has(pathname)) continue;
    const record = value as Record<string, unknown>;
    record.workspaceSlug = principal.organizationId;
    record.actorId = principal.id;
  }
}

function requireCrossAppBearerAuth(input: {
  request: { headers: Record<string, unknown> };
  reply: FastifyReply;
  expectedToken?: string | null;
}) {
  if (!input.expectedToken) {
    input.reply.code(503);
    return {
      ok: false,
      error: "marketplace_cross_app_auth_unconfigured",
      detail:
        "MARKETPLACE_INTERNAL_AUTH_TOKEN is required for Marketplace cross-app service routes.",
    };
  }
  if (bearerTokenFrom(input.request) !== input.expectedToken) {
    input.reply.code(401);
    return {
      ok: false,
      error: "marketplace_cross_app_unauthorized",
    };
  }
  return null;
}

function requireHubBearerAuth(input: {
  request: { headers: Record<string, unknown> };
  reply: FastifyReply;
  expectedToken?: string | null;
}) {
  if (!input.expectedToken) {
    input.reply.code(503);
    return {
      ok: false,
      error: "marketplace_hub_auth_unconfigured",
      detail:
        "MARKETPLACE_INTERNAL_AUTH_TOKEN is required for the HDDA Skills Hub adapter.",
    };
  }
  if (bearerTokenFrom(input.request) !== input.expectedToken) {
    input.reply.code(401);
    return { ok: false, error: "marketplace_hub_unauthorized" };
  }
  return null;
}

function toolNameForAction(provider: string, action: string) {
  const providerPrefix = `${provider}.`;
  const suffix = action.startsWith(providerPrefix)
    ? action.slice(providerPrefix.length)
    : action;
  return `marketplace.${provider}.${suffix}`;
}

function actionForTool(toolName: string) {
  const parts = toolName.split(".");
  if (parts.length < 3 || parts[0] !== "marketplace") {
    return null;
  }
  const provider = parts[1]!;
  const suffix = parts.slice(2).join(".");
  return `${provider}.${suffix}`;
}

function createBrokerToken() {
  return `broker_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
}

function brokerTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeBrokerGrant(
  grant: ReturnType<SqliteMarketplaceStore["createBrokerGrant"]>,
) {
  return {
    id: grant.id,
    workspaceSlug: grant.workspaceSlug,
    requesterMiniappId: grant.requesterMiniappId,
    pluginId: grant.pluginId,
    actionKeys: grant.actionKeys,
    capabilities: grant.capabilities,
    state: grant.state,
    expiresAt: grant.expiresAt,
    metadata: grant.metadata,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

function capabilityWeight(capability: ConnectorCapability) {
  return capability === "connector.admin"
    ? 3
    : capability === "connector.dispatch"
      ? 2
      : 1;
}

function highestCapability(capabilities: ConnectorCapability[]) {
  return capabilities.reduce<ConnectorCapability>(
    (highest, capability) =>
      capabilityWeight(capability) > capabilityWeight(highest)
        ? capability
        : highest,
    "connector.observe",
  );
}

function brokerGrantIsExpired(grant: { expiresAt: string }) {
  return Date.parse(grant.expiresAt) <= Date.now();
}

/**
 * Build the selection Marketplace sends to Portal for a published action.
 *
 * Capability-sending decision: `capability` is included only when the action
 * needs more than observe. A selection without `capability` means observe in
 * both Portal Core v1.1 and v1.2, so observe actions (including the legacy
 * GitHub repository-list action) keep sending the exact five-key v1.1
 * selection and continue to work against Portal deployments that predate
 * v1.2. Dispatch/admin actions require v1.2; an older Portal rejects the
 * extra key instead of silently minting an observe-only consent.
 */
function portalSelectionForPublishedAction(input: {
  entry: AgentActionCatalogEntry;
  accountId: string;
}): MarketplacePortalSelection {
  return {
    pluginId: input.entry.pluginId,
    actionKey: input.entry.actionKey,
    accountId: input.accountId,
    resourceKind: input.entry.resourceKind,
    resourceRef: `account:${input.accountId}`,
    ...(input.entry.capability === "connector.observe"
      ? {}
      : { capability: input.entry.capability }),
  };
}

/**
 * The exact selection shape Portal stores on a consent: observe omits
 * `capability` (v1.1), every other capability carries it (v1.2). Portal
 * compares runtime selections byte-for-byte, so an agent that spells observe
 * out explicitly must still introspect against the v1.1 shape.
 */
function canonicalPortalSelection(
  selection: MarketplacePortalSelection,
): MarketplacePortalSelection {
  const capability = selectionCapability(selection);
  return {
    pluginId: selection.pluginId,
    actionKey: selection.actionKey,
    accountId: selection.accountId,
    resourceKind: selection.resourceKind,
    resourceRef: selection.resourceRef,
    ...(capability === "connector.observe" ? {} : { capability }),
  };
}

/** Compare selections, treating an absent capability as observe. */
function portalSelectionsEquivalent(
  left: MarketplacePortalSelection,
  right: MarketplacePortalSelection,
) {
  return (
    left.pluginId === right.pluginId &&
    left.actionKey === right.actionKey &&
    left.accountId === right.accountId &&
    left.resourceKind === right.resourceKind &&
    left.resourceRef === right.resourceRef &&
    selectionCapability(left) === selectionCapability(right)
  );
}

function headerValue(request: { headers: Record<string, unknown> }, name: string) {
  const value = request.headers[name];
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0].trim() || null;
  }
  return null;
}

function agentConnectorGrantIsExpired(grant: AgentConnectorGrant) {
  return grant.state !== "active" || Date.parse(grant.expiresAt) <= Date.now();
}

function sanitizeAgentConnectorGrant(grant: AgentConnectorGrant) {
  return {
    id: grant.id,
    workspaceSlug: grant.workspaceSlug,
    agentId: grant.agentId,
    pluginId: grant.pluginId,
    actionKey: grant.actionKey,
    capability: grant.capability,
    connectionId: grant.connectionId,
    accountId: grant.accountId,
    resourceKind: grant.resourceKind,
    resourceRef: grant.resourceRef,
    attachmentId: grant.attachmentId,
    state: grant.state,
    expiresAt: grant.expiresAt,
    metadata: grant.metadata,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

function browserAgentConnectorGrant(grant: AgentConnectorGrant) {
  return {
    id: grant.id,
    workspaceSlug: grant.workspaceSlug,
    agentId: grant.agentId,
    pluginId: grant.pluginId,
    actionKey: grant.actionKey,
    capability: grant.capability,
    connectionId: grant.connectionId,
    accountId: grant.accountId,
    resourceKind: grant.resourceKind,
    resourceRef: grant.resourceRef,
    state: grant.state,
    expiresAt: grant.expiresAt,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

function browserMarketplaceAgentConsent(
  consent: ReturnType<SqliteMarketplaceStore["getMarketplaceAgentConsentById"]>,
) {
  if (!consent) return null;
  return {
    id: consent.id,
    portalOrgId: consent.portalOrgId,
    productTenantId: consent.productTenantId,
    workspaceId: consent.workspaceId,
    deploymentId: consent.deploymentId,
    userId: consent.userId,
    agentId: consent.agentId,
    consentId: consent.consentId,
    consentRevision: consent.consentRevision,
    pluginId: consent.pluginId,
    actionKey: consent.actionKey,
    capability: consent.capability,
    connectionId: consent.connectionId,
    accountId: consent.accountId,
    resourceKind: consent.resourceKind,
    resourceRef: consent.resourceRef,
    state: consent.state,
    capabilities: consent.capabilities,
    requiredActions: consent.requiredActions,
    createdAt: consent.createdAt,
    updatedAt: consent.updatedAt,
  };
}

function browserMarketplacePortalGrantRequest(
  request: MarketplacePortalGrantRequest,
) {
  const state =
    request.state === "pending" && Date.parse(request.expiresAt) <= Date.now()
      ? "expired"
      : request.state;
  return {
    id: request.id,
    portalOrgId: request.portalOrgId,
    productTenantId: request.productTenantId,
    workspaceId: request.workspaceId,
    deploymentId: request.deploymentId,
    agentId: request.agentId,
    requestId: request.requestId,
    approvalUrl: request.approvalUrl,
    expiresAt: request.expiresAt,
    idempotencyKey: request.idempotencyKey,
    selection: request.selection,
    state,
    consentId: request.consentId,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function runtimeResponse(input: {
  ok: boolean;
  traceId: string;
  error?: string;
  detail?: string;
  result?: Record<string, unknown>;
  usageId?: string;
}) {
  return {
    ok: input.ok,
    schema: 1,
    traceId: input.traceId,
    ...(input.error ? { error: input.error } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.result ? { result: input.result } : {}),
    ...(input.usageId ? { usageId: input.usageId } : {}),
  };
}

function runtimeSafeProviderResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(runtimeSafeProviderResult);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      /key|token|secret|authorization|credential/iu.test(key)
        ? "[redacted]"
        : runtimeSafeProviderResult(entry),
    ]),
  );
}

function listingRequiresConnectedAccount(listing: {
  pluginId: string;
  source: string;
  authOwner: string;
}) {
  return (
    listing.source === "composio" &&
    listing.authOwner === "composio" &&
    listing.pluginId !== "composio-bootstrap"
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Custom MCP connector owned by (and therefore runnable in) `workspaceSlug`. */
function listingIsWorkspaceCustomMcp(
  listing: MarketplaceListing,
  workspaceSlug: string,
) {
  return (
    listingIsOperatorCustomMcp(listing) &&
    listing.executionOwner === "mcp" &&
    listing.ownerWorkspaceSlug === workspaceSlug
  );
}

/** Composio listings, and custom MCP / Company Box connectors with tools, can run actions. */
function listingLaunchSupported(
  listing: MarketplaceListing,
  workspaceSlug: string,
) {
  return (
    listing.executionOwner === "composio" ||
    ((listingIsWorkspaceCustomMcp(listing, workspaceSlug) ||
      listingIsCompanyBoxOpenApi(listing)) &&
      listing.actions.length > 0)
  );
}

/**
 * Custom MCP connectors are "connected" only after a successful refresh;
 * Company Box connectors only after a passing connection test.
 */
function listingConnected(input: {
  listing: MarketplaceListing;
  workspaceSlug: string;
  connectionState: string | undefined;
}) {
  if (
    listingIsWorkspaceCustomMcp(input.listing, input.workspaceSlug) ||
    listingIsCompanyBoxOpenApi(input.listing)
  ) {
    return input.connectionState === "connected";
  }
  return (
    !listingRequiresConnectedAccount(input.listing) ||
    input.connectionState === "connected"
  );
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listingSkills(
  listing: MarketplaceListing,
): MarketplaceSkillDeclaration[] {
  const manifest = recordValue(listing.manifest);
  return arrayValue(manifest?.skills).flatMap((entry) => {
    const record = recordValue(entry);
    if (!record) {
      return [];
    }
    const skillId =
      stringValue(record.skillId) ?? stringValue(record.skillName);
    const displayName = stringValue(record.displayName) ?? skillId;
    if (!skillId || !displayName) {
      return [];
    }
    return [
      {
        skillId,
        ...(stringValue(record.skillName)
          ? { skillName: stringValue(record.skillName)! }
          : {}),
        displayName,
        ...(stringValue(record.description)
          ? { description: stringValue(record.description)! }
          : {}),
        ...(stringValue(record.sourcePath)
          ? { sourcePath: stringValue(record.sourcePath)! }
          : {}),
        ...(stringValue(record.skillRoot)
          ? { skillRoot: stringValue(record.skillRoot)! }
          : {}),
        requiresConnectors: arrayValue(record.requiresConnectors)
          .map((value) => stringValue(value))
          .filter((value): value is string => value !== null),
      },
    ];
  });
}

function composioToolsForListing(
  listing: MarketplaceListing,
): ComposioListingTool[] {
  const manifest = recordValue(listing.manifest);
  const composio = recordValue(manifest?.composio);
  return arrayValue(composio?.tools).flatMap((tool) => {
    const record = recordValue(tool);
    const action = stringValue(record?.action);
    const toolName = stringValue(record?.toolName);
    const displayName = stringValue(record?.displayName) ?? action;
    const capability = stringValue(record?.capability);
    if (!action || !toolName || !displayName) {
      return [];
    }
    return [
      {
        action,
        toolName,
        displayName,
        description: stringValue(record?.description) ?? "",
        capability:
          capability === "connector.admin" ||
          capability === "connector.dispatch" ||
          capability === "connector.observe"
            ? capability
            : "connector.observe",
      },
    ];
  });
}

function toolSelectionForListing(
  store: SqliteMarketplaceStore,
  workspaceSlug: string,
  listing: MarketplaceListing,
) {
  const knownTools = new Map(
    composioToolsForListing(listing).map((tool) => [tool.action, tool]),
  );
  const actions = listing.actions.map((action) => {
    const requirement = resolveActionRequirement(listing, action);
    const tool = knownTools.get(action);
    const enabled = store.isActionEnabled({
      workspaceSlug,
      pluginId: listing.pluginId,
      actionKey: action,
    });
    return {
      actionKey: action,
      displayName: tool?.displayName ?? action,
      description: tool?.description ?? "",
      toolName: tool?.toolName ?? composioToolNameForAction(listing, action),
      capability:
        requirement?.capability ?? tool?.capability ?? "connector.observe",
      enabled,
    };
  });
  return {
    total: actions.length,
    enabled: actions.filter((action) => action.enabled).length,
    disabled: actions.filter((action) => !action.enabled).length,
    actions,
  };
}

function pluginCardForListing(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  listing: MarketplaceListing;
  providers?: Awaited<ReturnType<typeof readProviderHealthWithReachability>>;
}) {
  const { store, workspaceSlug, listing } = input;
  const install = store.getInstall(workspaceSlug, listing.pluginId);
  const connection = store.getConnection(workspaceSlug, listing.pluginId);
  const registered = store.isRegistered(listing.pluginId);
  const installed =
    install?.enabled === true && install.lifecycle === "installed";
  const authRequired = listingRequiresConnectedAccount(listing);
  const connected = listingConnected({
    listing,
    workspaceSlug,
    connectionState: connection?.state,
  });
  const launchSupported = listingLaunchSupported(listing, workspaceSlug);
  const ready = launchSupported && registered && installed && connected;
  const status = !launchSupported
    ? "catalogOnly"
    : ready
    ? "ready"
    : installed && authRequired && !connected
      ? "authRequired"
      : installed
        ? "installed"
        : install?.lifecycle === "uninstalled"
          ? "disabled"
          : "available";
  const skills = listingSkills(listing);
  const toolSelection = toolSelectionForListing(store, workspaceSlug, listing);
  const primaryRuntime =
    listing.runtimeSources?.find((source) => source.primary) ??
    listing.runtimeSources?.[0];
  const provider =
    listing.source === "composio" ? input.providers?.composio : undefined;
  const connectStepStatus = !authRequired
    ? "complete"
    : connection?.state === "connected"
      ? "complete"
      : provider && !provider.configured
        ? "blocked"
        : "pending";

  return {
    addon: {
      addonId: listing.pluginId,
      pluginId: listing.pluginId,
      displayName: listing.displayName,
      version: String(recordValue(listing.manifest)?.version ?? "0.1.0"),
      kind: listing.kind,
      enabled: installed,
      skills,
      apps:
        listing.source === "composio"
          ? [
              {
                appKey: listing.provider,
                appId: listing.provider,
                label: listing.displayName,
                backend: "composio",
              },
            ]
          : [],
      capabilities: listing.capabilities,
      runtimeSources: listing.runtimeSources ?? [],
      defaultPrompts: arrayValue(recordValue(listing.manifest)?.defaultPrompts),
    },
    state: {
      status,
      ready,
      registered,
      installed,
      enabled: installed,
      authRequired,
      apps: [
        {
          appId: listing.provider,
          backend: listing.authOwner,
          state:
            connection?.state ?? (authRequired ? "disconnected" : "connected"),
          detail:
            connection?.detail ??
            (authRequired
              ? "Connect this plugin before Agent tools are exposed."
              : "No external account connection is required."),
        },
      ],
      diagnostics: [
        ...(provider && !provider.configured
          ? [`${listing.source} provider is not configured.`]
          : []),
        ...(toolSelection.enabled === 0 && toolSelection.total > 0
          ? ["No plugin tools are currently selected for Agent exposure."]
          : []),
      ],
      refreshedAt: new Date().toISOString(),
    },
    description: listing.description,
    developerName: "Teal Brick",
    marketplaceName:
      listing.source === "composio" ? "Composio" : "Teal Brick",
    capabilityLabels: listing.capabilities,
    primaryAction: ready ? "configure" : installed ? "connect" : "install",
    capabilityShape: listing.kind,
    runtimeSource: primaryRuntime?.kind ?? listing.executionOwner,
    toolCoverageCount: listing.actions.length,
    provenance:
      listing.source === "composio" ? "composio-imported" : "first-party",
    extensionClass:
      listing.source === "mcp"
        ? "mcp"
        : listing.source === "composio"
          ? "connector"
          : "native",
    sourceLabel: primaryRuntime?.label ?? listing.source,
    dependencyFlags:
      listing.runtimeSources?.flatMap((source) => source.requiredEnv ?? []) ??
      [],
    hostAffordances: [
      ...(authRequired ? ["oauth-window"] : []),
      "settings-panel",
      "tool-selection",
    ],
    parityGaps: [],
    installStateByTarget: [
      {
        targetId: workspaceSlug,
        status,
        installed,
        registered,
      },
    ],
    installPlan: {
      addonId: listing.pluginId,
      steps: [
        {
          kind: "plugin-install",
          label: "Register and install plugin",
          status: registered && installed ? "complete" : "pending",
          detail:
            registered && installed
              ? "Plugin is registered and installed for this workspace."
              : "Register and install before Agent projection.",
        },
        {
          kind: "app-connect",
          label: authRequired ? `Connect ${listing.displayName}` : "Connection",
          status: connectStepStatus,
          detail: authRequired
            ? (connection?.detail ?? "Open the Composio authorization popup.")
            : "No external connection required.",
        },
        {
          kind: "skill-config",
          label: "Agent skill guidance",
          status: skills.length > 0 ? "complete" : "pending",
          detail:
            skills.length > 0
              ? `${skills.length} skill guidance item${skills.length === 1 ? "" : "s"} available.`
              : "No skill guidance declared yet.",
        },
        {
          kind: "ui-promotion",
          label: "Tool selection",
          status: toolSelection.enabled > 0 ? "complete" : "pending",
          detail: `${toolSelection.enabled}/${toolSelection.total} tools selected for Agent exposure.`,
        },
      ],
    },
    skills,
    toolSelection,
    listing,
    install,
    connection,
    imports: store.listComposioImports({
      workspaceSlug,
      pluginId: listing.pluginId,
    }),
  };
}

function pluginSummaryForListing(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  listing: MarketplaceListing;
}) {
  const { store, workspaceSlug, listing } = input;
  const install = store.getInstall(workspaceSlug, listing.pluginId);
  const connection = store.getConnection(workspaceSlug, listing.pluginId);
  const registered = store.isRegistered(listing.pluginId);
  const installed =
    install?.enabled === true && install.lifecycle === "installed";
  const authRequired = listingRequiresConnectedAccount(listing);
  const connected = listingConnected({
    listing,
    workspaceSlug,
    connectionState: connection?.state,
  });
  const launchSupported = listingLaunchSupported(listing, workspaceSlug);
  const ready = launchSupported && registered && installed && connected;
  const status = !launchSupported
    ? "catalogOnly"
    : ready
    ? "ready"
    : installed && authRequired && !connected
      ? "authRequired"
      : installed
        ? "installed"
        : install?.lifecycle === "uninstalled"
          ? "disabled"
          : "available";
  const primaryRuntime =
    listing.runtimeSources?.find((source) => source.primary) ??
    listing.runtimeSources?.[0];

  return {
    pluginId: listing.pluginId,
    displayName: listing.displayName,
    description: listing.description,
    kind: listing.kind,
    provider: listing.provider,
    source: listing.source,
    sourceLabel: primaryRuntime?.label ?? listing.source,
    runtimeSource: primaryRuntime?.kind ?? listing.executionOwner,
    status,
    ready,
    registered,
    installed,
    authRequired,
    toolCount: listing.actions.length,
    install: install
      ? {
          enabled: install.enabled,
          lifecycle: install.lifecycle,
          updatedAt: install.updatedAt,
        }
      : null,
    connection: connection
      ? {
          provider: connection.provider,
          backend: connection.backend,
          state: connection.state,
          detail: connection.detail,
          updatedAt: connection.updatedAt,
        }
      : null,
  };
}

function browserListingForListing(listing: MarketplaceListing) {
  const manifest = recordValue(listing.manifest);
  return {
    pluginId: listing.pluginId,
    displayName: listing.displayName,
    kind: listing.kind,
    provider: listing.provider,
    description: listing.description,
    capabilities: listing.capabilities,
    actions: listing.actions,
    source: listing.source,
    authOwner: listing.authOwner,
    executionOwner: listing.executionOwner,
    enabledByDefault: listing.enabledByDefault,
    manifest: {
      ...(typeof manifest?.version === "string"
        ? { version: manifest.version }
        : {}),
      ...(typeof manifest?.required === "boolean"
        ? { required: manifest.required }
        : {}),
      ...(listingIsOperatorCustomMcp(listing) ? { operatorManaged: true } : {}),
    },
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}

function browserPluginCardForListing(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  listing: MarketplaceListing;
  providers: Awaited<ReturnType<typeof readProviderHealthWithReachability>>;
}) {
  const card = pluginCardForListing(input);
  const launchSupported = listingLaunchSupported(
    input.listing,
    input.workspaceSlug,
  );
  return {
    addon: {
      addonId: card.addon.addonId,
      pluginId: card.addon.pluginId,
      displayName: card.addon.displayName,
      version: card.addon.version,
      kind: card.addon.kind,
      enabled: card.addon.enabled,
    },
    state: {
      ...card.state,
      status: launchSupported ? card.state.status : "catalogOnly",
      ready: launchSupported && card.state.ready,
      diagnostics: [
        ...card.state.diagnostics,
        ...(!launchSupported
          ? ["Catalog evidence only; this execution backend is not supported in the launch profile."]
          : []),
      ],
    },
    description: card.description,
    developerName: card.developerName,
    marketplaceName: card.marketplaceName,
    capabilityLabels: card.capabilityLabels,
    primaryAction: launchSupported ? card.primaryAction : "inspect",
    capabilityShape: card.capabilityShape,
    runtimeSource: card.runtimeSource,
    toolCoverageCount: card.toolCoverageCount,
    provenance: card.provenance,
    extensionClass: card.extensionClass,
    sourceLabel: card.sourceLabel,
    dependencyFlags: [],
    hostAffordances: card.hostAffordances,
    parityGaps: launchSupported
      ? card.parityGaps
      : [...card.parityGaps, "execution-backend-not-supported"],
    installStateByTarget: card.installStateByTarget,
    installPlan: card.installPlan,
    toolSelection: card.toolSelection,
    listing: browserListingForListing(input.listing),
    install: card.install
      ? {
          enabled: card.install.enabled,
          lifecycle: card.install.lifecycle,
          updatedAt: card.install.updatedAt,
        }
      : null,
    connection: card.connection
      ? {
          provider: card.connection.provider,
          backend: card.connection.backend,
          state: card.connection.state,
          detail: card.connection.detail,
          updatedAt: card.connection.updatedAt,
        }
      : null,
  };
}

function browserProviderHealth(
  providers: Awaited<ReturnType<typeof readProviderHealthWithReachability>>,
) {
  return Object.fromEntries(
    Object.entries(providers).map(([name, provider]) => [
      name,
      {
        state: provider.state,
        configured: provider.configured,
        reachable: provider.reachable,
        mode: provider.mode,
        detail: provider.detail,
        statusCode: provider.statusCode,
        checkedAt: provider.checkedAt,
      },
    ]),
  );
}

async function pluginCardsForWorkspace(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  providers?: Awaited<ReturnType<typeof readProviderHealthWithReachability>>;
}) {
  const providers =
    input.providers ?? (await readProviderHealthWithReachability());
  return input.store.listListingsForWorkspace(input.workspaceSlug).map((listing) =>
    pluginCardForListing({
      store: input.store,
      workspaceSlug: input.workspaceSlug,
      listing,
      providers,
    }),
  );
}

function composioListingRole(listing: MarketplaceListing) {
  return stringValue(recordValue(listing.manifest)?.role);
}

function composioListingHasCatalog(listing: MarketplaceListing) {
  const composio = recordValue(recordValue(listing.manifest)?.composio);
  return Boolean(recordValue(composio?.catalog));
}

function composioToolkitForListing(listing: MarketplaceListing) {
  const composio = recordValue(recordValue(listing.manifest)?.composio);
  const catalog = recordValue(composio?.catalog);
  return (
    stringValue(composio?.toolkit) ??
    stringValue(catalog?.slug) ??
    listing.provider
  );
}

function composioAuthMetadataForListing(listing: MarketplaceListing) {
  const composio = recordValue(recordValue(listing.manifest)?.composio);
  const catalog = recordValue(composio?.catalog);
  return {
    authSchemes: arrayValue(catalog?.authSchemes)
      .map((value) => stringValue(value))
      .filter((value): value is string => value !== null),
    managedAuthSchemes: arrayValue(catalog?.managedAuthSchemes)
      .map((value) => stringValue(value))
      .filter((value): value is string => value !== null),
    noAuth: catalog?.noAuth === true,
  };
}

async function synchronizeComposioCatalog(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  env: ProviderEnvironment;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const catalog = await fetchComposioCatalog(input.env, fetchImpl);
  const connectedAccounts = await fetchComposioConnectedAccounts(
    input.env,
    fetchImpl,
  ).catch(() => ({ baseUrl: catalog.baseUrl, items: [] }));
  const existingByToolkit = new Map<string, MarketplaceListing>();
  for (const listing of input.store.listListings()) {
    if (
      listing.source !== "composio" ||
      listing.pluginId === "composio-bootstrap"
    ) {
      continue;
    }
    existingByToolkit.set(listing.provider, listing);
    existingByToolkit.set(composioToolkitForListing(listing), listing);
  }
  let added = 0;
  let refreshed = 0;

  for (const rawToolkit of catalog.items) {
    const catalogListing = buildComposioCatalogListing({
      toolkit: rawToolkit,
    });
    if (!catalogListing) {
      continue;
    }
    const existing = existingByToolkit.get(catalogListing.provider);
    if (
      existing &&
      composioListingRole(existing) !== "composio-catalog-connector" &&
      !composioListingHasCatalog(existing)
    ) {
      continue;
    }
    input.store.upsertListing(catalogListing);
    existingByToolkit.set(catalogListing.provider, catalogListing);
    if (existing) {
      refreshed += 1;
    } else {
      added += 1;
    }
  }

  const newestActiveByToolkit = new Map<
    string,
    (typeof connectedAccounts.items)[number]
  >();
  for (const account of connectedAccounts.items) {
    if (account.disabled || account.status.toUpperCase() !== "ACTIVE") {
      continue;
    }
    const existing = newestActiveByToolkit.get(account.toolkit);
    if (
      !existing ||
      (account.updatedAt ?? "") > (existing.updatedAt ?? "")
    ) {
      newestActiveByToolkit.set(account.toolkit, account);
    }
  }
  let connected = 0;
  for (const [toolkit, account] of newestActiveByToolkit) {
    const listing = existingByToolkit.get(toolkit);
    if (
      !listing ||
      composioListingRole(listing) !== "composio-catalog-connector"
    ) {
      continue;
    }
    input.store.upsertConnection({
      workspaceSlug: input.workspaceSlug,
      pluginId: listing.pluginId,
      provider: toolkit,
      backend: "composio",
      state: "connected",
      detail: "An active Composio connected account is available.",
      metadata: {
        source: "composio-catalog-sync",
        connectedAccountId: account.id,
        toolkit,
        userId: account.userId,
        status: account.status,
      },
    });
    connected += 1;
  }

  return {
    total: catalog.total,
    projected: added + refreshed,
    added,
    refreshed,
    connected,
  };
}

async function hydrateComposioCatalogConnector(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  listing: MarketplaceListing;
  toolkit: string;
  traceId: string;
  env: ProviderEnvironment;
  fetchImpl?: typeof fetch;
}) {
  if (composioListingRole(input.listing) !== "composio-catalog-connector") {
    return input.listing;
  }
  const fetched = await fetchComposioToolkitTools({
    toolkit: input.toolkit,
    env: input.env,
    fetchImpl: input.fetchImpl,
  });
  const existingComposio = recordValue(input.listing.manifest.composio) ?? {};
  const hydrated = buildComposioListingFromTools({
    toolkit: input.listing.provider,
    upstreamToolkit: input.toolkit,
    pluginId: input.listing.pluginId,
    displayName: input.listing.displayName,
    description: input.listing.description,
    tools: fetched.items,
  });
  const hydratedComposio = recordValue(hydrated.manifest.composio) ?? {};
  const listing: MarketplaceListing = {
    ...hydrated,
    manifest: {
      ...hydrated.manifest,
      role: "composio-catalog-connector",
      ...(input.listing.manifest.version
        ? { version: input.listing.manifest.version }
        : {}),
      composio: {
        ...hydratedComposio,
        ...(existingComposio.catalog
          ? { catalog: existingComposio.catalog }
          : {}),
      },
    },
  };
  input.store.upsertListing(listing);
  return listing;
}

function enableComposioConnector(input: {
  store: SqliteMarketplaceStore;
  workspaceSlug: string;
  listing: MarketplaceListing;
  toolkit: string;
  traceId: string;
}) {
  input.store.registerPlugin(input.listing.pluginId);
  input.store.install(input.workspaceSlug, input.listing.pluginId);
  for (const capability of input.listing.capabilities) {
    input.store.bindCapability({
      workspaceSlug: input.workspaceSlug,
      pluginId: input.listing.pluginId,
      capability,
      enabled: true,
    });
  }
  for (const actionKey of input.listing.actions) {
    input.store.bindAction({
      workspaceSlug: input.workspaceSlug,
      pluginId: input.listing.pluginId,
      actionKey,
      enabled: true,
    });
  }
  input.store.upsertComposioImport({
    workspaceSlug: input.workspaceSlug,
    pluginId: input.listing.pluginId,
    toolkit: input.toolkit,
    importedActionKeys: input.listing.actions,
    lifecycle: "enabled",
    metadata: {
      traceId: input.traceId,
      source: "composio-catalog-connect",
      toolCount: input.listing.actions.length,
    },
  });
}

/** Company Box entry backing a listing (REST adapter or official MCP server), if any. */
function companyBoxEntryForListing(
  catalog: CompanyBoxCatalog,
  listing: MarketplaceListing,
  workspaceSlug: string,
): CompiledOpenApiEntry | CompiledMcpEntry | null {
  if (listingIsCompanyBoxOpenApi(listing)) {
    return catalog.openApiForPluginId(listing.pluginId);
  }
  if (listingIsWorkspaceCustomMcp(listing, workspaceSlug)) {
    const entryId = customMcpManifest(listing).companyBox?.entryId;
    const entry = entryId ? catalog.get(entryId) : null;
    return entry?.kind === "mcp" && entry.errors.length === 0 ? entry : null;
  }
  return null;
}

const CompanyBoxSearchSchema = z
  .object({
    query: z.string().max(200).optional(),
    tag: z.string().max(100).optional(),
    capability: z.enum(["connector.observe", "connector.dispatch", "connector.admin"]).optional(),
    cursor: z.string().max(20).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const CompanyBoxOperationInputSchema = z
  .object({
    operation: z.string().trim().min(1).max(200),
    arguments: z.record(z.unknown()).optional(),
  })
  .strict();

function mcpToolRisk(entry: CompiledMcpEntry, listing: MarketplaceListing, actionKey: string) {
  const tool = customMcpToolForAction(listing, actionKey);
  return tool
    ? companyBoxMcpToolRisk(entry.entry, tool, actionKey.slice(listing.provider.length + 1))
    : null;
}

/** Declared risk for one Company Box action; undefined for other connectors. */
function companyBoxRiskForAction(
  catalog: CompanyBoxCatalog,
  listing: MarketplaceListing,
  workspaceSlug: string,
  actionKey: string,
): GovernedActionRisk | undefined {
  const entry = companyBoxEntryForListing(catalog, listing, workspaceSlug);
  if (!entry) {
    // A retired or broken REST entry: fail toward approval, never toward silence.
    return listingIsCompanyBoxOpenApi(listing) ? { write: true, outward: true, destructive: false } : undefined;
  }
  const risk = entry.kind === "openapi" ? entry.byKey.get(actionKey) : mcpToolRisk(entry, listing, actionKey);
  return risk ? { write: risk.write, outward: risk.outward, destructive: risk.destructive } : undefined;
}

function companyBoxAgentOperation(
  entry: CompiledOpenApiEntry | CompiledMcpEntry,
  listing: MarketplaceListing,
  published: AgentActionCatalogEntry,
): AgentOperation & { method?: string; path?: string } {
  if (entry.kind === "openapi") {
    const operation = entry.byKey.get(published.actionKey)!;
    return {
      key: operation.key,
      title: operation.title,
      summary: operation.summary,
      tags: operation.tags,
      group: operation.group,
      capability: operation.capability,
      outward: operation.outward,
      destructive: operation.destructive,
      method: operation.method.toUpperCase(),
      path: operation.path,
    };
  }
  const risk = mcpToolRisk(entry, listing, published.actionKey);
  return {
    key: published.actionKey,
    title: published.label,
    summary: published.description.slice(0, 300),
    tags: [],
    group: published.group ?? entry.entry.id,
    capability: published.capability,
    outward: risk?.outward ?? false,
    destructive: risk?.destructive ?? false,
  };
}

function describeCompanyBoxOperation(
  entry: CompiledOpenApiEntry | CompiledMcpEntry,
  listing: MarketplaceListing,
  key: string,
) {
  if (entry.kind === "openapi") {
    const operation = entry.byKey.get(key)!;
    return {
      key: operation.key,
      ref: operation.ref,
      operationId: operation.operationId,
      method: operation.method.toUpperCase(),
      path: operation.path,
      title: operation.title,
      description: operation.description,
      tags: operation.tags,
      group: operation.group,
      deprecated: operation.deprecated,
      capability: operation.capability,
      risk: { write: operation.write, outward: operation.outward, destructive: operation.destructive },
      arguments: operation.argumentGroups,
      contentType: operation.operation.requestBody?.contentType ?? null,
      inputSchema: operation.inputSchema,
    };
  }
  const tool = customMcpToolForAction(listing, key)!;
  const risk = mcpToolRisk(entry, listing, key);
  // The live schema is kept up to 16 KB; beyond that, serve the pinned
  // snapshot's full schema instead of a bare object.
  const snapshot = entry.tools.find((candidate) => candidate.name === tool.name);
  const fromSnapshot = Boolean(snapshot?.inputSchema && snapshot.inputSchemaBytes > OPENAPI_TOOL_SCHEMA_MAX_BYTES);
  return {
    key,
    ref: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description ?? "",
    group: entry.entry.id,
    capability: tool.capability,
    risk: risk ? { write: risk.write, outward: risk.outward, destructive: risk.destructive } : null,
    inputSchema: fromSnapshot ? snapshot!.inputSchema : tool.inputSchema,
    schemaSource: fromSnapshot ? "snapshot" : "server",
  };
}

/** Held outward calls expire after 7 days; their arguments are bounded. */
const COMPANY_BOX_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMPANY_BOX_APPROVAL_MAX_ARGUMENT_BYTES = 32 * 1024;
const COMPANY_BOX_APPROVAL_PREVIEW_CHARS = 400;
const COMPANY_BOX_APPROVAL_MAX_PENDING_PER_AGENT = 50;

function approvalFingerprint(actionKey: string, args: Record<string, unknown>) {
  return createHash("sha256").update(stableJson({ actionKey, args })).digest("hex");
}

function approvalPreview(args: Record<string, unknown>) {
  const json = JSON.stringify(args);
  return json.length > COMPANY_BOX_APPROVAL_PREVIEW_CHARS
    ? `${json.slice(0, COMPANY_BOX_APPROVAL_PREVIEW_CHARS - 1)}…`
    : json;
}

const APPROVAL_STATUS: Record<CompanyBoxApproval["state"], string> = {
  pending: "approval_pending",
  executing: "executing",
  succeeded: "succeeded",
  failed: "failed",
  denied: "denied",
  expired: "expired",
};

/** What the requesting agent sees: never the arguments. */
function agentApprovalView(approval: CompanyBoxApproval) {
  return {
    approvalId: approval.id,
    status: APPROVAL_STATUS[approval.state],
    actionKey: approval.actionKey,
    expiresAt: approval.expiresAt,
    ...(approval.state === "succeeded" ? { result: approval.result } : {}),
    ...(approval.error ? { error: approval.error } : {}),
  };
}

/** HTTP reply for a held call (first request, or a repeat with the same idempotency key). */
function approvalReply(approval: CompanyBoxApproval): { status: number; body: Record<string, unknown> } {
  const view = agentApprovalView(approval);
  switch (approval.state) {
    case "succeeded":
      return { status: 200, body: { ok: true, ...view } };
    case "failed":
      return { status: 502, body: { ok: false, ...view, error: approval.error ?? "approval_execution_failed" } };
    case "denied":
      return { status: 403, body: { ok: false, ...view, error: "approval_denied" } };
    case "expired":
      return { status: 410, body: { ok: false, ...view, error: "approval_expired" } };
    default:
      return { status: 202, body: { ok: false, ...view } };
  }
}

const COMPANY_BOX_META_TOOLS = ["search", "describe", "call", "status"] as const;
type CompanyBoxMetaTool = (typeof COMPANY_BOX_META_TOOLS)[number];

/** `operations.search|describe|call`, and `approvals.status` for held outward calls. */
function companyBoxMetaSuffix(tool: CompanyBoxMetaTool) {
  return tool === "status" ? "approvals.status" : `operations.${tool}`;
}

function companyBoxMetaToolName(provider: string, tool: CompanyBoxMetaTool) {
  return `marketplace.${provider}.${companyBoxMetaSuffix(tool)}`;
}

function parseCompanyBoxMetaTool(toolName: string) {
  const match = /^marketplace\.([a-z0-9][a-z0-9-]{0,127})\.(operations\.(search|describe|call)|approvals\.status)$/u.exec(toolName);
  if (!match) return null;
  return { provider: match[1]!, tool: (match[3] ?? "status") as CompanyBoxMetaTool };
}

const COMPANY_BOX_META_SCHEMAS: Record<CompanyBoxMetaTool, Record<string, unknown>> = {
  search: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 200, description: "Keywords matched against key, title, summary and tags." },
      tag: { type: "string", maxLength: 100 },
      capability: { type: "string", enum: ["connector.observe", "connector.dispatch", "connector.admin"] },
      cursor: { type: "string", description: "nextCursor from the previous page." },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
    },
    additionalProperties: false,
  },
  describe: {
    type: "object",
    required: ["operation"],
    properties: { operation: { type: "string", description: "Operation key from operations.search." } },
    additionalProperties: false,
  },
  call: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: { type: "string", description: "Operation key from operations.search." },
      arguments: { type: "object", description: "Arguments matching operations.describe's inputSchema." },
    },
    additionalProperties: false,
  },
  status: {
    type: "object",
    required: ["approvalId"],
    properties: { approvalId: { type: "string", description: "approvalId from an approval_pending reply." } },
    additionalProperties: false,
  },
};

function agentCapabilitiesForWorkspace(
  store: SqliteMarketplaceStore,
  workspaceSlug: string,
  catalog: CompanyBoxCatalog,
) {
  const enabledBindings = store.listEnabledBindings(workspaceSlug);
  return store.listListingsForWorkspace(workspaceSlug).flatMap((listing) => {
    const customMcp = listingIsWorkspaceCustomMcp(listing, workspaceSlug);
    const openApi = listingIsCompanyBoxOpenApi(listing);
    if (listing.executionOwner !== "composio" && !customMcp && !openApi) {
      return [];
    }
    if (!store.isRegistered(listing.pluginId)) {
      return [];
    }
    const install = store.getInstall(workspaceSlug, listing.pluginId);
    if (!install?.enabled || install.lifecycle !== "installed") {
      return [];
    }
    const connection = store.getConnection(workspaceSlug, listing.pluginId);
    if (
      !listingConnected({
        listing,
        workspaceSlug,
        connectionState: connection?.state,
      })
    ) {
      return [];
    }
    const companyBox = companyBoxEntryForListing(catalog, listing, workspaceSlug);
    if (openApi && !companyBox) {
      return [];
    }
    const perAction = listing.actions.flatMap((action) => {
      if (
        !store.isActionEnabled({
          workspaceSlug,
          pluginId: listing.pluginId,
          actionKey: action,
        })
      ) {
        return [];
      }
      const requirement = resolveActionRequirement(listing, action);
      if (!requirement) {
        return [];
      }
      const matchingBinding = enabledBindings.find(
        (binding) =>
          binding.pluginId === listing.pluginId &&
          binding.capability === requirement.capability,
      );
      if (!matchingBinding) {
        return [];
      }
      const operation =
        companyBox?.kind === "openapi" ? (companyBox.byKey.get(action) ?? null) : null;
      if (openApi && !operation) {
        return [];
      }
      const toolName = toolNameForAction(listing.provider, action);
      return [
        {
          pluginId: listing.pluginId,
          workspaceSlug,
          provider: listing.provider,
          actionType: action,
          toolName,
          description: operation
            ? `${listing.displayName}: ${operation.title}`
            : customMcp
              ? `${listing.displayName}: ${customMcpToolForAction(listing, action)?.description ?? action}`
              : `${listing.displayName}: ${action}`,
          requiredCapabilities: [requirement.capability],
          runtimeSource: listing.executionOwner,
          connectionState: connection?.state ?? null,
          endpoint: `/api/agent/tools/${toolName}`,
          ...(operation
            ? {
                inputSchema: operation.toolSchema,
                ...(operation.schemaTruncated ? { schemaTruncated: true } : {}),
                risk: { write: operation.write, outward: operation.outward, destructive: operation.destructive },
              }
            : {}),
        },
      ];
    });
    if (!companyBox || perAction.length === 0) {
      return perAction;
    }
    const metaTool = (tool: CompanyBoxMetaTool, description: string) => ({
      pluginId: listing.pluginId,
      workspaceSlug,
      provider: listing.provider,
      actionType: `${listing.provider}.${companyBoxMetaSuffix(tool)}`,
      toolName: companyBoxMetaToolName(listing.provider, tool),
      description,
      requiredCapabilities:
        tool === "call"
          ? [...new Set(perAction.flatMap((entry) => entry.requiredCapabilities))]
          : [],
      runtimeSource: listing.executionOwner,
      connectionState: connection?.state ?? null,
      endpoint: `/api/agent/tools/${companyBoxMetaToolName(listing.provider, tool)}`,
      inputSchema: COMPANY_BOX_META_SCHEMAS[tool],
      exposure: companyBox.exposure,
      operationCount: perAction.length,
    });
    const describeTool = metaTool(
      "describe",
      `${listing.displayName}: full input schema and documentation for one operation.`,
    );
    const hasOutward =
      companyBox.kind === "openapi"
        ? companyBox.operations.some((operation) => operation.outward)
        : companyBox.tools.some((tool) => tool.outward);
    // Outward calls can be held for the owner; agents poll them here.
    const statusTools = hasOutward
      ? [metaTool("status", `${listing.displayName}: status and result of a call waiting for the owner's approval.`)]
      : [];
    if (companyBox.exposure === "direct") {
      // Direct: one tool per operation, plus describe when a listed schema had to be truncated.
      return [
        ...perAction,
        ...(perAction.some((entry) => "schemaTruncated" in entry) ? [describeTool] : []),
        ...statusTools,
      ];
    }
    return [
      metaTool(
        "search",
        `${listing.displayName}: search all ${perAction.length} operations by keyword, tag or capability. Paginated.`,
      ),
      describeTool,
      metaTool(
        "call",
        `${listing.displayName}: call one operation by key. Grants and approvals apply per operation.`,
      ),
      ...statusTools,
    ];
  });
}

function callbackUrlForRequest(input: {
  pluginId: string;
  publicOrigin?: string;
}) {
  const path = `/api/marketplace/plugins/${encodeURIComponent(input.pluginId)}/oauth/composio/callback`;
  if (!input.publicOrigin?.trim()) {
    throw new Error("MARKETPLACE_PUBLIC_ORIGIN is required for Composio OAuth callbacks.");
  }
  const origin = new URL(input.publicOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("MARKETPLACE_PUBLIC_ORIGIN must be an exact HTTP(S) origin.");
  }
  return `${origin.origin}${path}`;
}

function htmlCloseout(input: { title: string; detail: string; ok: boolean }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8faf8; color: #1d2524; }
      main { width: min(520px, calc(100vw - 32px)); border: 1px solid #d7dfda; background: #fff; padding: 24px; }
      h1 { margin: 0 0 8px; font-size: 22px; letter-spacing: 0; }
      p { margin: 0; color: #53635f; line-height: 1.5; }
      .state { display: inline-block; margin-bottom: 14px; font-size: 12px; font-weight: 700; color: ${input.ok ? "#0f6b45" : "#9f2e2e"}; }
    </style>
  </head>
  <body>
    <main>
      <span class="state">${input.ok ? "CONNECTED" : "BLOCKED"}</span>
      <h1>${input.title}</h1>
      <p>${input.detail}</p>
    </main>
  </body>
</html>`;
}

function htmlShell() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Teal Brick Marketplace</title>
    <style>
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8faf8; color: #1d2524; }
      main { max-width: 1120px; margin: 0 auto; padding: 28px; }
      header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; border-bottom: 1px solid #d7dfda; padding-bottom: 18px; }
      h1 { font-size: 28px; line-height: 1.1; margin: 0 0 8px; letter-spacing: 0; }
      p { color: #4d5d58; max-width: 760px; }
      section { margin-top: 24px; }
      table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d7dfda; }
      th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e5ebe8; font-size: 14px; }
      th { color: #52615d; background: #f1f5f3; font-weight: 650; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .chips { display: flex; gap: 8px; flex-wrap: wrap; }
      .chip { border: 1px solid #c8d4cf; border-radius: 999px; padding: 4px 9px; background: #fff; color: #33423e; font-size: 12px; }
      .controls { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr) auto; gap: 10px; align-items: end; }
      label { display: grid; gap: 6px; color: #52615d; font-size: 12px; font-weight: 700; }
      input { border: 1px solid #c8d4cf; padding: 9px 10px; font: inherit; color: #1d2524; background: #fff; }
      button { border: 1px solid #2f6f59; background: #2f6f59; color: #fff; padding: 10px 12px; font: inherit; font-weight: 700; cursor: pointer; }
      button:disabled { opacity: .55; cursor: default; }
      .status { min-height: 22px; color: #52615d; font-size: 13px; }
      .error { color: #9f2e2e; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Teal Brick Marketplace</h1>
          <p>Plugin catalog, credentials, provider health, capability bindings, execution ledger, Composio/MCP runtime sources, and promotion candidates.</p>
        </div>
        <div class="chips">
          <span class="chip">SQLite-owned</span>
          <span class="chip">Rules-gated</span>
          <span class="chip">Dynamic port</span>
        </div>
      </header>
      <section>
        <h2>Composio Connect</h2>
        <div class="controls">
          <label>Workspace <input id="workspace" value="default" autocomplete="off" /></label>
          <label>Toolkit <input id="toolkit" value="linear" autocomplete="off" /></label>
          <button id="connect">Import and connect</button>
        </div>
        <p id="status" class="status"></p>
      </section>
      <section>
        <h2>Installed Runtime State</h2>
        <table>
          <thead><tr><th>Plugin</th><th>Source</th><th>Install</th><th>Connection</th><th>Actions</th></tr></thead>
          <tbody id="plugins"><tr><td colspan="5">Loading...</td></tr></tbody>
        </table>
      </section>
      <section>
        <h2>Program API</h2>
        <table>
          <tbody>
            <tr><th>Health</th><td><code>GET /healthz</code></td></tr>
            <tr><th>Status</th><td><code>GET /api/status</code></td></tr>
            <tr><th>Catalog</th><td><code>GET /api/marketplace/catalog</code></td></tr>
            <tr><th>Plugins</th><td><code>GET /api/marketplace/plugins?workspaceSlug=default</code></td></tr>
            <tr><th>Provider Health</th><td><code>GET /api/marketplace/provider-health</code></td></tr>
            <tr><th>Audit</th><td><code>GET /api/marketplace/audit?workspaceSlug=default</code></td></tr>
          </tbody>
        </table>
      </section>
    </main>
    <script>
      const statusEl = document.getElementById("status");
      const pluginsEl = document.getElementById("plugins");
      const button = document.getElementById("connect");
      const workspaceEl = document.getElementById("workspace");
      const toolkitEl = document.getElementById("toolkit");

      function setStatus(message, error = false) {
        statusEl.textContent = message;
        statusEl.className = error ? "status error" : "status";
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>\"']/g, (character) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          "\"": "&quot;",
          "'": "&#39;",
        }[character]));
      }

      async function jsonFetch(url, options = {}) {
        const response = await fetch(url, {
          ...options,
          headers: { "content-type": "application/json", ...(options.headers || {}) },
        });
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json.detail || json.error || "Request failed");
        }
        return json;
      }

      async function refresh() {
        const workspace = encodeURIComponent(workspaceEl.value.trim() || "default");
        const data = await jsonFetch("/api/marketplace/plugins?workspaceSlug=" + workspace);
        pluginsEl.innerHTML = data.items.map((item) => (
          "<tr>" +
          "<td>" + escapeHtml(item.displayName) + "<br><code>" + escapeHtml(item.pluginId) + "</code></td>" +
          "<td>" + escapeHtml(item.source) + "</td>" +
          "<td>" + escapeHtml(item.install?.lifecycle || "not installed") + "</td>" +
          "<td>" + escapeHtml(item.connection?.state || "not connected") + "</td>" +
          "<td>" + item.actions.length + "</td>" +
          "</tr>"
        )).join("");
      }

      async function importAndConnect() {
        button.disabled = true;
        const workspaceSlug = workspaceEl.value.trim() || "default";
        const toolkit = toolkitEl.value.trim();
        try {
          setStatus("Importing toolkit...");
          const imported = await jsonFetch("/api/marketplace/catalog/composio/import", {
            method: "POST",
            body: JSON.stringify({ workspaceSlug, toolkit, actorId: "operator", autoEnable: true }),
          });
          setStatus("Starting Composio authorization...");
          const connection = await jsonFetch("/api/marketplace/plugins/" + encodeURIComponent(imported.listing.pluginId) + "/connection", {
            method: "POST",
            body: JSON.stringify({ workspaceSlug, actorId: "operator", provider: toolkit, toolkit, backend: "composio" }),
          });
          if (connection.auth?.redirectUrl) {
            window.open(connection.auth.redirectUrl, "_blank", "noopener,noreferrer");
            setStatus("Authorization popup opened. Return here after the connection completes.");
          } else {
            setStatus("Connected account recorded.");
          }
          await refresh();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error), true);
        } finally {
          button.disabled = false;
        }
      }

      button.addEventListener("click", () => { void importAndConnect(); });
      void refresh().catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
    </script>
  </body>
</html>`;
}

export async function buildMarketplaceApp(
  options: BuildMarketplaceAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const entries = [
        ...new URLSearchParams(
          typeof body === "string" ? body : body.toString("utf8"),
        ).entries(),
      ];
      done(
        null,
        entries.length === 1 && entries[0]?.[0] === "ticket"
          ? { ticket: entries[0][1] }
          : null,
      );
    },
  );
  const runtimePath = options.store.describeRuntime().databasePath;
  const providerSettings =
    options.providerSettings ??
    new MarketplaceProviderSettingsStore(
      path.join(path.dirname(runtimePath), "provider-settings.json"),
      path.join(path.dirname(runtimePath), "provider-secrets.json"),
      options.env,
    );
  await providerSettings.load();
  const providerEnvironment = () => providerSettings.environment();
  const frontend = await registerMarketplaceFrontend(app);
  const environment = options.environment ?? process.env;
  const companyBox =
    options.companyBoxCatalog ??
    loadCompanyBoxCatalog(options.companyBoxCatalogDir ?? companyBoxCatalogDir(environment), {
      directMaxOperations: companyBoxDirectMaxOperations(environment),
    });
  for (const failure of [
    ...companyBox.loadErrors,
    ...companyBox.entries
      .filter((entry) => entry.errors.length > 0)
      .map((entry) => ({ entry: entry.entry.id, code: "company_box_coverage_failed", message: entry.errors.join("; ") })),
  ]) {
    console.error(JSON.stringify({ event: "marketplace.company_box.entry_unusable", ...failure }));
  }
  // Company Box REST listings are global (configured per workspace). Seed the
  // usable ones; a listing whose entry disappeared or broke keeps its row
  // (installs and grants stay inspectable) but publishes no actions.
  for (const entry of companyBox.usable()) {
    if (entry.kind !== "openapi") continue;
    const listing = companyBoxListing(entry, options.store.getListing(entry.pluginId)?.createdAt);
    options.store.upsertListing(listing);
    // A re-pinned spec may add operations: bind them where the entry is installed.
    for (const install of options.store.listInstallsForPlugin(entry.pluginId)) {
      if (install.lifecycle === "installed") {
        bindCustomMcpForWorkspace(options.store, install.workspaceSlug, listing);
      }
    }
  }
  for (const listing of options.store.listListings()) {
    if (
      listingIsCompanyBoxOpenApi(listing) &&
      !companyBox.openApiForPluginId(listing.pluginId) &&
      listing.actions.length > 0
    ) {
      options.store.upsertListing(retiredCompanyBoxListing(listing));
    }
  }
  const rulesConfiguration = options.rules;
  const portalConfiguration = resolvePortalRuntimeConfiguration({
    env: environment,
    portalIssuerUrl: options.portalIssuerUrl,
    portalInstanceProof: options.portalInstanceProof,
  });
  const operatorSessions =
    options.operatorSessionManager ??
    MarketplaceOperatorSessionManager.fromEnvironment({
      allowUnauthenticated:
        options.allowUnauthenticatedOperator === true ||
        (options.allowUnauthenticatedOperator === undefined && process.env.NODE_ENV === "test"),
    });
  const configuredOrganizationId =
    options.organizationId?.trim() || environment.MARKETPLACE_ORGANIZATION_ID?.trim() || null;
  const organizationId = configuredOrganizationId ?? portalConfiguration.workspaceId ?? "default";
  if (portalConfiguration.workspaceId && portalConfiguration.workspaceId !== organizationId) {
    throw new Error(
      "MARKETPLACE_ORGANIZATION_ID conflicts with MARKETPLACE_PORTAL_WORKSPACE_ID.",
    );
  }
  const requestPrincipals = new WeakMap<FastifyRequest, MarketplacePrincipal>();
  const governanceMode = governanceModeFor({
    rulesClient: options.rulesClient,
    rulesConfigured: Boolean(rulesConfiguration),
  });
  const governed = {
    governance: governanceMode,
    rulesClient: options.rulesClient,
    store: options.store,
  };
  /** Governance actor from the authenticated request principal only. */
  const principalActor = (request: FastifyRequest): GovernanceActor | null => {
    const principal = requestPrincipals.get(request);
    if (principal?.kind === "operator" || principal?.kind === "service") {
      return { kind: principal.kind, id: principal.id };
    }
    return null;
  };
  const servicePrincipal: MarketplacePrincipal = {
    kind: "service",
    id: "marketplace-service",
    organizationId,
  };
  const portalAttachmentAudience =
    options.portalAttachmentAudience?.trim() ||
    process.env.MARKETPLACE_PORTAL_ATTACHMENT_AUDIENCE?.trim() ||
    "marketplace";
  const portalIssuerUrl = portalConfiguration.issuerUrl;
  const portalInstanceProof = portalConfiguration.instanceProof;
  const portalIdentityMatches = (input: {
    deploymentId?: string;
    portalOrgId?: string;
    workspaceId?: string;
  }) =>
    (!portalConfiguration.deploymentId || input.deploymentId === portalConfiguration.deploymentId) &&
    (!portalConfiguration.portalOrgId || input.portalOrgId === portalConfiguration.portalOrgId) &&
    (!portalConfiguration.workspaceId || input.workspaceId === portalConfiguration.workspaceId);
  const agentScopeVerifier =
    options.agentScopeVerifier ??
    createPortalAgentScopeVerifier({
      issuer: portalIssuerUrl,
      fetchImpl: options.portalFetch ?? options.providerFetch,
    });
  const portalHandoffClient = createPortalHandoffClient({
    issuer: portalIssuerUrl,
    instanceProof: portalInstanceProof,
    fetchImpl: options.portalFetch ?? options.providerFetch,
  });
  const portalRuntimeScopeVerifier =
    options.portalRuntimeScopeVerifier ??
    createPortalRuntimeScopeVerifier({
      issuer: portalIssuerUrl,
      instanceProof: portalInstanceProof,
      fetchImpl: options.portalFetch ?? options.providerFetch,
    });
  const requireOperator = (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requestPrincipals.get(request);
    if (principal?.kind === "operator") return principal;
    reply.code(403);
    return null;
  };
  const requireService = (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requestPrincipals.get(request);
    if (principal?.kind === "service") return principal;
    reply.code(403);
    return null;
  };
  const requireHandoffPrincipal = (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const principal = requestPrincipals.get(request);
    if (principal && ["service", "operator"].includes(principal.kind)) {
      return principal;
    }
    reply.code(403);
    return null;
  };
  const verifyPortalScope = async (input: {
    request: FastifyRequest;
    reply: FastifyReply;
    requiredCapability: ConnectorCapability;
  }): Promise<{ ok: true; scope: PortalAgentScope } | { ok: false; error: string }> => {
    const agentToken = headerValue(input.request, "x-tealbrick-agent-token");
    const attachmentToken = headerValue(input.request, "x-tealbrick-attachment");
    if (!agentToken || !attachmentToken) {
      input.reply.code(401);
      return { ok: false, error: "agent_scope_required" };
    }
    try {
      const scope = await agentScopeVerifier({
        agentToken,
        attachmentToken,
        audience: portalAttachmentAudience,
        requiredCapability: input.requiredCapability,
      });
      return { ok: true, scope };
    } catch (error) {
      if (error instanceof PortalScopeError) {
        input.reply.code(error.statusCode);
        return { ok: false, error: error.code };
      }
      input.reply.code(503);
      return { ok: false, error: "portal_identity_unavailable" };
    }
  };
  const verifyAgentGrantScope = async (input: {
    request: FastifyRequest;
    reply: FastifyReply;
    grant: AgentConnectorGrant;
    requiredCapability: ConnectorCapability;
  }): Promise<
    | { ok: true; scope: PortalAgentScope }
    | { ok: false; error: string }
  > => {
    if (input.grant.state !== "active") {
      input.reply.code(403);
      return { ok: false, error: "agent_grant_revoked" };
    }
    if (agentConnectorGrantIsExpired(input.grant)) {
      input.reply.code(403);
      return { ok: false, error: "agent_grant_expired" };
    }
    const verified = await verifyPortalScope(input);
    if (!verified.ok) {
      return verified;
    }
    const { scope } = verified;
    if (scope.organizationId !== input.grant.workspaceSlug) {
      input.reply.code(403);
      return { ok: false, error: "agent_grant_tenant_mismatch" };
    }
    if (scope.agentId !== input.grant.agentId) {
      input.reply.code(403);
      return { ok: false, error: "agent_grant_agent_mismatch" };
    }
    if (scope.attachmentId !== input.grant.attachmentId) {
      input.reply.code(403);
      return { ok: false, error: "agent_grant_attachment_mismatch" };
    }
    if (scope.expiresAt * 1000 <= Date.now()) {
      input.reply.code(403);
      return { ok: false, error: "agent_grant_expired" };
    }
    return { ok: true, scope };
  };
  const logCustomMcpFailure = (input: {
    event: string;
    pluginId: string;
    workspaceSlug: string;
    error: unknown;
  }) => {
    // Never log header values or upstream bodies; codes and statuses only.
    const remote = input.error instanceof McpRemoteError ? input.error : null;
    console.error(
      JSON.stringify({
        event: input.event,
        pluginId: input.pluginId,
        workspaceSlug: input.workspaceSlug,
        code: remote?.code ?? "unexpected",
        status: remote?.detail.status ?? null,
        rpcCode: remote?.detail.rpcCode ?? null,
        reason: remote?.detail.reason ?? null,
        name: input.error instanceof Error ? input.error.name : typeof input.error,
      }),
    );
  };
  /** Plain + decrypted secret headers. Throws ConnectorSecretStoreUnavailableError. */
  const customMcpConnection = (
    listing: MarketplaceListing,
    workspaceSlug: string,
  ) => {
    const manifest = customMcpManifest(listing);
    return {
      url: manifest.url,
      transport: manifest.transport,
      headers: {
        ...manifest.headers,
        ...options.store.readConnectorSecretValues({
          workspaceSlug,
          pluginId: listing.pluginId,
        }),
      },
      fetchImpl: options.mcpFetch,
      lookup: options.mcpLookup,
      env: environment,
    };
  };
  const executeCustomMcpAction = async (input: {
    reply: FastifyReply;
    listing: MarketplaceListing;
    workspaceSlug: string;
    capability: ConnectorCapability;
    action: Record<string, unknown> & { type: string };
    actorId: string;
    traceId: string;
    rules: Awaited<ReturnType<typeof enforceRules>>;
    runId: string | null;
    sessionId: string | null;
    agentGrantId: string | null;
  }) => {
    const { listing, workspaceSlug } = input;
    const pluginId = listing.pluginId;
    const tool = customMcpToolForAction(listing, input.action.type);
    if (!tool) {
      input.reply.code(400);
      return { ok: false, traceId: input.traceId, error: "unknown_connector_action" };
    }
    const rulesDecisionId =
      "decisionId" in input.rules ? (input.rules.decisionId ?? null) : null;
    const usageBase = {
      workspaceSlug,
      pluginId,
      provider: listing.provider,
      sourceExecutor: listing.executionOwner,
      sourceActionKey: input.action.type,
      productCapabilityKey: `connector.${listing.executionOwner}.${listing.provider}.${input.action.type}`,
      scopesUsed: [input.capability],
      runId: input.runId,
      sessionId: input.sessionId,
      metadata: {
        rules: input.rules,
        toolName: tool.name,
        ...(input.agentGrantId ? { agentGrantId: input.agentGrantId } : {}),
      },
      input: input.action,
    };
    const fail = (status: number, error: string) => {
      const usage = options.store.recordUsage({
        ...usageBase,
        status: "failed",
        error,
        output: null,
      });
      options.store.recordEvent({
        type: "marketplace.execution.failed",
        traceId: input.traceId,
        workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId,
        payload: {
          capability: input.capability,
          action: input.action.type,
          usageId: usage.id,
          error,
        },
      });
      input.reply.code(status);
      return { ok: false, traceId: input.traceId, error, usage };
    };
    let connection: ReturnType<typeof customMcpConnection>;
    try {
      connection = customMcpConnection(listing, workspaceSlug);
    } catch (error) {
      if (error instanceof ConnectorSecretStoreUnavailableError) {
        return fail(503, "connector_secret_store_unavailable");
      }
      throw error;
    }
    const { type: _type, ...args } = input.action;
    let output: Awaited<ReturnType<typeof callMcpTool>>;
    try {
      output = await callMcpTool(connection, tool.name, args);
    } catch (error) {
      logCustomMcpFailure({
        event: "marketplace.custom_mcp.execute_failed",
        pluginId,
        workspaceSlug,
        error,
      });
      return fail(
        502,
        error instanceof McpRemoteError && error.code === "mcp_rpc_error"
          ? "mcp_tool_failed"
          : error instanceof McpRemoteError && error.code === "tailnet_unavailable"
            ? "tailnet_unavailable"
            : "mcp_unreachable",
      );
    }
    if (output.isError) {
      return fail(502, "mcp_tool_failed");
    }
    const result = {
      pluginId,
      workspaceSlug,
      provider: listing.provider,
      capability: input.capability,
      actionType: input.action.type,
      performedAt: new Date().toISOString(),
      simulated: false,
      summary: `Ran ${tool.title ?? tool.name} on ${listing.displayName}.`,
      details: {
        toolName: tool.name,
        result: {
          content: output.content,
          ...(output.structuredContent === undefined
            ? {}
            : { structuredContent: output.structuredContent }),
        },
      },
    };
    const usage = options.store.recordUsage({
      ...usageBase,
      metadata: { ...usageBase.metadata, output: outputDigest(result) },
      status: "succeeded",
      error: null,
      output: result,
    });
    options.store.recordEvent({
      type: "marketplace.execution.completed",
      traceId: input.traceId,
      workspaceSlug,
      pluginId,
      actorId: input.actorId,
      rulesDecisionId,
      payload: {
        capability: input.capability,
        action: input.action.type,
        usageId: usage.id,
      },
    });
    return { ok: true, traceId: input.traceId, result, usage, rules: input.rules };
  };
  const companyBoxFetch = options.companyBoxFetch ?? options.mcpFetch;
  const maxUploadBytes = companyBoxMaxUploadBytes(environment);
  // Execute routes carry base64 uploads: decoded cap × 4/3 plus room for JSON.
  const uploadBodyLimit = Math.max(1024 * 1024, Math.ceil((maxUploadBytes * 4) / 3) + 256 * 1024);
  /**
   * Base URL (connection metadata) and decrypted credentials for a Company
   * Box REST connector. Throws ConnectorSecretStoreUnavailableError.
   */
  const companyBoxOpenApiTarget = (listing: MarketplaceListing, workspaceSlug: string) => {
    const entry = companyBox.openApiForPluginId(listing.pluginId);
    if (!entry) return { ok: false as const, error: "company_box_entry_unavailable" };
    const connection = options.store.getConnection(workspaceSlug, listing.pluginId);
    const baseUrl = typeof connection?.metadata.baseUrl === "string" ? connection.metadata.baseUrl : "";
    if (!baseUrl) return { ok: false as const, error: "connector_not_connected" };
    return {
      ok: true as const,
      entry,
      baseUrl,
      credentials: options.store.readConnectorSecretValues({ workspaceSlug, pluginId: listing.pluginId }),
    };
  };
  const callCompanyBoxOperation = (
    target: { entry: CompiledOpenApiEntry; baseUrl: string; credentials: Record<string, string> },
    key: string,
    args: Record<string, unknown>,
  ) => {
    const operation = target.entry.byKey.get(key);
    if (!operation) {
      throw new OpenApiCallError("openapi_argument_invalid", "Unknown operation.", { field: "operation" });
    }
    return callOpenApiOperation({
      baseUrl: target.baseUrl,
      apiBasePath: target.entry.apiBasePath,
      operation: operation.operation,
      validateArguments: operation.validateArguments,
      maxUploadBytes,
      args,
      auth: runtimeAuthFor(target.entry.entry.auth),
      credentials: target.credentials,
      fetchImpl: companyBoxFetch,
      lookup: options.mcpLookup,
      env: environment,
    });
  };
  const companyBoxFailureStatus = (error: OpenApiCallError) =>
    error.code === "openapi_argument_invalid" || error.code === "openapi_base_url_not_allowed"
      ? 400
      : error.code === "openapi_upload_too_large"
        ? 413
      : error.code === "openapi_credentials_missing"
        ? 409
        : error.code === "tailnet_unavailable"
          ? 503
        : error.code === "openapi_timeout"
          ? 504
          : 502;
  const logCompanyBoxFailure = (input: { event: string; pluginId: string; workspaceSlug: string; error: unknown }) => {
    // Codes and statuses only: never URLs (query auth), headers or bodies.
    const failure = input.error instanceof OpenApiCallError ? input.error : null;
    console.error(
      JSON.stringify({
        event: input.event,
        pluginId: input.pluginId,
        workspaceSlug: input.workspaceSlug,
        code: failure?.code ?? "unexpected",
        status: failure?.detail.status ?? null,
        reason: failure?.detail.reason ?? null,
        name: input.error instanceof Error ? input.error.name : typeof input.error,
      }),
    );
  };
  const executeCompanyBoxAction = async (input: {
    reply: FastifyReply;
    listing: MarketplaceListing;
    workspaceSlug: string;
    capability: ConnectorCapability;
    action: Record<string, unknown> & { type: string };
    actorId: string;
    traceId: string;
    rules: Awaited<ReturnType<typeof enforceRules>>;
    risk: GovernedActionRisk | undefined;
    runId: string | null;
    sessionId: string | null;
    agentGrantId: string | null;
  }) => {
    const { listing, workspaceSlug } = input;
    const pluginId = listing.pluginId;
    const rulesDecisionId =
      "decisionId" in input.rules ? (input.rules.decisionId ?? null) : null;
    const usageBase = {
      workspaceSlug,
      pluginId,
      provider: listing.provider,
      sourceExecutor: listing.executionOwner,
      sourceActionKey: input.action.type,
      productCapabilityKey: `connector.${listing.executionOwner}.${listing.provider}.${input.action.type}`,
      scopesUsed: [input.capability],
      runId: input.runId,
      sessionId: input.sessionId,
      metadata: {
        rules: input.rules,
        ...(input.risk ? { risk: input.risk } : {}),
        ...(input.agentGrantId ? { agentGrantId: input.agentGrantId } : {}),
      },
      input: input.action,
    };
    const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => {
      const usage = options.store.recordUsage({ ...usageBase, status: "failed", error, output: null });
      options.store.recordEvent({
        type: "marketplace.execution.failed",
        traceId: input.traceId,
        workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId,
        payload: { capability: input.capability, action: input.action.type, usageId: usage.id, error },
      });
      input.reply.code(status);
      return { ok: false, traceId: input.traceId, error, ...extra, usage };
    };
    let target: ReturnType<typeof companyBoxOpenApiTarget>;
    try {
      target = companyBoxOpenApiTarget(listing, workspaceSlug);
    } catch (error) {
      if (error instanceof ConnectorSecretStoreUnavailableError) {
        return fail(503, "connector_secret_store_unavailable");
      }
      throw error;
    }
    if (!target.ok) return fail(409, target.error);
    const operation = target.entry.byKey.get(input.action.type);
    if (!operation) {
      input.reply.code(400);
      return { ok: false, traceId: input.traceId, error: "unknown_connector_action" };
    }
    const { type: _type, ...args } = input.action;
    let response: Awaited<ReturnType<typeof callOpenApiOperation>>;
    try {
      response = await callCompanyBoxOperation(target, operation.key, args);
    } catch (error) {
      if (!(error instanceof OpenApiCallError)) throw error;
      logCompanyBoxFailure({ event: "marketplace.company_box.execute_failed", pluginId, workspaceSlug, error });
      return fail(companyBoxFailureStatus(error), error.code, {
        ...(error.detail.field ? { field: error.detail.field } : {}),
        ...(error.detail.reason ? { reason: error.detail.reason } : {}),
        ...(error.detail.status
          ? { upstream: { status: error.detail.status, ...(error.detail.body === undefined ? {} : { body: error.detail.body }) } }
          : {}),
      });
    }
    const result = {
      pluginId,
      workspaceSlug,
      provider: listing.provider,
      capability: input.capability,
      actionType: input.action.type,
      performedAt: new Date().toISOString(),
      simulated: false,
      summary: `Ran ${operation.title} on ${listing.displayName}.`,
      details: {
        operation: { key: operation.key, method: operation.method.toUpperCase(), path: operation.path },
        response,
      },
    };
    // The ledger keeps output shape plus the full output's size and sha256.
    const usage = options.store.recordUsage({
      ...usageBase,
      metadata: { ...usageBase.metadata, output: outputDigest(result) },
      status: "succeeded",
      error: null,
      output: result,
    });
    options.store.recordEvent({
      type: "marketplace.execution.completed",
      traceId: input.traceId,
      workspaceSlug,
      pluginId,
      actorId: input.actorId,
      rulesDecisionId,
      payload: { capability: input.capability, action: input.action.type, usageId: usage.id },
    });
    return { ok: true, traceId: input.traceId, result, usage, rules: input.rules };
  };
  /**
   * Owner approval mode: hold an agent's outward Company Box call for the
   * owner instead of refusing it. Arguments are validated, bounded and stored
   * (never logged or audited); a repeat with the same idempotency key returns
   * the held call's state or result.
   */
  const holdCompanyBoxCall = (input: {
    listing: MarketplaceListing;
    workspaceSlug: string;
    actionKey: string;
    capability: ConnectorCapability;
    args: Record<string, unknown>;
    agentId: string;
    sourceKind: CompanyBoxApproval["sourceKind"];
    sourceRef: string;
    idempotencyKey: string | null;
    traceId: string;
  }): { status: number; body: Record<string, unknown> } => {
    const fingerprint = approvalFingerprint(input.actionKey, input.args);
    if (input.idempotencyKey) {
      const existing = options.store.findCompanyBoxApprovalByKey({
        workspaceSlug: input.workspaceSlug,
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) {
        return existing.fingerprint === fingerprint && existing.pluginId === input.listing.pluginId
          ? approvalReply(existing)
          : { status: 409, body: { ok: false, error: "approval_idempotency_conflict" } };
      }
    }
    if (
      options.store.countPendingCompanyBoxApprovals({ workspaceSlug: input.workspaceSlug, agentId: input.agentId }) >=
      COMPANY_BOX_APPROVAL_MAX_PENDING_PER_AGENT
    ) {
      return {
        status: 429,
        body: {
          ok: false,
          error: "approval_queue_full",
          detail: `This agent already has ${COMPANY_BOX_APPROVAL_MAX_PENDING_PER_AGENT} calls waiting for approval.`,
        },
      };
    }
    if (Buffer.byteLength(JSON.stringify(input.args)) > COMPANY_BOX_APPROVAL_MAX_ARGUMENT_BYTES) {
      // Held calls keep their arguments verbatim for the owner; nothing is
      // truncated, so uploads that do not fit are refused outright.
      return {
        status: 413,
        body: {
          ok: false,
          error: "approval_args_too_large",
          detail: `Outward calls wait for approval with their arguments stored in full, up to ${COMPANY_BOX_APPROVAL_MAX_ARGUMENT_BYTES} bytes. Send a smaller file, or upload it with a non-outward operation first and reference it.`,
        },
      };
    }
    const entry = companyBoxEntryForListing(companyBox, input.listing, input.workspaceSlug);
    if (entry?.kind === "openapi") {
      const operation = entry.byKey.get(input.actionKey);
      try {
        if (!operation) throw new OpenApiCallError("openapi_argument_invalid", "Unknown operation.");
        validateOpenApiArguments(operation.operation, input.args, runtimeAuthFor(entry.entry.auth), operation.validateArguments, maxUploadBytes);
      } catch (error) {
        if (!(error instanceof OpenApiCallError)) throw error;
        return {
          status: 400,
          body: {
            ok: false,
            error: error.code,
            ...(error.detail.field ? { field: error.detail.field } : {}),
            ...(error.detail.reason ? { reason: error.detail.reason } : {}),
          },
        };
      }
    }
    let approval: CompanyBoxApproval;
    try {
      approval = options.store.createCompanyBoxApproval({
      workspaceSlug: input.workspaceSlug,
      pluginId: input.listing.pluginId,
      actionKey: input.actionKey,
      capability: input.capability,
      agentId: input.agentId,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      idempotencyKey: input.idempotencyKey,
      fingerprint,
      arguments: input.args,
      argumentsPreview: approvalPreview(input.args),
      expiresAt: new Date(Date.now() + COMPANY_BOX_APPROVAL_TTL_MS).toISOString(),
      });
    } catch (error) {
      // A concurrent hold with the same idempotency key won the insert.
      const existing = input.idempotencyKey
        ? options.store.findCompanyBoxApprovalByKey({
            workspaceSlug: input.workspaceSlug,
            agentId: input.agentId,
            idempotencyKey: input.idempotencyKey,
          })
        : null;
      if (!existing) throw error;
      return existing.fingerprint === fingerprint && existing.pluginId === input.listing.pluginId
        ? approvalReply(existing)
        : { status: 409, body: { ok: false, error: "approval_idempotency_conflict" } };
    }
    options.store.recordAudit({
      workspaceSlug: input.workspaceSlug,
      pluginId: input.listing.pluginId,
      eventType: "marketplace.company_box.approval.requested",
      actorId: `agent:${input.agentId}`,
      metadata: {
        governance: "owner",
        approvalId: approval.id,
        actionKey: input.actionKey,
        agentId: input.agentId,
        sourceKind: input.sourceKind,
        expiresAt: approval.expiresAt,
      },
    });
    options.store.recordEvent({
      type: "marketplace.execution.held",
      traceId: input.traceId,
      workspaceSlug: input.workspaceSlug,
      pluginId: input.listing.pluginId,
      actorId: `agent:${input.agentId}`,
      payload: { approvalId: approval.id, action: input.actionKey, capability: input.capability },
    });
    return approvalReply(approval);
  };
  /** Run an approved held call once, against live state, and store its outcome. */
  const runApprovedCompanyBoxCall = async (
    approval: CompanyBoxApproval,
    request: FastifyRequest,
    reply: FastifyReply,
    operatorId: string,
  ): Promise<CompanyBoxApproval> => {
    const traceId = traceIdFrom(request);
    const fail = (error: string) =>
      options.store.finishCompanyBoxApproval({ id: approval.id, state: "failed", error });
    try {
      const authorityActive =
        approval.sourceKind === "agent-grant"
          ? options.store.getAgentConnectorGrant(approval.sourceRef)?.state === "active"
          : options.store.getMarketplaceAgentConsentById(approval.sourceRef)?.state === "active";
      if (!authorityActive) return fail("approval_authority_revoked");
      const listing = options.store.getListingForWorkspace(approval.pluginId, approval.workspaceSlug);
      const published = listing
        ? resolvePublishedAgentAction({
            store: options.store,
            workspaceSlug: approval.workspaceSlug,
            pluginId: approval.pluginId,
            actionKey: approval.actionKey,
          })
        : null;
      if (!listing || !published || published.capability !== approval.capability) {
        return fail("approval_target_unavailable");
      }
      const risk = companyBoxRiskForAction(companyBox, listing, approval.workspaceSlug, approval.actionKey);
      const rules = await enforceRules({
        reply,
        workspaceSlug: approval.workspaceSlug,
        operation: "execute",
        capability: approval.capability,
        pluginId: approval.pluginId,
        actorId: operatorId,
        payload: { approvalId: approval.id, agentId: approval.agentId, actionKey: approval.actionKey, traceId },
        actor: principalActor(request),
        ...(risk ? { risk } : {}),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) return fail(String(rules.error));
      const common = {
        reply,
        listing,
        workspaceSlug: approval.workspaceSlug,
        capability: approval.capability,
        action: { ...approval.arguments, type: approval.actionKey },
        actorId: `agent:${approval.agentId}`,
        traceId,
        rules,
        runId: null,
        sessionId: null,
        agentGrantId: approval.sourceKind === "agent-grant" ? approval.sourceRef : null,
      };
      const outcome: Record<string, unknown> = listingIsCompanyBoxOpenApi(listing)
        ? await executeCompanyBoxAction({ ...common, risk })
        : await executeCustomMcpAction(common);
      return outcome.ok === true
        ? options.store.finishCompanyBoxApproval({ id: approval.id, state: "succeeded", result: outcome.result })
        : fail(typeof outcome.error === "string" ? outcome.error : "approval_execution_failed");
    } catch (error) {
      fail("approval_execution_failed");
      throw error;
    }
  };
  const composioCatalogSyncByWorkspace = new Map<
    string,
    { expiresAt: number; pending: Promise<unknown> | null }
  >();
  const ensureComposioCatalog = async (workspaceSlug = "default") => {
    if (!readProviderHealth(providerEnvironment()).composio.configured) {
      return null;
    }
    const cached = composioCatalogSyncByWorkspace.get(workspaceSlug);
    if (cached && Date.now() < cached.expiresAt) {
      return null;
    }
    if (cached?.pending) {
      return cached.pending;
    }
    const pending = synchronizeComposioCatalog({
      store: options.store,
      workspaceSlug,
      env: providerEnvironment(),
      fetchImpl: options.providerFetch,
    })
      .then((result) => {
        composioCatalogSyncByWorkspace.set(workspaceSlug, {
          expiresAt: Date.now() + 5 * 60_000,
          pending: null,
        });
        return result;
      })
      .catch(() => null)
      .finally(() => {
        const latest = composioCatalogSyncByWorkspace.get(workspaceSlug);
        if (latest?.pending) {
          composioCatalogSyncByWorkspace.set(workspaceSlug, {
            expiresAt: latest.expiresAt,
            pending: null,
          });
        }
      });
    composioCatalogSyncByWorkspace.set(workspaceSlug, {
      expiresAt: 0,
      pending,
    });
    return pending;
  };

  app.addHook("onRequest", async (request, reply) => {
    const headers = corsHeadersForOrigin(request.headers.origin, environment);
    for (const [key, value] of Object.entries(headers)) {
      reply.header(key, value);
    }
    if (request.method === "OPTIONS") {
      reply.code(204).send();
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (request.method === "OPTIONS" || marketplacePublicPath(pathname)) return;

    const serviceToken = bearerTokenFrom(request);
    if (pathname === "/api/marketplace/v1/runtime/composio/execute") {
      if (serviceToken && marketplaceSecretMatches(serviceToken, options.internalAuthToken)) {
        reply.code(401).send({
          ok: false,
          schema: 1,
          error: "runtime_service_bearer_forbidden",
        });
      }
      return;
    }
    if (serviceToken && marketplaceSecretMatches(serviceToken, options.internalAuthToken)) {
      requestPrincipals.set(request, servicePrincipal);
      bindMarketplacePrincipalScope(request, servicePrincipal);
      return;
    }

    const sessionStatus = operatorSessions.status(request.headers.cookie);
    const operator = operatorSessions.authenticate(request.headers.cookie);
    if (!operator) {
      const configured = operatorSessions.status(request.headers.cookie).configured;
      reply.code(configured ? 401 : 503).send({
        ok: false,
        error: configured ? "marketplace_unauthorized" : "marketplace_operator_auth_unconfigured",
        detail: configured
          ? "Unlock Marketplace with an operator session or use the internal service bearer."
          : "MARKETPLACE_OPERATOR_ACCESS_TOKEN is required before Marketplace domain data is available.",
      });
      return;
    }

    if (sessionStatus.mode === "test_bypass") {
      requestPrincipals.set(request, operator);
      return;
    }

    if (isMutation(request.method)) {
      if (!allowedCorsOrigin(request.headers.origin, environment)) {
        reply.code(403).send({ ok: false, error: "marketplace_origin_denied" });
        return;
      }
      if (!operatorSessions.csrfMatches(request.headers.cookie, request.headers["x-csrf-token"])) {
        reply.code(403).send({ ok: false, error: "marketplace_csrf_denied" });
        return;
      }
    }

    requestPrincipals.set(request, operator);
    bindMarketplacePrincipalScope(request, operator);
  });

  app.setErrorHandler((error, request, reply) => {
    const isRuntimeReceiver =
      request.url.split("?", 1)[0] ===
      "/api/marketplace/v1/runtime/composio/execute";
    if (isRuntimeReceiver) {
      const traceId = traceIdFrom(request);
      if (error instanceof ZodError) {
        reply.code(400).send(
          runtimeResponse({
            ok: false,
            traceId,
            error: "runtime_validation_failed",
          }),
        );
        return;
      }
      if ((error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        reply.code(413).send(
          runtimeResponse({
            ok: false,
            traceId,
            error: "runtime_request_too_large",
          }),
        );
        return;
      }
    }
    if (error instanceof ZodError) {
      reply.code(400).send({
        ok: false,
        error: "validation_failed",
        issues: error.issues,
      });
      return;
    }
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number" &&
      (error as { statusCode: number }).statusCode >= 400 &&
      (error as { statusCode: number }).statusCode < 500
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode < 500) {
      // Fastify client errors (malformed JSON, body too large, ...) carry
      // their own safe codes; keep the status but not the raw message.
      reply.code(statusCode).send({
        ok: false,
        error: "marketplace_request_invalid",
        code: (error as { code?: unknown }).code ?? null,
      });
      return;
    }
    const errorId = `err_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    // Raw messages can include file paths, upstream provider responses, or
    // configuration names: log them server-side only.
    console.error(
      JSON.stringify({
        event: "marketplace.request.error",
        errorId,
        method: request.method,
        route: request.routeOptions?.url ?? null,
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    reply.code(500).send({
      ok: false,
      error: "marketplace_program_error",
      errorId,
    });
  });

  app.get("/", async (_request, reply) => {
    const rendered = await frontend.sendIndex(_request, reply);
    if (rendered !== null) return rendered;
    reply.type("text/html; charset=utf-8");
    return htmlShell();
  });

  const completePortalLaunch = async (
    ticket: string,
    deploymentId: string,
    reply: FastifyReply,
    input: { readonly issueOperatorSession?: boolean; readonly secure?: boolean } = {},
  ) => {
    try {
      const session = await portalHandoffClient.redeemLaunchTicket({
        deploymentId,
        ticket,
      });
      if (
        session.productTenantId !== organizationId ||
        !portalIdentityMatches(session)
      ) {
        reply.code(403);
        reply.type("text/html; charset=utf-8");
        return htmlCloseout({
          ok: false,
          title: "Marketplace launch blocked",
          detail: "The Portal deployment identity does not match this Marketplace instance.",
        });
      }
      options.store.upsertPortalHandoffSession({
        portalIssuer: portalIssuerUrl ?? "",
        deploymentId: session.deploymentId,
        portalOrgId: session.portalOrgId,
        productTenantId: session.productTenantId,
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionToken: session.session,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
      if (input.issueOperatorSession) {
        const operatorSession = operatorSessions.issuePortalSession({
          id: session.userId,
          organizationId: session.productTenantId,
          organizationName: session.workspaceName ?? null,
        });
        reply.header(
          "set-cookie",
          operatorSessions.sessionCookie(operatorSession.token, input.secure === true, "Lax"),
        );
        reply.header("location", "/");
        reply.code(303);
        return "";
      }
      reply.type("text/html; charset=utf-8");
      return htmlCloseout({
        ok: true,
        title: "Marketplace connected",
        detail: "Portal ownership was verified. Return to Marketplace to continue the connector approval flow.",
      });
    } catch (error) {
      reply.code(error instanceof PortalHandoffError ? error.statusCode : 503);
      reply.type("text/html; charset=utf-8");
      return htmlCloseout({
        ok: false,
        title: "Marketplace launch blocked",
        detail:
          error instanceof PortalHandoffError
            ? "Portal could not authorize this Marketplace launch."
            : "Portal launch verification failed.",
      });
    }
  };

  app.get("/auth/launch", async (request, reply) => {
    const query = z
      .strictObject({
        ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        deploymentId: PortalIdentifierSchema,
      })
      .parse(request.query);
    return completePortalLaunch(query.ticket, query.deploymentId, reply);
  });

  app.post("/auth/launch", { bodyLimit: 2_048 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    if (
      !portalIssuerUrl ||
      headerValue(request, "origin") !== portalIssuerUrl ||
      headerValue(request, "authorization")
    ) {
      reply.code(403);
      reply.type("text/html; charset=utf-8");
      return htmlCloseout({
        ok: false,
        title: "Marketplace launch blocked",
        detail: "Portal launch origin verification failed.",
      });
    }
    const contentType = headerValue(request, "content-type");
    const parsed =
      contentType?.split(";", 1)[0]?.trim().toLowerCase() ===
      "application/x-www-form-urlencoded"
        ? PortalLaunchFormSchema.safeParse(request.body)
        : null;
    const deploymentId = portalConfiguration.deploymentId;
    if (!parsed?.success || !deploymentId) {
      reply.code(parsed?.success ? 503 : 401);
      reply.type("text/html; charset=utf-8");
      return htmlCloseout({
        ok: false,
        title: "Marketplace launch blocked",
        detail: parsed?.success
          ? "Marketplace Portal deployment identity is not configured."
          : "Portal launch ticket is invalid.",
      });
    }
    return completePortalLaunch(parsed.data.ticket, deploymentId, reply, {
      issueOperatorSession: true,
      secure: secureRequest(request),
    });
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "marketplace",
    status: "healthy",
    // disabled | connected | unavailable; never addresses, names or keys.
    tailnet: await tailnetHealth(environment),
    time: new Date().toISOString(),
  }));

  app.get("/api/portal/readiness", async (request, reply) => {
    const suppliedProof = headerValue(request, "x-tealbrick-instance-proof");
    if (request.headers.cookie || request.headers.origin || request.headers.authorization) {
      reply.code(403);
      return { ok: false, error: "portal_readiness_service_request_required" };
    }
    if (
      !suppliedProof ||
      !portalInstanceProof ||
      !marketplaceSecretMatches(suppliedProof, portalInstanceProof)
    ) {
      reply.code(401);
      return { ok: false, error: "portal_readiness_instance_auth_required" };
    }

    const publicOrigin = environment.MARKETPLACE_PUBLIC_ORIGIN?.trim();
    if (
      !portalIssuerUrl ||
      !portalConfiguration.deploymentId ||
      !portalConfiguration.portalOrgId ||
      !portalConfiguration.workspaceId ||
      !publicOrigin
    ) {
      reply.code(503);
      return { ok: false, error: "portal_readiness_identity_unconfigured" };
    }

    const base = {
      ok: true,
      schema: 2,
      product: "marketplace" as const,
      deploymentId: portalConfiguration.deploymentId,
      orgId: portalConfiguration.portalOrgId,
      workspaceId: portalConfiguration.workspaceId,
      productTenantId: organizationId,
      publicOrigin,
      portal: {
        configured: true,
        baseUrl: portalIssuerUrl,
        instanceProofHeader: "x-tealbrick-instance-proof" as const,
      },
      tenant: {
        configured: true,
        productTenantId: organizationId,
      },
      auth: {
        configured: true,
        instanceProofHeader: "x-tealbrick-instance-proof" as const,
      },
    };

    if (!rulesConfiguration) {
      return {
        ...base,
        rules: {
          configured: false,
          reachable: false,
          effect: null,
          detail: "scoped_rules_credential_not_configured",
        },
      };
    }
    if (!rulesConfiguration.internalAuthToken?.trim()) {
      reply.code(503);
      return { ok: false, error: "portal_readiness_rules_auth_unconfigured" };
    }

    let response: Response;
    try {
      response = await (options.providerFetch ?? fetch)(
        new URL(RULES_INTROSPECTION_PATH, rulesConfiguration.baseUrl),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${rulesConfiguration.internalAuthToken}`,
          },
        },
      );
    } catch {
      reply.code(503);
      return { ok: false, error: "portal_readiness_rules_unavailable" };
    }
    if (!response.ok) {
      reply.code(503);
      return { ok: false, error: "portal_readiness_rules_unavailable" };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      reply.code(503);
      return { ok: false, error: "portal_readiness_rules_response_invalid" };
    }
    let principal;
    try {
      principal = parseRulesReadinessPrincipal({
        response: payload,
        organizationId,
        expectedCompanyId: rulesConfiguration.companyId,
      });
    } catch {
      reply.code(503);
      return { ok: false, error: "portal_readiness_rules_principal_invalid" };
    }
    return {
      ...base,
      rules: {
        configured: true,
        reachable: true,
        probe: "principal" as const,
        effect: null,
        principal: { ready: true, principal },
      },
    };
  });

  type RulesConnectionStatus = "connected" | "not-connected" | "unavailable";
  let rulesStatusCache: { status: RulesConnectionStatus; expiresAt: number } | null = null;
  const probeRulesConnection = async (): Promise<RulesConnectionStatus> => {
    if (!options.rulesClient && !rulesConfiguration) return "not-connected";
    if (!rulesConfiguration) {
      // An injected Rules client without a probe configuration (embedded
      // hosts and tests) is treated as connected; decisions still fail closed.
      return options.rulesClient ? "connected" : "not-connected";
    }
    if (!options.rulesClient || !rulesConfiguration.internalAuthToken?.trim()) {
      return "unavailable";
    }
    if (rulesStatusCache && Date.now() < rulesStatusCache.expiresAt) {
      return rulesStatusCache.status;
    }
    let status: RulesConnectionStatus = "unavailable";
    try {
      const response = await (options.providerFetch ?? fetch)(
        new URL(RULES_INTROSPECTION_PATH, rulesConfiguration.baseUrl),
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${rulesConfiguration.internalAuthToken}`,
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) {
        parseRulesReadinessPrincipal({
          response: await response.json(),
          organizationId,
          expectedCompanyId: rulesConfiguration.companyId,
        });
        status = "connected";
      }
    } catch {
      status = "unavailable";
    }
    rulesStatusCache = { status, expiresAt: Date.now() + 15_000 };
    return status;
  };

  // Authenticated (operator session or service bearer) runtime health for the
  // browser status indicators. Returns states only, never configuration.
  app.get("/api/marketplace/health", async () => ({
    ok: true,
    program: "ok" as const,
    version: MARKETPLACE_VERSION,
    rules: await probeRulesConnection(),
    governance: governanceMode,
    tailnet: await tailnetHealth(environment),
    checkedAt: new Date().toISOString(),
  }));

  app.get("/api/marketplace/auth/session", async (request) => ({
    session: operatorSessions.status(request.headers.cookie),
  }));

  app.post("/api/marketplace/auth/session", async (request, reply) => {
    if (!allowedCorsOrigin(request.headers.origin, environment)) {
      reply.code(403);
      return { ok: false, error: "marketplace_origin_denied" };
    }
    try {
      const body = z.object({ accessToken: z.string().trim().min(1).max(2_048) }).parse(request.body ?? {});
      const exchanged = operatorSessions.exchange(body.accessToken, request.ip);
      reply.header("set-cookie", operatorSessions.sessionCookie(exchanged.token, secureRequest(request)));
      return { ok: true, session: exchanged.status };
    } catch (error) {
      if (error instanceof MarketplaceAuthenticationError) {
        reply.code(error.statusCode);
        return { ok: false, error: error.code, detail: error.message };
      }
      throw error;
    }
  });

  app.delete("/api/marketplace/auth/session", async (request, reply) => {
    const operator = operatorSessions.authenticate(request.headers.cookie);
    if (!operator) {
      reply.code(401);
      return { ok: false, error: "marketplace_unauthorized" };
    }
    if (!allowedCorsOrigin(request.headers.origin, environment)) {
      reply.code(403);
      return { ok: false, error: "marketplace_origin_denied" };
    }
    if (!operatorSessions.csrfMatches(request.headers.cookie, request.headers["x-csrf-token"])) {
      reply.code(403);
      return { ok: false, error: "marketplace_csrf_denied" };
    }
    operatorSessions.revoke(request.headers.cookie);
    reply.header("set-cookie", operatorSessions.clearCookie(secureRequest(request)));
    return { ok: true };
  });

  app.get("/api/status", async (request, reply) => {
    if (!requireService(request, reply)) {
      return { ok: false, error: "marketplace_service_bearer_required" };
    }
    return {
    version: MARKETPLACE_VERSION,
    ok: true,
    service: "marketplace",
    database: {
      kind: "sqlite",
      tables: options.store.listTables(),
      path: options.store.describeRuntime().databasePath,
    },
    debug: {
      enabled: options.debug ?? compatDebugEnabled(),
      logPath: options.logPath ?? options.store.describeRuntime().logPath,
    },
    providers: await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    ),
    };
  });

  app.get("/api/settings/providers/composio", async (request, reply) => {
    if (!requireOperator(request, reply)) return { ok: false, error: "marketplace_operator_required" };
    return {
      ...providerSettings.safeView(),
      provider: readProviderHealth(providerEnvironment()).composio,
    };
  });

  app.put("/api/settings/providers/composio", async (request, reply) => {
    const principal = requireOperator(request, reply);
    if (!principal) return { ok: false, error: "marketplace_operator_required" };
    const input = ComposioProviderSettingsRequestSchema.parse(request.body);
    const before = providerSettings.safeView();
    let saved: ReturnType<typeof providerSettings.safeView>;
    try {
      saved = await providerSettings.update(input.settings);
    } catch (error) {
      if (error instanceof ProviderSettingsError) {
        reply.code(error.statusCode);
        return { ok: false, error: error.code };
      }
      throw error;
    }
    options.store.recordAudit({
      workspaceSlug: principal.organizationId,
      pluginId: "composio",
      eventType: "marketplace.provider.settings.updated",
      actorId: principal.id,
      metadata: {
        provider: "composio",
        keyReplaced: Boolean(input.settings.composioApiKey),
        keyFingerprint: saved.status.composioApiKey.fingerprint,
        baseUrlChanged: before.values.composioBaseUrl !== saved.values.composioBaseUrl,
        defaultUserChanged: before.values.composioDefaultUserId !== saved.values.composioDefaultUserId,
        connectedAccountChanged:
          before.values.composioDefaultConnectedAccountId !== saved.values.composioDefaultConnectedAccountId,
      },
    });
    return {
      ...saved,
      provider: readProviderHealth(providerEnvironment()).composio,
    };
  });

  app.delete("/api/settings/providers/composio/key", async (request, reply) => {
    const principal = requireOperator(request, reply);
    if (!principal) return { ok: false, error: "marketplace_operator_required" };
    const previousFingerprint = providerSettings.safeView().status.composioApiKey.fingerprint;
    let result: Awaited<ReturnType<typeof providerSettings.removeApiKey>>;
    try {
      result = await providerSettings.removeApiKey();
    } catch (error) {
      if (error instanceof ProviderSettingsError) {
        reply.code(error.statusCode);
        return { ok: false, error: error.code };
      }
      throw error;
    }
    if (result.removed) {
      composioCatalogSyncByWorkspace.clear();
      options.store.recordAudit({
        workspaceSlug: principal.organizationId,
        pluginId: "composio",
        eventType: "marketplace.provider.key.removed",
        actorId: principal.id,
        metadata: { provider: "composio", keyFingerprint: previousFingerprint },
      });
    }
    return {
      ...result.view,
      removed: result.removed,
      provider: readProviderHealth(providerEnvironment()).composio,
    };
  });

  app.post("/api/settings/providers/composio/test", { bodyLimit: 4_096 }, async (request, reply) => {
    const principal = requireOperator(request, reply);
    if (!principal) return { ok: false, error: "marketplace_operator_required" };
    const body = z
      .object({ composioApiKey: z.string().trim().max(512).optional() })
      .parse(request.body ?? {});
    const candidate = body.composioApiKey || providerSettings.activeApiKey();
    if (!candidate) {
      reply.code(400);
      return { ok: false, error: "composio_key_missing" };
    }
    try {
      assertComposioApiKeyFormat(candidate);
    } catch (error) {
      if (error instanceof ProviderSettingsError) {
        reply.code(error.statusCode);
        return { ok: false, error: error.code };
      }
      throw error;
    }
    const baseUrl = providerSettings.safeView().values.composioBaseUrl;
    if (!allowedComposioOrigin(baseUrl, environment)) {
      reply.code(400);
      return { ok: false, error: "composio_base_url_not_allowed" };
    }
    const probeUrl = new URL(`${baseUrl.replace(/\/+$/u, "")}/connected_accounts`);
    probeUrl.searchParams.set("limit", "1");
    let outcome: "valid" | "rejected" | "unreachable";
    let providerStatus: number | null = null;
    try {
      const response = await (options.providerFetch ?? fetch)(probeUrl, {
        method: "GET",
        headers: { accept: "application/json", "x-api-key": candidate },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
      });
      providerStatus = response.status;
      outcome = response.ok
        ? "valid"
        : response.status === 401 || response.status === 403
          ? "rejected"
          : "unreachable";
    } catch {
      outcome = "unreachable";
    }
    options.store.recordAudit({
      workspaceSlug: principal.organizationId,
      pluginId: "composio",
      eventType: "marketplace.provider.key.tested",
      actorId: principal.id,
      metadata: {
        provider: "composio",
        outcome,
        providerStatus,
        draftKey: Boolean(body.composioApiKey),
        keyFingerprint: composioKeyFingerprint(candidate),
      },
    });
    if (outcome === "rejected") {
      reply.code(422);
      return { ok: false, error: "composio_key_rejected" };
    }
    if (outcome === "unreachable") {
      reply.code(502);
      return { ok: false, error: "composio_unreachable" };
    }
    return { ok: true, status: "valid" as const, checkedAt: new Date().toISOString() };
  });

  // ---------------------------------------------------------------------
  // Operator custom MCP connectors (remote streamable-http / SSE only).
  // Workspace comes from the operator principal; every mutation is
  // Rules-gated as connector.admin; secrets never leave the server.
  // ---------------------------------------------------------------------
  const customMcpOperator = (request: FastifyRequest, reply: FastifyReply) => {
    const principal = requireOperator(request, reply);
    if (!principal) {
      return { error: { ok: false, error: "marketplace_operator_required" } } as const;
    }
    for (const value of [request.query, request.body]) {
      const supplied = recordValue(value)?.workspaceSlug;
      if (supplied !== undefined && supplied !== principal.organizationId) {
        reply.code(403);
        return { error: { ok: false, error: "workspace_mismatch" } } as const;
      }
    }
    return { principal } as const;
  };
  const ownedCustomMcp = (pluginId: string, workspaceSlug: string) => {
    const listing = options.store.getListingForWorkspace(pluginId, workspaceSlug);
    return listing && listingIsWorkspaceCustomMcp(listing, workspaceSlug)
      ? listing
      : null;
  };
  const customMcpInputFailure = (reply: FastifyReply, error: unknown) => {
    if (error instanceof CustomMcpInputError) {
      reply.code(400);
      return { ok: false, error: error.code, ...(error.field ? { field: error.field } : {}) };
    }
    if (error instanceof McpUrlPolicyError) {
      reply.code(400);
      return { ok: false, error: error.code, reason: error.reason };
    }
    throw error;
  };
  const secretAuditView = (workspaceSlug: string, pluginId: string) =>
    options.store
      .listConnectorSecrets({ workspaceSlug, pluginId })
      .map((secret) => ({ name: secret.name, fingerprint: secret.fingerprint }));

  app.get("/api/marketplace/connectors/custom", async (request, reply) => {
    const gate = customMcpOperator(request, reply);
    if ("error" in gate) return gate.error;
    const workspaceSlug = gate.principal.organizationId;
    return {
      ok: true,
      workspaceSlug,
      secretStoreAvailable: options.store.connectorSecretStoreAvailable(),
      items: options.store
        .listOwnedListings(workspaceSlug)
        .filter((listing) => listingIsWorkspaceCustomMcp(listing, workspaceSlug))
        .map((listing) => customConnectorView(options.store, workspaceSlug, listing)),
    };
  });

  app.post("/api/marketplace/connectors/custom", async (request, reply) => {
    const gate = customMcpOperator(request, reply);
    if ("error" in gate) return gate.error;
    const { principal } = gate;
    const workspaceSlug = principal.organizationId;
    if (requestsStdioTransport(request.body)) {
      reply.code(400);
      return { ok: false, error: "custom_mcp_transport_not_allowed" };
    }
    const input = CustomMcpCreateSchema.parse(request.body);
    let headers: Record<string, string>;
    let secretHeaders: Map<string, string | null>;
    let url: URL;
    try {
      headers = normalizePlainHeaders(input.headers);
      secretHeaders = normalizeSecretHeaderChanges(input.secretHeaders);
      assertHeaderSets({ plainNames: Object.keys(headers), secretNames: secretHeaders.keys() });
      url = checkMcpUrlSyntax(input.url, environment).url;
    } catch (error) {
      return customMcpInputFailure(reply, error);
    }
    if (secretHeaders.size > 0 && !options.store.connectorSecretStoreAvailable()) {
      reply.code(503);
      return { ok: false, error: "connector_secret_store_unavailable" };
    }
    const pluginId = customMcpPluginId({
      workspaceSlug,
      slug: input.slug,
      displayName: input.displayName,
    });
    if (options.store.getListing(pluginId)) {
      reply.code(409);
      return { ok: false, error: "custom_mcp_already_exists", pluginId };
    }
    const rules = await enforceRules({
      reply,
      workspaceSlug,
      operation: "custom-mcp.create",
      capability: "connector.admin",
      pluginId,
      actorId: principal.id,
      payload: {
        transport: input.transport,
        origin: url.origin,
        headerNames: Object.keys(headers),
        secretHeaderNames: [...secretHeaders.keys()],
      },
      actor: principalActor(request),
        ...governed,
    });
    if (!("effect" in rules)) return rules;
    const manifest: CustomMcpManifest = {
      operatorManaged: true,
      transport: input.transport,
      url: url.toString(),
      headers,
      tools: [],
      lastRefresh: null,
    };
    const listing = customMcpListing({
      pluginId,
      workspaceSlug,
      displayName: input.displayName,
      description: input.description,
      manifest,
    });
    options.store.upsertListing(listing);
    for (const [name, value] of secretHeaders) {
      if (value !== null) {
        options.store.putConnectorSecret({ workspaceSlug, pluginId, name, value });
      }
    }
    options.store.recordAudit({
      workspaceSlug,
      pluginId,
      eventType: "marketplace.custom_mcp.created",
      actorId: principal.id,
      rulesDecisionId: rules.decisionId,
      metadata: {
        transport: input.transport,
        origin: url.origin,
        headerNames: Object.keys(headers),
        secretHeaders: secretAuditView(workspaceSlug, pluginId),
      },
    });
    reply.code(201);
    return {
      ok: true,
      connector: customConnectorView(options.store, workspaceSlug, listing),
    };
  });

  app.patch("/api/marketplace/connectors/custom/:pluginId", async (request, reply) => {
    const gate = customMcpOperator(request, reply);
    if ("error" in gate) return gate.error;
    const { principal } = gate;
    const workspaceSlug = principal.organizationId;
    const { pluginId } = request.params as { pluginId: string };
    const current = ownedCustomMcp(pluginId, workspaceSlug);
    if (!current) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    if (requestsStdioTransport(request.body)) {
      reply.code(400);
      return { ok: false, error: "custom_mcp_transport_not_allowed" };
    }
    const input = CustomMcpPatchSchema.parse(request.body);
    const manifest = customMcpManifest(current);
    let headers: Record<string, string>;
    let secretChanges: Map<string, string | null>;
    let url: URL;
    try {
      headers = input.headers === undefined ? manifest.headers : normalizePlainHeaders(input.headers);
      secretChanges = normalizeSecretHeaderChanges(input.secretHeaders);
      const secretNames = new Set(
        options.store
          .listConnectorSecrets({ workspaceSlug, pluginId })
          .map((secret) => secret.name),
      );
      for (const [name, value] of secretChanges) {
        if (value === null) secretNames.delete(name);
        else secretNames.add(name);
      }
      assertHeaderSets({ plainNames: Object.keys(headers), secretNames });
      url = checkMcpUrlSyntax(input.url ?? manifest.url, environment).url;
    } catch (error) {
      return customMcpInputFailure(reply, error);
    }
    // Secrets stay with the origin they were entered for: moving the server
    // to another origin requires replacing (or removing) every secret header.
    if (new URL(manifest.url).origin !== url.origin) {
      const kept = options.store
        .listConnectorSecrets({ workspaceSlug, pluginId })
        .map((secret) => secret.name)
        .filter((name) => !secretChanges.has(name));
      if (kept.length) {
        reply.code(400);
        return { ok: false, error: "custom_mcp_secrets_required_for_new_origin", secretHeaders: kept };
      }
    }
    const writesSecrets = [...secretChanges.values()].some((value) => value !== null);
    if (writesSecrets && !options.store.connectorSecretStoreAvailable()) {
      reply.code(503);
      return { ok: false, error: "connector_secret_store_unavailable" };
    }
    const transport = input.transport ?? manifest.transport;
    const endpointChanged = url.toString() !== manifest.url || transport !== manifest.transport;
    const rules = await enforceRules({
      reply,
      workspaceSlug,
      operation: "custom-mcp.update",
      capability: "connector.admin",
      pluginId,
      actorId: principal.id,
      payload: {
        transport,
        origin: url.origin,
        endpointChanged,
        headerNames: Object.keys(headers),
        secretHeaderChanges: [...secretChanges].map(([name, value]) => ({
          name,
          change: value === null ? "remove" : "set",
        })),
      },
      actor: principalActor(request),
        ...governed,
    });
    if (!("effect" in rules)) return rules;
    const listing = customMcpListing({
      pluginId,
      workspaceSlug,
      displayName: input.displayName ?? current.displayName,
      description: input.description ?? current.description,
      version: typeof current.manifest.version === "string" ? current.manifest.version : undefined,
      createdAt: current.createdAt,
      manifest: {
        ...manifest,
        transport,
        url: url.toString(),
        headers,
        ...(endpointChanged ? { tools: [], lastRefresh: null } : {}),
      },
    });
    options.store.upsertListing(listing);
    for (const [name, value] of secretChanges) {
      if (value === null) {
        options.store.deleteConnectorSecret({ workspaceSlug, pluginId, name });
      } else {
        options.store.putConnectorSecret({ workspaceSlug, pluginId, name, value });
      }
    }
    if (endpointChanged && options.store.getConnection(workspaceSlug, pluginId)) {
      options.store.upsertConnection({
        workspaceSlug,
        pluginId,
        provider: listing.provider,
        backend: "mcp",
        state: "disconnected",
        detail: "Server address changed. Refresh tools to reconnect.",
        metadata: { reason: "endpoint_changed" },
      });
    }
    options.store.recordAudit({
      workspaceSlug,
      pluginId,
      eventType: "marketplace.custom_mcp.updated",
      actorId: principal.id,
      rulesDecisionId: rules.decisionId,
      metadata: {
        transport,
        origin: url.origin,
        endpointChanged,
        headerNames: Object.keys(headers),
        removedSecretHeaders: [...secretChanges].filter(([, value]) => value === null).map(([name]) => name),
        secretHeaders: secretAuditView(workspaceSlug, pluginId),
      },
    });
    return {
      ok: true,
      connector: customConnectorView(options.store, workspaceSlug, listing),
    };
  });

  app.delete("/api/marketplace/connectors/custom/:pluginId", async (request, reply) => {
    const gate = customMcpOperator(request, reply);
    if ("error" in gate) return gate.error;
    const { principal } = gate;
    const workspaceSlug = principal.organizationId;
    const { pluginId } = request.params as { pluginId: string };
    const listing = ownedCustomMcp(pluginId, workspaceSlug);
    if (!listing) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    const rules = await enforceRules({
      reply,
      workspaceSlug,
      operation: "custom-mcp.delete",
      capability: "connector.admin",
      pluginId,
      actorId: principal.id,
      payload: {},
      actor: principalActor(request),
        ...governed,
    });
    if (!("effect" in rules)) return rules;
    const secretHeaders = secretAuditView(workspaceSlug, pluginId);
    const brokerGrantsRevoked = options.store.revokeBrokerGrantsForPlugin({ workspaceSlug, pluginId });
    const agentAccess = options.store.revokeAgentAccessForPlugin({ workspaceSlug, pluginId });
    options.store.deleteListing(pluginId);
    options.store.recordAudit({
      workspaceSlug,
      pluginId,
      eventType: "marketplace.custom_mcp.deleted",
      actorId: principal.id,
      rulesDecisionId: rules.decisionId,
      metadata: {
        secretHeaders,
        brokerGrantsRevoked,
        agentGrantsRevoked: agentAccess.grants,
        agentConsentsRevoked: agentAccess.consents,
      },
    });
    return { ok: true, pluginId, deleted: true };
  });

  /**
   * Connect to a custom MCP server, load its tools, and publish them. Shared
   * by the custom connector refresh route and Company Box `mcp` entries
   * (which apply the entry's exclusions, risk patterns and no 200-tool cap).
   */
  const refreshCustomMcpConnector = async (input: {
    reply: FastifyReply;
    current: MarketplaceListing;
    workspaceSlug: string;
    actorId: string;
    rulesDecisionId: string | null;
  }) => {
    const { reply, current, workspaceSlug } = input;
    const pluginId = current.pluginId;
    const companyBoxEntry = companyBoxEntryForListing(companyBox, current, workspaceSlug);
    const companyBoxMcp = companyBoxEntry?.kind === "mcp" ? companyBoxEntry : null;
    let connection: ReturnType<typeof customMcpConnection>;
    try {
      connection = customMcpConnection(current, workspaceSlug);
    } catch (error) {
      if (error instanceof ConnectorSecretStoreUnavailableError) {
        reply.code(503);
        return { ok: false, error: "connector_secret_store_unavailable" };
      }
      throw error;
    }
    const requested = customMcpManifest(current);
    const at = new Date().toISOString();
    let errorCode: string | null = null;
    let remoteTools: Awaited<ReturnType<typeof listMcpTools>> = [];
    let liveTools: Awaited<ReturnType<typeof listMcpTools>> = [];
    try {
      // Company Box entries expose the whole toolkit: page through every tool
      // (bounded by the client's page limit) instead of the 200-tool default.
      remoteTools = await listMcpTools(connection, companyBoxMcp ? 10_000 : MCP_MAX_TOOLS);
      liveTools = remoteTools;
      if (companyBoxMcp) {
        // Only tools in the pinned snapshot are exposed; a tool the server
        // added since stays unusable (reported as notInSnapshot) until the
        // entry is re-pinned and reviewed.
        remoteTools = remoteTools.filter(
          (tool) =>
            !companyBoxMcp.excludedToolNames.has(tool.name) &&
            companyBoxMcp.tools.some((pinned) => pinned.name === tool.name),
        );
      }
    } catch (error) {
      logCustomMcpFailure({ event: "marketplace.custom_mcp.refresh_failed", pluginId, workspaceSlug, error });
      errorCode = error instanceof McpRemoteError ? error.code : "mcp_protocol_error";
    }
    // The connector may have been edited or deleted while the server was
    // being contacted: never resurrect it or overwrite a newer address.
    const latest = ownedCustomMcp(pluginId, workspaceSlug);
    if (!latest) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    const manifest = customMcpManifest(latest);
    if (manifest.url !== requested.url || manifest.transport !== requested.transport) {
      reply.code(409);
      return { ok: false, error: "custom_mcp_changed_during_refresh" };
    }
    const rebuild = (next: Partial<CustomMcpManifest>) =>
      customMcpListing({
        pluginId,
        workspaceSlug,
        displayName: latest.displayName,
        description: latest.description,
        version: typeof latest.manifest.version === "string" ? latest.manifest.version : undefined,
        createdAt: latest.createdAt,
        manifest: { ...manifest, ...next },
      });
    let listing: MarketplaceListing;
    if (errorCode === null) {
      try {
        const tools = toolRecordsFromRemote(latest.provider, remoteTools).map((tool) =>
          companyBoxMcp
            ? {
                ...tool,
                capability: companyBoxMcpToolRisk(
                  companyBoxMcp.entry,
                  tool,
                  tool.action.slice(latest.provider.length + 1),
                ).capability,
              }
            : tool,
        );
        listing = rebuild({ tools, lastRefresh: { at, ok: true, errorCode: null } });
      } catch (error) {
        logCustomMcpFailure({ event: "marketplace.custom_mcp.refresh_failed", pluginId, workspaceSlug, error });
        errorCode = "mcp_protocol_error";
        listing = rebuild({ lastRefresh: { at, ok: false, errorCode } });
      }
    } else {
      listing = rebuild({ lastRefresh: { at, ok: false, errorCode } });
    }
    options.store.upsertListing(listing);
    if (errorCode === null) {
      options.store.upsertConnection({
        workspaceSlug,
        pluginId,
        provider: listing.provider,
        backend: "mcp",
        state: "connected",
        detail: `Connected. ${listing.actions.length} tool${listing.actions.length === 1 ? "" : "s"} available.`,
        metadata: {
          lastRefreshAt: at,
          toolCount: listing.actions.length,
          ...(companyBoxMcp
            ? {
                companyBox: {
                  entryId: companyBoxMcp.entry.id,
                  snapshotTools: companyBoxMcp.tools.length,
                  // Drift between the pinned snapshot and the live server.
                  missingFromServer: companyBoxMcp.tools
                    .filter((tool) => !remoteTools.some((remote) => remote.name === tool.name))
                    .map((tool) => tool.name)
                    .slice(0, 50),
                  notInSnapshot: liveTools
                    .filter(
                      (remote) =>
                        !companyBoxMcp.tools.some((tool) => tool.name === remote.name) &&
                        !companyBoxMcp.excludedToolNames.has(remote.name),
                    )
                    .map((remote) => remote.name)
                    .slice(0, 50),
                },
              }
            : {}),
        },
      });
      if (options.store.getInstall(workspaceSlug, pluginId)?.lifecycle === "installed") {
        bindCustomMcpForWorkspace(options.store, workspaceSlug, listing);
      }
    } else {
      // Keep previously discovered tools, but stop exposing them until a
      // refresh succeeds again.
      options.store.upsertConnection({
        workspaceSlug,
        pluginId,
        provider: listing.provider,
        backend: "mcp",
        state: "blocked",
        detail: "Marketplace couldn't load tools from this server.",
        metadata: { lastRefreshAt: at, errorCode },
      });
    }
    options.store.recordAudit({
      workspaceSlug,
      pluginId,
      eventType: "marketplace.custom_mcp.refreshed",
      actorId: input.actorId,
      rulesDecisionId: input.rulesDecisionId,
      metadata: {
        ok: errorCode === null,
        errorCode,
        toolCount: listing.actions.length,
        secretHeaders: secretAuditView(workspaceSlug, pluginId),
      },
    });
    const view = customConnectorView(options.store, workspaceSlug, listing);
    if (errorCode) {
      reply.code(errorCode === "custom_mcp_url_not_allowed" ? 400 : 502);
      return { ok: false, error: errorCode, connector: view };
    }
    return { ok: true, connector: view };
  };

  app.post("/api/marketplace/connectors/custom/:pluginId/refresh", async (request, reply) => {
    const gate = customMcpOperator(request, reply);
    if ("error" in gate) return gate.error;
    const { principal } = gate;
    const workspaceSlug = principal.organizationId;
    const { pluginId } = request.params as { pluginId: string };
    const current = ownedCustomMcp(pluginId, workspaceSlug);
    if (!current) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    const rules = await enforceRules({
      reply,
      workspaceSlug,
      operation: "custom-mcp.refresh",
      capability: "connector.admin",
      pluginId,
      actorId: principal.id,
      payload: { transport: customMcpManifest(current).transport },
      actor: principalActor(request),
        ...governed,
    });
    if (!("effect" in rules)) return rules;
    return refreshCustomMcpConnector({
      reply,
      current,
      workspaceSlug,
      actorId: principal.id,
      rulesDecisionId: rules.decisionId ?? null,
    });
  });

  registerCompanyBoxRoutes(app, {
    store: options.store,
    catalog: companyBox,
    environment,
    operator: customMcpOperator,
    govern: async (input) => {
      const rules = await enforceRules({
        reply: input.reply,
        workspaceSlug: input.workspaceSlug,
        operation: input.operation,
        capability: "connector.admin",
        pluginId: input.pluginId,
        actorId: input.actorId,
        payload: input.payload,
        actor: principalActor(input.request),
        ...governed,
      });
      return "effect" in rules
        ? { ok: true as const, decisionId: rules.decisionId ?? null }
        : { ok: false as const, response: rules };
    },
    callOperation: callCompanyBoxOperation,
    refreshMcp: refreshCustomMcpConnector,
  });

  // Company Box approvals: outward calls held for the workspace owner.
  const ownerApprovalView = (approval: CompanyBoxApproval) => {
    const listing = options.store.getListingForWorkspace(approval.pluginId, approval.workspaceSlug);
    const entry = listing ? companyBoxEntryForListing(companyBox, listing, approval.workspaceSlug) : null;
    const operation = entry?.kind === "openapi" ? entry.byKey.get(approval.actionKey) : null;
    const tool = listing && !operation ? customMcpToolForAction(listing, approval.actionKey) : null;
    return {
      id: approval.id,
      pluginId: approval.pluginId,
      app: listing?.displayName ?? approval.pluginId,
      actionKey: approval.actionKey,
      operation: operation
        ? { title: operation.title, method: operation.method.toUpperCase(), path: operation.path }
        : { title: tool?.title ?? tool?.name ?? approval.actionKey, method: null, path: null },
      capability: approval.capability,
      agentId: approval.agentId,
      argumentsPreview: approval.argumentsPreview,
      state: approval.state,
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
      decidedAt: approval.decidedAt,
      decidedBy: approval.decidedBy,
      error: approval.error,
      ...(approval.state === "succeeded" ? { result: approval.result } : {}),
    };
  };
  const ownedApproval = (request: FastifyRequest, reply: FastifyReply) => {
    const gate = customMcpOperator(request, reply);
    if ("error" in gate) return { response: gate.error } as const;
    const { approvalId } = request.params as { approvalId: string };
    const approval = options.store.getCompanyBoxApproval(approvalId);
    if (!approval || approval.workspaceSlug !== gate.principal.organizationId) {
      reply.code(404);
      return { response: { ok: false, error: "approval_not_found" } } as const;
    }
    return { principal: gate.principal, approval } as const;
  };
  const notPending = (reply: FastifyReply, approvalId: string) => {
    const current = options.store.getCompanyBoxApproval(approvalId)!;
    reply.code(409);
    return {
      ok: false,
      error: current.state === "expired" ? "approval_expired" : "approval_not_pending",
      approval: ownerApprovalView(current),
    };
  };

  app.get("/api/marketplace/company-box/approvals", async (request, reply) => {
    const gate = customMcpOperator(request, reply);
    if ("error" in gate) return gate.error;
    const query = z
      .object({
        state: z.enum(["pending", "executing", "succeeded", "failed", "denied", "expired"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        workspaceSlug: z.string().optional(),
        actorId: z.string().optional(),
      })
      .parse(request.query);
    const workspaceSlug = gate.principal.organizationId;
    return {
      ok: true,
      workspaceSlug,
      pendingCount: options.store.listCompanyBoxApprovals({ workspaceSlug, state: "pending", limit: 500 }).length,
      approvals: options.store
        .listCompanyBoxApprovals({ workspaceSlug, state: query.state, limit: query.limit })
        .map(ownerApprovalView),
    };
  });

  /** Owner-only: the full stored arguments (≤ 32 KB) for review before approving. */
  app.get("/api/marketplace/company-box/approvals/:approvalId", async (request, reply) => {
    const owned = ownedApproval(request, reply);
    if ("response" in owned) return owned.response;
    return { ok: true, approval: ownerApprovalView(owned.approval), arguments: owned.approval.arguments };
  });

  app.post("/api/marketplace/company-box/approvals/:approvalId/approve", async (request, reply) => {
    const owned = ownedApproval(request, reply);
    if ("response" in owned) return owned.response;
    const { principal, approval } = owned;
    // Exactly once: only the request that moves it out of `pending` runs it.
    const claimed = options.store.decideCompanyBoxApproval({
      id: approval.id,
      workspaceSlug: principal.organizationId,
      decision: "approve",
      decidedBy: principal.id,
    });
    if (!claimed) return notPending(reply, approval.id);
    const finished = await runApprovedCompanyBoxCall(claimed, request, reply, principal.id);
    reply.code(200);
    options.store.recordAudit({
      workspaceSlug: finished.workspaceSlug,
      pluginId: finished.pluginId,
      eventType: "marketplace.company_box.approval.approved",
      actorId: principal.id,
      metadata: {
        approvalId: finished.id,
        actionKey: finished.actionKey,
        agentId: finished.agentId,
        outcome: finished.state,
        ...(finished.error ? { error: finished.error } : {}),
      },
    });
    return { ok: finished.state === "succeeded", approval: ownerApprovalView(finished) };
  });

  app.post("/api/marketplace/company-box/approvals/:approvalId/deny", async (request, reply) => {
    const owned = ownedApproval(request, reply);
    if ("response" in owned) return owned.response;
    const { principal, approval } = owned;
    const denied = options.store.decideCompanyBoxApproval({
      id: approval.id,
      workspaceSlug: principal.organizationId,
      decision: "deny",
      decidedBy: principal.id,
    });
    if (!denied) return notPending(reply, approval.id);
    options.store.recordAudit({
      workspaceSlug: denied.workspaceSlug,
      pluginId: denied.pluginId,
      eventType: "marketplace.company_box.approval.denied",
      actorId: principal.id,
      metadata: { approvalId: denied.id, actionKey: denied.actionKey, agentId: denied.agentId },
    });
    return { ok: true, approval: ownerApprovalView(denied) };
  });

  const capabilityProjectionHandler = async (request: { headers: Record<string, unknown>; query: unknown }, reply: FastifyReply) => {
    const authError = requireHubBearerAuth({
      request,
      reply,
      expectedToken: options.internalAuthToken,
    });
    if (authError) return authError;
    const query = HubAuthQuerySchema.parse(request.query);
    try {
      await ensureComposioCatalog(query.workspaceSlug);
      const baseProjection = marketplaceCapabilitiesHostProjection({
        store: options.store,
        workspaceSlug: query.workspaceSlug,
      });
      const projection = await projectExtensionSettings({
        microappsRoot: options.microappsRoot,
        baseProjection: baseProjection as unknown as CapabilitiesHostProjection,
      });
      return {
        ok: true,
        workspaceSlug: query.workspaceSlug,
        ...projection,
        dependencies: {
          registryAuthority: "doppelganger-registry",
          recordMode: "gateway-projected-records",
          lifecycleAuthority: "marketplace",
          directHermesRole: "underlying-adapters-only",
          normalModeDirectHermesControls: false,
          auth: {
            owner: "hdda-host-sdk",
            scope: "auth",
            status: "dependency",
          },
        },
      };
    } catch (error) {
      reply.code(409);
      return {
        ok: false,
        error: "capabilities_ownership_conflict",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };

  app.get("/api/marketplace/hub/records", capabilityProjectionHandler);
  app.get("/api/plugins/marketplace-hub/records", capabilityProjectionHandler);

  app.get("/api/marketplace/hub/plugins/:pluginId", async (request, reply) => {
    const authError = requireHubBearerAuth({
      request,
      reply,
      expectedToken: options.internalAuthToken,
    });
    if (authError) return authError;
    const query = HubAuthQuerySchema.parse(request.query);
    const { pluginId } = request.params as { pluginId: string };
    const listing = options.store.getListingForWorkspace(
      pluginId,
      query.workspaceSlug,
    );
    if (!listing) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    return {
      ok: true,
      record: marketplacePluginRecord({
        store: options.store,
        workspaceSlug: query.workspaceSlug,
        listing,
      }),
    };
  });

  app.post("/api/marketplace/hub/plugins/mcp", async (request, reply) => {
    const authError = requireHubBearerAuth({
      request,
      reply,
      expectedToken: options.internalAuthToken,
    });
    if (authError) return authError;
    const input = McpPluginSchema.parse(request.body);
    if (options.store.getListing(input.pluginId)) {
      reply.code(409);
      return { ok: false, error: "plugin_already_exists" };
    }
    const rules = await enforceRules({
      reply,
      workspaceSlug: input.workspaceSlug,
      operation: "hub.mcp.create",
      capability: "connector.admin",
      pluginId: input.pluginId,
      actorId: input.actorId,
      payload: { transport: input.transport },
      actor: principalActor(request),
        ...governed,
    });
    if (!("effect" in rules)) return rules;
    const listing = mcpListingFromInput(input);
    options.store.upsertListing(listing);
    options.store.recordAudit({
      workspaceSlug: input.workspaceSlug,
      pluginId: input.pluginId,
      eventType: "marketplace.plugin.created",
      actorId: input.actorId,
      rulesDecisionId: rules.decisionId,
      metadata: { kind: "mcp", transport: input.transport },
    });
    reply.code(201);
    return {
      ok: true,
      record: marketplacePluginRecord({
        store: options.store,
        workspaceSlug: input.workspaceSlug,
        listing,
      }),
    };
  });

  app.patch(
    "/api/marketplace/hub/plugins/:pluginId",
    async (request, reply) => {
      const authError = requireHubBearerAuth({
        request,
        reply,
        expectedToken: options.internalAuthToken,
      });
      if (authError) return authError;
      const query = HubAuthQuerySchema.parse(request.query);
      const { pluginId } = request.params as { pluginId: string };
      const current = options.store.getListingForWorkspace(
        pluginId,
        query.workspaceSlug,
      );
      if (!current) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (listingIsOperatorCustomMcp(current)) {
        reply.code(409);
        return { ok: false, error: "plugin_managed_by_operator" };
      }
      if (!listingIsCustomMcp(current)) {
        reply.code(409);
        return { ok: false, error: "plugin_not_custom_mcp" };
      }
      const requestBody = recordValue(request.body);
      const patch = McpPluginUpdateSchema.parse(
        requestBody?.settings ?? request.body,
      );
      const currentRecord = marketplacePluginRecord({
        store: options.store,
        workspaceSlug: query.workspaceSlug,
        listing: current,
      });
      if (currentRecord.adapter.type !== "mcp") {
        reply.code(409);
        return { ok: false, error: "plugin_not_mcp" };
      }
      const merged = McpPluginSchema.parse({
        workspaceSlug: query.workspaceSlug,
        actorId: "operator",
        pluginId,
        displayName: current.displayName,
        description: current.description,
        version: currentRecord.version,
        capabilities: current.capabilities,
        actions: current.actions,
        contributions: currentRecord.contributions,
        ...marketplaceMcpAdapterConfig(current, true),
        ...patch,
      });
      const rules = await enforceRules({
        reply,
        workspaceSlug: query.workspaceSlug,
        operation: "hub.mcp.update",
        capability: "connector.admin",
        pluginId,
        actorId: "operator",
        payload: { transport: merged.transport },
        actor: principalActor(request),
        ...governed,
      });
      if (!("effect" in rules)) return rules;
      const listing = mcpListingFromInput(merged, current);
      options.store.upsertListing(listing);
      const connection = options.store.getConnection(
        query.workspaceSlug,
        pluginId,
      );
      if (connection) {
        options.store.upsertConnection({
          workspaceSlug: query.workspaceSlug,
          pluginId,
          provider: connection.provider,
          backend: connection.backend,
          state: "disconnected",
          detail: "MCP adapter configuration changed; reload is required.",
          metadata: connection.metadata,
        });
      }
      options.store.recordAudit({
        workspaceSlug: query.workspaceSlug,
        pluginId,
        eventType: "marketplace.plugin.updated",
        actorId: "operator",
        rulesDecisionId: rules.decisionId,
        metadata: { kind: "mcp", transport: merged.transport },
      });
      return {
        ok: true,
        record: marketplacePluginRecord({
          store: options.store,
          workspaceSlug: query.workspaceSlug,
          listing,
        }),
      };
    },
  );

  app.delete(
    "/api/marketplace/hub/plugins/:pluginId",
    async (request, reply) => {
      const authError = requireHubBearerAuth({
        request,
        reply,
        expectedToken: options.internalAuthToken,
      });
      if (authError) return authError;
      const query = HubAuthQuerySchema.parse(request.query);
      const { pluginId } = request.params as { pluginId: string };
      const listing = options.store.getListingForWorkspace(
        pluginId,
        query.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (listingIsOperatorCustomMcp(listing)) {
        reply.code(409);
        return { ok: false, error: "plugin_managed_by_operator" };
      }
      if (!listingIsCustomMcp(listing)) {
        reply.code(409);
        return { ok: false, error: "plugin_not_custom_mcp" };
      }
      if (listingIsRequired(listing)) {
        reply.code(409);
        return { ok: false, error: "required_plugin_protected" };
      }
      if (
        options.store.getInstall(query.workspaceSlug, pluginId)?.lifecycle ===
        "installed"
      ) {
        reply.code(409);
        return { ok: false, error: "plugin_must_be_uninstalled_first" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: query.workspaceSlug,
        operation: "hub.mcp.delete",
        capability: "connector.admin",
        pluginId,
        actorId: "operator",
        payload: {},
        actor: principalActor(request),
        ...governed,
      });
      if (!("effect" in rules)) return rules;
      options.store.revokeBrokerGrantsForPlugin({
        workspaceSlug: query.workspaceSlug,
        pluginId,
      });
      options.store.deleteListing(pluginId);
      return { ok: true, pluginId, deleted: true };
    },
  );

  app.post(
    "/api/marketplace/hub/plugins/:pluginId/lifecycle",
    async (request, reply) => {
      const authError = requireHubBearerAuth({
        request,
        reply,
        expectedToken: options.internalAuthToken,
      });
      if (authError) return authError;
      const input = HubLifecycleSchema.parse(request.body);
      const { pluginId } = request.params as { pluginId: string };
      let listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (
        listingIsRequired(listing) &&
        (input.action === "disable" || input.action === "uninstall")
      ) {
        reply.code(409);
        return { ok: false, error: "required_plugin_protected" };
      }
      const install = options.store.getInstall(input.workspaceSlug, pluginId);
      if (
        input.action !== "install" &&
        (!install || install.lifecycle !== "installed")
      ) {
        reply.code(409);
        return { ok: false, error: "plugin_not_installed" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: `hub.lifecycle.${input.action}`,
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { action: input.action },
        actor: principalActor(request),
        ...governed,
      });
      if (!("effect" in rules)) return rules;

      if (input.action === "install") {
        options.store.registerPlugin(pluginId);
        options.store.install(input.workspaceSlug, pluginId);
        for (const capability of listing.capabilities) {
          options.store.bindCapability({
            workspaceSlug: input.workspaceSlug,
            pluginId,
            capability,
            enabled: true,
          });
        }
        for (const actionKey of listing.actions) {
          options.store.bindAction({
            workspaceSlug: input.workspaceSlug,
            pluginId,
            actionKey,
            enabled: true,
          });
        }
      } else if (input.action === "enable") {
        options.store.setInstallEnabled({
          workspaceSlug: input.workspaceSlug,
          pluginId,
          enabled: true,
        });
      } else if (input.action === "disable") {
        options.store.setInstallEnabled({
          workspaceSlug: input.workspaceSlug,
          pluginId,
          enabled: false,
        });
        options.store.revokeBrokerGrantsForPlugin({
          workspaceSlug: input.workspaceSlug,
          pluginId,
        });
      } else if (input.action === "reload") {
        options.store.requireInstall(input.workspaceSlug, pluginId);
        listing = options.store.touchListing(pluginId);
        if (listing.source === "mcp") {
          options.store.upsertConnection({
            workspaceSlug: input.workspaceSlug,
            pluginId,
            provider: listing.provider,
            backend: "mcp",
            state: "pending",
            detail:
              "MCP adapter reload requested; transport connection is pending runtime confirmation.",
            metadata: { reloadedAt: new Date().toISOString() },
          });
        }
      } else if (input.action === "uninstall") {
        options.store.revokeBrokerGrantsForPlugin({
          workspaceSlug: input.workspaceSlug,
          pluginId,
        });
        options.store.uninstall(input.workspaceSlug, pluginId);
        const connection = options.store.getConnection(
          input.workspaceSlug,
          pluginId,
        );
        if (connection) {
          options.store.upsertConnection({
            workspaceSlug: input.workspaceSlug,
            pluginId,
            provider: connection.provider,
            backend: connection.backend,
            state: "disconnected",
            detail: "Plugin uninstalled through the unified Hub lifecycle.",
            metadata: connection.metadata,
          });
        }
      }

      options.store.recordAudit({
        workspaceSlug: input.workspaceSlug,
        pluginId,
        eventType: `marketplace.plugin.${input.action}`,
        actorId: input.actorId,
        rulesDecisionId: rules.decisionId,
        metadata: { source: "skills-hub" },
      });
      return {
        ok: true,
        record: marketplacePluginRecord({
          store: options.store,
          workspaceSlug: input.workspaceSlug,
          listing,
        }),
      };
    },
  );

  app.post("/api/marketplace/hub/reconcile", async (request, reply) => {
    const authError = requireHubBearerAuth({
      request,
      reply,
      expectedToken: options.internalAuthToken,
    });
    if (authError) return authError;
    const snapshot = GatewayRegistrySnapshotSchema.parse(
      request.body,
    ) as MarketplaceGatewayRegistrySnapshot;
    return reconcileGatewayRegistry(snapshot);
  });

  app.get("/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      ...corsHeadersForOrigin(request.headers.origin, environment),
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(
      `event: marketplace.status\ndata: ${JSON.stringify({ ok: true, time: new Date().toISOString() })}\n\n`,
    );
    reply.raw.end();
  });

  app.get("/api/marketplace/catalog", async (request) => {
    const query = WorkspaceQuerySchema.parse(request.query);
    await ensureComposioCatalog(query.workspaceSlug);
    return {
      items: options.store
        .listListingsForWorkspace(query.workspaceSlug)
        .map(browserListingForListing),
      providers: await readProviderHealthWithReachability(
        providerEnvironment(),
        options.providerFetch,
      ),
    };
  });

  app.get("/api/marketplace/cards", async (request) => {
    const query = WorkspaceQuerySchema.parse(request.query);
    await ensureComposioCatalog(query.workspaceSlug);
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    return {
      workspaceSlug: query.workspaceSlug,
      providers,
      cards: await pluginCardsForWorkspace({
        store: options.store,
        workspaceSlug: query.workspaceSlug,
        providers,
      }),
    };
  });

  app.get("/api/marketplace/cards/summary", async (request) => {
    const query = CardsSummaryQuerySchema.parse(request.query);
    await ensureComposioCatalog(query.workspaceSlug);
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    const summaries = options.store
      .listListingsForWorkspace(query.workspaceSlug)
      .map((listing) =>
      pluginSummaryForListing({
        store: options.store,
        workspaceSlug: query.workspaceSlug,
        listing,
      }),
    );
    const search = query.search.toLocaleLowerCase();
    const filtered = summaries.filter((summary) => {
      if (query.source !== "all" && summary.source !== query.source) {
        return false;
      }
      if (query.installed && !summary.installed) {
        return false;
      }
      if (!search) {
        return true;
      }
      return [
        summary.displayName,
        summary.description,
        summary.provider,
        summary.pluginId,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search);
    });
    const connections = summaries
      .filter((summary) => summary.connection !== null)
      .map((summary) => ({
        pluginId: summary.pluginId,
        displayName: summary.displayName,
        ...summary.connection!,
      }));
    const sources = [...new Set(summaries.map((summary) => summary.source))];

    return {
      workspaceSlug: query.workspaceSlug,
      providers: browserProviderHealth(providers),
      total: summaries.length,
      filteredTotal: filtered.length,
      installedTotal: summaries.filter((summary) => summary.installed).length,
      offset: query.offset,
      limit: query.limit,
      hasMore: query.offset + query.limit < filtered.length,
      sources,
      connections,
      items: filtered.slice(query.offset, query.offset + query.limit),
    };
  });

  app.get("/api/marketplace/cards/:pluginId", async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string };
    const query = WorkspaceQuerySchema.parse(request.query);
    await ensureComposioCatalog(query.workspaceSlug);
    const listing = options.store.getListingForWorkspace(
      pluginId,
      query.workspaceSlug,
    );
    if (!listing) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    return {
      workspaceSlug: query.workspaceSlug,
      providers: browserProviderHealth(providers),
      card: browserPluginCardForListing({
        store: options.store,
        workspaceSlug: query.workspaceSlug,
        listing,
        providers,
      }),
    };
  });

  app.get("/api/marketplace/plugins", async (request) => {
    const query = WorkspaceQuerySchema.parse(request.query);
    await ensureComposioCatalog(query.workspaceSlug);
    return {
      workspaceSlug: query.workspaceSlug,
      items: options.store
        .listListingsForWorkspace(query.workspaceSlug)
        .map((listing) => ({
        ...browserListingForListing(listing),
        install: options.store.getInstall(
          query.workspaceSlug,
          listing.pluginId,
        ),
        connection: options.store.getConnection(
          query.workspaceSlug,
          listing.pluginId,
        ),
        imports: options.store.listComposioImports({
          workspaceSlug: query.workspaceSlug,
          pluginId: listing.pluginId,
        }),
        actionBindings: options.store.listActionBindings({
          workspaceSlug: query.workspaceSlug,
          pluginId: listing.pluginId,
        }),
      })),
    };
  });

  app.get("/api/marketplace/plugins/:pluginId", async (request, reply) => {
    const { pluginId } = request.params as { pluginId: string };
    const query = WorkspaceQuerySchema.partial().parse(request.query);
    const listing = options.store.getListingForWorkspace(
      pluginId,
      query.workspaceSlug ??
        requestPrincipals.get(request)?.organizationId ??
        organizationId,
    );
    if (!listing) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    return {
      listing: browserListingForListing(listing),
      ...(query.workspaceSlug
        ? {
            install: options.store.getInstall(query.workspaceSlug, pluginId),
            connection: options.store.getConnection(
              query.workspaceSlug,
              pluginId,
            ),
            imports: options.store.listComposioImports({
              workspaceSlug: query.workspaceSlug,
              pluginId,
            }),
            actionBindings: options.store.listActionBindings({
              workspaceSlug: query.workspaceSlug,
              pluginId,
            }),
          }
        : {}),
    };
  });

  app.post(
    "/api/marketplace/plugins/:pluginId/install",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = InstallInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "install",
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return rules;
      }
      const install = options.store.install(input.workspaceSlug, pluginId);
      if (
        listingIsWorkspaceCustomMcp(listing, input.workspaceSlug) ||
        listingIsCompanyBoxOpenApi(listing)
      ) {
        bindCustomMcpForWorkspace(options.store, input.workspaceSlug, listing);
      }
      options.store.recordEvent({
        type: "marketplace.plugin.installed",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: { lifecycle: install.lifecycle },
      });
      reply.code(201);
      return { ok: true, traceId, listing, install, rules };
    },
  );

  app.post(
    "/api/marketplace/plugins/:pluginId/uninstall",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = InstallInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (listingIsRequired(listing)) {
        reply.code(409);
        return { ok: false, error: "required_plugin_protected" };
      }
      if (!options.store.getInstall(input.workspaceSlug, pluginId)) {
        reply.code(409);
        return { ok: false, error: "plugin_not_installed" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "uninstall",
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const install = options.store.uninstall(input.workspaceSlug, pluginId);
      options.store.recordEvent({
        type: "marketplace.plugin.uninstalled",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: { lifecycle: install.lifecycle },
      });
      return { ok: true, traceId, install, rules };
    },
  );

  app.post(
    "/api/marketplace/plugins/:pluginId/register",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = InstallInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "register",
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const registration = options.store.registerPlugin(pluginId);
      options.store.recordEvent({
        type: "marketplace.plugin.registered",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: { registryState: registration.registryState },
      });
      reply.code(201);
      return { ok: true, traceId, registration, rules };
    },
  );

  app.post(
    "/api/marketplace/plugins/:pluginId/unregister",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = InstallInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (listingIsRequired(listing)) {
        reply.code(409);
        return { ok: false, error: "required_plugin_protected" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "unregister",
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const registration = options.store.unregisterPlugin(pluginId);
      options.store.recordEvent({
        type: "marketplace.plugin.unregistered",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: { registryState: registration.registryState },
      });
      return { ok: true, traceId, registration, rules };
    },
  );

  app.post(
    "/api/marketplace/plugins/:pluginId/connection",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = ConnectionInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      let listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (listingIsOperatorCustomMcp(listing)) {
        // Custom MCP connections are established only by a successful refresh.
        reply.code(409);
        return { ok: false, error: "custom_mcp_refresh_required" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation:
          input.backend === "composio"
            ? "composio.connect"
            : "connector.connection.register",
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const providerHealth = readProviderHealth(providerEnvironment());
      const provider =
        providerHealth[input.backend === "native" ? "nango" : input.backend];
      if (input.backend !== "native" && !provider.configured) {
        reply.code(409);
        return {
          ok: false,
          error: "provider_unavailable",
          provider: input.backend,
          detail: provider.detail,
        };
      }

      if (input.backend === "composio") {
        const state = `cmp_${randomUUID()}`;
        const toolkit =
          composioListingRole(listing) === "composio-catalog-connector"
            ? composioToolkitForListing(listing)
            : (input.toolkit ?? input.provider ?? listing.provider).trim();
        try {
          const hydratedListing = await hydrateComposioCatalogConnector({
            store: options.store,
            workspaceSlug: input.workspaceSlug,
            listing,
            toolkit,
            traceId,
            env: providerEnvironment(),
            fetchImpl: options.providerFetch,
          });
          listing = hydratedListing;
        } catch (error) {
          reply.code(502);
          return {
            ok: false,
            error: "composio_toolkit_activation_failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        let callbackUrl: string;
        try {
          callbackUrl = callbackUrlForRequest({
            pluginId,
            publicOrigin: environment.MARKETPLACE_PUBLIC_ORIGIN,
          });
        } catch (error) {
          reply.code(503);
          return {
            ok: false,
            error: "marketplace_public_origin_unconfigured",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        const auth = await createComposioAuthLink({
          toolkit,
          state,
          callbackUrl,
          env: providerEnvironment(),
          fetchImpl: options.providerFetch,
          authConfigId: input.authConfigId,
          userId: input.userId,
          alias: input.alias ?? `${input.workspaceSlug}-${toolkit}`,
          connectionData: input.connectionData,
          ...composioAuthMetadataForListing(listing),
        });
        if (auth.redirectUrl || auth.connectedAccountId) {
          enableComposioConnector({
            store: options.store,
            workspaceSlug: input.workspaceSlug,
            listing,
            toolkit,
            traceId,
          });
        }
        const connectionState = auth.redirectUrl
          ? "pending"
          : auth.connectedAccountId
            ? "connected"
            : "blocked";
        const connection = options.store.upsertConnection({
          workspaceSlug: input.workspaceSlug,
          pluginId,
          provider: toolkit,
          backend: "composio",
          state: connectionState,
          detail: auth.redirectUrl
            ? "Composio authorization popup is pending."
            : auth.connectedAccountId
              ? "Composio connected account is available."
              : "Composio did not return an authorization URL or connected account id.",
          metadata: {
            provider: toolkit,
            toolkit,
            state,
            traceId,
            authConfigId: auth.authConfigId,
            connectedAccountId: auth.connectedAccountId,
            callbackUrl,
            redirectUrl: auth.redirectUrl,
            status: auth.status,
          },
        });
        options.store.recordEvent({
          type: "marketplace.composio.connection.started",
          traceId,
          workspaceSlug: input.workspaceSlug,
          pluginId,
          actorId: input.actorId,
          rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
          payload: {
            provider: toolkit,
            backend: input.backend,
            connectionState: connection.state,
            rawSecretStored: false,
            redirectRequired: Boolean(auth.redirectUrl),
          },
        });
        return {
          ok: true,
          traceId,
          connection,
          auth: {
            kind: auth.redirectUrl ? "redirect-required" : "connected-account",
            redirectUrl: auth.redirectUrl,
            connectedAccountId: auth.connectedAccountId,
            authConfigId: auth.authConfigId,
            status: auth.status,
          },
          rules,
        };
      }

      const connection = options.store.upsertConnection({
        workspaceSlug: input.workspaceSlug,
        pluginId,
        provider: input.provider,
        backend: input.backend,
        state: input.backend === "native" ? "connected" : "pending",
        detail:
          input.backend === "native"
            ? "Native connection is available."
            : "External connection reference is pending.",
        metadata: {
          provider: input.provider,
          backend: input.backend,
          rawSecretStored: false,
          credentialRef: input.credentialRef ?? null,
          traceId,
        },
      });
      if (input.credentialRef) {
        options.store.upsertCredentialRef({
          workspaceSlug: input.workspaceSlug,
          pluginId,
          providerHint: input.provider,
          secretRefKey: input.credentialRef,
          externalRef: null,
          state: input.backend === "native" ? "active" : "pending",
          detail:
            "Credential reference registered without storing raw secret material.",
          metadata: { backend: input.backend, traceId },
        });
      }
      options.store.recordEvent({
        type: "connector.connection.ref_registered",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: {
          provider: input.provider,
          backend: input.backend,
          rawSecretStored: false,
          credentialRef: input.credentialRef ?? null,
        },
      });
      return {
        ok: true,
        traceId,
        connection: {
          ...connection,
          rawSecretStored: false,
        },
        rules,
      };
    },
  );

  app.get(
    "/api/marketplace/plugins/:pluginId/oauth/composio/callback",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const query = ComposioCallbackQuerySchema.parse(request.query);
      const traceId = traceIdFrom(request);
      const pending = options.store.findConnectionByState(
        query.state,
        pluginId,
      );
      reply.type("text/html; charset=utf-8");
      if (!pending) {
        reply.code(404);
        return htmlCloseout({
          ok: false,
          title: "Session not found",
          detail:
            "Teal Brick could not match this Composio callback to a pending plugin connection.",
        });
      }
      const connectedAccountId =
        query.connected_account_id ??
        query.connectedAccountId ??
        query.connection_id ??
        query.account_id ??
        connectedAccountIdFromConnection(pending);
      const status = query.status ?? (query.error ? "ERROR" : "CONNECTED");
      const connected =
        !query.error &&
        Boolean(connectedAccountId) &&
        !["error", "failed", "blocked"].includes(status.toLowerCase());
      const connection = options.store.upsertConnection({
        workspaceSlug: pending.workspaceSlug,
        pluginId: pending.pluginId,
        provider: pending.provider,
        backend: "composio",
        state: connected ? "connected" : "blocked",
        detail: connected
          ? "Composio connected account completed."
          : (query.error ??
            "Composio callback did not include a connected account."),
        metadata: {
          ...pending.metadata,
          traceId,
          status,
          connectedAccountId: connectedAccountId ?? null,
          callbackCompletedAt: new Date().toISOString(),
          error: query.error ?? null,
        },
      });
      if (connected && connectedAccountId) {
        options.store.upsertCredentialRef({
          workspaceSlug: pending.workspaceSlug,
          pluginId: pending.pluginId,
          providerHint: pending.provider,
          secretRefKey: `composio:${pending.provider}:${connectedAccountId}`,
          externalRef: connectedAccountId,
          state: "active",
          detail:
            "Composio connected account reference is active. Raw OAuth material stays with Composio.",
          metadata: {
            backend: "composio",
            authConfigId: pending.metadata.authConfigId ?? null,
            traceId,
          },
        });
      }
      options.store.recordEvent({
        type: connected
          ? "marketplace.composio.connection.completed"
          : "marketplace.composio.connection.blocked",
        traceId,
        workspaceSlug: pending.workspaceSlug,
        pluginId: pending.pluginId,
        payload: {
          provider: pending.provider,
          connectionState: connection.state,
          connectedAccountId: connectedAccountId ?? null,
          rawSecretStored: false,
          error: query.error ?? null,
        },
      });
      return htmlCloseout({
        ok: connected,
        title: connected
          ? "Teal Brick connection complete"
          : "Teal Brick connection blocked",
        detail: connected
          ? "The connected account is recorded. You can close this window and return to Teal Brick."
          : "The Composio callback did not complete successfully. Return to Teal Brick and retry the connection.",
      });
    },
  );

  app.post(
    "/api/marketplace/plugins/:pluginId/capability-binding",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = BindingInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      if (!options.store.getListingForWorkspace(pluginId, input.workspaceSlug)) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (!options.store.getInstall(input.workspaceSlug, pluginId)) {
        reply.code(409);
        return { ok: false, error: "plugin_not_installed" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "capability.bind",
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const binding = options.store.bindCapability({ ...input, pluginId });
      options.store.recordEvent({
        type: "marketplace.capability.bound",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: { capability: input.capability, enabled: input.enabled },
      });
      reply.code(201);
      return { ok: true, traceId, binding, rules };
    },
  );

  app.post(
    "/api/marketplace/plugins/:pluginId/action-binding",
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = ActionBindingInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (!listing.actions.includes(input.actionKey)) {
        reply.code(404);
        return { ok: false, error: "plugin_action_not_found" };
      }
      if (!options.store.getInstall(input.workspaceSlug, pluginId)) {
        reply.code(409);
        return { ok: false, error: "plugin_not_installed" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "action.bind",
        capability: "connector.admin",
        pluginId,
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const binding = options.store.bindAction({ ...input, pluginId });
      options.store.recordEvent({
        type: "marketplace.action.bound",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: { actionKey: input.actionKey, enabled: input.enabled },
      });
      reply.code(201);
      return { ok: true, traceId, binding, rules };
    },
  );

  app.post(
    "/api/marketplace/v1/agent/grants/request",
    async (request, reply) => {
      const principal = requireHandoffPrincipal(request, reply);
      if (!principal) {
        return { ok: false, error: "marketplace_service_required" };
      }
      const input = PortalHandoffRequestSchema.parse(request.body);
      const session = options.store.getPortalHandoffSession(input.deploymentId);
      if (
        !session ||
        session.portalIssuer !== (portalIssuerUrl ?? "") ||
        session.productTenantId !== organizationId ||
        !portalIdentityMatches(session)
      ) {
        reply.code(409);
        return { ok: false, schema: 1, error: "portal_session_required" };
      }
      if (Date.parse(session.expiresAt) <= Date.now()) {
        reply.code(401);
        return { ok: false, schema: 1, error: "portal_session_expired" };
      }
      const published = resolvePublishedAgentAction({
        store: options.store,
        workspaceSlug: organizationId,
        pluginId: input.selection.pluginId,
        actionKey: input.selection.actionKey,
      });
      if (!published) {
        reply.code(404);
        return { ok: false, schema: 1, error: "agent_action_not_published" };
      }
      if (input.selection.resourceKind !== published.resourceKind) {
        reply.code(409);
        return { ok: false, schema: 1, error: "agent_action_resource_mismatch" };
      }
      if (
        !published.accounts.some(
          (account) => account.accountId === input.selection.accountId,
        )
      ) {
        reply.code(409);
        return { ok: false, schema: 1, error: "agent_action_account_mismatch" };
      }
      if (
        input.selection.capability !== undefined &&
        input.selection.capability !== published.capability
      ) {
        reply.code(409);
        return { ok: false, schema: 1, error: "agent_action_capability_mismatch" };
      }
      const outboundSelection = portalSelectionForPublishedAction({
        entry: published,
        accountId: input.selection.accountId,
      });
      try {
        const handoff = await portalHandoffClient.requestGrant({
          deploymentId: input.deploymentId,
          session: session.sessionToken,
          agentId: input.agentId,
          selection: outboundSelection,
          idempotencyKey: input.idempotencyKey,
        });
        const projection = options.store.upsertMarketplacePortalGrantRequest({
          portalIssuer: session.portalIssuer,
          portalOrgId: session.portalOrgId,
          productTenantId: session.productTenantId,
          workspaceId: session.workspaceId,
          deploymentId: input.deploymentId,
          agentId: input.agentId,
          requestId: handoff.requestId,
          approvalUrl: handoff.approvalUrl,
          expiresAt: new Date(handoff.expiresAt).toISOString(),
          idempotencyKey: input.idempotencyKey,
          selection: outboundSelection,
        });
        return {
          ok: true,
          schema: 1,
          contractVersion: MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
          authority:
            principal.kind === "operator"
              ? "marketplace_operator_session"
              : "marketplace_service_bearer",
          request: handoff,
          projection: browserMarketplacePortalGrantRequest(projection),
        };
      } catch (error) {
        reply.code(error instanceof PortalHandoffError ? error.statusCode : 503);
        return {
          ok: false,
          schema: 1,
          error:
            error instanceof PortalHandoffError
              ? error.code
              : "portal_handoff_unavailable",
        };
      }
    },
  );

  app.post(
    "/api/marketplace/v1/agent/grants/redeem",
    async (request, reply) => {
      const principal = requireHandoffPrincipal(request, reply);
      if (!principal) {
        return { ok: false, error: "marketplace_service_required" };
      }
      const input = PortalHandoffRedeemSchema.parse(request.body);
      const session = options.store.getPortalHandoffSession(input.deploymentId);
      if (
        !session ||
        session.portalIssuer !== (portalIssuerUrl ?? "") ||
        session.productTenantId !== organizationId ||
        !portalIdentityMatches(session)
      ) {
        reply.code(409);
        return { ok: false, schema: 1, error: "portal_session_required" };
      }
      if (Date.parse(session.expiresAt) <= Date.now()) {
        reply.code(401);
        return { ok: false, schema: 1, error: "portal_session_expired" };
      }
      const persistedRequest = options.store.getMarketplacePortalGrantRequest({
        portalIssuer: session.portalIssuer,
        deploymentId: input.deploymentId,
        requestId: input.requestId,
      });
      const traceId = traceIdFrom(request);
      let consent;
      let reconciled = false;
      try {
        consent = await portalHandoffClient.redeemGrant({
          deploymentId: input.deploymentId,
          session: session.sessionToken,
          requestId: input.requestId,
        });
      } catch (error) {
        if (!(error instanceof PortalHandoffError) || error.code !== "portal_handoff_unavailable") {
          reply.code(error instanceof PortalHandoffError ? error.statusCode : 503);
          return {
            ok: false,
            schema: 1,
            traceId,
            error:
              error instanceof PortalHandoffError
                ? error.code
                : "portal_handoff_unavailable",
          };
        }
        try {
          consent = await portalHandoffClient.receipt({
            deploymentId: input.deploymentId,
            session: session.sessionToken,
            requestId: input.requestId,
          });
          reconciled = true;
        } catch (receiptError) {
          reply.code(receiptError instanceof PortalHandoffError ? receiptError.statusCode : 503);
          return {
            ok: false,
            schema: 1,
            traceId,
            error: "portal_receipt_reconciliation_required",
          };
        }
      }
      if (
        consent.productTenantId !== organizationId ||
        consent.deploymentId !== input.deploymentId ||
        consent.state !== "active" ||
        !consent.consentId
      ) {
        if (persistedRequest) {
          options.store.updateMarketplacePortalGrantRequest({
            portalIssuer: session.portalIssuer,
            deploymentId: input.deploymentId,
            requestId: input.requestId,
            state: "denied",
          });
        }
        reply.code(403);
        return { ok: false, schema: 1, traceId, error: "portal_consent_invalid" };
      }
      if (
        persistedRequest &&
        !portalSelectionsEquivalent(persistedRequest.selection, consent.selection)
      ) {
        reply.code(403);
        return { ok: false, schema: 1, traceId, error: "portal_consent_invalid" };
      }
      const listing = options.store.getListingForWorkspace(
        consent.selection.pluginId,
        organizationId,
      );
      const connection = options.store.getConnection(
        organizationId,
        consent.selection.pluginId,
      );
      const accountId = listing
        ? agentAccountIdForConnection({ listing, workspaceSlug: organizationId, connection })
        : undefined;
      if (
        !listing ||
        !listingExecutableForAgents(listing, organizationId) ||
        !listing.actions.includes(consent.selection.actionKey) ||
        !options.store.getInstall(organizationId, consent.selection.pluginId)?.enabled ||
        !options.store.isActionEnabled({
          workspaceSlug: organizationId,
          pluginId: consent.selection.pluginId,
          actionKey: consent.selection.actionKey,
        }) ||
        connection?.state !== "connected" ||
        accountId !== consent.selection.accountId ||
        consent.selection.resourceRef !== `account:${accountId}`
      ) {
        reply.code(409);
        return { ok: false, schema: 1, traceId, error: "portal_consent_scope_unavailable" };
      }
      const consentCapability = selectionCapability(consent.selection);
      let binding;
      try {
        binding = options.store.requireCapabilityBinding(
          organizationId,
          consent.selection.pluginId,
          consentCapability,
        );
      } catch {
        reply.code(403);
        return { ok: false, schema: 1, traceId, error: "connector_capability_denied" };
      }
      if (!binding.enabled) {
        reply.code(403);
        return { ok: false, schema: 1, traceId, error: "connector_capability_denied" };
      }
      const published = resolvePublishedAgentAction({
        store: options.store,
        workspaceSlug: organizationId,
        pluginId: consent.selection.pluginId,
        actionKey: consent.selection.actionKey,
      });
      if (
        !published ||
        published.capability !== consentCapability ||
        published.resourceKind !== consent.selection.resourceKind ||
        !published.accounts.some((account) => account.accountId === accountId) ||
        !consent.capabilities.includes(published.capability)
      ) {
        reply.code(409);
        return { ok: false, schema: 1, traceId, error: "portal_consent_scope_unavailable" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: organizationId,
        operation: "execute",
        capability: published.capability,
        pluginId: consent.selection.pluginId,
        actorId: `agent:${consent.agentId}`,
        payload: {
          contractVersion: MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
          phase: "grant",
          portalOrgId: consent.portalOrgId,
          productTenantId: consent.productTenantId,
          deploymentId: consent.deploymentId,
          agentId: consent.agentId,
          consentId: consent.consentId,
          selection: consent.selection,
          traceId,
        },
        actor: { kind: "agent", id: `agent:${consent.agentId}`, attestation: "portal-consent" },
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const created = options.store.createMarketplaceAgentConsent({
        portalIssuer: session.portalIssuer,
        portalOrgId: consent.portalOrgId,
        productTenantId: consent.productTenantId,
        workspaceId: consent.workspaceId,
        deploymentId: consent.deploymentId,
        userId: consent.userId,
        agentId: consent.agentId,
        consentId: consent.consentId,
        consentRevision: consent.consentRevision,
        pluginId: consent.selection.pluginId,
        actionKey: consent.selection.actionKey,
        capability: published.capability,
        connectionId: connection.id,
        accountId: consent.selection.accountId,
        resourceKind: consent.selection.resourceKind,
        resourceRef: consent.selection.resourceRef,
        capabilities: consent.capabilities,
        requiredActions: consent.requiredActions,
        metadata: {
          contractVersion: MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
          durableConsent: true,
          rawTokensStored: false,
        },
      });
      if (created.created) {
        options.store.recordEvent({
          type: "marketplace.agent.consent.created",
          traceId,
          workspaceSlug: organizationId,
          pluginId: consent.selection.pluginId,
          actorId: `agent:${consent.agentId}`,
          rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
          payload: {
            grantId: created.consent.id,
            consentId: created.consent.consentId,
            portalOrgId: created.consent.portalOrgId,
            productTenantId: created.consent.productTenantId,
            deploymentId: created.consent.deploymentId,
            agentId: created.consent.agentId,
            rawTokensStored: false,
          },
        });
      }
      const projection = persistedRequest
        ? options.store.updateMarketplacePortalGrantRequest({
            portalIssuer: session.portalIssuer,
            deploymentId: input.deploymentId,
            requestId: input.requestId,
            state: "redeemed",
            consentId: created.consent.consentId,
          })
        : null;
      return {
        ok: true,
        schema: 1,
        contractVersion: MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
        authority:
          principal.kind === "operator"
            ? "marketplace_operator_session"
            : "marketplace_service_bearer",
        traceId,
        reconciled,
        created: created.created,
        consent: browserMarketplaceAgentConsent(created.consent),
        ...(projection
          ? { projection: browserMarketplacePortalGrantRequest(projection) }
          : {}),
        rules,
      };
    },
  );

  app.post(
    "/api/marketplace/agent/grants",
    async (request, reply) => {
      if (!requireService(request, reply)) {
        return { ok: false, error: "marketplace_service_required" };
      }
      const input = AgentGrantInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const service = requestPrincipals.get(request);
      const workspaceSlug = service?.organizationId ?? input.workspaceSlug;
      const listing = options.store.getListingForWorkspace(input.pluginId, workspaceSlug);
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      if (!listingExecutableForAgents(listing, workspaceSlug)) {
        reply.code(409);
        return { ok: false, error: "plugin_not_composio_backed" };
      }
      if (!listing.actions.includes(input.actionKey)) {
        reply.code(400);
        return { ok: false, error: "agent_grant_action_not_registered" };
      }
      const requirement = resolveActionRequirement(listing, input.actionKey);
      if (!requirement) {
        reply.code(400);
        return { ok: false, error: "agent_grant_action_contract_mismatch" };
      }
      const install = options.store.getInstall(workspaceSlug, input.pluginId);
      if (!install || !install.enabled || install.lifecycle !== "installed") {
        reply.code(409);
        return { ok: false, error: "plugin_not_installed" };
      }
      if (
        !options.store.isActionEnabled({
          workspaceSlug,
          pluginId: input.pluginId,
          actionKey: input.actionKey,
        })
      ) {
        reply.code(403);
        return { ok: false, error: "connector_action_denied" };
      }
      const connection = options.store.getConnection(workspaceSlug, input.pluginId);
      const accountId = agentAccountIdForConnection({ listing, workspaceSlug, connection });
      if (!connection || !accountId || accountId !== input.accountId) {
        reply.code(409);
        return { ok: false, error: "agent_grant_account_mismatch" };
      }
      if (input.resourceRef !== `account:${accountId}`) {
        reply.code(403);
        return { ok: false, error: "resource_mismatch" };
      }
      let binding;
      try {
        binding = options.store.requireCapabilityBinding(
          workspaceSlug,
          input.pluginId,
          requirement.capability,
        );
      } catch {
        reply.code(403);
        return { ok: false, error: "connector_capability_denied" };
      }
      if (!binding.enabled) {
        reply.code(403);
        return { ok: false, error: "connector_capability_denied" };
      }
      const mapping = resolvePublishedAgentAction({
        store: options.store,
        workspaceSlug,
        pluginId: input.pluginId,
        actionKey: input.actionKey,
      });
      if (!mapping) {
        reply.code(409);
        return {
          ok: false,
          error: "agent_grant_action_not_supported",
          detail:
            "This action is not published to agents in this workspace.",
        };
      }
      if (input.resourceKind !== mapping.resourceKind) {
        reply.code(400);
        return { ok: false, error: "agent_grant_resource_invalid" };
      }
      const portal = await verifyPortalScope({
        request,
        reply,
        requiredCapability: mapping.capability,
      });
      if (!portal.ok) {
        return { ok: false, error: portal.error };
      }
      if (portal.scope.organizationId !== workspaceSlug) {
        reply.code(403);
        return { ok: false, error: "agent_grant_tenant_mismatch" };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug,
        operation: "execute",
        capability: mapping.capability,
        pluginId: input.pluginId,
        actorId: `agent:${portal.scope.agentId}`,
        payload: {
          contractVersion: MARKETPLACE_AGENT_GRANT_CONTRACT_VERSION,
          phase: "grant",
          agentId: portal.scope.agentId,
          attachmentId: portal.scope.attachmentId,
          accountId: input.accountId,
          actionKey: input.actionKey,
          resourceKind: input.resourceKind,
          resourceRef: input.resourceRef,
          traceId,
        },
        actor: { kind: "agent", id: `agent:${portal.scope.agentId}`, attestation: "portal-scope" },
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      if (
        options.store.findActiveAgentConnectorGrant({
          workspaceSlug,
          agentId: portal.scope.agentId,
          pluginId: input.pluginId,
          actionKey: input.actionKey,
          accountId: input.accountId,
          resourceKind: input.resourceKind,
          resourceRef: input.resourceRef,
        })
      ) {
        reply.code(409);
        return { ok: false, error: "agent_grant_already_active" };
      }
      const expiresAt = new Date(
        Math.min(portal.scope.expiresAt * 1000, Date.now() + 5 * 60_000),
      ).toISOString();
      const grant = options.store.createAgentConnectorGrant({
        workspaceSlug,
        agentId: portal.scope.agentId,
        pluginId: input.pluginId,
        actionKey: input.actionKey,
        capability: mapping.capability,
        connectionId: connection.id,
        accountId: input.accountId,
        resourceKind: input.resourceKind,
        resourceRef: input.resourceRef,
        attachmentId: portal.scope.attachmentId,
        expiresAt,
        metadata: {
          contractVersion: MARKETPLACE_AGENT_GRANT_CONTRACT_VERSION,
          provider: listing.provider,
          toolName: mapping.toolName,
          rawTokensStored: false,
        },
      });
      options.store.recordEvent({
        type: "marketplace.agent.grant.created",
        traceId,
        workspaceSlug,
        pluginId: input.pluginId,
        actorId: `agent:${portal.scope.agentId}`,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: {
          grantId: grant.id,
          agentId: grant.agentId,
          accountId: grant.accountId,
          actionKey: grant.actionKey,
          resourceKind: grant.resourceKind,
          resourceRef: grant.resourceRef,
          attachmentId: grant.attachmentId,
          rawTokensStored: false,
        },
      });
      reply.code(201);
      return { ok: true, traceId, grant: sanitizeAgentConnectorGrant(grant), rules };
    },
  );

  app.post(
    "/api/marketplace/plugins/:pluginId/execute",
    { bodyLimit: uploadBodyLimit },
    async (request, reply) => {
      const { pluginId } = request.params as { pluginId: string };
      const input = ExecuteInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      let scopedGrant: AgentConnectorGrant | null = null;
      let effectiveActorId = input.actorId;
      let effectiveAction = input.action;
      if (input.agentGrantId) {
        scopedGrant = options.store.getAgentConnectorGrant(input.agentGrantId);
        if (!scopedGrant) {
          reply.code(404);
          return { ok: false, error: "agent_grant_not_found" };
        }
        if (
          scopedGrant.workspaceSlug !== input.workspaceSlug ||
          scopedGrant.pluginId !== pluginId ||
          scopedGrant.actionKey !== input.action.type ||
          scopedGrant.capability !== input.capability
        ) {
          reply.code(403);
          return { ok: false, error: "agent_grant_scope_mismatch" };
        }
        const verified = await verifyAgentGrantScope({
          request,
          reply,
          grant: scopedGrant,
          requiredCapability: input.capability,
        });
        if (!verified.ok) {
          return { ok: false, error: verified.error };
        }
        if (
          input.resourceRef !== undefined &&
          input.resourceRef !== scopedGrant.resourceRef
        ) {
          reply.code(403);
          return { ok: false, error: "resource_mismatch" };
        }
        effectiveActorId = `agent:${verified.scope.agentId}`;
      }
      options.store.recordEvent({
        type: "marketplace.execution.requested",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: effectiveActorId,
        payload: {
          capability: input.capability,
          action: input.action.type,
          ...(scopedGrant
            ? {
                agentGrantId: scopedGrant.id,
                resourceKind: scopedGrant.resourceKind,
                resourceRef: scopedGrant.resourceRef,
              }
            : {}),
        },
      });
      const listing = options.store.getListingForWorkspace(
        pluginId,
        input.workspaceSlug,
      );
      if (!listing) {
        reply.code(404);
        return { ok: false, error: "plugin_not_found" };
      }
      const customMcp = listingIsWorkspaceCustomMcp(listing, input.workspaceSlug);
      const openApi = listingIsCompanyBoxOpenApi(listing);
      const install = options.store.getInstall(input.workspaceSlug, pluginId);
      if (!install || !install.enabled || install.lifecycle !== "installed") {
        reply.code(409);
        return { ok: false, error: "plugin_not_installed" };
      }
      const requirement = resolveActionRequirement(listing, input.action.type);
      if (!requirement) {
        reply.code(400);
        return { ok: false, error: "unknown_connector_action" };
      }
      if (requirement.capability !== input.capability) {
        reply.code(400);
        return {
          ok: false,
          error: "connector_capability_mismatch",
          requiredCapability: requirement.capability,
        };
      }
      if (requirement.kind !== listing.provider) {
        reply.code(409);
        return {
          ok: false,
          error: "connector_kind_mismatch",
          provider: listing.provider,
        };
      }
      if (
        !options.store.isActionEnabled({
          workspaceSlug: input.workspaceSlug,
          pluginId,
          actionKey: input.action.type,
        })
      ) {
        reply.code(403);
        return { ok: false, error: "connector_action_denied" };
      }
      const connection = options.store.getConnection(
        input.workspaceSlug,
        pluginId,
      );
      if (
        !listingConnected({
          listing,
          workspaceSlug: input.workspaceSlug,
          connectionState: connection?.state,
        })
      ) {
        reply.code(409);
        return {
          ok: false,
          error: "connector_not_connected",
          provider: listing.provider,
        };
      }
      if (
        scopedGrant &&
        (connection?.id !== scopedGrant.connectionId ||
          agentAccountIdForConnection({
            listing,
            workspaceSlug: input.workspaceSlug,
            connection,
          }) !== scopedGrant.accountId)
      ) {
        reply.code(403);
        return { ok: false, error: "agent_grant_connection_mismatch" };
      }
      const binding = options.store.getCapabilityBinding(
        input.workspaceSlug,
        pluginId,
        input.capability,
      );
      if (!binding?.enabled) {
        reply.code(403);
        return { ok: false, error: "connector_capability_denied" };
      }
      if (scopedGrant) {
        // Resolve against live workspace state after the specific install,
        // action, connection and binding checks so their error codes stay
        // stable; anything else that unpublished the action fails here.
        const scopedAction = applyScopedResource({
          action: input.action,
          grant: scopedGrant,
          entry: resolvePublishedAgentAction({
            store: options.store,
            workspaceSlug: input.workspaceSlug,
            pluginId,
            actionKey: input.action.type,
          }),
        });
        if (!scopedAction.ok) {
          reply.code(403);
          return { ok: false, error: scopedAction.error };
        }
        effectiveAction = { ...scopedAction.action, type: input.action.type };
      }
      if (listing.executionOwner !== "composio" && !customMcp && !openApi) {
        options.store.recordEvent({
          type: "marketplace.execution.unsupported",
          traceId,
          workspaceSlug: input.workspaceSlug,
          pluginId,
          actorId: effectiveActorId,
          payload: {
            executionOwner: listing.executionOwner,
            action: input.action.type,
            supportedExecutionOwners: ["composio", "mcp", "openapi"],
          },
        });
        reply.code(501);
        return {
          ok: false,
          traceId,
          error: "connector_execution_not_supported",
          executionOwner: listing.executionOwner,
          supportedExecutionOwners: ["composio", "mcp", "openapi"],
          detail:
            "This launch profile executes Composio-backed tools and the workspace's own custom MCP connectors only. Native, Activepieces, Nango, and Hub MCP execution are unavailable rather than simulated.",
        };
      }
      const risk = companyBoxRiskForAction(companyBox, listing, input.workspaceSlug, input.action.type);
      if (
        governanceMode === "owner" &&
        risk?.outward &&
        scopedGrant &&
        companyBoxEntryForListing(companyBox, listing, input.workspaceSlug)
      ) {
        const { type: _type, ...args } = effectiveAction;
        const held = holdCompanyBoxCall({
          listing,
          workspaceSlug: input.workspaceSlug,
          actionKey: input.action.type,
          capability: input.capability,
          args,
          agentId: scopedGrant.agentId,
          sourceKind: "agent-grant",
          sourceRef: scopedGrant.id,
          idempotencyKey: input.idempotencyKey ?? null,
          traceId,
        });
        reply.code(held.status);
        return { ...held.body, traceId };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "execute",
        capability: input.capability,
        pluginId,
        actorId: effectiveActorId,
        ...(risk ? { risk } : {}),
        payload: {
          ...(request.body as Record<string, unknown>),
          action: effectiveAction,
          ...(scopedGrant
            ? {
                agentId: scopedGrant.agentId,
                accountId: scopedGrant.accountId,
                resourceKind: scopedGrant.resourceKind,
                resourceRef: scopedGrant.resourceRef,
                agentGrantId: scopedGrant.id,
              }
            : {}),
          traceId,
        },
        actor: scopedGrant
          ? { kind: "agent", id: effectiveActorId, attestation: "agent-grant" }
          : principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        options.store.recordEvent({
          type: "marketplace.execution.denied",
          traceId,
          workspaceSlug: input.workspaceSlug,
          pluginId,
          actorId: effectiveActorId,
          payload: {
            capability: input.capability,
            action: input.action.type,
            error: rules.error,
          },
        });
        return { ...rules, traceId };
      }

      if (openApi) {
        return executeCompanyBoxAction({
          reply,
          listing,
          workspaceSlug: input.workspaceSlug,
          capability: input.capability,
          action: effectiveAction,
          actorId: effectiveActorId,
          traceId,
          rules,
          risk,
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
          agentGrantId: scopedGrant?.id ?? null,
        });
      }
      if (customMcp) {
        return executeCustomMcpAction({
          reply,
          listing,
          workspaceSlug: input.workspaceSlug,
          capability: input.capability,
          action: effectiveAction,
          actorId: effectiveActorId,
          traceId,
          rules,
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
          agentGrantId: scopedGrant?.id ?? null,
        });
      }

      const toolName = composioToolNameForAction(listing, input.action.type);
      let providerResult: { summary: string; details: Record<string, unknown> };
      try {
        const providerOutput = await executeComposioTool({
            toolName,
            arguments: { ...effectiveAction, type: undefined },
            connectedAccountId: connectedAccountIdFromConnection(connection),
            userId:
              typeof connection?.metadata.userId === "string"
                ? connection.metadata.userId
                : undefined,
            env: providerEnvironment(),
            fetchImpl: options.providerFetch,
        });
        providerResult = {
          summary: `Executed ${toolName} through Composio.`,
          details: {
            toolName,
            result: providerOutput,
          },
        };
      } catch (error) {
          const usage = options.store.recordUsage({
            workspaceSlug: input.workspaceSlug,
            pluginId,
            provider: listing.provider,
            sourceExecutor: listing.executionOwner,
            sourceActionKey: input.action.type,
            productCapabilityKey: `connector.${listing.executionOwner}.${listing.provider}.${input.action.type}`,
            scopesUsed: [input.capability],
            status: "failed",
            runId: input.runId ?? null,
            sessionId: input.sessionId ?? null,
            error: error instanceof Error ? error.message : String(error),
            metadata: {
              rules,
              ...(scopedGrant ? { agentGrantId: scopedGrant.id } : {}),
            },
            input: effectiveAction,
            output: null,
          });
          options.store.recordEvent({
            type: "marketplace.execution.failed",
            traceId,
            workspaceSlug: input.workspaceSlug,
            pluginId,
            actorId: effectiveActorId,
            rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
            payload: {
              capability: input.capability,
              action: input.action.type,
              usageId: usage.id,
            },
          });
          reply.code(502);
        return {
          ok: false,
          traceId,
          error: "composio_execute_failed",
          detail: error instanceof Error ? error.message : String(error),
          usage,
        };
      }
      const result = {
        pluginId,
        workspaceSlug: input.workspaceSlug,
        provider: listing.provider,
        capability: input.capability,
        actionType: input.action.type,
        performedAt: new Date().toISOString(),
        simulated: false,
        summary: providerResult.summary,
        details: providerResult.details,
      };
      const usage = options.store.recordUsage({
        workspaceSlug: input.workspaceSlug,
        pluginId,
        provider: listing.provider,
        sourceExecutor: listing.executionOwner,
        sourceActionKey: input.action.type,
        productCapabilityKey: `connector.${listing.executionOwner}.${listing.provider}.${input.action.type}`,
        scopesUsed: [input.capability],
        status: "succeeded",
        runId: input.runId ?? null,
        sessionId: input.sessionId ?? null,
        error: null,
        metadata: {
          rules,
          ...(scopedGrant ? { agentGrantId: scopedGrant.id } : {}),
        },
        input: effectiveAction,
        output: result,
      });
      options.store.recordEvent({
        type: "marketplace.execution.completed",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId,
        actorId: effectiveActorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: {
          capability: input.capability,
          action: input.action.type,
          usageId: usage.id,
        },
      });
      return { ok: true, traceId, result, usage, rules };
    },
  );

  app.route({
    method: "POST",
    url: "/api/marketplace/v1/runtime/composio/execute",
    bodyLimit: 16_384,
    handler: async (request, reply) => {
      const traceId = traceIdFrom(request);
      if (request.headers.cookie || request.headers.origin) {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_service_request_required",
        });
      }
      const attachmentToken = bearerTokenFrom(request);
      if (!attachmentToken) {
        reply.code(401);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_lease_required",
        });
      }
      const input = RuntimeComposioExecuteSchema.parse(request.body);
      let scope;
      try {
        scope = await portalRuntimeScopeVerifier({
          attachmentToken,
          selection: canonicalPortalSelection(input.selection),
          requiredCapability: selectionCapability(input.selection),
        });
      } catch (error) {
        const status =
          error instanceof PortalRuntimeScopeError ? error.statusCode : 503;
        reply.code(status);
        return runtimeResponse({
          ok: false,
          traceId,
          error:
            error instanceof PortalRuntimeScopeError
              ? error.code
              : "portal_runtime_unavailable",
        });
      }
      if (scope.productTenantId !== organizationId) {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_tenant_mismatch",
        });
      }
      if (!portalIdentityMatches(scope)) {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_identity_mismatch",
        });
      }
      if (scope.consentId !== input.consentId) {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_consent_mismatch",
        });
      }
      const consent = options.store.getMarketplaceAgentConsent({
        portalIssuer: portalIssuerUrl ?? "",
        deploymentId: scope.deploymentId,
        consentId: scope.consentId,
      });
      if (!consent || consent.state !== "active") {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: consent ? "runtime_consent_revoked" : "runtime_consent_not_found",
        });
      }
      if (
        consent.productTenantId !== scope.productTenantId ||
        consent.portalOrgId !== scope.portalOrgId ||
        consent.workspaceId !== scope.workspaceId ||
        consent.deploymentId !== scope.deploymentId ||
        consent.agentId !== scope.agentId ||
        consent.pluginId !== input.selection.pluginId ||
        consent.actionKey !== input.selection.actionKey ||
        consent.accountId !== input.selection.accountId ||
        consent.resourceKind !== input.selection.resourceKind ||
        consent.resourceRef !== input.selection.resourceRef ||
        consent.capability !== selectionCapability(input.selection)
      ) {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_scope_mismatch",
        });
      }
      const listing = options.store.getListingForWorkspace(
        input.selection.pluginId,
        organizationId,
      );
      const connection = options.store.getConnection(
        organizationId,
        input.selection.pluginId,
      );
      if (
        !listing ||
        !listingExecutableForAgents(listing, organizationId) ||
        !listing.actions.includes(input.selection.actionKey) ||
        !options.store.getInstall(organizationId, input.selection.pluginId)?.enabled ||
        !options.store.isActionEnabled({
          workspaceSlug: organizationId,
          pluginId: input.selection.pluginId,
          actionKey: input.selection.actionKey,
        }) ||
        !connection ||
        agentAccountIdForConnection({ listing, workspaceSlug: organizationId, connection }) !==
          consent.accountId ||
        connection.id !== consent.connectionId
      ) {
        reply.code(409);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_connection_unavailable",
        });
      }
      let binding;
      try {
        binding = options.store.requireCapabilityBinding(
          organizationId,
          input.selection.pluginId,
          consent.capability,
        );
      } catch {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "connector_capability_denied",
        });
      }
      if (!binding.enabled) {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "connector_capability_denied",
        });
      }
      const published = resolvePublishedAgentAction({
        store: options.store,
        workspaceSlug: organizationId,
        pluginId: consent.pluginId,
        actionKey: consent.actionKey,
      });
      if (!published || published.capability !== consent.capability) {
        reply.code(409);
        return runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_connection_unavailable",
        });
      }
      const action = { type: input.selection.actionKey, ...input.input };
      const scopedAction = applyScopedResource({
        action,
        grant: consent,
        entry: published,
      });
      if (!scopedAction.ok) {
        reply.code(403);
        return runtimeResponse({
          ok: false,
          traceId,
          error: scopedAction.error,
        });
      }
      const runtimeRisk = companyBoxRiskForAction(companyBox, listing, organizationId, input.selection.actionKey);
      if (
        governanceMode === "owner" &&
        runtimeRisk?.outward &&
        companyBoxEntryForListing(companyBox, listing, organizationId)
      ) {
        const { type: _type, ...args } = scopedAction.action;
        const held = holdCompanyBoxCall({
          listing,
          workspaceSlug: organizationId,
          actionKey: input.selection.actionKey,
          capability: consent.capability,
          args,
          agentId: consent.agentId,
          sourceKind: "runtime-lease",
          sourceRef: consent.id,
          idempotencyKey: input.idempotencyKey,
          traceId,
        });
        reply.code(held.status);
        return { ...held.body, schema: 1, traceId };
      }
      const rules = await enforceRules({
        reply,
        workspaceSlug: organizationId,
        operation: "execute",
        capability: consent.capability,
        pluginId: consent.pluginId,
        actorId: `agent:${consent.agentId}`,
        ...(runtimeRisk ? { risk: runtimeRisk } : {}),
        payload: {
          contractVersion: MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
          phase: "execute",
          portalOrgId: consent.portalOrgId,
          productTenantId: consent.productTenantId,
          workspaceId: consent.workspaceId,
          deploymentId: consent.deploymentId,
          agentId: consent.agentId,
          consentId: consent.consentId,
          leaseId: scope.leaseId,
          action: scopedAction.action,
          selection: input.selection,
          traceId,
        },
        actor: { kind: "agent", id: `agent:${consent.agentId}`, attestation: "runtime-lease" },
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        options.store.recordEvent({
          type: "marketplace.runtime.execution.denied",
          traceId,
          workspaceSlug: organizationId,
          pluginId: consent.pluginId,
          actorId: `agent:${consent.agentId}`,
          payload: {
            consentId: consent.consentId,
            leaseId: scope.leaseId,
            capability: consent.capability,
            action: input.selection.actionKey,
            error: rules.error,
          },
        });
        return runtimeResponse({
          ok: false,
          traceId,
          error: rules.error,
        });
      }
      // Custom MCP connectors run through the same runtime contract; build
      // their outbound connection before reserving the idempotency key so a
      // missing secret store never leaves an operation needing reconciliation.
      let mcpConnection: ReturnType<typeof customMcpConnection> | null = null;
      let openApiTarget: Extract<ReturnType<typeof companyBoxOpenApiTarget>, { ok: true }> | null = null;
      if (listingIsCompanyBoxOpenApi(listing)) {
        let target: ReturnType<typeof companyBoxOpenApiTarget>;
        try {
          target = companyBoxOpenApiTarget(listing, organizationId);
        } catch (error) {
          if (!(error instanceof ConnectorSecretStoreUnavailableError)) throw error;
          reply.code(503);
          return runtimeResponse({ ok: false, traceId, error: "connector_secret_store_unavailable" });
        }
        if (!target.ok) {
          reply.code(409);
          return runtimeResponse({ ok: false, traceId, error: "runtime_connection_unavailable" });
        }
        const operation = target.entry.byKey.get(input.selection.actionKey);
        const { type: _type, ...args } = scopedAction.action;
        try {
          if (!operation) throw new OpenApiCallError("openapi_argument_invalid", "Unknown operation.");
          validateOpenApiArguments(operation.operation, args, runtimeAuthFor(target.entry.entry.auth), operation.validateArguments, maxUploadBytes);
        } catch (error) {
          if (!(error instanceof OpenApiCallError)) throw error;
          reply.code(400);
          return runtimeResponse({ ok: false, traceId, error: "provider_argument_invalid" });
        }
        openApiTarget = target;
      }
      if (listingIsWorkspaceCustomMcp(listing, organizationId)) {
        try {
          mcpConnection = customMcpConnection(listing, organizationId);
        } catch (error) {
          if (!(error instanceof ConnectorSecretStoreUnavailableError)) throw error;
          reply.code(503);
          return runtimeResponse({
            ok: false,
            traceId,
            error: "connector_secret_store_unavailable",
          });
        }
      }
      const fingerprint = createHash("sha256")
        .update(
          stableJson({
            consentId: input.consentId,
            selection: input.selection,
            input: input.input,
          }),
        )
        .digest("hex");
      let operation;
      try {
        operation = options.store.beginMarketplaceRuntimeOperation({
          consentId: input.consentId,
          idempotencyKey: input.idempotencyKey,
          fingerprint,
        });
      } catch (error) {
        reply.code(409);
        return runtimeResponse({
          ok: false,
          traceId,
          error:
            error instanceof Error && error.message === "runtime_operation_idempotency_conflict"
              ? "runtime_idempotency_conflict"
              : "runtime_operation_unavailable",
        });
      }
      if (!operation.created) {
        if (operation.operation.status === "succeeded" && operation.operation.response) {
          return { ...operation.operation.response, replayed: true };
        }
        reply.code(409);
        return runtimeResponse({
          ok: false,
          traceId,
          error:
            operation.operation.status === "pending"
              ? "runtime_operation_in_progress"
              : "runtime_operation_reconciliation_required",
        });
      }
      const toolName = mcpConnection || openApiTarget
        ? published.toolName
        : composioToolNameForAction(listing, input.selection.actionKey);
      try {
        let providerOutput: unknown;
        if (openApiTarget) {
          const { type: _type, ...args } = scopedAction.action;
          try {
            providerOutput = await callCompanyBoxOperation(openApiTarget, input.selection.actionKey, args);
          } catch (error) {
            logCompanyBoxFailure({
              event: "marketplace.company_box.runtime_failed",
              pluginId: listing.pluginId,
              workspaceSlug: organizationId,
              error,
            });
            throw new Error(error instanceof OpenApiCallError ? error.code : "openapi_unreachable");
          }
        } else if (mcpConnection) {
          const { type: _type, ...args } = scopedAction.action;
          const output = await callMcpTool(mcpConnection, toolName, args);
          if (output.isError) {
            throw new Error("mcp_tool_failed");
          }
          providerOutput = {
            content: output.content,
            ...(output.structuredContent === undefined
              ? {}
              : { structuredContent: output.structuredContent }),
          };
        } else {
          providerOutput = await executeComposioTool({
            toolName,
            arguments: { ...scopedAction.action, type: undefined },
            connectedAccountId: connectedAccountIdFromConnection(connection),
            userId:
              typeof connection?.metadata.userId === "string"
                ? connection.metadata.userId
                : undefined,
            env: providerEnvironment(),
            fetchImpl: options.providerFetch,
          });
        }
        const result = {
          pluginId: input.selection.pluginId,
          workspaceSlug: organizationId,
          provider: listing.provider,
          capability: consent.capability,
          actionType: input.selection.actionKey,
          performedAt: new Date().toISOString(),
          simulated: false,
          summary: mcpConnection || openApiTarget
            ? `Ran ${toolName} on ${listing.displayName}.`
            : `Executed ${toolName} through Composio.`,
          details: { toolName, result: runtimeSafeProviderResult(providerOutput) },
        };
        if (JSON.stringify(result).length > 65536) {
          throw new Error("runtime_result_too_large");
        }
        const usage = options.store.recordUsage({
          workspaceSlug: organizationId,
          pluginId: input.selection.pluginId,
          provider: listing.provider,
          sourceExecutor: listing.executionOwner,
          sourceActionKey: input.selection.actionKey,
          productCapabilityKey: `connector.${listing.executionOwner}.${listing.provider}.${input.selection.actionKey}`,
          scopesUsed: [consent.capability],
          status: "succeeded",
          runId: null,
          sessionId: null,
          error: null,
          metadata: {
            contractVersion: MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
            consentId: consent.consentId,
            leaseId: scope.leaseId,
          },
          input: scopedAction.action,
          output: result,
        });
        options.store.recordEvent({
          type: "marketplace.runtime.execution.completed",
          traceId,
          workspaceSlug: organizationId,
          pluginId: input.selection.pluginId,
          actorId: `agent:${consent.agentId}`,
          rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
          payload: {
            consentId: consent.consentId,
            leaseId: scope.leaseId,
            usageId: usage.id,
          },
        });
        const response = runtimeResponse({
          ok: true,
          traceId,
          result,
          usageId: usage.id,
        });
        options.store.finishMarketplaceRuntimeOperation({
          id: operation.operation.id,
          status: "succeeded",
          response,
        });
        return response;
      } catch (error) {
        const detail = error instanceof Error && error.message === "runtime_result_too_large"
          ? "Provider result exceeded the bounded runtime response size."
          : "Provider dispatch may have completed; reconcile before retrying this idempotency key.";
        const usage = options.store.recordUsage({
          workspaceSlug: organizationId,
          pluginId: input.selection.pluginId,
          provider: listing.provider,
          sourceExecutor: listing.executionOwner,
          sourceActionKey: input.selection.actionKey,
          productCapabilityKey: `connector.${listing.executionOwner}.${listing.provider}.${input.selection.actionKey}`,
          scopesUsed: [consent.capability],
          status: "failed",
          runId: null,
          sessionId: null,
          error: error instanceof Error ? error.message : String(error),
          metadata: { consentId: consent.consentId, leaseId: scope.leaseId },
          input: scopedAction.action,
          output: null,
        });
        const response = runtimeResponse({
          ok: false,
          traceId,
          error: "runtime_operation_reconciliation_required",
          detail,
          usageId: usage.id,
        });
        options.store.finishMarketplaceRuntimeOperation({
          id: operation.operation.id,
          status: "reconciliation-required",
          response,
        });
        options.store.recordEvent({
          type: "marketplace.runtime.execution.failed",
          traceId,
          workspaceSlug: organizationId,
          pluginId: consent.pluginId,
          actorId: `agent:${consent.agentId}`,
          payload: {
            consentId: consent.consentId,
            leaseId: scope.leaseId,
            usageId: usage.id,
            reconciliationRequired: true,
          },
        });
        reply.code(502);
        return response;
      }
    },
  });

  app.post(
    "/api/marketplace/agent/grants/:grantId/revoke",
    async (request, reply) => {
      const principal = requestPrincipals.get(request);
      if (!principal || !["service", "operator"].includes(principal.kind)) {
        reply.code(403);
        return { ok: false, error: "marketplace_authority_required" };
      }
      const { grantId } = request.params as { grantId: string };
      const durableConsent = options.store.getMarketplaceAgentConsentById(grantId);
      if (durableConsent) {
        if (principal.organizationId !== durableConsent.productTenantId) {
          reply.code(403);
          return { ok: false, error: "agent_grant_tenant_mismatch" };
        }
        const revoked = options.store.revokeMarketplaceAgentConsent(grantId);
        const traceId = traceIdFrom(request);
        options.store.recordEvent({
          type: "marketplace.agent.consent.revoked",
          traceId,
          workspaceSlug: durableConsent.productTenantId,
          pluginId: durableConsent.pluginId,
          actorId:
            principal.kind === "operator"
              ? `operator:${principal.id}`
              : "marketplace-service",
          payload: {
            grantId,
            consentId: durableConsent.consentId,
            portalOrgId: durableConsent.portalOrgId,
            deploymentId: durableConsent.deploymentId,
          },
        });
        return {
          ok: true,
          schema: 1,
          traceId,
          grant: browserMarketplaceAgentConsent(revoked),
        };
      }
      const grant = options.store.getAgentConnectorGrant(grantId);
      if (!grant) {
        reply.code(404);
        return { ok: false, error: "agent_grant_not_found" };
      }
      if (principal.organizationId !== grant.workspaceSlug) {
        reply.code(403);
        return { ok: false, error: "agent_grant_tenant_mismatch" };
      }
      const revoked = options.store.revokeAgentConnectorGrant(grantId);
      const traceId = traceIdFrom(request);
      options.store.recordEvent({
        type: "marketplace.agent.grant.revoked",
        traceId,
        workspaceSlug: grant.workspaceSlug,
        pluginId: grant.pluginId,
        actorId:
          principal.kind === "operator"
            ? `operator:${principal.id}`
            : "marketplace-service",
        payload: {
          grantId,
          agentId: grant.agentId,
          accountId: grant.accountId,
          resourceKind: grant.resourceKind,
          resourceRef: grant.resourceRef,
        },
      });
      return {
        ok: true,
        traceId,
        grant:
          revoked && principal.kind === "operator"
            ? browserAgentConnectorGrant(revoked)
            : revoked
              ? sanitizeAgentConnectorGrant(revoked)
              : null,
      };
    },
  );

  app.get("/api/marketplace/agent/grants", async (request, reply) => {
    const principal = requireOperator(request, reply);
    if (!principal) return { ok: false, error: "marketplace_operator_required" };
    const query = AgentGrantListQuerySchema.parse(request.query);
    if (query.workspaceSlug !== principal.organizationId) {
      reply.code(403);
      return { ok: false, error: "agent_grant_tenant_mismatch" };
    }
    const grants = options.store.listAgentConnectorGrants({
      workspaceSlug: query.workspaceSlug,
      agentId: query.agentId,
      pluginId: query.pluginId,
      state: query.state,
      limit: query.limit,
    });
    return {
      contractVersion: MARKETPLACE_AGENT_GRANT_CONTRACT_VERSION,
      workspaceSlug: query.workspaceSlug,
      grants: grants.map(browserAgentConnectorGrant),
      handoffRequests: options.store
        .listMarketplacePortalGrantRequests({
          productTenantId: query.workspaceSlug,
          agentId: query.agentId,
        })
        .map(browserMarketplacePortalGrantRequest),
      consents: options.store
        .listMarketplaceAgentConsents({
          productTenantId: query.workspaceSlug,
          agentId: query.agentId,
          state: query.state,
        })
        .map(browserMarketplaceAgentConsent),
      handoffContractVersion: MARKETPLACE_PORTAL_HANDOFF_CONTRACT_VERSION,
      grantCreation: {
        available: false,
        code: "portal_handoff_required",
        detail:
          "Agent grants require a Portal-attested server-side handoff; raw agent or attachment credentials are never accepted from browser code.",
      },
    };
  });

  app.get("/api/marketplace/v1/agent/action-catalog", async (request, reply) => {
    const principal = requireHandoffPrincipal(request, reply);
    if (!principal) {
      return { ok: false, error: "marketplace_operator_required" };
    }
    // The principal-scope hook rewrites `workspaceSlug` in the parsed query,
    // so read what the caller actually sent from the raw URL.
    const rawQuery = new URLSearchParams(request.url.split("?")[1] ?? "");
    const requested = rawQuery.getAll("workspaceSlug");
    if (requested.length > 1) {
      reply.code(400);
      return { ok: false, error: "validation_failed" };
    }
    const requestedSlug = requested[0]?.trim() || null;
    if (principal.kind === "service" && !requestedSlug) {
      reply.code(400);
      return { ok: false, error: "workspace_slug_required" };
    }
    if (requestedSlug && requestedSlug !== principal.organizationId) {
      reply.code(403);
      return { ok: false, error: "agent_action_catalog_tenant_mismatch" };
    }
    const workspaceSlug = principal.organizationId;
    return {
      contractVersion: MARKETPLACE_AGENT_ACTION_CATALOG_CONTRACT_VERSION,
      workspaceSlug,
      actions: publishedAgentActionCatalog({ store: options.store, workspaceSlug }),
    };
  });

  app.get("/api/agent/capabilities", async (request, reply) => {
    const query = AgentCapabilitiesQuerySchema.parse(request.query);
    const capabilities = agentCapabilitiesForWorkspace(
      options.store,
      query.workspaceSlug,
      companyBox,
    );
    if (!query.grantId) {
      return { workspaceSlug: query.workspaceSlug, capabilities };
    }
    const grant = options.store.getAgentConnectorGrant(query.grantId);
    if (!grant) {
      reply.code(404);
      return { ok: false, error: "agent_grant_not_found" };
    }
    if (grant.workspaceSlug !== query.workspaceSlug) {
      reply.code(403);
      return { ok: false, error: "agent_grant_tenant_mismatch" };
    }
    const verified = await verifyAgentGrantScope({
      request,
      reply,
      grant,
      requiredCapability: grant.capability,
    });
    if (!verified.ok) {
      return { ok: false, error: verified.error };
    }
    return {
      workspaceSlug: query.workspaceSlug,
      grant: sanitizeAgentConnectorGrant(grant),
      capabilities: capabilities.filter(
        (capability) =>
          capability.pluginId === grant.pluginId &&
          capability.actionType === grant.actionKey,
      ),
    };
  });

  app.post("/api/agent/tools/:toolName", { bodyLimit: uploadBodyLimit }, async (request, reply) => {
    const { toolName } = request.params as { toolName: string };
    const body = z
      .object({
        workspaceSlug: z.string().trim().min(1),
        actorId: z.string().trim().min(1).default("agent"),
        pluginId: z.string().trim().min(1),
        input: z.record(z.unknown()).default({}),
        grantId: z.string().trim().min(1).optional(),
        resourceRef: z.string().trim().min(1).optional(),
        /** Repeating a held outward call with the same key returns its approval state or result. */
        idempotencyKey: IdempotencyKeySchema.optional(),
      })
      .parse(request.body);
    // Company Box meta tools: search/describe read the published operation
    // list; call resolves to one operation key, so grants, bindings and
    // approvals apply to that operation exactly as for a direct tool.
    const meta = parseCompanyBoxMetaTool(toolName);
    let actionType = meta ? null : actionForTool(toolName);
    let actionInput = body.input;
    if (meta) {
      const metaListing = options.store.getListingForWorkspace(body.pluginId, body.workspaceSlug);
      const entry =
        metaListing && metaListing.provider === meta.provider
          ? companyBoxEntryForListing(companyBox, metaListing, body.workspaceSlug)
          : null;
      if (!metaListing || !entry) {
        reply.code(404);
        return { ok: false, error: "agent_tool_not_found" };
      }
      if (meta.tool === "status") {
        // Only the agent that made the call can read its approval.
        const target = z.object({ approvalId: z.string().trim().min(1).max(100) }).strict().safeParse(body.input);
        if (!target.success) {
          reply.code(400);
          return { ok: false, error: "validation_failed" };
        }
        const approval = options.store.getCompanyBoxApproval(target.data.approvalId);
        if (!approval || approval.workspaceSlug !== body.workspaceSlug || approval.pluginId !== metaListing.pluginId) {
          reply.code(404);
          return { ok: false, error: "approval_not_found" };
        }
        const scope = await verifyPortalScope({ request, reply, requiredCapability: approval.capability });
        if (!scope.ok) return { ok: false, error: scope.error };
        if (scope.scope.agentId !== approval.agentId || scope.scope.organizationId !== approval.workspaceSlug) {
          reply.code(404);
          return { ok: false, error: "approval_not_found" };
        }
        return { ok: true, ...agentApprovalView(approval) };
      }
      const published = publishedAgentActionsForListing({
        store: options.store,
        workspaceSlug: body.workspaceSlug,
        listing: metaListing,
      });
      if (published.length === 0) {
        reply.code(404);
        return { ok: false, error: "agent_tool_not_available" };
      }
      const operations = published.map((published) => companyBoxAgentOperation(entry, metaListing, published));
      if (meta.tool === "search") {
        const search = CompanyBoxSearchSchema.safeParse(body.input);
        if (!search.success) {
          reply.code(400);
          return { ok: false, error: "validation_failed" };
        }
        return {
          ok: true,
          pluginId: metaListing.pluginId,
          exposure: entry.exposure,
          ...searchAgentOperations(operations, search.data),
        };
      }
      const target = CompanyBoxOperationInputSchema.safeParse(body.input);
      if (!target.success) {
        reply.code(400);
        return { ok: false, error: "validation_failed" };
      }
      if (!operations.some((operation) => operation.key === target.data.operation)) {
        reply.code(404);
        return { ok: false, error: "company_box_operation_not_found" };
      }
      if (meta.tool === "describe") {
        return {
          ok: true,
          pluginId: metaListing.pluginId,
          operation: describeCompanyBoxOperation(entry, metaListing, target.data.operation),
        };
      }
      actionType = target.data.operation;
      actionInput = target.data.arguments ?? {};
    }
    if (!actionType) {
      reply.code(404);
      return { ok: false, error: "agent_tool_not_found" };
    }
    const listing = options.store.getListingForWorkspace(
      body.pluginId,
      body.workspaceSlug,
    );
    const requirement = listing
      ? resolveActionRequirement(listing, actionType)
      : null;
    if (!requirement) {
      reply.code(404);
      return { ok: false, error: "agent_tool_not_registered" };
    }
    let grant: AgentConnectorGrant | null = null;
    if (body.grantId) {
      grant = options.store.getAgentConnectorGrant(body.grantId);
      if (!grant) {
        reply.code(404);
        return { ok: false, error: "agent_grant_not_found" };
      }
      if (
        grant.workspaceSlug !== body.workspaceSlug ||
        grant.pluginId !== body.pluginId ||
        grant.actionKey !== actionType ||
        grant.capability !== requirement.capability
      ) {
        reply.code(403);
        return { ok: false, error: "agent_grant_scope_mismatch" };
      }
      const verified = await verifyAgentGrantScope({
        request,
        reply,
        grant,
        requiredCapability: requirement.capability,
      });
      if (!verified.ok) {
        return { ok: false, error: verified.error };
      }
      if (body.resourceRef && body.resourceRef !== grant.resourceRef) {
        reply.code(403);
        return { ok: false, error: "resource_mismatch" };
      }
    }
    const available =
      meta !== null ||
      agentCapabilitiesForWorkspace(
        options.store,
        body.workspaceSlug,
        companyBox,
      ).some(
        (capability) =>
          capability.toolName === toolName &&
          capability.pluginId === body.pluginId,
      );
    if (!available) {
      reply.code(404);
      return { ok: false, error: "agent_tool_not_available" };
    }
    const injected = await app.inject({
      method: "POST",
      url: `/api/marketplace/plugins/${encodeURIComponent(body.pluginId)}/execute`,
      headers: {
        "x-trace-id": traceIdFrom(request),
        ...(options.internalAuthToken
          ? { authorization: `Bearer ${options.internalAuthToken}` }
          : {}),
        ...(headerValue(request, "x-tealbrick-agent-token")
          ? { "x-tealbrick-agent-token": headerValue(request, "x-tealbrick-agent-token")! }
          : {}),
        ...(headerValue(request, "x-tealbrick-attachment")
          ? { "x-tealbrick-attachment": headerValue(request, "x-tealbrick-attachment")! }
          : {}),
      },
      payload: {
        workspaceSlug: body.workspaceSlug,
        actorId: body.actorId,
        capability: requirement.capability,
        ...(grant
          ? { agentGrantId: grant.id, resourceRef: grant.resourceRef }
          : {}),
        ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
        action: { ...actionInput, type: actionType },
      },
    });
    reply.code(injected.statusCode);
    return injected.json();
  });

  app.post("/api/marketplace/broker/grants", async (request, reply) => {
    if (!requireService(request, reply)) {
      return { ok: false, error: "marketplace_service_required" };
    }
    const input = BrokerGrantInputSchema.parse(request.body);
    const traceId = traceIdFrom(request);
    const listing = options.store.getListing(input.pluginId);
    if (!listing) {
      reply.code(404);
      return { ok: false, error: "plugin_not_found" };
    }
    if (listing.executionOwner !== "composio") {
      reply.code(409);
      return { ok: false, error: "plugin_not_composio_backed" };
    }
    const install = options.store.getInstall(
      input.workspaceSlug,
      listing.pluginId,
    );
    if (!install || !install.enabled || install.lifecycle !== "installed") {
      reply.code(409);
      return { ok: false, error: "plugin_not_installed" };
    }
    const connection = options.store.getConnection(
      input.workspaceSlug,
      listing.pluginId,
    );
    if (connection?.state !== "connected") {
      reply.code(409);
      return {
        ok: false,
        error: "connector_not_connected",
        provider: listing.provider,
      };
    }
    const actionRequirements = input.actionKeys.map((actionKey) => {
      if (!listing.actions.includes(actionKey)) {
        return { actionKey, requirement: null };
      }
      return {
        actionKey,
        requirement: resolveActionRequirement(listing, actionKey),
      };
    });
    const unknownAction = actionRequirements.find(
      (entry) => entry.requirement === null,
    );
    if (unknownAction) {
      reply.code(404);
      return {
        ok: false,
        error: "plugin_action_not_found",
        actionKey: unknownAction.actionKey,
      };
    }
    const disabledAction = input.actionKeys.find(
      (actionKey) =>
        !options.store.isActionEnabled({
          workspaceSlug: input.workspaceSlug,
          pluginId: listing.pluginId,
          actionKey,
        }),
    );
    if (disabledAction) {
      reply.code(403);
      return {
        ok: false,
        error: "connector_action_denied",
        actionKey: disabledAction,
      };
    }
    const capabilities = [
      ...new Set(
        actionRequirements.map((entry) => entry.requirement!.capability),
      ),
    ];
    const unboundCapability = capabilities.find((capability) => {
      try {
        return !options.store.requireCapabilityBinding(
          input.workspaceSlug,
          listing.pluginId,
          capability,
        ).enabled;
      } catch {
        return true;
      }
    });
    if (unboundCapability) {
      reply.code(403);
      return {
        ok: false,
        error: "connector_capability_denied",
        capability: unboundCapability,
      };
    }
    const rules = await enforceRules({
      reply,
      workspaceSlug: input.workspaceSlug,
      operation: "broker.grant",
      capability: highestCapability(capabilities),
      pluginId: listing.pluginId,
      actorId: input.actorId,
      payload: {
        requesterMiniappId: input.requesterMiniappId,
        actionKeys: input.actionKeys,
        metadata: input.metadata,
        ...(recordValue(input.metadata.crossApp)
          ? {
              crossApp: recordValue(input.metadata.crossApp),
              contractVersion: stringValue(
                recordValue(input.metadata.crossApp)?.contractVersion,
              ),
              sourceMiniappId: stringValue(
                recordValue(input.metadata.crossApp)?.sourceMiniappId,
              ),
              idempotencyKey: stringValue(
                recordValue(input.metadata.crossApp)?.idempotencyKey,
              ),
            }
          : {}),
        traceId,
      },
      actor: principalActor(request),
        ...governed,
    });
    if ("ok" in rules && rules.ok === false) {
      return { ...rules, traceId };
    }
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    if (!providers.composio.configured) {
      reply.code(409);
      return {
        ok: false,
        error: "composio_unavailable",
        detail: providers.composio.detail,
      };
    }
    const token = createBrokerToken();
    const grant = options.store.createBrokerGrant({
      workspaceSlug: input.workspaceSlug,
      requesterMiniappId: input.requesterMiniappId,
      pluginId: listing.pluginId,
      actionKeys: input.actionKeys,
      capabilities,
      tokenHash: brokerTokenHash(token),
      expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
      metadata: {
        ...input.metadata,
        traceId,
        provider: listing.provider,
        rawSecretStored: false,
      },
    });
    options.store.recordEvent({
      type: "marketplace.broker.grant.created",
      traceId,
      workspaceSlug: input.workspaceSlug,
      pluginId: listing.pluginId,
      actorId: input.actorId,
      rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
      payload: {
        grantId: grant.id,
        requesterMiniappId: input.requesterMiniappId,
        actionKeys: input.actionKeys,
        capabilities,
        rawSecretReturned: false,
      },
    });
    reply.code(201);
    return {
      ok: true,
      traceId,
      token,
      grant: sanitizeBrokerGrant(grant),
      rules,
    };
  });

  app.post(
    "/api/marketplace/broker/composio/execute",
    async (request, reply) => {
      const input = BrokerExecuteInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const grant = options.store.getBrokerGrantByTokenHash(
        brokerTokenHash(input.brokerToken),
      );
      if (!grant || grant.state !== "active") {
        reply.code(401);
        return { ok: false, error: "broker_grant_not_found", traceId };
      }
      if (brokerGrantIsExpired(grant)) {
        reply.code(401);
        return { ok: false, error: "broker_grant_expired", traceId };
      }
      if (
        grant.workspaceSlug !== input.workspaceSlug ||
        grant.pluginId !== input.pluginId ||
        grant.requesterMiniappId !== input.requesterMiniappId
      ) {
        reply.code(403);
        return { ok: false, error: "broker_grant_scope_mismatch", traceId };
      }
      if (!grant.actionKeys.includes(input.action.type)) {
        reply.code(403);
        return {
          ok: false,
          error: "broker_action_not_granted",
          traceId,
          actionKey: input.action.type,
        };
      }
      const listing = options.store.getListing(input.pluginId);
      const requirement = listing
        ? resolveActionRequirement(listing, input.action.type)
        : null;
      if (!listing || listing.executionOwner !== "composio" || !requirement) {
        reply.code(404);
        return { ok: false, error: "broker_tool_not_registered", traceId };
      }
      if (!grant.capabilities.includes(requirement.capability)) {
        reply.code(403);
        return {
          ok: false,
          error: "broker_capability_not_granted",
          traceId,
          capability: requirement.capability,
        };
      }
      if (!options.store.consumeBrokerGrant(grant.id)) {
        reply.code(401);
        return { ok: false, error: "broker_grant_already_used", traceId };
      }
      const injected = await app.inject({
        method: "POST",
        url: `/api/marketplace/plugins/${encodeURIComponent(input.pluginId)}/execute`,
        headers: {
          "x-trace-id": traceId,
          ...(options.internalAuthToken
            ? { authorization: `Bearer ${options.internalAuthToken}` }
            : {}),
        },
        payload: {
          workspaceSlug: input.workspaceSlug,
          actorId: `miniapp:${input.requesterMiniappId}`,
          capability: requirement.capability,
          action: input.action,
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
        },
      });
      const result = injected.json<Record<string, unknown>>();
      options.store.recordEvent({
        type:
          injected.statusCode >= 200 && injected.statusCode < 300
            ? "marketplace.broker.execution.completed"
            : "marketplace.broker.execution.failed",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId: input.pluginId,
        actorId: input.requesterMiniappId,
        payload: {
          grantId: grant.id,
          grantConsumed: true,
          requesterMiniappId: input.requesterMiniappId,
          actionKey: input.action.type,
          statusCode: injected.statusCode,
          rawSecretReturned: false,
        },
      });
      reply.code(injected.statusCode);
      return {
        ...result,
        broker: {
          grantId: grant.id,
          requesterMiniappId: input.requesterMiniappId,
          pluginId: input.pluginId,
          actionKey: input.action.type,
          rawSecretReturned: false,
        },
      };
    },
  );

  app.post(
    "/api/marketplace/v1/broker/composio/execute",
    async (request, reply) => {
      const authFailure = requireCrossAppBearerAuth({
        expectedToken: options.internalAuthToken,
        reply,
        request,
      });
      if (authFailure) {
        return authFailure;
      }

      const input = CrossAppBrokerExecuteInputSchema.parse(request.body);
      if (
        input.requesterMiniappId &&
        input.requesterMiniappId !== input.sourceMiniappId
      ) {
        reply.code(400);
        return {
          ok: false,
          error: "cross_app_requester_source_mismatch",
          traceId: input.traceId,
        };
      }

      const crossApp = {
        contractVersion: input.contractVersion,
        sourceMiniappId: input.sourceMiniappId,
        sourceId: input.sourceId,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        traceId: input.traceId,
      };
      const requesterMiniappId = input.sourceMiniappId;
      const grantResponse = await app.inject({
        method: "POST",
        url: "/api/marketplace/broker/grants",
        headers: {
          "x-trace-id": input.traceId,
          ...(options.internalAuthToken
            ? { authorization: `Bearer ${options.internalAuthToken}` }
            : {}),
        },
        payload: {
          workspaceSlug: input.workspaceSlug,
          actorId: `miniapp:${requesterMiniappId}`,
          requesterMiniappId,
          pluginId: input.pluginId,
          actionKeys: [input.action.type],
          ttlSeconds: input.ttlSeconds,
          metadata: {
            ...input.metadata,
            crossApp,
          },
        },
      });
      const grantResult = grantResponse.json<Record<string, unknown>>();
      if (grantResponse.statusCode < 200 || grantResponse.statusCode >= 300) {
        reply.code(grantResponse.statusCode);
        return {
          ...grantResult,
          crossApp,
        };
      }

      const brokerToken =
        typeof grantResult.token === "string" ? grantResult.token : null;
      if (!brokerToken) {
        reply.code(502);
        return {
          ok: false,
          error: "cross_app_broker_token_missing",
          traceId: input.traceId,
          crossApp,
        };
      }

      const executeResponse = await app.inject({
        method: "POST",
        url: "/api/marketplace/broker/composio/execute",
        headers: {
          "x-trace-id": input.traceId,
          ...(options.internalAuthToken
            ? { authorization: `Bearer ${options.internalAuthToken}` }
            : {}),
        },
        payload: {
          workspaceSlug: input.workspaceSlug,
          requesterMiniappId,
          pluginId: input.pluginId,
          brokerToken,
          action: input.action,
          runId: input.runId ?? null,
          sessionId: input.sessionId ?? null,
        },
      });
      reply.code(executeResponse.statusCode);
      return {
        ...executeResponse.json<Record<string, unknown>>(),
        crossApp,
      };
    },
  );

  app.get("/api/marketplace/provider-health", async (request) => {
    const traceId = traceIdFrom(request);
    const query = z
      .object({
        workspaceSlug: z.string().trim().min(1).optional(),
      })
      .parse(request.query);
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    options.store.recordEvent({
      type: "marketplace.provider.health",
      traceId,
      workspaceSlug: query.workspaceSlug ?? null,
      payload: { providers },
    });
    return { traceId, providers };
  });

  app.get("/api/marketplace/audit", async (request) => {
    const query = AuditQuerySchema.parse(request.query);
    return {
      usage: query.workspaceSlug
        ? options.store.listUsage({
            workspaceSlug: query.workspaceSlug,
            provider: query.provider,
            limit: query.limit,
          })
        : [],
      audit: options.store.listAudit(query),
    };
  });

  app.post("/api/marketplace/session-correlations", async (request, reply) => {
    const input = SessionCorrelationInputSchema.parse(request.body);
    const remoteSessionId =
      input.remoteSessionId ??
      input.hermesStoredSessionId ??
      input.hermesLiveSessionId;
    if (!remoteSessionId) {
      reply.code(400);
      return {
        ok: false,
        error: "remote_session_id_required",
        detail:
          "Provide remoteSessionId, hermesStoredSessionId, or hermesLiveSessionId.",
      };
    }
    const correlation = options.store.recordSessionCorrelation({
      workspaceSlug: input.workspaceSlug,
      appThreadId: input.appThreadId,
      provider: input.provider,
      providerInstanceId: input.providerInstanceId,
      remoteSessionId,
      hermesLiveSessionId: input.hermesLiveSessionId ?? null,
      hermesStoredSessionId: input.hermesStoredSessionId ?? null,
      profile: input.profile ?? null,
      runtimeMode: input.runtimeMode ?? null,
      cwd: input.cwd ?? null,
      source: input.source,
      eventType: input.eventType,
      metadata: input.metadata,
    });
    options.store.recordEvent({
      type: "marketplace.agent.session-correlated",
      traceId: traceIdFrom(request),
      workspaceSlug: input.workspaceSlug,
      pluginId: "marketplace",
      payload: {
        appThreadId: correlation.appThreadId,
        providerInstanceId: correlation.providerInstanceId,
        remoteSessionId: correlation.remoteSessionId,
        hermesStoredSessionId: correlation.hermesStoredSessionId,
        hermesLiveSessionId: correlation.hermesLiveSessionId,
      },
    });
    reply.code(201);
    return { ok: true, correlation };
  });

  app.get("/api/marketplace/session-correlations", async (request) => {
    const query = SessionCorrelationQuerySchema.parse(request.query);
    return {
      correlations: options.store.listSessionCorrelations(query),
    };
  });

  app.get("/api/debug/events", async (request) => {
    const query = AuditQuerySchema.parse(request.query);
    return {
      debug: {
        enabled: options.debug ?? compatDebugEnabled(),
        logPath: options.logPath ?? options.store.describeRuntime().logPath,
      },
      storage: options.store.describeRuntime(),
      events: options.store.listEvents(query),
    };
  });

  app.get("/api/debug/logs", async (request, reply) => {
    if (!requireService(request, reply)) {
      return { ok: false, error: "marketplace_service_bearer_required" };
    }
    const query = z
      .object({
        tail: z.coerce.number().int().positive().max(500).default(100),
      })
      .parse(request.query);
    const runtime = options.store.describeRuntime();
    if (!runtime.logPath) {
      return { debug: { enabled: false, logPath: null }, lines: [] };
    }
    try {
      const text = await readFile(runtime.logPath, "utf8");
      return {
        debug: {
          enabled: runtime.debug,
          logPath: runtime.logPath,
        },
        lines: text.trim().split("\n").filter(Boolean).slice(-query.tail),
      };
    } catch (error) {
      reply.code(404);
      return {
        ok: false,
        error: "debug_log_not_found",
        logPath: runtime.logPath,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.get("/api/marketplace/catalog/activepieces", async (request, reply) => {
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    if (!providers.activepieces.baseUrl || !providers.activepieces.reachable) {
      reply.code(409);
      return {
        ok: false,
        error: "activepieces_unavailable",
        detail: providers.activepieces.detail,
      };
    }
    try {
      const catalog = await fetchActivepiecesCatalog(
        providerEnvironment(),
        options.providerFetch,
      );
      return { ok: true, provider: "activepieces", ...catalog };
    } catch (error) {
      reply.code(502);
      return {
        ok: false,
        error: "activepieces_catalog_fetch_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.post(
    "/api/marketplace/catalog/activepieces/scaffold",
    async (request, reply) => {
      const payload = (request.body ?? {}) as Record<string, unknown>;
      const workspaceSlug = String(payload.workspaceSlug ?? "");
      const rules = await enforceRules({
        reply,
        workspaceSlug,
        operation: "activepieces.scaffold",
        capability: "connector.admin",
        pluginId: "activepieces-pack-generator",
        actorId: String(payload.actorId ?? "operator"),
        payload,
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return rules;
      }
      const providers = await readProviderHealthWithReachability(
        providerEnvironment(),
        options.providerFetch,
      );
      if (!providers.activepieces.configured) {
        reply.code(409);
        return {
          ok: false,
          error: "activepieces_unavailable",
          detail: providers.activepieces.detail,
        };
      }
      return { ok: true, scaffold: null, rules };
    },
  );

  app.get("/api/marketplace/catalog/composio", async (request, reply) => {
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    if (!providers.composio.configured) {
      reply.code(409);
      return {
        ok: false,
        error: "composio_unavailable",
        detail: providers.composio.detail,
      };
    }
    try {
      const catalog = await fetchComposioCatalog(
        providerEnvironment(),
        options.providerFetch,
      );
      return { ok: true, provider: "composio", ...catalog };
    } catch (error) {
      reply.code(502);
      return {
        ok: false,
        error: "composio_catalog_fetch_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.get("/api/marketplace/catalog/composio/tools", async (request, reply) => {
    const query = ComposioToolsQuerySchema.parse(request.query);
    const providers = await readProviderHealthWithReachability(
      providerEnvironment(),
      options.providerFetch,
    );
    if (!providers.composio.configured) {
      reply.code(409);
      return {
        ok: false,
        error: "composio_unavailable",
        detail: providers.composio.detail,
      };
    }
    try {
      const upstreamToolkit = query.toolkit.trim();
      const toolkit = normalizeConnectorSlug(upstreamToolkit);
      const catalog = await fetchComposioToolkitTools({
        toolkit: upstreamToolkit,
        limit: query.limit,
        env: providerEnvironment(),
        fetchImpl: options.providerFetch,
      });
      const tools = normalizeComposioTools(toolkit, catalog.items);
      return {
        ok: true,
        provider: "composio",
        toolkit,
        upstreamToolkit,
        total: catalog.total,
        items: catalog.items,
        tools: tools.map((tool) => ({
          ...tool,
          actionKey: tool.action,
        })),
        skills: defaultSkillsForComposioToolkit(toolkit),
      };
    } catch (error) {
      reply.code(502);
      return {
        ok: false,
        error: "composio_toolkit_tools_fetch_failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.post(
    "/api/marketplace/catalog/composio/import",
    async (request, reply) => {
      const input = ComposioImportInputSchema.parse(request.body);
      const traceId = traceIdFrom(request);
      const rules = await enforceRules({
        reply,
        workspaceSlug: input.workspaceSlug,
        operation: "composio.import",
        capability: "connector.admin",
        pluginId: "composio-bootstrap",
        actorId: input.actorId,
        payload: { ...(request.body as Record<string, unknown>), traceId },
        actor: principalActor(request),
        ...governed,
      });
      if ("ok" in rules && rules.ok === false) {
        return { ...rules, traceId };
      }
      const providers = await readProviderHealthWithReachability(
        providerEnvironment(),
        options.providerFetch,
      );
      if (!providers.composio.configured) {
        reply.code(409);
        return {
          ok: false,
          error: "composio_unavailable",
          detail: providers.composio.detail,
        };
      }
      const upstreamToolkit = input.toolkit.trim();
      const toolkit = normalizeConnectorSlug(upstreamToolkit);
      const fetchedTools =
        input.tools ??
        (
          await fetchComposioToolkitTools({
            toolkit: upstreamToolkit,
            env: providerEnvironment(),
            fetchImpl: options.providerFetch,
          })
        ).items;
      const selectedActions =
        input.actionKeys?.map((action) => action.trim()).filter(Boolean) ?? [];
      if (selectedActions.length > 0) {
        const normalizedTools = normalizeComposioTools(toolkit, fetchedTools);
        const knownActions = new Set(
          normalizedTools.flatMap((tool) => [tool.action, tool.toolName]),
        );
        const unknownActions = selectedActions.filter(
          (action) => !knownActions.has(action),
        );
        if (unknownActions.length > 0) {
          reply.code(400);
          return {
            ok: false,
            error: "unknown_composio_action_keys",
            actionKeys: unknownActions,
          };
        }
      }
      const listing = buildComposioListingFromTools({
        toolkit,
        upstreamToolkit,
        pluginId: input.pluginId,
        displayName: input.displayName,
        description: input.description,
        tools: fetchedTools,
        selectedActions,
        skills: input.skills,
      });
      options.store.upsertListing(listing);

      let registration: ReturnType<
        SqliteMarketplaceStore["registerPlugin"]
      > | null = null;
      let install: ReturnType<SqliteMarketplaceStore["install"]> | null = null;
      const bindings = [];
      if (input.autoEnable) {
        registration = options.store.registerPlugin(listing.pluginId);
        install = options.store.install(input.workspaceSlug, listing.pluginId);
        const capabilities = input.bindCapabilities ?? listing.capabilities;
        for (const capability of capabilities) {
          bindings.push(
            options.store.bindCapability({
              workspaceSlug: input.workspaceSlug,
              pluginId: listing.pluginId,
              capability,
              enabled: true,
            }),
          );
        }
      }
      const actionBindings = listing.actions.map((actionKey) =>
        options.store.bindAction({
          workspaceSlug: input.workspaceSlug,
          pluginId: listing.pluginId,
          actionKey,
          enabled: true,
        }),
      );
      const importRecord = options.store.upsertComposioImport({
        workspaceSlug: input.workspaceSlug,
        pluginId: listing.pluginId,
        toolkit,
        importedActionKeys: listing.actions,
        lifecycle: input.autoEnable ? "enabled" : "imported",
        metadata: {
          traceId,
          source: input.tools ? "request" : "composio",
          toolCount: fetchedTools.length,
          providerConfigured: providers.composio.configured,
        },
      });
      options.store.recordEvent({
        type: "marketplace.composio.toolkit.imported",
        traceId,
        workspaceSlug: input.workspaceSlug,
        pluginId: listing.pluginId,
        actorId: input.actorId,
        rulesDecisionId: "decisionId" in rules ? rules.decisionId : null,
        payload: {
          toolkit,
          actions: listing.actions,
          lifecycle: importRecord.lifecycle,
          autoEnable: input.autoEnable,
        },
      });
      reply.code(201);
      return {
        ok: true,
        traceId,
        listing,
        import: importRecord,
        registration,
        install,
        bindings,
        actionBindings,
        rules,
      };
    },
  );

  app.post("/api/runtime/plugins/:pluginId/execute", async (request, reply) => {
    reply.code(501);
    return {
      ok: false,
      error: "runtime_execute_adapter_not_wired",
      detail:
        "Use /api/marketplace/plugins/:pluginId/execute in the standalone candidate. App runtime adapter wiring is pending.",
    };
  });

  return app;
}

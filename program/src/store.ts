import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  nativeConnectorListings,
  providerBackedListings,
} from "./connectors.js";
import type {
  ActionBinding,
  AgentConnectorGrant,
  CapabilityBinding,
  CompanyBoxApproval,
  ComposioImportRecord,
  ConnectorCapability,
  ConnectorConnection,
  CredentialRef,
  ConnectorUsageLedgerEntry,
  MarketplaceBrokerGrant,
  MarketplaceAgentConsent,
  MarketplaceListing,
  MarketplaceEventEnvelope,
  MarketplacePortalGrantRequest,
  MarketplacePortalHandoffSession,
  MarketplaceRuntimeOperation,
  WorkspacePluginInstall,
} from "./types.js";
import { boundedStoredOutput, shapeOf } from "./usage-ledger.js";
import { compatDebugEnabled } from "./legacy-ids.js";
import {
  CHANNEL_TABLES,
  ChannelStore,
  migrateChannelTables,
} from "./channels/store.js";

export const MARKETPLACE_TABLES = [
  "marketplace_listing",
  "plugin_registry",
  "workspace_plugin_install",
  "plugin_capability_binding",
  "plugin_action_binding",
  "connector_connection",
  "agent_connector_grant",
  "marketplace_portal_handoff_session",
  "marketplace_portal_grant_request",
  "marketplace_agent_consent",
  "marketplace_runtime_operation",
  "credential_ref",
  "connector_secret",
  "activepieces_pack_binding",
  "composio_import",
  "connector_usage_ledger",
  "agent_session_correlation",
  "broker_grant",
  "promotion_candidate",
  "health_event",
  "audit_event",
  "company_box_approval",
  ...CHANNEL_TABLES,
] as const;

type JsonRecord = Record<string, unknown>;

type StoreOptions = {
  logPath?: string;
  debug?: boolean;
  handoffEncryptionKey?: string;
};

const SECRET_CIPHERTEXT_PREFIX = "v1:";

/**
 * AES-256-GCM key shared by every encrypted-at-rest Marketplace value (Portal
 * handoff session tokens and operator connector secrets). Accepts a 32-byte
 * base64url value or a 64-character hex value.
 */
function encryptionKeyFromSecret(secret?: string): Buffer | null {
  const value = secret?.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/iu.test(value)) {
    return Buffer.from(value, "hex");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32) {
    throw new Error(
      "MARKETPLACE_HANDOFF_ENCRYPTION_KEY must be a 32-byte base64url value or 64-character hex value.",
    );
  }
  return decoded;
}

function encryptSecretValue(plaintext: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    SECRET_CIPHERTEXT_PREFIX.slice(0, -1),
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

function decryptSecretValue(value: string, key: Buffer, label: string) {
  const [version, ivValue, authTagValue, ciphertextValue] = value.split(":");
  if (
    `${version}:` !== SECRET_CIPHERTEXT_PREFIX ||
    !ivValue ||
    !authTagValue ||
    !ciphertextValue
  ) {
    throw new Error(`${label} has an invalid format.`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function isEncryptedSecretValue(value: string) {
  return value.startsWith(SECRET_CIPHERTEXT_PREFIX);
}

function encryptPortalHandoffToken(token: string, key: Buffer) {
  return encryptSecretValue(token, key);
}

function decryptPortalHandoffToken(value: string, key: Buffer) {
  return decryptSecretValue(value, key, "Stored Portal handoff session token");
}

function isEncryptedPortalHandoffToken(value: string) {
  return isEncryptedSecretValue(value);
}

/** Raised when a connector secret is written or read without the encryption key. */
export class ConnectorSecretStoreUnavailableError extends Error {
  readonly code = "connector_secret_store_unavailable";
  constructor() {
    super(
      "MARKETPLACE_HANDOFF_ENCRYPTION_KEY is required to store connector secrets.",
    );
  }
}

export type ConnectorSecretMetadata = {
  id: string;
  workspaceSlug: string;
  pluginId: string;
  name: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
};

function connectorSecretMetadataFromRow(
  row: Record<string, unknown>,
): ConnectorSecretMetadata {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    name: String(row.name),
    fingerprint: String(row.fingerprint),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function jsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  return JSON.parse(value) as T;
}

function listingFromRow(row: Record<string, unknown>): MarketplaceListing {
  return {
    pluginId: String(row.plugin_id),
    displayName: String(row.display_name),
    kind: row.kind as MarketplaceListing["kind"],
    provider: String(row.provider),
    description: String(row.description),
    capabilities: jsonParse<ConnectorCapability[]>(
      String(row.capabilities),
      [],
    ),
    actions: jsonParse<string[]>(String(row.actions), []),
    source: row.source as MarketplaceListing["source"],
    authOwner: row.auth_owner as MarketplaceListing["authOwner"],
    executionOwner: row.execution_owner as MarketplaceListing["executionOwner"],
    runtimeSources: jsonParse<MarketplaceListing["runtimeSources"]>(
      String(row.runtime_sources_json),
      [],
    ),
    enabledByDefault: Number(row.enabled_by_default) === 1,
    manifest: jsonParse<JsonRecord>(String(row.manifest_json), {}),
    ...(row.workspace_slug === null || row.workspace_slug === undefined
      ? {}
      : { ownerWorkspaceSlug: String(row.workspace_slug) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function installFromRow(row: Record<string, unknown>): WorkspacePluginInstall {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    enabled: Number(row.enabled) === 1,
    lifecycle: row.lifecycle as WorkspacePluginInstall["lifecycle"],
    installedAt: String(row.installed_at),
    updatedAt: String(row.updated_at),
  };
}

function bindingFromRow(row: Record<string, unknown>): CapabilityBinding {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    capability: row.capability as ConnectorCapability,
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function actionBindingFromRow(row: Record<string, unknown>): ActionBinding {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    actionKey: String(row.action_key),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function connectionFromRow(row: Record<string, unknown>): ConnectorConnection {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    provider: String(row.provider),
    backend: row.backend as ConnectorConnection["backend"],
    state: row.state as ConnectorConnection["state"],
    detail: String(row.detail),
    metadata: jsonParse<JsonRecord>(String(row.metadata), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function agentConnectorGrantFromRow(
  row: Record<string, unknown>,
): AgentConnectorGrant {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    agentId: String(row.agent_id),
    pluginId: String(row.plugin_id),
    actionKey: String(row.action_key),
    capability: row.capability as ConnectorCapability,
    connectionId: String(row.connection_id),
    accountId: String(row.account_id),
    resourceKind: String(row.resource_kind),
    resourceRef: String(row.resource_ref),
    attachmentId: String(row.attachment_id),
    state: row.state as AgentConnectorGrant["state"],
    expiresAt: String(row.expires_at),
    metadata: jsonParse<JsonRecord>(String(row.metadata), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function portalHandoffSessionFromRow(
  row: Record<string, unknown>,
  sessionToken: string,
): MarketplacePortalHandoffSession {
  return {
    id: String(row.id),
    portalIssuer: String(row.portal_issuer),
    deploymentId: String(row.deployment_id),
    portalOrgId: String(row.portal_org_id),
    productTenantId: String(row.product_tenant_id),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    sessionToken,
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function marketplaceAgentConsentFromRow(
  row: Record<string, unknown>,
): MarketplaceAgentConsent {
  return {
    id: String(row.id),
    portalIssuer: String(row.portal_issuer),
    portalOrgId: String(row.portal_org_id),
    productTenantId: String(row.product_tenant_id),
    workspaceId: String(row.workspace_id),
    deploymentId: String(row.deployment_id),
    userId: String(row.user_id),
    agentId: String(row.agent_id),
    consentId: String(row.consent_id),
    consentRevision: Number(row.consent_revision),
    pluginId: String(row.plugin_id),
    actionKey: String(row.action_key),
    capability: row.capability as MarketplaceAgentConsent["capability"],
    connectionId: String(row.connection_id),
    accountId: String(row.account_id),
    resourceKind: String(row.resource_kind),
    resourceRef: String(row.resource_ref),
    state: row.state as MarketplaceAgentConsent["state"],
    capabilities: jsonParse<MarketplaceAgentConsent["capabilities"]>(
      String(row.capabilities),
      [],
    ),
    requiredActions: jsonParse<string[]>(String(row.required_actions), []),
    metadata: jsonParse<JsonRecord>(String(row.metadata), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function marketplaceRuntimeOperationFromRow(
  row: Record<string, unknown>,
): MarketplaceRuntimeOperation {
  return {
    id: String(row.id),
    consentId: String(row.consent_id),
    idempotencyKey: String(row.idempotency_key),
    fingerprint: String(row.fingerprint),
    status: row.status as MarketplaceRuntimeOperation["status"],
    response:
      row.response_json === null
        ? null
        : jsonParse<JsonRecord>(String(row.response_json), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function marketplacePortalGrantRequestFromRow(
  row: Record<string, unknown>,
): MarketplacePortalGrantRequest {
  return {
    id: String(row.id),
    portalIssuer: String(row.portal_issuer),
    portalOrgId: String(row.portal_org_id),
    productTenantId: String(row.product_tenant_id),
    workspaceId: String(row.workspace_id),
    deploymentId: String(row.deployment_id),
    agentId: String(row.agent_id),
    requestId: String(row.request_id),
    approvalUrl: String(row.approval_url),
    expiresAt: String(row.expires_at),
    idempotencyKey: String(row.idempotency_key),
    selection: jsonParse<MarketplacePortalGrantRequest["selection"]>(
      String(row.selection_json),
      {
        pluginId: "",
        actionKey: "",
        accountId: "",
        resourceKind: "",
        resourceRef: "",
      },
    ),
    state: row.state as MarketplacePortalGrantRequest["state"],
    consentId: row.consent_id === null ? null : String(row.consent_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function credentialRefFromRow(row: Record<string, unknown>): CredentialRef {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    providerHint: String(row.provider_hint),
    secretRefKey: String(row.secret_ref_key),
    externalRef: row.external_ref === null ? null : String(row.external_ref),
    state: row.state as CredentialRef["state"],
    detail: String(row.detail),
    metadata: jsonParse<JsonRecord>(String(row.metadata), {}),
    configuredAt: row.configured_at === null ? null : String(row.configured_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function composioImportFromRow(
  row: Record<string, unknown>,
): ComposioImportRecord {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    toolkit: String(row.toolkit),
    importedActionKeys: jsonParse<string[]>(
      String(row.imported_action_keys),
      [],
    ),
    lifecycle: row.lifecycle as ComposioImportRecord["lifecycle"],
    metadata: jsonParse<JsonRecord>(String(row.metadata), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function usageFromRow(row: Record<string, unknown>): ConnectorUsageLedgerEntry {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    provider: String(row.provider),
    sourceExecutor:
      row.source_executor as ConnectorUsageLedgerEntry["sourceExecutor"],
    sourceActionKey: String(row.source_action_key),
    productCapabilityKey: String(row.product_capability_key),
    inputShape: jsonParse<JsonRecord>(String(row.input_shape), {}),
    outputShape: jsonParse<JsonRecord>(String(row.output_shape), {}),
    scopesUsed: jsonParse<string[]>(String(row.scopes_used), []),
    status: row.status as ConnectorUsageLedgerEntry["status"],
    runId: row.run_id === null ? null : String(row.run_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    error: row.error === null ? null : String(row.error),
    metadata:
      row.metadata === null
        ? null
        : jsonParse<JsonRecord>(String(row.metadata), {}),
    createdAt: String(row.created_at),
  };
}

function companyBoxApprovalFromRow(row: Record<string, unknown>): CompanyBoxApproval {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    pluginId: String(row.plugin_id),
    actionKey: String(row.action_key),
    capability: row.capability as CompanyBoxApproval["capability"],
    agentId: String(row.agent_id),
    sourceKind: row.source_kind as CompanyBoxApproval["sourceKind"],
    sourceRef: String(row.source_ref),
    idempotencyKey: row.idempotency_key === null ? null : String(row.idempotency_key),
    fingerprint: String(row.fingerprint),
    arguments: jsonParse<Record<string, unknown>>(String(row.arguments_json), {}),
    argumentsPreview: String(row.arguments_preview),
    state: row.state as CompanyBoxApproval["state"],
    result: row.result_json === null ? null : jsonParse<unknown>(String(row.result_json), null),
    error: row.error === null ? null : String(row.error),
    decidedBy: row.decided_by === null ? null : String(row.decided_by),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function brokerGrantFromRow(
  row: Record<string, unknown>,
): MarketplaceBrokerGrant {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    requesterMiniappId: String(row.requester_miniapp_id),
    pluginId: String(row.plugin_id),
    actionKeys: jsonParse<string[]>(String(row.action_keys), []),
    capabilities: jsonParse<ConnectorCapability[]>(
      String(row.capabilities),
      [],
    ),
    tokenHash: String(row.token_hash),
    state: row.state as MarketplaceBrokerGrant["state"],
    expiresAt: String(row.expires_at),
    metadata: jsonParse<JsonRecord>(String(row.metadata), {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteMarketplaceStore {
  private readonly db: DatabaseSync;
  private readonly logPath: string | null;
  private readonly debug: boolean;
  private readonly handoffEncryptionKey: Buffer | null;
  private channelStore: ChannelStore | null = null;

  constructor(
    readonly dbPath: string,
    options: StoreOptions = {},
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.logPath =
      options.logPath ??
      path.join(
        path.dirname(path.dirname(dbPath)),
        "logs",
        "marketplace-debug.jsonl",
      );
    this.debug = options.debug ?? compatDebugEnabled();
    this.handoffEncryptionKey = encryptionKeyFromSecret(
      options.handoffEncryptionKey ?? process.env.MARKETPLACE_HANDOFF_ENCRYPTION_KEY,
    );
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.migrate();
      this.seedListings();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate() {
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS marketplace_listing (
        plugin_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        description TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        actions TEXT NOT NULL,
        source TEXT NOT NULL,
        auth_owner TEXT NOT NULL,
        execution_owner TEXT NOT NULL,
        runtime_sources_json TEXT NOT NULL DEFAULT '[]',
        enabled_by_default INTEGER NOT NULL DEFAULT 0,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_secret (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        name TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_slug, plugin_id, name)
      );

      CREATE TABLE IF NOT EXISTS plugin_registry (
        plugin_id TEXT PRIMARY KEY,
        registry_state TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_plugin_install (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        lifecycle TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_slug, plugin_id)
      );

      CREATE TABLE IF NOT EXISTS plugin_capability_binding (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_slug, plugin_id, capability)
      );

      CREATE TABLE IF NOT EXISTS plugin_action_binding (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_slug, plugin_id, action_key)
      );

      CREATE TABLE IF NOT EXISTS connector_connection (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        backend TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_connector_grant (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        capability TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        state TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_connector_grant_scope
      ON agent_connector_grant(
        workspace_slug, agent_id, plugin_id, action_key, account_id,
        resource_kind, resource_ref, state
      );

      CREATE TABLE IF NOT EXISTS marketplace_portal_handoff_session (
        id TEXT PRIMARY KEY,
        portal_issuer TEXT NOT NULL,
        deployment_id TEXT NOT NULL UNIQUE,
        portal_org_id TEXT NOT NULL,
        product_tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS marketplace_portal_grant_request (
        id TEXT PRIMARY KEY,
        portal_issuer TEXT NOT NULL,
        portal_org_id TEXT NOT NULL,
        product_tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        approval_url TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        state TEXT NOT NULL,
        consent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(portal_issuer, deployment_id, request_id),
        UNIQUE(portal_issuer, deployment_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_marketplace_portal_grant_request_scope
      ON marketplace_portal_grant_request(product_tenant_id, deployment_id, agent_id, state);

      CREATE TABLE IF NOT EXISTS marketplace_agent_consent (
        id TEXT PRIMARY KEY,
        portal_issuer TEXT NOT NULL,
        portal_org_id TEXT NOT NULL,
        product_tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        consent_id TEXT NOT NULL,
        consent_revision INTEGER NOT NULL,
        plugin_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        capability TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_ref TEXT NOT NULL,
        state TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        required_actions TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(portal_issuer, deployment_id, consent_id)
      );

      CREATE INDEX IF NOT EXISTS idx_marketplace_agent_consent_scope
      ON marketplace_agent_consent(product_tenant_id, deployment_id, agent_id, state);

      CREATE TABLE IF NOT EXISTS marketplace_runtime_operation (
        id TEXT PRIMARY KEY,
        consent_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(consent_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS credential_ref (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        provider_hint TEXT NOT NULL,
        secret_ref_key TEXT NOT NULL,
        external_ref TEXT,
        state TEXT NOT NULL,
        detail TEXT NOT NULL,
        metadata TEXT NOT NULL,
        configured_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activepieces_pack_binding (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        piece_name TEXT NOT NULL,
        action_key TEXT NOT NULL,
        webhook_url TEXT,
        flow_id TEXT,
        state TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS composio_import (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        toolkit TEXT NOT NULL,
        imported_action_keys TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connector_usage_ledger (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_executor TEXT NOT NULL,
        source_action_key TEXT NOT NULL,
        product_capability_key TEXT NOT NULL,
        input_shape TEXT NOT NULL,
        output_shape TEXT NOT NULL,
        scopes_used TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        session_id TEXT,
        error TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      -- Retired feature: no code reads or writes this table any more. It is
      -- kept so existing databases and the table inventory stay unchanged.
      CREATE TABLE IF NOT EXISTS agent_session_correlation (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        app_thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        remote_session_id TEXT NOT NULL,
        hermes_live_session_id TEXT,
        hermes_stored_session_id TEXT,
        profile TEXT,
        runtime_mode TEXT,
        cwd TEXT,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        metadata TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(workspace_slug, app_thread_id, provider_instance_id, remote_session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_agent_session_correlation_app_thread
      ON agent_session_correlation(workspace_slug, app_thread_id);

      CREATE INDEX IF NOT EXISTS idx_agent_session_correlation_remote_session
      ON agent_session_correlation(workspace_slug, remote_session_id);

      CREATE TABLE IF NOT EXISTS broker_grant (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        requester_miniapp_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        action_keys TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS promotion_candidate (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_action_key TEXT NOT NULL,
        product_capability_key TEXT NOT NULL,
        usage_count INTEGER NOT NULL,
        state TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS health_event (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        detail TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS company_box_approval (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        capability TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        idempotency_key TEXT,
        fingerprint TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        arguments_preview TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        decided_by TEXT,
        decided_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_slug, agent_id, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS audit_event (
        id TEXT PRIMARY KEY,
        workspace_slug TEXT,
        plugin_id TEXT,
        event_type TEXT NOT NULL,
        actor_id TEXT,
        rules_decision_id TEXT,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.addColumnIfMissing(
      "ALTER TABLE marketplace_listing ADD COLUMN runtime_sources_json TEXT NOT NULL DEFAULT '[]'",
    );
    // Operator-created custom connectors are owned by one workspace; seeded
    // listings stay global (NULL).
    this.addColumnIfMissing(
      "ALTER TABLE marketplace_listing ADD COLUMN workspace_slug TEXT",
    );
    // Channels (0.2.0): additive tables only; older builds ignore them.
    migrateChannelTables(this.db);
    this.migratePortalHandoffSessions();
  }

  /** Channels records (spec §4) on the same database connection. */
  get channels(): ChannelStore {
    this.channelStore ??= new ChannelStore(this.db);
    return this.channelStore;
  }

  private addColumnIfMissing(statement: string) {
    try {
      this.db.exec(statement);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("duplicate column name")
      ) {
        throw error;
      }
    }
  }

  private migratePortalHandoffSessions() {
    const rows = this.db
      .prepare("SELECT id, session_token FROM marketplace_portal_handoff_session")
      .all() as Record<string, unknown>[];
    if (rows.length === 0) return;
    if (!this.handoffEncryptionKey) {
      throw new Error(
        "MARKETPLACE_HANDOFF_ENCRYPTION_KEY is required to open stored Portal handoff sessions.",
      );
    }
    for (const row of rows) {
      if (isEncryptedPortalHandoffToken(String(row.session_token))) {
        this.decryptHandoffSessionToken(String(row.session_token));
      }
    }
    const legacyRows = rows.filter(
      (row) => !isEncryptedPortalHandoffToken(String(row.session_token)),
    );
    if (legacyRows.length === 0) return;
    this.db.exec("BEGIN");
    try {
      const update = this.db.prepare(
        "UPDATE marketplace_portal_handoff_session SET session_token = ? WHERE id = ?",
      );
      for (const row of legacyRows) {
        update.run(
          encryptPortalHandoffToken(
            String(row.session_token),
            this.handoffEncryptionKey,
          ),
          String(row.id),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private encryptHandoffSessionToken(token: string) {
    if (!this.handoffEncryptionKey) {
      throw new Error(
        "MARKETPLACE_HANDOFF_ENCRYPTION_KEY is required for Portal handoff sessions.",
      );
    }
    return encryptPortalHandoffToken(token, this.handoffEncryptionKey);
  }

  private decryptHandoffSessionToken(value: string) {
    if (!this.handoffEncryptionKey) {
      throw new Error(
        "MARKETPLACE_HANDOFF_ENCRYPTION_KEY is required for Portal handoff sessions.",
      );
    }
    return decryptPortalHandoffToken(value, this.handoffEncryptionKey);
  }

  private seedListings() {
    for (const listing of [
      ...nativeConnectorListings(),
      ...providerBackedListings(),
    ]) {
      this.upsertListing(listing);
    }
  }

  upsertListing(listing: MarketplaceListing) {
    this.db
      .prepare(
        `INSERT INTO marketplace_listing (
          plugin_id, display_name, kind, provider, description, capabilities, actions, source,
          auth_owner, execution_owner, runtime_sources_json, enabled_by_default, manifest_json, created_at, updated_at,
          workspace_slug
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          workspace_slug = COALESCE(marketplace_listing.workspace_slug, excluded.workspace_slug),
          display_name = excluded.display_name,
          kind = excluded.kind,
          provider = excluded.provider,
          description = excluded.description,
          capabilities = excluded.capabilities,
          actions = excluded.actions,
          source = excluded.source,
          auth_owner = excluded.auth_owner,
          execution_owner = excluded.execution_owner,
          runtime_sources_json = excluded.runtime_sources_json,
          enabled_by_default = excluded.enabled_by_default,
          manifest_json = excluded.manifest_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        listing.pluginId,
        listing.displayName,
        listing.kind,
        listing.provider,
        listing.description,
        JSON.stringify(listing.capabilities),
        JSON.stringify(listing.actions),
        listing.source,
        listing.authOwner,
        listing.executionOwner,
        JSON.stringify(listing.runtimeSources ?? []),
        listing.enabledByDefault ? 1 : 0,
        JSON.stringify(listing.manifest),
        listing.createdAt,
        listing.updatedAt,
        listing.ownerWorkspaceSlug ?? null,
      );
  }

  listTables(): string[] {
    const rows = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  listListings(): MarketplaceListing[] {
    return (
      this.db
        .prepare("SELECT * FROM marketplace_listing ORDER BY display_name ASC")
        .all() as Record<string, unknown>[]
    ).map(listingFromRow);
  }

  getListing(pluginId: string): MarketplaceListing | null {
    const row = this.db
      .prepare("SELECT * FROM marketplace_listing WHERE plugin_id = ?")
      .get(pluginId) as Record<string, unknown> | undefined;
    return row ? listingFromRow(row) : null;
  }

  /** Global listings plus the listings owned by `workspaceSlug`. */
  listListingsForWorkspace(workspaceSlug: string): MarketplaceListing[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM marketplace_listing
           WHERE workspace_slug IS NULL OR workspace_slug = ?
           ORDER BY display_name ASC`,
        )
        .all(workspaceSlug) as Record<string, unknown>[]
    ).map(listingFromRow);
  }

  /** Listings owned by `workspaceSlug` only (operator custom connectors). */
  listOwnedListings(workspaceSlug: string): MarketplaceListing[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM marketplace_listing
           WHERE workspace_slug = ?
           ORDER BY display_name ASC`,
        )
        .all(workspaceSlug) as Record<string, unknown>[]
    ).map(listingFromRow);
  }

  /**
   * Workspace-aware lookup: a listing owned by another workspace is reported
   * as absent so callers answer 404 rather than leaking its existence.
   */
  getListingForWorkspace(
    pluginId: string,
    workspaceSlug: string,
  ): MarketplaceListing | null {
    const row = this.db
      .prepare(
        `SELECT * FROM marketplace_listing
         WHERE plugin_id = ? AND (workspace_slug IS NULL OR workspace_slug = ?)`,
      )
      .get(pluginId, workspaceSlug) as Record<string, unknown> | undefined;
    return row ? listingFromRow(row) : null;
  }

  registerPlugin(pluginId: string) {
    const listing = this.getListing(pluginId);
    if (!listing) {
      throw new Error(`Plugin ${pluginId} was not found`);
    }
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO plugin_registry (plugin_id, registry_state, manifest_json, created_at, updated_at)
         VALUES (?, 'registered', ?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           registry_state = 'registered',
           manifest_json = excluded.manifest_json,
           updated_at = excluded.updated_at`,
      )
      .run(pluginId, JSON.stringify(listing.manifest), timestamp, timestamp);
    return {
      pluginId,
      registryState: "registered",
      manifest: listing.manifest,
      updatedAt: timestamp,
    };
  }

  unregisterPlugin(pluginId: string) {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO plugin_registry (plugin_id, registry_state, manifest_json, created_at, updated_at)
         VALUES (?, 'unregistered', '{}', ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           registry_state = 'unregistered',
           updated_at = excluded.updated_at`,
      )
      .run(pluginId, timestamp, timestamp);
    return { pluginId, registryState: "unregistered", updatedAt: timestamp };
  }

  isRegistered(pluginId: string): boolean {
    const row = this.db
      .prepare("SELECT registry_state FROM plugin_registry WHERE plugin_id = ?")
      .get(pluginId) as { registry_state?: string } | undefined;
    return row?.registry_state === "registered";
  }

  install(workspaceSlug: string, pluginId: string): WorkspacePluginInstall {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO workspace_plugin_install (id, workspace_slug, plugin_id, enabled, lifecycle, installed_at, updated_at)
         VALUES (?, ?, ?, 1, 'installed', ?, ?)
         ON CONFLICT(workspace_slug, plugin_id) DO UPDATE SET
           enabled = 1,
           lifecycle = 'installed',
           updated_at = excluded.updated_at`,
      )
      .run(createId("install"), workspaceSlug, pluginId, timestamp, timestamp);
    return this.requireInstall(workspaceSlug, pluginId);
  }

  uninstall(workspaceSlug: string, pluginId: string): WorkspacePluginInstall {
    const timestamp = nowIso();
    this.db
      .prepare(
        `UPDATE workspace_plugin_install
         SET enabled = 0, lifecycle = 'uninstalled', updated_at = ?
         WHERE workspace_slug = ? AND plugin_id = ?`,
      )
      .run(timestamp, workspaceSlug, pluginId);
    return this.requireInstall(workspaceSlug, pluginId);
  }

  setInstallEnabled(input: {
    workspaceSlug: string;
    pluginId: string;
    enabled: boolean;
  }): WorkspacePluginInstall {
    const install = this.requireInstall(input.workspaceSlug, input.pluginId);
    if (install.lifecycle !== "installed") {
      throw new Error(`Plugin ${input.pluginId} is not installed`);
    }
    this.db
      .prepare(
        `UPDATE workspace_plugin_install
         SET enabled = ?, updated_at = ?
         WHERE workspace_slug = ? AND plugin_id = ?`,
      )
      .run(
        input.enabled ? 1 : 0,
        nowIso(),
        input.workspaceSlug,
        input.pluginId,
      );
    return this.requireInstall(input.workspaceSlug, input.pluginId);
  }

  touchListing(pluginId: string): MarketplaceListing {
    const timestamp = nowIso();
    const result = this.db
      .prepare(
        "UPDATE marketplace_listing SET updated_at = ? WHERE plugin_id = ?",
      )
      .run(timestamp, pluginId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Plugin ${pluginId} was not found`);
    }
    return this.getListing(pluginId)!;
  }

  deleteListing(pluginId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "plugin_capability_binding",
        "plugin_action_binding",
        "connector_connection",
        "credential_ref",
        "connector_secret",
        "composio_import",
        "workspace_plugin_install",
        "plugin_registry",
      ]) {
        this.db
          .prepare(`DELETE FROM ${table} WHERE plugin_id = ?`)
          .run(pluginId);
      }
      this.db
        .prepare("DELETE FROM marketplace_listing WHERE plugin_id = ?")
        .run(pluginId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getInstall(
    workspaceSlug: string,
    pluginId: string,
  ): WorkspacePluginInstall | null {
    const row = this.db
      .prepare(
        "SELECT * FROM workspace_plugin_install WHERE workspace_slug = ? AND plugin_id = ?",
      )
      .get(workspaceSlug, pluginId) as Record<string, unknown> | undefined;
    return row ? installFromRow(row) : null;
  }

  /** Store an agent's held outward call. Arguments are bounded by the caller. */
  createCompanyBoxApproval(input: {
    workspaceSlug: string;
    pluginId: string;
    actionKey: string;
    capability: ConnectorCapability;
    agentId: string;
    sourceKind: CompanyBoxApproval["sourceKind"];
    sourceRef: string;
    idempotencyKey: string | null;
    fingerprint: string;
    arguments: Record<string, unknown>;
    argumentsPreview: string;
    /** Lifetime from creation. Creation and expiry derive from one clock reading, so the span is exactly this. */
    ttlMs: number;
  }): CompanyBoxApproval {
    const id = createId("approval");
    const created = Date.now();
    const timestamp = new Date(created).toISOString();
    const expiresAt = new Date(created + input.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO company_box_approval (
          id, workspace_slug, plugin_id, action_key, capability, agent_id, source_kind, source_ref,
          idempotency_key, fingerprint, arguments_json, arguments_preview, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.pluginId,
        input.actionKey,
        input.capability,
        input.agentId,
        input.sourceKind,
        input.sourceRef,
        input.idempotencyKey,
        input.fingerprint,
        JSON.stringify(input.arguments),
        input.argumentsPreview,
        expiresAt,
        timestamp,
        timestamp,
      );
    return this.getCompanyBoxApproval(id)!;
  }

  countPendingCompanyBoxApprovals(input: { workspaceSlug: string; agentId: string }): number {
    this.expireCompanyBoxApprovals();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM company_box_approval
         WHERE workspace_slug = ? AND agent_id = ? AND state = 'pending'`,
      )
      .get(input.workspaceSlug, input.agentId) as { count: number };
    return Number(row.count);
  }

  /** Pending approvals past their expiry become `expired`. */
  private expireCompanyBoxApprovals() {
    const timestamp = nowIso();
    this.db
      .prepare(
        `UPDATE company_box_approval SET state = 'expired', updated_at = ?
         WHERE state = 'pending' AND expires_at <= ?`,
      )
      .run(timestamp, timestamp);
  }

  getCompanyBoxApproval(id: string): CompanyBoxApproval | null {
    this.expireCompanyBoxApprovals();
    const row = this.db
      .prepare("SELECT * FROM company_box_approval WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? companyBoxApprovalFromRow(row) : null;
  }

  findCompanyBoxApprovalByKey(input: {
    workspaceSlug: string;
    agentId: string;
    idempotencyKey: string;
  }): CompanyBoxApproval | null {
    this.expireCompanyBoxApprovals();
    const row = this.db
      .prepare(
        `SELECT * FROM company_box_approval
         WHERE workspace_slug = ? AND agent_id = ? AND idempotency_key = ?`,
      )
      .get(input.workspaceSlug, input.agentId, input.idempotencyKey) as Record<string, unknown> | undefined;
    return row ? companyBoxApprovalFromRow(row) : null;
  }

  listCompanyBoxApprovals(input: {
    workspaceSlug: string;
    state?: CompanyBoxApproval["state"];
    limit?: number;
  }): CompanyBoxApproval[] {
    this.expireCompanyBoxApprovals();
    return (
      this.db
        .prepare(
          `SELECT * FROM company_box_approval
           WHERE workspace_slug = ? AND (? IS NULL OR state = ?)
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(
          input.workspaceSlug,
          input.state ?? null,
          input.state ?? null,
          Math.max(1, Math.min(input.limit ?? 100, 500)),
        ) as Record<string, unknown>[]
    ).map(companyBoxApprovalFromRow);
  }

  /**
   * Atomically move a live pending approval to `executing` (approve) or
   * `denied`. Returns null when it was not pending (already decided, expired,
   * or in another workspace), which makes approval exactly-once.
   */
  decideCompanyBoxApproval(input: {
    id: string;
    workspaceSlug: string;
    decision: "approve" | "deny";
    decidedBy: string;
  }): CompanyBoxApproval | null {
    this.expireCompanyBoxApprovals();
    const timestamp = nowIso();
    const result = this.db
      .prepare(
        `UPDATE company_box_approval
         SET state = ?, decided_by = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND workspace_slug = ? AND state = 'pending' AND expires_at > ?`,
      )
      .run(
        input.decision === "approve" ? "executing" : "denied",
        input.decidedBy,
        timestamp,
        timestamp,
        input.id,
        input.workspaceSlug,
        timestamp,
      );
    return Number(result.changes) === 1 ? this.getCompanyBoxApproval(input.id) : null;
  }

  finishCompanyBoxApproval(input: {
    id: string;
    state: "succeeded" | "failed";
    result?: unknown;
    error?: string | null;
  }): CompanyBoxApproval {
    const stored = input.result === undefined ? null : boundedStoredOutput(input.result).output;
    this.db
      .prepare(
        `UPDATE company_box_approval SET state = ?, result_json = ?, error = ?, updated_at = ?
         WHERE id = ? AND state = 'executing'`,
      )
      .run(input.state, stored === null ? null : JSON.stringify(stored), input.error ?? null, nowIso(), input.id);
    return this.getCompanyBoxApproval(input.id)!;
  }

  /** Every workspace's install row for one plugin (global listings). */
  listInstallsForPlugin(pluginId: string): WorkspacePluginInstall[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM workspace_plugin_install WHERE plugin_id = ? ORDER BY workspace_slug ASC",
        )
        .all(pluginId) as Record<string, unknown>[]
    ).map(installFromRow);
  }

  requireInstall(
    workspaceSlug: string,
    pluginId: string,
  ): WorkspacePluginInstall {
    const install = this.getInstall(workspaceSlug, pluginId);
    if (!install) {
      throw new Error(
        `Plugin ${pluginId} is not installed for ${workspaceSlug}`,
      );
    }
    return install;
  }

  bindCapability(input: {
    workspaceSlug: string;
    pluginId: string;
    capability: ConnectorCapability;
    enabled: boolean;
  }): CapabilityBinding {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO plugin_capability_binding (id, workspace_slug, plugin_id, capability, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug, plugin_id, capability) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        createId("binding"),
        input.workspaceSlug,
        input.pluginId,
        input.capability,
        input.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
    return this.requireCapabilityBinding(
      input.workspaceSlug,
      input.pluginId,
      input.capability,
    );
  }

  getCapabilityBinding(
    workspaceSlug: string,
    pluginId: string,
    capability: ConnectorCapability,
  ): CapabilityBinding | null {
    const row = this.db
      .prepare(
        "SELECT * FROM plugin_capability_binding WHERE workspace_slug = ? AND plugin_id = ? AND capability = ?",
      )
      .get(workspaceSlug, pluginId, capability) as
      | Record<string, unknown>
      | undefined;
    return row ? bindingFromRow(row) : null;
  }

  requireCapabilityBinding(
    workspaceSlug: string,
    pluginId: string,
    capability: ConnectorCapability,
  ): CapabilityBinding {
    const row = this.db
      .prepare(
        "SELECT * FROM plugin_capability_binding WHERE workspace_slug = ? AND plugin_id = ? AND capability = ?",
      )
      .get(workspaceSlug, pluginId, capability) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error(
        `Plugin ${pluginId} has no ${capability} binding for ${workspaceSlug}`,
      );
    }
    return bindingFromRow(row);
  }

  recordUsage(
    input: Omit<
      ConnectorUsageLedgerEntry,
      "id" | "inputShape" | "outputShape" | "createdAt"
    > & {
      input?: Record<string, unknown>;
      output?: unknown;
      inputShape?: JsonRecord;
      outputShape?: JsonRecord;
      createdAt?: string;
    },
  ): ConnectorUsageLedgerEntry {
    const entry: ConnectorUsageLedgerEntry = {
      id: createId("connector_usage"),
      workspaceSlug: input.workspaceSlug,
      pluginId: input.pluginId,
      provider: input.provider,
      sourceExecutor: input.sourceExecutor,
      sourceActionKey: input.sourceActionKey,
      productCapabilityKey: input.productCapabilityKey,
      inputShape: input.inputShape ?? shapeOf(input.input),
      outputShape: input.outputShape ?? shapeOf(input.output),
      scopesUsed: input.scopesUsed,
      status: input.status,
      runId: input.runId,
      sessionId: input.sessionId,
      error: input.error,
      metadata: input.metadata,
      createdAt: input.createdAt ?? nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO connector_usage_ledger (
          id, workspace_slug, plugin_id, provider, source_executor, source_action_key,
          product_capability_key, input_shape, output_shape, scopes_used, status, run_id,
          session_id, error, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.workspaceSlug,
        entry.pluginId,
        entry.provider,
        entry.sourceExecutor,
        entry.sourceActionKey,
        entry.productCapabilityKey,
        JSON.stringify(entry.inputShape),
        JSON.stringify(entry.outputShape),
        JSON.stringify(entry.scopesUsed),
        entry.status,
        entry.runId,
        entry.sessionId,
        entry.error,
        JSON.stringify(entry.metadata),
        entry.createdAt,
      );
    return entry;
  }

  listUsage(input: {
    workspaceSlug: string;
    provider?: string;
    limit?: number;
  }): ConnectorUsageLedgerEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM connector_usage_ledger
         WHERE workspace_slug = ? AND (? IS NULL OR provider = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(
        input.workspaceSlug,
        input.provider ?? null,
        input.provider ?? null,
        Math.max(1, Math.min(input.limit ?? 100, 500)),
      ) as Record<string, unknown>[];
    return rows.map(usageFromRow);
  }

  createBrokerGrant(input: {
    workspaceSlug: string;
    requesterMiniappId: string;
    pluginId: string;
    actionKeys: string[];
    capabilities: ConnectorCapability[];
    tokenHash: string;
    expiresAt: string;
    metadata?: JsonRecord;
  }): MarketplaceBrokerGrant {
    const timestamp = nowIso();
    const id = createId("broker_grant");
    this.db
      .prepare(
        `INSERT INTO broker_grant (
          id, workspace_slug, requester_miniapp_id, plugin_id, action_keys,
          capabilities, token_hash, state, expires_at, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.requesterMiniappId,
        input.pluginId,
        JSON.stringify(input.actionKeys),
        JSON.stringify(input.capabilities),
        input.tokenHash,
        input.expiresAt,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.requireBrokerGrantById(id);
  }

  getBrokerGrantByTokenHash(tokenHash: string): MarketplaceBrokerGrant | null {
    const row = this.db
      .prepare(
        `SELECT * FROM broker_grant
         WHERE token_hash = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(tokenHash) as Record<string, unknown> | undefined;
    return row ? brokerGrantFromRow(row) : null;
  }

  consumeBrokerGrant(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE broker_grant
         SET state = 'consumed', updated_at = ?
         WHERE id = ? AND state = 'active'`,
      )
      .run(nowIso(), id);
    return Number(result.changes) === 1;
  }

  listBrokerGrants(
    input: {
      workspaceSlug?: string;
      requesterMiniappId?: string;
      pluginId?: string;
    } = {},
  ): MarketplaceBrokerGrant[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM broker_grant
         WHERE (? IS NULL OR workspace_slug = ?)
           AND (? IS NULL OR requester_miniapp_id = ?)
           AND (? IS NULL OR plugin_id = ?)
         ORDER BY updated_at DESC`,
      )
      .all(
        input.workspaceSlug ?? null,
        input.workspaceSlug ?? null,
        input.requesterMiniappId ?? null,
        input.requesterMiniappId ?? null,
        input.pluginId ?? null,
        input.pluginId ?? null,
      ) as Record<string, unknown>[];
    return rows.map(brokerGrantFromRow);
  }

  revokeBrokerGrantsForPlugin(input: {
    workspaceSlug: string;
    pluginId: string;
  }): number {
    const result = this.db
      .prepare(
        `UPDATE broker_grant
         SET state = 'revoked', updated_at = ?
         WHERE workspace_slug = ? AND plugin_id = ? AND state = 'active'`,
      )
      .run(nowIso(), input.workspaceSlug, input.pluginId);
    return Number(result.changes);
  }

  listEnabledBindings(workspaceSlug: string): CapabilityBinding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plugin_capability_binding
         WHERE workspace_slug = ? AND enabled = 1
         ORDER BY plugin_id ASC, capability ASC`,
      )
      .all(workspaceSlug) as Record<string, unknown>[];
    return rows.map(bindingFromRow);
  }

  bindAction(input: {
    workspaceSlug: string;
    pluginId: string;
    actionKey: string;
    enabled: boolean;
  }): ActionBinding {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO plugin_action_binding (id, workspace_slug, plugin_id, action_key, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug, plugin_id, action_key) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        createId("action_binding"),
        input.workspaceSlug,
        input.pluginId,
        input.actionKey,
        input.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
    return this.requireActionBinding(
      input.workspaceSlug,
      input.pluginId,
      input.actionKey,
    );
  }

  requireActionBinding(
    workspaceSlug: string,
    pluginId: string,
    actionKey: string,
  ): ActionBinding {
    const row = this.db
      .prepare(
        "SELECT * FROM plugin_action_binding WHERE workspace_slug = ? AND plugin_id = ? AND action_key = ?",
      )
      .get(workspaceSlug, pluginId, actionKey) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error(
        `Plugin ${pluginId} has no ${actionKey} action binding for ${workspaceSlug}`,
      );
    }
    return actionBindingFromRow(row);
  }

  getActionBinding(
    workspaceSlug: string,
    pluginId: string,
    actionKey: string,
  ): ActionBinding | null {
    const row = this.db
      .prepare(
        "SELECT * FROM plugin_action_binding WHERE workspace_slug = ? AND plugin_id = ? AND action_key = ?",
      )
      .get(workspaceSlug, pluginId, actionKey) as
      | Record<string, unknown>
      | undefined;
    return row ? actionBindingFromRow(row) : null;
  }

  listActionBindings(input: {
    workspaceSlug: string;
    pluginId?: string;
  }): ActionBinding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM plugin_action_binding
         WHERE workspace_slug = ?
           AND (? IS NULL OR plugin_id = ?)
         ORDER BY plugin_id ASC, action_key ASC`,
      )
      .all(
        input.workspaceSlug,
        input.pluginId ?? null,
        input.pluginId ?? null,
      ) as Record<string, unknown>[];
    return rows.map(actionBindingFromRow);
  }

  isActionEnabled(input: {
    workspaceSlug: string;
    pluginId: string;
    actionKey: string;
  }): boolean {
    const binding = this.getActionBinding(
      input.workspaceSlug,
      input.pluginId,
      input.actionKey,
    );
    return binding ? binding.enabled : true;
  }

  upsertConnection(input: {
    workspaceSlug: string;
    pluginId: string;
    provider: string;
    backend: ConnectorConnection["backend"];
    state: ConnectorConnection["state"];
    detail: string;
    metadata?: JsonRecord;
  }): ConnectorConnection {
    const timestamp = nowIso();
    const existing = this.db
      .prepare(
        `SELECT * FROM connector_connection
         WHERE workspace_slug = ? AND plugin_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(input.workspaceSlug, input.pluginId) as
      | Record<string, unknown>
      | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE connector_connection
           SET provider = ?, backend = ?, state = ?, detail = ?, metadata = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.provider,
          input.backend,
          input.state,
          input.detail,
          JSON.stringify(input.metadata ?? {}),
          timestamp,
          String(existing.id),
        );
      return this.requireConnectionById(String(existing.id));
    }

    const id = createId("connection");
    this.db
      .prepare(
        `INSERT INTO connector_connection (
          id, workspace_slug, plugin_id, provider, backend, state, detail, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.pluginId,
        input.provider,
        input.backend,
        input.state,
        input.detail,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.requireConnectionById(id);
  }

  getConnection(
    workspaceSlug: string,
    pluginId: string,
  ): ConnectorConnection | null {
    const row = this.db
      .prepare(
        `SELECT * FROM connector_connection
         WHERE workspace_slug = ? AND plugin_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(workspaceSlug, pluginId) as Record<string, unknown> | undefined;
    return row ? connectionFromRow(row) : null;
  }

  findConnectionByState(
    state: string,
    pluginId?: string,
  ): ConnectorConnection | null {
    const row = this.db
      .prepare(
        `SELECT * FROM connector_connection
         WHERE json_extract(metadata, '$.state') = ?
           AND (? IS NULL OR plugin_id = ?)
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(state, pluginId ?? null, pluginId ?? null) as
      | Record<string, unknown>
      | undefined;
    return row ? connectionFromRow(row) : null;
  }

  listConnections(
    input: { workspaceSlug?: string; pluginId?: string } = {},
  ): ConnectorConnection[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM connector_connection
         WHERE (? IS NULL OR workspace_slug = ?)
           AND (? IS NULL OR plugin_id = ?)
         ORDER BY updated_at DESC`,
      )
      .all(
        input.workspaceSlug ?? null,
        input.workspaceSlug ?? null,
        input.pluginId ?? null,
        input.pluginId ?? null,
      ) as Record<string, unknown>[];
    return rows.map(connectionFromRow);
  }

  createAgentConnectorGrant(input: {
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
    expiresAt: string;
    metadata?: JsonRecord;
  }): AgentConnectorGrant {
    const timestamp = nowIso();
    const id = createId("agent_grant");
    this.db
      .prepare(
        `INSERT INTO agent_connector_grant (
          id, workspace_slug, agent_id, plugin_id, action_key, capability,
          connection_id, account_id, resource_kind, resource_ref, attachment_id,
          state, expires_at, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.agentId,
        input.pluginId,
        input.actionKey,
        input.capability,
        input.connectionId,
        input.accountId,
        input.resourceKind,
        input.resourceRef,
        input.attachmentId,
        input.expiresAt,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.requireAgentConnectorGrantById(id);
  }

  getAgentConnectorGrant(id: string): AgentConnectorGrant | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_connector_grant
         WHERE id = ?
         LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? agentConnectorGrantFromRow(row) : null;
  }

  findActiveAgentConnectorGrant(input: {
    workspaceSlug: string;
    agentId: string;
    pluginId: string;
    actionKey: string;
    accountId: string;
    resourceKind: string;
    resourceRef: string;
  }): AgentConnectorGrant | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_connector_grant
         WHERE workspace_slug = ?
           AND agent_id = ?
           AND plugin_id = ?
           AND action_key = ?
           AND account_id = ?
           AND resource_kind = ?
           AND resource_ref = ?
           AND state = 'active'
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(
        input.workspaceSlug,
        input.agentId,
        input.pluginId,
        input.actionKey,
        input.accountId,
        input.resourceKind,
        input.resourceRef,
      ) as Record<string, unknown> | undefined;
    return row ? agentConnectorGrantFromRow(row) : null;
  }

  revokeAgentConnectorGrant(id: string): AgentConnectorGrant | null {
    this.db
      .prepare(
        `UPDATE agent_connector_grant
         SET state = 'revoked', updated_at = ?
         WHERE id = ? AND state = 'active'`,
      )
      .run(nowIso(), id);
    return this.getAgentConnectorGrant(id);
  }

  listAgentConnectorGrants(input: {
    workspaceSlug?: string;
    agentId?: string;
    pluginId?: string;
    state?: AgentConnectorGrant["state"];
    limit?: number;
  } = {}): AgentConnectorGrant[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_connector_grant
         WHERE (? IS NULL OR workspace_slug = ?)
           AND (? IS NULL OR agent_id = ?)
           AND (? IS NULL OR plugin_id = ?)
           AND (? IS NULL OR state = ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(
        input.workspaceSlug ?? null,
        input.workspaceSlug ?? null,
        input.agentId ?? null,
        input.agentId ?? null,
        input.pluginId ?? null,
        input.pluginId ?? null,
        input.state ?? null,
        input.state ?? null,
        Math.max(1, Math.min(input.limit ?? 100, 500)),
      ) as Record<string, unknown>[];
    return rows.map(agentConnectorGrantFromRow);
  }

  upsertPortalHandoffSession(input: {
    portalIssuer: string;
    deploymentId: string;
    portalOrgId: string;
    productTenantId: string;
    workspaceId: string;
    userId: string;
    sessionToken: string;
    expiresAt: string;
  }): MarketplacePortalHandoffSession {
    const timestamp = nowIso();
    const existing = this.db
      .prepare(
        "SELECT id, created_at FROM marketplace_portal_handoff_session WHERE deployment_id = ?",
      )
      .get(input.deploymentId) as Record<string, unknown> | undefined;
    const id = existing ? String(existing.id) : createId("portal_session");
    this.db
      .prepare(
        `INSERT INTO marketplace_portal_handoff_session (
          id, portal_issuer, deployment_id, portal_org_id, product_tenant_id,
          workspace_id, user_id, session_token, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(deployment_id) DO UPDATE SET
          portal_issuer = excluded.portal_issuer,
          portal_org_id = excluded.portal_org_id,
          product_tenant_id = excluded.product_tenant_id,
          workspace_id = excluded.workspace_id,
          user_id = excluded.user_id,
          session_token = excluded.session_token,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.portalIssuer,
        input.deploymentId,
        input.portalOrgId,
        input.productTenantId,
        input.workspaceId,
        input.userId,
        this.encryptHandoffSessionToken(input.sessionToken),
        input.expiresAt,
        existing ? String(existing.created_at) : timestamp,
        timestamp,
      );
    return this.requirePortalHandoffSession(input.deploymentId);
  }

  getPortalHandoffSession(deploymentId: string): MarketplacePortalHandoffSession | null {
    const row = this.db
      .prepare(
        "SELECT * FROM marketplace_portal_handoff_session WHERE deployment_id = ?",
      )
      .get(deploymentId) as Record<string, unknown> | undefined;
    return row
      ? portalHandoffSessionFromRow(
          row,
          this.decryptHandoffSessionToken(String(row.session_token)),
        )
      : null;
  }

  upsertMarketplacePortalGrantRequest(input: {
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
    selection: MarketplacePortalGrantRequest["selection"];
  }): MarketplacePortalGrantRequest {
    const timestamp = nowIso();
    const existing = this.db
      .prepare(
        `SELECT id, created_at FROM marketplace_portal_grant_request
         WHERE portal_issuer = ? AND deployment_id = ? AND request_id = ?
         LIMIT 1`,
      )
      .get(input.portalIssuer, input.deploymentId, input.requestId) as
      | Record<string, unknown>
      | undefined;
    const id = existing ? String(existing.id) : createId("portal_grant_request");
    this.db
      .prepare(
        `INSERT INTO marketplace_portal_grant_request (
          id, portal_issuer, portal_org_id, product_tenant_id, workspace_id,
          deployment_id, agent_id, request_id, approval_url, expires_at,
          idempotency_key, selection_json, state, consent_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
        ON CONFLICT(portal_issuer, deployment_id, request_id) DO UPDATE SET
          approval_url = excluded.approval_url,
          expires_at = excluded.expires_at,
          selection_json = excluded.selection_json,
          updated_at = excluded.updated_at
        `,
      )
      .run(
        id,
        input.portalIssuer,
        input.portalOrgId,
        input.productTenantId,
        input.workspaceId,
        input.deploymentId,
        input.agentId,
        input.requestId,
        input.approvalUrl,
        input.expiresAt,
        input.idempotencyKey,
        JSON.stringify(input.selection),
        existing ? String(existing.created_at) : timestamp,
        timestamp,
      );
    return this.requireMarketplacePortalGrantRequest({
      portalIssuer: input.portalIssuer,
      deploymentId: input.deploymentId,
      requestId: input.requestId,
    });
  }

  getMarketplacePortalGrantRequest(input: {
    portalIssuer: string;
    deploymentId: string;
    requestId: string;
  }): MarketplacePortalGrantRequest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM marketplace_portal_grant_request
         WHERE portal_issuer = ? AND deployment_id = ? AND request_id = ?
         LIMIT 1`,
      )
      .get(input.portalIssuer, input.deploymentId, input.requestId) as
      | Record<string, unknown>
      | undefined;
    return row ? marketplacePortalGrantRequestFromRow(row) : null;
  }

  updateMarketplacePortalGrantRequest(input: {
    portalIssuer: string;
    deploymentId: string;
    requestId: string;
    state: MarketplacePortalGrantRequest["state"];
    consentId?: string | null;
  }): MarketplacePortalGrantRequest {
    this.db
      .prepare(
        `UPDATE marketplace_portal_grant_request
         SET state = ?, consent_id = COALESCE(?, consent_id), updated_at = ?
         WHERE portal_issuer = ? AND deployment_id = ? AND request_id = ?`,
      )
      .run(
        input.state,
        input.consentId ?? null,
        nowIso(),
        input.portalIssuer,
        input.deploymentId,
        input.requestId,
      );
    return this.requireMarketplacePortalGrantRequest(input);
  }

  listMarketplacePortalGrantRequests(input: {
    productTenantId: string;
    agentId?: string;
  }): MarketplacePortalGrantRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM marketplace_portal_grant_request
         WHERE product_tenant_id = ?
           AND (? IS NULL OR agent_id = ?)
         ORDER BY updated_at DESC`,
      )
      .all(
        input.productTenantId,
        input.agentId ?? null,
        input.agentId ?? null,
      ) as Record<string, unknown>[];
    return rows.map(marketplacePortalGrantRequestFromRow);
  }

  createMarketplaceAgentConsent(input: {
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
    capabilities: ConnectorCapability[];
    requiredActions: string[];
    metadata?: JsonRecord;
  }): { consent: MarketplaceAgentConsent; created: boolean } {
    const existing = this.getMarketplaceAgentConsent({
      portalIssuer: input.portalIssuer,
      deploymentId: input.deploymentId,
      consentId: input.consentId,
    });
    if (existing) {
      return { consent: existing, created: false };
    }
    const timestamp = nowIso();
    const id = createId("marketplace_consent");
    try {
      this.db
        .prepare(
          `INSERT INTO marketplace_agent_consent (
            id, portal_issuer, portal_org_id, product_tenant_id, workspace_id,
            deployment_id, user_id, agent_id, consent_id, consent_revision,
            plugin_id, action_key, capability, connection_id, account_id,
            resource_kind, resource_ref, state, capabilities, required_actions,
            metadata, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.portalIssuer,
          input.portalOrgId,
          input.productTenantId,
          input.workspaceId,
          input.deploymentId,
          input.userId,
          input.agentId,
          input.consentId,
          input.consentRevision,
          input.pluginId,
          input.actionKey,
          input.capability,
          input.connectionId,
          input.accountId,
          input.resourceKind,
          input.resourceRef,
          JSON.stringify(input.capabilities),
          JSON.stringify(input.requiredActions),
          JSON.stringify(input.metadata ?? {}),
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE")) {
        throw error;
      }
      const concurrent = this.getMarketplaceAgentConsent({
        portalIssuer: input.portalIssuer,
        deploymentId: input.deploymentId,
        consentId: input.consentId,
      });
      if (concurrent) return { consent: concurrent, created: false };
      throw error;
    }
    const consent = this.requireMarketplaceAgentConsent(id);
    return { consent, created: true };
  }

  getMarketplaceAgentConsent(input: {
    portalIssuer: string;
    deploymentId: string;
    consentId: string;
  }): MarketplaceAgentConsent | null {
    const row = this.db
      .prepare(
        `SELECT * FROM marketplace_agent_consent
         WHERE portal_issuer = ? AND deployment_id = ? AND consent_id = ?
         LIMIT 1`,
      )
      .get(input.portalIssuer, input.deploymentId, input.consentId) as
      | Record<string, unknown>
      | undefined;
    return row ? marketplaceAgentConsentFromRow(row) : null;
  }

  getMarketplaceAgentConsentById(id: string): MarketplaceAgentConsent | null {
    const row = this.db
      .prepare("SELECT * FROM marketplace_agent_consent WHERE id = ? LIMIT 1")
      .get(id) as Record<string, unknown> | undefined;
    return row ? marketplaceAgentConsentFromRow(row) : null;
  }

  listMarketplaceAgentConsents(input: {
    productTenantId?: string;
    agentId?: string;
    state?: MarketplaceAgentConsent["state"];
  } = {}): MarketplaceAgentConsent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM marketplace_agent_consent
         WHERE (? IS NULL OR product_tenant_id = ?)
           AND (? IS NULL OR agent_id = ?)
           AND (? IS NULL OR state = ?)
         ORDER BY updated_at DESC`,
      )
      .all(
        input.productTenantId ?? null,
        input.productTenantId ?? null,
        input.agentId ?? null,
        input.agentId ?? null,
        input.state ?? null,
        input.state ?? null,
      ) as Record<string, unknown>[];
    return rows.map(marketplaceAgentConsentFromRow);
  }

  revokeMarketplaceAgentConsent(id: string): MarketplaceAgentConsent | null {
    this.db
      .prepare(
        `UPDATE marketplace_agent_consent
         SET state = 'revoked', updated_at = ?
         WHERE id = ? AND state = 'active'`,
      )
      .run(nowIso(), id);
    return this.getMarketplaceAgentConsentById(id);
  }

  getMarketplaceRuntimeOperation(input: {
    consentId: string;
    idempotencyKey: string;
  }): MarketplaceRuntimeOperation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM marketplace_runtime_operation
         WHERE consent_id = ? AND idempotency_key = ?
         LIMIT 1`,
      )
      .get(input.consentId, input.idempotencyKey) as
      | Record<string, unknown>
      | undefined;
    return row ? marketplaceRuntimeOperationFromRow(row) : null;
  }

  beginMarketplaceRuntimeOperation(input: {
    consentId: string;
    idempotencyKey: string;
    fingerprint: string;
  }): { operation: MarketplaceRuntimeOperation; created: boolean } {
    const existing = this.getMarketplaceRuntimeOperation(input);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) {
        throw new Error("runtime_operation_idempotency_conflict");
      }
      return { operation: existing, created: false };
    }
    const timestamp = nowIso();
    const id = createId("runtime_operation");
    try {
      this.db
        .prepare(
          `INSERT INTO marketplace_runtime_operation (
            id, consent_id, idempotency_key, fingerprint, status,
            response_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          id,
          input.consentId,
          input.idempotencyKey,
          input.fingerprint,
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE")) {
        throw error;
      }
      const concurrent = this.getMarketplaceRuntimeOperation(input);
      if (concurrent) {
        if (concurrent.fingerprint !== input.fingerprint) {
          throw new Error("runtime_operation_idempotency_conflict");
        }
        return { operation: concurrent, created: false };
      }
      throw error;
    }
    return { operation: this.requireMarketplaceRuntimeOperation(id), created: true };
  }

  finishMarketplaceRuntimeOperation(input: {
    id: string;
    status: Exclude<MarketplaceRuntimeOperation["status"], "pending">;
    response: JsonRecord;
  }): MarketplaceRuntimeOperation {
    this.db
      .prepare(
        `UPDATE marketplace_runtime_operation
         SET status = ?, response_json = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(input.status, JSON.stringify(input.response), nowIso(), input.id);
    return this.requireMarketplaceRuntimeOperation(input.id);
  }

  upsertCredentialRef(input: {
    workspaceSlug: string;
    pluginId: string;
    providerHint: string;
    secretRefKey: string;
    externalRef?: string | null;
    state: CredentialRef["state"];
    detail: string;
    metadata?: JsonRecord;
    configuredAt?: string | null;
  }): CredentialRef {
    const timestamp = nowIso();
    const existing = this.db
      .prepare(
        `SELECT * FROM credential_ref
         WHERE workspace_slug = ? AND plugin_id = ? AND provider_hint = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(input.workspaceSlug, input.pluginId, input.providerHint) as
      | Record<string, unknown>
      | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE credential_ref
           SET secret_ref_key = ?, external_ref = ?, state = ?, detail = ?, metadata = ?, configured_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.secretRefKey,
          input.externalRef ?? null,
          input.state,
          input.detail,
          JSON.stringify(input.metadata ?? {}),
          input.configuredAt ?? timestamp,
          timestamp,
          String(existing.id),
        );
      return this.requireCredentialRefById(String(existing.id));
    }

    const id = createId("credential");
    this.db
      .prepare(
        `INSERT INTO credential_ref (
          id, workspace_slug, plugin_id, provider_hint, secret_ref_key, external_ref,
          state, detail, metadata, configured_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.pluginId,
        input.providerHint,
        input.secretRefKey,
        input.externalRef ?? null,
        input.state,
        input.detail,
        JSON.stringify(input.metadata ?? {}),
        input.configuredAt ?? timestamp,
        timestamp,
        timestamp,
      );
    return this.requireCredentialRefById(id);
  }

  listCredentialRefs(input: {
    workspaceSlug: string;
    pluginId?: string;
  }): CredentialRef[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM credential_ref
           WHERE workspace_slug = ? AND (? IS NULL OR plugin_id = ?)
           ORDER BY created_at ASC`,
        )
        .all(
          input.workspaceSlug,
          input.pluginId ?? null,
          input.pluginId ?? null,
        ) as Record<string, unknown>[]
    ).map(credentialRefFromRow);
  }

  /** True when connector secrets can be encrypted at rest. */
  connectorSecretStoreAvailable(): boolean {
    return this.handoffEncryptionKey !== null;
  }

  private requireSecretKey(): Buffer {
    if (!this.handoffEncryptionKey) {
      throw new ConnectorSecretStoreUnavailableError();
    }
    return this.handoffEncryptionKey;
  }

  /**
   * Keyed fingerprint (12 hex) for display and audit. HMAC with the at-rest
   * key so a low-entropy secret cannot be confirmed from the fingerprint.
   */
  connectorSecretFingerprint(value: string): string {
    return createHmac("sha256", this.requireSecretKey())
      .update(`marketplace-connector-secret:${value}`)
      .digest("hex")
      .slice(0, 12);
  }

  /**
   * Encrypt and upsert one connector secret plus its credential_ref row.
   * Returns metadata only; the plaintext never leaves this method.
   */
  putConnectorSecret(input: {
    workspaceSlug: string;
    pluginId: string;
    name: string;
    value: string;
  }): ConnectorSecretMetadata {
    const key = this.requireSecretKey();
    const ciphertext = encryptSecretValue(input.value, key);
    const fingerprint = this.connectorSecretFingerprint(input.value);
    const timestamp = nowIso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO connector_secret (
            id, workspace_slug, plugin_id, name, ciphertext, fingerprint, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_slug, plugin_id, name) DO UPDATE SET
            ciphertext = excluded.ciphertext,
            fingerprint = excluded.fingerprint,
            updated_at = excluded.updated_at`,
        )
        .run(
          createId("connector_secret"),
          input.workspaceSlug,
          input.pluginId,
          input.name,
          ciphertext,
          fingerprint,
          timestamp,
          timestamp,
        );
      const secret = this.requireConnectorSecretMetadata(
        input.workspaceSlug,
        input.pluginId,
        input.name,
      );
      const secretRefKey = `marketplace-secret:${secret.id}`;
      const existingRef = this.db
        .prepare("SELECT id FROM credential_ref WHERE secret_ref_key = ?")
        .get(secretRefKey) as { id?: string } | undefined;
      const metadata = JSON.stringify({ secretName: input.name, fingerprint });
      if (existingRef?.id) {
        this.db
          .prepare(
            `UPDATE credential_ref
             SET state = 'active', detail = ?, metadata = ?, configured_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            "Connector secret is encrypted at rest in Marketplace.",
            metadata,
            timestamp,
            timestamp,
            existingRef.id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO credential_ref (
              id, workspace_slug, plugin_id, provider_hint, secret_ref_key, external_ref,
              state, detail, metadata, configured_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'mcp', ?, NULL, 'active', ?, ?, ?, ?, ?)`,
          )
          .run(
            createId("credential"),
            input.workspaceSlug,
            input.pluginId,
            secretRefKey,
            "Connector secret is encrypted at rest in Marketplace.",
            metadata,
            timestamp,
            timestamp,
            timestamp,
          );
      }
      this.db.exec("COMMIT");
      return secret;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireConnectorSecretMetadata(
    workspaceSlug: string,
    pluginId: string,
    name: string,
  ): ConnectorSecretMetadata {
    const row = this.db
      .prepare(
        `SELECT id, workspace_slug, plugin_id, name, fingerprint, created_at, updated_at
         FROM connector_secret WHERE workspace_slug = ? AND plugin_id = ? AND name = ?`,
      )
      .get(workspaceSlug, pluginId, name) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Connector secret ${name} was not found`);
    }
    return connectorSecretMetadataFromRow(row);
  }

  listConnectorSecrets(input: {
    workspaceSlug: string;
    pluginId: string;
  }): ConnectorSecretMetadata[] {
    return (
      this.db
        .prepare(
          `SELECT id, workspace_slug, plugin_id, name, fingerprint, created_at, updated_at
           FROM connector_secret WHERE workspace_slug = ? AND plugin_id = ?
           ORDER BY name ASC`,
        )
        .all(input.workspaceSlug, input.pluginId) as Record<string, unknown>[]
    ).map(connectorSecretMetadataFromRow);
  }

  /**
   * Decrypt every secret for one connector. Server-side use only (attaching
   * headers to outbound MCP requests); never serialize the result.
   */
  readConnectorSecretValues(input: {
    workspaceSlug: string;
    pluginId: string;
  }): Record<string, string> {
    const rows = this.db
      .prepare(
        `SELECT name, ciphertext FROM connector_secret
         WHERE workspace_slug = ? AND plugin_id = ?`,
      )
      .all(input.workspaceSlug, input.pluginId) as Array<{
      name: string;
      ciphertext: string;
    }>;
    if (rows.length === 0) return {};
    const key = this.requireSecretKey();
    return Object.fromEntries(
      rows.map((row) => [
        row.name,
        decryptSecretValue(row.ciphertext, key, "Stored connector secret"),
      ]),
    );
  }

  deleteConnectorSecret(input: {
    workspaceSlug: string;
    pluginId: string;
    name: string;
  }): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM connector_secret
         WHERE workspace_slug = ? AND plugin_id = ? AND name = ?`,
      )
      .get(input.workspaceSlug, input.pluginId, input.name) as
      | { id?: string }
      | undefined;
    if (!row?.id) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM connector_secret WHERE id = ?").run(row.id);
      this.db
        .prepare("DELETE FROM credential_ref WHERE secret_ref_key = ?")
        .run(`marketplace-secret:${row.id}`);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Revoke every active agent connector grant and Portal agent consent that
   * targets `pluginId` in `workspaceSlug`. Used when a connector is deleted.
   */
  revokeAgentAccessForPlugin(input: {
    workspaceSlug: string;
    pluginId: string;
  }): { grants: number; consents: number } {
    const timestamp = nowIso();
    const grants = this.db
      .prepare(
        `UPDATE agent_connector_grant
         SET state = 'revoked', updated_at = ?
         WHERE workspace_slug = ? AND plugin_id = ? AND state = 'active'`,
      )
      .run(timestamp, input.workspaceSlug, input.pluginId);
    const consents = this.db
      .prepare(
        `UPDATE marketplace_agent_consent
         SET state = 'revoked', updated_at = ?
         WHERE product_tenant_id = ? AND plugin_id = ? AND state = 'active'`,
      )
      .run(timestamp, input.workspaceSlug, input.pluginId);
    return {
      grants: Number(grants.changes),
      consents: Number(consents.changes),
    };
  }

  upsertComposioImport(input: {
    workspaceSlug: string;
    pluginId: string;
    toolkit: string;
    importedActionKeys: string[];
    lifecycle: ComposioImportRecord["lifecycle"];
    metadata?: JsonRecord;
  }): ComposioImportRecord {
    const timestamp = nowIso();
    const existing = this.db
      .prepare(
        `SELECT * FROM composio_import
         WHERE workspace_slug = ? AND plugin_id = ? AND toolkit = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(input.workspaceSlug, input.pluginId, input.toolkit) as
      | Record<string, unknown>
      | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE composio_import
           SET imported_action_keys = ?, lifecycle = ?, metadata = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(input.importedActionKeys),
          input.lifecycle,
          JSON.stringify(input.metadata ?? {}),
          timestamp,
          String(existing.id),
        );
      return this.requireComposioImportById(String(existing.id));
    }

    const id = createId("composio_import");
    this.db
      .prepare(
        `INSERT INTO composio_import (
          id, workspace_slug, plugin_id, toolkit, imported_action_keys, lifecycle, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.pluginId,
        input.toolkit,
        JSON.stringify(input.importedActionKeys),
        input.lifecycle,
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        timestamp,
      );
    return this.requireComposioImportById(id);
  }

  listComposioImports(
    input: { workspaceSlug?: string; pluginId?: string } = {},
  ): ComposioImportRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM composio_import
         WHERE (? IS NULL OR workspace_slug = ?)
           AND (? IS NULL OR plugin_id = ?)
         ORDER BY updated_at DESC`,
      )
      .all(
        input.workspaceSlug ?? null,
        input.workspaceSlug ?? null,
        input.pluginId ?? null,
        input.pluginId ?? null,
      ) as Record<string, unknown>[];
    return rows.map(composioImportFromRow);
  }

  recordAudit(input: {
    workspaceSlug?: string | null;
    pluginId?: string | null;
    eventType: string;
    actorId?: string | null;
    rulesDecisionId?: string | null;
    metadata: JsonRecord;
  }) {
    const eventId = createId("event");
    const createdAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO audit_event (
          id, workspace_slug, plugin_id, event_type, actor_id, rules_decision_id, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        input.workspaceSlug ?? null,
        input.pluginId ?? null,
        input.eventType,
        input.actorId ?? null,
        input.rulesDecisionId ?? null,
        JSON.stringify(input.metadata),
        createdAt,
      );
    if (this.debug && this.logPath) {
      fs.appendFileSync(
        this.logPath,
        `${JSON.stringify({
          id: eventId,
          type: input.eventType,
          sourceProgram: "marketplace",
          workspaceSlug: input.workspaceSlug ?? null,
          pluginId: input.pluginId ?? null,
          occurredAt: createdAt,
          payload: input.metadata,
        })}\n`,
      );
    }
  }

  listAudit(input: {
    workspaceSlug?: string;
    pluginId?: string;
    limit?: number;
  }) {
    return this.db
      .prepare(
        `SELECT * FROM audit_event
         WHERE (? IS NULL OR workspace_slug = ?)
           AND (? IS NULL OR plugin_id = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(
        input.workspaceSlug ?? null,
        input.workspaceSlug ?? null,
        input.pluginId ?? null,
        input.pluginId ?? null,
        Math.max(1, Math.min(input.limit ?? 100, 500)),
      );
  }

  recordEvent(input: {
    type: string;
    traceId: string;
    workspaceSlug?: string | null;
    pluginId?: string | null;
    actorId?: string | null;
    rulesDecisionId?: string | null;
    payload?: JsonRecord;
  }): MarketplaceEventEnvelope {
    const envelope: MarketplaceEventEnvelope = {
      id: createId("event"),
      type: input.type,
      traceId: input.traceId,
      sourceProgram: "marketplace",
      workspaceSlug: input.workspaceSlug ?? null,
      pluginId: input.pluginId ?? null,
      occurredAt: nowIso(),
      payload: input.payload ?? {},
    };
    this.db
      .prepare(
        `INSERT INTO audit_event (
          id, workspace_slug, plugin_id, event_type, actor_id, rules_decision_id, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.id,
        envelope.workspaceSlug,
        envelope.pluginId,
        envelope.type,
        input.actorId ?? null,
        input.rulesDecisionId ?? null,
        JSON.stringify({
          ...envelope.payload,
          traceId: envelope.traceId,
          sourceProgram: envelope.sourceProgram,
        }),
        envelope.occurredAt,
      );
    if (this.debug && this.logPath) {
      fs.appendFileSync(this.logPath, `${JSON.stringify(envelope)}\n`);
    }
    return envelope;
  }

  listEvents(input: {
    workspaceSlug?: string;
    pluginId?: string;
    limit?: number;
  }): MarketplaceEventEnvelope[] {
    const rows = this.listAudit(input) as Record<string, unknown>[];
    return rows.map((row) => {
      const payload = jsonParse<JsonRecord>(String(row.metadata), {});
      return {
        id: String(row.id),
        type: String(row.event_type),
        traceId: typeof payload.traceId === "string" ? payload.traceId : "",
        sourceProgram: "marketplace",
        workspaceSlug:
          row.workspace_slug === null ? null : String(row.workspace_slug),
        pluginId: row.plugin_id === null ? null : String(row.plugin_id),
        occurredAt: String(row.created_at),
        payload,
      };
    });
  }

  describeRuntime() {
    return {
      databasePath: this.dbPath,
      logPath: this.logPath,
      debug: this.debug,
    };
  }

  close() {
    this.db.close();
  }

  private requireConnectionById(id: string): ConnectorConnection {
    const row = this.db
      .prepare("SELECT * FROM connector_connection WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Connection ${id} was not found`);
    }
    return connectionFromRow(row);
  }

  private requireAgentConnectorGrantById(id: string): AgentConnectorGrant {
    const row = this.db
      .prepare("SELECT * FROM agent_connector_grant WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Agent connector grant ${id} was not found`);
    }
    return agentConnectorGrantFromRow(row);
  }

  private requirePortalHandoffSession(
    deploymentId: string,
  ): MarketplacePortalHandoffSession {
    const row = this.db
      .prepare(
        "SELECT * FROM marketplace_portal_handoff_session WHERE deployment_id = ?",
      )
      .get(deploymentId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Portal handoff session ${deploymentId} was not found`);
    }
    return portalHandoffSessionFromRow(
      row,
      this.decryptHandoffSessionToken(String(row.session_token)),
    );
  }

  private requireMarketplacePortalGrantRequest(input: {
    portalIssuer: string;
    deploymentId: string;
    requestId: string;
  }): MarketplacePortalGrantRequest {
    const row = this.db
      .prepare(
        `SELECT * FROM marketplace_portal_grant_request
         WHERE portal_issuer = ? AND deployment_id = ? AND request_id = ?`,
      )
      .get(input.portalIssuer, input.deploymentId, input.requestId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new Error(`Marketplace Portal grant request ${input.requestId} was not found`);
    }
    return marketplacePortalGrantRequestFromRow(row);
  }

  private requireMarketplaceAgentConsent(id: string): MarketplaceAgentConsent {
    const row = this.db
      .prepare("SELECT * FROM marketplace_agent_consent WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Marketplace consent ${id} was not found`);
    }
    return marketplaceAgentConsentFromRow(row);
  }

  private requireMarketplaceRuntimeOperation(
    id: string,
  ): MarketplaceRuntimeOperation {
    const row = this.db
      .prepare("SELECT * FROM marketplace_runtime_operation WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Marketplace runtime operation ${id} was not found`);
    }
    return marketplaceRuntimeOperationFromRow(row);
  }

  private requireCredentialRefById(id: string): CredentialRef {
    const row = this.db
      .prepare("SELECT * FROM credential_ref WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Credential ref ${id} was not found`);
    }
    return credentialRefFromRow(row);
  }

  private requireComposioImportById(id: string): ComposioImportRecord {
    const row = this.db
      .prepare("SELECT * FROM composio_import WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Composio import ${id} was not found`);
    }
    return composioImportFromRow(row);
  }

  private requireBrokerGrantById(id: string): MarketplaceBrokerGrant {
    const row = this.db
      .prepare("SELECT * FROM broker_grant WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Broker grant ${id} was not found`);
    }
    return brokerGrantFromRow(row);
  }
}

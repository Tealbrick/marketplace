/**
 * Company Box operator routes: list the collection, set an entry up for the
 * workspace (base URL + credentials + connection test), re-test, remove.
 *
 * Workspace comes from the operator principal; every mutation is governed
 * as connector.admin; credential values go straight into the encrypted
 * connector secret store and are never echoed, logged or audited (names and
 * keyed fingerprints only).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  COMPANY_BOX_COLLECTION,
  companyBoxMcpPluginId,
  companyBoxMcpSecretHeader,
  companyBoxMcpUrl,
  credentialFieldsFor,
  type CompanyBoxCatalog,
  type CompiledCompanyBoxEntry,
  type CompiledMcpEntry,
  type CompiledOpenApiEntry,
} from "./company-box.js";
import {
  bindCustomMcpForWorkspace,
  customMcpListing,
  customMcpManifest,
  displayUrl,
  listingIsOperatorCustomMcp,
} from "./custom-mcp.js";
import { checkMcpUrlSyntax, McpUrlPolicyError } from "./mcp-url-policy.js";
import { OpenApiCallError, type OpenApiCallResult } from "./openapi-http.js";
import type { SqliteMarketplaceStore } from "./store.js";
import type { MarketplaceListing } from "./types.js";

type Principal = { id: string; organizationId: string };

export type CompanyBoxRouteDeps = {
  store: SqliteMarketplaceStore;
  catalog: CompanyBoxCatalog;
  environment: Record<string, string | undefined>;
  /** Operator gate (also rejects a mismatched workspaceSlug). */
  operator: (request: FastifyRequest, reply: FastifyReply) => { principal: Principal } | { error: unknown };
  /** Governance gate for connector.admin operations; returns the decision id or a response to send. */
  govern: (input: {
    request: FastifyRequest;
    reply: FastifyReply;
    workspaceSlug: string;
    operation: string;
    pluginId: string;
    actorId: string;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: true; decisionId: string | null } | { ok: false; response: unknown }>;
  /** Run one REST operation for the workspace's configured target. */
  callOperation: (
    target: { entry: CompiledOpenApiEntry; baseUrl: string; credentials: Record<string, string> },
    key: string,
    args: Record<string, unknown>,
  ) => Promise<OpenApiCallResult>;
  /** Shared custom MCP refresh (tool load + publish); sets the reply status on failure. */
  refreshMcp: (input: {
    reply: FastifyReply;
    current: MarketplaceListing;
    workspaceSlug: string;
    actorId: string;
    rulesDecisionId: string | null;
  }) => Promise<unknown>;
};

const MAX_CREDENTIAL_LENGTH = 4_096;

const SetupSchema = z
  .object({
    baseUrl: z.string().trim().min(1).max(2_048),
    /** Omitted keys keep the stored value. */
    credentials: z.record(z.string().max(MAX_CREDENTIAL_LENGTH)).optional(),
    // Set by the principal-scope hook from the operator session.
    workspaceSlug: z.string().optional(),
    actorId: z.string().optional(),
  })
  .strict();

function credentialValueValid(value: string) {
  return value.length > 0 && /^[\t\x20-\x7e\x80-\xff]*$/u.test(value);
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/u, "");
}

export function registerCompanyBoxRoutes(app: FastifyInstance, deps: CompanyBoxRouteDeps) {
  const { store, catalog } = deps;

  /** The workspace's custom MCP connector installed from an `mcp` entry, if any. */
  const mcpListingFor = (entryId: string, workspaceSlug: string) =>
    store
      .listOwnedListings(workspaceSlug)
      .find(
        (listing) =>
          listingIsOperatorCustomMcp(listing) && customMcpManifest(listing).companyBox?.entryId === entryId,
      ) ?? null;

  const pluginIdFor = (entry: CompiledCompanyBoxEntry, workspaceSlug: string) =>
    entry.kind === "openapi"
      ? entry.pluginId
      : (mcpListingFor(entry.entry.id, workspaceSlug)?.pluginId ?? null);

  const credentialView = (entry: CompiledCompanyBoxEntry, workspaceSlug: string, pluginId: string | null) => {
    const secrets = pluginId ? store.listConnectorSecrets({ workspaceSlug, pluginId }) : [];
    const fields = credentialFieldsFor(entry.entry.auth);
    if (entry.kind === "openapi") {
      return fields.map((field) => {
        const secret = secrets.find((candidate) => candidate.name === field.key);
        return { key: field.key, label: field.label, secret: field.secret, configured: Boolean(secret), ...(secret ? { fingerprint: secret.fingerprint } : {}) };
      });
    }
    // mcp entries store one composed secret header.
    const header = secrets[0];
    return fields.map((field) => ({
      key: field.key,
      label: field.label,
      secret: field.secret,
      configured: Boolean(header),
      ...(header ? { fingerprint: header.fingerprint } : {}),
    }));
  };

  const entryView = (entry: CompiledCompanyBoxEntry, workspaceSlug: string) => {
    const pluginId = pluginIdFor(entry, workspaceSlug);
    const install = pluginId ? store.getInstall(workspaceSlug, pluginId) : null;
    const connection = pluginId ? store.getConnection(workspaceSlug, pluginId) : null;
    const exposed = entry.coverage.filter((item) => item.status === "exposed").length;
    const listing = entry.kind === "mcp" && pluginId ? store.getListingForWorkspace(pluginId, workspaceSlug) : null;
    const baseUrl =
      entry.kind === "openapi"
        ? typeof connection?.metadata.baseUrl === "string"
          ? connection.metadata.baseUrl
          : null
        : listing
          ? (customMcpManifest(listing).companyBox?.baseUrl ?? null)
          : null;
    return {
      id: entry.entry.id,
      displayName: entry.entry.displayName,
      description: entry.entry.description,
      category: entry.entry.category ?? null,
      source: entry.kind,
      appVersion: entry.entry.app.version,
      homepage: entry.entry.app.homepage ?? null,
      baseUrlExample: entry.entry.baseUrlExample ?? null,
      auth: { type: entry.entry.auth.type, fields: credentialFieldsFor(entry.entry.auth) },
      coverage: {
        unit: entry.kind === "openapi" ? ("operations" as const) : ("tools" as const),
        total: entry.coverage.length,
        exposed,
        excluded: entry.coverage.filter((item) => item.status === "excluded").length,
      },
      exposure: entry.exposure,
      outward: entry.coverage.filter((item) => item.outward).length,
      destructive: entry.coverage.filter((item) => item.destructive).length,
      healthOperation: entry.kind === "openapi" ? (entry.healthOperation?.ref ?? null) : null,
      pluginId,
      installed: install?.lifecycle === "installed",
      connection: connection
        ? {
            state: connection.state,
            detail: connection.detail,
            updatedAt: connection.updatedAt,
            baseUrl: baseUrl ? displayUrl(baseUrl) : null,
          }
        : null,
      credentials: credentialView(entry, workspaceSlug, pluginId),
    };
  };

  const usableEntry = (entryId: string, reply: FastifyReply) => {
    const entry = catalog.get(entryId);
    if (!entry) {
      reply.code(404);
      return { error: { ok: false, error: "company_box_entry_not_found" } } as const;
    }
    if (entry.errors.length) {
      reply.code(409);
      return { error: { ok: false, error: "company_box_entry_unavailable" } } as const;
    }
    return { entry } as const;
  };

  const secretAudit = (workspaceSlug: string, pluginId: string) =>
    store.listConnectorSecrets({ workspaceSlug, pluginId }).map((secret) => ({ name: secret.name, fingerprint: secret.fingerprint }));

  /** Run the entry's health operation and record the connection state. */
  const testOpenApi = async (entry: CompiledOpenApiEntry, workspaceSlug: string, baseUrl: string) => {
    const at = new Date().toISOString();
    let result: { ok: true; status: number } | { ok: false; errorCode: string; status: number | null };
    try {
      const response = await deps.callOperation(
        { entry, baseUrl, credentials: store.readConnectorSecretValues({ workspaceSlug, pluginId: entry.pluginId }) },
        entry.healthOperation!.key,
        {},
      );
      result = { ok: true, status: response.status };
    } catch (error) {
      if (!(error instanceof OpenApiCallError)) throw error;
      console.error(
        JSON.stringify({
          event: "marketplace.company_box.test_failed",
          pluginId: entry.pluginId,
          workspaceSlug,
          code: error.code,
          status: error.detail.status ?? null,
          reason: error.detail.reason ?? null,
        }),
      );
      result = { ok: false, errorCode: error.code, status: error.detail.status ?? null };
    }
    store.upsertConnection({
      workspaceSlug,
      pluginId: entry.pluginId,
      provider: entry.pluginId,
      backend: "openapi",
      state: result.ok ? "connected" : "blocked",
      detail: result.ok
        ? `Connected. ${entry.operations.length} operations available.`
        : result.errorCode === "openapi_auth_rejected"
          ? "The app rejected the credentials."
          : result.errorCode === "tailnet_unavailable"
            ? "The tailnet is unavailable, so Marketplace couldn't reach the app."
            : "Marketplace couldn't reach the app.",
      metadata: {
        baseUrl,
        lastTestAt: at,
        specSha256: entry.specSha256,
        operationCount: entry.operations.length,
        ...(result.ok ? {} : { errorCode: result.errorCode, status: result.status }),
      },
    });
    return result;
  };

  app.get("/api/marketplace/company-box", async (request, reply) => {
    const gate = deps.operator(request, reply);
    if ("error" in gate) return gate.error;
    const workspaceSlug = gate.principal.organizationId;
    return {
      ok: true,
      workspaceSlug,
      collection: COMPANY_BOX_COLLECTION,
      secretStoreAvailable: store.connectorSecretStoreAvailable(),
      entries: catalog.usable().map((entry) => entryView(entry, workspaceSlug)),
      unavailable: [
        ...catalog.loadErrors.map((error) => ({ id: error.entry, code: error.code })),
        ...catalog.entries
          .filter((entry) => entry.errors.length)
          .map((entry) => ({ id: entry.entry.id, code: "company_box_coverage_failed" })),
      ],
    };
  });

  app.post("/api/marketplace/company-box/:entryId/setup", async (request, reply) => {
    const gate = deps.operator(request, reply);
    if ("error" in gate) return gate.error;
    const { principal } = gate;
    const workspaceSlug = principal.organizationId;
    const found = usableEntry((request.params as { entryId: string }).entryId, reply);
    if ("error" in found) return found.error;
    const { entry } = found;
    const parsed = SetupSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "validation_failed" };
    }
    const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
    let origin: string;
    try {
      const target = entry.kind === "mcp" ? companyBoxMcpUrl(entry.entry, baseUrl) : baseUrl;
      origin = checkMcpUrlSyntax(target, deps.environment).url.origin;
    } catch (error) {
      if (error instanceof McpUrlPolicyError) {
        reply.code(400);
        return { ok: false, error: "company_box_base_url_not_allowed", reason: error.reason };
      }
      throw error;
    }
    const fields = credentialFieldsFor(entry.entry.auth);
    const provided = Object.entries(parsed.data.credentials ?? {}).map(([key, value]) => [key, value.trim()] as const);
    for (const [key, value] of provided) {
      if (!fields.some((field) => field.key === key)) {
        reply.code(400);
        return { ok: false, error: "company_box_credential_unknown", field: key };
      }
      if (!credentialValueValid(value)) {
        reply.code(400);
        return { ok: false, error: "company_box_credential_invalid", field: key };
      }
    }
    const providedKeys = new Set(provided.map(([key]) => key));
    const existingPluginId = pluginIdFor(entry, workspaceSlug);
    const stored = new Set(
      existingPluginId ? store.listConnectorSecrets({ workspaceSlug, pluginId: existingPluginId }).map((secret) => secret.name) : [],
    );
    const missing = fields.filter((field) =>
      entry.kind === "openapi"
        ? !providedKeys.has(field.key) && !stored.has(field.key)
        : // mcp: credentials compose one header, so they change together.
          providedKeys.size > 0
          ? !providedKeys.has(field.key)
          : stored.size === 0,
    );
    if (missing.length) {
      reply.code(400);
      return { ok: false, error: "company_box_credentials_required", fields: missing.map((field) => field.key) };
    }
    if (provided.length && !store.connectorSecretStoreAvailable()) {
      reply.code(503);
      return { ok: false, error: "connector_secret_store_unavailable" };
    }
    const pluginId =
      entry.kind === "openapi"
        ? entry.pluginId
        : (existingPluginId ?? companyBoxMcpPluginId(entry.entry.id, workspaceSlug, entry.entry.displayName));
    if (entry.kind === "mcp" && !existingPluginId && store.getListing(pluginId)) {
      reply.code(409);
      return { ok: false, error: "custom_mcp_already_exists", pluginId };
    }
    const decision = await deps.govern({
      request,
      reply,
      workspaceSlug,
      operation: "company-box.setup",
      pluginId,
      actorId: principal.id,
      payload: { entryId: entry.entry.id, source: entry.kind, origin, credentialFields: [...providedKeys] },
    });
    if (!decision.ok) return decision.response;

    if (entry.kind === "openapi") {
      return setupOpenApi({ entry, workspaceSlug, principal, baseUrl, origin, provided, decisionId: decision.decisionId });
    }
    return setupMcp({
      reply,
      entry,
      workspaceSlug,
      principal,
      pluginId,
      baseUrl,
      origin,
      credentials: Object.fromEntries(provided),
      decisionId: decision.decisionId,
    });

    async function setupOpenApi(input: {
      entry: CompiledOpenApiEntry;
      workspaceSlug: string;
      principal: Principal;
      baseUrl: string;
      origin: string;
      provided: ReadonlyArray<readonly [string, string]>;
      decisionId: string | null;
    }) {
      const listing = store.getListing(input.entry.pluginId)!;
      store.install(input.workspaceSlug, listing.pluginId);
      bindCustomMcpForWorkspace(store, input.workspaceSlug, listing);
      for (const [name, value] of input.provided) {
        store.putConnectorSecret({ workspaceSlug: input.workspaceSlug, pluginId: listing.pluginId, name, value });
      }
      const test = await testOpenApi(input.entry, input.workspaceSlug, input.baseUrl);
      store.recordAudit({
        workspaceSlug: input.workspaceSlug,
        pluginId: listing.pluginId,
        eventType: "marketplace.company_box.configured",
        actorId: input.principal.id,
        rulesDecisionId: input.decisionId,
        metadata: {
          entryId: input.entry.entry.id,
          origin: input.origin,
          credentials: secretAudit(input.workspaceSlug, listing.pluginId),
          test: test.ok ? { ok: true } : { ok: false, errorCode: test.errorCode },
        },
      });
      if (!test.ok) reply.code(502);
      return {
        ok: test.ok,
        ...(test.ok ? {} : { error: test.errorCode }),
        entry: entryView(input.entry, input.workspaceSlug),
      };
    }
  });

  async function setupMcp(input: {
    reply: FastifyReply;
    entry: CompiledMcpEntry;
    workspaceSlug: string;
    principal: Principal;
    pluginId: string;
    baseUrl: string;
    origin: string;
    credentials: Record<string, string>;
    decisionId: string | null;
  }) {
    const current = store.getListingForWorkspace(input.pluginId, input.workspaceSlug);
    const url = companyBoxMcpUrl(input.entry.entry, input.baseUrl);
    const previous = current ? customMcpManifest(current) : null;
    const endpointChanged = !previous || previous.url !== url || previous.transport !== input.entry.entry.mcp!.transport;
    const listing = customMcpListing({
      pluginId: input.pluginId,
      workspaceSlug: input.workspaceSlug,
      displayName: input.entry.entry.displayName,
      description: input.entry.entry.description,
      version: input.entry.entry.app.version,
      createdAt: current?.createdAt,
      manifest: {
        operatorManaged: true,
        transport: input.entry.entry.mcp!.transport,
        url,
        headers: {},
        tools: endpointChanged ? [] : previous!.tools,
        lastRefresh: endpointChanged ? null : previous!.lastRefresh,
        companyBox: { entryId: input.entry.entry.id, baseUrl: input.baseUrl },
      },
    });
    store.upsertListing(listing);
    const header = companyBoxMcpSecretHeader(input.entry.entry, input.credentials);
    if (header) {
      for (const secret of store.listConnectorSecrets({ workspaceSlug: input.workspaceSlug, pluginId: input.pluginId })) {
        if (secret.name !== header.name) {
          store.deleteConnectorSecret({ workspaceSlug: input.workspaceSlug, pluginId: input.pluginId, name: secret.name });
        }
      }
      store.putConnectorSecret({ workspaceSlug: input.workspaceSlug, pluginId: input.pluginId, name: header.name, value: header.value });
    }
    store.install(input.workspaceSlug, input.pluginId);
    bindCustomMcpForWorkspace(store, input.workspaceSlug, listing);
    const refreshed = (await deps.refreshMcp({
      reply: input.reply,
      current: listing,
      workspaceSlug: input.workspaceSlug,
      actorId: input.principal.id,
      rulesDecisionId: input.decisionId,
    })) as { ok?: boolean; error?: string };
    store.recordAudit({
      workspaceSlug: input.workspaceSlug,
      pluginId: input.pluginId,
      eventType: "marketplace.company_box.configured",
      actorId: input.principal.id,
      rulesDecisionId: input.decisionId,
      metadata: {
        entryId: input.entry.entry.id,
        origin: input.origin,
        credentials: secretAudit(input.workspaceSlug, input.pluginId),
        test: refreshed.ok ? { ok: true } : { ok: false, errorCode: refreshed.error ?? null },
      },
    });
    return {
      ok: refreshed.ok === true,
      ...(refreshed.ok ? {} : { error: refreshed.error }),
      entry: entryView(input.entry, input.workspaceSlug),
    };
  }

  app.post("/api/marketplace/company-box/:entryId/test", async (request, reply) => {
    const gate = deps.operator(request, reply);
    if ("error" in gate) return gate.error;
    const { principal } = gate;
    const workspaceSlug = principal.organizationId;
    const found = usableEntry((request.params as { entryId: string }).entryId, reply);
    if ("error" in found) return found.error;
    const { entry } = found;
    const pluginId = pluginIdFor(entry, workspaceSlug);
    const install = pluginId ? store.getInstall(workspaceSlug, pluginId) : null;
    if (!pluginId || install?.lifecycle !== "installed") {
      reply.code(409);
      return { ok: false, error: "company_box_not_set_up" };
    }
    const decision = await deps.govern({
      request,
      reply,
      workspaceSlug,
      operation: "company-box.test",
      pluginId,
      actorId: principal.id,
      payload: { entryId: entry.entry.id },
    });
    if (!decision.ok) return decision.response;
    if (entry.kind === "mcp") {
      const refreshed = (await deps.refreshMcp({
        reply,
        current: store.getListingForWorkspace(pluginId, workspaceSlug)!,
        workspaceSlug,
        actorId: principal.id,
        rulesDecisionId: decision.decisionId,
      })) as { ok?: boolean; error?: string };
      return { ok: refreshed.ok === true, ...(refreshed.ok ? {} : { error: refreshed.error }), entry: entryView(entry, workspaceSlug) };
    }
    const baseUrl = store.getConnection(workspaceSlug, pluginId)?.metadata.baseUrl;
    if (typeof baseUrl !== "string" || !baseUrl) {
      reply.code(409);
      return { ok: false, error: "company_box_not_set_up" };
    }
    const test = await testOpenApi(entry, workspaceSlug, baseUrl);
    store.recordAudit({
      workspaceSlug,
      pluginId,
      eventType: "marketplace.company_box.tested",
      actorId: principal.id,
      rulesDecisionId: decision.decisionId,
      metadata: { entryId: entry.entry.id, ok: test.ok, ...(test.ok ? {} : { errorCode: test.errorCode }) },
    });
    if (!test.ok) reply.code(502);
    return { ok: test.ok, ...(test.ok ? {} : { error: test.errorCode }), entry: entryView(entry, workspaceSlug) };
  });

  app.delete("/api/marketplace/company-box/:entryId", async (request, reply) => {
    const gate = deps.operator(request, reply);
    if ("error" in gate) return gate.error;
    const { principal } = gate;
    const workspaceSlug = principal.organizationId;
    const entryId = (request.params as { entryId: string }).entryId;
    const entry = catalog.get(entryId);
    if (!entry) {
      reply.code(404);
      return { ok: false, error: "company_box_entry_not_found" };
    }
    const pluginId = pluginIdFor(entry, workspaceSlug);
    if (!pluginId || !store.getInstall(workspaceSlug, pluginId)) {
      reply.code(409);
      return { ok: false, error: "company_box_not_set_up" };
    }
    const decision = await deps.govern({
      request,
      reply,
      workspaceSlug,
      operation: "company-box.remove",
      pluginId,
      actorId: principal.id,
      payload: { entryId },
    });
    if (!decision.ok) return decision.response;
    const credentials = secretAudit(workspaceSlug, pluginId);
    const brokerGrantsRevoked = store.revokeBrokerGrantsForPlugin({ workspaceSlug, pluginId });
    const agentAccess = store.revokeAgentAccessForPlugin({ workspaceSlug, pluginId });
    if (entry.kind === "mcp") {
      store.deleteListing(pluginId);
    } else {
      store.uninstall(workspaceSlug, pluginId);
      for (const secret of store.listConnectorSecrets({ workspaceSlug, pluginId })) {
        store.deleteConnectorSecret({ workspaceSlug, pluginId, name: secret.name });
      }
      store.upsertConnection({
        workspaceSlug,
        pluginId,
        provider: pluginId,
        backend: "openapi",
        state: "disconnected",
        detail: "Removed from this workspace.",
        metadata: {},
      });
    }
    store.recordAudit({
      workspaceSlug,
      pluginId,
      eventType: "marketplace.company_box.removed",
      actorId: principal.id,
      rulesDecisionId: decision.decisionId,
      metadata: {
        entryId,
        credentials,
        brokerGrantsRevoked,
        agentGrantsRevoked: agentAccess.grants,
        agentConsentsRevoked: agentAccess.consents,
      },
    });
    return { ok: true, entry: entry.errors.length ? null : entryView(entry, workspaceSlug) };
  });
}

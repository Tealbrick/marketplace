const jsonObject = { type: "object", additionalProperties: true } as const;
const bearerSecurity = [{ bearerAuth: [] }] as const;
const operatorSecurity = [{ operatorSession: [] }] as const;

export function buildMarketplaceOpenApi(baseUrl = "/") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Doppelganger Marketplace API",
      version: "0.2.0",
      description:
        "Program-owned catalog, Rules-governed plugin lifecycle, provider connections, capability bindings, Composio execution, and audit. The launch profile treats every non-Composio source as catalog-only. Hub and cross-app service routes require an internal bearer credential that is never exposed to the browser.",
    },
    servers: [{ url: baseUrl }],
    security: operatorSecurity,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Internal HDDA Host SDK or cross-app service credential.",
        },
        operatorSession: {
          type: "apiKey",
          in: "cookie",
          name: "dg_marketplace_operator_session",
          description: "Short-lived HttpOnly operator session. Browser mutations also require the per-session x-csrf-token header.",
        },
      },
    },
    tags: [
      { name: "Runtime" },
      { name: "Catalog" },
      { name: "Lifecycle" },
      { name: "Connections" },
      { name: "Bindings" },
      { name: "Execution" },
      { name: "Audit" },
      { name: "Provider settings" },
      { name: "Hub service" },
      { name: "Agent" },
    ],
    paths: {
      "/healthz": { get: { security: [], tags: ["Runtime"], summary: "Program liveness", responses: { "200": { description: "Healthy" } } } },
      "/status": { get: { security: [], tags: ["Runtime"], summary: "Redacted frontend-safe status", responses: { "200": { description: "Status" } } } },
      "/bootstrap.json": { get: { security: [], tags: ["Runtime"], summary: "Redacted frontend bootstrap and authorization posture", responses: { "200": { description: "Bootstrap" } } } },
      "/api/marketplace/auth/session": {
        get: { security: [], tags: ["Runtime"], summary: "Read the redacted operator-session state", responses: { "200": { description: "Session status" } } },
        post: { security: [], tags: ["Runtime"], summary: "Exchange the provisioned operator access token for an HttpOnly session", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["accessToken"], properties: { accessToken: { type: "string", writeOnly: true } } } } } }, responses: { "200": { description: "Session created" }, "401": { description: "Invalid token" }, "429": { description: "Rate limited" }, "503": { description: "Operator access is not configured" } } },
        delete: { security: operatorSecurity, tags: ["Runtime"], summary: "Revoke the current operator session", responses: { "200": { description: "Session revoked" }, "401": { description: "Unauthorized" } } },
      },
      "/api/status": { get: { security: operatorSecurity, tags: ["Runtime"], summary: "Detailed authenticated Program status", responses: { "200": { description: "Runtime status" } } } },
      "/api/marketplace/cards": { get: { tags: ["Catalog"], summary: "List operator-facing plugin cards", parameters: [{ name: "workspaceSlug", in: "query", schema: { type: "string", default: "default" } }], responses: { "200": { description: "Cards and provider state" } } } },
      "/api/marketplace/cards/summary": { get: { tags: ["Catalog"], summary: "List a bounded, searchable browser-safe catalog projection", description: "Returns exact catalog totals, redacted provider and connection status, and at most 100 lightweight records from the canonical Marketplace catalog. Arbitrary manifests and provider metadata are omitted.", parameters: [{ name: "workspaceSlug", in: "query", schema: { type: "string", default: "default" } }, { name: "search", in: "query", schema: { type: "string", maxLength: 200 } }, { name: "source", in: "query", schema: { type: "string", enum: ["all", "native", "activepieces", "composio", "nango", "mcp"], default: "all" } }, { name: "installed", in: "query", schema: { type: "boolean", default: false } }, { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 60 } }], responses: { "200": { description: "Bounded browser-safe catalog projection" } } } },
      "/api/marketplace/cards/{pluginId}": { get: { tags: ["Catalog"], summary: "Read one browser-safe operator card", description: "Returns the selected card's UI contract without arbitrary manifest, connection metadata, credentials, environment, or runtime endpoint fields.", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }, { name: "workspaceSlug", in: "query", schema: { type: "string", default: "default" } }], responses: { "200": { description: "Redacted operator card and provider status" }, "404": { description: "Not found" } } } },
      "/api/marketplace/plugins": { get: { tags: ["Catalog"], summary: "List catalog records with workspace state", parameters: [{ name: "workspaceSlug", in: "query", schema: { type: "string", default: "default" } }], responses: { "200": { description: "Plugins" } } } },
      "/api/marketplace/plugins/{pluginId}": { get: { tags: ["Catalog"], summary: "Read one plugin", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }, { name: "workspaceSlug", in: "query", schema: { type: "string" } }], responses: { "200": { description: "Plugin" }, "404": { description: "Not found" } } } },
      "/api/marketplace/plugins/{pluginId}/install": { post: { tags: ["Lifecycle"], summary: "Rules-governed install", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "201": { description: "Installed" }, "403": { description: "Rules denied" }, "503": { description: "Rules unavailable" } } } },
      "/api/marketplace/plugins/{pluginId}/uninstall": { post: { tags: ["Lifecycle"], summary: "Rules-governed uninstall", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "200": { description: "Uninstalled" }, "409": { description: "Required or not installed" } } } },
      "/api/marketplace/plugins/{pluginId}/register": { post: { tags: ["Lifecycle"], summary: "Register with the plugin runtime", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "201": { description: "Registered" } } } },
      "/api/marketplace/plugins/{pluginId}/unregister": { post: { tags: ["Lifecycle"], summary: "Unregister from the plugin runtime", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "200": { description: "Unregistered" }, "409": { description: "Required plugin" } } } },
      "/api/marketplace/plugins/{pluginId}/connection": { post: { tags: ["Connections"], summary: "Start or register a provider connection", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "200": { description: "Connection or OAuth redirect" }, "409": { description: "Provider unavailable" } } } },
      "/api/marketplace/plugins/{pluginId}/capability-binding": { post: { tags: ["Bindings"], summary: "Set a Rules-governed capability binding", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "201": { description: "Bound" } } } },
      "/api/marketplace/plugins/{pluginId}/action-binding": { post: { tags: ["Bindings"], summary: "Include or exclude an Agent action", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "201": { description: "Bound" } } } },
      "/api/marketplace/plugins/{pluginId}/execute": { post: { tags: ["Execution"], summary: "Execute one enabled and connected Composio action through Rules", description: "The launch profile executes only Composio-backed actions. Other catalog sources return 501 and are never recorded as successful usage. Operator frontends must confirm the impact before sending.", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "200": { description: "Executed through Composio" }, "403": { description: "Rules or binding denied" }, "409": { description: "Not installed or connected" }, "501": { description: "Catalog source is not executable in this launch profile" }, "502": { description: "Provider failed" } } } },
      "/api/marketplace/provider-health": { get: { tags: ["Connections"], summary: "Probe configured provider reachability", responses: { "200": { description: "Provider state" } } } },
      "/api/marketplace/audit": { get: { tags: ["Audit"], summary: "List lifecycle audit and usage evidence", parameters: [{ name: "workspaceSlug", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", default: 100 } }], responses: { "200": { description: "Audit" } } } },
      "/api/settings/providers/composio": {
        get: { security: operatorSecurity, tags: ["Provider settings"], summary: "Read redacted Composio settings", responses: { "200": { description: "Redacted settings" } } },
        put: { security: operatorSecurity, tags: ["Provider settings"], summary: "Persist allowlisted Composio settings and an optional API key", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { settings: { type: "object", properties: { composioApiKey: { type: "string", writeOnly: true }, composioBaseUrl: { type: "string", format: "uri" }, composioDefaultUserId: { type: "string" }, composioDefaultConnectedAccountId: { type: "string" } } } } } } } }, responses: { "200": { description: "Saved redacted settings" }, "400": { description: "Provider origin is not allowlisted" } } },
      },
      "/api/agent/capabilities": { get: { tags: ["Agent"], summary: "List enabled Composio tools currently projected to Agents", description: "Native, Activepieces, Nango, and MCP records are catalog-only and are not projected as executable Agent tools in this launch profile.", parameters: [{ name: "workspaceSlug", in: "query", schema: { type: "string", default: "default" } }], responses: { "200": { description: "Capabilities" } } } },
      "/api/marketplace/broker/grants": { post: { security: bearerSecurity, tags: ["Execution"], summary: "Issue a single-use scoped Composio broker grant", description: "Internal services only. Grants are stored as token hashes, expire within at most 900 seconds, and are consumed atomically before provider dispatch.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["requesterMiniappId", "pluginId", "actionKeys"], properties: { requesterMiniappId: { type: "string" }, pluginId: { type: "string" }, actionKeys: { type: "array", minItems: 1, items: { type: "string" } }, ttlSeconds: { type: "integer", minimum: 1, maximum: 900, default: 300 } } } } } }, responses: { "201": { description: "Single-use grant issued" }, "400": { description: "Invalid scope or TTL" }, "401": { description: "Unauthorized" }, "403": { description: "Rules denied" } } } },
      "/api/marketplace/hub/records": { get: { security: bearerSecurity, tags: ["Hub service"], summary: "Project normalized records to the HDDA Host SDK", responses: { "200": { description: "Projection" }, "401": { description: "Unauthorized" }, "503": { description: "Service auth unconfigured" } } } },
      "/api/marketplace/hub/plugins/{pluginId}/lifecycle": { post: { security: bearerSecurity, tags: ["Hub service"], summary: "Internal Host SDK lifecycle including enable, disable, and reload", parameters: [{ name: "pluginId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "200": { description: "Lifecycle changed" }, "401": { description: "Unauthorized" } } } },
      "/api/marketplace/v1/broker/composio/execute": { post: { security: bearerSecurity, tags: ["Execution"], summary: "Authenticated cross-app Composio broker execution", description: "Issues and consumes one internal single-use grant for this call; raw provider credentials are never returned.", requestBody: { required: true, content: { "application/json": { schema: jsonObject } } }, responses: { "200": { description: "Executed" }, "401": { description: "Unauthorized" }, "403": { description: "Rules denied" } } } },
    },
    "x-doppelganger-commands": [
      { id: "list-cards", method: "GET", path: "/api/marketplace/cards/summary?workspaceSlug={workspaceSlug}&limit=60" },
      { id: "read-card", method: "GET", path: "/api/marketplace/cards/{pluginId}?workspaceSlug={workspaceSlug}" },
      { id: "install", method: "POST", path: "/api/marketplace/plugins/{pluginId}/install" },
      { id: "connect", method: "POST", path: "/api/marketplace/plugins/{pluginId}/connection" },
      { id: "bind-action", method: "POST", path: "/api/marketplace/plugins/{pluginId}/action-binding" },
      { id: "inspect-audit", method: "GET", path: "/api/marketplace/audit?workspaceSlug={workspaceSlug}" },
    ],
    "x-doppelganger-templates": {
      install: { workspaceSlug: "default", actorId: "operator" },
      connectComposio: { workspaceSlug: "default", actorId: "operator", provider: "github", backend: "composio" },
      bindAction: { workspaceSlug: "default", actorId: "operator", actionKey: "github.tool.execute", enabled: true },
      execute: { workspaceSlug: "default", actorId: "operator", capability: "connector.dispatch", action: { type: "github.tool.execute" } },
    },
  };
}

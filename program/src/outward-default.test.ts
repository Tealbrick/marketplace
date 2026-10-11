/**
 * F3-1 / F3-4 (0.2.1 hotfix): actions whose risk nobody reviewed are outward by default.
 *
 * - A Composio toolkit without a curated policy: every tool needs `connector.dispatch` and every call is outward
 *   (held for the owner in owner approval mode), unless the tool is on the reviewed read allowlist. Name inference
 *   never makes a Composio tool read-only.
 * - An operator custom MCP server: its `readOnlyHint` and tool names never make a tool read-only; every tool needs
 *   at least `connector.dispatch` and is outward.
 * - Curated toolkits (googlecalendar) keep their policy (see composio-policy.test.ts).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { composioCallRisk, composioToolClassification, setComposioReadAllowlistForTests } from "./composio-policy.js";
import { AGENT_OPERATION } from "./contract.js";
import { applyComposioPolicyToListing, buildComposioListingFromTools, resolveActionRequirement } from "./connectors.js";
import { applyCustomMcpClassificationToListing, customMcpListing, customMcpManifest, customMcpToolCapability, customMcpToolRisk } from "./custom-mcp.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "./operator-auth.js";
import type { PortalAgentScopeVerifier } from "./portal-scope.js";
import { MarketplaceProviderSettingsStore } from "./provider-settings.js";
import { SqliteMarketplaceStore } from "./store.js";
import { startFakeMcpServer } from "./testing/fake-mcp-server.js";
import type { ConnectorCapability } from "./types.js";

const SERVICE = "marketplace-service-token-outward";
const PORTAL = "https://portal.test";
const TENANT = "atlas";
const APP_GRANT = `tbag_${"o".repeat(43)}`;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("classification: unreviewed means outward", () => {
  it("never lets name inference make an uncurated Composio tool read-only or quiet", () => {
    for (const [slug, inferred] of [
      ["GMAIL_SEND_EMAIL", "connector.dispatch"],
      ["GMAIL_FETCH_EMAILS", "connector.observe"],
      ["SLACK_LIST_CHANNELS", "connector.observe"],
      ["SLACK_CHAT_POST_MESSAGE", "connector.observe"],
    ] as const) {
      const toolkit = slug.split("_")[0]!.toLowerCase();
      expect(composioToolClassification(toolkit, slug, inferred), slug).toEqual({ capability: "connector.dispatch", outward: "always", destructive: false, curated: false });
      expect(composioCallRisk(toolkit, slug, {}, inferred), slug).toEqual({ write: true, outward: true, destructive: false });
    }
    // Inference may only tighten: a name-inferred admin stays admin, still outward.
    expect(composioToolClassification("github", "GITHUB_DELETE_A_REPOSITORY", "connector.admin")).toMatchObject({ capability: "connector.admin", outward: "always" });
  });

  it("treats only reviewed allowlist entries of uncurated toolkits as reads; curated toolkits ignore the allowlist", () => {
    const restore = setComposioReadAllowlistForTests({ gmail: ["GMAIL_FETCH_EMAILS"], googlecalendar: ["GOOGLECALENDAR_CREATE_EVENT"] });
    try {
      expect(composioToolClassification("gmail", "gmail_fetch_emails", "connector.dispatch")).toEqual({ capability: "connector.observe", outward: null, destructive: false, curated: false });
      expect(composioCallRisk("gmail", "GMAIL_FETCH_EMAILS", { anything: true }, "connector.observe")).toEqual({ write: false, outward: false, destructive: false });
      expect(composioToolClassification("gmail", "GMAIL_SEND_EMAIL", "connector.dispatch")).toMatchObject({ outward: "always" });
      // googlecalendar has a curated policy: its classification is unchanged by the allowlist.
      expect(composioToolClassification("googlecalendar", "GOOGLECALENDAR_CREATE_EVENT", "connector.dispatch")).toMatchObject({ capability: "connector.dispatch", outward: "unlessQuiet", curated: true });
      expect(composioCallRisk("googlecalendar", "GOOGLECALENDAR_CREATE_EVENT", { send_updates: "none" }, "connector.dispatch").outward).toBe(false);
    } finally {
      restore();
    }
    expect(composioToolClassification("gmail", "GMAIL_FETCH_EMAILS", "connector.observe").outward).toBe("always");
  });

  it("classifies new listings, re-classifies stored ones and overrides the static requirement table", () => {
    const listing = buildComposioListingFromTools({ toolkit: "gmail", tools: [{ name: "GMAIL_FETCH_EMAILS" }, { name: "GMAIL_SEND_EMAIL" }] });
    expect(resolveActionRequirement(listing, "gmail.fetch.emails")?.capability).toBe("connector.dispatch");
    expect(listing.capabilities).toEqual(["connector.dispatch"]);
    expect((listing.manifest.composio as { tools: Array<Record<string, unknown>> }).tools.every((tool) => tool.outward === "always")).toBe(true);
    expect(applyComposioPolicyToListing(listing)).toBeNull();
    // A listing stored before the fix: observe, not outward.
    const stale = JSON.parse(JSON.stringify(listing));
    stale.manifest.actionRequirements["gmail.fetch.emails"].capability = "connector.observe";
    stale.manifest.composio.tools = stale.manifest.composio.tools.map((tool: Record<string, unknown>) => ({ ...tool, capability: "connector.observe", outward: undefined }));
    expect(resolveActionRequirement(stale, "gmail.fetch.emails")?.capability).toBe("connector.dispatch");
    const refreshed = applyComposioPolicyToListing(stale)!;
    expect(refreshed.manifest.actionRequirements).toMatchObject({ "gmail.fetch.emails": { capability: "connector.dispatch" } });
    expect((refreshed.manifest.composio as { tools: Array<Record<string, unknown>> }).tools[0]).toMatchObject({ outward: "always", capability: "connector.dispatch" });
    // `github.repositories.list` is also a native static requirement (observe); it does not apply to Composio.
    const github = buildComposioListingFromTools({ toolkit: "github", tools: [{ name: "GITHUB_REPOSITORIES_LIST" }] });
    expect(github.actions).toEqual(["github.repositories.list"]);
    expect(resolveActionRequirement(github, "github.repositories.list")?.capability).toBe("connector.dispatch");
  });

  it("ignores a custom MCP server's readOnlyHint and names; hints only tighten; an owner flag is the only read", () => {
    expect(customMcpToolCapability({ annotations: { readOnlyHint: true } }, "send-message")).toBe("connector.dispatch");
    expect(customMcpToolCapability({ annotations: { readOnlyHint: true } }, "list-tickets")).toBe("connector.dispatch");
    expect(customMcpToolCapability({}, "get-status")).toBe("connector.dispatch");
    expect(customMcpToolCapability({ annotations: { readOnlyHint: true, destructiveHint: true } }, "list")).toBe("connector.admin");
    expect(customMcpToolCapability({}, "delete-everything")).toBe("connector.admin");
    expect(customMcpToolCapability({ annotations: { destructiveHint: true } }, "send", { readOnly: true })).toBe("connector.observe");
    expect(customMcpToolRisk("connector.dispatch")).toEqual({ write: true, outward: true, destructive: false });
    expect(customMcpToolRisk("connector.admin")).toEqual({ write: true, outward: true, destructive: true });
    expect(customMcpToolRisk("connector.observe")).toEqual({ write: false, outward: false, destructive: false });
  });

  it("re-classifies a stored custom MCP listing whose tools came from readOnlyHint", () => {
    const listing = customMcpListing({
      pluginId: "mcp-desk-1",
      workspaceSlug: TENANT,
      displayName: "Desk",
      manifest: {
        operatorManaged: true,
        transport: "streamable-http",
        url: "https://mcp.example.invalid/mcp",
        headers: {},
        lastRefresh: null,
        tools: [{ name: "send_message", action: "mcp-desk-1.send-message", capability: "connector.observe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      },
    });
    const stored = { ...listing, manifest: { ...listing.manifest, skillsHub: { ...(listing.manifest.skillsHub as object), operatorManaged: true } } };
    const reclassified = applyCustomMcpClassificationToListing(stored);
    expect(reclassified).not.toBeNull();
    expect(customMcpManifest(reclassified!).tools[0]!.capability).toBe("connector.dispatch");
    expect(reclassified!.capabilities).toEqual(["connector.dispatch"]);
    expect(applyCustomMcpClassificationToListing(reclassified!)).toBeNull();
  });
});

/**
 * Owner approval mode (no Rules). The agent scope verifier enforces the capability the action needs, like Portal:
 * `capabilities` is what the agent's consent covers.
 */
async function ownerMode(input: { capabilities: ConnectorCapability[]; mcpOrigin?: string }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-outward-default-"));
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), { handoffEncryptionKey: "a".repeat(64) });
  const executions: Array<{ tool: string; body: Record<string, unknown> }> = [];
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "operator-access-token", operatorId: "owner-1", organizationId: TENANT });
  const agentScopeVerifier: PortalAgentScopeVerifier = async ({ agentToken, requiredCapability }) => {
    if (!input.capabilities.includes(requiredCapability as ConnectorCapability)) throw new Error("capability_not_granted");
    return { organizationId: TENANT, agentId: agentToken, attachmentId: "attachment-1", capabilities: input.capabilities, expiresAt: Math.floor(Date.now() / 1000) + 300 };
  };
  const portalFetch: typeof fetch = async (url) => {
    if (String(url).endsWith("/api/runtime/app-grant/introspect")) {
      return new Response(
        JSON.stringify({
          authorized: true,
          principalId: "tealbrick-agent:agent-1",
          agentId: "agent-1",
          orgId: "portal-org-1",
          workspaceId: TENANT,
          deploymentId: "deployment-1",
          product: "marketplace",
          productTenantId: TENANT,
          actions: ["create", "read"],
          operations: [AGENT_OPERATION.consentsList, AGENT_OPERATION.toolsCall],
          capabilityRevision: 1,
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: TENANT,
    operatorSessionManager: sessions,
    agentScopeVerifier,
    portalFetch,
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    environment: {
      NODE_ENV: "test",
      MARKETPLACE_ORGANIZATION_ID: TENANT,
      MARKETPLACE_PORTAL_URL: `${PORTAL}/`,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: "p".repeat(43),
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: TENANT,
      ...(input.mcpOrigin ? { MARKETPLACE_MCP_ALLOWED_ORIGINS: input.mcpOrigin } : {}),
    },
    ...(input.mcpOrigin ? { providerSettings: new MarketplaceProviderSettingsStore(path.join(root, "ps.json"), path.join(root, "pss.json"), {}) } : {}),
    providerFetch: async (url, init) => {
      const match = /\/tools\/execute\/([A-Z0-9_]+)/u.exec(String(url));
      if (match) {
        executions.push({ tool: match[1]!, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(JSON.stringify({ data: { id: "sent-1" }, successful: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
  });
  cleanups.push(async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const login = sessions.exchange("operator-access-token", "outward-default");
  const operator = { origin: "http://localhost", cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${login.token}`, "x-csrf-token": login.status.csrfToken! };
  const service = { authorization: `Bearer ${SERVICE}` };
  const agent = { ...service, "x-tealbrick-agent-token": "agent-1", "x-tealbrick-attachment": "attachment-1" };
  const approve = (approvalId: string) =>
    app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${approvalId}/approve`, headers: operator });
  return { app, store, executions, operator, service, agent, approve };
}

type Fixture = Awaited<ReturnType<typeof ownerMode>>;

async function importGmail(f: Fixture) {
  const imported = await f.app.inject({
    method: "POST",
    url: "/api/marketplace/catalog/composio/import",
    headers: f.service,
    payload: {
      workspaceSlug: TENANT,
      toolkit: "gmail",
      pluginId: "gmail-composio",
      tools: [
        { name: "GMAIL_SEND_EMAIL", description: "Send an email." },
        { name: "GMAIL_FETCH_EMAILS", description: "Fetch emails." },
      ],
      autoEnable: true,
    },
  });
  expect(imported.statusCode, imported.body).toBe(201);
  const connection = f.store.upsertConnection({
    workspaceSlug: TENANT, pluginId: "gmail-composio", provider: "gmail", backend: "composio", state: "connected",
    detail: "Test connected account", metadata: { connectedAccountId: "ca_1" },
  });
  for (const capability of ["connector.observe", "connector.dispatch"] as const) {
    f.store.bindCapability({ workspaceSlug: TENANT, pluginId: "gmail-composio", capability, enabled: true });
  }
  return connection;
}

const sendInput = { recipient_email: "someone@example.invalid", subject: "hi", body: "from an agent" };

function portalConsent(f: Fixture, connectionId: string, actionKey: string, capability: ConnectorCapability, consentId: string) {
  return f.store.createMarketplaceAgentConsent({
    portalIssuer: PORTAL,
    portalOrgId: "portal-org-1",
    productTenantId: TENANT,
    workspaceId: TENANT,
    deploymentId: "deployment-1",
    userId: "owner-1",
    agentId: "agent-1",
    consentId,
    consentRevision: 1,
    pluginId: "gmail-composio",
    actionKey,
    capability,
    connectionId,
    accountId: "ca_1",
    resourceKind: "gmail.connected-account",
    resourceRef: "account:ca_1",
    capabilities: [capability],
    requiredActions: [capability === "connector.observe" ? "read" : "create"],
  }).consent;
}

const toolsCall = (f: Fixture, body: Record<string, unknown>, key = "outward-key-0001") =>
  f.app.inject({
    method: "POST",
    url: "/api/marketplace/v1/agent/tools/call",
    headers: { authorization: `Bearer ${APP_GRANT}`, "idempotency-key": key },
    payload: body,
  });

describe("owner mode: an uncurated Composio toolkit (F3-1)", () => {
  it("holds a send on a dispatch grant (/api/agent/tools) until the owner approves, then executes it once", async () => {
    const f = await ownerMode({ capabilities: ["connector.observe", "connector.dispatch"] });
    await importGmail(f);
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: f.agent,
      payload: { workspaceSlug: TENANT, pluginId: "gmail-composio", actionKey: "gmail.send.email", accountId: "ca_1", resourceKind: "gmail.connected-account", resourceRef: "account:ca_1" },
    });
    expect(grant.statusCode, grant.body).toBe(201);
    expect(grant.json().grant.capability).toBe("connector.dispatch");
    const sent = await f.app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.gmail.send.email",
      headers: f.agent,
      payload: { workspaceSlug: TENANT, pluginId: "gmail-composio", grantId: grant.json().grant.id, input: sendInput },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(sent.json()).toMatchObject({ status: "approval_pending", approvalId: expect.any(String) });
    expect(f.executions).toEqual([]);
    const approvalId = sent.json().approvalId as string;
    expect(f.store.getCompanyBoxApproval(approvalId)).toMatchObject({ state: "pending", pluginId: "gmail-composio", actionKey: "gmail.send.email" });

    const approved = await f.approve(approvalId);
    expect(approved.json(), approved.body).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    expect(f.executions).toEqual([{ tool: "GMAIL_SEND_EMAIL", body: expect.objectContaining({ arguments: sendInput }) }]);
    // A second approve does not send again.
    await f.approve(approvalId);
    expect(f.executions).toHaveLength(1);
  });

  it("holds a send on a Portal dispatch consent (marketplace.tools.call) until the owner approves", async () => {
    const f = await ownerMode({ capabilities: ["connector.dispatch"] });
    const connection = await importGmail(f);
    portalConsent(f, connection.id, "gmail.send.email", "connector.dispatch", "consent-send");
    const body = { consentId: "consent-send", toolkit: "gmail-composio", action: "gmail.send.email", arguments: sendInput };
    const held = await toolsCall(f, body);
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ status: "approval_pending", approvalId: expect.any(String) });
    expect(f.executions).toEqual([]);
    // The same key returns the same held call; nothing is sent.
    const again = await toolsCall(f, body);
    expect(again.statusCode).toBe(202);
    expect(again.json().approvalId).toBe(held.json().approvalId);
    expect(f.executions).toEqual([]);

    expect((await f.approve(held.json().approvalId)).json()).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_SEND_EMAIL"]);
    const done = await toolsCall(f, body);
    expect(done.statusCode).toBe(200);
    expect(f.executions).toHaveLength(1);
  });

  it("refuses an uncurated tool on a read-only (observe) consent before anything executes", async () => {
    const f = await ownerMode({ capabilities: ["connector.observe"] });
    const connection = await importGmail(f);
    // Portal consent minted at observe (e.g. before this fix) for a fetch tool and for a send tool.
    portalConsent(f, connection.id, "gmail.fetch.emails", "connector.observe", "consent-fetch");
    portalConsent(f, connection.id, "gmail.send.email", "connector.observe", "consent-send-ro");
    for (const [consentId, action] of [["consent-fetch", "gmail.fetch.emails"], ["consent-send-ro", "gmail.send.email"]] as const) {
      const response = await toolsCall(f, { consentId, toolkit: "gmail-composio", action, arguments: {} }, `key-${consentId}`);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: "runtime_connection_unavailable" });
    }
    // Agent grants: the action needs connector.dispatch, which a read-only consent does not cover.
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: f.agent,
      payload: { workspaceSlug: TENANT, pluginId: "gmail-composio", actionKey: "gmail.fetch.emails", accountId: "ca_1", resourceKind: "gmail.connected-account", resourceRef: "account:ca_1" },
    });
    expect(grant.statusCode).not.toBe(201);
    const direct = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/gmail-composio/execute",
      headers: f.operator,
      payload: { workspaceSlug: TENANT, capability: "connector.observe", action: { type: "gmail.send.email", ...sendInput } },
    });
    expect(direct.statusCode).toBe(400);
    expect(direct.json()).toMatchObject({ error: "connector_capability_mismatch", requiredCapability: "connector.dispatch" });
    expect(f.executions).toEqual([]);
    expect(f.store.listCompanyBoxApprovals({ workspaceSlug: TENANT })).toEqual([]);
  });

  it("tells the agent the uncurated tool is outward and held; a reviewed read is not", async () => {
    const restore = setComposioReadAllowlistForTests({ gmail: ["GMAIL_FETCH_EMAILS"] });
    cleanups.push(restore);
    const f = await ownerMode({ capabilities: ["connector.observe", "connector.dispatch"] });
    await importGmail(f);
    const response = await f.app.inject({ method: "GET", url: `/api/agent/capabilities?workspaceSlug=${TENANT}`, headers: f.service });
    expect(response.statusCode).toBe(200);
    const tools = (response.json().capabilities as Array<Record<string, unknown>>).filter((tool) => tool.pluginId === "gmail-composio");
    expect(tools.find((tool) => tool.actionType === "gmail.send.email")).toMatchObject({
      requiredCapabilities: ["connector.dispatch"],
      risk: { write: true, outward: true, destructive: false },
      description: expect.stringContaining("each call waits for the owner's approval"),
    });
    expect(tools.find((tool) => tool.actionType === "gmail.fetch.emails")).toMatchObject({
      requiredCapabilities: ["connector.observe"],
      risk: { write: false, outward: false, destructive: false },
    });
    expect(String(tools.find((tool) => tool.actionType === "gmail.fetch.emails")?.description)).not.toContain("approval");
    const guidance = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/guidance/1", headers: { authorization: `Bearer ${APP_GRANT}` } });
    expect(guidance.statusCode, guidance.body).toBe(200);
    expect(guidance.body).toContain("every action of a connector without a reviewed policy");
    expect(guidance.body).toContain("`202 approval_pending`");
    // The reviewed read runs on a read-only grant without a hold.
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: f.agent,
      payload: { workspaceSlug: TENANT, pluginId: "gmail-composio", actionKey: "gmail.fetch.emails", accountId: "ca_1", resourceKind: "gmail.connected-account", resourceRef: "account:ca_1" },
    });
    expect(grant.json().grant.capability).toBe("connector.observe");
    const read = await f.app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.gmail.fetch.emails",
      headers: f.agent,
      payload: { workspaceSlug: TENANT, pluginId: "gmail-composio", grantId: grant.json().grant.id, input: {} },
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_FETCH_EMAILS"]);
  });
});

describe("owner mode: a custom MCP tool marked readOnlyHint:true (F3-4)", () => {
  async function customServer(capabilities: ConnectorCapability[]) {
    const server = await startFakeMcpServer({
      tools: [
        {
          name: "send_message",
          description: "Send a message to a customer.",
          inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    cleanups.push(() => server.close());
    const f = await ownerMode({ capabilities, mcpOrigin: server.origin });
    const created = await f.app.inject({ method: "POST", url: "/api/marketplace/connectors/custom", headers: f.operator, payload: { displayName: "Support Desk", url: server.streamableUrl, transport: "streamable-http" } });
    expect(created.statusCode, created.body).toBe(201);
    const pluginId = created.json().connector.pluginId as string;
    const refreshed = await f.app.inject({ method: "POST", url: `/api/marketplace/connectors/custom/${pluginId}/refresh`, headers: f.operator });
    expect(refreshed.json().connector.tools).toEqual([expect.objectContaining({ name: "send_message", capability: "connector.dispatch" })]);
    expect((await f.app.inject({ method: "POST", url: `/api/marketplace/plugins/${pluginId}/install`, headers: f.operator, payload: {} })).statusCode).toBe(201);
    const toolCalls = () => server.requests.filter((request) => request.rpcMethod === "tools/call").length;
    const grant = () =>
      f.app.inject({
        method: "POST",
        url: "/api/marketplace/agent/grants",
        headers: f.agent,
        payload: { workspaceSlug: TENANT, pluginId, actionKey: `${pluginId}.send-message`, accountId: "connector", resourceKind: `${pluginId}.connected-account`, resourceRef: "account:connector" },
      });
    const call = (grantId: string) =>
      f.app.inject({
        method: "POST",
        url: `/api/agent/tools/marketplace.${pluginId}.send-message`,
        headers: f.agent,
        payload: { workspaceSlug: TENANT, pluginId, grantId, input: { to: "customer@example.invalid", text: "hello" } },
      });
    return { f, pluginId, toolCalls, grant, call };
  }

  it("is refused on a read-only consent", async () => {
    const { f, pluginId, toolCalls, grant } = await customServer(["connector.observe"]);
    expect((await grant()).statusCode).not.toBe(201);
    const direct = await f.app.inject({
      method: "POST",
      url: `/api/marketplace/plugins/${pluginId}/execute`,
      headers: f.operator,
      payload: { workspaceSlug: TENANT, capability: "connector.observe", action: { type: `${pluginId}.send-message`, to: "x", text: "y" } },
    });
    expect(direct.json()).toMatchObject({ error: "connector_capability_mismatch", requiredCapability: "connector.dispatch" });
    expect(toolCalls()).toBe(0);
  });

  it("is held on a dispatch consent and runs once after the owner approves", async () => {
    const { f, pluginId, toolCalls, grant, call } = await customServer(["connector.observe", "connector.dispatch"]);
    const granted = await grant();
    expect(granted.statusCode, granted.body).toBe(201);
    const held = await call(granted.json().grant.id);
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ status: "approval_pending" });
    expect(toolCalls()).toBe(0);
    const capabilities = (await f.app.inject({ method: "GET", url: `/api/agent/capabilities?workspaceSlug=${TENANT}`, headers: f.service })).json().capabilities as Array<Record<string, unknown>>;
    expect(capabilities.find((tool) => tool.pluginId === pluginId)).toMatchObject({ risk: { outward: true }, description: expect.stringContaining("owner's approval") });
    expect((await f.approve(held.json().approvalId)).json()).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    expect(toolCalls()).toBe(1);
  });
});

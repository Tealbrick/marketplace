import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolvePublishedAgentAction } from "./agent-action-catalog.js";
import { buildMarketplaceApp } from "./app.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "./operator-auth.js";
import type { PortalRuntimeScopeVerifier } from "./portal-runtime-scope.js";
import { SqliteMarketplaceStore } from "./store.js";
import { startFakeMcpServer } from "./testing/fake-mcp-server.js";

const ORIGIN = "http://127.0.0.1:5314";
const SERVICE_TOKEN = "marketplace-service-token-1234";
const SERVICE = { authorization: `Bearer ${SERVICE_TOKEN}` };
const SECRET = "sk-fixture-secret-value-0001";
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-catalog-mcp-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), {
    handoffEncryptionKey: "a".repeat(64),
  });
  const server = await startFakeMcpServer({ requiredHeader: { name: "x-api-key", value: SECRET } });
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234" });
  const portalRequests: Array<Record<string, unknown>> = [];
  const portalGrants = new Map<string, Record<string, unknown>>();
  const verifierCalls: Array<Parameters<PortalRuntimeScopeVerifier>[0]> = [];
  let sequence = 0;
  let leaseConsent = "";
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE_TOKEN,
    organizationId: "ws-a",
    operatorSessionManager: sessions,
    env: {},
    environment: { NODE_ENV: "test", MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin },
    mcpFetch: (resource, init) => fetch(resource, init),
    portalIssuerUrl: "https://portal.test",
    portalInstanceProof: "p".repeat(43),
    portalFetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (pathname === "/api/deployment-browser/grant-request") {
        portalRequests.push(body);
        const requestId = `${"r".repeat(42)}${sequence++ % 10}`;
        portalGrants.set(requestId, body);
        return new Response(JSON.stringify({ requestId, approvalUrl: `https://portal.test/approve/${requestId}`, expiresAt: Date.now() + 600_000 }), { status: 200 });
      }
      const requested = portalGrants.get(String(body.requestId))!;
      const selection = requested.selection as Record<string, string>;
      return new Response(
        JSON.stringify({
          schema: 1,
          authorized: true,
          product: "marketplace",
          portalOrgId: "portal-org",
          productTenantId: "ws-a",
          workspaceId: "ws-a",
          deploymentId: "deployment-1",
          userId: "owner-1",
          agentId: requested.agentId,
          consentId: `consent-${String(body.requestId).slice(-1)}`,
          consentRevision: 1,
          state: "active",
          capabilities: [selection.capability ?? "connector.observe"],
          requiredActions: ["read", "create"],
          selection,
        }),
        { status: 200 },
      );
    },
    portalRuntimeScopeVerifier: async (input) => {
      verifierCalls.push(input);
      return {
        portalOrgId: "portal-org",
        productTenantId: "ws-a",
        workspaceId: "ws-a",
        deploymentId: "deployment-1",
        agentId: "agent-1",
        consentId: leaseConsent,
        leaseId: "lease-1",
        capabilities: [input.requiredCapability],
        expiresAt: Date.now() + 300_000,
      };
    },
    agentScopeVerifier: async ({ requiredCapability }) => ({
      organizationId: "ws-a",
      agentId: "agent-1",
      attachmentId: "attachment-1",
      capabilities: [requiredCapability],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }),
    rulesClient: async () => ({ effect: "allow", decisionId: "rules-allow" }),
  });
  store.upsertPortalHandoffSession({
    portalIssuer: "https://portal.test",
    deploymentId: "deployment-1",
    portalOrgId: "portal-org",
    productTenantId: "ws-a",
    workspaceId: "ws-a",
    userId: "owner-1",
    sessionToken: "s".repeat(43),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const operator = (organizationId: string) => {
    const { token, status } = sessions.issuePortalSession({ id: `operator-${organizationId}`, organizationId });
    return { cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`, origin: ORIGIN, "x-csrf-token": status.csrfToken! };
  };
  const a = operator("ws-a");
  const created = await app.inject({
    method: "POST",
    url: "/api/marketplace/connectors/custom",
    headers: a,
    payload: { displayName: "Issue Tracker", url: server.streamableUrl, transport: "streamable-http", secretHeaders: { "X-Api-Key": SECRET } },
  });
  expect(created.statusCode).toBe(201);
  const pluginId = created.json().connector.pluginId as string;
  expect((await app.inject({ method: "POST", url: `/api/marketplace/connectors/custom/${pluginId}/refresh`, headers: a })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: `/api/marketplace/plugins/${pluginId}/install`, headers: a, payload: {} })).statusCode).toBe(201);
  closers.push(async () => {
    await app.close();
    store.close();
    await server.close();
  });
  return {
    app,
    store,
    server,
    pluginId,
    a,
    operator,
    portalRequests,
    verifierCalls,
    setLeaseConsent(consentId: string) {
      leaseConsent = consentId;
    },
    catalog: async (headers: Record<string, string>) =>
      app.inject({ method: "GET", url: "/api/marketplace/v1/agent/action-catalog", headers }),
  };
}

describe("agent action catalog: custom MCP connectors", () => {
  it("publishes the workspace's refreshed MCP tools with a synthetic connector account", async () => {
    const f = await fixture();
    const response = await f.catalog(f.a);
    expect(response.statusCode).toBe(200);
    const actions = response.json().actions as Array<Record<string, unknown>>;
    const mcp = actions.filter((entry) => entry.pluginId === f.pluginId);
    expect(mcp.map((entry) => [entry.toolName, entry.capability])).toEqual([
      ["create_issue", "connector.dispatch"],
      ["Delete Everything!", "connector.admin"],
      ["echo", "connector.observe"],
      ["fail_tool", "connector.dispatch"],
    ]);
    const createIssue = mcp.find((entry) => entry.toolName === "create_issue");
    expect(createIssue).toEqual({
      pluginId: f.pluginId,
      pluginName: "Issue Tracker",
      provider: f.pluginId,
      actionKey: `${f.pluginId}.create-issue`,
      label: "create_issue",
      description: "Create an issue.",
      capability: "connector.dispatch",
      resourceKind: `${f.pluginId}.connected-account`,
      mode: "connected-account",
      accounts: [{ accountId: "connector", label: "Issue Tracker" }],
      allowedArguments: ["title"],
      toolName: "create_issue",
    });
    expect(mcp.find((entry) => entry.toolName === "echo")).toMatchObject({ label: "Echo", allowedArguments: ["message"] });
    expect(mcp.find((entry) => entry.toolName === "Delete Everything!")).toMatchObject({ allowedArguments: null });
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain(f.server.origin);
  });

  it("never shows one workspace's custom connector to another workspace", async () => {
    const f = await fixture();
    const b = f.operator("ws-b");
    const other = await f.catalog(b);
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ workspaceSlug: "ws-b", actions: [] });
    // Even with install, bindings, and a connected row in ws-b, the listing stays ws-a's.
    f.store.install("ws-b", f.pluginId);
    f.store.bindCapability({ workspaceSlug: "ws-b", pluginId: f.pluginId, capability: "connector.dispatch", enabled: true });
    f.store.upsertConnection({ workspaceSlug: "ws-b", pluginId: f.pluginId, provider: f.pluginId, backend: "mcp", state: "connected", detail: "forged", metadata: {} });
    expect(resolvePublishedAgentAction({ store: f.store, workspaceSlug: "ws-b", pluginId: f.pluginId, actionKey: `${f.pluginId}.create-issue` })).toBeNull();
    expect((await f.catalog(b)).json().actions).toEqual([]);
    expect(resolvePublishedAgentAction({ store: f.store, workspaceSlug: "ws-a", pluginId: f.pluginId, actionKey: `${f.pluginId}.create-issue` })).not.toBeNull();
  });

  it("runs a dispatch MCP action through request, redeem, runtime and scoped execute, then denies it once disconnected or deleted", async () => {
    const f = await fixture();
    const actionKey = `${f.pluginId}.create-issue`;
    const selection = {
      pluginId: f.pluginId,
      actionKey,
      accountId: "connector",
      resourceKind: `${f.pluginId}.connected-account`,
      resourceRef: "account:connector",
    };
    const requested = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection, idempotencyKey: "mcp-request-1" },
    });
    expect(requested.statusCode).toBe(200);
    expect(f.portalRequests.at(-1)?.selection).toEqual({ ...selection, capability: "connector.dispatch" });
    const redeemed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/redeem",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", requestId: requested.json().request.requestId },
    });
    expect(redeemed.statusCode).toBe(200);
    const consent = redeemed.json().consent;
    expect(consent).toMatchObject({ pluginId: f.pluginId, actionKey, capability: "connector.dispatch", accountId: "connector" });
    f.setLeaseConsent(consent.consentId);

    const runtime = (input: Record<string, unknown>, idempotencyKey: string) =>
      f.app.inject({
        method: "POST",
        url: "/api/marketplace/v1/runtime/composio/execute",
        headers: { authorization: "Bearer portal-lease" },
        payload: { schema: 1, consentId: consent.consentId, selection: { ...selection, capability: "connector.dispatch" }, input, idempotencyKey },
      });
    const toolCalls = () => f.server.requests.filter((request) => request.rpcMethod === "tools/call").length;

    const executed = await runtime({ title: "Bug" }, "mcp-op-1");
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      ok: true,
      result: {
        actionType: actionKey,
        capability: "connector.dispatch",
        details: { toolName: "create_issue", result: { structuredContent: { tool: "create_issue", arguments: { title: "Bug" } } } },
      },
    });
    expect(f.verifierCalls.at(-1)?.requiredCapability).toBe("connector.dispatch");
    expect(toolCalls()).toBe(1);
    expect(executed.body).not.toContain(SECRET);

    for (const [input, key] of [[{ title: "x", labels: ["y"] }, "mcp-op-2"], [{ title: "x", user_id: "someone" }, "mcp-op-3"]] as const) {
      const denied = await runtime(input, key);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: "provider_argument_invalid" });
    }
    expect(toolCalls()).toBe(1);

    // Agent execute path with a scoped direct grant goes through the same MCP executor.
    const agentHeaders = { ...SERVICE, "x-tealbrick-agent-token": "agent-1", "x-tealbrick-attachment": "attachment-1" };
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: agentHeaders,
      payload: { workspaceSlug: "ws-a", pluginId: f.pluginId, actionKey, accountId: "connector", resourceKind: selection.resourceKind, resourceRef: "account:connector" },
    });
    expect(grant.statusCode).toBe(201);
    const execute = (action: Record<string, unknown>) =>
      f.app.inject({
        method: "POST",
        url: `/api/marketplace/plugins/${f.pluginId}/execute`,
        headers: agentHeaders,
        payload: { workspaceSlug: "ws-a", capability: "connector.dispatch", agentGrantId: grant.json().grant.id, action: { type: actionKey, ...action } },
      });
    expect((await execute({ title: "Scoped" })).statusCode).toBe(200);
    expect(toolCalls()).toBe(2);
    const override = await execute({ title: "x", connected_account_id: "other" });
    expect(override.statusCode).toBe(403);
    expect(override.json()).toMatchObject({ error: "provider_argument_invalid" });

    // Changing the server address disconnects the connector until a refresh.
    const patched = await f.app.inject({
      method: "PATCH",
      url: `/api/marketplace/connectors/custom/${f.pluginId}`,
      headers: f.a,
      payload: { url: `${f.server.origin}/mcp/v2` },
    });
    expect(patched.statusCode).toBe(200);
    expect((await f.catalog(f.a)).json().actions.filter((entry: { pluginId: string }) => entry.pluginId === f.pluginId)).toEqual([]);
    const disconnected = await runtime({ title: "Bug" }, "mcp-op-4");
    expect(disconnected.statusCode).toBe(409);
    expect(disconnected.json()).toMatchObject({ error: "runtime_connection_unavailable" });
    const rejectedRequest = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection, idempotencyKey: "mcp-request-2" },
    });
    expect(rejectedRequest.statusCode).toBe(404);
    expect(rejectedRequest.json()).toMatchObject({ error: "agent_action_not_published" });

    const deleted = await f.app.inject({ method: "DELETE", url: `/api/marketplace/connectors/custom/${f.pluginId}`, headers: f.a });
    expect(deleted.statusCode).toBe(200);
    const afterDelete = await runtime({ title: "Bug" }, "mcp-op-5");
    expect(afterDelete.statusCode).toBe(403);
    expect(afterDelete.json()).toMatchObject({ error: "runtime_consent_revoked" });
    expect((await f.catalog(f.a)).json().actions).toEqual([]);
    expect(toolCalls()).toBe(2);
  });
});

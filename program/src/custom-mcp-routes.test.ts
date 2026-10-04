import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { capabilityForTool, customMcpPluginId, deriveActionKeys } from "./custom-mcp.js";
import { MarketplaceOperatorSessionManager, MARKETPLACE_OPERATOR_SESSION_COOKIE } from "./operator-auth.js";
import { MarketplaceProviderSettingsStore } from "./provider-settings.js";
import { MARKETPLACE_TABLES, SqliteMarketplaceStore } from "./store.js";
import { startFakeMcpServer } from "./testing/fake-mcp-server.js";
import type { RulesDecision } from "./types.js";

const ORIGIN = "http://127.0.0.1:5314";
const SERVICE = "marketplace-service-token-1234";
const SECRET = "sk-fixture-secret-value-0001";
const SECRET_V2 = "sk-fixture-secret-value-0002";
const KEY = "a".repeat(64);
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Rules = { decision: RulesDecision | "unavailable"; calls: Array<Record<string, unknown>> };

async function fixture(input: { encryptionKey?: string | null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-custom-mcp-"));
  roots.push(root);
  const dbPath = path.join(root, "data", "marketplace.sqlite");
  const store = new SqliteMarketplaceStore(dbPath, {
    handoffEncryptionKey: input.encryptionKey === null ? undefined : (input.encryptionKey ?? KEY),
    logPath: path.join(root, "logs", "marketplace-debug.jsonl"),
  });
  const server = await startFakeMcpServer({ requiredHeader: { name: "x-api-key", value: SECRET } });
  const rules: Rules = { decision: { effect: "allow", decisionId: "decision-allow" }, calls: [] };
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234" });
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: "ws-a",
    operatorSessionManager: sessions,
    providerSettings: new MarketplaceProviderSettingsStore(path.join(root, "ps.json"), path.join(root, "pss.json"), {}),
    env: {},
    environment: { NODE_ENV: "test", MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin },
    rulesClient: async (request) => {
      rules.calls.push(request as unknown as Record<string, unknown>);
      if (rules.decision === "unavailable") throw new Error("unreachable in tests");
      return rules.decision;
    },
  });
  const operator = (organizationId: string, id = `operator-${organizationId}`) => {
    const { token, status } = sessions.issuePortalSession({ id, organizationId });
    return {
      cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      origin: ORIGIN,
      "x-csrf-token": status.csrfToken!,
    };
  };
  const bodies: string[] = [];
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) => {
    const response = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
    bodies.push(response.body);
    return response;
  };
  closers.push(async () => {
    await app.close();
    store.close();
    await server.close();
  });
  return { app, store, server, rules, operator, call, bodies, dbPath, root, sessions };
}

function createBody(url: string, extra: Record<string, unknown> = {}) {
  return {
    displayName: "Issue Tracker",
    url,
    transport: "streamable-http",
    headers: { "X-Team": "blue" },
    secretHeaders: { "X-Api-Key": SECRET },
    ...extra,
  };
}

function dumpDatabase(dbPath: string) {
  const database = new DatabaseSync(dbPath);
  try {
    return MARKETPLACE_TABLES.map((table) => JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all())).join("\n");
  } finally {
    database.close();
  }
}

describe("custom MCP derivation rules", () => {
  it("derives stable, valid, collision-free action keys", () => {
    expect(customMcpPluginId({ workspaceSlug: "ws-a", displayName: "Issue Tracker!" })).toMatch(/^mcp-issue-tracker-[0-9a-f]{8}$/u);
    expect(customMcpPluginId({ workspaceSlug: "ws-a", displayName: "9 Lives" })).toMatch(/^mcp-c-9-lives-[0-9a-f]{8}$/u);
    expect(customMcpPluginId({ workspaceSlug: "ws-a", displayName: "x" })).not.toBe(customMcpPluginId({ workspaceSlug: "ws-b", displayName: "x" }));
    const provider = "mcp-demo-12345678";
    expect(deriveActionKeys(provider, ["Create_Issue", "create-issue", "1password", "!!!", "a".repeat(300)])).toEqual([
      `${provider}.create-issue`,
      `${provider}.create-issue-2`,
      `${provider}.tool-1password`,
      `${provider}.tool`,
      `${provider}.${"a".repeat(128 - provider.length - 1 - 4)}`,
    ]);
  });

  it("maps annotations to capabilities, falling back to the action name", () => {
    expect(capabilityForTool({ annotations: { readOnlyHint: true, destructiveHint: true } }, "x")).toBe("connector.observe");
    expect(capabilityForTool({ annotations: { destructiveHint: true } }, "x")).toBe("connector.admin");
    expect(capabilityForTool({ annotations: { readOnlyHint: false } }, "list-things")).toBe("connector.dispatch");
    expect(capabilityForTool({}, "create-issue")).toBe("connector.dispatch");
    expect(capabilityForTool({}, "list-issues")).toBe("connector.observe");
  });
});

describe("custom MCP connector routes", () => {
  it("is operator-only and refuses stdio, unsafe URLs, and invalid headers", async () => {
    const { app, operator, call, store } = await fixture();
    const a = operator("ws-a");
    expect((await app.inject({ method: "GET", url: "/api/marketplace/connectors/custom" })).statusCode).toBe(401);
    const service = { authorization: `Bearer ${SERVICE}` };
    expect((await call("GET", "/api/marketplace/connectors/custom", service)).json()).toEqual({ ok: false, error: "marketplace_operator_required" });
    const serviceCreate = await call("POST", "/api/marketplace/connectors/custom", service, createBody("https://mcp.example.com/mcp"));
    expect(serviceCreate.statusCode).toBe(403);

    for (const body of [
      { displayName: "Local", transport: "stdio", command: "npx" },
      createBody("https://mcp.example.com/mcp", { command: "/bin/sh" }),
      createBody("https://mcp.example.com/mcp", { env: { TOKEN: "x" } }),
      createBody("https://mcp.example.com/mcp", { args: ["-y"] }),
      createBody("https://mcp.example.com/mcp", { cwd: "/" }),
    ]) {
      const refused = await call("POST", "/api/marketplace/connectors/custom", a, body);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ ok: false, error: "custom_mcp_transport_not_allowed" });
    }
    for (const [url, reason] of [
      ["http://mcp.example.com/mcp", "scheme_not_https"],
      ["https://169.254.169.254/latest", "address_not_allowed"],
      ["https://localhost/mcp", "hostname_not_allowed"],
      ["https://user:pw@mcp.example.com/", "userinfo_not_allowed"],
    ]) {
      const refused = await call("POST", "/api/marketplace/connectors/custom", a, createBody(url!));
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ ok: false, error: "custom_mcp_url_not_allowed", reason });
    }
    expect((await call("POST", "/api/marketplace/connectors/custom", a, createBody("https://mcp.example.com/mcp", { headers: { Host: "evil" } }))).json()).toMatchObject({ error: "custom_mcp_header_invalid" });
    expect((await call("POST", "/api/marketplace/connectors/custom", a, createBody("https://mcp.example.com/mcp", { headers: { "x-api-key": "plain" } }))).json()).toMatchObject({ error: "custom_mcp_header_conflict" });
    expect((await call("POST", "/api/marketplace/connectors/custom", a, createBody("https://mcp.example.com/mcp", { secretHeaders: { "bad header": "x" } }))).json()).toMatchObject({ error: "custom_mcp_header_invalid" });
    expect((await call("POST", "/api/marketplace/connectors/custom", { ...a, "x-csrf-token": "wrong" }, createBody("https://mcp.example.com/mcp"))).statusCode).toBe(403);
    expect(store.listOwnedListings("ws-a")).toEqual([]);
  });

  it("creates, refreshes, installs, executes, edits, and deletes without leaking secrets", async () => {
    const { app, store, server, rules, operator, call, bodies, dbPath, root } = await fixture();
    const a = operator("ws-a");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const created = await call("POST", "/api/marketplace/connectors/custom", a, createBody(`${server.streamableUrl}?tenant=t1`));
    expect(created.statusCode).toBe(201);
    const connector = created.json().connector;
    const pluginId = connector.pluginId as string;
    expect(pluginId).toMatch(/^mcp-issue-tracker-[0-9a-f]{8}$/u);
    expect(connector).toMatchObject({
      displayName: "Issue Tracker",
      transport: "streamable-http",
      url: server.streamableUrl,
      headers: [{ name: "x-team", value: "blue" }],
      secretHeaders: [{ name: "x-api-key", configured: true, fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/u) }],
      tools: [],
      lastRefresh: null,
      install: { installed: false },
      connection: null,
    });
    expect(rules.calls.at(-1)).toMatchObject({ operation: "custom-mcp.create", capability: "connector.admin", actorId: "operator-ws-a", workspaceSlug: "ws-a" });
    expect(store.getListing(pluginId)?.ownerWorkspaceSlug).toBe("ws-a");

    const duplicate = await call("POST", "/api/marketplace/connectors/custom", a, createBody(server.streamableUrl));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: "custom_mcp_already_exists" });

    const refreshed = await call("POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`, a);
    expect(refreshed.statusCode).toBe(200);
    const tools = refreshed.json().connector.tools as Array<{ name: string; action: string; capability: string }>;
    expect(tools.map((tool) => [tool.name, tool.action, tool.capability])).toEqual([
      ["echo", `${pluginId}.echo`, "connector.observe"],
      ["create_issue", `${pluginId}.create-issue`, "connector.dispatch"],
      ["Delete Everything!", `${pluginId}.delete-everything`, "connector.admin"],
      ["fail_tool", `${pluginId}.fail-tool`, "connector.dispatch"],
    ]);
    expect(refreshed.json().connector).toMatchObject({ lastRefresh: { ok: true, errorCode: null }, connection: { state: "connected" } });
    expect(server.requests.find((request) => request.rpcMethod === "tools/list")?.headers).toMatchObject({ "x-api-key": SECRET, "x-team": "blue" });
    expect(store.getListing(pluginId)?.actions).toHaveLength(4);

    const summaryBefore = (await call("GET", "/api/marketplace/cards/summary?search=Issue", a)).json();
    expect(summaryBefore.items.find((item: { pluginId: string }) => item.pluginId === pluginId)).toMatchObject({ status: "available", source: "mcp" });

    const installed = await call("POST", `/api/marketplace/plugins/${pluginId}/install`, a, {});
    expect(installed.statusCode).toBe(201);
    const capabilities = (await call("GET", "/api/agent/capabilities", a)).json().capabilities as Array<{ pluginId: string; toolName: string; requiredCapabilities: string[] }>;
    const mine = capabilities.filter((capability) => capability.pluginId === pluginId);
    expect(mine.map((capability) => capability.toolName)).toEqual(expect.arrayContaining([`marketplace.${pluginId}.echo`, `marketplace.${pluginId}.delete-everything`]));
    expect(mine).toHaveLength(4);
    const card = (await call("GET", `/api/marketplace/cards/${pluginId}`, a)).json().card;
    expect(card.state).toMatchObject({ status: "ready", ready: true });

    const executed = await call("POST", `/api/marketplace/plugins/${pluginId}/execute`, a, {
      capability: "connector.observe",
      action: { type: `${pluginId}.echo`, message: "hello" },
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      ok: true,
      result: { simulated: false, details: { toolName: "echo", result: { structuredContent: { tool: "echo", arguments: { message: "hello" } } } } },
      usage: { status: "succeeded", sourceExecutor: "mcp", provider: pluginId },
    });
    expect(rules.calls.at(-1)).toMatchObject({ operation: "execute", capability: "connector.observe", pluginId });

    const viaAgentTool = await call("POST", `/api/agent/tools/marketplace.${pluginId}.create-issue`, a, { pluginId, input: { title: "Bug" } });
    expect(viaAgentTool.statusCode).toBe(200);
    expect(viaAgentTool.json().result.details.result.structuredContent).toEqual({ tool: "create_issue", arguments: { title: "Bug" } });

    const toolFailure = await call("POST", `/api/marketplace/plugins/${pluginId}/execute`, a, {
      capability: "connector.dispatch",
      action: { type: `${pluginId}.fail-tool` },
    });
    expect(toolFailure.statusCode).toBe(502);
    expect(toolFailure.json()).toMatchObject({ ok: false, error: "mcp_tool_failed", usage: { status: "failed", error: "mcp_tool_failed" } });
    expect(toolFailure.body).not.toContain("upstream exploded");

    const wrongCapability = await call("POST", `/api/marketplace/plugins/${pluginId}/execute`, a, { capability: "connector.dispatch", action: { type: `${pluginId}.echo` } });
    expect(wrongCapability.json()).toMatchObject({ error: "connector_capability_mismatch", requiredCapability: "connector.observe" });

    const usage = store.listUsage({ workspaceSlug: "ws-a", provider: pluginId });
    expect(usage.map((entry) => entry.status).sort()).toEqual(["failed", "succeeded", "succeeded"]);

    // Replace the secret with a wrong value: refresh reports auth rejection.
    const firstFingerprint = connector.secretHeaders[0].fingerprint;
    const replaced = await call("PATCH", `/api/marketplace/connectors/custom/${pluginId}`, a, { secretHeaders: { "x-api-key": SECRET_V2 } });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().connector.secretHeaders[0].fingerprint).not.toBe(firstFingerprint);
    expect(replaced.json().connector.connection.state).toBe("connected");
    const rejected = await call("POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`, a);
    expect(rejected.statusCode).toBe(502);
    expect(rejected.json()).toMatchObject({ ok: false, error: "mcp_auth_rejected", connector: { lastRefresh: { ok: false, errorCode: "mcp_auth_rejected" }, connection: { state: "blocked" } } });
    const blockedExecute = await call("POST", `/api/marketplace/plugins/${pluginId}/execute`, a, { capability: "connector.observe", action: { type: `${pluginId}.echo` } });
    expect(blockedExecute.statusCode).toBe(409);
    expect(blockedExecute.json()).toMatchObject({ error: "connector_not_connected" });
    expect((await call("GET", "/api/agent/capabilities", a)).json().capabilities.filter((entry: { pluginId: string }) => entry.pluginId === pluginId)).toEqual([]);

    // Restore the secret, then remove it again.
    await call("PATCH", `/api/marketplace/connectors/custom/${pluginId}`, a, { secretHeaders: { "x-api-key": SECRET } });
    expect((await call("POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`, a)).statusCode).toBe(200);
    const removed = await call("PATCH", `/api/marketplace/connectors/custom/${pluginId}`, a, { secretHeaders: { "x-api-key": null } });
    expect(removed.json().connector.secretHeaders).toEqual([]);
    expect(store.listCredentialRefs({ workspaceSlug: "ws-a", pluginId })).toEqual([]);
    await call("PATCH", `/api/marketplace/connectors/custom/${pluginId}`, a, { secretHeaders: { "x-api-key": SECRET } });

    // Changing the server address disconnects and clears tools.
    const moved = await call("PATCH", `/api/marketplace/connectors/custom/${pluginId}`, a, { url: server.sseUrl, transport: "sse", displayName: "Issue Tracker (SSE)" });
    expect(moved.json().connector).toMatchObject({ displayName: "Issue Tracker (SSE)", transport: "sse", tools: [], lastRefresh: null, connection: { state: "disconnected" } });
    expect(store.getListing(pluginId)?.actions).toEqual([]);
    const sseRefresh = await call("POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`, a);
    expect(sseRefresh.statusCode).toBe(200);
    expect(sseRefresh.json().connector.tools).toHaveLength(4);
    const sseExecute = await call("POST", `/api/marketplace/plugins/${pluginId}/execute`, a, { capability: "connector.observe", action: { type: `${pluginId}.echo`, n: 2 } });
    expect(sseExecute.json()).toMatchObject({ ok: true, result: { details: { result: { structuredContent: { arguments: { n: 2 } } } } } });

    // Secret values never appear in responses, the database, audit/events, usage, logs, or Rules payloads.
    const audit = store.listAudit({ workspaceSlug: "ws-a", pluginId }) as Array<{ event_type: string; actor_id: string; metadata: string }>;
    expect(audit.map((entry) => entry.event_type)).toEqual(expect.arrayContaining([
      "marketplace.custom_mcp.created",
      "marketplace.custom_mcp.refreshed",
      "marketplace.custom_mcp.updated",
      "marketplace.execution.completed",
    ]));
    expect(audit.find((entry) => entry.event_type === "marketplace.custom_mcp.created")).toMatchObject({ actor_id: "operator-ws-a" });
    expect(audit.find((entry) => entry.event_type === "marketplace.custom_mcp.created")!.metadata).toContain(firstFingerprint);
    const everything = [
      bodies.join("\n"),
      dumpDatabase(dbPath),
      JSON.stringify(rules.calls),
      JSON.stringify(logged.mock.calls),
      JSON.stringify(store.getListing(pluginId)),
    ].join("\n");
    for (const secret of [SECRET, SECRET_V2]) expect(everything).not.toContain(secret);
    expect((await readFile(dbPath)).toString("utf8")).not.toContain(SECRET);
    expect(root).toBeTruthy();

    // Delete revokes grants and removes every workspace record.
    store.createAgentConnectorGrant({
      workspaceSlug: "ws-a", agentId: "agent-1", pluginId, actionKey: `${pluginId}.echo`, capability: "connector.observe",
      connectionId: "c", accountId: "acct", resourceKind: "r", resourceRef: "x", attachmentId: "att", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.createBrokerGrant({ workspaceSlug: "ws-a", requesterMiniappId: "m", pluginId, actionKeys: [`${pluginId}.echo`], capabilities: ["connector.observe"], tokenHash: "h", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const deleted = await call("DELETE", `/api/marketplace/connectors/custom/${pluginId}`, a);
    expect(deleted.json()).toEqual({ ok: true, pluginId, deleted: true });
    expect(store.getListing(pluginId)).toBeNull();
    expect(store.getInstall("ws-a", pluginId)).toBeNull();
    expect(store.getConnection("ws-a", pluginId)).toBeNull();
    expect(store.listConnectorSecrets({ workspaceSlug: "ws-a", pluginId })).toEqual([]);
    expect(store.listCredentialRefs({ workspaceSlug: "ws-a", pluginId })).toEqual([]);
    expect(store.listActionBindings({ workspaceSlug: "ws-a", pluginId })).toEqual([]);
    expect(store.listAgentConnectorGrants({ workspaceSlug: "ws-a", pluginId }).map((grant) => grant.state)).toEqual(["revoked"]);
    expect(store.listBrokerGrants({ workspaceSlug: "ws-a", pluginId }).map((grant) => grant.state)).toEqual(["revoked"]);
    expect((await call("GET", "/api/marketplace/connectors/custom", a)).json().items).toEqual([]);
    expect(app).toBeTruthy();
  });

  it("isolates one workspace's connector from every other workspace", async () => {
    const { store, server, operator, call } = await fixture();
    const a = operator("ws-a");
    const b = operator("ws-b");
    const pluginId = (await call("POST", "/api/marketplace/connectors/custom", a, createBody(server.streamableUrl))).json().connector.pluginId as string;
    await call("POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`, a);
    await call("POST", `/api/marketplace/plugins/${pluginId}/install`, a, {});

    expect((await call("GET", "/api/marketplace/connectors/custom", b)).json().items).toEqual([]);
    for (const [method, url, payload] of [
      ["GET", `/api/marketplace/plugins/${pluginId}`],
      ["GET", `/api/marketplace/cards/${pluginId}`],
      ["PATCH", `/api/marketplace/connectors/custom/${pluginId}`, { displayName: "Stolen" }],
      ["DELETE", `/api/marketplace/connectors/custom/${pluginId}`],
      ["POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`],
      ["POST", `/api/marketplace/plugins/${pluginId}/install`, {}],
      ["POST", `/api/marketplace/plugins/${pluginId}/register`, {}],
      ["POST", `/api/marketplace/plugins/${pluginId}/connection`, { provider: pluginId, backend: "native" }],
      ["POST", `/api/marketplace/plugins/${pluginId}/action-binding`, { actionKey: `${pluginId}.echo` }],
      ["POST", `/api/marketplace/plugins/${pluginId}/capability-binding`, { capability: "connector.observe" }],
      ["POST", `/api/marketplace/plugins/${pluginId}/execute`, { capability: "connector.observe", action: { type: `${pluginId}.echo` } }],
      ["POST", `/api/agent/tools/marketplace.${pluginId}.echo`, { pluginId, input: {} }],
    ] as const) {
      const response = await call(method, url, b, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    for (const url of ["/api/marketplace/catalog", "/api/marketplace/plugins", "/api/marketplace/cards", "/api/marketplace/cards/summary?limit=100&source=mcp", "/api/agent/capabilities"]) {
      expect((await call("GET", url, b)).body, url).not.toContain(pluginId);
    }
    expect((await call("GET", "/api/marketplace/cards/summary?limit=100&source=mcp", a)).body).toContain(pluginId);
    // A forged workspaceSlug in the query cannot cross the session boundary.
    expect((await call("GET", "/api/marketplace/connectors/custom?workspaceSlug=ws-a", b)).statusCode).toBe(200);
    expect((await call("GET", "/api/marketplace/connectors/custom?workspaceSlug=ws-a", b)).json().items).toEqual([]);
    expect(store.getListing(pluginId)?.displayName).toBe("Issue Tracker");
  });

  it("keeps Hub records consistent and refuses Hub edits of operator connectors", async () => {
    const { server, operator, call } = await fixture();
    const a = operator("ws-a");
    const pluginId = (await call("POST", "/api/marketplace/connectors/custom", a, createBody(server.streamableUrl))).json().connector.pluginId as string;
    const service = { authorization: `Bearer ${SERVICE}` };
    const records = await call("GET", "/api/marketplace/hub/records", service);
    expect(records.statusCode).toBe(200);
    const record = records.json().pluginRecords.find((entry: { pluginId: string }) => entry.pluginId === pluginId);
    expect(record).toMatchObject({ custom: false, adapter: { type: "mcp", mcp: { transport: "streamable-http", url: server.streamableUrl } } });
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect((await call("PATCH", `/api/marketplace/hub/plugins/${pluginId}`, service, { url: "https://evil.example/mcp" })).json()).toEqual({ ok: false, error: "plugin_managed_by_operator" });
    expect((await call("DELETE", `/api/marketplace/hub/plugins/${pluginId}`, service)).json()).toEqual({ ok: false, error: "plugin_managed_by_operator" });
  });

  it("blocks mutations and execution when Rules deny, need review, or are unavailable", async () => {
    const { server, rules, operator, call, store } = await fixture();
    const a = operator("ws-a");
    const pluginId = (await call("POST", "/api/marketplace/connectors/custom", a, createBody(server.streamableUrl))).json().connector.pluginId as string;
    await call("POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`, a);
    await call("POST", `/api/marketplace/plugins/${pluginId}/install`, a, {});
    const before = server.requests.filter((request) => request.rpcMethod === "tools/call").length;

    for (const [decision, status, error] of [
      [{ effect: "deny", decisionId: "d" }, 403, "rules_denied"],
      [{ effect: "review", decisionId: "r" }, 409, "rules_review_required"],
    ] as const) {
      rules.decision = decision;
      expect((await call("POST", "/api/marketplace/connectors/custom", a, createBody(server.streamableUrl, { displayName: "Other" }))).json()).toMatchObject({ error });
      for (const [method, url, payload] of [
        ["PATCH", `/api/marketplace/connectors/custom/${pluginId}`, { displayName: "Renamed" }],
        ["DELETE", `/api/marketplace/connectors/custom/${pluginId}`],
        ["POST", `/api/marketplace/connectors/custom/${pluginId}/refresh`],
        ["POST", `/api/marketplace/plugins/${pluginId}/execute`, { capability: "connector.observe", action: { type: `${pluginId}.echo` } }],
      ] as const) {
        const response = await call(method, url, a, payload);
        expect(response.statusCode, `${method} ${url}`).toBe(status);
        expect(response.json()).toMatchObject({ error });
      }
    }
    expect(store.getListing(pluginId)?.displayName).toBe("Issue Tracker");
    expect(store.listOwnedListings("ws-a")).toHaveLength(1);
    expect(server.requests.filter((request) => request.rpcMethod === "tools/call")).toHaveLength(before);
  });

  it("returns rules_unavailable without a Rules client and fails closed on secrets without a key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-custom-mcp-norules-"));
    roots.push(root);
    const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
    const sessions = new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234" });
    const app = await buildMarketplaceApp({
      store,
      operatorSessionManager: sessions,
      providerSettings: new MarketplaceProviderSettingsStore(path.join(root, "ps.json"), path.join(root, "pss.json"), {}),
      env: {},
      environment: { NODE_ENV: "test" },
    });
    closers.push(async () => { await app.close(); store.close(); });
    const { token, status } = sessions.issuePortalSession({ id: "op", organizationId: "ws-a" });
    const headers = { cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${token}`, origin: ORIGIN, "x-csrf-token": status.csrfToken! };
    const unavailable = await app.inject({ method: "POST", url: "/api/marketplace/connectors/custom", headers, payload: { displayName: "X", url: "https://mcp.example.com/mcp" } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ error: "rules_unavailable" });

    const { operator, call, store: keyless } = await fixture({ encryptionKey: null });
    const a = operator("ws-a");
    const withSecret = await call("POST", "/api/marketplace/connectors/custom", a, createBody("https://mcp.example.com/mcp"));
    expect(withSecret.statusCode).toBe(503);
    expect(withSecret.json()).toEqual({ ok: false, error: "connector_secret_store_unavailable" });
    expect(keyless.listOwnedListings("ws-a")).toEqual([]);
    const listed = await call("GET", "/api/marketplace/connectors/custom", a);
    expect(listed.json()).toMatchObject({ secretStoreAvailable: false });
    const plain = await call("POST", "/api/marketplace/connectors/custom", a, createBody("https://mcp.example.com/mcp", { secretHeaders: undefined }));
    expect(plain.statusCode).toBe(201);
  });
});

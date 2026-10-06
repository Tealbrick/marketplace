import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { SqliteMarketplaceStore } from "./store.js";
import { FAKE_MCP_TOOLS, startFakeMcpServer, type FakeMcpTool } from "./testing/fake-mcp-server.js";
import { startFakeRestServer, type FakeRestRequest } from "./testing/fake-rest-server.js";
import type { RulesClient } from "./types.js";

const ORIGIN = "http://127.0.0.1:5314";
const SERVICE_TOKEN = "marketplace-service-token-1234";
const SERVICE = { authorization: `Bearer ${SERVICE_TOKEN}` };
const AGENT = { ...SERVICE, "x-tealbrick-agent-token": "agent-1", "x-tealbrick-attachment": "attachment-1" };
const SECRET = "cb-fixture-secret-value-0001";
const FIXTURES = path.join(import.meta.dirname, "testing", "company-box");

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Fixture catalog copy with optional entry.json patches. */
function catalog(patches: Record<string, (entry: Record<string, unknown>) => void> = {}) {
  const root = tempDir("company-box-routes-");
  cpSync(FIXTURES, root, { recursive: true });
  for (const [id, patch] of Object.entries(patches)) {
    const file = path.join(root, id, "entry.json");
    const entry = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    patch(entry);
    writeFileSync(file, JSON.stringify(entry));
  }
  return root;
}

function authorized(request: FakeRestRequest) {
  const basic = `Basic ${Buffer.from(`ops:${SECRET}`).toString("base64")}`;
  return (
    request.headers.authorization === `Bearer ${SECRET}` ||
    request.headers.authorization === basic ||
    request.query.api_key?.[0] === SECRET
  );
}

async function fixture(options: { catalogDir?: string; rulesClient?: RulesClient; storeRoot?: string; mcpTools?: FakeMcpTool[] } = {}) {
  const root = options.storeRoot ?? tempDir("company-box-app-");
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), {
    handoffEncryptionKey: "a".repeat(64),
  });
  const rest = await startFakeRestServer({ authorize: authorized });
  const mcp = await startFakeMcpServer({ requiredHeader: { name: "x-api-key", value: SECRET }, ...(options.mcpTools ? { tools: options.mcpTools } : {}) });
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234" });
  const rulesCalls: Array<Parameters<RulesClient>[0]> = [];
  const portalGrants = new Map<string, Record<string, unknown>>();
  let portalSequence = 0;
  let leaseConsent = "";
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE_TOKEN,
    organizationId: "ws-a",
    operatorSessionManager: sessions,
    env: {},
    environment: { NODE_ENV: "test", MARKETPLACE_MCP_ALLOWED_ORIGINS: `${rest.origin},${mcp.origin}` },
    mcpFetch: (resource, init) => fetch(resource, init),
    companyBoxCatalogDir: options.catalogDir ?? FIXTURES,
    portalIssuerUrl: "https://portal.test",
    portalInstanceProof: "p".repeat(43),
    portalFetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (pathname === "/api/deployment-browser/grant-request") {
        const requestId = `${"r".repeat(42)}${portalSequence++ % 10}`;
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
    portalRuntimeScopeVerifier: async (input) => ({
      portalOrgId: "portal-org",
      productTenantId: "ws-a",
      workspaceId: "ws-a",
      deploymentId: "deployment-1",
      agentId: "agent-1",
      consentId: leaseConsent,
      leaseId: "lease-1",
      capabilities: [input.requiredCapability],
      expiresAt: Date.now() + 300_000,
    }),
    agentScopeVerifier: async ({ requiredCapability, agentToken }) => ({
      organizationId: "ws-a",
      // The fake Portal identifies the agent by its token.
      agentId: agentToken,
      attachmentId: "attachment-1",
      capabilities: [requiredCapability],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }),
    ...(options.rulesClient
      ? {
          rulesClient: async (input) => {
            rulesCalls.push(input);
            return options.rulesClient!(input);
          },
        }
      : {}),
  });
  closers.push(async () => {
    await app.close();
    store.close();
    await rest.close();
    await mcp.close();
  });
  const { token, status } = sessions.issuePortalSession({ id: "operator-ws-a", organizationId: "ws-a" });
  const operator = {
    cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    origin: ORIGIN,
    "x-csrf-token": status.csrfToken!,
  };
  const inject = (method: "GET" | "POST" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const setup = (entryId: string, payload: Record<string, unknown>) =>
    inject("POST", `/api/marketplace/company-box/${entryId}/setup`, operator, payload);
  const grant = async (pluginId: string, actionKey: string) => {
    const response = await inject("POST", "/api/marketplace/agent/grants", AGENT, {
      workspaceSlug: "ws-a",
      pluginId,
      actionKey,
      accountId: "connector",
      resourceKind: `${pluginId}.connected-account`,
      resourceRef: "account:connector",
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().grant.id as string;
  };
  const tool = (toolName: string, pluginId: string, input: Record<string, unknown>, grantId?: string) =>
    inject("POST", `/api/agent/tools/${toolName}`, AGENT, {
      workspaceSlug: "ws-a",
      pluginId,
      input,
      ...(grantId ? { grantId } : {}),
    });
  /** Everything a browser, agent or log reader could see about the workspace. */
  const everything = async () => {
    const bodies = await Promise.all(
      [
        ["GET", "/api/marketplace/company-box", operator],
        ["GET", "/api/marketplace/audit?workspaceSlug=ws-a&limit=500", operator],
        ["GET", "/api/marketplace/plugins?workspaceSlug=ws-a", operator],
        ["GET", "/api/marketplace/catalog?workspaceSlug=ws-a", operator],
        ["GET", "/api/marketplace/cards/summary?workspaceSlug=ws-a", operator],
        ["GET", "/api/marketplace/v1/agent/action-catalog?workspaceSlug=ws-a", SERVICE],
        ["GET", "/api/agent/capabilities?workspaceSlug=ws-a", SERVICE],
        ["GET", "/api/marketplace/connectors/custom", operator],
        ["GET", "/events?workspaceSlug=ws-a", SERVICE],
      ].map(async ([method, url, headers]) => (await inject(method as "GET", url as string, headers as Record<string, string>)).body),
    );
    return [...bodies, JSON.stringify(errors.mock.calls)].join("\n");
  };
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
  /** Portal consent for one operation, then a runtime executor bound to it. */
  const consent = async (pluginId: string, actionKey: string, capability: string) => {
    const selection = {
      pluginId,
      actionKey,
      accountId: "connector",
      resourceKind: `${pluginId}.connected-account`,
      resourceRef: "account:connector",
    };
    const requested = await inject("POST", "/api/marketplace/v1/agent/grants/request", SERVICE, {
      deploymentId: "deployment-1",
      agentId: "agent-1",
      selection,
      idempotencyKey: `request-${actionKey.replace(/[^A-Za-z0-9-]/gu, "-")}`,
    });
    expect(requested.statusCode, requested.body).toBe(200);
    const redeemed = await inject("POST", "/api/marketplace/v1/agent/grants/redeem", SERVICE, {
      deploymentId: "deployment-1",
      requestId: requested.json().request.requestId,
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const consentId = redeemed.json().consent.consentId as string;
    return (input: Record<string, unknown>, idempotencyKey: string) => {
      leaseConsent = consentId;
      return inject("POST", "/api/marketplace/v1/runtime/composio/execute", { authorization: "Bearer portal-lease" }, {
        schema: 1,
        consentId,
        selection: { ...selection, capability },
        input,
        idempotencyKey,
      });
    };
  };
  return { app, store, rest, mcp, operator, inject, setup, grant, tool, consent, everything, rulesCalls, errors };
}

describe("Company Box collection", () => {
  it("lists entries with coverage, auth fields and no install state yet", async () => {
    const f = await fixture();
    const response = await f.inject("GET", "/api/marketplace/company-box", f.operator);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.collection).toMatchObject({ id: "company-box", label: "Company Box" });
    expect(body.entries.map((entry: Record<string, unknown>) => [entry.id, entry.source, entry.coverage, entry.exposure, entry.installed])).toEqual([
      ["bigapp", "openapi", { unit: "operations", total: 152, exposed: 152, excluded: 0 }, "discovery", false],
      ["notes", "openapi", { unit: "operations", total: 11, exposed: 10, excluded: 1 }, "direct", false],
      ["tracker", "mcp", { unit: "tools", total: 4, exposed: 3, excluded: 1 }, "direct", false],
    ]);
    expect(body.entries[1]).toMatchObject({
      auth: { type: "header", fields: [{ key: "token", label: "API token", secret: true }] },
      healthOperation: "getHealth",
      outward: 1,
      destructive: 1,
      credentials: [{ key: "token", configured: false }],
    });
    const service = await f.inject("GET", "/api/marketplace/company-box", SERVICE);
    expect(service.statusCode).toBe(403);
  });

  it("sets up each auth scheme, keeps secrets out of every surface, and enforces the URL policy", async () => {
    const root = catalog({ notes: (entry) => (entry.auth = { type: "basic" }) });
    const f = await fixture({ catalogDir: root });
    // basic (notes variant)
    const basic = await f.setup("notes", { baseUrl: `${f.rest.origin}/`, credentials: { username: "ops", password: SECRET } });
    expect(basic.statusCode, basic.body).toBe(200);
    expect(basic.json().entry).toMatchObject({
      installed: true,
      connection: { state: "connected", detail: "Connected. 10 operations available.", baseUrl: `${f.rest.origin}/` },
      credentials: [
        { key: "username", configured: true, fingerprint: expect.any(String) },
        { key: "password", configured: true, fingerprint: expect.any(String) },
      ],
    });
    expect(f.rest.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/health" });
    // query (bigapp)
    const query = await f.setup("bigapp", { baseUrl: f.rest.origin, credentials: { apiKey: SECRET } });
    expect(query.statusCode, query.body).toBe(200);
    expect(f.rest.requests.at(-1)).toMatchObject({ path: "/api/ping", query: { api_key: [SECRET] } });
    // header (tracker uses the custom MCP path)
    const header = await f.setup("tracker", { baseUrl: f.mcp.origin, credentials: { token: SECRET } });
    expect(header.statusCode, header.body).toBe(200);

    // Wrong credentials: blocked connection, safe error, still no secret.
    const wrong = await f.setup("bigapp", { baseUrl: f.rest.origin, credentials: { apiKey: "wrong-key-value" } });
    expect(wrong.statusCode).toBe(502);
    expect(wrong.json()).toMatchObject({ ok: false, error: "openapi_auth_rejected", entry: { connection: { state: "blocked" } } });

    const surfaces = await f.everything();
    expect(surfaces).not.toContain(SECRET);
    expect(surfaces).not.toContain("wrong-key-value");
    expect(surfaces).not.toContain(Buffer.from(`ops:${SECRET}`).toString("base64"));
    expect(surfaces).toContain("marketplace.company_box.configured");

    for (const [baseUrl, reason] of [
      ["https://169.254.169.254", "address_not_allowed"],
      ["http://notes.example.com", "scheme_not_https"],
      ["https://notes.internal", "hostname_not_allowed"],
      ["https://notes.example.com/?token=1", "query_not_allowed"],
    ] as const) {
      const refused = await f.setup("notes", { baseUrl });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ ok: false, error: "company_box_base_url_not_allowed", reason });
    }
    const unknownField = await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } });
    expect(unknownField.json()).toEqual({ ok: false, error: "company_box_credential_unknown", field: "token" });
    const missing = await f.setup("tracker", { baseUrl: f.mcp.origin, credentials: {} });
    expect(missing.statusCode).toBe(200);
  });

  it("requires credentials on first setup and reaches tailnet addresses", async () => {
    const seen: string[] = [];
    const f = await fixture();
    const missing = await f.setup("notes", { baseUrl: f.rest.origin });
    expect(missing.json()).toEqual({ ok: false, error: "company_box_credentials_required", fields: ["token"] });
    const store = new SqliteMarketplaceStore(path.join(tempDir("company-box-tailnet-"), "m.sqlite"), {
      handoffEncryptionKey: "b".repeat(64),
    });
    const sessions = new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234" });
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: SERVICE_TOKEN,
      organizationId: "ws-a",
      operatorSessionManager: sessions,
      env: {},
      environment: { NODE_ENV: "test" },
      companyBoxCatalogDir: FIXTURES,
      mcpLookup: async () => [{ address: "100.88.1.2", family: 4 }],
      companyBoxFetch: async (input) => {
        seen.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    closers.push(async () => {
      await app.close();
      store.close();
    });
    const { token, status } = sessions.issuePortalSession({ id: "operator-ws-a", organizationId: "ws-a" });
    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/company-box/notes/setup",
      headers: { cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`, origin: ORIGIN, "x-csrf-token": status.csrfToken! },
      payload: { baseUrl: "https://notes.tail1234.ts.net", credentials: { token: SECRET } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(seen).toEqual(["https://notes.tail1234.ts.net/api/v1/health"]);
  });
});

describe("Company Box governance", () => {
  it("follows grants for reads and writes, flags destructive, and requires the owner for outward ops", async () => {
    const f = await fixture();
    expect((await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } })).statusCode).toBe(200);
    const plugin = "company-box-notes";
    const list = await f.grant(plugin, `${plugin}.list-notes`);
    const listed = await f.tool(`marketplace.${plugin}.list-notes`, plugin, { query: { user_id: "u-1" } }, list);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      ok: true,
      result: { details: { operation: { method: "GET", path: "/notes" }, response: { status: 200, body: { query: { user_id: ["u-1"] } } } } },
    });
    // A read-only grant cannot call a write.
    const escalate = await f.tool(`marketplace.${plugin}.create-note`, plugin, { body: { title: "x" } }, list);
    expect(escalate.statusCode).toBe(403);
    expect(escalate.json()).toMatchObject({ error: "agent_grant_scope_mismatch" });

    const create = await f.grant(plugin, `${plugin}.create-note`);
    const created = await f.tool(`marketplace.${plugin}.create-note`, plugin, { body: { title: "Hello" } }, create);
    expect(created.statusCode, created.body).toBe(200);
    expect(f.rest.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/notes", body: '{"title":"Hello"}' });

    const remove = await f.grant(plugin, `${plugin}.delete-note`);
    expect((await f.tool(`marketplace.${plugin}.delete-note`, plugin, { path: { id: "n1" } }, remove)).statusCode).toBe(200);
    const audit = (await f.inject("GET", "/api/marketplace/audit?workspaceSlug=ws-a&limit=500", f.operator)).json().audit as Array<{ event_type: string; metadata: string }>;
    const destructive = audit.find((event) => event.metadata.includes('"destructive":true'));
    expect(destructive?.event_type).toBe("marketplace.governance.owner_approved");
    expect(JSON.parse(destructive!.metadata)).toMatchObject({ risk: { write: true, outward: false, destructive: true }, actorKind: "agent" });

    const share = await f.grant(plugin, `${plugin}.share-note`);
    const before = f.rest.requests.length;
    const shared = await f.tool(`marketplace.${plugin}.share-note`, plugin, { path: { id: "n1" }, body: { email: "a@b.test" } }, share);
    expect(shared.statusCode).toBe(202);
    expect(shared.json()).toMatchObject({ ok: false, status: "approval_pending", approvalId: expect.any(String) });
    expect(f.rest.requests.length).toBe(before);

    // The owner running it directly is the approval.
    const owner = await f.inject("POST", `/api/marketplace/plugins/${plugin}/execute`, f.operator, {
      workspaceSlug: "ws-a",
      capability: "connector.dispatch",
      action: { type: `${plugin}.share-note`, path: { id: "n1" }, body: { email: "a@b.test" } },
    });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(f.rest.requests.at(-1)).toMatchObject({ path: "/api/v1/notes/n1/share" });

    // Arguments outside the operation's groups never reach the app.
    const smuggled = await f.tool(`marketplace.${plugin}.list-notes`, plugin, { connected_account_id: "other" }, list);
    expect(smuggled.statusCode).toBe(403);
    expect(smuggled.json()).toMatchObject({ error: "provider_argument_invalid" });
    const invalid = await f.tool(`marketplace.${plugin}.list-notes`, plugin, { query: { nope: 1 } }, list);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "openapi_argument_invalid", field: "query.nope" });
  });

  it("sends the declared risk to Rules so outward ops can wait for approval", async () => {
    const f = await fixture({
      rulesClient: async (input) =>
        (input.payload.risk as { outward?: boolean } | undefined)?.outward
          ? { effect: "review", decisionId: "rules-review" }
          : { effect: "allow", decisionId: "rules-allow" },
    });
    expect((await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } })).statusCode).toBe(200);
    const plugin = "company-box-notes";
    const share = await f.grant(plugin, `${plugin}.share-note`);
    const review = await f.tool(`marketplace.${plugin}.share-note`, plugin, { path: { id: "n1" }, body: { email: "a@b.test" } }, share);
    expect(review.statusCode).toBe(409);
    expect(review.json()).toMatchObject({ error: "rules_review_required" });
    expect(f.rulesCalls.at(-1)).toMatchObject({
      operation: "execute",
      capability: "connector.dispatch",
      payload: expect.objectContaining({ risk: { write: true, outward: true, destructive: false } }),
    });
  });
});

describe("Company Box Portal runtime path", () => {
  it("runs consented operations, pre-validates arguments, and holds outward ops for the owner", async () => {
    const f = await fixture();
    expect((await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } })).statusCode).toBe(200);
    const plugin = "company-box-notes";
    const getNote = await f.consent(plugin, `${plugin}.get-note`, "connector.observe");
    const ran = await getNote({ path: { id: "n7" } }, "runtime-op-1");
    expect(ran.statusCode, ran.body).toBe(200);
    expect(ran.json()).toMatchObject({ ok: true, result: { actionType: `${plugin}.get-note`, details: { toolName: "getNote" } } });
    expect(f.rest.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/notes/n7" });
    const before = f.rest.requests.length;
    const invalid = await getNote({ path: { id: ".." } }, "runtime-op-2");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ ok: false, error: "provider_argument_invalid" });
    // Not reserved: the same key can be used once the arguments are fixed.
    expect((await getNote({ path: { id: "n8" } }, "runtime-op-2")).statusCode).toBe(200);

    const share = await f.consent(plugin, `${plugin}.share-note`, "connector.dispatch");
    const held = await share({ path: { id: "n1" }, body: { email: "a@b.test" } }, "runtime-op-3");
    expect(held.statusCode).toBe(202);
    expect(held.json()).toMatchObject({ ok: false, schema: 1, status: "approval_pending" });
    expect(f.rest.requests.length).toBe(before + 1);
    // The owner approves; the agent gets the result by repeating the same key.
    const approved = await f.inject("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, f.operator);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(f.rest.requests.at(-1)).toMatchObject({ path: "/api/v1/notes/n1/share" });
    const repeated = await share({ path: { id: "n1" }, body: { email: "a@b.test" } }, "runtime-op-3");
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ ok: true, status: "succeeded", result: { details: { response: { status: 201 } } } });
    expect(f.rest.requests.length).toBe(before + 2);
    expect(await f.everything()).not.toContain(SECRET);
  });
});

type CapabilityEntry = { toolName: string; actionType: string; pluginId: string; inputSchema?: Record<string, unknown>; exposure?: string };

/** Arguments for one operation, built from its describe output. */
function argumentsFor(described: { path: string; arguments: string[]; contentType: string | null }) {
  return {
    ...(described.arguments.includes("path") ? { path: { id: "7" } } : {}),
    ...(described.arguments.includes("body")
      ? { body: described.contentType === "application/x-www-form-urlencoded" ? { channel: "email" } : { name: "x" } }
      : {}),
  };
}

describe("Company Box agent exposure", () => {
  for (const mode of ["discovery", "direct"] as const) {
    it(`reaches 100% of a 152-operation spec through the agent surface (${mode})`, async () => {
      const root = catalog(mode === "direct" ? { bigapp: (entry) => (entry.exposure = "direct") } : {});
      const f = await fixture({
        catalogDir: root,
        rulesClient: async () => ({ effect: "allow", decisionId: "rules-allow" }),
      });
      expect((await f.setup("bigapp", { baseUrl: f.rest.origin, credentials: { apiKey: SECRET } })).statusCode).toBe(200);
      const plugin = "company-box-bigapp";
      const capabilities = (await f.inject("GET", "/api/agent/capabilities?workspaceSlug=ws-a", SERVICE)).json()
        .capabilities as CapabilityEntry[];
      const tools = capabilities.filter((entry) => entry.pluginId === plugin);
      if (mode === "discovery") {
        expect(tools.map((entry) => entry.toolName)).toEqual([
          `marketplace.${plugin}.operations.search`,
          `marketplace.${plugin}.operations.describe`,
          `marketplace.${plugin}.operations.call`,
          `marketplace.${plugin}.approvals.status`,
        ]);
        expect(tools[0]).toMatchObject({ exposure: "discovery", operationCount: 152 });
      } else {
        expect(tools).toHaveLength(153);
        expect(tools.at(-1)?.toolName).toBe(`marketplace.${plugin}.approvals.status`);
        expect(tools.slice(0, 152).every((entry) => entry.inputSchema && !entry.toolName.includes(".operations."))).toBe(true);
      }

      // Enumerate every operation through paginated search.
      const keys: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await f.tool(`marketplace.${plugin}.operations.search`, plugin, { limit: 50, ...(cursor ? { cursor } : {}) });
        expect(page.statusCode, page.body).toBe(200);
        const body = page.json();
        expect(body.total).toBe(152);
        keys.push(...body.operations.map((operation: { key: string }) => operation.key));
        cursor = body.nextCursor;
      } while (cursor);
      expect(new Set(keys).size).toBe(152);
      const catalogKeys = ((await f.inject("GET", "/api/marketplace/v1/agent/action-catalog?workspaceSlug=ws-a", SERVICE)).json()
        .actions as Array<{ pluginId: string; actionKey: string }>)
        .filter((entry) => entry.pluginId === plugin)
        .map((entry) => entry.actionKey);
      expect([...catalogKeys].sort()).toEqual([...keys].sort());

      const before = f.rest.requests.length;
      for (const key of keys) {
        const described = await f.tool(`marketplace.${plugin}.operations.describe`, plugin, { operation: key });
        expect(described.statusCode).toBe(200);
        const operation = described.json().operation;
        expect(operation.inputSchema).toMatchObject({ type: "object" });
        const grantId = await f.grant(plugin, key);
        const args = argumentsFor(operation);
        const called =
          mode === "discovery"
            ? await f.tool(`marketplace.${plugin}.operations.call`, plugin, { operation: key, arguments: args }, grantId)
            : await f.tool(tools.find((entry) => entry.actionType === key)!.toolName, plugin, args, grantId);
        expect(called.statusCode, `${key}: ${called.body}`).toBe(200);
        expect(called.json().result.details.operation.key).toBe(key);
      }
      expect(f.rest.requests.length - before).toBe(152);
      const outwardKeys = f.rulesCalls
        .filter((call) => call.operation === "execute" && (call.payload.risk as { outward?: boolean } | undefined)?.outward && call.payload.phase === undefined)
        .length;
      expect(outwardKeys).toBe(25);
      expect(await f.everything()).not.toContain(SECRET);

      if (mode === "discovery") {
        // Per-operation tool names are not offered in discovery mode.
        const direct = await f.tool(`marketplace.${plugin}.ping`, plugin, {});
        expect(direct.statusCode).toBe(404);
        expect(direct.json()).toMatchObject({ error: "agent_tool_not_available" });
      }
      const unknown = await f.tool(`marketplace.${plugin}.operations.call`, plugin, { operation: `${plugin}.nope` });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: "company_box_operation_not_found" });
    }, 60_000);
  }
});

describe("Company Box MCP entries and lifecycle", () => {
  it("installs an official MCP server through the custom MCP path with exclusions and outward flags", async () => {
    const f = await fixture();
    const setup = await f.setup("tracker", { baseUrl: f.mcp.origin, credentials: { token: SECRET } });
    expect(setup.statusCode, setup.body).toBe(200);
    const entry = setup.json().entry;
    expect(entry).toMatchObject({ source: "mcp", installed: true, connection: { state: "connected" }, coverage: { exposed: 3, total: 4 } });
    const pluginId = entry.pluginId as string;
    expect(pluginId).toMatch(/^mcp-cb-tracker-[0-9a-f]{8}$/u);
    const listing = f.store.getListing(pluginId)!;
    expect(listing.actions).toEqual([`${pluginId}.echo`, `${pluginId}.create-issue`, `${pluginId}.fail-tool`]);
    expect(f.store.getConnection("ws-a", pluginId)?.metadata.companyBox).toEqual({
      entryId: "tracker",
      snapshotTools: 3,
      missingFromServer: [],
      notInSnapshot: [],
    });
    const custom = (await f.inject("GET", "/api/marketplace/connectors/custom", f.operator)).json();
    expect(custom.items.map((item: { pluginId: string }) => item.pluginId)).toEqual([pluginId]);

    const echo = await f.grant(pluginId, `${pluginId}.echo`);
    expect((await f.tool(`marketplace.${pluginId}.echo`, pluginId, { message: "hi" }, echo)).statusCode).toBe(200);
    const issue = await f.grant(pluginId, `${pluginId}.create-issue`);
    const outward = await f.tool(`marketplace.${pluginId}.create-issue`, pluginId, { title: "Bug" }, issue);
    expect(outward.statusCode).toBe(202);
    const toolCalls = () => f.mcp.requests.filter((request) => request.rpcMethod === "tools/call").length;
    const callsBefore = toolCalls();
    const approved = await f.inject("POST", `/api/marketplace/company-box/approvals/${outward.json().approvalId}/approve`, f.operator);
    expect(approved.json()).toMatchObject({ ok: true, approval: { state: "succeeded", operation: { title: "create_issue" } } });
    expect(toolCalls()).toBe(callsBefore + 1);
    const search = await f.tool(`marketplace.${pluginId}.operations.search`, pluginId, {});
    expect(search.json()).toMatchObject({ total: 3, operations: expect.arrayContaining([expect.objectContaining({ key: `${pluginId}.create-issue`, outward: true })]) });
    expect(await f.everything()).not.toContain(SECRET);

    const removed = await f.inject("DELETE", "/api/marketplace/company-box/tracker", f.operator);
    expect(removed.statusCode).toBe(200);
    expect(f.store.getListing(pluginId)).toBeNull();
    expect((await f.tool(`marketplace.${pluginId}.echo`, pluginId, { message: "hi" }, echo)).statusCode).toBe(404);
  });

  it("removal revokes agent access and deletes credentials", async () => {
    const f = await fixture();
    await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } });
    const plugin = "company-box-notes";
    const grantId = await f.grant(plugin, `${plugin}.list-notes`);
    const removed = await f.inject("DELETE", "/api/marketplace/company-box/notes", f.operator);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().entry).toMatchObject({ installed: false, connection: { state: "disconnected" }, credentials: [{ configured: false }] });
    expect(f.store.listConnectorSecrets({ workspaceSlug: "ws-a", pluginId: plugin })).toEqual([]);
    const denied = await f.tool(`marketplace.${plugin}.list-notes`, plugin, {}, grantId);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "agent_grant_revoked" });
    const retest = await f.inject("POST", "/api/marketplace/company-box/notes/test", f.operator);
    expect(retest.json()).toMatchObject({ error: "company_box_not_set_up" });
  });

  it("retires a listing whose entry left the catalog", async () => {
    const storeRoot = tempDir("company-box-retire-");
    const first = await fixture({ storeRoot });
    await first.setup("notes", { baseUrl: first.rest.origin, credentials: { token: SECRET } });
    const empty = tempDir("company-box-empty-");
    const second = await fixture({ storeRoot, catalogDir: empty });
    expect(second.store.getListing("company-box-notes")).toMatchObject({ actions: [], capabilities: [] });
    const catalogResponse = await second.inject("GET", "/api/marketplace/v1/agent/action-catalog?workspaceSlug=ws-a", SERVICE);
    expect(catalogResponse.json().actions.filter((entry: { pluginId: string }) => entry.pluginId === "company-box-notes")).toEqual([]);
    expect((await second.inject("GET", "/api/marketplace/company-box", second.operator)).json().entries).toEqual([]);
  });
});

describe("Company Box approvals (owner mode)", () => {
  const plugin = "company-box-notes";
  const shareArgs = { path: { id: "n1" }, body: { email: "someone@example.test", message: "private-arg-marker" } };

  async function held(f: Awaited<ReturnType<typeof fixture>>, idempotencyKey = "share-key-0001") {
    expect((await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } })).statusCode).toBe(200);
    const grantId = await f.grant(plugin, `${plugin}.share-note`);
    const call = () =>
      f.inject("POST", `/api/agent/tools/marketplace.${plugin}.share-note`, AGENT, {
        workspaceSlug: "ws-a",
        pluginId: plugin,
        input: shareArgs,
        grantId,
        idempotencyKey,
      });
    const first = await call();
    expect(first.statusCode, first.body).toBe(202);
    return { approvalId: first.json().approvalId as string, call, grantId };
  }

  const status = (f: Awaited<ReturnType<typeof fixture>>, approvalId: string, agent = "agent-1") =>
    f.inject("POST", `/api/agent/tools/marketplace.${plugin}.approvals.status`, { ...AGENT, "x-tealbrick-agent-token": agent }, {
      workspaceSlug: "ws-a",
      pluginId: plugin,
      input: { approvalId },
    });

  it("lists the held call for the owner and executes it exactly once on approval", async () => {
    const f = await fixture();
    const { approvalId, call, grantId } = await held(f);
    expect((await call()).json()).toMatchObject({ status: "approval_pending", approvalId });
    const list = await f.inject("GET", "/api/marketplace/company-box/approvals?state=pending", f.operator);
    expect(list.json()).toMatchObject({
      pendingCount: 1,
      approvals: [{ id: approvalId, app: "Notes", agentId: "agent-1", state: "pending", operation: { title: "Email a note to someone", method: "POST", path: "/notes/{id}/share" } }],
    });
    expect(list.json().approvals[0].argumentsPreview).toContain("someone@example.test");

    const before = f.rest.requests.length;
    const [one, two] = await Promise.all([
      f.inject("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, f.operator),
      f.inject("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, f.operator),
    ]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 409]);
    expect(f.rest.requests.length - before).toBe(1);
    expect(f.rest.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/notes/n1/share" });
    const again = await f.inject("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, f.operator);
    expect(again.json()).toMatchObject({ error: "approval_not_pending", approval: { state: "succeeded" } });

    const polled = await status(f, approvalId);
    expect(polled.json()).toMatchObject({ ok: true, status: "succeeded", result: { details: { response: { status: 201 } } } });
    const repeated = await call();
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ ok: true, status: "succeeded", approvalId });
    expect(f.rest.requests.length - before).toBe(1);

    const changedArgs = await f.inject("POST", `/api/agent/tools/marketplace.${plugin}.share-note`, AGENT, {
      workspaceSlug: "ws-a",
      pluginId: plugin,
      input: { ...shareArgs, body: { email: "other@example.test" } },
      grantId,
      idempotencyKey: "share-key-0001",
    });
    expect(changedArgs.statusCode).toBe(409);
    expect(changedArgs.json()).toMatchObject({ error: "approval_idempotency_conflict" });

    // Arguments are stored for the owner, never in audit, events or logs.
    const audit = (await f.inject("GET", "/api/marketplace/audit?workspaceSlug=ws-a&limit=500", f.operator)).body;
    expect(audit).toContain("marketplace.company_box.approval.requested");
    expect(audit).toContain("marketplace.company_box.approval.approved");
    expect(audit).not.toContain("private-arg-marker");
    expect((await f.inject("GET", "/events?workspaceSlug=ws-a", SERVICE)).body).not.toContain("private-arg-marker");
    expect(JSON.stringify(f.errors.mock.calls)).not.toContain("private-arg-marker");
  });

  it("records a denial and never runs a denied call", async () => {
    const f = await fixture();
    const { approvalId, call } = await held(f);
    const before = f.rest.requests.length;
    const denied = await f.inject("POST", `/api/marketplace/company-box/approvals/${approvalId}/deny`, f.operator);
    expect(denied.json()).toMatchObject({ ok: true, approval: { state: "denied", decidedBy: "operator-ws-a" } });
    expect((await f.inject("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, f.operator)).statusCode).toBe(409);
    const repeated = await call();
    expect(repeated.statusCode).toBe(403);
    expect(repeated.json()).toMatchObject({ status: "denied", error: "approval_denied" });
    expect((await status(f, approvalId)).json()).toMatchObject({ status: "denied" });
    expect(f.rest.requests.length).toBe(before);
    expect((await f.inject("GET", "/api/marketplace/audit?workspaceSlug=ws-a&limit=500", f.operator)).body).toContain("marketplace.company_box.approval.denied");
  });

  it("expires held calls after 7 days", async () => {
    const f = await fixture();
    const { approvalId } = await held(f);
    const approval = f.store.getCompanyBoxApproval(approvalId)!;
    expect(Date.parse(approval.expiresAt) - Date.parse(approval.createdAt)).toBe(7 * 24 * 60 * 60 * 1000);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.parse(approval.expiresAt) + 60_000);
      const late = await f.inject("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, f.operator);
      expect(late.statusCode).toBe(409);
      expect(late.json()).toMatchObject({ error: "approval_expired", approval: { state: "expired" } });
      expect((await status(f, approvalId)).json()).toMatchObject({ ok: true, status: "expired" });
      expect(f.store.getCompanyBoxApproval(approvalId)?.state).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("only the requesting agent can read an approval, and only the owner can decide it", async () => {
    const f = await fixture();
    const { approvalId } = await held(f);
    expect((await status(f, approvalId)).json()).toMatchObject({ ok: true, status: "approval_pending" });
    const otherAgent = await status(f, approvalId, "agent-2");
    expect(otherAgent.statusCode).toBe(404);
    expect(otherAgent.json()).toEqual({ ok: false, error: "approval_not_found" });
    const unattested = await f.inject("POST", `/api/agent/tools/marketplace.${plugin}.approvals.status`, SERVICE, {
      workspaceSlug: "ws-a",
      pluginId: plugin,
      input: { approvalId },
    });
    expect(unattested.statusCode).toBe(401);

    // Service bearer (agents' infrastructure) cannot approve or list.
    expect((await f.inject("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, AGENT)).statusCode).toBe(403);
    expect((await f.inject("GET", "/api/marketplace/company-box/approvals", SERVICE)).statusCode).toBe(403);
    expect(f.store.getCompanyBoxApproval(approvalId)?.state).toBe("pending");
  });

  it("validates and bounds held arguments before storing them", async () => {
    const f = await fixture();
    expect((await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } })).statusCode).toBe(200);
    const grantId = await f.grant(plugin, `${plugin}.share-note`);
    const send = (input: Record<string, unknown>) =>
      f.inject("POST", `/api/agent/tools/marketplace.${plugin}.share-note`, AGENT, { workspaceSlug: "ws-a", pluginId: plugin, input, grantId });
    const invalid = await send({ path: { id: ".." }, body: { email: "a@b.test" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "openapi_argument_invalid", field: "path.id" });
    const large = await send({ path: { id: "n1" }, body: { email: "a@b.test", message: "x".repeat(40_000) } });
    expect(large.statusCode).toBe(413);
    expect(large.json()).toMatchObject({ error: "approval_arguments_too_large" });
    expect(f.store.listCompanyBoxApprovals({ workspaceSlug: "ws-a" })).toEqual([]);
  });
});

describe("Company Box catalog groups, reads, schemas and usage evidence", () => {
  it("publishes a stable group per action and classifies reads patterns as reads", async () => {
    const root = catalog({ notes: (entry) => (entry.reads = ["createFolder"]) });
    const f = await fixture({ catalogDir: root });
    await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } });
    await f.setup("tracker", { baseUrl: f.mcp.origin, credentials: { token: SECRET } });
    const actions = (await f.inject("GET", "/api/marketplace/v1/agent/action-catalog?workspaceSlug=ws-a", SERVICE)).json()
      .actions as Array<{ actionKey: string; group?: string; capability: string; pluginId: string }>;
    const byKey = new Map(actions.map((action) => [action.actionKey, action]));
    expect(byKey.get("company-box-notes.list-notes")?.group).toBe("notes");
    expect(byKey.get("company-box-notes.get-health")?.group).toBe("system");
    expect(byKey.get("company-box-notes.list-folders")?.group).toBe("folders");
    // POST createFolder is read-class through `reads`.
    expect(byKey.get("company-box-notes.create-folder")).toMatchObject({ capability: "connector.observe" });
    expect(actions.filter((action) => action.pluginId.startsWith("mcp-cb-tracker-")).every((action) => action.group === "tracker")).toBe(true);
    const readOnly = await f.grant("company-box-notes", "company-box-notes.create-folder");
    const created = await f.tool("marketplace.company-box-notes.create-folder", "company-box-notes", { body: { name: "Inbox" } }, readOnly);
    expect(created.statusCode, created.body).toBe(200);

    // Usage evidence keeps the output's size and sha256.
    const usage = (await f.inject("GET", "/api/marketplace/audit?workspaceSlug=ws-a&limit=500", f.operator)).json().usage as Array<{ sourceActionKey: string; metadata: { output?: { bytes: number; sha256: string } } }>;
    expect(usage.find((entry) => entry.sourceActionKey === "company-box-notes.create-folder")?.metadata.output).toEqual({
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("describe serves the pinned snapshot schema for MCP tools over 16 KB", async () => {
    const big = {
      name: "bulk_import",
      description: "Import many records.",
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`field_${index}`, { type: "string", description: "y".repeat(40) }])),
      },
    };
    const tools = [...FAKE_MCP_TOOLS, big];
    const root = catalog();
    const snapshot = { server: { name: "fake-mcp", version: "1.0.0" }, tools };
    const text = JSON.stringify(snapshot);
    writeFileSync(path.join(root, "tracker", "tools.json"), text);
    const entryPath = path.join(root, "tracker", "entry.json");
    const entry = JSON.parse(readFileSync(entryPath, "utf8"));
    entry.mcp.sha256 = createHash("sha256").update(text).digest("hex");
    writeFileSync(entryPath, JSON.stringify(entry));
    const f = await fixture({ catalogDir: root, mcpTools: tools });
    const setup = await f.setup("tracker", { baseUrl: f.mcp.origin, credentials: { token: SECRET } });
    expect(setup.statusCode, setup.body).toBe(200);
    const pluginId = setup.json().entry.pluginId as string;
    expect(f.store.getListing(pluginId)?.manifest).toBeDefined();
    const described = await f.tool(`marketplace.${pluginId}.operations.describe`, pluginId, { operation: `${pluginId}.bulk-import` });
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json().operation).toMatchObject({ schemaSource: "snapshot" });
    expect(Object.keys(described.json().operation.inputSchema.properties)).toHaveLength(500);
    const small = await f.tool(`marketplace.${pluginId}.operations.describe`, pluginId, { operation: `${pluginId}.echo` });
    expect(small.json().operation).toMatchObject({ schemaSource: "server", inputSchema: { properties: { message: { type: "string" } } } });
  });
});

describe("Company Box security review fixes", () => {
  const plugin = "company-box-notes";

  it("never sends stored credentials to a new origin", async () => {
    const f = await fixture();
    expect((await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } })).statusCode).toBe(200);
    // Another allowlisted origin stands in for "a new host".
    const mcpBefore = f.mcp.requests.length;
    const moved = await f.setup("notes", { baseUrl: f.mcp.origin });
    expect(moved.statusCode).toBe(400);
    expect(moved.json()).toEqual({ ok: false, error: "company_box_credentials_required", fields: ["token"], reason: "origin_changed" });
    expect(f.mcp.requests.length).toBe(mcpBefore);
    // Same origin, new path: stored credentials keep working.
    expect((await f.setup("notes", { baseUrl: `${f.rest.origin}/v2` })).statusCode).toBe(200);
    expect(f.rest.requests.at(-1)?.headers.authorization).toBe(`Bearer ${SECRET}`);

    // MCP entries: the generic custom connector PATCH obeys the same rule.
    const setup = await f.setup("tracker", { baseUrl: f.mcp.origin, credentials: { token: SECRET } });
    const pluginId = setup.json().entry.pluginId as string;
    const restBefore = f.rest.requests.length;
    const patched = await f.app.inject({ method: "PATCH", url: `/api/marketplace/connectors/custom/${pluginId}`, headers: f.operator, payload: { url: `${f.rest.origin}/mcp` } });
    expect(patched.statusCode).toBe(400);
    expect(patched.json()).toMatchObject({ error: "custom_mcp_secrets_required_for_new_origin", secretHeaders: ["x-api-key"] });
    const mcpMoved = await f.setup("tracker", { baseUrl: f.rest.origin });
    expect(mcpMoved.json()).toMatchObject({ error: "company_box_credentials_required", reason: "origin_changed" });
    expect(f.rest.requests.length).toBe(restBefore);
  });

  it("serves the full stored arguments to the owner only", async () => {
    const f = await fixture();
    await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } });
    const grantId = await f.grant(plugin, `${plugin}.share-note`);
    const message = "m".repeat(5_000);
    const held = await f.inject("POST", `/api/agent/tools/marketplace.${plugin}.share-note`, AGENT, {
      workspaceSlug: "ws-a",
      pluginId: plugin,
      input: { path: { id: "n1" }, body: { email: "a@b.test", message } },
      grantId,
    });
    const approvalId = held.json().approvalId as string;
    const full = await f.inject("GET", `/api/marketplace/company-box/approvals/${approvalId}`, f.operator);
    expect(full.json()).toMatchObject({ ok: true, arguments: { path: { id: "n1" }, body: { email: "a@b.test", message } } });
    expect(full.json().approval.argumentsPreview.length).toBeLessThanOrEqual(400);
    expect((await f.inject("GET", `/api/marketplace/company-box/approvals/${approvalId}`, SERVICE)).statusCode).toBe(403);
  });

  it("caps pending approvals per agent and dedupes concurrent holds with one key", async () => {
    const f = await fixture();
    await f.setup("notes", { baseUrl: f.rest.origin, credentials: { token: SECRET } });
    const grantId = await f.grant(plugin, `${plugin}.share-note`);
    const send = (idempotencyKey?: string) =>
      f.inject("POST", `/api/agent/tools/marketplace.${plugin}.share-note`, AGENT, {
        workspaceSlug: "ws-a",
        pluginId: plugin,
        input: { path: { id: "n1" }, body: { email: "a@b.test" } },
        grantId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    const [one, two] = await Promise.all([send("same-key-0001"), send("same-key-0001")]);
    expect([one.statusCode, two.statusCode]).toEqual([202, 202]);
    expect(one.json().approvalId).toBe(two.json().approvalId);
    for (let index = 1; index < 50; index += 1) expect((await send()).statusCode).toBe(202);
    const full = await send();
    expect(full.statusCode).toBe(429);
    expect(full.json()).toMatchObject({ error: "approval_queue_full" });
  });

  it("keeps live MCP tools that are not in the pinned snapshot unusable", async () => {
    const extra = { name: "surprise_tool", description: "Added upstream after pinning." };
    const f = await fixture({ mcpTools: [...FAKE_MCP_TOOLS, extra] });
    const setup = await f.setup("tracker", { baseUrl: f.mcp.origin, credentials: { token: SECRET } });
    const pluginId = setup.json().entry.pluginId as string;
    expect(f.store.getListing(pluginId)?.actions).not.toContain(`${pluginId}.surprise-tool`);
    expect(f.store.getConnection("ws-a", pluginId)?.metadata.companyBox).toMatchObject({ notInSnapshot: ["surprise_tool"] });
  });
});

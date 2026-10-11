/**
 * Agent approval modes (Assistant / System), daily limits, the kill switch and Assistant-mode receipts, end to end
 * with the real buildMarketplaceApp and the real SQLite mode store (no mocks of the store).
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import {
  SENSITIVE_ACTION_FAMILIES,
  classifySensitive,
  commitCapReservation,
  decideOutward,
  getAgentApprovalMode,
  assistantHold,
  getHoldFamilies,
  isAgentPaused,
  redactArguments,
  releaseCapReservation,
  sensitiveMatches,
  toolNameSegments,
  writeOutwardReceipt,
} from "./agent-approval-mode.js";
import { seededPin } from "./channels/approval-test-support.js";
import { AGENT_OPERATION } from "./contract.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "./operator-auth.js";
import type { PortalAgentScopeVerifier } from "./portal-scope.js";
import { SqliteMarketplaceStore } from "./store.js";
import type { ConnectorCapability } from "./types.js";

const SERVICE = "marketplace-service-token-modes";
const PORTAL = "https://portal.test";
const TENANT = "atlas";
const APP_GRANT = `tbag_${"m".repeat(43)}`;
// A fake key shaped like a provider secret, assembled at runtime so it is never a literal in the repository.
const FAKE_SECRET = ["sk", "live", "notarealkey", "0000", "fake"].join("_");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type FixtureInput = {
  root?: string;
  capabilities?: ConnectorCapability[];
  failTools?: string[];
  rules?: "allow" | "deny";
  pinned?: boolean;
  now?: { value: Date };
};

async function modes(input: FixtureInput = {}) {
  const root = input.root ?? (await mkdtemp(path.join(os.tmpdir(), "marketplace-agent-modes-")));
  if (!input.root) cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), { handoffEncryptionKey: "a".repeat(64) });
  const executions: Array<{ tool: string; body: Record<string, unknown> }> = [];
  const rulesCalls: Array<Record<string, unknown>> = [];
  const capabilities = input.capabilities ?? ["connector.observe", "connector.dispatch", "connector.admin"];
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "operator-access-token", operatorId: "owner-1", organizationId: TENANT });
  /** Portal's agentPolicy claim per agent, as the verified attachment / lease carries it (undefined: none). */
  const policies = new Map<string, unknown>();
  const agentScopeVerifier: PortalAgentScopeVerifier = async ({ agentToken, requiredCapability }) => {
    if (!capabilities.includes(requiredCapability as ConnectorCapability)) throw new Error("capability_not_granted");
    return {
      organizationId: TENANT, agentId: agentToken, attachmentId: "attachment-1", capabilities, expiresAt: Math.floor(Date.now() / 1000) + 300,
      ...(policies.has(agentToken) ? { agentPolicy: policies.get(agentToken) } : {}),
    };
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
          actions: ["create", "read", "update", "delete"],
          // Even a grant naming the owner operations cannot reach them.
          operations: [AGENT_OPERATION.consentsList, AGENT_OPERATION.toolsCall, "marketplace.agents.update", "marketplace.agents.resume", "marketplace.agents.resume-all", "marketplace.agent-receipts.list"],
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
    portalRuntimeScopeVerifier: async ({ requiredCapability }) => ({
      portalOrgId: "portal-org-1", productTenantId: TENANT, workspaceId: TENANT, deploymentId: "deployment-1", agentId: "agent-1",
      consentId: "consent-lease", leaseId: "lease-1", capabilities: [requiredCapability], expiresAt: Date.now() + 300_000,
      ...(policies.has("agent-1") ? { agentPolicy: policies.get("agent-1") } : {}),
    }),
    ...(input.pinned === false ? {} : { ownerPinSource: seededPin({ portalIssuer: PORTAL }) }),
    ...(input.now ? { agentModeClock: () => input.now!.value } : {}),
    ...(input.rules
      ? {
          rulesClient: async (request) => {
            rulesCalls.push(request as unknown as Record<string, unknown>);
            const deny = input.rules === "deny" && (request as { operation?: string }).operation === "execute";
            return deny ? { effect: "deny" as const, decisionId: "rules-deny" } : { effect: "allow" as const, decisionId: "rules-allow" };
          },
        }
      : {}),
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    environment: {
      NODE_ENV: "test",
      MARKETPLACE_ORGANIZATION_ID: TENANT,
      MARKETPLACE_PORTAL_URL: `${PORTAL}/`,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: "p".repeat(43),
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: TENANT,
    },
    providerFetch: async (url, init) => {
      const match = /\/tools\/execute\/([A-Z0-9_]+)/u.exec(String(url));
      if (match) {
        executions.push({ tool: match[1]!, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        if (input.failTools?.includes(match[1]!)) return new Response(JSON.stringify({ error: "upstream failed" }), { status: 500 });
        return new Response(JSON.stringify({ data: { id: "done-1" }, successful: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
  });
  cleanups.push(async () => {
    await app.close();
    try {
      store.close();
    } catch {
      // Already closed by a restart test.
    }
  });
  const service = { authorization: `Bearer ${SERVICE}` };
  const owner = (() => {
    const { token, status } = sessions.issuePortalSession({ id: "owner-1", organizationId: TENANT });
    return { origin: "http://localhost", cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`, "x-csrf-token": status.csrfToken! };
  })();
  const agent = (agentId: string) => ({ ...service, "x-tealbrick-agent-token": agentId, "x-tealbrick-attachment": "attachment-1" });

  const importToolkit = async (toolkit: string, slugs: string[]) => {
    const pluginId = `${toolkit}-composio`;
    if (!store.getListing(pluginId)) {
      const imported = await app.inject({
        method: "POST",
        url: "/api/marketplace/catalog/composio/import",
        headers: service,
        payload: { workspaceSlug: TENANT, toolkit, pluginId, tools: slugs.map((name) => ({ name })), autoEnable: true },
      });
      expect(imported.statusCode, imported.body).toBe(201);
      store.upsertConnection({ workspaceSlug: TENANT, pluginId, provider: toolkit, backend: "composio", state: "connected", detail: "Test account", metadata: { connectedAccountId: "ca_1" } });
      for (const capability of ["connector.observe", "connector.dispatch", "connector.admin"] as const) {
        store.bindCapability({ workspaceSlug: TENANT, pluginId, capability, enabled: true });
      }
    }
    return pluginId;
  };
  const grant = async (agentId: string, pluginId: string, actionKey: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: agent(agentId),
      payload: { workspaceSlug: TENANT, pluginId, actionKey, accountId: "ca_1", resourceKind: `${pluginId.replace(/-composio$/u, "")}.connected-account`, resourceRef: "account:ca_1" },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().grant.id as string;
  };
  let keyCounter = 0;
  const call = (agentId: string, pluginId: string, actionKey: string, grantId: string, input: Record<string, unknown> = {}, idempotencyKey = `mode-key-${String(++keyCounter).padStart(6, "0")}`) =>
    app.inject({
      method: "POST",
      url: `/api/agent/tools/marketplace.${actionKey}`,
      headers: agent(agentId),
      payload: { workspaceSlug: TENANT, pluginId, grantId, input, idempotencyKey },
    });
  const setMode = (agentId: string, body: Record<string, unknown>, headers: Record<string, string> = owner) =>
    app.inject({ method: "PATCH", url: `/api/marketplace/agents/${agentId}`, headers, payload: body });
  const ownerPost = (url: string, headers: Record<string, string> = owner) => app.inject({ method: "POST", url, headers, payload: {} });
  const setFamily = (familyId: string, on: boolean, headers: Record<string, string> = owner) =>
    app.inject({ method: "PATCH", url: `/api/marketplace/agents/hold-families/${familyId}`, headers, payload: { on } });
  const overview = async () => (await app.inject({ method: "GET", url: "/api/marketplace/agents", headers: owner })).json();
  const approve = (approvalId: string) => app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${approvalId}/approve`, headers: owner });
  const consent = (pluginId: string, actionKey: string, capability: ConnectorCapability, consentId: string) => {
    const connection = store.getConnection(TENANT, pluginId)!;
    return store.createMarketplaceAgentConsent({
      portalIssuer: PORTAL, portalOrgId: "portal-org-1", productTenantId: TENANT, workspaceId: TENANT, deploymentId: "deployment-1",
      userId: "owner-1", agentId: "agent-1", consentId, consentRevision: 1, pluginId, actionKey, capability,
      connectionId: connection.id, accountId: "ca_1", resourceKind: `${pluginId.replace(/-composio$/u, "")}.connected-account`, resourceRef: "account:ca_1",
      capabilities: [capability], requiredActions: [capability === "connector.observe" ? "read" : "create"],
    }).consent;
  };
  const toolsCall = (body: Record<string, unknown>, key: string) =>
    app.inject({ method: "POST", url: "/api/marketplace/v1/agent/tools/call", headers: { authorization: `Bearer ${APP_GRANT}`, "idempotency-key": key }, payload: body });
  const receiptAudit = () =>
    (store.listAudit({ workspaceSlug: TENANT, limit: 500 }) as Array<{ event_type: string; metadata: string }>)
      .filter((row) => row.event_type === "marketplace.agent.outward.receipt")
      .map((row) => JSON.parse(row.metadata) as Record<string, unknown>);
  return { root, app, store, executions, rulesCalls, sessions, policies, service, owner, agent, importToolkit, grant, call, setMode, ownerPost, setFamily, overview, approve, consent, toolsCall, receiptAudit };
}

type Fixture = Awaited<ReturnType<typeof modes>>;

async function gmail(f: Fixture) {
  return f.importToolkit("gmail", ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS", "GMAIL_TRASH_MESSAGE", "GMAIL_FORWARD_MESSAGE", "GMAIL_DELETE_MESSAGE"]);
}

const sendInput = { recipient_email: "client@example.invalid", subject: "Invoice", body: "Attached." };

describe("sensitive families", () => {
  it("keeps one exported list with the four families and matches whole word segments", () => {
    expect(SENSITIVE_ACTION_FAMILIES.map((family) => family.family)).toEqual(["destructive", "money", "access-sharing", "bulk"]);
    expect(toolNameSegments("GMAIL_SEND_EMAIL", "gmail")).toEqual(["SEND", "EMAIL"]);
    expect(toolNameSegments("sendMessageToAll")).toEqual(["SEND", "MESSAGE", "TO", "ALL"]);
    const samples: Array<[string, string | undefined, string]> = [
      ["GMAIL_TRASH_MESSAGE", "gmail", "destructive"],
      ["NOTION_ARCHIVE_ALL", "notion", "destructive"],
      ["STRIPE_CREATE_REFUND", "stripe", "money"],
      ["STRIPE_CANCEL_SUBSCRIPTION", "stripe", "money"],
      ["GOOGLEDRIVE_SHARE_FILE", "googledrive", "access-sharing"],
      ["GMAIL_CREATE_FORWARDING_RULE", "gmail", "access-sharing"],
      ["GITHUB_CREATE_API_KEY", "github", "access-sharing"],
      ["MAILCHIMP_BULK_SEND", "mailchimp", "bulk"],
      ["SLACK_BROADCAST_MESSAGE", "slack", "bulk"],
      ["notify_users_all", undefined, "bulk"],
      ["mass_email", undefined, "bulk"],
      // Plural last words (pretix `orders_refunds.create`, `teams_invites.create`).
      ["orders_refunds.create", undefined, "money"],
      ["teams_invites.create", undefined, "access-sharing"],
      ["GMAIL_DELETE_MESSAGES", "gmail", "destructive"],
    ];
    for (const [slug, toolkit, family] of samples) {
      expect(sensitiveMatches(slug, toolkit).map((match) => match.family), slug).toContain(family);
    }
    // Not sensitive: ordinary sends, partial words, a toolkit name that contains a word.
    for (const [slug, toolkit] of [["GMAIL_SEND_EMAIL", "gmail"], ["SLACK_SEND_MESSAGE", "slack"], ["GOOGLEDRIVE_LIST_SHARED_DRIVES", "googledrive"], ["SHAREPOINT_LIST_FILES", "sharepoint"], ["SHOPIFY_ORDERLY_SYNC", "shopify"], ["PAYPAL_GET_BALANCE", "paypal"], ["BULK", undefined], ["ALL", undefined]] as const) {
      expect(sensitiveMatches(slug, toolkit), slug).toEqual([]);
    }
    expect(classifySensitive("STRIPE_CREATE_REFUND", { toolkit: "stripe" })).toEqual({ sensitive: true, family: "money", word: "REFUND" });
    expect(classifySensitive("GMAIL_SEND_EMAIL", { toolkit: "gmail" })).toEqual({ sensitive: false });
    // A family the owner turned off no longer matches.
    expect(classifySensitive("STRIPE_CREATE_REFUND", { toolkit: "stripe", families: [{ id: "money", on: false }] })).toEqual({ sensitive: false });
  });

  it("redacts secret keys and token-looking values", () => {
    expect(redactArguments({ api_key: "abc", body: FAKE_SECRET, nested: { Authorization: "Bearer x", note: "hello" }, list: [`ghp_${"x".repeat(20)}`] })).toEqual({
      api_key: "[redacted]",
      body: "[redacted]",
      nested: { Authorization: "[redacted]", note: "hello" },
      list: ["[redacted]"],
    });
  });
});

describe("only the owner sets the mode", () => {
  it("accepts the pinned owner's launch session with CSRF and refuses every other caller", async () => {
    const f = await modes();
    const accessTokenLogin = f.sessions.exchange("operator-access-token", "static-operator");
    const staticOperator = { origin: "http://localhost", cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${accessTokenLogin.token}`, "x-csrf-token": accessTokenLogin.status.csrfToken! };
    const refusals: Array<[string, Record<string, string>]> = [
      ["agent app grant", { authorization: `Bearer ${APP_GRANT}` }],
      ["service bearer", f.service],
      ["service bearer with agent headers", f.agent("agent-1")],
      ["Portal runtime lease", { authorization: "Bearer portal-runtime-lease-token" }],
      ["static operator access token", staticOperator],
      ["owner session without CSRF", { origin: f.owner.origin, cookie: f.owner.cookie }],
    ];
    for (const [label, headers] of refusals) {
      for (const response of [
        await f.setMode("agent-1", { mode: "assistant" }, headers),
        await f.ownerPost("/api/marketplace/agents/agent-1/resume", headers),
        await f.ownerPost("/api/marketplace/agents/resume-all", headers),
      ]) {
        expect(response.statusCode, `${label}: ${response.body}`).toBeGreaterThanOrEqual(401);
        expect(response.statusCode, label).toBeLessThan(500);
      }
    }
    expect(f.store.agentModes.getSetting(TENANT, "agent-1")).toMatchObject({ mode: "system", stored: false });
    // A grant listing the owner operation is still refused as owner-only.
    const viaGrant = await f.setMode("agent-1", { mode: "assistant" }, { authorization: `Bearer ${APP_GRANT}` });
    expect(viaGrant.json()).toEqual({ error: "operation_owner_only" });

    const set = await f.setMode("agent-1", { mode: "assistant", dailyCap: 7 });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().agent).toMatchObject({ agentId: "agent-1", mode: "assistant", dailyCap: 7, connectorDailyCap: 50 });
    const audit = f.store.listAudit({ workspaceSlug: TENANT, limit: 50 }) as Array<{ event_type: string; actor_id: string; metadata: string }>;
    expect(audit.find((row) => row.event_type === "marketplace.agent.mode.changed")).toMatchObject({ actor_id: "operator:owner-1" });
  });

  it("refuses every write while no owner is pinned (fail closed)", async () => {
    const f = await modes({ pinned: false });
    const response = await f.setMode("agent-1", { mode: "assistant" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "approval_owner_unbound" });
  });
});

describe("modes are per agent and per workspace", () => {
  it("starts every agent in System, never shares a mode, and resets a removed agent to System", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    expect(f.store.agentModes.getSetting(TENANT, "agent-new").mode).toBe("system");
    expect((await f.setMode("agent-a", { mode: "assistant" })).statusCode).toBe(200);
    const a = await f.grant("agent-a", pluginId, "gmail.send.email");
    const b = await f.grant("agent-b", pluginId, "gmail.send.email");
    expect((await f.call("agent-a", pluginId, "gmail.send.email", a, sendInput)).statusCode).toBe(200);
    const fromB = await f.call("agent-b", pluginId, "gmail.send.email", b, sendInput);
    expect(fromB.statusCode).toBe(202);
    expect(fromB.json()).toMatchObject({ status: "approval_pending", heldBecause: "system_mode" });
    // Another workspace on the same store never sees agent-a's mode.
    expect(f.store.agentModes.getSetting("other-workspace", "agent-a")).toMatchObject({ mode: "system", stored: false });
    expect((await f.overview()).agents.map((entry: { agentId: string; mode: string }) => [entry.agentId, entry.mode])).toEqual([
      ["agent-a", "assistant"],
      ["agent-b", "system"],
    ]);
    // agent-a is removed (its last grant revoked) and registered again with the same id: System.
    const revoked = await f.app.inject({ method: "POST", url: `/api/marketplace/agent/grants/${a}/revoke`, headers: f.owner, payload: {} });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(f.store.agentModes.getSetting(TENANT, "agent-a")).toMatchObject({ mode: "system", stored: false });
    const again = await f.grant("agent-a", pluginId, "gmail.send.email");
    expect((await f.call("agent-a", pluginId, "gmail.send.email", again, sendInput)).statusCode).toBe(202);
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_SEND_EMAIL"]);
  });
});

describe("System and Assistant", () => {
  it("System holds every outward call; Assistant runs it at once with a receipt", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    const grantId = await f.grant("agent-1", pluginId, "gmail.send.email");
    const held = await f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput);
    expect(held.statusCode).toBe(202);
    expect(f.executions).toEqual([]);
    expect((await f.setMode("agent-1", { mode: "assistant" })).statusCode).toBe(200);
    const ran = await f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput);
    expect(ran.statusCode, ran.body).toBe(200);
    expect(ran.json()).toMatchObject({ ok: true, receipt: { status: "succeeded", mode: "assistant" } });
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_SEND_EMAIL"]);
    expect(f.store.agentModes.listReceipts({ workspaceSlug: TENANT })).toEqual([expect.objectContaining({ status: "succeeded", mode: "assistant", actionKey: "gmail.send.email" })]);
    const audit = f.store.listAudit({ workspaceSlug: TENANT, limit: 200 }) as Array<{ event_type: string; metadata: string }>;
    expect(audit.some((row) => row.event_type === "marketplace.governance.owner_approved" && row.metadata.includes('"basis":"assistant-mode"'))).toBe(true);
  });

  it("switching Assistant -> System holds the next call; a hold made under System stays held after switching to Assistant", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    const grantId = await f.grant("agent-1", pluginId, "gmail.send.email");
    // Under System: held with key K.
    const held = await f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput, "held-key-0001");
    expect(held.statusCode).toBe(202);
    await f.setMode("agent-1", { mode: "assistant" });
    // The same key after switching to Assistant: still the same held call, nothing sent.
    const retry = await f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput, "held-key-0001");
    expect(retry.statusCode).toBe(202);
    expect(retry.json().approvalId).toBe(held.json().approvalId);
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)?.state).toBe("pending");
    expect(f.executions).toEqual([]);
    // A new call runs under Assistant.
    expect((await f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput)).statusCode).toBe(200);
    // Back to System: the next call waits.
    await f.setMode("agent-1", { mode: "system" });
    expect((await f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput)).statusCode).toBe(202);
    expect(f.executions).toHaveLength(1);
  });

  it("never widens the consent: an observe consent cannot run a dispatch/outward tool in Assistant mode", async () => {
    const f = await modes({ capabilities: ["connector.observe"] });
    const pluginId = await gmail(f);
    await f.setMode("agent-1", { mode: "assistant" });
    f.consent(pluginId, "gmail.send.email", "connector.observe", "consent-observe-send");
    const response = await f.toolsCall({ consentId: "consent-observe-send", toolkit: pluginId, action: "gmail.send.email", arguments: sendInput }, "observe-key-0001");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "runtime_connection_unavailable" });
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: f.agent("agent-1"),
      payload: { workspaceSlug: TENANT, pluginId, actionKey: "gmail.send.email", accountId: "ca_1", resourceKind: "gmail.connected-account", resourceRef: "account:ca_1" },
    });
    expect(grant.statusCode).not.toBe(201);
    expect(f.executions).toEqual([]);
  });

  it("runs on a Portal dispatch consent (marketplace.tools.call) in Assistant mode; a replay counts once", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    await f.setMode("agent-1", { mode: "assistant", dailyCap: 2 });
    f.consent(pluginId, "gmail.send.email", "connector.dispatch", "consent-send");
    const body = { consentId: "consent-send", toolkit: pluginId, action: "gmail.send.email", arguments: sendInput };
    const first = await f.toolsCall(body, "replay-key-0001");
    expect(first.statusCode, first.body).toBe(200);
    const replay = await f.toolsCall(body, "replay-key-0001");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(f.executions).toHaveLength(1);
    expect(f.store.agentModes.usedToday(TENANT, "agent-1", new Date().toISOString().slice(0, 10)).total).toBe(1);
    expect((await f.toolsCall(body, "replay-key-0002")).statusCode).toBe(200);
    const over = await f.toolsCall(body, "replay-key-0003");
    expect(over.statusCode).toBe(202);
    expect(over.json()).toMatchObject({ heldBecause: "cap_agent" });
    expect(f.executions).toHaveLength(2);
  });
});

describe("sensitive actions stay held in Assistant mode", () => {
  it("holds one sample per family, admin-by-name tools and curated destructive tools; GMAIL_SEND_EMAIL runs", async () => {
    const f = await modes();
    await f.setMode("agent-1", { mode: "assistant" });
    const cases: Array<[string, string, string, string]> = [
      ["gmail", "GMAIL_TRASH_MESSAGE", "gmail.trash.message", "sensitive:destructive"],
      ["stripe", "STRIPE_CREATE_REFUND", "stripe.create.refund", "sensitive:money"],
      ["gmail", "GMAIL_FORWARD_MESSAGE", "gmail.forward.message", "sensitive:access-sharing"],
      ["slack", "SLACK_BROADCAST_MESSAGE", "slack.broadcast.message", "sensitive:bulk"],
      // Admin by name (DELETE): destructive.
      ["gmail", "GMAIL_DELETE_MESSAGE", "gmail.delete.message", "destructive"],
      // Curated: outward (it notifies attendees) and destructive.
      ["googlecalendar", "GOOGLECALENDAR_DELETE_EVENT", "googlecalendar.delete.event", "destructive"],
    ];
    await gmail(f);
    for (const [toolkit, slug, actionKey, reason] of cases) {
      const pluginId = await f.importToolkit(toolkit, [slug]);
      const grantId = await f.grant("agent-1", pluginId, actionKey);
      const response = await f.call("agent-1", pluginId, actionKey, grantId, { id: "x1", send_updates: "all" });
      expect(response.statusCode, `${slug}: ${response.body}`).toBe(202);
      expect(response.json(), slug).toMatchObject({ status: "approval_pending", heldBecause: reason });
    }
    expect(f.executions).toEqual([]);
    const sendGrant = await f.grant("agent-1", "gmail-composio", "gmail.send.email");
    expect((await f.call("agent-1", "gmail-composio", "gmail.send.email", sendGrant, sendInput)).statusCode).toBe(200);
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_SEND_EMAIL"]);
  });
});

describe("daily limits", () => {
  it("is atomic: 20 parallel calls with a cap of 5 run exactly 5 and hold 15", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    await f.setMode("agent-1", { mode: "assistant", dailyCap: 5 });
    const grantId = await f.grant("agent-1", pluginId, "gmail.send.email");
    const responses = await Promise.all(Array.from({ length: 20 }, () => f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput)));
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(5);
    const held = responses.filter((response) => response.statusCode === 202);
    expect(held).toHaveLength(15);
    expect(held.every((response) => response.json().heldBecause === "cap_agent")).toBe(true);
    expect(f.executions).toHaveLength(5);
    expect(f.store.listCompanyBoxApprovals({ workspaceSlug: TENANT, state: "pending" })).toHaveLength(15);
  });

  it("holds at the agent and per-connector boundaries and resets at 00:00 UTC", async () => {
    const now = { value: new Date("2026-10-11T23:59:00.000Z") };
    const f = await modes({ now });
    const gmailId = await gmail(f);
    const slackId = await f.importToolkit("slack", ["SLACK_SEND_MESSAGE"]);
    await f.setMode("agent-1", { mode: "assistant", dailyCap: 3, connectorDailyCap: 2 });
    const send = await f.grant("agent-1", gmailId, "gmail.send.email");
    const slack = await f.grant("agent-1", slackId, "slack.send.message");
    expect((await f.call("agent-1", gmailId, "gmail.send.email", send, sendInput)).statusCode).toBe(200);
    expect((await f.call("agent-1", gmailId, "gmail.send.email", send, sendInput)).statusCode).toBe(200);
    const connectorCap = await f.call("agent-1", gmailId, "gmail.send.email", send, sendInput);
    expect(connectorCap.statusCode).toBe(202);
    expect(connectorCap.json().heldBecause).toBe("cap_connector");
    expect((await f.call("agent-1", slackId, "slack.send.message", slack, { channel: "#ops", text: "hi" })).statusCode).toBe(200);
    const agentCap = await f.call("agent-1", slackId, "slack.send.message", slack, { channel: "#ops", text: "hi" });
    expect(agentCap.statusCode).toBe(202);
    expect(agentCap.json().heldBecause).toBe("cap_agent");
    expect((await f.overview()).agents[0]).toMatchObject({ today: { day: "2026-10-11", executed: 3, byConnector: { [gmailId]: 2, [slackId]: 1 } } });
    now.value = new Date("2026-10-12T00:00:00.000Z");
    expect((await f.call("agent-1", gmailId, "gmail.send.email", send, sendInput)).statusCode).toBe(200);
    expect(f.executions).toHaveLength(4);
  });
});

describe("kill switch", () => {
  it("refuses a paused agent's calls before any provider call, reads included, and an agent cannot lift it", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    await f.setMode("agent-1", { mode: "assistant" });
    const send = await f.grant("agent-1", pluginId, "gmail.send.email");
    f.consent(pluginId, "gmail.send.email", "connector.dispatch", "consent-send");
    expect((await f.ownerPost("/api/marketplace/agents/agent-1/pause")).statusCode).toBe(200);
    const paused = await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput);
    expect(paused.statusCode).toBe(403);
    expect(paused.json()).toMatchObject({ error: "agent_paused" });
    const viaConsent = await f.toolsCall({ consentId: "consent-send", toolkit: pluginId, action: "gmail.send.email", arguments: sendInput }, "paused-key-0001");
    expect(viaConsent.statusCode).toBe(403);
    expect(viaConsent.json()).toMatchObject({ error: "agent_paused" });
    // Agents cannot lift it: owner-only operation for app grants, refused for the service bearer + agent headers.
    expect((await f.ownerPost("/api/marketplace/agents/agent-1/resume", { authorization: `Bearer ${APP_GRANT}` })).statusCode).toBe(403);
    expect((await f.ownerPost("/api/marketplace/agents/agent-1/resume", f.agent("agent-1"))).statusCode).toBe(403);
    expect(f.store.agentModes.pauseState(TENANT, "agent-1")).toBe("agent");
    // Other agents keep working; "Pause all" stops them too.
    const other = await f.grant("agent-2", pluginId, "gmail.send.email");
    expect((await f.call("agent-2", pluginId, "gmail.send.email", other, sendInput)).statusCode).toBe(202);
    expect((await f.ownerPost("/api/marketplace/agents/pause-all")).json()).toMatchObject({ pausedAll: true });
    expect((await f.call("agent-2", pluginId, "gmail.send.email", other, sendInput)).json()).toMatchObject({ error: "agent_paused", pausedBy: "all_agents" });
    expect(f.executions).toEqual([]);
    expect((await f.ownerPost("/api/marketplace/agents/resume-all")).json()).toMatchObject({ pausedAll: false });
    expect((await f.ownerPost("/api/marketplace/agents/agent-1/resume")).statusCode).toBe(200);
    expect((await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput)).statusCode).toBe(200);
    const audit = (f.store.listAudit({ workspaceSlug: TENANT, limit: 200 }) as Array<{ event_type: string }>).map((row) => row.event_type);
    expect(audit).toEqual(expect.arrayContaining(["marketplace.agent.paused", "marketplace.agent.resumed", "marketplace.agents.paused_all", "marketplace.agents.resumed_all"]));
  });

  it("holds back a call approved while paused (refused at execution time) and runs it after resume", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    const send = await f.grant("agent-1", pluginId, "gmail.send.email");
    const held = await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput);
    expect(held.statusCode).toBe(202);
    await f.ownerPost("/api/marketplace/agents/pause-all");
    const approveWhilePaused = await f.approve(held.json().approvalId);
    expect(approveWhilePaused.statusCode).toBe(403);
    expect(approveWhilePaused.json()).toMatchObject({ error: "agent_paused" });
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)?.state).toBe("pending");
    expect(f.executions).toEqual([]);
    await f.ownerPost("/api/marketplace/agents/resume-all");
    expect((await f.approve(held.json().approvalId)).json()).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    expect(f.executions).toHaveLength(1);
  });

  it("persists across a restart on the same data directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-agent-modes-restart-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await modes({ root });
    const pluginId = await gmail(first);
    await first.setMode("agent-1", { mode: "assistant" });
    await first.ownerPost("/api/marketplace/agents/agent-1/pause");
    await first.ownerPost("/api/marketplace/agents/pause-all");
    await first.app.close();
    first.store.close();
    const second = await modes({ root });
    expect(second.store.agentModes.getSetting(TENANT, "agent-1")).toMatchObject({ mode: "assistant", paused: true });
    expect(second.store.agentModes.isPausedAll(TENANT)).toBe(true);
    const send = await second.grant("agent-1", pluginId, "gmail.send.email");
    const afterRestart = await second.call("agent-1", pluginId, "gmail.send.email", send, sendInput);
    expect(afterRestart.statusCode).toBe(403);
    expect(afterRestart.json()).toMatchObject({ error: "agent_paused" });
    expect(second.executions).toEqual([]);
  });
});

describe("receipts", () => {
  it("writes one redacted receipt per Assistant execution, failed calls included, visible to the owner only", async () => {
    const f = await modes({ failTools: ["SLACK_SEND_MESSAGE"] });
    const gmailId = await gmail(f);
    const slackId = await f.importToolkit("slack", ["SLACK_SEND_MESSAGE"]);
    await f.setMode("agent-1", { mode: "assistant" });
    const send = await f.grant("agent-1", gmailId, "gmail.send.email");
    const slack = await f.grant("agent-1", slackId, "slack.send.message");
    const ok = await f.call("agent-1", gmailId, "gmail.send.email", send, { ...sendInput, api_key: FAKE_SECRET, body: `token ${FAKE_SECRET}`, signature: FAKE_SECRET });
    expect(ok.statusCode, ok.body).toBe(200);
    const failed = await f.call("agent-1", slackId, "slack.send.message", slack, { channel: "#ops", text: FAKE_SECRET });
    expect(failed.statusCode).toBe(502);
    const receipts = f.store.agentModes.listReceipts({ workspaceSlug: TENANT });
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.status).sort()).toEqual(["failed", "succeeded"]);
    const listed = await f.app.inject({ method: "GET", url: "/api/marketplace/agents/receipts", headers: f.owner });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(FAKE_SECRET);
    const audit = f.receiptAudit();
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(FAKE_SECRET);
    expect(audit.find((entry) => entry.status === "succeeded")).toMatchObject({
      agentId: "agent-1",
      pluginId: gmailId,
      provider: "gmail",
      account: "ca_1",
      actionKey: "gmail.send.email",
      destination: "recipient_email: client@example.invalid",
      mode: "assistant",
      argumentsPreview: expect.stringContaining('"api_key":"[redacted]"'),
    });
    expect(audit.find((entry) => entry.status === "failed")).toMatchObject({ actionKey: "slack.send.message", destination: "channel: #ops", mode: "assistant" });
    // Receipts appear in Activity (the owner's audit view).
    const activity = await f.app.inject({ method: "GET", url: `/api/marketplace/audit?workspaceSlug=${TENANT}`, headers: f.owner });
    expect(activity.statusCode, activity.body).toBe(200);
    expect(activity.body).toContain("marketplace.agent.outward.receipt");
    expect(activity.body).not.toContain(FAKE_SECRET);
    // Agents cannot read, write, edit or delete receipts: no agent operation exists for them.
    for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
      const attempt = await f.app.inject({ method, url: "/api/marketplace/agents/receipts", headers: { authorization: `Bearer ${APP_GRANT}` }, ...(method === "GET" || method === "DELETE" ? {} : { payload: { status: "succeeded" } }) });
      expect(attempt.statusCode, method).toBeGreaterThanOrEqual(403);
      expect(attempt.statusCode, method).toBeLessThan(500);
    }
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const attempt = await f.app.inject({ method, url: `/api/marketplace/agents/receipts`, headers: f.agent("agent-1"), ...(method === "DELETE" ? {} : { payload: {} }) });
      // No write route exists (404); PATCH reaches the owner-only agent setting route and is refused there.
      expect([403, 404], method).toContain(attempt.statusCode);
    }
    expect(f.store.agentModes.listReceipts({ workspaceSlug: TENANT })).toHaveLength(2);
  });
});

describe("agent-facing description", () => {
  it("says per outward tool whether it runs (Assistant) or waits (System, sensitive, limits) and what applies to this agent", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    const listing = await f.app.inject({ method: "GET", url: `/api/agent/capabilities?workspaceSlug=${TENANT}`, headers: f.service });
    const tools = (listing.json().capabilities as Array<Record<string, unknown>>).filter((tool) => tool.pluginId === pluginId);
    expect(tools.find((tool) => tool.actionType === "gmail.send.email")).toMatchObject({ approval: { system: "waits", assistant: "runs" } });
    expect(tools.find((tool) => tool.actionType === "gmail.trash.message")).toMatchObject({ approval: { system: "waits", assistant: "waits", waitsBecause: "sensitive:destructive" } });
    const grantId = await f.grant("agent-1", pluginId, "gmail.send.email");
    const forAgent = async () =>
      (await f.app.inject({ method: "GET", url: `/api/agent/capabilities?workspaceSlug=${TENANT}&grantId=${grantId}`, headers: f.agent("agent-1") })).json();
    expect(await forAgent()).toMatchObject({ agent: { approvalMode: "system", paused: false }, capabilities: [expect.objectContaining({ forThisAgent: "waits" })] });
    await f.setMode("agent-1", { mode: "assistant" });
    expect(await forAgent()).toMatchObject({ agent: { approvalMode: "assistant" }, capabilities: [expect.objectContaining({ forThisAgent: "runs" })] });
    await f.ownerPost("/api/marketplace/agents/agent-1/pause");
    expect(await forAgent()).toMatchObject({ agent: { paused: true }, capabilities: [expect.objectContaining({ forThisAgent: "refused: agent_paused" })] });
    await f.ownerPost("/api/marketplace/agents/agent-1/resume");
    const guidance = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/guidance/1", headers: { authorization: `Bearer ${APP_GRANT}` } });
    expect(guidance.statusCode).toBe(200);
    expect(guidance.body).toContain("## Your approval mode");
    expect(guidance.body).toContain("Assistant: your outward actions run at once");
  });
});

describe("Rules mode is unchanged", () => {
  it("lets Rules decide outward calls whatever the agent's mode; no Assistant receipts", async () => {
    const f = await modes({ rules: "allow" });
    const pluginId = await gmail(f);
    await f.setMode("agent-1", { mode: "system" });
    const grantId = await f.grant("agent-1", pluginId, "gmail.send.email");
    const response = await f.call("agent-1", pluginId, "gmail.send.email", grantId, sendInput);
    expect(response.statusCode, response.body).toBe(200);
    expect(f.rulesCalls.at(-1)).toMatchObject({ operation: "execute", payload: { risk: { outward: true } } });
    expect(f.store.listCompanyBoxApprovals({ workspaceSlug: TENANT })).toEqual([]);
    expect(f.store.agentModes.listReceipts({ workspaceSlug: TENANT })).toEqual([]);
    const denied = await modes({ rules: "deny" });
    const deniedPlugin = await gmail(denied);
    await denied.setMode("agent-1", { mode: "assistant" });
    const deniedGrant = await denied.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: denied.agent("agent-1"),
      payload: { workspaceSlug: TENANT, pluginId: deniedPlugin, actionKey: "gmail.send.email", accountId: "ca_1", resourceKind: "gmail.connected-account", resourceRef: "account:ca_1" },
    });
    if (deniedGrant.statusCode === 201) {
      // Assistant mode does not override a Rules denial.
      const refused = await denied.call("agent-1", deniedPlugin, "gmail.send.email", deniedGrant.json().grant.id, sendInput);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: "rules_denied" });
    } else {
      expect(deniedGrant.statusCode).toBe(403);
    }
    expect(denied.executions).toEqual([]);
    expect(denied.store.agentModes.listReceipts({ workspaceSlug: TENANT })).toEqual([]);
  });
});

describe("reusable interface (agent-approval-mode.ts, for Channels)", () => {
  it("decides, reserves, commits or releases and writes receipts with the real store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-approval-mode-api-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
    cleanups.push(() => store.close());
    const ref = { workspaceSlug: TENANT, agentId: "agent-c" };
    const now = new Date("2026-10-11T10:00:00.000Z");
    const outward = { outward: true, destructive: false, sensitive: false };
    const decide = (extra: Partial<Parameters<typeof decideOutward>[1]> = {}) =>
      decideOutward(store, { ...ref, connectorKey: "telegram", actionKey: "channels.post", risk: outward, now, ...extra });
    expect(getAgentApprovalMode(store, ref)).toBe("system");
    expect(isAgentPaused(store, ref)).toEqual({ paused: false, scope: null });
    expect(decide()).toEqual({ kind: "hold", reason: "system_mode" });
    expect(decide({ risk: { outward: false, destructive: true, sensitive: true } })).toEqual({ kind: "run", reason: "not_outward" });
    store.agentModes.updateSetting({ ...ref, mode: "assistant", dailyCap: 2, actor: "operator:owner-1", now });
    expect(decide({ risk: { ...outward, sensitive: true } })).toEqual({ kind: "hold", reason: "sensitive" });
    expect(decide({ risk: { ...outward, destructive: true } })).toEqual({ kind: "hold", reason: "destructive" });
    // A released reservation (never reached the provider) does not count; a failed one does.
    const first = decide({ replayKey: "post-1" });
    expect(first).toMatchObject({ kind: "run", reason: "assistant", capReservation: expect.any(String) });
    releaseCapReservation(store, { reservationId: first.capReservation!, now });
    const second = decide({ replayKey: "post-2" });
    commitCapReservation(store, { reservationId: second.capReservation!, status: "failed", error: "provider_error", now });
    writeOutwardReceipt(store, { ...ref, connectorKey: "telegram", accountRef: "chat-1", actionKey: "channels.post", argumentsPreview: "{}", status: "failed", mode: "assistant", policyId: "grant-1", reservationId: second.capReservation!, now });
    expect(decide({ replayKey: "post-2" })).toMatchObject({ kind: "run", replay: true, capReservation: second.capReservation });
    const third = decide({ replayKey: "post-3" });
    commitCapReservation(store, { reservationId: third.capReservation!, status: "ok", now });
    expect(store.agentModes.usedToday(TENANT, "agent-c", "2026-10-11").total).toBe(2);
    expect(decide({ replayKey: "post-4" })).toEqual({ kind: "hold", reason: "cap_agent" });
    expect(decide({ now: new Date("2026-10-12T00:00:00.000Z"), replayKey: "post-5" })).toMatchObject({ kind: "run" });
    // Without a reservation the receipt is recorded as a finished, counted row.
    writeOutwardReceipt(store, { ...ref, connectorKey: "discord", accountRef: null, actionKey: "channels.react", argumentsPreview: "{}", status: "ok", mode: "assistant", now });
    const audit = (store.listAudit({ workspaceSlug: TENANT, limit: 20 }) as Array<{ event_type: string; metadata: string }>).filter((row) => row.event_type === "marketplace.agent.outward.receipt");
    expect(audit.map((row) => JSON.parse(row.metadata))).toEqual(expect.arrayContaining([expect.objectContaining({ policyId: "grant-1", status: "failed" }), expect.objectContaining({ pluginId: "discord", status: "succeeded" })]));
    store.agentModes.setPausedAll({ workspaceSlug: TENANT, paused: true, actor: "operator:owner-1", now });
    expect(isAgentPaused(store, ref)).toEqual({ paused: true, scope: "global" });
    expect(decide({ risk: { outward: false, destructive: false, sensitive: false } })).toEqual({ kind: "refuse", reason: "paused" });
  });
});

describe("hold families are owner settings", () => {
  it("start ON for a fresh workspace; only the owner turns one off (audited); then that verb runs in Assistant with a receipt", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    expect(getHoldFamilies(f.store, TENANT).map((family) => [family.id, family.on])).toEqual([
      ["destructive", true], ["money", true], ["access-sharing", true], ["bulk", true], ["first-contact-dm", true], ["live-session-grant", true],
    ]);
    expect((await f.overview()).holdFamilies).toHaveLength(6);
    const accessTokenLogin = f.sessions.exchange("operator-access-token", "static-operator");
    for (const [label, headers] of [
      ["agent app grant", { authorization: `Bearer ${APP_GRANT}` }],
      ["service bearer", f.agent("agent-1")],
      ["Portal runtime lease", { authorization: "Bearer portal-runtime-lease-token" }],
      ["static operator access token", { origin: "http://localhost", cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${accessTokenLogin.token}`, "x-csrf-token": accessTokenLogin.status.csrfToken! }],
    ] as Array<[string, Record<string, string>]>) {
      const response = await f.setFamily("access-sharing", false, headers);
      expect(response.statusCode, label).toBeGreaterThanOrEqual(401);
      expect(response.statusCode, label).toBeLessThan(500);
    }
    expect(getHoldFamilies(f.store, TENANT).find((family) => family.id === "access-sharing")?.on).toBe(true);
    expect((await f.setFamily("not-a-family", false)).statusCode).toBe(400);
    // Destructive and money always wait: not owner-overridable.
    for (const locked of ["destructive", "money"]) {
      const response = await f.setFamily(locked, false);
      expect(response.statusCode, locked).toBe(400);
      expect(response.json()).toMatchObject({ error: "hold_family_locked" });
    }

    await f.setMode("agent-1", { mode: "assistant" });
    const forward = await f.grant("agent-1", pluginId, "gmail.forward.message");
    expect((await f.call("agent-1", pluginId, "gmail.forward.message", forward, { id: "m1", to: "a@example.invalid" })).json()).toMatchObject({ heldBecause: "sensitive:access-sharing" });
    const off = await f.setFamily("access-sharing", false);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().holdFamilies.find((family: { id: string }) => family.id === "access-sharing")).toMatchObject({ on: false, updatedBy: "operator:owner-1" });
    const audit = f.store.listAudit({ workspaceSlug: TENANT, limit: 50 }) as Array<{ event_type: string; actor_id: string; metadata: string }>;
    expect(audit.find((row) => row.event_type === "marketplace.agent.hold_family.changed")).toMatchObject({ actor_id: "operator:owner-1" });
    expect(JSON.parse(audit.find((row) => row.event_type === "marketplace.agent.hold_family.changed")!.metadata)).toMatchObject({ familyId: "access-sharing", from: null, to: false });
    const ran = await f.call("agent-1", pluginId, "gmail.forward.message", forward, { id: "m1", to: "a@example.invalid" });
    expect(ran.statusCode, ran.body).toBe(200);
    expect(f.receiptAudit()).toEqual([expect.objectContaining({ actionKey: "gmail.forward.message", status: "succeeded", mode: "assistant" })]);
    // Destructive words stay held (locked family), and so does destructive-by-name (connector.admin).
    const trash = await f.grant("agent-1", pluginId, "gmail.trash.message");
    expect((await f.call("agent-1", pluginId, "gmail.trash.message", trash, { id: "m1" })).json()).toMatchObject({ heldBecause: "sensitive:destructive" });
    const del = await f.grant("agent-1", pluginId, "gmail.delete.message");
    expect((await f.call("agent-1", pluginId, "gmail.delete.message", del, { id: "m1" })).json()).toMatchObject({ heldBecause: "destructive" });
    // System mode ignores families.
    await f.setMode("agent-1", { mode: "system" });
    expect((await f.call("agent-1", pluginId, "gmail.forward.message", forward, { id: "m2" })).json()).toMatchObject({ heldBecause: "system_mode" });
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_FORWARD_MESSAGE"]);
  });

  it("holds a caller-declared family while it is ON and runs it once the owner turns it off", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-hold-families-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
    cleanups.push(() => store.close());
    const now = new Date("2026-10-11T10:00:00.000Z");
    store.agentModes.updateSetting({ workspaceSlug: TENANT, agentId: "agent-d", mode: "assistant", actor: "operator:owner-1", now });
    const input = { workspaceSlug: TENANT, agentId: "agent-d", connectorKey: "telegram", actionKey: "channels.dm", risk: { outward: true, destructive: false, sensitive: false }, now, families: ["first-contact-dm"] };
    expect(decideOutward(store, input)).toEqual({ kind: "hold", reason: "sensitive", family: "first-contact-dm" });
    expect(assistantHold(store, { workspaceSlug: TENANT, risk: input.risk, families: ["live-session-grant"] })).toEqual({ reason: "sensitive", family: "live-session-grant" });
    store.agentModes.setFamily({ workspaceSlug: TENANT, familyId: "first-contact-dm", enabled: false, actor: "operator:owner-1", now });
    expect(decideOutward(store, input)).toMatchObject({ kind: "run", reason: "assistant" });
    // Another workspace keeps its default (ON).
    expect(decideOutward(store, { ...input, workspaceSlug: "other", agentId: "agent-d" })).toEqual({ kind: "hold", reason: "system_mode" });
    expect(getHoldFamilies(store, "other").every((family) => family.on)).toBe(true);
  });
});

describe("Portal agentPolicy claim (source of truth; local setting is the temporary fallback)", () => {
  const policy = (extra: Record<string, unknown> = {}) => ({ v: 1, approvalMode: "assistant", paused: false, rev: 1, ...extra });

  it("parses exactly: v/rev/type errors and unknown modes are system, paused only when true, destructive/money ignored", async () => {
    const { parseAgentPolicy } = await import("./agent-approval-mode.js");
    expect(parseAgentPolicy(undefined)).toBeNull();
    expect(parseAgentPolicy(policy())).toEqual({ approvalMode: "assistant", paused: false, holdFamilies: {}, rev: 1 });
    expect(parseAgentPolicy(policy({ x: 1, holdFamilies: { bulk: false, destructive: false, money: false, nope: false } }))).toEqual({ approvalMode: "assistant", paused: false, holdFamilies: { bulk: false }, rev: 1 });
    for (const bad of [null, "assistant", [], policy({ v: 2 }), policy({ v: undefined }), policy({ rev: -1 }), policy({ rev: 1.5 }), policy({ rev: "1" }), policy({ approvalMode: "boss" }), policy({ approvalMode: 1 }), policy({ paused: "no" }), policy({ holdFamilies: [] })]) {
      expect(parseAgentPolicy(bad)?.approvalMode, JSON.stringify(bad)).toBe("system");
    }
    expect(parseAgentPolicy(policy({ paused: true }))?.paused).toBe(true);
    expect(parseAgentPolicy(policy({ paused: "yes" }))?.paused).toBe(false);
    expect(parseAgentPolicy({ v: 1, approvalMode: "assistant", rev: 0 })?.paused).toBe(false);
  });

  it("claim present: the stricter of claim and local; claim absent: local; paused claim refuses; stale rev is system", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    const grantFor = (agentId: string) => f.grant(agentId, pluginId, "gmail.send.email");
    const send = async (agentId: string, grantId: string) => (await f.call(agentId, pluginId, "gmail.send.email", grantId, sendInput));

    // claim assistant + no local setting -> assistant (runs)
    f.policies.set("a1", policy());
    expect((await send("a1", await grantFor("a1"))).statusCode).toBe(200);
    // claim assistant + local system -> system (the local setting can only tighten)
    f.policies.set("a2", policy());
    await f.setMode("a2", { mode: "system" });
    expect((await send("a2", await grantFor("a2"))).json()).toMatchObject({ heldBecause: "system_mode" });
    // claim system + local assistant -> system
    f.policies.set("a3", policy({ approvalMode: "system" }));
    await f.setMode("a3", { mode: "assistant" });
    expect((await send("a3", await grantFor("a3"))).json()).toMatchObject({ heldBecause: "system_mode" });
    // claim absent -> local (assistant runs)
    await f.setMode("a4", { mode: "assistant" });
    expect((await send("a4", await grantFor("a4"))).statusCode).toBe(200);
    // invalid claim value -> system, even with local assistant
    f.policies.set("a5", policy({ approvalMode: "boss" }));
    await f.setMode("a5", { mode: "assistant" });
    expect((await send("a5", await grantFor("a5"))).json()).toMatchObject({ heldBecause: "system_mode" });
    // paused claim -> refused before any provider call, whatever the local setting
    const g6 = await grantFor("a6");
    f.policies.set("a6", policy({ paused: true }));
    const paused = await send("a6", g6);
    expect(paused.statusCode).toBe(403);
    expect(paused.json()).toMatchObject({ error: "agent_paused", pausedBy: "portal" });
    // stale revision -> system for that call; the newer one runs again
    const g7 = await grantFor("a7");
    f.policies.set("a7", policy({ rev: 5 }));
    expect((await send("a7", g7)).statusCode).toBe(200);
    f.policies.set("a7", policy({ rev: 4 }));
    expect((await send("a7", g7)).json()).toMatchObject({ heldBecause: "system_mode" });
    f.policies.set("a7", policy({ rev: 6 }));
    expect((await send("a7", g7)).statusCode).toBe(200);
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL"]);
    // The verified agent sees its effective mode.
    const caps = await f.app.inject({ method: "GET", url: `/api/agent/capabilities?workspaceSlug=${TENANT}&grantId=${g7}`, headers: f.agent("a7") });
    expect(caps.json()).toMatchObject({ agent: { approvalMode: "assistant" } });
  });

  it("claim holdFamilies only loosen together with the local setting; locked families ignore the claim", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    f.policies.set("agent-1", policy({ holdFamilies: { "access-sharing": false, destructive: false } }));
    const forward = await f.grant("agent-1", pluginId, "gmail.forward.message");
    const trash = await f.grant("agent-1", pluginId, "gmail.trash.message");
    // Local default (ON) is stricter than the claim's off: still held.
    expect((await f.call("agent-1", pluginId, "gmail.forward.message", forward, { id: "m1" })).json()).toMatchObject({ heldBecause: "sensitive:access-sharing" });
    await f.setFamily("access-sharing", false);
    expect((await f.call("agent-1", pluginId, "gmail.forward.message", forward, { id: "m1" })).statusCode).toBe(200);
    expect((await f.call("agent-1", pluginId, "gmail.trash.message", trash, { id: "m1" })).json()).toMatchObject({ heldBecause: "sensitive:destructive" });
  });

  it("reads the claim from the lease on the consented-call path (runtime receiver)", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    f.consent(pluginId, "gmail.send.email", "connector.dispatch", "consent-lease");
    const body = (key: string) => ({
      schema: 1,
      consentId: "consent-lease",
      selection: { pluginId, actionKey: "gmail.send.email", accountId: "ca_1", resourceKind: "gmail.connected-account", resourceRef: "account:ca_1", capability: "connector.dispatch" },
      input: sendInput,
      idempotencyKey: key,
    });
    const lease = (key: string) => f.app.inject({ method: "POST", url: "/api/marketplace/v1/runtime/composio/execute", headers: { authorization: "Bearer portal-lease-token" }, payload: body(key) });
    expect((await lease("lease-key-0001")).statusCode).toBe(202);
    f.policies.set("agent-1", policy({ rev: 2 }));
    const ran = await lease("lease-key-0002");
    expect(ran.statusCode, ran.body).toBe(200);
    f.policies.set("agent-1", policy({ rev: 3, paused: true }));
    const pausedLease = await lease("lease-key-0003");
    expect(pausedLease.statusCode).toBe(403);
    expect(pausedLease.json()).toMatchObject({ error: "agent_paused" });
    expect(f.executions).toHaveLength(1);
  });
});

describe("runtime tool slug (QA pre-GO)", () => {
  it("classifies the slug the executor sends to /tools/execute/<SLUG>, never the arguments; an unnamed tool is held", async () => {
    const f = await modes();
    await f.setMode("agent-1", { mode: "assistant" });
    const acme = await f.importToolkit("acme", ["ACME_SEND_MONEY", "ACME_ADD_MEMBER", "ACME_BULK_DELETE"]);
    for (const [actionKey, slug, heldBecause] of [
      ["acme.send.money", "ACME_SEND_MONEY", "sensitive:money"],
      ["acme.add.member", "ACME_ADD_MEMBER", "sensitive:access-sharing"],
      // DELETE makes it admin by name, which is checked before the bulk family.
      ["acme.bulk.delete", "ACME_BULK_DELETE", "destructive"],
    ] as const) {
      const grantId = await f.grant("agent-1", acme, actionKey);
      const held = await f.call("agent-1", acme, actionKey, grantId, { amount: 5 });
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json()).toMatchObject({ heldBecause });
      // The hold record carries the runtime slug.
      expect(f.store.getCompanyBoxApproval(held.json().approvalId)?.toolSlug).toBe(slug);
    }
    expect(f.executions).toEqual([]);

    const gmailId = await gmail(f);
    const send = await f.grant("agent-1", gmailId, "gmail.send.email");
    // An argument naming another tool changes nothing: the slug comes from the listing, as the executor reads it.
    const ran = await f.call("agent-1", gmailId, "gmail.send.email", send, { ...sendInput, tool_slug: "GMAIL_DELETE_MESSAGE", toolName: "GMAIL_DELETE_MESSAGE" });
    expect(ran.statusCode, ran.body).toBe(200);
    expect(ran.json().receipt).toMatchObject({ toolSlug: "GMAIL_SEND_EMAIL", status: "succeeded" });
    expect(f.executions.map((execution) => execution.tool)).toEqual(["GMAIL_SEND_EMAIL"]);
    expect(f.receiptAudit()).toEqual([expect.objectContaining({ toolSlug: "GMAIL_SEND_EMAIL", actionKey: "gmail.send.email" })]);
    expect(f.store.agentModes.listReceipts({ workspaceSlug: TENANT })[0]).toMatchObject({ toolSlug: "GMAIL_SEND_EMAIL" });

    // A listing imported without tools stores the generic `<toolkit>.tool.execute`: no tool slug, so it is held.
    const generic = await f.importToolkit("acmegeneric", []);
    expect(f.store.getListing(generic)?.actions).toEqual(["acmegeneric.tool.execute"]);
    const genericGrant = await f.grant("agent-1", generic, "acmegeneric.tool.execute");
    const missing = await f.call("agent-1", generic, "acmegeneric.tool.execute", genericGrant, { tool_slug: "ACMEGENERIC_SEND_EMAIL", text: "hi" });
    expect(missing.statusCode, missing.body).toBe(202);
    expect(missing.json()).toMatchObject({ heldBecause: "tool_slug_unknown" });
    expect(f.store.getCompanyBoxApproval(missing.json().approvalId)?.toolSlug).toBe("acmegeneric.tool.execute");
    const caps = (await f.app.inject({ method: "GET", url: `/api/agent/capabilities?workspaceSlug=${TENANT}`, headers: f.service })).json().capabilities as Array<Record<string, unknown>>;
    expect(caps.find((tool) => tool.actionType === "acmegeneric.tool.execute")).toMatchObject({ approval: { assistant: "waits", waitsBecause: "tool_slug_unknown" } });
    expect(f.executions).toHaveLength(1);
  });

  it("does not run an approved hold whose listing now maps the action to another tool", async () => {
    const f = await modes();
    const gmailId = await gmail(f);
    const send = await f.grant("agent-1", gmailId, "gmail.send.email");
    const held = await f.call("agent-1", gmailId, "gmail.send.email", send, sendInput);
    expect(held.statusCode).toBe(202);
    const listing = f.store.getListing(gmailId)!;
    const composio = listing.manifest.composio as { tools: Array<Record<string, unknown>> };
    f.store.upsertListing({
      ...listing,
      manifest: { ...listing.manifest, composio: { ...composio, tools: composio.tools.map((tool) => (tool.action === "gmail.send.email" ? { ...tool, toolName: "GMAIL_SEND_TO_EVERYONE" } : tool)) } },
    });
    const approved = await f.approve(held.json().approvalId);
    expect(approved.json()).toMatchObject({ ok: false, approval: { state: "failed", error: "approval_target_changed", toolSlug: "GMAIL_SEND_EMAIL" } });
    expect(f.executions).toEqual([]);
  });
});

describe("contract alignment (approval-mode API)", () => {
  const policy = (extra: Record<string, unknown> = {}) => ({ v: 1, approvalMode: "system", paused: false, rev: 1, ...extra });

  it("re-checks an approved held call against a fresh (<= 60 s) policy read; stale or paused does not run", async () => {
    const now = { value: new Date("2026-10-11T10:00:00.000Z") };
    const f = await modes({ now });
    const pluginId = await gmail(f);
    f.policies.set("agent-1", policy());
    const send = await f.grant("agent-1", pluginId, "gmail.send.email");
    // System (claim): held; the call is a verified policy read at 10:00:00.
    const first = await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput, "fresh-key-0001");
    expect(first.statusCode).toBe(202);
    now.value = new Date("2026-10-11T10:00:30.000Z");
    expect((await f.approve(first.json().approvalId)).json()).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    expect(f.executions).toHaveLength(1);

    const second = await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput, "fresh-key-0002");
    expect(second.statusCode).toBe(202);
    now.value = new Date("2026-10-11T10:01:31.000Z");
    const stale = await f.approve(second.json().approvalId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "approval_policy_stale" });
    expect(f.store.getCompanyBoxApproval(second.json().approvalId)?.state).toBe("pending");
    // The agent polls (repeats the call with the same key): a fresh read; now the approval runs.
    expect((await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput, "fresh-key-0002")).statusCode).toBe(202);
    expect((await f.approve(second.json().approvalId)).json()).toMatchObject({ ok: true, approval: { state: "succeeded" } });
    expect(f.executions).toHaveLength(2);

    // Paused by Portal after the hold: the fresh read says paused, so the approval is refused (403) and stays pending.
    const third = await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput, "fresh-key-0003");
    f.policies.set("agent-1", policy({ paused: true, rev: 2 }));
    expect((await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput, "fresh-key-0003")).statusCode).toBe(403);
    const refused = await f.approve(third.json().approvalId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "agent_paused" });
    expect(f.store.getCompanyBoxApproval(third.json().approvalId)?.state).toBe("pending");
    expect(f.executions).toHaveLength(2);
  });

  it("never treats a missing cap as unlimited: an unreadable cap store holds the call", async () => {
    const f = await modes();
    const pluginId = await gmail(f);
    await f.setMode("agent-1", { mode: "assistant" });
    const send = await f.grant("agent-1", pluginId, "gmail.send.email");
    const spy = vi.spyOn(f.store.agentModes, "reserveExecution").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      const held = await f.call("agent-1", pluginId, "gmail.send.email", send, sendInput);
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json()).toMatchObject({ heldBecause: "cap_unavailable" });
    } finally {
      spy.mockRestore();
    }
    expect(f.executions).toEqual([]);
    // A cap of 0 holds every call.
    await f.setMode("agent-1", { mode: "assistant" });
    const now = new Date();
    expect(decideOutward(f.store, { workspaceSlug: TENANT, agentId: "agent-z", connectorKey: "x", actionKey: "x.send", risk: { outward: true, destructive: false, sensitive: false }, now })).toMatchObject({ kind: "hold", reason: "system_mode" });
    f.store.agentModes.updateSetting({ workspaceSlug: TENANT, agentId: "agent-z", mode: "assistant", dailyCap: 0, actor: "operator:owner-1", now });
    expect(decideOutward(f.store, { workspaceSlug: TENANT, agentId: "agent-z", connectorKey: "x", actionKey: "x.send", risk: { outward: true, destructive: false, sensitive: false }, now })).toEqual({ kind: "hold", reason: "cap_agent" });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import {
  MARKETPLACE_OPERATOR_SESSION_COOKIE,
  MarketplaceOperatorSessionManager,
} from "./operator-auth.js";
import type { PortalRuntimeScopeVerifier } from "./portal-runtime-scope.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ORG = "tenant-1";
const SERVICE = { authorization: "Bearer marketplace-service-token" };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-action-catalog-routes-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), {
    handoffEncryptionKey: "a".repeat(64),
  });
  const operatorSessions = new MarketplaceOperatorSessionManager({
    accessToken: "operator-access-token",
    organizationId: ORG,
  });
  const operatorLogin = operatorSessions.exchange("operator-access-token", "catalog-route-test");
  const portalRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const portalGrants = new Map<string, Record<string, unknown>>();
  const providerCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const verifierCalls: Array<Parameters<PortalRuntimeScopeVerifier>[0]> = [];
  let sequence = 0;
  let consentIdForLease = "";
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: "marketplace-service-token",
    organizationId: ORG,
    operatorSessionManager: operatorSessions,
    portalIssuerUrl: "https://portal.test",
    portalInstanceProof: "p".repeat(43),
    env: { COMPOSIO_API_KEY: "provider-secret-canary" },
    portalFetch: async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      portalRequests.push({ path: pathname, body });
      if (pathname === "/api/deployment-browser/grant-request") {
        const requestId = `${"r".repeat(42)}${sequence++ % 10}`;
        portalGrants.set(requestId, body);
        return new Response(
          JSON.stringify({ requestId, approvalUrl: `https://portal.test/approve/${requestId}`, expiresAt: Date.now() + 600_000 }),
          { status: 200 },
        );
      }
      const requested = portalGrants.get(String(body.requestId));
      if (!requested) return new Response(JSON.stringify({ error: "not_found" }), { status: 409 });
      const selection = requested.selection as Record<string, string>;
      return new Response(
        JSON.stringify({
          schema: 1,
          authorized: true,
          product: "marketplace",
          portalOrgId: "portal-org",
          productTenantId: ORG,
          workspaceId: ORG,
          deploymentId: "deployment-1",
          userId: "owner-1",
          agentId: requested.agentId,
          consentId: `consent-${String(body.requestId).slice(-1)}`,
          consentRevision: 1,
          state: "active",
          // Portal Core v1.2 maps the selection capability to tether actions
          // and echoes the selection it approved.
          capabilities: [selection.capability ?? "connector.observe"],
          requiredActions: selection.capability === "connector.dispatch" ? ["read", "create"] : ["read"],
          selection,
        }),
        { status: 200 },
      );
    },
    portalRuntimeScopeVerifier: async (input) => {
      verifierCalls.push(input);
      return {
        portalOrgId: "portal-org",
        productTenantId: ORG,
        workspaceId: ORG,
        deploymentId: "deployment-1",
        agentId: "agent-1",
        consentId: consentIdForLease,
        leaseId: "lease-1",
        capabilities: [input.requiredCapability],
        expiresAt: Date.now() + 300_000,
      };
    },
    providerFetch: async (input, init) => {
      providerCalls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    },
    agentScopeVerifier: async ({ requiredCapability }) => ({
      organizationId: ORG,
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
    productTenantId: ORG,
    workspaceId: ORG,
    userId: "owner-1",
    sessionToken: "s".repeat(43),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const imported = await app.inject({
    method: "POST",
    url: "/api/marketplace/catalog/composio/import",
    headers: SERVICE,
    payload: {
      workspaceSlug: ORG,
      actorId: "operator",
      toolkit: "github",
      pluginId: "github-composio",
      tools: [
        { name: "GITHUB_LIST_REPOSITORIES", description: "List repositories." },
        {
          name: "GITHUB_CREATE_ISSUE",
          displayName: "Create issue",
          description: "Open an issue.",
          input_parameters: { type: "object", properties: { owner: {}, repo: {}, title: {}, body: {} } },
        },
      ],
      autoEnable: true,
    },
  });
  expect(imported.statusCode).toBe(201);
  store.upsertConnection({
    workspaceSlug: ORG,
    pluginId: "github-composio",
    provider: "github",
    backend: "composio",
    state: "connected",
    detail: "fixture",
    metadata: { connectedAccountId: "ca_1", userId: "composio-user-secret" },
  });
  return {
    app,
    store,
    operatorCookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${operatorLogin.token}`,
    portalRequests,
    providerCalls,
    verifierCalls,
    setLeaseConsent(consentId: string) {
      consentIdForLease = consentId;
    },
    async close() {
      await app.close();
      store.close();
    },
  };
}

const legacySelection = {
  pluginId: "github-composio",
  actionKey: "github.list.repositories",
  accountId: "ca_1",
  resourceKind: "github.connected-account",
  resourceRef: "account:ca_1",
};
const dispatchSelection = { ...legacySelection, actionKey: "github.create.issue" };

describe("agent action catalog routes", () => {
  it("scopes the catalog to the operator organization or a service bearer with workspaceSlug", async () => {
    const f = await fixture();
    const operator = await f.app.inject({
      method: "GET",
      url: "/api/marketplace/v1/agent/action-catalog",
      headers: { cookie: f.operatorCookie },
    });
    expect(operator.statusCode).toBe(200);
    const body = operator.json();
    expect(body).toMatchObject({
      contractVersion: "doppelganger.marketplace.agent-action-catalog.v1",
      workspaceSlug: ORG,
    });
    expect(body.actions.map((entry: { actionKey: string; capability: string }) => [entry.actionKey, entry.capability])).toEqual([
      ["github.create.issue", "connector.dispatch"],
      ["github.list.repositories", "connector.observe"],
    ]);
    expect(Object.keys(body.actions[0]).sort()).toEqual(
      ["accounts", "actionKey", "allowedArguments", "capability", "description", "label", "mode", "pluginId", "pluginName", "provider", "resourceKind", "toolName"],
    );
    expect(operator.body).not.toContain("composio-user-secret");
    expect(operator.body).not.toContain("provider-secret-canary");
    expect(operator.body).not.toContain("manifest");

    const sameOrg = await f.app.inject({ method: "GET", url: `/api/marketplace/v1/agent/action-catalog?workspaceSlug=${ORG}`, headers: { cookie: f.operatorCookie } });
    expect(sameOrg.statusCode).toBe(200);
    const foreign = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/action-catalog?workspaceSlug=other-org", headers: { cookie: f.operatorCookie } });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: "agent_action_catalog_tenant_mismatch" });

    const serviceMissing = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/action-catalog", headers: SERVICE });
    expect(serviceMissing.statusCode).toBe(400);
    expect(serviceMissing.json()).toMatchObject({ error: "workspace_slug_required" });
    const service = await f.app.inject({ method: "GET", url: `/api/marketplace/v1/agent/action-catalog?workspaceSlug=${ORG}`, headers: SERVICE });
    expect(service.statusCode).toBe(200);
    expect(service.json().actions).toHaveLength(2);
    const serviceForeign = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/action-catalog?workspaceSlug=other-org", headers: SERVICE });
    expect(serviceForeign.statusCode).toBe(403);

    const anonymous = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/action-catalog" });
    expect(anonymous.statusCode).toBe(401);

    f.store.uninstall(ORG, "github-composio");
    const afterUninstall = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/action-catalog", headers: { cookie: f.operatorCookie } });
    expect(afterUninstall.json().actions).toEqual([]);
    await f.close();
  });

  it("keeps the legacy GitHub selection byte-identical and rejects unpublished selections", async () => {
    const f = await fixture();
    const legacy = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection: legacySelection, idempotencyKey: "legacy-request-1" },
    });
    expect(legacy.statusCode).toBe(200);
    expect(f.portalRequests.at(-1)?.body.selection).toEqual(legacySelection);

    const reject = async (selection: Record<string, unknown>, status: number, error: string) => {
      const before = f.portalRequests.length;
      const response = await f.app.inject({
        method: "POST",
        url: "/api/marketplace/v1/agent/grants/request",
        headers: SERVICE,
        payload: { deploymentId: "deployment-1", agentId: "agent-1", selection, idempotencyKey: `reject-${error}` },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error });
      expect(f.portalRequests.length).toBe(before);
    };
    await reject({ ...legacySelection, actionKey: "github.delete.repository" }, 404, "agent_action_not_published");
    await reject({ ...legacySelection, pluginId: "slack-composio", resourceKind: "slack.connected-account" }, 404, "agent_action_not_published");
    await reject({ ...legacySelection, accountId: "ca_2", resourceRef: "account:ca_2" }, 409, "agent_action_account_mismatch");
    await reject({ ...legacySelection, resourceKind: "gitlab.connected-account" }, 409, "agent_action_resource_mismatch");
    await reject({ ...dispatchSelection, capability: "connector.observe" }, 409, "agent_action_capability_mismatch");

    f.store.bindAction({ workspaceSlug: ORG, pluginId: "github-composio", actionKey: "github.create.issue", enabled: false });
    await reject(dispatchSelection, 404, "agent_action_not_published");
    await f.close();
  });

  it("runs a dispatch action end-to-end: request with capability, redeem, runtime execute", async () => {
    const f = await fixture();
    const requested = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection: dispatchSelection, idempotencyKey: "dispatch-request-1" },
    });
    expect(requested.statusCode).toBe(200);
    expect(f.portalRequests.at(-1)?.body.selection).toEqual({ ...dispatchSelection, capability: "connector.dispatch" });
    expect(requested.json().projection.selection).toMatchObject({ capability: "connector.dispatch" });
    const requestId = requested.json().request.requestId as string;

    const redeemed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/redeem",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", requestId },
    });
    expect(redeemed.statusCode).toBe(200);
    const consent = redeemed.json().consent;
    expect(consent).toMatchObject({
      actionKey: "github.create.issue",
      capability: "connector.dispatch",
      accountId: "ca_1",
      resourceKind: "github.connected-account",
    });
    f.setLeaseConsent(consent.consentId);

    const runtime = (input: Record<string, unknown>, idempotencyKey: string, selection: Record<string, unknown> = { ...dispatchSelection, capability: "connector.dispatch" }) =>
      f.app.inject({
        method: "POST",
        url: "/api/marketplace/v1/runtime/composio/execute",
        headers: { authorization: "Bearer portal-lease" },
        payload: { schema: 1, consentId: consent.consentId, selection, input, idempotencyKey },
      });

    const executed = await runtime({ owner: "acme", repo: "app", title: "Bug" }, "dispatch-op-1");
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({ ok: true, result: { actionType: "github.create.issue", capability: "connector.dispatch" } });
    expect(f.verifierCalls.at(-1)?.requiredCapability).toBe("connector.dispatch");
    expect(f.providerCalls.at(-1)?.url).toContain("/tools/execute/GITHUB_CREATE_ISSUE");
    expect(f.providerCalls.at(-1)?.body).toMatchObject({
      connected_account_id: "ca_1",
      arguments: { owner: "acme", repo: "app", title: "Bug" },
    });

    const providerCount = f.providerCalls.length;
    const outsideSchema = await runtime({ owner: "acme", labels: ["x"] }, "dispatch-op-2");
    expect(outsideSchema.statusCode).toBe(403);
    expect(outsideSchema.json()).toMatchObject({ error: "provider_argument_invalid" });
    const override = await runtime({ owner: "acme", connected_account_id: "ca_other" }, "dispatch-op-3");
    expect(override.statusCode).toBe(403);
    expect(override.json()).toMatchObject({ error: "provider_argument_invalid" });
    // An observe-shaped (legacy five-key) selection cannot ride a dispatch consent.
    const downgraded = await runtime({ owner: "acme" }, "dispatch-op-4", dispatchSelection);
    expect(downgraded.statusCode).toBe(403);
    expect(downgraded.json()).toMatchObject({ error: "runtime_scope_mismatch" });

    f.store.uninstall(ORG, "github-composio");
    const afterUninstall = await runtime({ owner: "acme" }, "dispatch-op-5");
    expect(afterUninstall.statusCode).toBe(409);
    expect(afterUninstall.json()).toMatchObject({ error: "runtime_connection_unavailable" });
    expect(f.providerCalls.length).toBe(providerCount);
    await f.close();
  });

  it("still redeems and executes the legacy GitHub list action unchanged", async () => {
    const f = await fixture();
    const requested = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection: legacySelection, idempotencyKey: "legacy-request-2" },
    });
    const redeemed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/redeem",
      headers: SERVICE,
      payload: { deploymentId: "deployment-1", requestId: requested.json().request.requestId },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().consent).toMatchObject({ capability: "connector.observe", actionKey: "github.list.repositories" });
    f.setLeaseConsent(redeemed.json().consent.consentId);
    const executed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: { schema: 1, consentId: redeemed.json().consent.consentId, selection: legacySelection, input: { per_page: 5 }, idempotencyKey: "legacy-op-1" },
    });
    expect(executed.statusCode).toBe(200);
    expect(f.verifierCalls.at(-1)?.requiredCapability).toBe("connector.observe");
    expect(f.providerCalls.at(-1)?.url).toContain("/tools/execute/GITHUB_LIST_REPOSITORIES");
    await f.close();
  });

  it("creates and executes a scoped direct grant for a published dispatch action", async () => {
    const f = await fixture();
    const agentHeaders = { ...SERVICE, "x-tealbrick-agent-token": "agent-1", "x-tealbrick-attachment": "attachment-1" };
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: agentHeaders,
      payload: { workspaceSlug: ORG, pluginId: "github-composio", actionKey: "github.create.issue", accountId: "ca_1", resourceKind: "github.connected-account", resourceRef: "account:ca_1" },
    });
    expect(grant.statusCode).toBe(201);
    expect(grant.json().grant).toMatchObject({ capability: "connector.dispatch", actionKey: "github.create.issue" });
    const grantId = grant.json().grant.id as string;
    const execute = (action: Record<string, unknown>) =>
      f.app.inject({
        method: "POST",
        url: "/api/marketplace/plugins/github-composio/execute",
        headers: agentHeaders,
        payload: { workspaceSlug: ORG, capability: "connector.dispatch", agentGrantId: grantId, action: { type: "github.create.issue", ...action } },
      });
    const outside = await execute({ owner: "acme", milestone: 3 });
    expect(outside.statusCode).toBe(403);
    expect(outside.json()).toMatchObject({ error: "provider_argument_invalid" });
    const allowed = await execute({ owner: "acme", repo: "app", title: "Bug" });
    expect(allowed.statusCode).toBe(200);
    expect(f.providerCalls.at(-1)?.url).toContain("/tools/execute/GITHUB_CREATE_ISSUE");

    const unknown = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: agentHeaders,
      payload: { workspaceSlug: ORG, pluginId: "github-composio", actionKey: "github.list.repositories", accountId: "ca_1", resourceKind: "gitlab.connected-account", resourceRef: "account:ca_1" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: "agent_grant_resource_invalid" });

    f.store.uninstall(ORG, "github-composio");
    const afterUninstall = await execute({ owner: "acme" });
    expect(afterUninstall.statusCode).toBe(409);
    expect(afterUninstall.json()).toMatchObject({ error: "plugin_not_installed" });
    await f.close();
  });
});

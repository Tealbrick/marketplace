import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import {
  MARKETPLACE_OPERATOR_SESSION_COOKIE,
  MarketplaceOperatorSessionManager,
} from "./operator-auth.js";
import type { PortalAgentScopeVerifier } from "./portal-scope.js";
import { makeRulesClient } from "./rules-client.js";
import { SqliteMarketplaceStore } from "./store.js";
import { setComposioReadAllowlistForTests } from "./composio-policy.js";

// F3-1: the shipped Composio read allowlist is empty, so every tool of an uncurated toolkit is
// outward and needs connector.dispatch. This file exercises grant/consent/execution plumbing with
// a read action, so it marks that read as reviewed for the duration of the file only.
let restoreComposioReadAllowlist: () => void = () => {};
beforeAll(() => {
  restoreComposioReadAllowlist = setComposioReadAllowlistForTests({ github: ["GITHUB_LIST_REPOSITORIES"] });
});
afterAll(() => restoreComposioReadAllowlist());

const tempRoots: string[] = [];

async function tempDbPath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-agent-grant-"));
  tempRoots.push(root);
  return path.join(root, "marketplace.sqlite");
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Marketplace agent connector grants", () => {
  it("binds a verified Portal agent to one Composio account/resource and revokes it", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const executions: Array<Record<string, unknown>> = [];
    const rulesCalls: Array<Record<string, unknown>> = [];
    const operatorSessions = new MarketplaceOperatorSessionManager({
      accessToken: "operator-access-token",
      organizationId: "atlas",
    });
    const operatorLogin = operatorSessions.exchange(
      "operator-access-token",
      "agent-grant-test",
    );
    const providerFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/tools/execute/GITHUB_LIST_REPOSITORIES")) {
        executions.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ name: "marketplace" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const agentScopeVerifier: PortalAgentScopeVerifier = async ({
      agentToken,
      attachmentToken,
      audience,
      requiredCapability,
    }) => {
      expect(attachmentToken).toMatch(/^attachment-/u);
      expect(audience).toBe("marketplace");
      expect(requiredCapability).toBe("connector.observe");
      return {
        organizationId: "atlas",
        agentId: agentToken === "agent-2" ? "agent-2" : "agent-1",
        attachmentId: "attachment-1",
        capabilities: ["connector.observe"],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      };
    };
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "marketplace-service-token",
      organizationId: "atlas",
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      providerFetch,
      agentScopeVerifier,
      operatorSessionManager: operatorSessions,
      rulesClient: async (input) => {
        rulesCalls.push(input as unknown as Record<string, unknown>);
        return { effect: "allow", decisionId: "rules-allow-agent-grant" };
      },
    });

    const imported = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      headers: { authorization: "Bearer marketplace-service-token" },
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "github",
        pluginId: "github-composio",
        tools: [
          {
            name: "GITHUB_LIST_REPOSITORIES",
            description: "List repositories for an owner.",
          },
        ],
        autoEnable: true,
      },
    });
    expect(imported.statusCode).toBe(201);
    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "github-composio",
      provider: "github",
      backend: "composio",
      state: "connected",
      detail: "Test connected account",
      metadata: { connectedAccountId: "ca_agent_1" },
    });

    const fixture = JSON.parse(
      await readFile(
        new URL("../../contracts/fixtures/marketplace-agent-connector-grant.v1.json", import.meta.url),
        "utf8",
      ),
    ) as { cases: Array<{ id: string; expected: string; reason: string }> };
    expect(fixture.cases.map((item) => item.id)).toEqual([
      "allowed",
      "foreign-resource",
      "foreign-agent",
      "revoked",
    ]);
    expect(fixture.cases.filter((item) => item.expected === "deny")).toHaveLength(3);
    const browserFixture = JSON.parse(
      await readFile(
        new URL("../../contracts/fixtures/marketplace-agent-grant-browser.v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      projection: { forbiddenFields: string[] };
      creation: { available: boolean; code: string };
    };
    expect(browserFixture.projection.forbiddenFields).toEqual(
      expect.arrayContaining(["attachmentId", "agentToken", "attachmentToken"]),
    );
    expect(browserFixture.creation).toMatchObject({
      available: false,
      code: "portal_handoff_required",
    });

    const grantResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-tealbrick-agent-token": "agent-1",
        "x-tealbrick-attachment": "attachment-1",
      },
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        actionKey: "github.list.repositories",
        accountId: "ca_agent_1",
        resourceKind: "github.connected-account",
        resourceRef: "account:ca_agent_1",
      },
    });
    expect(grantResponse.statusCode).toBe(201);
    const grantBody = grantResponse.json<{
      grant: { id: string; agentId: string; accountId: string; resourceRef: string };
    }>();
    expect(grantBody.grant).toMatchObject({
      agentId: "agent-1",
      accountId: "ca_agent_1",
      resourceRef: "account:ca_agent_1",
    });
    const grantId = grantBody.grant.id;
    expect(grantResponse.body).not.toContain("agent-1-secret");
    expect(grantResponse.body).not.toContain("attachment-1-secret");
    expect(JSON.stringify(store.listAudit({ workspaceSlug: "atlas" }))).not.toContain(
      "attachment-1-secret",
    );
    expect(
      rulesCalls.find(
        (call) =>
          (call.payload as Record<string, unknown> | undefined)?.phase ===
          "grant",
      ),
    ).toMatchObject({
      operation: "execute",
      actorId: "agent:agent-1",
      pluginId: "github-composio",
    });

    const browserProjection = await app.inject({
      method: "GET",
      url: "/api/marketplace/agent/grants?workspaceSlug=atlas",
      headers: {
        cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${operatorLogin.token}`,
      },
    });
    expect(browserProjection.statusCode).toBe(200);
    expect(browserProjection.json()).toMatchObject({
      contractVersion: "doppelganger.marketplace.agent-connector-grant.v1",
      workspaceSlug: "atlas",
      grants: [
        expect.objectContaining({
          id: grantId,
          agentId: "agent-1",
          accountId: "ca_agent_1",
          resourceKind: "github.connected-account",
          resourceRef: "account:ca_agent_1",
        }),
      ],
      grantCreation: { available: false, code: "portal_handoff_required" },
    });
    expect(browserProjection.body).not.toContain("attachmentId");
    expect(browserProjection.body).not.toContain("agent-1-secret");
    expect(browserProjection.body).not.toContain("attachment-1-secret");

    const capabilities = await app.inject({
      method: "GET",
      url: `/api/agent/capabilities?workspaceSlug=atlas&grantId=${grantId}`,
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-tealbrick-agent-token": "agent-1",
        "x-tealbrick-attachment": "attachment-1",
      },
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      grant: { id: grantId, agentId: "agent-1" },
      capabilities: [
        expect.objectContaining({
          pluginId: "github-composio",
          actionType: "github.list.repositories",
          requiredCapabilities: ["connector.observe"],
        }),
      ],
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.list.repositories",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-tealbrick-agent-token": "agent-1",
        "x-tealbrick-attachment": "attachment-1",
      },
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        grantId,
        input: { per_page: 25, visibility: "all" },
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      ok: true,
      result: { actionType: "github.list.repositories", simulated: false },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      connected_account_id: "ca_agent_1",
      arguments: { per_page: 25, visibility: "all" },
    });
    expect(rulesCalls.at(-1)).toMatchObject({
      operation: "execute",
      actorId: "agent:agent-1",
      payload: expect.objectContaining({
        agentGrantId: grantId,
        resourceKind: "github.connected-account",
        resourceRef: "account:ca_agent_1",
      }),
    });

    const foreignResource = await app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.list.repositories",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-tealbrick-agent-token": "agent-1",
        "x-tealbrick-attachment": "attachment-1",
      },
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        grantId,
        resourceRef: "account:ca_other",
        input: { per_page: 25 },
      },
    });
    expect(foreignResource.statusCode).toBe(403);
    expect(foreignResource.json()).toMatchObject({ error: "resource_mismatch" });
    expect(executions).toHaveLength(1);

    const foreignAgent = await app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.list.repositories",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-tealbrick-agent-token": "agent-2",
        "x-tealbrick-attachment": "attachment-1",
      },
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        grantId,
        input: { per_page: 25 },
      },
    });
    expect(foreignAgent.statusCode).toBe(403);
    expect(foreignAgent.json()).toMatchObject({ error: "agent_grant_agent_mismatch" });
    expect(executions).toHaveLength(1);

    const revoked = await app.inject({
      method: "POST",
      url: `/api/marketplace/agent/grants/${grantId}/revoke`,
      headers: {
        origin: "http://localhost",
        cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${operatorLogin.token}`,
        "x-csrf-token": operatorLogin.status.csrfToken!,
      },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ grant: { id: grantId, state: "revoked" } });

    const afterRevoke = await app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.list.repositories",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-tealbrick-agent-token": "agent-1",
        "x-tealbrick-attachment": "attachment-1",
      },
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        grantId,
        input: { per_page: 25 },
      },
    });
    expect(afterRevoke.statusCode).toBe(403);
    expect(afterRevoke.json()).toMatchObject({ error: "agent_grant_revoked" });
    expect(executions).toHaveLength(1);

    const reconnected = await app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-tealbrick-agent-token": "agent-1",
        "x-tealbrick-attachment": "attachment-1",
      },
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        actionKey: "github.list.repositories",
        accountId: "ca_agent_1",
        resourceKind: "github.connected-account",
        resourceRef: "account:ca_agent_1",
      },
    });
    expect(reconnected.statusCode).toBe(201);
    const reconnectedId = reconnected.json<{ grant: { id: string } }>().grant.id;
    const serviceRevoked = await app.inject({
      method: "POST",
      url: `/api/marketplace/agent/grants/${reconnectedId}/revoke`,
      headers: { authorization: "Bearer marketplace-service-token" },
    });
    expect(serviceRevoked.statusCode).toBe(200);
    expect(serviceRevoked.json()).toMatchObject({
      grant: { id: reconnectedId, state: "revoked", attachmentId: "attachment-1" },
    });

    await app.close();
    store.close();
  });

  it("does not mint an agent grant when the actual Rules response has no match", async () => {
    const rules = Fastify();
    rules.post("/api/rules/gateway/evaluate", async (request) => {
      const body = request.body as {
        params?: { actor?: { kind?: string }; operation?: string };
      };
      if (body.params?.actor?.kind === "operator") {
        return { allowed: true, reason: "operator fixture allow", decisionId: "rules-operator-allow" };
      }
      return {
        allowed: false,
        reason: "gateway request denied: no live ruleset matched this request",
        decisionId: "rules-no-agent-grant-match",
      };
    });
    await rules.listen({ host: "127.0.0.1", port: 0 });
    const address = rules.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Rules fixture did not bind to a TCP port.");
    }
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "marketplace-service-token",
      organizationId: "atlas",
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      providerFetch: async () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      agentScopeVerifier: async () => ({
        organizationId: "atlas",
        agentId: "agent-1",
        attachmentId: "attachment-1",
        capabilities: ["connector.observe"],
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      }),
      rulesClient: makeRulesClient({
        host: "127.0.0.1",
        port: address.port,
        dbPath: store.dbPath,
        settingsPath: `${store.dbPath}.settings.json`,
        secretsPath: `${store.dbPath}.secrets.json`,
        rules: { baseUrl: `http://127.0.0.1:${address.port}`, companyId: "atlas" },
      }),
    });

    const auth = { authorization: "Bearer marketplace-service-token" };
    const imported = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      headers: auth,
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "github",
        pluginId: "github-composio",
        tools: [{ name: "GITHUB_LIST_REPOSITORIES" }],
        autoEnable: true,
      },
    });
    expect(imported.statusCode).toBe(201);
    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "github-composio",
      provider: "github",
      backend: "composio",
      state: "connected",
      detail: "Rules denial fixture",
      metadata: { connectedAccountId: "ca_agent_1" },
    });

    const grant = await app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: {
        ...auth,
        "x-tealbrick-agent-token": "agent-1",
        "x-tealbrick-attachment": "attachment-1",
      },
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        actionKey: "github.list.repositories",
        accountId: "ca_agent_1",
        resourceKind: "github.connected-account",
        resourceRef: "account:ca_agent_1",
      },
    });
    expect(grant.statusCode).toBe(403);
    expect(grant.json()).toMatchObject({ error: "rules_denied" });
    expect(store.listAgentConnectorGrants({ workspaceSlug: "atlas" })).toHaveLength(0);

    await app.close();
    await rules.close();
    store.close();
  });
});

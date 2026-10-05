import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp, type BuildMarketplaceAppOptions } from "./app.js";
import {
  governanceModeFor,
  ownerGovernedDecision,
  OWNER_APPROVAL_REQUIRES_PORTAL_CONSENT,
} from "./governance.js";
import {
  MARKETPLACE_OPERATOR_SESSION_COOKIE,
  MarketplaceOperatorSessionManager,
} from "./operator-auth.js";
import type { PortalAgentScopeVerifier } from "./portal-scope.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];
const SERVICE = "marketplace-service-token";
const ORIGIN = "http://localhost";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type AuditRow = {
  event_type: string;
  actor_id: string | null;
  plugin_id: string | null;
  rules_decision_id: string | null;
  metadata: string;
};

function governanceAudit(store: SqliteMarketplaceStore, workspaceSlug: string) {
  return (store.listAudit({ workspaceSlug, limit: 500 }) as AuditRow[])
    .filter((row) => row.event_type.startsWith("marketplace.governance."))
    .map((row) => ({
      eventType: row.event_type,
      actorId: row.actor_id,
      pluginId: row.plugin_id,
      decisionId: row.rules_decision_id,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    }));
}

async function fixture(extra: Partial<BuildMarketplaceAppOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-governance-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
  const executions: Array<Record<string, unknown>> = [];
  const sessions = new MarketplaceOperatorSessionManager({
    accessToken: "operator-access-token",
    operatorId: "owner-1",
    organizationId: "atlas",
  });
  const login = sessions.exchange("operator-access-token", "governance-test");
  const agentScopeVerifier: PortalAgentScopeVerifier = async ({ agentToken }) => ({
    organizationId: "atlas",
    agentId: agentToken,
    attachmentId: "attachment-1",
    capabilities: ["connector.observe"],
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: "atlas",
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    operatorSessionManager: sessions,
    agentScopeVerifier,
    providerFetch: async (input, init) => {
      if (String(input).includes("/tools/execute/GITHUB_LIST_REPOSITORIES")) {
        executions.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: [{ name: "marketplace" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
    ...extra,
  });
  const operatorHeaders = {
    origin: ORIGIN,
    cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${login.token}`,
    "x-csrf-token": login.status.csrfToken!,
  };
  const serviceHeaders = { authorization: `Bearer ${SERVICE}` };
  const agentHeaders = (agentId: string) => ({
    ...serviceHeaders,
    "x-tealbrick-agent-token": agentId,
    "x-tealbrick-attachment": "attachment-1",
  });
  const close = async () => {
    await app.close();
    store.close();
  };
  return { app, store, executions, operatorHeaders, serviceHeaders, agentHeaders, close };
}

/** Service-bearer Composio import, then a connected account for the agent. */
async function importGithub(f: Awaited<ReturnType<typeof fixture>>) {
  const imported = await f.app.inject({
    method: "POST",
    url: "/api/marketplace/catalog/composio/import",
    headers: f.serviceHeaders,
    payload: {
      workspaceSlug: "atlas",
      toolkit: "github",
      pluginId: "github-composio",
      tools: [{ name: "GITHUB_LIST_REPOSITORIES", description: "List repositories." }],
      autoEnable: true,
    },
  });
  f.store.upsertConnection({
    workspaceSlug: "atlas",
    pluginId: "github-composio",
    provider: "github",
    backend: "composio",
    state: "connected",
    detail: "Test connected account",
    metadata: { connectedAccountId: "ca_1" },
  });
  return imported;
}

const executeBody = {
  workspaceSlug: "atlas",
  capability: "connector.observe",
  action: { type: "github.list.repositories", per_page: 5 },
};

describe("governance mode selection", () => {
  it("is owner only when no Rules client and no Rules configuration exist", () => {
    expect(governanceModeFor({ rulesConfigured: false })).toBe("owner");
    expect(governanceModeFor({ rulesConfigured: true })).toBe("rules");
    expect(
      governanceModeFor({
        rulesConfigured: false,
        rulesClient: async () => ({ effect: "deny" }),
      }),
    ).toBe("rules");
  });

  it("decides owner mode from the actor kind, never from actor id strings", () => {
    const base = { operation: "install", capability: "connector.admin" as const, pluginId: "p" };
    expect(ownerGovernedDecision({ ...base, actor: { kind: "operator", id: "agent:spoof" } })).toMatchObject({
      effect: "allow",
      decisionId: "owner-governed:install:p",
    });
    expect(
      ownerGovernedDecision({
        ...base,
        operation: "execute",
        capability: "connector.observe",
        actor: { kind: "agent", id: "agent:a", attestation: "agent-grant" },
      }),
    ).toMatchObject({ effect: "allow", decisionId: "owner-governed:portal-consent:execute:p" });
    expect(ownerGovernedDecision({ ...base, actor: { kind: "service", id: "svc" } })).toMatchObject({
      effect: "allow",
      basis: "service-admin",
    });
    for (const capability of ["connector.observe", "connector.dispatch", "connector.admin"] as const) {
      expect(
        ownerGovernedDecision({ ...base, operation: "execute", capability, actor: { kind: "service", id: "operator" } }),
      ).toMatchObject({ effect: "deny", error: OWNER_APPROVAL_REQUIRES_PORTAL_CONSENT });
    }
    expect(
      ownerGovernedDecision({ ...base, operation: "broker.grant", capability: "connector.observe", actor: { kind: "service", id: "svc" } }),
    ).toMatchObject({ effect: "deny" });
    expect(ownerGovernedDecision({ ...base, actor: null })).toMatchObject({ effect: "deny" });
  });
});

describe("owner approval mode (no Rules configured)", () => {
  it("lets the operator session install, bind and execute, auditing each owner decision", async () => {
    const f = await fixture();
    expect((await importGithub(f)).statusCode).toBe(201);

    const uninstall = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-composio/uninstall",
      headers: f.operatorHeaders,
      payload: { workspaceSlug: "atlas", actorId: "agent:spoofed" },
    });
    expect(uninstall.statusCode).toBe(200);
    expect(uninstall.json()).toMatchObject({
      ok: true,
      rules: { effect: "allow", decisionId: "owner-governed:uninstall:github-composio" },
    });

    const install = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-composio/install",
      headers: f.operatorHeaders,
      payload: { workspaceSlug: "atlas" },
    });
    expect(install.statusCode).toBe(201);
    expect(install.json()).toMatchObject({
      rules: { effect: "allow", decisionId: "owner-governed:install:github-composio" },
    });

    const bind = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-composio/capability-binding",
      headers: f.operatorHeaders,
      payload: { workspaceSlug: "atlas", capability: "connector.observe", enabled: true },
    });
    expect(bind.statusCode).toBe(201);

    const executed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-composio/execute",
      headers: f.operatorHeaders,
      payload: executeBody,
    });
    expect(executed.statusCode).toBe(200);
    expect(f.executions).toHaveLength(1);

    const audit = governanceAudit(f.store, "atlas");
    const operatorEvents = audit.filter((row) => row.actorId === "owner-1");
    expect(operatorEvents.map((row) => row.metadata.operation).sort()).toEqual(
      ["capability.bind", "execute", "install", "uninstall"],
    );
    for (const row of operatorEvents) {
      expect(row).toMatchObject({
        eventType: "marketplace.governance.owner_approved",
        pluginId: "github-composio",
        metadata: { governance: "owner", actorKind: "operator", basis: "operator" },
      });
      expect(row.decisionId).toBe(`owner-governed:${String(row.metadata.operation)}:github-composio`);
    }
    // Only the decision basis is audited; never payload values.
    expect(JSON.stringify(audit)).not.toContain("per_page");
    expect(JSON.stringify(audit)).not.toContain("spoofed");
    await f.close();
  });

  it("allows owner-provisioned service administration via Hub routes, audited", async () => {
    const f = await fixture();
    expect((await importGithub(f)).statusCode).toBe(201);
    const reload = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/github-composio/lifecycle",
      headers: f.serviceHeaders,
      payload: { workspaceSlug: "atlas", action: "reload" },
    });
    expect(reload.statusCode).toBeLessThan(300);
    const audit = governanceAudit(f.store, "atlas");
    expect(audit.find((row) => row.metadata.operation === "hub.lifecycle.reload")).toMatchObject({
      eventType: "marketplace.governance.owner_approved",
      actorId: "marketplace-service",
      decisionId: "owner-governed:hub.lifecycle.reload:github-composio",
      metadata: { actorKind: "service", basis: "service-admin" },
    });
    await f.close();
  });

  it("denies unattested service-bearer execution and allows agents only with a verified Portal grant", async () => {
    const f = await fixture();
    expect((await importGithub(f)).statusCode).toBe(201);

    const unattested = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-composio/execute",
      headers: f.serviceHeaders,
      payload: { ...executeBody, actorId: "operator" },
    });
    expect(unattested.statusCode).toBe(403);
    expect(unattested.json()).toMatchObject({
      ok: false,
      error: "owner_approval_requires_portal_consent",
      governance: "owner",
    });

    const toolWithoutGrant = await f.app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.list.repositories",
      headers: f.serviceHeaders,
      payload: { workspaceSlug: "atlas", pluginId: "github-composio", input: { per_page: 5 } },
    });
    expect(toolWithoutGrant.statusCode).toBe(403);
    expect(toolWithoutGrant.json()).toMatchObject({ error: "owner_approval_requires_portal_consent" });
    expect(f.executions).toHaveLength(0);

    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: f.agentHeaders("agent-1"),
      payload: {
        workspaceSlug: "atlas",
        pluginId: "github-composio",
        actionKey: "github.list.repositories",
        accountId: "ca_1",
        resourceKind: "github.connected-account",
        resourceRef: "account:ca_1",
      },
    });
    expect(grant.statusCode).toBe(201);
    expect(grant.json()).toMatchObject({
      rules: { effect: "allow", decisionId: "owner-governed:portal-consent:execute:github-composio" },
    });
    const grantId = grant.json<{ grant: { id: string } }>().grant.id;

    const withGrant = await f.app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.list.repositories",
      headers: f.agentHeaders("agent-1"),
      payload: { workspaceSlug: "atlas", pluginId: "github-composio", grantId, input: { per_page: 5 } },
    });
    expect(withGrant.statusCode).toBe(200);
    expect(f.executions).toHaveLength(1);

    const foreignAgent = await f.app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.list.repositories",
      headers: f.agentHeaders("agent-2"),
      payload: { workspaceSlug: "atlas", pluginId: "github-composio", grantId, input: { per_page: 5 } },
    });
    expect(foreignAgent.statusCode).toBe(403);
    expect(foreignAgent.json()).toMatchObject({ error: "agent_grant_agent_mismatch" });
    expect(f.executions).toHaveLength(1);

    const audit = governanceAudit(f.store, "atlas");
    expect(audit.filter((row) => row.eventType === "marketplace.governance.owner_denied")).toEqual([
      expect.objectContaining({ actorId: "marketplace-service", metadata: expect.objectContaining({ operation: "execute", actorKind: "service" }) }),
      expect.objectContaining({ actorId: "marketplace-service", metadata: expect.objectContaining({ operation: "execute", actorKind: "service" }) }),
    ]);
    const agentEvents = audit.filter((row) => row.metadata.actorKind === "agent");
    expect(agentEvents.map((row) => row.metadata.attestation).sort()).toEqual(["agent-grant", "portal-scope"]);
    for (const row of agentEvents) {
      expect(row).toMatchObject({
        eventType: "marketplace.governance.owner_approved",
        actorId: "agent:agent-1",
        decisionId: "owner-governed:portal-consent:execute:github-composio",
        metadata: { basis: "portal-consent" },
      });
    }
    await f.close();
  });
});

describe("rules mode is unchanged when Rules is configured", () => {
  it("still sends operator decisions to Rules and honours explicit denials", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const f = await fixture({
      rulesClient: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        return input.operation === "install"
          ? { effect: "deny", decisionId: "rules-deny-install" }
          : { effect: "allow", decisionId: "rules-allow" };
      },
    });
    expect((await importGithub(f)).statusCode).toBe(201);
    const install = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-composio/install",
      headers: f.operatorHeaders,
      payload: { workspaceSlug: "atlas" },
    });
    expect(install.statusCode).toBe(403);
    expect(install.json()).toMatchObject({ error: "rules_denied", rules: { decisionId: "rules-deny-install" } });
    expect(calls.at(-1)).toMatchObject({ operation: "install", actorId: "owner-1" });

    // The unattested service bearer is still decided by Rules, not denied locally.
    const executed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-composio/execute",
      headers: f.serviceHeaders,
      payload: executeBody,
    });
    expect(executed.statusCode).toBe(200);
    expect(calls.at(-1)).toMatchObject({ operation: "execute", actorId: "marketplace-service" });
    expect(governanceAudit(f.store, "atlas")).toEqual([]);
    await f.close();
  });

  it("fails closed when a configured Rules service is unreachable", async () => {
    const { makeRulesClient } = await import("./rules-client.js");
    const f = await fixture({
      rules: { baseUrl: "http://127.0.0.1:9", internalAuthToken: "rules-token" },
      rulesClient: makeRulesClient({ rules: { baseUrl: "http://127.0.0.1:9", internalAuthToken: "rules-token" } } as never),
    });
    const imported = await importGithub(f);
    expect(imported.statusCode).toBe(403);
    expect(imported.json()).toMatchObject({ error: "rules_denied", rules: { reason: expect.stringContaining("failed closed") } });
    const health = await f.app.inject({ method: "GET", url: "/api/marketplace/health", headers: f.serviceHeaders });
    expect(health.json()).toMatchObject({ governance: "rules" });
    await f.close();
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateEmergencyCode } from "@tealbrick/contract";
import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp, type BuildMarketplaceAppOptions } from "./app.js";
import {
  AGENT_OPERATION,
  MARKETPLACE_MANIFEST,
  resolveLaunchRoute,
} from "./contract.js";
import { CHANNEL_AGENT_OPERATION } from "./channels/routes.js";
import { MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { SqliteMarketplaceStore } from "./store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PORTAL = "https://portal.test";
const PROOF = "p".repeat(43);
const SERVICE = "marketplace-service-secret";
const INSTANCE_TOKEN = "i".repeat(40);
const TENANT = "tenant-community";
const GRANT_A = `tbag_${"a".repeat(43)}`;
const GRANT_B = `tbag_${"b".repeat(43)}`;
const GRANT_LIST_ONLY = `tbag_${"c".repeat(43)}`;
const GRANT_ALL = `tbag_${"d".repeat(43)}`;
const LEASE = "portal-lease";

type GrantRecord = {
  agentId: string;
  operations: string[];
  actions: string[];
};

async function fixture(
  input: {
    environment?: Record<string, string | undefined>;
    rules?: boolean;
    operatorSessionManager?: MarketplaceOperatorSessionManager;
    options?: Partial<BuildMarketplaceAppOptions>;
    seedConsents?: boolean;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-contract-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), {
    handoffEncryptionKey: "a".repeat(64),
  });
  let providerCalls = 0;
  const providerBodies: unknown[] = [];
  const introspectCalls: Array<{ token: string; headers: Record<string, string> }> = [];
  const redeemCalls: Array<Record<string, unknown>> = [];
  const grants: Record<string, GrantRecord> = {
    [GRANT_A]: {
      agentId: "agent-1",
      operations: [AGENT_OPERATION.consentsList, AGENT_OPERATION.toolsCall],
      actions: ["create", "read"],
    },
    [GRANT_B]: {
      agentId: "agent-2",
      operations: [AGENT_OPERATION.consentsList, AGENT_OPERATION.toolsCall],
      actions: ["create", "read"],
    },
    [GRANT_LIST_ONLY]: {
      agentId: "agent-1",
      operations: [AGENT_OPERATION.consentsList],
      actions: ["read"],
    },
    // A grant that lists every operation of the manifest, owner operations included.
    [GRANT_ALL]: {
      agentId: "agent-1",
      operations: MARKETPLACE_MANIFEST.operations.map((operation) => operation.id),
      actions: ["create", "read", "update", "delete"],
    },
  };
  let launchTickets = new Set<string>();
  const portalFetch: typeof fetch = async (url, init) => {
    const target = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (target.endsWith("/api/runtime/app-grant/introspect")) {
      const token = String(body.token);
      introspectCalls.push({ token, headers: init?.headers as Record<string, string> });
      const grant = grants[token];
      if (!grant) return new Response(JSON.stringify({ error: "app_grant_denied" }), { status: 403 });
      return new Response(
        JSON.stringify({
          authorized: true,
          principalId: `tealbrick-agent:${grant.agentId}`,
          agentId: grant.agentId,
          orgId: "portal-org-1",
          workspaceId: TENANT,
          deploymentId: "deployment-1",
          product: "marketplace",
          productTenantId: TENANT,
          actions: grant.actions,
          operations: grant.operations,
          capabilityRevision: 1,
          expiresAt: Date.now() + 60_000,
        }),
        { status: 200 },
      );
    }
    if (target.endsWith("/api/deployment-browser/redeem")) {
      redeemCalls.push(body);
      const ticket = String(body.ticket);
      if (launchTickets.has(ticket)) return new Response(JSON.stringify({ error: "invalid_browser_session" }), { status: 401 });
      launchTickets.add(ticket);
      return new Response(
        JSON.stringify({
          schema: 1,
          authorized: true,
          product: "marketplace",
          deploymentId: "deployment-1",
          workspaceId: TENANT,
          orgId: "portal-org-1",
          productTenantId: TENANT,
          userId: "owner-1",
          endpoint: "https://marketplace.fixture.invalid",
          session: "s".repeat(43),
          expiresAt: Date.now() + 3_600_000,
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const scope = {
    portalOrgId: "portal-org-1",
    productTenantId: TENANT,
    workspaceId: TENANT,
    deploymentId: "deployment-1",
    agentId: "agent-1",
    consentId: "consent-1",
    leaseId: "lease-1",
    capabilities: ["connector.observe"],
    expiresAt: Date.now() + 300_000,
  };
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: TENANT,
    // A real operator login (not the test bypass), so owner routes really are closed to anonymous callers.
    operatorSessionManager:
      input.operatorSessionManager ??
      new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234", operatorId: "operator-1", organizationId: TENANT }),
    environment: {
      MARKETPLACE_ORGANIZATION_ID: TENANT,
      MARKETPLACE_PORTAL_URL: `${PORTAL}/`,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: PROOF,
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: TENANT,
      MARKETPLACE_ALLOWED_ORIGINS: "https://marketplace.fixture.invalid",
      ...input.environment,
    },
    portalFetch,
    portalRuntimeScopeVerifier: async () => scope,
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    providerFetch: async (url) => {
      if (String(url).includes("/tools/execute/GITHUB_LIST_REPOSITORIES")) {
        providerCalls += 1;
        providerBodies.push(null);
        return new Response(
          JSON.stringify({
            data: [{ name: "marketplace", html: "<script>alert(1)</script>" }],
            access_token: "provider-secret-fixture",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
    ...(input.rules
      ? {
          rulesClient: async () => ({ effect: "allow" as const, decisionId: "rules-allow" }),
          rules: { baseUrl: "https://rules.fixture.invalid", internalAuthToken: "r".repeat(40) },
        }
      : {}),
    ...input.options,
  });

  const imported = await app.inject({
    method: "POST",
    url: "/api/marketplace/catalog/composio/import",
    headers: { authorization: `Bearer ${SERVICE}` },
    payload: {
      workspaceSlug: TENANT,
      actorId: "operator",
      toolkit: "github",
      pluginId: "github-composio",
      tools: [{ name: "GITHUB_LIST_REPOSITORIES" }],
      autoEnable: true,
    },
  });
  expect(imported.statusCode).toBe(201);
  const connection = store.upsertConnection({
    workspaceSlug: TENANT,
    pluginId: "github-composio",
    provider: "github",
    backend: "composio",
    state: "connected",
    detail: "Contract fixture connection",
    metadata: { connectedAccountId: "ca_1" },
  });
  store.bindCapability({ workspaceSlug: TENANT, pluginId: "github-composio", capability: "connector.observe", enabled: true });
  const consentFor = (agentId: string, consentId: string) =>
    store.createMarketplaceAgentConsent({
      portalIssuer: PORTAL,
      portalOrgId: "portal-org-1",
      productTenantId: TENANT,
      workspaceId: TENANT,
      deploymentId: "deployment-1",
      userId: "operator-1",
      agentId,
      consentId,
      consentRevision: 1,
      pluginId: "github-composio",
      actionKey: "github.list.repositories",
      capability: "connector.observe",
      connectionId: connection.id,
      accountId: "ca_1",
      resourceKind: "github.connected-account",
      resourceRef: "account:ca_1",
      capabilities: ["connector.observe"],
      requiredActions: ["read"],
    }).consent;
  const consents =
    input.seedConsents === false
      ? null
      : { own: consentFor("agent-1", "consent-1"), foreign: consentFor("agent-2", "consent-2") };
  return {
    app,
    store,
    grants,
    consents,
    consentFor,
    introspectCalls,
    redeemCalls,
    resetTickets: () => {
      launchTickets = new Set();
    },
    get providerCalls() {
      return providerCalls;
    },
    async close() {
      await app.close();
      store.close();
    },
  };
}

const call = (
  f: Awaited<ReturnType<typeof fixture>>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  token = GRANT_A,
) =>
  f.app.inject({
    method: "POST",
    url: "/api/marketplace/v1/agent/tools/call",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": "agent-key-0001", ...headers },
    payload: body,
  });

const toolsBody = {
  consentId: "consent-1",
  toolkit: "github-composio",
  action: "github.list.repositories",
  arguments: { per_page: 25 },
};

describe("tealbrick.app.json", () => {
  it("validates, is a suite with the agreed agent operations, and declares everything else owner-only", () => {
    expect(MARKETPLACE_MANIFEST.kind).toBe("suite");
    expect(MARKETPLACE_MANIFEST.app.id).toBe("marketplace");
    expect(MARKETPLACE_MANIFEST.runtime.tenantEnv).toBe("TEALBRICK_TENANT_ID");
    expect(MARKETPLACE_MANIFEST.runtime.claim).toBe("/.well-known/tealbrick/claim");
    const agent = MARKETPLACE_MANIFEST.operations.filter((operation) => operation.audience !== "owner");
    expect(agent.map((operation) => operation.id)).toEqual([
      AGENT_OPERATION.consentsList,
      AGENT_OPERATION.toolsCall,
      ...Object.values(CHANNEL_AGENT_OPERATION),
      AGENT_OPERATION.approvalsResolve,
    ]);
    expect(agent[0]).toMatchObject({ method: "GET", crud: ["read"], effects: "read-only" });
    // The contract requires an idempotency key for any operation that creates (validator rule).
    expect(agent[1]).toMatchObject({ method: "POST", crud: ["create"], effects: "external-effects", idempotency: "required" });
    const owner = MARKETPLACE_MANIFEST.operations.filter((operation) => operation.audience === "owner").map((operation) => operation.id);
    expect(owner).toEqual(expect.arrayContaining([
      "marketplace.consents.request",
      "marketplace.consents.redeem",
      "marketplace.consents.revoke",
      "marketplace.connections.connect",
      "marketplace.plugins.install",
      "marketplace.plugins.register",
      "marketplace.settings.update",
      "marketplace.approvals.approve",
    ]));
    expect(owner).toEqual(expect.arrayContaining([
      "marketplace.channels.discover",
      "marketplace.channels.create",
      "marketplace.channels.update",
      "marketplace.channels.test",
      "marketplace.channel-grants.approve",
      "marketplace.channel-posts.resolve",
      "marketplace.channel-receipts.purge",
    ]));
    // + 3: the owner Buzz approval key (marketplace.approval-owner-key.get|update|clear, Channels §6.3).
    // + 3: Channels inbound (marketplace.channel-inbound-routes.update, -events.list, -settings.update; P2 scope 2.2).
    // + 4: the Buzz identity (marketplace.channel-buzz-identity.get|update, -buzz-key.generate, -buzz-auth-tag.revoke).
    // + 4: routes v2 people (marketplace.channel-people-policy.get|update, marketplace.channel-people.list|revoke).
    expect(owner.length).toBe(16 + 16 + 3 + 3 + 4 + 4);
    // Channels: the account-sourced bot tokens (and the Slack signing secret) arrive as provider env, never stored by Portal.
    const channels = MARKETPLACE_MANIFEST.settings?.groups.find((group) => group.id === "channels");
    expect(channels?.fields.map((field) => [field.key, field.env])).toEqual([
      ["channels.telegram.botToken", "MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN"],
      ["channels.discord.botToken", "MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN"],
      ["channels.slack.botToken", "MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN"],
      ["channels.slack.signingSecret", "MARKETPLACE_CHANNELS_SLACK_SIGNING_SECRET"],
      ["channels.teams.appId", "MARKETPLACE_CHANNELS_TEAMS_APP_ID"],
      ["channels.teams.appSecret", "MARKETPLACE_CHANNELS_TEAMS_APP_SECRET"],
      ["channels.teams.tenantId", "MARKETPLACE_CHANNELS_TEAMS_TENANT_ID"],
      ["channels.teams.graphEnabled", "MARKETPLACE_CHANNELS_TEAMS_GRAPH_ENABLED"],
    ]);
    expect(channels?.fields.every((field) => field.destination === "provider-env")).toBe(true);
    // Secrets are account-sourced; the Teams app id, tenant id and Graph switch are plain (readable) provider env.
    const plain = new Set(["channels.teams.appId", "channels.teams.tenantId", "channels.teams.graphEnabled"]);
    for (const field of channels?.fields ?? []) {
      if (plain.has(field.key)) expect(field.source, field.key).toBeUndefined();
      else expect([field.key, field.type, field.source]).toEqual([field.key, "secret", "account"]);
    }
    expect(MARKETPLACE_MANIFEST.runtime.env?.allow).toEqual(expect.arrayContaining([
      "MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN",
      "MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN",
      "MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN",
      "MARKETPLACE_CHANNELS_SLACK_SIGNING_SECRET",
      "MARKETPLACE_CHANNELS_TEAMS_APP_ID",
      "MARKETPLACE_CHANNELS_TEAMS_APP_SECRET",
      "MARKETPLACE_CHANNELS_TEAMS_TENANT_ID",
      "MARKETPLACE_CHANNELS_TEAMS_GRAPH_ENABLED",
    ]));
  });

  it("maps every operation to a real route of the app", async () => {
    const f = await fixture({ seedConsents: false });
    for (const operation of MARKETPLACE_MANIFEST.operations) {
      const url = operation.path.replace(/\{([^}]+)\}/gu, ":$1");
      expect(f.app.hasRoute({ method: operation.method as "GET", url }), `${operation.id} ${operation.method} ${operation.path}`).toBe(true);
    }
    await f.close();
  });

  it("keeps its version on the release version", async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "tealbrick.app.json"), "utf8")) as { app: { version: string } };
    const program = JSON.parse(await readFile(path.join(repoRoot, "program/package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
    expect(manifest.app.version).toBe(program.version);
    expect(program.dependencies["@tealbrick/contract"]).toBe("0.1.0-alpha.7");
  });

  it("resolves launch routes against the manifest", () => {
    expect(resolveLaunchRoute(undefined)).toBe("/");
    expect(resolveLaunchRoute("")).toBe("/");
    expect(resolveLaunchRoute("/?view=settings")).toBe("/?view=settings");
    expect(resolveLaunchRoute("/?view=other")).toBeNull();
    expect(resolveLaunchRoute("//evil.example")).toBeNull();
    expect(resolveLaunchRoute("https://evil.example/")).toBeNull();
  });
});

describe("marketplace.consents.list", () => {
  it("returns only the calling agent's active consents, with no credential field", async () => {
    const f = await fixture();
    const own = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/consents", headers: { authorization: `Bearer ${GRANT_A}` } });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({
      ok: true,
      schema: 1,
      consents: [{ consentId: "consent-1", toolkit: "github-composio", actions: ["github.list.repositories"], state: "active" }],
    });
    expect(own.body).not.toContain("consent-2");
    expect(own.body).not.toContain("ca_1");
    expect(own.body).not.toContain("agent-2");
    const other = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/consents", headers: { authorization: `Bearer ${GRANT_B}` } });
    expect(other.json().consents.map((consent: { consentId: string }) => consent.consentId)).toEqual(["consent-2"]);

    f.store.revokeMarketplaceAgentConsent(f.consents!.own.id);
    const revoked = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/consents", headers: { authorization: `Bearer ${GRANT_A}` } });
    expect(revoked.json().consents).toEqual([]);
    await f.close();
  });

  it("refuses a missing, unknown or operator credential", async () => {
    const f = await fixture();
    const anonymous = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/consents" });
    expect(anonymous.statusCode).toBe(401);
    const unknown = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/consents", headers: { authorization: `Bearer tbag_${"z".repeat(43)}` } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: "grant_denied" });
    // The internal service bearer is not an agent: the route needs a Portal app grant.
    const service = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/consents", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(service.statusCode).toBe(403);
    expect(service.json()).toMatchObject({ error: "agent_grant_required" });
    await f.close();
  });
});

describe("marketplace.tools.call", () => {
  it("runs a consented action through the shared execution and replays an exact retry", async () => {
    const f = await fixture();
    const first = await call(f, toolsBody);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      ok: true,
      schema: 1,
      resultTrust: "untrusted-provider-data",
      result: { actionType: "github.list.repositories", simulated: false, details: { result: { access_token: "[redacted]" } } },
    });
    expect(first.headers["content-type"]).toContain("application/json");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body).not.toContain(GRANT_A);
    expect(first.body).not.toContain("test-composio-key");
    expect(f.providerCalls).toBe(1);

    const replay = await call(f, toolsBody);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, replayed: true });
    expect(f.providerCalls).toBe(1);

    const conflict = await call(f, { ...toolsBody, arguments: { per_page: 50 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "runtime_idempotency_conflict" });
    expect(f.providerCalls).toBe(1);

    const fresh = await call(f, toolsBody, { "idempotency-key": "agent-key-0002" });
    expect(fresh.statusCode).toBe(200);
    expect(f.providerCalls).toBe(2);

    // Same usage ledger and audit as the runtime receiver, marked with the path that proved the consent.
    const events = f.store.listAudit({ workspaceSlug: TENANT }) as Array<{ event_type: string; metadata: string }>;
    expect(events.some((row) => row.event_type === "marketplace.governance.owner_approved")).toBe(true);
    await f.close();
  });

  it("requires an Idempotency-Key and a bounded, well-formed body", async () => {
    const f = await fixture();
    const noKey = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/tools/call",
      headers: { authorization: `Bearer ${GRANT_A}` },
      payload: toolsBody,
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({ error: "idempotency_key_required" });
    const badKey = await call(f, toolsBody, { "idempotency-key": "short" });
    expect(badKey.statusCode).toBe(400);
    const extra = await call(f, { ...toolsBody, workspaceSlug: "other" });
    expect(extra.statusCode).toBe(400);
    expect(extra.json()).toMatchObject({ error: "validation_failed" });
    const big = await call(f, { ...toolsBody, arguments: { blob: "x".repeat(13_000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: "arguments_too_large" });
    const huge = await call(f, { ...toolsBody, arguments: { blob: "x".repeat(20_000) } });
    expect(huge.statusCode).toBe(413);
    expect(f.providerCalls).toBe(0);
    await f.close();
  });

  it("answers 404 for another principal's consent and for an unknown consent, with the same body", async () => {
    const f = await fixture();
    const foreign = await call(f, { ...toolsBody, consentId: "consent-2" });
    const unknown = await call(f, { ...toolsBody, consentId: "consent-does-not-exist" });
    expect(foreign.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ ok: false, error: "consent_not_found" });
    expect(unknown.json()).toEqual(foreign.json());
    // The other agent can use its own consent, but not agent-1's.
    const own = await call(f, { ...toolsBody, consentId: "consent-2" }, { "idempotency-key": "agent-key-b001" }, GRANT_B);
    expect(own.statusCode).toBe(200);
    const crossed = await call(f, { ...toolsBody, consentId: "consent-1" }, { "idempotency-key": "agent-key-b002" }, GRANT_B);
    expect(crossed.statusCode).toBe(404);
    expect(f.providerCalls).toBe(1);
    await f.close();
  });

  it("answers 403 consent_mismatch for a wrong toolkit, a wrong action or an inactive consent", async () => {
    const f = await fixture();
    const toolkit = await call(f, { ...toolsBody, toolkit: "slack-composio" });
    expect(toolkit.statusCode).toBe(403);
    expect(toolkit.json()).toMatchObject({ error: "consent_mismatch", reason: "toolkit" });
    const action = await call(f, { ...toolsBody, action: "github.delete.repository" });
    expect(action.statusCode).toBe(403);
    expect(action.json()).toMatchObject({ error: "consent_mismatch", reason: "action" });
    f.store.revokeMarketplaceAgentConsent(f.consents!.own.id);
    const inactive = await call(f, toolsBody);
    expect(inactive.statusCode).toBe(403);
    expect(inactive.json()).toMatchObject({ error: "consent_mismatch", reason: "inactive" });
    expect(f.providerCalls).toBe(0);
    await f.close();
  });

  it("does not run an operation the grant does not name", async () => {
    const f = await fixture();
    const denied = await call(f, toolsBody, {}, GRANT_LIST_ONLY);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "operation_not_granted" });
    expect(f.providerCalls).toBe(0);
    await f.close();
  });
});

describe("Portal not configured", () => {
  it("fails closed for an app grant, and keeps serving the unauthenticated health and manifest", async () => {
    const f = await fixture({ seedConsents: false, environment: { MARKETPLACE_PORTAL_DEPLOYMENT_ID: undefined } });
    const denied = await f.app.inject({ method: "GET", url: "/api/marketplace/v1/agent/consents", headers: { authorization: `Bearer ${GRANT_A}` } });
    expect(denied.statusCode).toBe(503);
    expect(denied.json()).toEqual({ error: "portal_unconfigured" });
    expect(f.introspectCalls).toHaveLength(0);
    const guidance = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/guidance/1", headers: { authorization: `Bearer ${GRANT_A}` } });
    expect(guidance.statusCode).toBe(503);
    await f.close();
  });

  it("serves the usage guidance to a live grant only", async () => {
    const f = await fixture({ seedConsents: false });
    const anonymous = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/guidance/1" });
    expect(anonymous.statusCode).toBe(401);
    const live = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/guidance/1", headers: { authorization: `Bearer ${GRANT_A}` } });
    expect(live.statusCode).toBe(200);
    expect(live.headers["content-type"]).toContain("text/markdown");
    expect(live.body).toContain("marketplace.tools.call");
    await f.close();
  });
});

describe("owner-only operations", () => {
  it("refuse every agent grant with operation_owner_only, and undeclared routes with operation_unknown", async () => {
    const f = await fixture();
    for (const operation of MARKETPLACE_MANIFEST.operations.filter((entry) => entry.audience === "owner")) {
      const url = operation.path.replace(/\{([^}]+)\}/gu, "github-composio");
      // Even a grant that lists the owner operation cannot reach it.
      const response = await f.app.inject({
        method: operation.method as "GET",
        url,
        headers: { authorization: `Bearer ${GRANT_ALL}`, ...(operation.method === "GET" ? {} : { "content-type": "application/json" }) },
        ...(operation.method === "GET" ? {} : { payload: {} }),
      });
      expect(response.statusCode, `${operation.id}`).toBe(403);
      expect(response.json(), `${operation.id}`).toEqual({ error: "operation_owner_only" });
    }
    const undeclared = await f.app.inject({ method: "GET", url: "/api/marketplace/plugins", headers: { authorization: `Bearer ${GRANT_ALL}` } });
    expect(undeclared.statusCode).toBe(403);
    expect(undeclared.json()).toEqual({ error: "operation_unknown" });
    await f.close();
  });

  it("stay available to the owner session and the service bearer", async () => {
    const f = await fixture();
    const settings = await f.app.inject({ method: "GET", url: "/api/settings/providers/composio" });
    // No cookie, no bearer: the owner routes are not open.
    expect(settings.statusCode).toBeGreaterThanOrEqual(401);
    const service = await f.app.inject({ method: "GET", url: "/api/marketplace/plugins?workspaceSlug=tenant-community", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(service.statusCode).toBe(200);
    await f.close();
  });
});

describe("both grant paths reach the same execution", () => {
  it("accepts a Portal runtime lease and a Portal app grant for one consent", async () => {
    const f = await fixture();
    const lease = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: `Bearer ${LEASE}` },
      payload: {
        schema: 1,
        consentId: "consent-1",
        selection: {
          pluginId: "github-composio",
          actionKey: "github.list.repositories",
          accountId: "ca_1",
          resourceKind: "github.connected-account",
          resourceRef: "account:ca_1",
        },
        input: { per_page: 25 },
        idempotencyKey: "runtime-op-1",
      },
    });
    expect(lease.statusCode).toBe(200);
    expect(lease.json()).toMatchObject({ ok: true, schema: 1 });
    const grant = await call(f, toolsBody);
    expect(grant.statusCode).toBe(200);
    expect(grant.json()).toMatchObject({ ok: true, schema: 1 });
    expect(Object.keys(grant.json()).sort()).toEqual([...Object.keys(lease.json()), "resultTrust"].sort());
    expect(f.providerCalls).toBe(2);
    const usage = f.store.listUsage({ workspaceSlug: TENANT }) as unknown as Array<{ metadata: { via?: string } }>;
    const via = usage.map((row) => row.metadata).filter((metadata) => metadata.via === "app-grant");
    expect(via).toHaveLength(1);
    expect(JSON.stringify(via)).not.toContain(GRANT_A);
    await f.close();
  });
});

describe("control endpoints", () => {
  it("serves health with the app identity, and the manifest without credentials", async () => {
    const f = await fixture({ seedConsents: false });
    const health = await f.app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toMatchObject({ ok: true, app: "marketplace", major: 1 });
    expect(health.body).not.toContain(TENANT);
    const manifest = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/manifest" });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({ schema: "tealbrick.miniapp/v1", kind: "suite", app: { id: "marketplace" } });
    await f.close();
  });

  it("answers status only to the Portal-held instance credentials", async () => {
    const f = await fixture({ seedConsents: false, environment: { TEALBRICK_INSTANCE_TOKEN: INSTANCE_TOKEN } });
    const anonymous = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/status" });
    expect(anonymous.statusCode).toBe(401);
    const wrong = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/status", headers: { authorization: "Bearer wrong-token-wrong-token-wrong-token" } });
    expect(wrong.statusCode).toBe(401);
    for (const headers of [
      { authorization: `Bearer ${SERVICE}` },
      { authorization: `Bearer ${INSTANCE_TOKEN}` },
      { "x-tealbrick-instance-proof": PROOF },
      { "x-knowledge-instance-token": SERVICE },
    ]) {
      const ok = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/status", headers });
      expect(ok.statusCode, JSON.stringify(Object.keys(headers))).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, app: "marketplace", setup: "configured" });
    }
    await f.close();
  });

  it("keeps the claim identity on both paths and accepts the contract instance token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-contract-claim-"));
    roots.push(root);
    const f = await fixture({ seedConsents: false, environment: { TEALBRICK_INSTANCE_TOKEN: INSTANCE_TOKEN }, options: { instanceClaimDir: root } });
    const identities = [];
    for (const url of ["/.well-known/tealbrick/claim", "/api/tealbrick/claim"]) {
      const response = await f.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${INSTANCE_TOKEN}` } });
      expect(response.statusCode).toBe(200);
      identities.push(response.json());
    }
    expect(identities[0]).toEqual(identities[1]);
    const legacy = await f.app.inject({ method: "GET", url: "/api/tealbrick/claim", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(legacy.json()).toEqual(identities[0]);
    const browser = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/claim", headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, origin: PORTAL } });
    expect(browser.statusCode).toBe(403);
    await f.close();
  });

  it("reports secret presence only, and writes the non-secret provider settings", async () => {
    const f = await fixture({ seedConsents: false });
    const headers = { authorization: `Bearer ${SERVICE}` };
    const read = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/settings", headers });
    expect(read.statusCode).toBe(200);
    expect(read.json().account).toEqual({
      "channels.discord.botToken": { set: false, source: "account" },
      "channels.slack.botToken": { set: false, source: "account" },
      "channels.slack.signingSecret": { set: false, source: "account" },
      "channels.teams.appSecret": { set: false, source: "account" },
      "channels.telegram.botToken": { set: false, source: "account" },
      "composio.apiKey": { source: "account", set: true } });
    expect(read.json().values).toMatchObject({ "channels.teams.appId": null, "channels.teams.tenantId": null, "channels.teams.graphEnabled": false });
    expect(read.body).not.toContain("test-composio-key");
    const revision = read.json().revision as string;
    const bad = await f.app.inject({ method: "PUT", url: "/.well-known/tealbrick/settings", headers, payload: { values: { "composio.baseUrl": "https://evil.example/api" } } });
    expect(bad.statusCode).toBe(400);
    const secretWrite = await f.app.inject({ method: "PUT", url: "/.well-known/tealbrick/settings", headers, payload: { values: { "composio.apiKey": "x".repeat(40) } } });
    expect(secretWrite.statusCode).toBe(400);
    const good = await f.app.inject({ method: "PUT", url: "/.well-known/tealbrick/settings", headers, payload: { ifRevision: revision, values: { "composio.defaultUserId": "workspace-user" } } });
    expect(good.statusCode).toBe(200);
    expect(good.json().values["composio.defaultUserId"]).toBe("workspace-user");
    expect(good.json().revision).not.toBe(revision);
    const stale = await f.app.inject({ method: "PUT", url: "/.well-known/tealbrick/settings", headers, payload: { ifRevision: revision, values: { "composio.defaultUserId": "again" } } });
    expect(stale.statusCode).toBe(409);
    await f.close();
  });

  it("serves companions as unbound without Rules and bound with Rules, in owner approval mode either way", async () => {
    const without = await fixture({ seedConsents: false });
    const headers = { authorization: `Bearer ${SERVICE}` };
    const unbound = await without.app.inject({ method: "GET", url: "/.well-known/tealbrick/companions", headers });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json().companions).toEqual([expect.objectContaining({ app: "rules-approvals", relation: "enhanced-by", bound: false })]);
    await without.close();
    const withRules = await fixture({ seedConsents: false, rules: true });
    const bound = await withRules.app.inject({ method: "GET", url: "/.well-known/tealbrick/companions", headers });
    expect(bound.json().companions).toEqual([expect.objectContaining({ app: "rules-approvals", bound: true })]);
    expect(bound.body).not.toContain("rules.fixture.invalid");
    await withRules.close();
  });
});

describe("Portal launch", () => {
  const launch = (f: Awaited<ReturnType<typeof fixture>>, payload: string, headers: Record<string, string> = {}) =>
    f.app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: { origin: PORTAL, "content-type": "application/x-www-form-urlencoded", ...headers },
      payload,
    });

  it("validates the route before spending the ticket, and hands the settings bearer to the settings route", async () => {
    const f = await fixture({ seedConsents: false });
    const ticket = "t".repeat(43);
    const bad = await launch(f, `ticket=${ticket}&route=${encodeURIComponent("/?view=nope")}`);
    expect(bad.statusCode).toBe(400);
    expect(f.redeemCalls).toHaveLength(0);
    const offsite = await launch(f, `ticket=${ticket}&route=${encodeURIComponent("//evil.example/")}`);
    expect(offsite.statusCode).toBe(400);

    const settings = await launch(f, `ticket=${ticket}&route=${encodeURIComponent("/?view=settings")}`);
    expect(settings.statusCode).toBe(303);
    const location = String(settings.headers.location);
    expect(location.startsWith("/?view=settings#tealbrick_settings_bearer=tbsb_")).toBe(true);
    expect(settings.headers["set-cookie"]).toContain("HttpOnly");
    const bearer = decodeURIComponent(/tealbrick_settings_bearer=([^&]+)/u.exec(location)![1]!);
    const read = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/settings", headers: { authorization: `Bearer ${bearer}` } });
    expect(read.statusCode).toBe(200);
    const status = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/status", headers: { authorization: `Bearer ${bearer}` } });
    expect(status.statusCode).toBe(200);

    f.resetTickets();
    const home = await launch(f, `ticket=${"u".repeat(43)}`);
    expect(home.statusCode).toBe(303);
    expect(home.headers.location).toBe("/");
    await f.close();
  });

  it("mints only a settings bearer for the server-side settings relay (no session, no Origin)", async () => {
    const f = await fixture({ seedConsents: false });
    const relay = await f.app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: { "content-type": "application/json" },
      payload: { ticket: "r".repeat(43), purpose: "settings" },
    });
    expect(relay.statusCode).toBe(200);
    expect(relay.headers["set-cookie"]).toBeUndefined();
    expect(relay.json()).toMatchObject({ tokenType: "Bearer", purpose: "settings", workspaceId: TENANT });
    const bearer = relay.json().settingsBearer as string;
    const write = await f.app.inject({ method: "PUT", url: "/.well-known/tealbrick/settings", headers: { authorization: `Bearer ${bearer}` }, payload: { values: { "composio.defaultUserId": "relay-user" } } });
    expect(write.statusCode).toBe(200);
    // No Origin and no settings purpose is not a Portal launch.
    const plain = await f.app.inject({ method: "POST", url: "/auth/launch", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: `ticket=${"q".repeat(43)}` });
    expect(plain.statusCode).toBe(403);
    // A foreign Origin is refused even for the relay.
    const foreign = await f.app.inject({ method: "POST", url: "/auth/launch", headers: { origin: "https://evil.example", "content-type": "application/json" }, payload: { ticket: "w".repeat(43), purpose: "settings" } });
    expect(foreign.statusCode).toBe(403);
    expect(f.redeemCalls).toHaveLength(1);
    await f.close();
  });

  it("keeps the previous behaviour for a bare ticket and for a wrong origin", async () => {
    const f = await fixture({ seedConsents: false });
    const wrongOrigin = await launch(f, `ticket=${"t".repeat(43)}`, { origin: "https://evil.example" });
    expect(wrongOrigin.statusCode).toBe(403);
    const withAuth = await launch(f, `ticket=${"t".repeat(43)}`, { authorization: "Bearer x" });
    expect(withAuth.statusCode).toBe(403);
    const junk = await launch(f, "ticket=short");
    expect(junk.statusCode).toBe(401);
    const extra = await launch(f, `ticket=${"t".repeat(43)}&other=1`);
    expect(extra.statusCode).toBe(401);
    await f.close();
  });
});

describe("tenant binding", () => {
  it("requires TEALBRICK_TENANT_ID to equal the Marketplace workspace binding", async () => {
    await expect(fixture({ environment: { TEALBRICK_TENANT_ID: "another-tenant" }, seedConsents: false })).rejects.toThrow(/TEALBRICK_TENANT_ID conflicts/u);
    const same = await fixture({ environment: { TEALBRICK_TENANT_ID: TENANT }, seedConsents: false });
    expect((await same.app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await same.close();
  });
});

describe("emergency access (contract 12.3.3)", () => {
  const CODE = generateEmergencyCode();

  it("is disabled without TEALBRICK_EMERGENCY_CODE", async () => {
    const f = await fixture({ seedConsents: false });
    const response = await f.app.inject({ method: "POST", url: "/auth/emergency", headers: { "content-type": "application/json" }, payload: { code: CODE } });
    expect(response.statusCode).toBe(404);
    const session = await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session" });
    expect(session.json().session.emergencyLogin).toBeUndefined();
    await f.close();
  });

  it("signs the owner in with the code, shows the banner, protects changes with a CSRF token and audits it", async () => {
    const f = await fixture({
      seedConsents: false,
      environment: { TEALBRICK_EMERGENCY_CODE: CODE },
      operatorSessionManager: new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234", operatorId: "operator-1", organizationId: TENANT }),
    });
    const before = await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session" });
    expect(before.json().session).toMatchObject({ authenticated: false, emergencyLogin: true });
    const wrong = await f.app.inject({ method: "POST", url: "/auth/emergency", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" }, payload: { code: "not-the-code" } });
    expect(wrong.statusCode).toBe(401);
    const login = await f.app.inject({ method: "POST", url: "/auth/emergency", headers: { "content-type": "application/json", accept: "application/json", "x-forwarded-for": "198.51.100.7" }, payload: { code: CODE } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    expect(cookie).toContain("tealbrick-emergency=");

    const session = await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session", headers: { cookie } });
    const body = session.json().session;
    expect(body).toMatchObject({ authenticated: true, mode: "emergency", principal: { kind: "operator", id: "emergency-owner", organizationId: TENANT } });
    expect(body.emergency.banner).toContain("Emergency access");
    expect(body.csrfToken).toBeTruthy();

    const read = await f.app.inject({ method: "GET", url: "/api/settings/providers/composio", headers: { cookie } });
    expect(read.statusCode).toBe(200);
    const noCsrf = await f.app.inject({ method: "DELETE", url: "/api/settings/providers/composio/key", headers: { cookie, origin: "https://marketplace.fixture.invalid" } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json()).toMatchObject({ error: "marketplace_csrf_denied" });
    const withCsrf = await f.app.inject({ method: "DELETE", url: "/api/settings/providers/composio/key", headers: { cookie, origin: "https://marketplace.fixture.invalid", "x-csrf-token": body.csrfToken } });
    expect(withCsrf.statusCode).not.toBe(403);

    // The audit holds the outcome and a client hash, never the code.
    const audit = (f.store.listAudit({ workspaceSlug: TENANT }) as Array<{ event_type: string; metadata: string }>).filter((row) => row.event_type === "marketplace.auth.emergency_login");
    expect(audit.map((row) => JSON.parse(row.metadata).outcome).sort()).toEqual(["denied", "success"]);
    expect(JSON.stringify(audit)).not.toContain(CODE);

    const logout = await f.app.inject({ method: "POST", url: "/auth/emergency/logout", headers: { cookie } });
    expect(logout.statusCode).toBeLessThan(400);
    const after = await f.app.inject({ method: "GET", url: "/api/settings/providers/composio", headers: { cookie } });
    expect(after.statusCode).toBe(401);
    await f.close();
  });

  it("lets the emergency owner reach the settings endpoint while Portal is down", async () => {
    const f = await fixture({ seedConsents: false, environment: { TEALBRICK_EMERGENCY_CODE: CODE } });
    const login = await f.app.inject({ method: "POST", url: "/auth/emergency", headers: { "content-type": "application/json", accept: "application/json" }, payload: { code: CODE } });
    const token = (login.json() as { sessionToken: string }).sessionToken;
    const read = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/settings", headers: { authorization: `Bearer ${token}` } });
    expect(read.statusCode).toBe(200);
    // The same bearer is an owner session for the app API too (no CSRF needed: a bearer is not ambient).
    const owner = await f.app.inject({ method: "GET", url: "/api/settings/providers/composio", headers: { authorization: `Bearer ${token}` } });
    expect(owner.statusCode).toBe(200);
    await f.close();
  });
});

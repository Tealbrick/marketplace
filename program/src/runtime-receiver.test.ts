import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import {
  PortalRuntimeScopeError,
  type PortalRuntimeScopeVerifier,
} from "./portal-runtime-scope.js";
import { SqliteMarketplaceStore } from "./store.js";
import { runtimeAuditRows, seamSnapshot } from "./testing/seam-snapshot.js";
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
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-runtime-receiver-"));
  tempRoots.push(root);
  return path.join(root, "marketplace.sqlite");
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(input: {
  /** "none" builds without a Rules client (owner approval mode). */
  rulesEffect?: "allow" | "deny" | "no-match" | "none";
  runtimeVerifier?: PortalRuntimeScopeVerifier;
}) {
  const store = new SqliteMarketplaceStore(await tempDbPath());
  let providerCalls = 0;
  const rulesCalls: Array<Record<string, unknown>> = [];
  const scope = {
    portalOrgId: "portal-org-1",
    productTenantId: "tenant-community",
    workspaceId: "tenant-community",
    deploymentId: "deployment-1",
    agentId: "agent-1",
    consentId: "consent-1",
    leaseId: "lease-1",
    capabilities: ["connector.observe"],
    expiresAt: Date.now() + 300_000,
  };
  const runtimeVerifier = input.runtimeVerifier ?? (async () => scope);
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: "marketplace-service-secret",
    organizationId: "tenant-community",
    environment: {
      MARKETPLACE_ORGANIZATION_ID: "tenant-community",
      MARKETPLACE_PORTAL_URL: "https://portal.test/",
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: "p".repeat(43),
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: "tenant-community",
    },
    portalRuntimeScopeVerifier: runtimeVerifier,
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    providerFetch: async (input) => {
      if (String(input).includes("/tools/execute/GITHUB_LIST_REPOSITORIES")) {
        providerCalls += 1;
        return new Response(
          JSON.stringify({
            data: [{ name: "marketplace" }],
            access_token: "provider-secret-fixture",
          }),
          {
          status: 200,
          },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
    rulesClient: input.rulesEffect === "none" ? undefined : async (rulesInput) => {
      rulesCalls.push(rulesInput as unknown as Record<string, unknown>);
      return (input.rulesEffect === "deny" || input.rulesEffect === "no-match") &&
        (rulesInput.payload as Record<string, unknown> | undefined)?.phase === "execute"
        ? {
            effect: "deny",
            ...(input.rulesEffect === "no-match"
              ? { reason: "gateway request denied: no live ruleset matched this request" }
              : { decisionId: "rules-runtime-deny" }),
          }
        : { effect: "allow", decisionId: "rules-runtime-allow" };
    },
  });
  const imported = await app.inject({
    method: "POST",
    url: "/api/marketplace/catalog/composio/import",
    headers: { authorization: "Bearer marketplace-service-secret" },
    payload: {
      workspaceSlug: "tenant-community",
      actorId: "operator",
      toolkit: "github",
      pluginId: "github-composio",
      tools: [{ name: "GITHUB_LIST_REPOSITORIES" }],
      autoEnable: true,
    },
  });
  expect(imported.statusCode).toBe(201);
  const connection = store.upsertConnection({
    workspaceSlug: "tenant-community",
    pluginId: "github-composio",
    provider: "github",
    backend: "composio",
    state: "connected",
    detail: "Paired runtime fixture connection",
    metadata: { connectedAccountId: "ca_1" },
  });
  store.bindCapability({
    workspaceSlug: "tenant-community",
    pluginId: "github-composio",
    capability: "connector.observe",
    enabled: true,
  });
  const consent = store.createMarketplaceAgentConsent({
    portalIssuer: "https://portal.test",
    portalOrgId: scope.portalOrgId,
    productTenantId: scope.productTenantId,
    workspaceId: scope.workspaceId,
    deploymentId: scope.deploymentId,
    userId: "operator-1",
    agentId: scope.agentId,
    consentId: scope.consentId,
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
  });
  return {
    app,
    store,
    scope,
    consent: consent.consent,
    get providerCalls() {
      return providerCalls;
    },
    rulesCalls,
    async close() {
      await app.close();
      store.close();
    },
  };
}

const requestBody = {
  schema: 1,
  consentId: "consent-1",
  selection: {
    pluginId: "github-composio",
    actionKey: "github.list.repositories",
    accountId: "ca_1",
    resourceKind: "github.connected-account",
    resourceRef: "account:ca_1",
  },
  input: { per_page: 25, visibility: "all" },
  idempotencyKey: "runtime-op-1",
};

describe("Marketplace v1.1 runtime receiver", () => {
  it("accepts only the Portal lease bearer, introspects online, and reconciles exact retries", async () => {
    const f = await fixture({ rulesEffect: "allow" });
    const missing = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      payload: requestBody,
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ error: "runtime_lease_required" });

    const service = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer marketplace-service-secret" },
      payload: requestBody,
    });
    expect(service.statusCode).toBe(401);
    expect(service.json()).toMatchObject({ error: "runtime_service_bearer_forbidden" });

    const allowed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: requestBody,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      ok: true,
      schema: 1,
      result: {
        actionType: "github.list.repositories",
        simulated: false,
        details: { result: { access_token: "[redacted]" } },
      },
    });
    expect(allowed.body).not.toContain("marketplace-service-secret");
    expect(f.providerCalls).toBe(1);
    expect(f.rulesCalls.at(-1)).toMatchObject({
      operation: "execute",
      actorId: "agent:agent-1",
      payload: expect.objectContaining({
        consentId: "consent-1",
        leaseId: "lease-1",
      }),
    });

    const replay = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: requestBody,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, replayed: true });
    expect(f.providerCalls).toBe(1);
    await f.close();
  });

  it("executes a Portal consent + lease in owner approval mode, audited", async () => {
    const f = await fixture({ rulesEffect: "none" });
    const allowed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: requestBody,
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ ok: true, schema: 1 });
    expect(f.providerCalls).toBe(1);
    const audit = (f.store.listAudit({ workspaceSlug: "tenant-community" }) as Array<{
      event_type: string;
      actor_id: string | null;
      rules_decision_id: string | null;
      metadata: string;
    }>).find((row) => row.event_type === "marketplace.governance.owner_approved" && row.actor_id === "agent:agent-1");
    expect(audit).toMatchObject({
      rules_decision_id: "owner-governed:portal-consent:execute:github-composio",
    });
    expect(JSON.parse(audit!.metadata)).toMatchObject({
      governance: "owner",
      actorKind: "agent",
      attestation: "runtime-lease",
      capability: "connector.observe",
    });
    expect(audit!.metadata).not.toContain("lease-1");
    await f.close();
  });

  it("returns the bounded receiver error contract for malformed and oversized requests", async () => {
    const f = await fixture({ rulesEffect: "allow" });
    const malformed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: { ...requestBody, unexpected: true },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      ok: false,
      schema: 1,
      error: "runtime_validation_failed",
    });

    const oversized = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: { ...requestBody, input: { oversized: "x".repeat(17_000) } },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      ok: false,
      schema: 1,
      error: "runtime_request_too_large",
    });
    expect(f.providerCalls).toBe(0);
    await f.close();
  });

  it("introspects with Portal's canonical selection shape whatever the agent spelled", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const scope = {
      portalOrgId: "portal-org-1",
      productTenantId: "tenant-community",
      workspaceId: "tenant-community",
      deploymentId: "deployment-1",
      agentId: "agent-1",
      consentId: "consent-1",
      leaseId: "lease-1",
      capabilities: ["connector.observe"],
      expiresAt: Date.now() + 300_000,
    };
    const f = await fixture({
      rulesEffect: "allow",
      runtimeVerifier: async (input) => {
        seen.push({ ...input.selection });
        return scope;
      },
    });
    // Explicit observe introspects as the v1.1 shape Portal stored on the consent.
    const explicitObserve = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: {
        ...requestBody,
        idempotencyKey: "runtime-op-explicit-observe",
        selection: { ...requestBody.selection, capability: "connector.observe" },
      },
    });
    expect(explicitObserve.statusCode).toBe(200);
    expect(seen.at(-1)).toEqual(requestBody.selection);
    expect(Object.hasOwn(seen.at(-1)!, "capability")).toBe(false);
    // Non-observe capabilities keep the v1.2 key so Portal can match them exactly.
    await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: {
        ...requestBody,
        idempotencyKey: "runtime-op-dispatch",
        selection: { ...requestBody.selection, capability: "connector.dispatch" },
      },
    });
    expect(seen.at(-1)).toEqual({ ...requestBody.selection, capability: "connector.dispatch" });
    await f.close();
  });

  it("fails closed on Rules denial, local revoke, and Portal outage", async () => {
    const denied = await fixture({ rulesEffect: "deny" });
    const rulesResponse = await denied.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: requestBody,
    });
    expect(rulesResponse.statusCode).toBe(403);
    expect(rulesResponse.json()).toMatchObject({ error: "rules_denied" });
    expect(denied.providerCalls).toBe(0);
    await denied.close();

    const noMatch = await fixture({ rulesEffect: "no-match" });
    const noMatchResponse = await noMatch.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: { ...requestBody, idempotencyKey: "runtime-op-no-match" },
    });
    expect(noMatchResponse.statusCode).toBe(403);
    expect(noMatchResponse.json()).toMatchObject({ error: "rules_denied" });
    expect(noMatch.rulesCalls.at(-1)).toMatchObject({
      operation: "execute",
      actorId: "agent:agent-1",
      payload: expect.objectContaining({
        contractVersion: "tealbrick.marketplace.operator-handoff.v1.1",
        phase: "execute",
      }),
    });
    expect(noMatch.providerCalls).toBe(0);
    await noMatch.close();

    const revoked = await fixture({ rulesEffect: "allow" });
    const revoke = await revoked.app.inject({
      method: "POST",
      url: `/api/marketplace/agent/grants/${revoked.consent.id}/revoke`,
      headers: { authorization: "Bearer marketplace-service-secret" },
    });
    expect(revoke.statusCode).toBe(200);
    const afterRevoke = await revoked.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: { ...requestBody, idempotencyKey: "runtime-op-revoked" },
    });
    expect(afterRevoke.statusCode).toBe(403);
    expect(afterRevoke.json()).toMatchObject({ error: "runtime_consent_revoked" });
    expect(revoked.providerCalls).toBe(0);
    await revoked.close();

    const outage = await fixture({
      rulesEffect: "allow",
      runtimeVerifier: async () => {
        throw new PortalRuntimeScopeError("portal_runtime_unavailable", 503, "offline");
      },
    });
    const outageResponse = await outage.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: { ...requestBody, idempotencyKey: "runtime-op-outage" },
    });
    expect(outageResponse.statusCode).toBe(503);
    expect(outageResponse.json()).toMatchObject({ error: "portal_runtime_unavailable" });
    expect(outage.providerCalls).toBe(0);
    await outage.close();
  });
});

describe("executeConsentedCall execution targets", () => {
  it("keeps the response, usage-ledger row and audit rows of the Composio target", async () => {
    const f = await fixture({ rulesEffect: "allow" });
    const executed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/runtime/composio/execute",
      headers: { authorization: "Bearer portal-lease" },
      payload: requestBody,
    });
    expect(executed.statusCode, executed.body).toBe(200);
    expect(seamSnapshot({
      response: executed.json(),
      ledger: f.store.listUsage({ workspaceSlug: "tenant-community" }),
      audit: runtimeAuditRows(f.store.listAudit({ workspaceSlug: "tenant-community", limit: 500 }) as unknown[], "github-composio"),
    })).toMatchSnapshot("composio");
    await f.close();
  });
});

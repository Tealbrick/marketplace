import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];

async function buildSecureApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-auth-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: "marketplace-service-token-1234",
    organizationId: "verified-org",
    operatorSessionManager: new MarketplaceOperatorSessionManager({
      accessToken: "marketplace-operator-token-1234",
      operatorId: "verified-operator",
      organizationId: "verified-org",
    }),
    env: { COMPOSIO_API_KEY: "provider-secret-canary" },
  });
  return { app, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Marketplace operator and service authorization", () => {
  it("keeps domain data private while public bootstrap remains redacted", async () => {
    const { app, store } = await buildSecureApp();

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/marketplace/cards/summary?workspaceSlug=spoofed",
    });
    expect(anonymous.statusCode).toBe(401);

    const bootstrap = await app.inject({ method: "GET", url: "/bootstrap.json" });
    expect(bootstrap.statusCode).toBe(200);
    expect(JSON.stringify(bootstrap.json())).not.toContain("provider-secret-canary");
    expect(JSON.stringify(bootstrap.json())).not.toContain("marketplace-service-token-1234");

    const serviceRead = await app.inject({
      method: "GET",
      url: "/api/marketplace/cards/summary?workspaceSlug=spoofed",
      headers: { authorization: "Bearer marketplace-service-token-1234" },
    });
    expect(serviceRead.statusCode).toBe(200);
    expect(serviceRead.json()).toMatchObject({ workspaceSlug: "verified-org" });

    const serviceSettings = await app.inject({
      method: "GET",
      url: "/api/settings/providers/composio",
      headers: { authorization: "Bearer marketplace-service-token-1234" },
    });
    expect(serviceSettings.statusCode).toBe(403);

    await app.close();
    store.close();
  });

  it("exchanges an operator token for an HttpOnly session and enforces Origin plus CSRF", async () => {
    const { app, store } = await buildSecureApp();
    const deniedOrigin = await app.inject({
      method: "POST",
      url: "/api/marketplace/auth/session",
      headers: { origin: "https://attacker.invalid" },
      payload: { accessToken: "marketplace-operator-token-1234" },
    });
    expect(deniedOrigin.statusCode).toBe(403);

    const unlocked = await app.inject({
      method: "POST",
      url: "/api/marketplace/auth/session",
      headers: { origin: "http://127.0.0.1:5314" },
      payload: { accessToken: "marketplace-operator-token-1234" },
    });
    expect(unlocked.statusCode).toBe(200);
    const cookie = unlocked.headers["set-cookie"] as string;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const csrfToken = unlocked.json().session.csrfToken as string;

    const scoped = await app.inject({
      method: "GET",
      url: "/api/marketplace/cards/summary?workspaceSlug=spoofed",
      headers: { cookie },
    });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json()).toMatchObject({ workspaceSlug: "verified-org" });

    const missingCsrf = await app.inject({
      method: "PUT",
      url: "/api/settings/providers/composio",
      headers: { cookie, origin: "http://127.0.0.1:5314" },
      payload: {
        settings: {
          composioBaseUrl: "https://backend.composio.dev/api/v3.1",
          composioDefaultUserId: "verified-org",
          composioDefaultConnectedAccountId: "",
        },
      },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: "marketplace_csrf_denied" });

    const providerTakeover = await app.inject({
      method: "PUT",
      url: "/api/settings/providers/composio",
      headers: {
        cookie,
        origin: "http://127.0.0.1:5314",
        "x-csrf-token": csrfToken,
      },
      payload: {
        settings: {
          composioBaseUrl: "https://attacker.invalid/api/v3.1",
          composioDefaultUserId: "verified-org",
          composioDefaultConnectedAccountId: "",
        },
      },
    });
    expect(providerTakeover.statusCode).toBe(400);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/providers/composio",
      headers: {
        cookie,
        origin: "http://127.0.0.1:5314",
        "x-csrf-token": csrfToken,
      },
      payload: {
        settings: {
          composioBaseUrl: "https://backend.composio.dev/api/v3.1",
          composioDefaultUserId: "verified-org",
          composioDefaultConnectedAccountId: "",
        },
      },
    });
    expect(saved.statusCode).toBe(200);

    const loggedOut = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/auth/session",
      headers: {
        cookie,
        origin: "http://127.0.0.1:5314",
        "x-csrf-token": csrfToken,
      },
    });
    expect(loggedOut.statusCode).toBe(200);

    const expired = await app.inject({ method: "GET", url: "/api/marketplace/audit", headers: { cookie } });
    expect(expired.statusCode).toBe(401);

    await app.close();
    store.close();
  });

  it("lets the operator session drive Portal grant request/redeem without browser credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-handoff-auth-"));
    roots.push(root);
    const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
    const requestId = "r".repeat(43);
    const consentId = "portal_consent_1";
    const selection = {
      pluginId: "github-composio" as const,
      actionKey: "github.list.repositories" as const,
      accountId: "ca_1",
      resourceKind: "github.connected-account" as const,
      resourceRef: "account:ca_1",
    };
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "marketplace-service-token-1234",
      organizationId: "verified-org",
      operatorSessionManager: new MarketplaceOperatorSessionManager({
        accessToken: "marketplace-operator-token-1234",
        operatorId: "verified-operator",
        organizationId: "verified-org",
      }),
      portalIssuerUrl: "https://portal.test",
      portalInstanceProof: "p".repeat(43),
      portalFetch: async (input) => {
        if (String(input).endsWith("/api/deployment-browser/grant-request")) {
          return new Response(
            JSON.stringify({
              requestId,
              approvalUrl: `https://portal.test/portal?requestId=${requestId}`,
              expiresAt: Date.now() + 600_000,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            schema: 1,
            authorized: true,
            product: "marketplace",
            portalOrgId: "portal-org",
            productTenantId: "verified-org",
            workspaceId: "workspace-1",
            deploymentId: "deployment-1",
            userId: "owner-1",
            agentId: "agent-1",
            consentId,
            consentRevision: 1,
            state: "active",
            capabilities: ["connector.observe"],
            requiredActions: ["read"],
            selection,
          }),
          { status: 200 },
        );
      },
      rulesClient: async () => ({ effect: "allow", decisionId: "rules-allow" }),
      env: { COMPOSIO_API_KEY: "provider-secret-canary" },
    });
    store.upsertPortalHandoffSession({
      portalIssuer: "https://portal.test",
      deploymentId: "deployment-1",
      portalOrgId: "portal-org",
      productTenantId: "verified-org",
      workspaceId: "workspace-1",
      userId: "owner-1",
      sessionToken: "s".repeat(43),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const imported = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      headers: { authorization: "Bearer marketplace-service-token-1234" },
      payload: {
        workspaceSlug: "verified-org",
        actorId: "operator",
        toolkit: "github",
        pluginId: "github-composio",
        tools: [{ name: "GITHUB_LIST_REPOSITORIES" }],
        autoEnable: true,
      },
    });
    expect(imported.statusCode).toBe(201);
    const connection = store.upsertConnection({
      workspaceSlug: "verified-org",
      pluginId: "github-composio",
      provider: "github",
      backend: "composio",
      state: "connected",
      detail: "Fixture connection",
      metadata: { connectedAccountId: "ca_1" },
    });
    store.bindCapability({
      workspaceSlug: "verified-org",
      pluginId: "github-composio",
      capability: "connector.observe",
      enabled: true,
    });
    expect(connection.id).toBeTruthy();

    const unlocked = await app.inject({
      method: "POST",
      url: "/api/marketplace/auth/session",
      headers: { origin: "http://127.0.0.1:5314" },
      payload: { accessToken: "marketplace-operator-token-1234" },
    });
    const cookie = unlocked.headers["set-cookie"] as string;
    const csrfToken = unlocked.json().session.csrfToken as string;
    const browserHeaders = {
      cookie,
      origin: "http://127.0.0.1:5314",
      "x-csrf-token": csrfToken,
    };
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: { cookie, origin: "http://127.0.0.1:5314" },
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection, idempotencyKey: "browser-request-1" },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ error: "marketplace_csrf_denied" });

    const requested = await app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: browserHeaders,
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection, idempotencyKey: "browser-request-1" },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({
      authority: "marketplace_operator_session",
      request: { requestId, approvalUrl: `https://portal.test/portal?requestId=${requestId}` },
      projection: { requestId, state: "pending" },
    });
    expect(requested.body).not.toContain("s".repeat(43));

    const projection = await app.inject({
      method: "GET",
      url: "/api/marketplace/agent/grants?workspaceSlug=verified-org&agentId=agent-1",
      headers: { cookie },
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toMatchObject({
      handoffRequests: [{ requestId, approvalUrl: `https://portal.test/portal?requestId=${requestId}`, state: "pending" }],
    });

    const redeemed = await app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/redeem",
      headers: browserHeaders,
      payload: { deploymentId: "deployment-1", requestId },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toMatchObject({
      authority: "marketplace_operator_session",
      projection: { requestId, consentId, state: "redeemed" },
    });
    expect(redeemed.body).not.toContain("s".repeat(43));
    expect(redeemed.body).not.toContain("p".repeat(43));

    await app.close();
    store.close();
  });
});

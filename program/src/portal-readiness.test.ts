import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { SqliteMarketplaceStore } from "./store.js";

const tempRoots: string[] = [];

async function tempDbPath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-portal-readiness-"));
  tempRoots.push(root);
  return path.join(root, "marketplace.sqlite");
}

const environment = {
  MARKETPLACE_ORGANIZATION_ID: "tenant-community",
  MARKETPLACE_PUBLIC_ORIGIN: "https://marketplace.fixture.invalid",
  MARKETPLACE_PORTAL_URL: "https://portal.fixture.invalid",
  MARKETPLACE_PORTAL_INSTANCE_TOKEN: "p".repeat(43),
  MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
  MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
  MARKETPLACE_PORTAL_WORKSPACE_ID: "tenant-community",
};

const scopedPrincipal = {
  kind: "scoped-evaluation",
      credentialId: "rules-gateway-marketplace-fixture",
  companyId: "tenant-community",
  workspaceSlug: "tenant-community",
  clientId: "marketplace",
  targetKind: "plugin",
  allowedMethods: ["doppelganger.rules.evaluate"],
  allowedRuleKeys: ["marketplace.plugin"],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  active: true,
};

const attestedPrincipal = {
  active: true,
  kind: "scoped-evaluation",
  credentialId: scopedPrincipal.credentialId,
  companyId: scopedPrincipal.companyId,
  workspaceSlug: scopedPrincipal.workspaceSlug,
  clientId: "marketplace",
  targetKind: "plugin",
  allowedMethods: ["doppelganger.rules.evaluate"],
  allowedRuleKeys: ["marketplace.plugin"],
  expiresAt: scopedPrincipal.expiresAt,
};

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Portal readiness receiver", () => {
  it("requires instance proof and attests the live scoped Rules principal without business allow", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const requests: Array<{ url: string; authorization?: string }> = [];
    const app = await buildMarketplaceApp({
      store,
      environment,
      rules: {
        baseUrl: "https://rules.fixture.invalid",
        internalAuthToken: "rules-scoped-secret-fixture",
        companyId: "tenant-community",
      },
      providerFetch: async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        });
        return new Response(JSON.stringify({ ok: true, principal: scopedPrincipal }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const missing = await app.inject({ method: "GET", url: "/api/portal/readiness" });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "GET",
      url: "/api/portal/readiness",
      headers: { "x-tealbrick-instance-proof": "wrong-proof" },
    });
    expect(wrong.statusCode).toBe(401);

    const ready = await app.inject({
      method: "GET",
      url: "/api/portal/readiness",
      headers: { "x-tealbrick-instance-proof": environment.MARKETPLACE_PORTAL_INSTANCE_TOKEN },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      schema: 2,
      product: "marketplace",
      deploymentId: "deployment-1",
      orgId: "portal-org-1",
      workspaceId: "tenant-community",
      productTenantId: "tenant-community",
      publicOrigin: "https://marketplace.fixture.invalid",
      portal: {
        configured: true,
        baseUrl: "https://portal.fixture.invalid",
        instanceProofHeader: "x-tealbrick-instance-proof",
      },
      tenant: { configured: true, productTenantId: "tenant-community" },
      auth: { configured: true, instanceProofHeader: "x-tealbrick-instance-proof" },
      rules: {
        configured: true,
        reachable: true,
        probe: "principal",
        effect: null,
        principal: { ready: true, principal: attestedPrincipal },
      },
    });
    expect(ready.body).not.toContain("rules-scoped-secret-fixture");
    expect(requests).toEqual([
      {
        url: "https://rules.fixture.invalid/api/rules/gateway/introspect",
        authorization: "Bearer rules-scoped-secret-fixture",
      },
    ]);
  });

  it("does not attest a foreign or expired Rules principal", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    let response = { ok: true, principal: { ...scopedPrincipal, companyId: "foreign" } };
    const app = await buildMarketplaceApp({
      store,
      environment,
      rules: {
        baseUrl: "https://rules.fixture.invalid",
        internalAuthToken: "rules-scoped-secret-fixture",
        companyId: "tenant-community",
      },
      providerFetch: async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    const foreign = await app.inject({
      method: "GET",
      url: "/api/portal/readiness",
      headers: { "x-tealbrick-instance-proof": environment.MARKETPLACE_PORTAL_INSTANCE_TOKEN },
    });
    expect(foreign.statusCode).toBe(503);
    expect(foreign.json()).toMatchObject({
      ok: false,
      error: "portal_readiness_rules_principal_invalid",
    });

    response = {
      ok: true,
      principal: { ...scopedPrincipal, expiresAt: new Date(Date.now() - 1_000).toISOString() },
    };
    const expired = await app.inject({
      method: "GET",
      url: "/api/portal/readiness",
      headers: { "x-tealbrick-instance-proof": environment.MARKETPLACE_PORTAL_INSTANCE_TOKEN },
    });
    expect(expired.statusCode).toBe(503);
    expect(expired.json()).toMatchObject({
      ok: false,
      error: "portal_readiness_rules_principal_invalid",
    });
  });
});

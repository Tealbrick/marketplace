import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp, type BuildMarketplaceAppOptions } from "./app.js";
import { MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { RULES_INTROSPECTION_PATH } from "./rules-readiness.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];
const SERVICE = "marketplace-service-token-1234";

async function build(extra: Partial<BuildMarketplaceAppOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-health-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: "tenant-1",
    operatorSessionManager: new MarketplaceOperatorSessionManager({
      accessToken: "marketplace-operator-token-1234",
      operatorId: "operator-1",
      organizationId: "tenant-1",
    }),
    env: {},
    ...extra,
  });
  const close = async () => { await app.close(); store.close(); };
  return { app, close };
}

const principal = () => ({
  ok: true,
  principal: {
    active: true,
    kind: "scoped-evaluation",
    credentialId: "cred-1",
    companyId: "tenant-1",
    workspaceSlug: "tenant-1",
    clientId: "marketplace",
    targetKind: "plugin",
    allowedMethods: ["doppelganger.rules.evaluate"],
    allowedRuleKeys: ["marketplace.plugin"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authenticated runtime health", () => {
  it("requires a session or service bearer", async () => {
    const { app, close } = await build();
    const anonymous = await app.inject({ method: "GET", url: "/api/marketplace/health" });
    expect(anonymous.statusCode).toBe(401);
    await close();
  });

  it("reports not-connected when no Rules client is configured", async () => {
    const { app, close } = await build();
    const response = await app.inject({ method: "GET", url: "/api/marketplace/health", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, program: "ok", rules: "not-connected" });
    await close();
  });

  it("reports connected after a valid Rules principal probe and unavailable when Rules fails", async () => {
    let healthy = true;
    const calls: string[] = [];
    const { app, close } = await build({
      rulesClient: async () => ({ effect: "allow", decisionId: "d-1" }) as never,
      rules: { baseUrl: "https://rules.fixture.invalid", internalAuthToken: "rules-token" },
      providerFetch: async (input) => {
        calls.push(new URL(String(input)).pathname);
        return healthy
          ? new Response(JSON.stringify(principal()), { status: 200 })
          : new Response("down", { status: 502 });
      },
    });
    const first = await app.inject({ method: "GET", url: "/api/marketplace/health", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(first.json()).toMatchObject({ rules: "connected" });
    expect(calls).toEqual([RULES_INTROSPECTION_PATH]);
    expect(first.body).not.toContain("rules-token");
    expect(first.body).not.toContain("rules.fixture.invalid");
    await close();

    healthy = false;
    const down = await build({
      rulesClient: async () => ({ effect: "allow", decisionId: "d-1" }) as never,
      rules: { baseUrl: "https://rules.fixture.invalid", internalAuthToken: "rules-token" },
      providerFetch: async () => new Response("down", { status: 502 }),
    });
    const response = await down.app.inject({ method: "GET", url: "/api/marketplace/health", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(response.json()).toMatchObject({ rules: "unavailable" });
    await down.close();
  });
});

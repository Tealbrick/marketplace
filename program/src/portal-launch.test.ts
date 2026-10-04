import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Portal browser launch", () => {
  it("redeems the form POST through the server-held Portal identity and rejects replay, origin, and scope failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-portal-launch-"));
    roots.push(root);
    const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), {
      handoffEncryptionKey: "a".repeat(64),
    });
    const ticket = "t".repeat(43);
    const session = "s".repeat(43);
    let redeemed = false;
    let returnedDeploymentId = "deployment-1";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = await buildMarketplaceApp({
      store,
      organizationId: "tenant-1",
      portalIssuerUrl: "https://portal.fixture.invalid",
      portalInstanceProof: "p".repeat(43),
      portalFetch: async (input, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        calls.push({ url: String(input), body });
        if (redeemed) {
          return new Response(JSON.stringify({ error: "invalid_browser_session" }), { status: 401 });
        }
        redeemed = true;
        return new Response(
          JSON.stringify({
            schema: 1,
            authorized: true,
            product: "marketplace",
            deploymentId: returnedDeploymentId,
            workspaceId: "tenant-1",
            orgId: "portal-org",
            productTenantId: "tenant-1",
            userId: "owner-1",
            endpoint: "https://marketplace.fixture.invalid",
            session,
            expiresAt: Date.now() + 3_600_000,
          }),
          { status: 200 },
        );
      },
      environment: {
        MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
        MARKETPLACE_PORTAL_ORG_ID: "portal-org",
        MARKETPLACE_PORTAL_WORKSPACE_ID: "tenant-1",
      },
    });

    const success = await app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: {
        origin: "https://portal.fixture.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `ticket=${ticket}`,
    });
    expect(success.statusCode).toBe(200);
    expect(success.headers["cache-control"]).toBe("no-store");
    expect(success.headers["referrer-policy"]).toBe("no-referrer");
    expect(success.body).toContain("Marketplace connected");
    expect(success.body).not.toContain(ticket);
    expect(success.body).not.toContain(session);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://portal.fixture.invalid/api/deployment-browser/redeem",
      body: { schema: 1, product: "marketplace", deploymentId: "deployment-1", ticket },
    });
    expect(store.getPortalHandoffSession("deployment-1")).toMatchObject({
      deploymentId: "deployment-1",
      productTenantId: "tenant-1",
      sessionToken: session,
    });

    const replay = await app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: {
        origin: "https://portal.fixture.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `ticket=${ticket}`,
    });
    expect(replay.statusCode).toBe(401);

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: {
        origin: "https://attacker.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `ticket=${"x".repeat(43)}`,
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(calls).toHaveLength(2);

    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: {
        origin: "https://portal.fixture.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `ticket=${ticket}&ticket=${ticket}`,
    });
    expect(duplicate.statusCode).toBe(401);
    expect(calls).toHaveLength(2);

    redeemed = false;
    returnedDeploymentId = "foreign-deployment";
    const foreign = await app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: {
        origin: "https://portal.fixture.invalid",
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `ticket=${"f".repeat(43)}`,
    });
    expect(foreign.statusCode).toBe(403);
    expect(store.getPortalHandoffSession("foreign-deployment")).toBeNull();

    await app.close();
    store.close();
  });
});

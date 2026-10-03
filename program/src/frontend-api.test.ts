import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { SqliteMarketplaceStore } from "./store.js";

const tempRoots: string[] = [];

async function buildFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-frontend-api-"));
  tempRoots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
  store.upsertListing({
    pluginId: "summary-secret-fixture",
    displayName: "Summary Secret Fixture",
    kind: "connector",
    provider: "fixture",
    description: "Tests the redacted catalog projection.",
    capabilities: ["connector.observe"],
    actions: ["fixture.read"],
    source: "native",
    authOwner: "program",
    executionOwner: "native",
    enabledByDefault: false,
    manifest: { version: "9.9.9", credential: "manifest-secret" },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  store.registerPlugin("summary-secret-fixture");
  store.install("default", "summary-secret-fixture");
  store.upsertConnection({
    workspaceSlug: "default",
    pluginId: "summary-secret-fixture",
    provider: "fixture",
    backend: "native",
    state: "connected",
    detail: "Fixture connection is available.",
    metadata: { accessToken: "never-serialize-me", credentialRef: "secret://fixture" },
  });
  const app = await buildMarketplaceApp({ store, env: {} });
  return { app, store };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Marketplace frontend API", () => {
  it("returns bounded canonical summaries without manifest or connection metadata", async () => {
    const { app, store } = await buildFixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/cards/summary?workspaceSlug=default&search=secret&limit=1",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBeGreaterThan(body.filteredTotal - 1);
    expect(body.filteredTotal).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      pluginId: "summary-secret-fixture",
      installed: true,
      connection: { state: "connected", backend: "native" },
    });
    expect(body.connections).toEqual([
      expect.objectContaining({ pluginId: "summary-secret-fixture", state: "connected" }),
    ]);
    const serialized = response.body;
    expect(serialized).not.toContain("never-serialize-me");
    expect(serialized).not.toContain("secret://fixture");
    expect(serialized).not.toContain("manifest-secret");
    expect(body.items[0].connection).not.toHaveProperty("metadata");
    expect(body.connections[0]).not.toHaveProperty("connection");
    expect(body.providers.nango).not.toHaveProperty("env");
    expect(body.providers.nango).not.toHaveProperty("baseUrl");
    expect(body.providers.nango).not.toHaveProperty("error");
    await app.close();
    store.close();
  });

  it("returns a complete safe UI card without arbitrary manifest or connection secrets", async () => {
    const { app, store } = await buildFixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/cards/summary-secret-fixture?workspaceSlug=default",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().card).toMatchObject({
      addon: { displayName: "Summary Secret Fixture", version: "9.9.9" },
      state: { ready: false, status: "catalogOnly" },
      listing: { pluginId: "summary-secret-fixture", manifest: { version: "9.9.9" } },
      connection: { state: "connected", backend: "native" },
      toolSelection: { total: 1 },
      provenance: "first-party",
    });
    expect(response.body).not.toContain("manifest-secret");
    expect(response.body).not.toContain("never-serialize-me");
    expect(response.body).not.toContain("secret://fixture");
    expect(response.json().card.listing.manifest).not.toHaveProperty("credential");
    expect(response.json().card.connection).not.toHaveProperty("metadata");
    expect(response.json().card).not.toHaveProperty("imports");
    expect(response.json().providers.composio).not.toHaveProperty("env");
    await app.close();
    store.close();
  });

  it("serves redacted bootstrap and OpenAPI without service bearer material", async () => {
    const { app, store } = await buildFixture();
    const bootstrap = await app.inject({ method: "GET", url: "/bootstrap.json" });
    const contract = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().authorization.credentialExposedToBrowser).toBe(false);
    expect(contract.statusCode).toBe(200);
    expect(contract.json().paths["/api/marketplace/cards/summary"]).toBeDefined();
    expect(contract.body).not.toContain("projection-token");
    await app.close();
    store.close();
  });
});

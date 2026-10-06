import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import {
  listingIsCustomMcp,
  listingIsOperatorCustomMcp,
  listingIsRequired,
} from "./hub.js";
import { SqliteMarketplaceStore } from "./store.js";
import type { MarketplaceListing } from "./types.js";

const roots: string[] = [];
const allowRules = async () => ({
  effect: "allow" as const,
  decisionId: "rules-listing-flags",
});

async function makeStore() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tealbrick-marketplace-listing-flags-"),
  );
  roots.push(root);
  return new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function listing(manifest: Record<string, unknown>, extra: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    pluginId: "flag-fixture",
    displayName: "Flag Fixture",
    kind: "module",
    provider: "tealbrick",
    description: "Listing flag fixture.",
    capabilities: ["connector.observe"],
    actions: ["flag-fixture.status"],
    source: "native",
    authOwner: "external",
    executionOwner: "native",
    enabledByDefault: true,
    manifest,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...extra,
  };
}

describe("Marketplace listing flags", () => {
  it("reads required and custom MCP flags from current and legacy manifest keys", () => {
    expect(listingIsRequired(listing({ system: { required: true } }))).toBe(true);
    // `skillsHub` is the persisted key written by earlier releases.
    expect(listingIsRequired(listing({ skillsHub: { required: true } }))).toBe(true);
    expect(listingIsRequired(listing({}))).toBe(false);

    const custom = listing(
      { skillsHub: { custom: true, operatorManaged: true } },
      { source: "mcp", ownerWorkspaceSlug: "atlas" },
    );
    expect(listingIsCustomMcp(custom)).toBe(true);
    expect(listingIsOperatorCustomMcp(custom)).toBe(true);
    expect(listingIsOperatorCustomMcp({ ...custom, ownerWorkspaceSlug: undefined })).toBe(false);
    expect(listingIsCustomMcp(listing({ skillsHub: { custom: true } }))).toBe(false);
  });

  it("protects required first-party Plugins from uninstall and unregister", async () => {
    const store = await makeStore();
    store.upsertListing(
      listing({ version: "1.0.0", skillsHub: { required: true } }, { pluginId: "required-native" }),
    );
    const app = await buildMarketplaceApp({ store, rulesClient: allowRules });

    for (const pathSuffix of ["uninstall", "unregister"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/marketplace/plugins/required-native/${pathSuffix}`,
        payload: { workspaceSlug: "default" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "required_plugin_protected" });
    }

    await app.close();
    store.close();
  });

  it("no longer serves the retired Skills Hub routes", async () => {
    const store = await makeStore();
    const app = await buildMarketplaceApp({ store, internalAuthToken: "service-token" });
    for (const url of [
      "/api/marketplace/hub/records",
      "/api/plugins/marketplace-hub/records",
      "/api/marketplace/session-correlations",
    ]) {
      const response = await app.inject({
        url,
        headers: { authorization: "Bearer service-token" },
      });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
    store.close();
  });
});

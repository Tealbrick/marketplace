import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildComposioListingFromTools } from "./connectors.js";
import { projectMarketplacePlugins } from "./marketplace-plugin-projection.js";
import { SqliteMarketplaceStore } from "./store.js";

const tempRoots: string[] = [];

async function makeStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dg-plugin-projection-"));
  tempRoots.push(root);
  return new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Marketplace Plugin capability projection", () => {
  it("projects all eight default listings as unique, available, secret-free Product records", async () => {
    const store = await makeStore();
    const projection = projectMarketplacePlugins(store, "default");
    const expectedPluginIds = [
      "activepieces-pack-generator",
      "cloudflare-native",
      "composio-bootstrap",
      "coolify-native",
      "github-native",
      "mcp-runtime",
      "telegram-native",
      "whatsapp-native",
    ];

    expect(projection.pluginRecords).toHaveLength(8);
    expect(projection.pluginRecords.map((record) => record.pluginId).sort()).toEqual(
      expectedPluginIds,
    );
    expect(new Set(projection.pluginRecords.map((record) => record.recordId)).size).toBe(8);
    expect(new Set(projection.actions.map((action) => action.actionId)).size).toBe(8);

    const owners = new Set(projection.pluginRecords.map((record) => record.recordId));
    for (const record of projection.pluginRecords) {
      expect(record).toMatchObject({
        schemaVersion: "doppelganger.marketplace.plugin-record.v1",
        recordId: `plugin:${record.pluginId}`,
        providerId: "marketplace",
        lifecycle: "available",
        enabled: false,
        required: false,
        connection: {
          state: "connected",
          detail: "No external-account connection is required.",
        },
        allowedActions: ["install"],
        settingsSurfaceIds: [],
        registry: { authority: "doppelganger-registry", unitId: record.pluginId },
      });
    }
    for (const action of projection.actions) {
      expect(owners.has(action.ownerRecordId)).toBe(true);
      expect(action).toMatchObject({
        operation: "install",
        method: "POST",
        payload: { workspaceSlug: "default", actorId: "operator" },
      });
      expect(action.endpoint).toMatch(
        /^\/api\/plugins\/doppelganger-registry\/proxy\/marketplace\/api\/marketplace\/plugins\/[^/]+\/install$/,
      );
    }

    expect(
      projection.pluginRecords.find((record) => record.pluginId === "github-native"),
    ).toMatchObject({ kind: "native", adapter: { type: "native" } });
    expect(
      projection.pluginRecords.find((record) => record.pluginId === "mcp-runtime"),
    ).toMatchObject({ kind: "mcp", adapter: { type: "mcp" } });
    expect(JSON.stringify(projection)).not.toMatch(
      /API_KEY|authorization|access[_-]?token|requiredEnv/i,
    );

    store.close();
  });

  it("maps imported Composio install and connection state to real proxy actions without secrets", async () => {
    const store = await makeStore();
    const now = "2026-07-12T12:00:00.000Z";
    const listing = buildComposioListingFromTools({
      toolkit: "linear",
      pluginId: "composio-linear",
      tools: [{ name: "LINEAR_CREATE_ISSUE", description: "Create a Linear issue" }],
      now,
    });
    store.upsertListing({
      ...listing,
      manifest: { ...listing.manifest, version: "2.3.4", privateToken: "never-return" },
    });

    const available = projectMarketplacePlugins(store, "atlas");
    expect(available.pluginRecords.find((record) => record.pluginId === listing.pluginId)).toMatchObject({
      lifecycle: "available",
      enabled: false,
      version: "2.3.4",
      connection: { state: "auth-required" },
      allowedActions: ["install"],
      createdAt: now,
    });

    store.install("atlas", listing.pluginId);
    const installed = projectMarketplacePlugins(store, "atlas");
    const installedRecord = installed.pluginRecords.find(
      (record) => record.pluginId === listing.pluginId,
    );
    expect(installedRecord).toMatchObject({
      lifecycle: "installed",
      enabled: true,
      connection: { state: "auth-required" },
      allowedActions: ["authenticate", "configure", "uninstall"],
    });
    expect(
      installed.actions
        .filter((action) => action.ownerRecordId === installedRecord?.recordId)
        .map((action) => [action.operation, action.endpoint]),
    ).toEqual([
      ["authenticate", "/api/plugins/doppelganger-registry/proxy/marketplace/api/marketplace/plugins/composio-linear/connection"],
      ["configure", "/api/plugins/doppelganger-registry/proxy/marketplace/api/marketplace/plugins/composio-linear/action-binding"],
      ["uninstall", "/api/plugins/doppelganger-registry/proxy/marketplace/api/marketplace/plugins/composio-linear/uninstall"],
    ]);

    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: listing.pluginId,
      provider: "linear",
      backend: "composio",
      state: "connected",
      detail: "Connected safely.",
      metadata: { accessToken: "secret-access-token" },
    });
    const connected = projectMarketplacePlugins(store, "atlas");
    const connectedRecord = connected.pluginRecords.find(
      (record) => record.pluginId === listing.pluginId,
    );
    expect(connectedRecord).toMatchObject({
      lifecycle: "installed",
      enabled: true,
      connection: { state: "connected", detail: "Connected safely." },
      allowedActions: ["configure", "uninstall"],
      capabilities: listing.capabilities,
      actions: listing.actions,
    });
    const serialized = JSON.stringify(connected);
    expect(serialized).not.toContain("never-return");
    expect(serialized).not.toContain("secret-access-token");
    expect(serialized).not.toContain("accessToken");

    store.close();
  });
});

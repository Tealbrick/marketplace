import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { buildComposioListingFromTools } from "./connectors.js";
import {
  marketplaceCapabilitiesHostProjection,
  reconcileGatewayRegistry,
} from "./hub.js";
import { SqliteMarketplaceStore } from "./store.js";
import type { MarketplaceListing } from "./types.js";

const roots: string[] = [];
const token = "skills-hub-internal-token";
const auth = { authorization: `Bearer ${token}` };
const allowRules = async () => ({
  effect: "allow" as const,
  decisionId: "rules-hub",
});

async function makeStore() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tealbrick-marketplace-hub-"),
  );
  roots.push(root);
  return new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Marketplace Skills Hub contract", () => {
  it("routes lifecycle and Composio Connect actions through the authenticated registry proxy", async () => {
    const store = await makeStore();
    const listing = buildComposioListingFromTools({
      toolkit: "gmail",
      pluginId: "composio-gmail",
      tools: [{ name: "GMAIL_FETCH_EMAILS", description: "Fetch Gmail messages" }],
    });
    store.upsertListing(listing);
    store.install("atlas", listing.pluginId);

    const projection = marketplaceCapabilitiesHostProjection({
      store,
      workspaceSlug: "atlas",
    });
    expect(projection.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionId: "plugin:activepieces-pack-generator:install",
          endpoint:
            "/api/plugins/doppelganger-registry/proxy/marketplace/api/marketplace/hub/plugins/activepieces-pack-generator/lifecycle",
          payload: {
            workspaceSlug: "atlas",
            actorId: "operator",
            action: "install",
          },
        }),
        expect.objectContaining({
          actionId: "plugin:composio-gmail:authenticate",
          label: "Connect",
          endpoint:
            "/api/plugins/doppelganger-registry/proxy/marketplace/api/marketplace/plugins/composio-gmail/connection",
          payload: {
            workspaceSlug: "atlas",
            actorId: "operator",
            provider: "gmail",
            backend: "composio",
            toolkit: "gmail",
          },
        }),
      ]),
    );
    expect(
      projection.pluginRecords.find(
        (record) => record.pluginId === "composio-gmail",
      ),
    ).toMatchObject({
      allowedActions: expect.arrayContaining([
        "authenticate",
        "disable",
        "reload",
        "uninstall",
      ]),
      settingsSurfaceIds: [],
    });
    expect(
      projection.pluginRecords.find(
        (record) => record.pluginId === "composio-gmail",
      )?.allowedActions,
    ).not.toEqual(expect.arrayContaining(["configure", "update"]));
    expect(
      projection.actions
        .filter(
          (action) => action.ownerRecordId === "plugin:composio-gmail",
        )
        .map((action) => action.operation),
    ).not.toEqual(expect.arrayContaining(["configure", "update"]));
    expect(
      projection.settingsSurfaces.some(
        (surface) => surface.ownerRecordId === "plugin:composio-gmail",
      ),
    ).toBe(false);
    expect(
      projection.extensionRecords
        .filter((record) => record.ownerPluginId === "composio-gmail")
        .every((record) => record.settingsSurfaceId === undefined),
    ).toBe(true);
    expect(
      projection.settingsSurfaces.some((surface) =>
        surface.ownerRecordId.startsWith("extension:composio-gmail:"),
      ),
    ).toBe(false);

    store.close();
  });

  it("requires internal bearer auth and projects into the one Capabilities host", async () => {
    const store = await makeStore();
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: token,
      rulesClient: allowRules,
    });

    expect(
      (await app.inject({ url: "/api/marketplace/hub/records" })).statusCode,
    ).toBe(401);
    const response = await app.inject({
      url: "/api/marketplace/hub/records?workspaceSlug=default",
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      host: {
        entry: "capabilities",
        tabs: ["skills", "plugins", "extensions"],
        lifecycleAuthority: "marketplace",
        directHermesRole: "underlying-adapters-only",
      },
      dependencies: {
        registryAuthority: "doppelganger-registry",
        recordMode: "gateway-projected-records",
        lifecycleAuthority: "marketplace",
        directHermesRole: "underlying-adapters-only",
        normalModeDirectHermesControls: false,
        auth: { owner: "hdda-host-sdk", scope: "auth", status: "dependency" },
      },
    });
    expect(
      response
        .json()
        .pluginRecords.every((record: { kind: string }) =>
          ["native", "mcp"].includes(record.kind),
        ),
    ).toBe(true);

    await app.close();
    store.close();
  });

  it("creates, reads, updates, installs, enables, reloads, uninstalls, and deletes an MCP-backed Plugin", async () => {
    const store = await makeStore();
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: token,
      rulesClient: allowRules,
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/mcp",
      headers: auth,
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        pluginId: "project-search",
        displayName: "Project Search",
        description: "Searches the active project through MCP.",
        transport: "stdio",
        command: "project-search-mcp",
        args: ["--root", "/workspace"],
        env: { PROJECT_SEARCH_TOKEN: "credential-value-not-for-hub-cards" },
        headers: { authorization: "Bearer not-for-hub-cards" },
        config: { timeoutMs: 15000 },
        contributions: [
          {
            id: "project-search.results",
            type: "extension-surface",
            label: "Search Results",
            mount: "right-rail",
            routeSegment: "project-search",
            settings: {
              settingsSurfaceId:
                "marketplace.extension.project-search.results.settings",
              title: "Search Results settings",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: { resultLimit: { type: "integer", minimum: 1 } },
              },
            },
            enabled: true,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().record).toMatchObject({
      pluginId: "project-search",
      kind: "mcp",
      lifecycle: "available",
      enabled: false,
      custom: true,
      recordId: "plugin:project-search",
      providerId: "marketplace",
      adapter: {
        type: "mcp",
        mcp: { transport: "stdio", command: "project-search-mcp" },
      },
      registry: { authority: "doppelganger-registry" },
    });
    expect(created.json().record.adapter.mcp).not.toHaveProperty("env");
    expect(created.json().record.adapter.mcp).not.toHaveProperty("headers");

    const projection = await app.inject({
      url: "/api/marketplace/hub/records?workspaceSlug=default",
      headers: auth,
    });
    expect(projection.statusCode).toBe(200);
    expect(projection.json()).toMatchObject({
      pluginRecords: expect.arrayContaining([
        expect.objectContaining({
          recordId: "plugin:project-search",
          settingsSurfaceIds: ["marketplace.plugin.project-search.settings"],
        }),
      ]),
      extensionRecords: expect.arrayContaining([
        expect.objectContaining({
          recordId: "extension:project-search:project-search.results",
          ownerPluginId: "project-search",
          visible: true,
          status: expect.objectContaining({ state: "disconnected" }),
          capabilities: ["connector.observe", "connector.dispatch"],
          settingsSurfaceId:
            "marketplace.extension.project-search.results.settings",
        }),
      ]),
      settingsSurfaces: expect.arrayContaining([
        expect.objectContaining({
          presentation: "modal",
          schemaVersion: "doppelganger.capability-settings.v1",
          settingsSurfaceId:
            "marketplace.extension.project-search.results.settings",
          jsonSchema: expect.objectContaining({ type: "object" }),
          allowedActions: [],
        }),
      ]),
      actions: expect.arrayContaining([
        expect.objectContaining({
          actionId: "plugin:project-search:configure",
          operation: "configure",
          endpoint:
            "/api/plugins/doppelganger-registry/proxy/marketplace/api/marketplace/hub/plugins/project-search?workspaceSlug=default",
          method: "PATCH",
        }),
      ]),
    });

    const installed = await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/project-search/lifecycle",
      headers: auth,
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        action: "install",
      },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json().record).toMatchObject({
      lifecycle: "installed",
      enabled: true,
    });

    store.createBrokerGrant({
      workspaceSlug: "default",
      requesterMiniappId: "live-artifacts",
      pluginId: "project-search",
      actionKeys: ["mcp.tools.call"],
      capabilities: ["connector.dispatch"],
      tokenHash: "hub-grant-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const reloaded = await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/project-search/lifecycle",
      headers: auth,
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        action: "reload",
      },
    });
    expect(reloaded.json().record.connection).toMatchObject({
      state: "connecting",
    });

    const disabled = await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/project-search/lifecycle",
      headers: auth,
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        action: "disable",
      },
    });
    expect(disabled.json().record.enabled).toBe(false);
    expect(
      store.listBrokerGrants({ pluginId: "project-search" })[0]?.state,
    ).toBe("revoked");

    const enabled = await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/project-search/lifecycle",
      headers: auth,
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        action: "enable",
      },
    });
    expect(enabled.json().record.enabled).toBe(true);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/marketplace/hub/plugins/project-search?workspaceSlug=default",
      headers: auth,
      payload: {
        settings: {
          displayName: "Project Search Pro",
          transport: "stdio",
          command: "project-search-mcp",
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().record.displayName).toBe("Project Search Pro");
    expect(updated.json().record.connection).toMatchObject({
      state: "disconnected",
    });
    expect(
      (
        store.getListing("project-search")?.manifest.skillsHub as {
          adapter: { mcp: { env: Record<string, string> } };
        }
      ).adapter.mcp.env,
    ).toEqual({
      PROJECT_SEARCH_TOKEN: "credential-value-not-for-hub-cards",
    });

    const read = await app.inject({
      url: "/api/marketplace/hub/plugins/project-search?workspaceSlug=default",
      headers: auth,
    });
    expect(read.json().record.displayName).toBe("Project Search Pro");

    const uninstalled = await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/project-search/lifecycle",
      headers: auth,
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        action: "uninstall",
      },
    });
    expect(uninstalled.json().record).toMatchObject({
      lifecycle: "available",
      enabled: false,
      connection: { state: "disconnected" },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/marketplace/hub/plugins/project-search?workspaceSlug=default",
      headers: auth,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      ok: true,
      pluginId: "project-search",
      deleted: true,
    });
    expect(store.getListing("project-search")).toBeNull();

    await app.close();
    store.close();
  });

  it("rejects lifecycle mutations that require an installed Plugin", async () => {
    const store = await makeStore();
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: token,
      rulesClient: allowRules,
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/mcp",
      headers: auth,
      payload: {
        pluginId: "pending-mcp",
        displayName: "Pending MCP",
        transport: "stdio",
        command: "pending-mcp",
      },
    });

    for (const action of ["enable", "disable", "reload", "uninstall"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/marketplace/hub/plugins/pending-mcp/lifecycle",
        headers: auth,
        payload: { workspaceSlug: "default", action },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "plugin_not_installed" });
    }

    await app.close();
    store.close();
  });

  it("fails closed when providers contribute duplicate Extension ownership", async () => {
    const store = await makeStore();
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: token,
      rulesClient: allowRules,
    });
    for (const pluginId of ["first-mcp", "second-mcp"]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/marketplace/hub/plugins/mcp",
        headers: auth,
        payload: {
          pluginId,
          displayName: pluginId,
          transport: "stdio",
          command: pluginId,
          contributions: [
            {
              id: "shared.extension",
              type: "extension-surface",
              label: "Shared Extension",
              mount: "settings-panel",
              routeSegment: "shared-extension",
              enabled: true,
            },
          ],
        },
      });
      expect(created.statusCode).toBe(201);
    }
    const projection = await app.inject({
      url: "/api/marketplace/hub/records?workspaceSlug=default",
      headers: auth,
    });
    expect(projection.statusCode).toBe(409);
    expect(projection.json()).toMatchObject({
      error: "capabilities_ownership_conflict",
      detail: expect.stringContaining("Extension contribution"),
    });

    await app.close();
    store.close();
  });

  it("protects required first-party Plugins from disable and uninstall", async () => {
    const store = await makeStore();
    const listing: MarketplaceListing = {
      pluginId: "required-native",
      displayName: "Required Native",
      kind: "module",
      provider: "doppelganger",
      description: "Required first-party fixture.",
      capabilities: ["connector.observe"],
      actions: ["required-native.status"],
      source: "native",
      authOwner: "external",
      executionOwner: "native",
      enabledByDefault: true,
      manifest: {
        version: "1.0.0",
        skillsHub: { required: true, custom: false, unitId: "required-native" },
      },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    store.upsertListing(listing);
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: token,
      rulesClient: allowRules,
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/hub/plugins/required-native/lifecycle",
      headers: auth,
      payload: { workspaceSlug: "default", action: "install" },
    });

    for (const action of ["disable", "uninstall"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/marketplace/hub/plugins/required-native/lifecycle",
        headers: auth,
        payload: { workspaceSlug: "default", action },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "required_plugin_protected",
      });
    }
    const record = (
      await app.inject({
        url: "/api/marketplace/hub/plugins/required-native?workspaceSlug=default",
        headers: auth,
      })
    ).json().record;
    expect(record).toMatchObject({ required: true, enabled: true });
    expect(record.allowedActions).not.toContain("disable");
    expect(record.allowedActions).not.toContain("uninstall");

    for (const pathSuffix of ["uninstall", "unregister"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/marketplace/plugins/required-native/${pathSuffix}`,
        payload: { workspaceSlug: "default" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: "required_plugin_protected",
      });
    }

    await app.close();
    store.close();
  });

  it("reconciles the required Marketplace unit without writing the HDDA gateway registry", () => {
    const healthy = reconcileGatewayRegistry({
      contractVersion: "1.0.0",
      revision: 42,
      units: [
        {
          unitId: "marketplace",
          version: "0.2.0",
          enabled: true,
          required: true,
          capabilityProjection: {
            gatewayPluginId: "doppelganger-registry",
            recordsPath:
              "/api/plugins/doppelganger-registry/proxy/marketplace/api/plugins/marketplace-hub/records",
          },
        },
      ],
      contributions: [],
    });
    expect(healthy).toMatchObject({
      ok: true,
      authority: "doppelganger-registry",
      writesRegistry: false,
    });
    expect(healthy.expected.tabs).toEqual(["skills", "plugins", "extensions"]);

    const broken = reconcileGatewayRegistry({
      contractVersion: "1.0.0",
      revision: 43,
      units: [
        {
          unitId: "marketplace",
          version: "0.2.0",
          enabled: false,
          required: false,
          capabilityProjection: {
            gatewayPluginId: "wrong-marketplace-adapter",
            recordsPath: "/api/plugins/wrong-marketplace-adapter/records",
          },
        },
      ],
      contributions: [
        {
          id: "marketplace.mcp",
          unitId: "marketplace",
          type: "surface",
          label: "MCP",
          mount: "hub-tab",
          routeSegment: "mcp",
        },
      ],
    });
    expect(broken.ok).toBe(false);
    expect(broken.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "required-unit-disabled",
        "required-policy-missing",
        "capabilities-projection-mismatch",
        "duplicate-top-level-tab",
        "unexpected-top-level-category",
      ]),
    );
  });

  it("ships native/MCP fixtures, a host-composable projection contract, and the gateway adapter", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const native = JSON.parse(
      await readFile(
        path.join(root, "contracts/fixtures/native-plugin.json"),
        "utf8",
      ),
    );
    const mcp = JSON.parse(
      await readFile(
        path.join(root, "contracts/fixtures/mcp-plugin.json"),
        "utf8",
      ),
    );
    const registry = JSON.parse(
      await readFile(
        path.join(root, "extension/hdda/registry.fragment.json"),
        "utf8",
      ),
    );
    const hddaDependency = JSON.parse(
      await readFile(
        path.join(root, "contracts/hdda-registry-dependency.json"),
        "utf8",
      ),
    );
    expect(native).toMatchObject({ kind: "native", required: true });
    expect(mcp).toMatchObject({ kind: "mcp", adapter: { type: "mcp" } });
    expect(registry.units).toEqual([
      expect.objectContaining({
        unitId: "marketplace",
        enabled: true,
        required: true,
        capabilityProjection: {
          gatewayPluginId: "doppelganger-registry",
          recordsPath:
            "/api/plugins/doppelganger-registry/proxy/marketplace/api/plugins/marketplace-hub/records",
        },
      }),
    ]);
    expect(registry.contributions).toEqual([]);
    expect(
      registry.contributions.some(
        (entry: { mount?: string }) => entry.mount === "hub-tab",
      ),
    ).toBe(false);
    expect(hddaDependency).toMatchObject({
      authority: "doppelganger-registry",
      api: {
        currentWholeDocumentWrite: { marketplaceMayCall: false },
        candidateUnitEnablement: {
          method: "PUT",
          pathTemplate:
            "/api/plugins/doppelganger-registry/units/{unit_id}/enabled",
          request: { enabled: "boolean" },
          status: "pending-hdda-pr-8",
        },
      },
      host: {
        entry: "Capabilities",
        projection: {
          registryUnitField: "capabilityProjection",
          gatewayPluginId: "doppelganger-registry",
          recordsPath:
            "/api/plugins/doppelganger-registry/proxy/marketplace/api/plugins/marketplace-hub/records",
          hostOwnsRendering: true,
          hostOwnsTabs: true,
          modalOwnership: "host-generic",
          duplicateOwnership: "fail-closed",
          tabReplacement: "forbidden",
        },
        kernelContributions: {
          records: {
            type: "capability-record",
            region: "app.capabilities.records",
          },
          settings: {
            type: "capability-settings-surface",
            region: "app.capabilities.settings",
            schemaVersion: "doppelganger.capability-settings.v1",
          },
        },
        lifecycleOwnership: {
          canonical: "marketplace",
          directHermesRole: "underlying-adapters-only",
          normalModeDirectHermesControls: false,
          duplicateLifecycleControls: "forbidden",
        },
      },
    });
    expect(
      (
        await readFile(
          path.join(
            root,
            "plugin/hermes/gateway-dashboard/marketplace-hub/dashboard/plugin_api.py",
          ),
          "utf8",
        )
      ).includes("/api/marketplace/hub/records"),
    ).toBe(true);
    expect(
      (
        await readFile(
          path.join(
            root,
            "plugin/hermes/gateway-dashboard/marketplace-hub/plugin.yaml",
          ),
          "utf8",
        )
      ).includes("name: marketplace-hub"),
    ).toBe(true);
  });

  it("ships every declared dashboard entry as a tracked, archive-eligible adapter artifact", async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const adapterRoot = path.join(
      root,
      "plugin/hermes/gateway-dashboard/marketplace-hub",
    );
    const manifest = JSON.parse(
      await readFile(path.join(adapterRoot, "dashboard/manifest.json"), "utf8"),
    ) as { entry: string };
    const entry = path.resolve(adapterRoot, "dashboard", manifest.entry);
    const source = await readFile(entry, "utf8");

    expect(
      path.relative(path.join(adapterRoot, "dashboard"), entry),
    ).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(source).toContain('plugins.register("marketplace-hub"');
    expect(createHash("sha256").update(source).digest("hex")).toMatch(
      /^[a-f0-9]{64}$/,
    );

    // Exercise a fresh archive without staging or depending on the operator's
    // working index. This also works for the uncommitted LABS consolidation.
    const archiveRoot = await mkdtemp(path.join(os.tmpdir(), "marketplace-archive-"));
    roots.push(archiveRoot);
    await cp(adapterRoot, path.join(archiveRoot, "adapter"), { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: archiveRoot });
    execFileSync("git", ["add", "adapter"], { cwd: archiveRoot });
    const archiveEntry = path.join("adapter/dashboard", manifest.entry);
    const indexTree = execFileSync("git", ["write-tree"], { cwd: archiveRoot, encoding: "utf8" }).trim();
    const archive = execFileSync("git", ["archive", "--format=tar", indexTree, "--", archiveEntry], { cwd: archiveRoot });
    expect(archive.includes(Buffer.from(archiveEntry))).toBe(true);
  });
});

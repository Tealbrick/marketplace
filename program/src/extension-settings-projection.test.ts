import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultMicroappsRoot,
  gatewayProgramProxyEndpoint,
  loadExtensionManifests,
  projectExtensionSettings,
  type CapabilitiesHostProjection,
} from "./extension-settings-projection.js";

const noSettings = {
  schemaVersion: "doppelganger.capability-settings.v1",
  state: "none",
  posture: "none",
  reason: "Fixture has no settings.",
};

describe("Extension settings projection", () => {
  it("projects only operational forms and keeps intentional no-settings units form-free", async () => {
    const projection = await projectExtensionSettings();
    expect(projection.extensionRecords).toHaveLength((await loadExtensionManifests()).length);
    expect(projection.settingsSurfaces).toHaveLength(3);
    expect(projection.settingsSurfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        settingsSurfaceId: "local-runtime-bridge.settings",
        ownerRecordId: "extension:local-runtime-bridge",
        schemaVersion: "doppelganger.capability-settings.v1",
        applyMode: "live",
        presentation: "modal",
        jsonSchema: expect.objectContaining({
          properties: expect.objectContaining({
            localConnectorStatus: expect.objectContaining({ readOnly: true }),
            desktopPairingStatus: expect.objectContaining({ readOnly: true }),
            remoteGatewayPosture: expect.objectContaining({ readOnly: true }),
            relayEnabled: expect.objectContaining({ readOnly: true }),
            allowedRoots: expect.objectContaining({ type: "array" }),
            scopePresets: expect.objectContaining({ readOnly: true }),
            availableTools: expect.objectContaining({ readOnly: true }),
            shellExecutionEnabled: expect.objectContaining({ type: "boolean" }),
            allowedCommands: expect.objectContaining({ type: "array" }),
          }),
        }),
      }),
      expect.objectContaining({
        settingsSurfaceId: "marketplace.settings",
        ownerRecordId: "extension:marketplace",
        schemaVersion: "doppelganger.capability-settings.v1",
        presentation: "modal",
        loadActionId: "extension:marketplace:load-settings",
        submitActionId: "extension:marketplace:configure",
        applyMode: "live",
      }),
      expect.objectContaining({
        settingsSurfaceId: "observer-backfill.settings",
        ownerRecordId: "extension:observer-backfill",
        schemaVersion: "doppelganger.capability-settings.v1",
        presentation: "modal",
        loadActionId: "extension:observer-backfill:load-settings",
        submitActionId: "extension:observer-backfill:configure",
        applyMode: "immediate",
      }),
    ]));
    expect(projection.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: "extension:local-runtime-bridge:load-settings",
        endpoint: "/api/plugins/doppelganger-registry/proxy/local-runtime-bridge/api/plugins/local-runtime-bridge/settings",
        method: "GET",
        transport: "desktop-runtime-bridge",
      }),
      expect.objectContaining({
        actionId: "extension:local-runtime-bridge:configure",
        endpoint: "/api/plugins/doppelganger-registry/proxy/local-runtime-bridge/api/plugins/local-runtime-bridge/settings",
        method: "PATCH",
        transport: "desktop-runtime-bridge",
      }),
      expect.objectContaining({
        actionId: "extension:marketplace:load-settings",
        ownerRecordId: "extension:marketplace",
        endpoint: "/api/plugins/doppelganger-registry/proxy/marketplace/api/settings/providers/composio",
        method: "GET",
      }),
      expect.objectContaining({
        actionId: "extension:marketplace:configure",
        ownerRecordId: "extension:marketplace",
        endpoint: "/api/plugins/doppelganger-registry/proxy/marketplace/api/settings/providers/composio",
        method: "PUT",
      }),
      expect.objectContaining({
        actionId: "extension:observer-backfill:load-settings",
        ownerRecordId: "extension:observer-backfill",
        endpoint: "/api/plugins/doppelganger-registry/proxy/observer-backfill/api/observer/settings",
        method: "GET",
      }),
      expect.objectContaining({
        actionId: "extension:observer-backfill:configure",
        ownerRecordId: "extension:observer-backfill",
        endpoint: "/api/plugins/doppelganger-registry/proxy/observer-backfill/api/observer/settings",
        method: "PATCH",
      }),
    ]));
    expect(projection.extensionRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordId: "extension:operator-inbox",
        settingsPosture: "none",
        status: { state: "connected", detail: "No configurable settings." },
      }),
      expect.objectContaining({
        recordId: "extension:marketplace",
        displayName: "Doppelganger Plugins",
        settingsPosture: "dynamic-provider",
        settingsSurfaceId: "marketplace.settings",
      }),
      expect.objectContaining({
        recordId: "extension:local-runtime-bridge",
        displayName: "Runtime Bridge",
        settingsSurfaceId: "local-runtime-bridge.settings",
      }),
      expect.objectContaining({
        recordId: "extension:observer-backfill",
        displayName: "Observer Backfill",
        settingsPosture: "operational",
        settingsSurfaceId: "observer-backfill.settings",
      }),
    ]));
    expect(projection.extensionRecords.find(record => record.recordId === "extension:operator-inbox"))
      .not.toHaveProperty("settingsSurfaceId");

    const pluginManifest = JSON.parse(await readFile(
      new URL("../../.codex-plugin/plugin.json", import.meta.url),
      "utf8",
    )) as {
      doppelganger: {
        settingsPanels: Array<{ settings: { jsonSchema: unknown; uiSchema: unknown } }>;
      };
    };
    const marketplaceSurface = projection.settingsSurfaces.find(
      surface => surface.settingsSurfaceId === "marketplace.settings",
    );
    expect(marketplaceSurface?.jsonSchema).toEqual(
      pluginManifest.doppelganger.settingsPanels[0].settings.jsonSchema,
    );
    expect(marketplaceSurface?.uiSchema).toEqual(
      pluginManifest.doppelganger.settingsPanels[0].settings.uiSchema,
    );
    expect(marketplaceSurface?.uiSchema).toMatchObject({
      fields: {
        composioApiKey: { secretStatusKey: "composioApiKeyConfigured" },
      },
    });
  });

  it("preserves existing provider and Composio-owned projection entries unchanged", async () => {
    const base: CapabilitiesHostProjection = {
      host: {
        entry: "capabilities",
        tabs: ["skills", "plugins", "extensions"],
        lifecycleAuthority: "marketplace",
        directHermesRole: "underlying-adapters-only",
      },
      pluginRecords: [{ recordId: "plugin:composio-gmail", providerId: "composio" }],
      extensionRecords: [],
      actions: [{ actionId: "plugin:composio-gmail:configure", ownerRecordId: "plugin:composio-gmail" }],
      settingsSurfaces: [{ settingsSurfaceId: "composio.gmail.settings", ownerRecordId: "plugin:composio-gmail" }],
    };
    const projection = await projectExtensionSettings({ baseProjection: base });
    expect(projection.pluginRecords[0]).toBe(base.pluginRecords[0]);
    expect(projection.actions[0]).toBe(base.actions[0]);
    expect(projection.settingsSurfaces[0]).toBe(base.settingsSurfaces[0]);
  });

  it("rejects duplicate Plugin record ownership before composing Extension records", async () => {
    const duplicate = { recordId: "plugin:duplicate", providerId: "marketplace" };
    const base: CapabilitiesHostProjection = {
      host: {
        entry: "capabilities",
        tabs: ["skills", "plugins", "extensions"],
        lifecycleAuthority: "marketplace",
        directHermesRole: "underlying-adapters-only",
      },
      pluginRecords: [duplicate, { ...duplicate }],
      extensionRecords: [],
      actions: [],
      settingsSurfaces: [],
    };
    await expect(projectExtensionSettings({ baseProjection: base })).rejects.toThrow(
      /duplicate Plugin record ownership/i,
    );
  });

  it("loads installed manifests through each unit's current release path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dg-installed-microapps-"));
    try {
      const manifestDir = path.join(root, "operator-inbox", "current", "extension");
      const releaseProgramSrc = path.join(root, "marketplace", "releases", "release-1", "program", "src");
      await mkdir(manifestDir, { recursive: true });
      await mkdir(releaseProgramSrc, { recursive: true });
      await writeFile(path.join(manifestDir, "manifest.json"), JSON.stringify({
        id: "operator-inbox",
        name: "Operator Inbox",
        capabilitySettings: noSettings,
      }));

      const manifests = await loadExtensionManifests(root);
      expect(manifests.map(manifest => manifest.id)).toEqual(["operator-inbox"]);
      expect(defaultMicroappsRoot({}, releaseProgramSrc)).toBe(root);
      const projection = await projectExtensionSettings({ microappsRoot: root });
      expect(projection.extensionRecords).toEqual([
        expect.objectContaining({ recordId: "extension:operator-inbox", settingsPosture: "none" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a live-style installed bridge settings-free while Marketplace dynamic settings remain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dg-installed-dynamic-settings-"));
    try {
      const releaseRoot = path.join(root, "marketplace", "current");
      await mkdir(path.join(releaseRoot, "extension"), { recursive: true });
      await mkdir(path.join(releaseRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(releaseRoot, "extension", "manifest.json"),
        JSON.stringify({
          id: "marketplace",
          name: "Doppelganger Plugins",
          registryManifest: "../.codex-plugin/plugin.json",
          capabilitySettings: {
            schemaVersion: "doppelganger.capability-settings.v1",
            state: "none",
            posture: "dynamic-provider",
            reason: "Settings belong to the provider panel.",
          },
        }),
      );
      const jsonSchema = {
        type: "object",
        additionalProperties: false,
        properties: { account: { type: "string" } },
      };
      const uiSchema = { fields: { account: { widget: "text" } } };
      await writeFile(
        path.join(releaseRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({
          doppelganger: {
            settingsPanels: [{
              panelId: "marketplace",
              label: "Plugins",
              settings: {
                jsonSchema,
                uiSchema,
                loadAction: { method: "GET", path: "/api/settings" },
                submitAction: { method: "PUT", path: "/api/settings" },
              },
            }],
          },
        }),
      );
      const bridgeRoot = path.join(root, "local-runtime-bridge", "current");
      await mkdir(path.join(bridgeRoot, "extension"), { recursive: true });
      await mkdir(path.join(bridgeRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(bridgeRoot, "extension", "manifest.json"),
        JSON.stringify({ id: "local-runtime-bridge" }),
      );
      await writeFile(
        path.join(bridgeRoot, ".codex-plugin", "plugin.json"),
        JSON.stringify({
          interface: { displayName: "Runtime Bridge" },
          doppelganger: {
            settingsPanels: [{
              panelId: "must-not-project",
              label: "Undeclared bridge panel",
              settings: {
                jsonSchema,
                uiSchema,
                loadAction: { method: "GET", path: "/api/bridge/settings" },
                submitAction: { method: "PATCH", path: "/api/bridge/settings" },
              },
            }],
          },
        }),
      );

      const projection = await projectExtensionSettings({ microappsRoot: root });
      expect(projection.extensionRecords).toEqual(expect.arrayContaining([
        expect.objectContaining({
          recordId: "extension:local-runtime-bridge",
          displayName: "Runtime Bridge",
          settingsPosture: "none",
        }),
        expect.objectContaining({
          recordId: "extension:marketplace",
          settingsSurfaceId: "marketplace.settings",
        }),
      ]));
      expect(projection.settingsSurfaces).toEqual([
        expect.objectContaining({
          ownerRecordId: "extension:marketplace",
          jsonSchema,
          uiSchema,
          presentation: "modal",
        }),
      ]);
      expect(projection.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          actionId: "extension:marketplace:load-settings",
          endpoint: "/api/plugins/doppelganger-registry/proxy/marketplace/api/settings",
        }),
        expect.objectContaining({
          actionId: "extension:marketplace:configure",
          endpoint: "/api/plugins/doppelganger-registry/proxy/marketplace/api/settings",
        }),
      ]));
      expect(projection.settingsSurfaces).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ ownerRecordId: "extension:local-runtime-bridge" }),
      ]));
      expect(projection.actions).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ ownerRecordId: "extension:local-runtime-bridge" }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers the configured manifest root and fails clearly for an empty root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dg-explicit-microapps-"));
    try {
      await expect(loadExtensionManifests(root)).rejects.toThrow(/contains no Extension manifests/);
      expect(() => defaultMicroappsRoot({ DOPPELGANGER_MICROAPPS_ROOT: root })).toThrow(
        /DOPPELGANGER_MICROAPPS_ROOT does not contain Extension manifests/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives gateway proxy endpoints and rejects traversal or invalid Program paths", () => {
    expect(gatewayProgramProxyEndpoint("local-runtime-bridge", "settings")).toBe(
      "/api/plugins/doppelganger-registry/proxy/local-runtime-bridge/settings",
    );
    expect(() => gatewayProgramProxyEndpoint("local-runtime-bridge", "/../settings")).toThrow(/traversal/);
    expect(() => gatewayProgramProxyEndpoint("local-runtime-bridge", "/%2e%2e/settings")).toThrow(/traversal/);
    expect(() => gatewayProgramProxyEndpoint("local-runtime-bridge", "https://example.test/settings")).toThrow(/invalid Program settings path/);
    expect(() => gatewayProgramProxyEndpoint("../bridge", "/settings")).toThrow(/invalid Extension unit id/);
  });
});

import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateSettingsDeclaration } from "../../.sdk/extension-settings.mjs";

type JsonRecord = Record<string, unknown>;

export type CapabilitiesHostProjection = {
  host: {
    entry: "capabilities";
    tabs: ["skills", "plugins", "extensions"];
    lifecycleAuthority: "marketplace";
    directHermesRole: "underlying-adapters-only";
  };
  pluginRecords: JsonRecord[];
  extensionRecords: JsonRecord[];
  actions: JsonRecord[];
  settingsSurfaces: JsonRecord[];
};

function emptyProjection(): CapabilitiesHostProjection {
  return {
    host: {
      entry: "capabilities",
      tabs: ["skills", "plugins", "extensions"],
      lifecycleAuthority: "marketplace",
      directHermesRole: "underlying-adapters-only",
    },
    pluginRecords: [],
    extensionRecords: [],
    actions: [],
    settingsSurfaces: [],
  };
}

function assertUnique(label: string, values: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

const UNIT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export function gatewayProgramProxyEndpoint(unitId: string, declaredPath: unknown) {
  if (!UNIT_ID_PATTERN.test(unitId)) {
    throw new Error(`invalid Extension unit id for gateway proxy: ${unitId}`);
  }
  if (typeof declaredPath !== "string" || !declaredPath.trim()) {
    throw new Error(`invalid Program settings path for ${unitId}`);
  }
  const trimmed = declaredPath.trim();
  if (trimmed.includes("\\") || trimmed.includes("?") || trimmed.includes("#") || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    throw new Error(`invalid Program settings path for ${unitId}: ${trimmed}`);
  }
  const normalized = `/${trimmed.replace(/^\/+/, "")}`;
  const segments = normalized.split("/").filter(Boolean);
  for (const segment of segments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`invalid Program settings path encoding for ${unitId}: ${trimmed}`);
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error(`Program settings path traversal is not allowed for ${unitId}: ${trimmed}`);
    }
  }
  return `/api/plugins/doppelganger-registry/proxy/${unitId}${normalized}`;
}

function manifestPathForUnit(root: string, unitId: string) {
  const standaloneManifest = path.join(root, "extension", "manifest.json");
  const standaloneProduct = path.join(root, "manifest.json");
  if (existsSync(standaloneManifest) && existsSync(standaloneProduct)) {
    try {
      const product = JSON.parse(readFileSync(standaloneProduct, "utf8")) as JsonRecord;
      if (product.id === unitId) return standaloneManifest;
    } catch {
      // The normal manifest reader below will report malformed source details.
    }
  }
  const direct = path.join(root, unitId, "extension", "manifest.json");
  if (existsSync(direct)) return direct;
  const installed = path.join(root, unitId, "current", "extension", "manifest.json");
  return existsSync(installed) ? installed : null;
}

function standaloneUnitId(root: string) {
  const extensionManifest = path.join(root, "extension", "manifest.json");
  const productManifest = path.join(root, "manifest.json");
  if (!existsSync(extensionManifest) || !existsSync(productManifest)) return null;
  try {
    const product = JSON.parse(readFileSync(productManifest, "utf8")) as JsonRecord;
    return typeof product.id === "string" && product.id ? product.id : null;
  } catch {
    return null;
  }
}

function isManifestRoot(root: string) {
  if (standaloneUnitId(root)) return true;
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      entry => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()) && manifestPathForUnit(root, entry.name),
    );
  } catch {
    return false;
  }
}

export function defaultMicroappsRoot(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir = path.dirname(fileURLToPath(import.meta.url)),
) {
  const explicit = env.DOPPELGANGER_MICROAPPS_ROOT?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!isManifestRoot(resolved)) {
      throw new Error(`DOPPELGANGER_MICROAPPS_ROOT does not contain Extension manifests: ${resolved}`);
    }
    return resolved;
  }

  const candidates = [
    path.resolve(moduleDir, "../.."),
    path.resolve(moduleDir, "../../.."),
    path.resolve(moduleDir, "../../../../.."),
  ];
  const resolved = candidates.find(isManifestRoot);
  if (!resolved) {
    throw new Error(
      `No Micro-app Extension manifest root found. Set DOPPELGANGER_MICROAPPS_ROOT; checked: ${candidates.join(", ")}`,
    );
  }
  return resolved;
}

export async function loadExtensionManifests(microappsRoot?: string) {
  const resolvedRoot = microappsRoot ? path.resolve(microappsRoot) : defaultMicroappsRoot();
  if (!isManifestRoot(resolvedRoot)) {
    throw new Error(`Micro-app root contains no Extension manifests: ${resolvedRoot}`);
  }
  const standaloneId = standaloneUnitId(resolvedRoot);
  if (standaloneId) {
    const standalonePath = manifestPathForUnit(resolvedRoot, standaloneId);
    if (!standalonePath) throw new Error(`Micro-app root contains no readable Extension manifests: ${resolvedRoot}`);
    const manifest = JSON.parse(await readFile(standalonePath, "utf8")) as JsonRecord;
    if (manifest.capabilitySettings !== undefined) {
      validateSettingsDeclaration(manifest.capabilitySettings);
    }
    return [manifest];
  }
  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const manifests: JsonRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if ((!entry.isDirectory() && !entry.isSymbolicLink()) || entry.name.startsWith(".")) continue;
    const manifestPath = manifestPathForUnit(resolvedRoot, entry.name);
    if (!manifestPath) continue;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as JsonRecord;
      if (manifest.capabilitySettings !== undefined) {
        validateSettingsDeclaration(manifest.capabilitySettings);
      }
      manifests.push(manifest);
    } catch (error) {
      throw new Error(`${entry.name} Extension settings declaration is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (manifests.length === 0) {
    throw new Error(`Micro-app root contains no readable Extension manifests: ${resolvedRoot}`);
  }
  return manifests;
}

async function loadDynamicProviderPanels(
  microappsRoot: string,
  manifest: JsonRecord,
) {
  const id = String(manifest.id);
  if (typeof manifest.registryManifest !== "string" || !manifest.registryManifest.trim()) {
    return [];
  }
  const pluginManifest = await loadSourcePluginManifest(microappsRoot, manifest, true);
  if (!pluginManifest) return [];
  const panels = asRecord(pluginManifest.doppelganger)?.settingsPanels;
  if (!Array.isArray(panels)) return [];

  return panels.flatMap((value) => {
    const panel = asRecord(value);
    const settings = asRecord(panel?.settings);
    if (!panel || !settings) return [];
    const jsonSchema = asRecord(settings.jsonSchema);
    const uiSchema = asRecord(settings.uiSchema);
    const loadAction = asRecord(settings.loadAction);
    const submitAction = asRecord(settings.submitAction);
    if (typeof panel.panelId !== "string" || !panel.panelId.trim()) {
      throw new Error(`${id} dynamic-provider settings panel requires panelId`);
    }
    if (typeof panel.label !== "string" || !panel.label.trim()) {
      throw new Error(`${id} dynamic-provider settings panel requires label`);
    }
    if (!jsonSchema || jsonSchema.type !== "object") {
      throw new Error(`${id} dynamic-provider settings panel requires object jsonSchema`);
    }
    if (!uiSchema) {
      throw new Error(`${id} dynamic-provider settings panel requires uiSchema`);
    }
    if (
      loadAction?.method !== "GET" ||
      typeof loadAction.path !== "string" ||
      !loadAction.path
    ) {
      throw new Error(`${id} dynamic-provider settings panel requires a GET loadAction`);
    }
    if (
      !["PATCH", "PUT"].includes(String(submitAction?.method)) ||
      typeof submitAction?.path !== "string" ||
      !submitAction.path
    ) {
      throw new Error(`${id} dynamic-provider settings panel requires a PATCH or PUT submitAction`);
    }
    return [{ panel, settings, jsonSchema, uiSchema, loadAction, submitAction }];
  });
}

async function loadSourcePluginManifest(
  microappsRoot: string,
  manifest: JsonRecord,
  requireDeclaredPath = false,
) {
  const id = String(manifest.id);
  const extensionManifestPath = manifestPathForUnit(microappsRoot, id);
  if (!extensionManifestPath) {
    throw new Error(`${id} Extension manifest path is unavailable`);
  }
  const declaredPath = typeof manifest.registryManifest === "string"
    ? manifest.registryManifest.trim()
    : "";
  if (requireDeclaredPath && !declaredPath) return null;
  const registryManifest = declaredPath || "../.codex-plugin/plugin.json";
  const unitRoot = path.dirname(path.dirname(extensionManifestPath));
  const pluginManifestPath = path.resolve(
    path.dirname(extensionManifestPath),
    registryManifest,
  );
  if (
    pluginManifestPath !== unitRoot &&
    !pluginManifestPath.startsWith(`${unitRoot}${path.sep}`)
  ) {
    throw new Error(`${id} registryManifest must stay inside its Micro-app root`);
  }

  try {
    const plugin = JSON.parse(await readFile(pluginManifestPath, "utf8")) as JsonRecord;
    const productPath = path.join(unitRoot, "manifest.json");
    if (existsSync(productPath)) {
      const product = JSON.parse(await readFile(productPath, "utf8")) as JsonRecord;
      plugin.doppelganger = product.doppelganger ?? plugin.doppelganger;
    }
    return plugin;
  } catch (error) {
    if (!declaredPath && (error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw new Error(
      `${id} registry manifest is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function dynamicSettingsSurfaceId(unitId: string, panelId: string) {
  return panelId === unitId
    ? `${unitId}.settings`
    : `${unitId}.${panelId}.settings`;
}

export async function projectExtensionSettings(options: {
  microappsRoot?: string;
  baseProjection?: CapabilitiesHostProjection;
} = {}): Promise<CapabilitiesHostProjection> {
  const base = options.baseProjection ?? emptyProjection();
  const microappsRoot = options.microappsRoot
    ? path.resolve(options.microappsRoot)
    : defaultMicroappsRoot();
  const manifests = await loadExtensionManifests(microappsRoot);
  const extensionRecords = [...base.extensionRecords];
  const actions = [...base.actions];
  const settingsSurfaces = [...base.settingsSurfaces];

  for (const manifest of manifests) {
    const id = String(manifest.id);
    const pluginManifest = await loadSourcePluginManifest(microappsRoot, manifest);
    const pluginDisplayName = asRecord(pluginManifest?.interface)?.displayName;
    const name = typeof manifest.name === "string" && manifest.name.trim()
      ? manifest.name.trim()
      : typeof pluginDisplayName === "string" && pluginDisplayName.trim()
        ? pluginDisplayName.trim()
        : id;
    const declaration = manifest.capabilitySettings === undefined
      ? {
          schemaVersion: "doppelganger.capability-settings.v1",
          state: "none",
          posture: "none",
          reason: "This Extension does not declare a settings surface.",
        }
      : validateSettingsDeclaration(manifest.capabilitySettings) as JsonRecord;
    const available = declaration.state === "available";
    const dynamicPanels = declaration.posture === "dynamic-provider"
      ? await loadDynamicProviderPanels(microappsRoot, manifest)
      : [];
    const settingsAvailable = available || dynamicPanels.length > 0;
    const recordId = `extension:${id}`;
    extensionRecords.push({
      recordId,
      providerId: "marketplace",
      ownerPluginId: id,
      displayName: name,
      description: typeof manifest.description === "string" ? manifest.description : `${name} first-party Extension.`,
      visible: true,
      enabled: true,
      required: (manifest.system as JsonRecord | undefined)?.required === true,
      status: {
        state: "connected",
        detail: settingsAvailable
          ? "Settings available."
          : "No configurable settings.",
      },
      ...(available
        ? { settingsSurfaceId: declaration.settingsSurfaceId }
        : dynamicPanels[0]
          ? { settingsSurfaceId: dynamicSettingsSurfaceId(id, String(dynamicPanels[0].panel.panelId)) }
          : {}),
      capabilities: Array.isArray((manifest.interface as JsonRecord | undefined)?.capabilities)
        ? (manifest.interface as JsonRecord).capabilities
        : [],
      settingsPosture: declaration.posture,
    });
    if (!available) {
      for (const dynamic of dynamicPanels) {
        const panelId = String(dynamic.panel.panelId);
        const settingsSurfaceId = dynamicSettingsSurfaceId(id, panelId);
        const actionPrefix = panelId === id ? recordId : `${recordId}:${panelId}`;
        const loadActionId = `${actionPrefix}:load-settings`;
        const submitActionId = `${actionPrefix}:configure`;
        actions.push(
          {
            actionId: loadActionId,
            ownerRecordId: recordId,
            operation: "open-settings",
            label: dynamic.loadAction.label ?? "Load settings",
            endpoint: gatewayProgramProxyEndpoint(id, dynamic.loadAction.path),
            method: dynamic.loadAction.method,
          },
          {
            actionId: submitActionId,
            ownerRecordId: recordId,
            operation: "configure",
            label: dynamic.submitAction.label ?? "Save settings",
            endpoint: gatewayProgramProxyEndpoint(id, dynamic.submitAction.path),
            method: dynamic.submitAction.method,
          },
        );
        settingsSurfaces.push({
          settingsSurfaceId,
          ownerRecordId: recordId,
          schemaVersion: "doppelganger.capability-settings.v1",
          presentation: "modal",
          title: dynamic.panel.label,
          jsonSchema: dynamic.jsonSchema,
          uiSchema: dynamic.uiSchema,
          loadActionId,
          submitActionId,
          allowedActions: ["configure"],
          audience: "normal",
          applyMode: "live",
        });
      }
      continue;
    }

    const endpoints = declaration.endpoints as JsonRecord;
    const read = endpoints.read as JsonRecord;
    const apply = endpoints.apply as JsonRecord;
    const transport = declaration.transport === "desktop-runtime-bridge"
      ? "desktop-runtime-bridge"
      : undefined;
    const loadActionId = `${recordId}:load-settings`;
    const submitActionId = `${recordId}:configure`;
    actions.push(
      {
        actionId: loadActionId,
        ownerRecordId: recordId,
        operation: "open-settings",
        label: "Load settings",
        endpoint: gatewayProgramProxyEndpoint(id, read.path),
        method: read.method,
        ...(transport ? { transport } : {}),
      },
      {
        actionId: submitActionId,
        ownerRecordId: recordId,
        operation: "configure",
        label: "Save settings",
        endpoint: gatewayProgramProxyEndpoint(id, apply.path),
        method: apply.method,
        ...(transport ? { transport } : {}),
      },
    );
    settingsSurfaces.push({
      settingsSurfaceId: declaration.settingsSurfaceId,
      ownerRecordId: recordId,
      schemaVersion: declaration.schemaVersion,
      presentation: "modal",
      title: declaration.title,
      ...(declaration.description ? { description: declaration.description } : {}),
      jsonSchema: declaration.jsonSchema,
      ...(declaration.uiSchema ? { uiSchema: declaration.uiSchema } : {}),
      loadActionId,
      submitActionId,
      allowedActions: ["configure"],
      audience: declaration.audience,
      applyMode: transport ? "live" : declaration.applyMode,
    });
  }

  assertUnique("Extension record ownership", extensionRecords.map(record => String(record.recordId)));
  assertUnique("Plugin record ownership", base.pluginRecords.map(record => String(record.recordId)));
  assertUnique("capability action ownership", actions.map(action => String(action.actionId)));
  assertUnique("settings surface ownership", settingsSurfaces.map(surface => String(surface.settingsSurfaceId)));
  return { ...base, extensionRecords, actions, settingsSurfaces };
}

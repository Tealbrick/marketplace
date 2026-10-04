import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RegistryEntry = {
  name: string;
  source: {
    source: string;
    path: string;
  };
};

type Capability = {
  pluginId: string;
  toolName: string;
};

const sourceRoot = path.resolve(import.meta.dirname, "..");
const SERVICE_TOKEN = "marketplace-installed-smoke-service-token";

async function copyInstalledPayload(installedRoot: string) {
  await cp(sourceRoot, installedRoot, {
    recursive: true,
    filter: (entry) => {
      const parts = entry.split(path.sep);
      return !parts.includes("node_modules") && !parts.includes(".git") && !parts.includes(".turbo");
    },
  });
  await cp(
    path.resolve(sourceRoot, "..", ".sdk"),
    path.resolve(installedRoot, "..", ".sdk"),
    {
      recursive: true,
      filter: (entry) => !entry.split(path.sep).includes("node_modules"),
    },
  );
}

async function writeInstalledRegistry(registryPath: string) {
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    JSON.stringify(
      {
        name: "Temporary Marketplace App-home Registry",
        plugins: [
          {
            name: "marketplace",
            version: "0.1.0",
            category: "marketplace",
            source: {
              source: "local",
              path: "./microapps/marketplace",
            },
            policy: {
              required: false,
              enabledByDefault: true,
              disableAllowed: true,
              systemRole: "marketplace",
            },
          },
        ],
      },
      null,
      2,
    ),
  );
}

async function discoverInstalledMarketplace(input: { appHome: string; registryPath: string }) {
  const registry = JSON.parse(await readFile(input.registryPath, "utf8")) as { plugins?: RegistryEntry[] };
  const entry = registry.plugins?.find((plugin) => plugin.name === "marketplace");
  if (!entry) {
    throw new Error("Installed App-home registry did not include marketplace.");
  }
  if (entry.source.source !== "local" || entry.source.path !== "./microapps/marketplace") {
    throw new Error(`Marketplace registry entry points at the wrong source: ${JSON.stringify(entry)}`);
  }

  const root = path.resolve(input.appHome, entry.source.path);
  type ManifestNamespace = {
    dataTransports?: unknown[];
    surfaces?: unknown[];
    settingsPanels?: unknown[];
  };
  const pluginManifest = JSON.parse(await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8")) as {
    name?: string;
    tealbrick?: ManifestNamespace;
    doppelganger?: ManifestNamespace;
  };
  if (pluginManifest.name !== "marketplace") {
    throw new Error("Installed loader manifest did not identify marketplace.");
  }
  // Namespace key `tealbrick`, legacy `doppelganger` (see program/src/legacy-ids.ts).
  const namespace = pluginManifest.tealbrick ?? pluginManifest.doppelganger;
  if (!namespace?.dataTransports?.length) {
    throw new Error("Installed Marketplace manifest did not expose data transports.");
  }
  if (!namespace.surfaces?.length || !namespace.settingsPanels?.length) {
    throw new Error("Installed Marketplace manifest did not expose extension surfaces/settings.");
  }

  const hermesManifest = await readFile(path.join(root, "plugin", "hermes", "plugin.yaml"), "utf8");
  for (const required of [
    "marketplace_agent_capabilities",
    "marketplace_plugin_register",
    "marketplace_plugin_execute",
    "marketplace_debug_events",
  ]) {
    if (!hermesManifest.includes(required)) {
      throw new Error(`Installed Hermes adapter manifest is missing ${required}.`);
    }
  }

  return { entry, root, pluginManifest };
}

async function requestJson(baseUrl: string, pathname: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const body = await response.json() as unknown;
  return { response, body };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tealbrick-marketplace-installed-home-"));
  const appHome = path.join(tempRoot, "app-home");
  const installedRoot = path.join(appHome, "microapps", "marketplace");
  const registryPath = path.join(appHome, ".agents", "plugins", "marketplace.json");
  const dataDir = path.join(appHome, "programs", "marketplace", "data");
  const dbPath = path.join(dataDir, "marketplace.sqlite");
  const logPath = path.join(appHome, "programs", "marketplace", "logs", "marketplace-debug.jsonl");
  let app: { close: () => Promise<void> } | null = null;
  let store: { close: () => void; upsertConnection: (input: Record<string, unknown>) => unknown } | null = null;

  try {
    await copyInstalledPayload(installedRoot);
    await writeInstalledRegistry(registryPath);
    const discovery = await discoverInstalledMarketplace({ appHome, registryPath });

    await execFileAsync("pnpm", [
      "--dir",
      path.join(installedRoot, "program"),
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);

    const appModule = await import(pathToFileURL(path.join(installedRoot, "program", "src", "app.ts")).href) as {
      buildMarketplaceApp: (options: Record<string, unknown>) => Promise<{ listen: (options: { host: string; port: number }) => Promise<string>; close: () => Promise<void> }>;
    };
    const storeModule = await import(pathToFileURL(path.join(installedRoot, "program", "src", "store.ts")).href) as {
      SqliteMarketplaceStore: new (dbPath: string, options: { logPath: string; debug: boolean }) => { close: () => void; upsertConnection: (input: Record<string, unknown>) => unknown };
    };

    const decisions = new Map<string, "allow" | "deny">([
      ["installed-denied-trace", "deny"],
      ["installed-allowed-trace", "allow"],
    ]);
    const providerCalls: unknown[] = [];

    store = new storeModule.SqliteMarketplaceStore(dbPath, { logPath, debug: true });
    app = await appModule.buildMarketplaceApp({
      store,
      debug: true,
      logPath,
      internalAuthToken: SERVICE_TOKEN,
      organizationId: "installed-smoke",
      env: { COMPOSIO_API_KEY: "marketplace-installed-smoke-composio-key" },
      providerFetch: async (input: unknown, init?: { body?: unknown }) => {
        if (String(input).includes("/tools/execute/GITHUB_LIST_REPOSITORIES")) {
          providerCalls.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ data: [{ name: "Doppelganger/installed-app-home-provider" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
      rulesClient: async (input: { payload: Record<string, unknown> }) => ({
        effect: decisions.get(String(input.payload.traceId)) ?? "allow",
        decisionId: `rules-${String(input.payload.traceId ?? "default")}`,
        reason: decisions.get(String(input.payload.traceId)) === "deny" ? "installed smoke denial" : undefined,
      }),
    });

    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

    const health = await requestJson(baseUrl, "/healthz");
    if (health.response.status !== 200) {
      throw new Error(`installed Program health failed ${health.response.status}: ${JSON.stringify(health.body)}`);
    }

    await requestJson(baseUrl, "/api/marketplace/provider-health?workspaceSlug=installed-smoke", {
      headers: { "x-trace-id": "installed-provider-health-trace" },
    });

    const initial = await requestJson(baseUrl, "/api/agent/capabilities?workspaceSlug=installed-smoke");
    if (initial.response.status !== 200) {
      throw new Error(`installed initial capability discovery failed ${initial.response.status}`);
    }

    await requestJson(baseUrl, "/api/marketplace/catalog/composio/import", {
      method: "POST",
      body: JSON.stringify({
        workspaceSlug: "installed-smoke",
        actorId: "installed-agent",
        toolkit: "github",
        pluginId: "github-composio",
        tools: [{ name: "GITHUB_LIST_REPOSITORIES", description: "List GitHub repositories." }],
        autoEnable: true,
      }),
    });
    store.upsertConnection({ workspaceSlug: "installed-smoke", pluginId: "github-composio", provider: "github", backend: "composio", state: "connected", detail: "Installed smoke connected account", metadata: { connectedAccountId: "ca_installed_smoke" } });

    const discovered = await requestJson(baseUrl, "/api/agent/capabilities?workspaceSlug=installed-smoke");
    const capabilities = (discovered.body as { capabilities?: Capability[] }).capabilities ?? [];
    if (!capabilities.some((capability) => capability.toolName === "marketplace.github.list.repositories")) {
      throw new Error(`installed capability discovery did not expose marketplace.github.list.repositories: ${JSON.stringify(discovered.body)}`);
    }

    const denied = await requestJson(baseUrl, "/api/agent/tools/marketplace.github.list.repositories", {
      method: "POST",
      headers: { "x-trace-id": "installed-denied-trace" },
      body: JSON.stringify({
        workspaceSlug: "installed-smoke",
        actorId: "installed-agent",
        pluginId: "github-composio",
        input: { owner: "Doppelganger" },
      }),
    });
    if (denied.response.status !== 403) {
      throw new Error(`installed denied execution expected 403: ${JSON.stringify(denied.body)}`);
    }

    const allowed = await requestJson(baseUrl, "/api/agent/tools/marketplace.github.list.repositories", {
      method: "POST",
      headers: { "x-trace-id": "installed-allowed-trace" },
      body: JSON.stringify({
        workspaceSlug: "installed-smoke",
        actorId: "installed-agent",
        pluginId: "github-composio",
        input: { owner: "Doppelganger" },
      }),
    });
    if (allowed.response.status !== 200) {
      throw new Error(`installed allowed execution expected 200: ${JSON.stringify(allowed.body)}`);
    }
    if (providerCalls.length !== 1) {
      throw new Error(`installed smoke expected one provider call, saw ${providerCalls.length}`);
    }

    await requestJson(baseUrl, "/api/marketplace/plugins/github-composio/uninstall", {
      method: "POST",
      headers: { "x-trace-id": "installed-uninstall-trace" },
      body: JSON.stringify({ workspaceSlug: "installed-smoke", actorId: "installed-agent" }),
    });

    const debugEvents = await requestJson(baseUrl, "/api/debug/events?workspaceSlug=installed-smoke");
    const eventTypes = new Set((debugEvents.body as { events?: Array<{ type?: string }> }).events?.map((event) => event.type));
    for (const expected of [
      "marketplace.provider.health",
      "marketplace.composio.toolkit.imported",
      "marketplace.plugin.uninstalled",
      "marketplace.execution.requested",
      "marketplace.execution.denied",
      "marketplace.execution.completed",
    ]) {
      if (!eventTypes.has(expected)) {
        throw new Error(`installed smoke missing event family ${expected}: ${JSON.stringify(debugEvents.body)}`);
      }
    }

    const debugLogs = await requestJson(baseUrl, "/api/debug/logs?tail=50");
    const lines = (debugLogs.body as { lines?: string[] }).lines ?? [];
    if (!lines.join("\n").includes("installed-denied-trace") || !lines.join("\n").includes("installed-allowed-trace")) {
      throw new Error(`installed debug logs did not include expected trace ids: ${JSON.stringify(debugLogs.body)}`);
    }

    console.log(JSON.stringify({
      ok: true,
      evidenceLevel: "installed-app-home-temp",
      appHome,
      registryPath,
      installedRoot: discovery.root,
      baseUrl,
      dbPath,
      logPath,
      discoveredTools: capabilities.map((capability) => capability.toolName),
      providerCalls: providerCalls.length,
      cleaned: true,
    }, null, 2));
  } finally {
    if (app) {
      await app.close();
    }
    if (store) {
      store.close();
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

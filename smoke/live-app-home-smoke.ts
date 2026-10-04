import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RegistryPlugin = {
  name?: string;
  version?: string;
  category?: string;
  source?: {
    source?: string;
    path?: string;
  };
  policy?: Record<string, unknown>;
  [key: string]: unknown;
};

type Registry = {
  name?: string;
  interface?: Record<string, unknown>;
  plugins?: RegistryPlugin[];
  [key: string]: unknown;
};

type ManifestNamespace = {
  surfaces?: Array<Record<string, unknown>>;
  settingsPanels?: Array<Record<string, unknown>>;
  dataTransports?: Array<Record<string, unknown>>;
};

type ManifestRecord = {
  name?: string;
  tealbrick?: ManifestNamespace;
  doppelganger?: ManifestNamespace;
};

const sourceRoot = path.resolve(import.meta.dirname, "..");

// TEALBRICK_APP_HOME; DOPPELGANGER_APP_HOME is a deprecated alias.
function envAppHome() {
  if (!process.env.TEALBRICK_APP_HOME && process.env.DOPPELGANGER_APP_HOME) {
    console.warn("[marketplace] DOPPELGANGER_APP_HOME is deprecated; set TEALBRICK_APP_HOME instead.");
  }
  return process.env.TEALBRICK_APP_HOME || process.env.DOPPELGANGER_APP_HOME || process.env.T3CODE_HOME;
}

function parseArgs(argv: string[]) {
  const result = {
    appHome: envAppHome() || path.join(os.homedir(), ".t3"),
    sourceRoot,
    programHealth: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--app-home") {
      result.appHome = argv.at(index + 1) ?? "";
      index += 1;
    } else if (arg === "--source-root") {
      result.sourceRoot = argv.at(index + 1) ?? "";
      index += 1;
    } else if (arg === "--no-program-health") {
      result.programHealth = false;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!result.appHome.trim()) {
    throw new Error("Missing App home. Pass --app-home or set TEALBRICK_APP_HOME/T3CODE_HOME.");
  }
  if (!result.sourceRoot.trim()) {
    throw new Error("Missing Marketplace source root.");
  }

  return {
    appHome: path.resolve(result.appHome),
    sourceRoot: path.resolve(result.sourceRoot),
    programHealth: result.programHealth,
  };
}

function assertInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify path outside ${parent}: ${child}`);
  }
}

async function copyMarketplacePayload(input: { sourceRoot: string; installedRoot: string; appHome: string }) {
  assertInside(input.appHome, input.installedRoot);
  await rm(input.installedRoot, { recursive: true, force: true });
  await mkdir(path.dirname(input.installedRoot), { recursive: true });
  await cp(input.sourceRoot, input.installedRoot, {
    recursive: true,
    filter: (entry) => {
      const parts = entry.split(path.sep);
      return !parts.includes("node_modules") && !parts.includes(".git") && !parts.includes(".turbo");
    },
  });
}

async function readRegistry(registryPath: string): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8")) as Registry;
    return {
      ...parsed,
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
    };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        name: "Teal Brick App Registry",
        interface: {
          displayName: "App Registry",
          developerName: "Teal Brick",
          category: "Installed Extensions",
        },
        plugins: [],
      };
    }
    throw error;
  }
}

async function upsertMarketplaceRegistry(registryPath: string) {
  const registry = await readRegistry(registryPath);
  const plugins = (registry.plugins ?? []).filter((plugin) => plugin.name !== "marketplace");
  plugins.push({
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
  });

  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(
    registryPath,
    `${JSON.stringify({
      ...registry,
      name: typeof registry.name === "string" ? registry.name : "Teal Brick App Registry",
      plugins,
    })}\n`,
  );
}

async function verifyInstalledDiscovery(input: { appHome: string; registryPath: string }) {
  const registry = await readRegistry(input.registryPath);
  const entry = registry.plugins?.find((plugin) => plugin.name === "marketplace");
  if (!entry) {
    throw new Error("Live App-home registry does not include marketplace.");
  }
  if (entry.source?.source !== "local" || entry.source.path !== "./microapps/marketplace") {
    throw new Error(`Marketplace registry entry is not an installed App-home source: ${JSON.stringify(entry)}`);
  }

  const installedRoot = path.resolve(input.appHome, entry.source.path);
  const manifest = JSON.parse(
    await readFile(path.join(installedRoot, ".codex-plugin", "plugin.json"), "utf8"),
  ) as ManifestRecord;

  // Namespace key `tealbrick`, legacy `doppelganger` (see program/src/legacy-ids.ts).
  const namespace = manifest.tealbrick ?? manifest.doppelganger;
  const surface = namespace?.surfaces?.find(
    (candidate) => candidate.surfaceId === "marketplace" && candidate.routeSegment === "marketplace",
  );
  const settingsPanel = namespace?.settingsPanels?.find(
    (candidate) => candidate.panelId === "marketplace",
  );
  const dataTransport = namespace?.dataTransports?.find(
    (candidate) => candidate.transportId === "marketplace-api",
  );

  if (manifest.name !== "marketplace") {
    throw new Error(`Installed manifest name mismatch: ${manifest.name ?? "<missing>"}`);
  }
  if (!surface) {
    throw new Error("Installed Marketplace manifest does not expose /extensions/marketplace surface metadata.");
  }
  if (!settingsPanel) {
    throw new Error("Installed Marketplace manifest does not expose the marketplace settings panel.");
  }
  if (!dataTransport) {
    throw new Error("Installed Marketplace manifest does not expose marketplace-api data transport.");
  }

  return {
    installedRoot,
    surfaceRoute: "/extensions/marketplace",
    dataTransportKey: "marketplace:marketplace-api",
    operationCount: Array.isArray(dataTransport.operations) ? dataTransport.operations.length : 0,
  };
}

async function waitForProgramUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for Marketplace Program dynamic port."));
    }, 15_000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/u)) {
        try {
          const payload = JSON.parse(line) as { event?: unknown; baseUrl?: unknown };
          if (
            typeof payload.event === "string" &&
            payload.event.endsWith(".ready") &&
            typeof payload.baseUrl === "string"
          ) {
            cleanup();
            resolve(payload.baseUrl.replace(/\/+$/u, ""));
            return;
          }
        } catch {
          // Ignore non-JSON process logs.
        }
      }
      const match = text.match(/Marketplace Program listening at (http:\/\/[^\s]+)/);
      if (match?.[1]) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Marketplace Program exited before listening, code=${code ?? "null"}.`));
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

async function verifyProgramHealth(input: { appHome: string; installedRoot: string }) {
  await execFileAsync("pnpm", [
    "--dir",
    path.join(input.installedRoot, "program"),
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);

  const child = spawn("pnpm", ["--dir", path.join(input.installedRoot, "program"), "dev:miniapp"], {
    env: {
      ...process.env,
      TEALBRICK_DEBUG: "1",
      MARKETPLACE_PORT: "0",
      MARKETPLACE_DATA_DIR: path.join(input.appHome, "programs", "marketplace", "data"),
    },
  });

  try {
    const baseUrl = await waitForProgramUrl(child);
    const health = await fetch(`${baseUrl}/healthz`);
    if (health.status !== 200) {
      throw new Error(`Installed Marketplace Program health failed: ${health.status}`);
    }
    const status = await fetch(`${baseUrl}/api/status`);
    if (status.status !== 200) {
      throw new Error(`Installed Marketplace Program status failed: ${status.status}`);
    }
    return {
      baseUrl,
      health: health.status,
      status: status.status,
      dynamicPort: new URL(baseUrl).port,
    };
  } finally {
    child.kill();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const installedRoot = path.join(options.appHome, "microapps", "marketplace");
  const registryPath = path.join(options.appHome, ".agents", "plugins", "marketplace.json");

  await copyMarketplacePayload({
    sourceRoot: options.sourceRoot,
    installedRoot,
    appHome: options.appHome,
  });
  await upsertMarketplaceRegistry(registryPath);
  const discovery = await verifyInstalledDiscovery({ appHome: options.appHome, registryPath });
  const program = options.programHealth
    ? await verifyProgramHealth({ appHome: options.appHome, installedRoot })
    : null;

  console.log(JSON.stringify({
    ok: true,
    evidenceLevel: "real-app-home-install",
    appHome: options.appHome,
    registryPath,
    installedRoot: discovery.installedRoot,
    surfaceRoute: discovery.surfaceRoute,
    dataTransportKey: discovery.dataTransportKey,
    operationCount: discovery.operationCount,
    program,
    refreshRequiredForAlreadyRunningBackend: true,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

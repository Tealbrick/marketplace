// Marketplace 0.2.0 (Channels) upgrade / rollback rehearsal: 0.1.19 -> 0.2.0 -> 0.1.19 -> 0.2.0 on ONE data directory.
//
//   pnpm -C program exec tsx scripts/channels-upgrade-rehearsal.ts [--old-ref v0.1.19] [--new-ref worktree|<git ref>] [--keep]
//
// OLD: the prebuilt release bundle of --old-ref (release/railway/dist/marketplace-program.mjs, exactly what the
//      Railway image's entrypoint.mjs imports when TS_AUTHKEY is unset), extracted with `git archive` and run as a
//      child process on a random 127.0.0.1 port. No Portal, dummy test secrets, a local fake Composio.
// NEW: buildMarketplaceApp in-process from --new-ref ("worktree" = this checkout; any other ref is extracted with
//      `git archive` and reuses this checkout's node_modules when the lockfile is identical), with fake Telegram /
//      Discord providers, a fake Portal and a virtual channel clock. No real network: global fetch only reaches
//      127.0.0.1, and every provider base URL points at local fakes.
// Evidence (JSON + Markdown) goes to CHANNELS_REHEARSAL_OUT
// (default /Users/puma/work/artifacts/marketplace-channels-0.2.0/rehearsal-<timestamp>/). Temp state goes to
// CHANNELS_REHEARSAL_WORK (default: a new directory under the OS temp dir); it is removed after a PASS unless --keep.
// Exit code: 0 when every phase passes, 1 on any FAIL, 2 on a usage error. See docs/channels-upgrade-rehearsal.md.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, readdirSync, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { FastifyInstance, LightMyRequestResponse } from "fastify";

type AppModule = typeof import("../src/app.js");
type StoreModule = typeof import("../src/store.js");
type OperatorModule = typeof import("../src/operator-auth.js");
type SettingsModule = typeof import("../src/provider-settings.js");
type FixtureModule = typeof import("../src/channels/app-fixture.js");
type ContractModule = typeof import("../src/contract.js");
type RoutesModule = typeof import("../src/channels/routes.js");
type ServiceModule = typeof import("../src/channels/service.js");
type ChannelStoreModule = typeof import("../src/channels/store.js");
type TypesModule = typeof import("../src/types.js");
type ConnectorCapability = import("../src/types.js").ConnectorCapability;
type ChannelDestination = import("../src/channels/providers/types.js").ChannelDestination;
type FakeProvider = ReturnType<FixtureModule["fakeProvider"]>;

// ---------------------------------------------------------------------------------------------------------------
// Arguments and constants
// ---------------------------------------------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROGRAM_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(PROGRAM_DIR, "..");
const DEFAULT_OUT_ROOT = "/Users/puma/work/artifacts/marketplace-channels-0.2.0";

const TENANT = "tenant-rehearsal";
const PORTAL = "https://portal.rehearsal.invalid";
const AGENT_ID = "agent-rehearsal";

export type Args = { oldRef: string; newRef: string; keep: boolean };

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { oldRef: "v0.1.19", newRef: "worktree", keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--keep") args.keep = true;
    else if (flag === "--old-ref" || flag === "--new-ref") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (flag === "--old-ref") args.oldRef = value;
      else args.newRef = value;
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

// ---------------------------------------------------------------------------------------------------------------
// Step recording
// ---------------------------------------------------------------------------------------------------------------

type Status = "PASS" | "FAIL";
type StepRecord = { name: string; status: Status; evidence: Record<string, unknown>; failures: string[] };
type PhaseRecord = {
  id: string;
  title: string;
  status: Status;
  steps: StepRecord[];
  snapshot?: PhaseSnapshot;
};
type PhaseSnapshot = {
  version: string | null;
  tables: string[];
  counts: Record<string, number>;
  identity: IdentityView;
  dataFiles: Record<string, string>;
};
type IdentityView = { file: string; sha256: string | null; instanceId: string | null; servedInstanceId?: string | null };

class Abort extends Error {}

type StepApi = { ev(entries: Record<string, unknown>): void; expect(condition: unknown, message: string): void };

let secretsForRedaction: string[] = [];
const redact = (text: string) => secretsForRedaction.reduce((acc, secret) => (secret ? acc.split(secret).join("[REDACTED]") : acc), text);
const out = (line: string) => void process.stdout.write(`${redact(line)}\n`);

class Phase {
  readonly record: PhaseRecord;
  constructor(id: string, title: string) {
    this.record = { id, title, status: "PASS", steps: [] };
    out(`\n=== ${id}: ${title}`);
  }
  async step(name: string, run: (s: StepApi) => Promise<void> | void): Promise<Status> {
    const record: StepRecord = { name, status: "PASS", evidence: {}, failures: [] };
    const api: StepApi = {
      ev: (entries) => Object.assign(record.evidence, entries),
      expect: (condition, message) => {
        if (!condition) record.failures.push(message);
      },
    };
    try {
      await run(api);
    } catch (error) {
      record.failures.push(`error: ${redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`);
    }
    record.status = record.failures.length === 0 ? "PASS" : "FAIL";
    if (record.status === "FAIL") this.record.status = "FAIL";
    this.record.steps.push(record);
    out(`  ${record.status} ${name}`);
    const evidence = JSON.stringify(record.evidence);
    if (evidence !== "{}") out(`       evidence: ${evidence.length > 600 ? `${evidence.slice(0, 600)}...` : evidence}`);
    for (const failure of record.failures) out(`       FAIL: ${failure}`);
    return record.status;
  }
  /** A failing critical step stops the rehearsal: later phases would test nothing. */
  async must(name: string, run: (s: StepApi) => Promise<void> | void) {
    if ((await this.step(name, run)) === "FAIL") throw new Abort(`${this.record.id}: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers: hashing, git, ports, SQLite snapshots
// ---------------------------------------------------------------------------------------------------------------

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const sha256File = (file: string) => (existsSync(file) ? sha256(readFileSync(file)) : null);
const b64 = (bytes: number) => randomBytes(bytes).toString("base64url");

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** `git archive <ref> <paths...> | tar -x -C <dir>` without a shell. */
async function extractRef(ref: string, paths: string[], dir: string) {
  await mkdir(dir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", ref, ...paths], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    archive.stderr.on("data", (chunk) => (stderr += String(chunk)));
    tar.stderr.on("data", (chunk) => (stderr += String(chunk)));
    archive.stdout.pipe(tar.stdin);
    let pending = 2;
    const done = (code: number | null) => {
      if (code !== 0) reject(new Error(`git archive ${ref} failed: ${stderr.trim()}`));
      else if ((pending -= 1) === 0) resolve();
    };
    archive.on("close", done);
    tar.on("close", done);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TableSnapshot = { count: number; hash: string; rows: Record<string, string> };
type DbSnapshot = { tables: string[]; perTable: Record<string, TableSnapshot> };

function rowHash(row: Record<string, unknown>) {
  const normal = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? `hex:${Buffer.from(value).toString("hex")}` : typeof value === "bigint" ? value.toString() : value]),
  );
  return sha256(JSON.stringify(normal));
}

/** Reads every table (row hashes keyed by rowid) while no app has the database open. */
function snapshotDb(dbPath: string): DbSnapshot {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => String(row.name),
    );
    const perTable: Record<string, TableSnapshot> = {};
    for (const table of tables) {
      let rows: Array<Record<string, unknown>>;
      let keyed = true;
      try {
        rows = db.prepare(`SELECT rowid AS "__rowid", * FROM "${table}" ORDER BY rowid`).all() as Array<Record<string, unknown>>;
      } catch {
        keyed = false;
        rows = db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
      }
      const map: Record<string, string> = {};
      rows.forEach((row, index) => {
        const key = keyed ? String(row.__rowid) : `#${index}`;
        const { __rowid: _ignored, ...rest } = row;
        map[key] = rowHash(rest);
      });
      perTable[table] = { count: rows.length, hash: sha256(Object.entries(map).map(([key, value]) => `${key}:${value}`).join("\n")), rows: map };
    }
    return { tables, perTable };
  } finally {
    db.close();
  }
}

/** One query against the closed database (statuses, specific rows). */
function queryDb<T = Record<string, unknown>>(dbPath: string, sql: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

type TableDiff = { added: string[]; removed: string[]; changed: string[] };
function diffTable(before: TableSnapshot | undefined, after: TableSnapshot | undefined): TableDiff {
  const a = before?.rows ?? {};
  const b = after?.rows ?? {};
  return {
    added: Object.keys(b).filter((key) => !(key in a)),
    removed: Object.keys(a).filter((key) => !(key in b)),
    changed: Object.keys(a).filter((key) => key in b && a[key] !== b[key]),
  };
}

const countsOf = (snapshot: DbSnapshot, tables: readonly string[]) => Object.fromEntries(tables.map((table) => [table, snapshot.perTable[table]?.count ?? -1]));

function walkFiles(root: string, base = root, acc: Record<string, string> = {}) {
  if (!existsSync(root)) return acc;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, acc);
    else if (entry.isFile()) acc[path.relative(base, full)] = sha256(readFileSync(full));
  }
  return acc;
}

function readIdentity(stateDir: string): IdentityView {
  const file = path.join(stateDir, "instance-claim-identity.json");
  if (!existsSync(file)) return { file, sha256: null, instanceId: null };
  const raw = readFileSync(file);
  let instanceId: string | null = null;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as { instanceId?: unknown };
    instanceId = typeof parsed.instanceId === "string" ? parsed.instanceId : null;
  } catch {
    instanceId = null;
  }
  return { file, sha256: sha256(raw), instanceId };
}

// ---------------------------------------------------------------------------------------------------------------
// Local fakes: Composio (both sides) and the network guard (in-process side)
// ---------------------------------------------------------------------------------------------------------------

async function startFakeComposio() {
  const requests: Array<{ method: string; path: string }> = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? "GET", path: (request.url ?? "/").split("?")[0]! });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: [], next_cursor: null, total_items: 0 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/api/v3`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
function installNetworkGuard() {
  const original = globalThis.fetch;
  const blocked: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      blocked.push(`${url.protocol}//${url.host}${url.pathname}`);
      throw new Error("channels_rehearsal_network_blocked");
    }
    return original(input, init);
  }) as typeof fetch;
  return { blocked, restore: () => void (globalThis.fetch = original) };
}

/** Records intervals created while tracking is on, and which of them were cleared (until restore()). */
function trackIntervals() {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const created = new Set<unknown>();
  let tracking = true;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = originalSet(...args);
    if (tracking) created.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
    created.delete(handle);
    originalClear(handle);
  }) as typeof clearInterval;
  let total = 0;
  return {
    stopTracking() {
      tracking = false;
      total = created.size;
    },
    created: () => total,
    active: () => created.size,
    restore() {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// OLD: the prebuilt release bundle as a child process
// ---------------------------------------------------------------------------------------------------------------

type OldProcess = {
  port: number;
  base: string;
  child: ChildProcess;
  logFile: string;
  output: () => string;
  stop: () => Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
};

async function startOld(input: { bundleDir: string; env: Record<string, string>; logFile: string }): Promise<OldProcess> {
  const port = Number(input.env.MARKETPLACE_PORT);
  const base = `http://127.0.0.1:${port}`;
  const log: WriteStream = createWriteStream(input.logFile, { flags: "a" });
  let captured = "";
  const child = spawn(process.execPath, ["./dist/marketplace-program.mjs"], { cwd: input.bundleDir, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
  const sink = (chunk: Buffer) => {
    captured += chunk.toString("utf8");
    log.write(chunk);
  };
  child.stdout!.on("data", sink);
  child.stderr!.on("data", sink);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    }),
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`0.1.19 exited before /healthz (code ${(exited as { code: number | null }).code}): ${captured.slice(-800)}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`0.1.19 did not answer /healthz within 30 s: ${captured.slice(-800)}`);
    }
    await sleep(150);
  }
  return {
    port,
    base,
    child,
    logFile: input.logFile,
    output: () => captured,
    stop: async () => {
      const started = Date.now();
      if (!exited) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const result = await exitPromise;
      clearTimeout(timer);
      await new Promise<void>((resolve) => log.end(resolve));
      return { ...result, ms: Date.now() - started };
    },
  };
}

type HttpResult = { status: number; body: unknown; text: string };

async function httpJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<HttpResult & { headers: Headers }> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text, headers: res.headers };
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The 0.1.19 read endpoints that phases 1 and 3 call; phase 3 must answer each the same way. */
const OLD_READ_ENDPOINTS = [
  { path: "/healthz", auth: "none" },
  { path: "/api/marketplace/health", auth: "bearer" },
  { path: "/api/status", auth: "bearer" },
  { path: "/api/marketplace/catalog", auth: "bearer" },
  { path: "/api/marketplace/plugins", auth: "bearer" },
  { path: "/api/marketplace/cards/summary", auth: "bearer" },
  { path: "/api/marketplace/company-box/approvals", auth: "operator" },
  { path: "/api/marketplace/agent/grants", auth: "operator" },
  { path: "/api/marketplace/audit", auth: "bearer" },
  { path: "/api/tealbrick/claim", auth: "bearer" },
  { path: "/.well-known/tealbrick/claim", auth: "bearer" },
  { path: "/api/marketplace/connectors/custom", auth: "operator" },
] as const;

// ---------------------------------------------------------------------------------------------------------------
// NEW: buildMarketplaceApp in-process
// ---------------------------------------------------------------------------------------------------------------

type NewModules = {
  app: AppModule;
  store: StoreModule;
  operator: OperatorModule;
  settings: SettingsModule;
  fixture: FixtureModule;
  contract: ContractModule;
  routes: RoutesModule;
  service: ServiceModule;
  channelStore: ChannelStoreModule;
  types: TypesModule;
};

async function loadNewModules(programDir: string): Promise<NewModules> {
  const load = <T>(rel: string) => import(pathToFileURL(path.join(programDir, rel)).href) as Promise<T>;
  return {
    app: await load<AppModule>("src/app.ts"),
    store: await load<StoreModule>("src/store.ts"),
    operator: await load<OperatorModule>("src/operator-auth.ts"),
    settings: await load<SettingsModule>("src/provider-settings.ts"),
    fixture: await load<FixtureModule>("src/channels/app-fixture.ts"),
    contract: await load<ContractModule>("src/contract.ts"),
    routes: await load<RoutesModule>("src/channels/routes.ts"),
    service: await load<ServiceModule>("src/channels/service.ts"),
    channelStore: await load<ChannelStoreModule>("src/channels/store.ts"),
    types: await load<TypesModule>("src/types.ts"),
  };
}

type Secrets = {
  internal: string;
  handoffKey: string;
  operatorAccess: string;
  composioKey: string;
  portalProof: string;
  telegram: string;
  discord: string;
  agentGrant: string;
};

type NewApp = Awaited<ReturnType<typeof startNew>>;

async function startNew(input: {
  mods: NewModules;
  dbPath: string;
  secrets: Secrets;
  composioBaseUrl: string;
  clock: { now: number };
  scheduler: boolean;
  telegram: FakeProvider;
  discord: FakeProvider;
}) {
  const { mods, secrets } = input;
  const stateDir = path.dirname(input.dbPath);
  const providerEnv = { COMPOSIO_API_KEY: secrets.composioKey, COMPOSIO_BASE_URL: input.composioBaseUrl };
  const store = new mods.store.SqliteMarketplaceStore(input.dbPath, { handoffEncryptionKey: secrets.handoffKey });
  const providerSettings = new mods.settings.MarketplaceProviderSettingsStore(
    path.join(stateDir, "provider-settings.json"),
    path.join(stateDir, "provider-secrets.json"),
    providerEnv,
  );
  const agentOps = [
    ...Object.values(mods.routes.CHANNEL_AGENT_OPERATION),
    mods.contract.AGENT_OPERATION.approvalsResolve,
    mods.contract.AGENT_OPERATION.consentsList,
    mods.contract.AGENT_OPERATION.toolsCall,
  ];
  const portalRequests: string[] = [];
  const portalFetch: typeof fetch = async (url, init) => {
    const target = String(url);
    portalRequests.push(new URL(target).pathname);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (target.endsWith("/api/runtime/app-grant/introspect")) {
      if (body.token !== secrets.agentGrant) return new Response(JSON.stringify({ error: "app_grant_denied" }), { status: 403 });
      return new Response(
        JSON.stringify({
          authorized: true,
          principalId: `tealbrick-agent:${AGENT_ID}`,
          agentId: AGENT_ID,
          orgId: "portal-org-rehearsal",
          workspaceId: TENANT,
          deploymentId: "deployment-rehearsal",
          product: "marketplace",
          productTenantId: TENANT,
          actions: ["create", "read", "update", "delete"],
          operations: agentOps,
          capabilityRevision: 1,
          expiresAt: Date.now() + 600_000,
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  };
  const operatorSessions = new mods.operator.MarketplaceOperatorSessionManager({ allowUnauthenticated: true, organizationId: TENANT, operatorId: "operator-rehearsal" });
  // Every interval the app creates while it is built (the 30 s channel scheduler) must be cleared by app.close().
  const intervals = trackIntervals();
  const app: FastifyInstance = await mods.app.buildMarketplaceApp({
    store,
    internalAuthToken: secrets.internal,
    organizationId: TENANT,
    allowUnauthenticatedOperator: true,
    operatorSessionManager: operatorSessions,
    providerSettings,
    instanceClaimDir: stateDir,
    environment: {
      NODE_ENV: "production",
      MARKETPLACE_ORGANIZATION_ID: TENANT,
      MARKETPLACE_PORTAL_URL: `${PORTAL}/`,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: secrets.portalProof,
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-rehearsal",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-rehearsal",
      MARKETPLACE_PORTAL_WORKSPACE_ID: TENANT,
      MARKETPLACE_PUBLIC_ORIGIN: "https://marketplace.rehearsal.invalid",
      MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: secrets.telegram,
      MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: secrets.discord,
    },
    env: providerEnv,
    portalFetch,
    providerFetch: globalThis.fetch,
    channelProviders: { telegram: input.telegram.provider, discord: input.discord.provider },
    channelScheduler: input.scheduler,
    channelClock: () => new Date(input.clock.now),
  });
  const runtime = mods.app.channelRuntimeOf(app);
  await runtime.ready;
  intervals.stopTracking();
  const responses: string[] = [];
  const record = (res: LightMyRequestResponse) => {
    responses.push(res.body);
    return res;
  };
  const owner = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    record(await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers }));
  const agent = async (method: "GET" | "POST", url: string, opts: { payload?: unknown; key?: string } = {}) =>
    record(
      await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${secrets.agentGrant}`, ...(opts.key ? { "idempotency-key": opts.key } : {}) },
        ...(opts.payload !== undefined ? { payload: opts.payload as Record<string, unknown> } : {}),
      }),
    );
  const service = async (method: "GET" | "POST", url: string) =>
    record(await app.inject({ method, url, headers: { authorization: `Bearer ${secrets.internal}` } }));
  let consentCounter = 0;
  const consentFor = (channel: { slug: string; connectionId: string; provider: string }) => {
    consentCounter += 1;
    return store.createMarketplaceAgentConsent({
      portalIssuer: PORTAL,
      portalOrgId: "portal-org-rehearsal",
      productTenantId: TENANT,
      workspaceId: TENANT,
      deploymentId: "deployment-rehearsal",
      userId: "owner-rehearsal",
      agentId: AGENT_ID,
      consentId: `consent-rehearsal-${channel.slug}-${consentCounter}`,
      consentRevision: 1,
      pluginId: `channels-${channel.provider}`,
      actionKey: "class:outward",
      capability: "connector.dispatch" as ConnectorCapability,
      connectionId: channel.connectionId,
      accountId: channel.connectionId,
      resourceKind: `${channel.provider}.connected-account`,
      resourceRef: `account:${channel.connectionId}`,
      capabilities: ["connector.class.outward"] as unknown as ConnectorCapability[],
      requiredActions: ["read", "create"],
      metadata: { selectionKind: "class", grantClass: "outward", actionGroup: `channel:${channel.slug}` },
    }).consent;
  };
  return {
    app,
    store,
    runtime,
    owner,
    agent,
    service,
    consentFor,
    responses,
    portalRequests,
    async close() {
      await app.close();
      store.close();
      const result = { intervalsCreatedAtBuild: intervals.created(), intervalsStillActiveAfterClose: intervals.active() };
      intervals.restore();
      return result;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------------------------------------------

type ChannelView = { id: string; slug: string; connectionId: string; provider: string; revision: number };

export async function runRehearsal(args: Args) {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/gu, "-");
  const outDir = process.env.CHANNELS_REHEARSAL_OUT?.trim() || path.join(DEFAULT_OUT_ROOT, `rehearsal-${runId}`);
  const workBase = process.env.CHANNELS_REHEARSAL_WORK?.trim();
  if (workBase) await mkdir(workBase, { recursive: true });
  const workDir = await mkdtemp(path.join(workBase || os.tmpdir(), "channels-rehearsal-"));
  const dataRoot = path.join(workDir, "data");
  const stateDir = path.join(dataRoot, "state");
  const logsDir = path.join(dataRoot, "logs");
  const dbPath = path.join(stateDir, "marketplace.sqlite");
  const runLogs = path.join(workDir, "run-logs");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await mkdir(runLogs, { recursive: true });

  const secrets: Secrets = {
    internal: `rehearsal-internal-${b64(24)}`,
    handoffKey: randomBytes(32).toString("hex"),
    operatorAccess: `rehearsal-operator-${b64(24)}`,
    composioKey: `rehearsal-composio-${b64(18)}`,
    portalProof: b64(32).slice(0, 43),
    telegram: `${randomInt(100_000_000, 999_999_999)}:AAH${b64(24)}`,
    discord: `MT${b64(18)}.Gx${b64(4)}.${b64(27)}`,
    agentGrant: `tbag_${b64(32).slice(0, 43)}`,
  };
  secretsForRedaction = Object.values(secrets);
  const botTokens = [secrets.telegram, secrets.discord];

  const phases: PhaseRecord[] = [];
  let aborted: string | null = null;
  const capturedLogs: string[] = [];
  const consoleOriginal = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const guard = installNetworkGuard();
  const composio = await startFakeComposio();
  const refs: Record<string, unknown> = {};
  const snapshots: Record<string, DbSnapshot> = {};
  const oldEndpointAnswers: Record<string, Record<string, number>> = {};
  const oldLogFiles: string[] = [];
  let newMods: NewModules | null = null;
  let channelTables: readonly string[] = [];
  let oldTables: string[] = [];

  const clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  const T0 = clock.now;
  const plan = {
    expiredSendAt: T0 + 2 * 60_000, // > 15 min late at the phase-4 tick: expired
    onTimeSendAt: T0 + 20 * 60_000, // 2 min late at the phase-4 tick: sent once
    tickAt: T0 + 22 * 60_000,
  };

  out(`Marketplace Channels upgrade/rollback rehearsal ${runId}`);
  out(`old ref ${args.oldRef} | new ref ${args.newRef} | work dir ${workDir} | evidence ${outDir}`);

  try {
    // -------------------------------------------------------------------------------------------------------------
    // Refs and materialisation
    // -------------------------------------------------------------------------------------------------------------
    const prep = new Phase("P0", "materialise OLD release bundle and NEW source");
    phases.push(prep.record);
    const oldSrc = path.join(workDir, "old-src");
    const bundleDir = path.join(oldSrc, "release", "railway");
    let newProgramDir = PROGRAM_DIR;
    await prep.must(`extract ${args.oldRef} release/railway with git archive and verify the bundle manifest`, async (s) => {
      const commit = git(["rev-parse", `${args.oldRef}^{commit}`]);
      await extractRef(commit, ["release/railway"], oldSrc);
      const manifest = readFileSync(path.join(bundleDir, "bundle-manifest.sha256"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(/\s+/u) as [string, string]);
      const mismatches = manifest.filter(([hash, rel]) => sha256File(path.join(oldSrc, rel)) !== hash).map(([, rel]) => rel);
      const releaseHead = readFileSync(path.join(bundleDir, "RELEASE.md"), "utf8").split("\n")[0];
      const snapshotLine = /Source snapshot: `([0-9a-f]{40})`/u.exec(readFileSync(path.join(bundleDir, "RELEASE.md"), "utf8"));
      refs.old = {
        ref: args.oldRef,
        commit,
        releaseTitle: releaseHead,
        sourceSnapshot: snapshotLine?.[1] ?? null,
        sourceArchiveSha256: readFileSync(path.join(bundleDir, "SOURCE-SHA256"), "utf8").trim(),
        bundle: "release/railway/dist/marketplace-program.mjs",
        bundleSha256: sha256File(path.join(bundleDir, "dist", "marketplace-program.mjs")),
        manifestEntries: manifest.length,
        manifestMismatches: mismatches,
        startedAs: "node ./dist/marketplace-program.mjs (cwd release/railway): what entrypoint.mjs imports in-process when TS_AUTHKEY is unset",
      };
      s.ev({ commit, bundleSha256: refs.old && (refs.old as Record<string, unknown>).bundleSha256, manifestEntries: manifest.length });
      s.expect(mismatches.length === 0, `bundle files differ from bundle-manifest.sha256: ${mismatches.join(", ")}`);
      s.expect(existsSync(path.join(bundleDir, "dist", "marketplace-program.mjs")), "the release bundle exists");
    });
    await prep.must(`resolve NEW (${args.newRef}) and load buildMarketplaceApp in-process`, async (s) => {
      if (args.newRef === "worktree") {
        const dirty = git(["status", "--porcelain", "--", "program/src"]).length > 0;
        refs.new = { ref: "worktree", commit: git(["rev-parse", "HEAD"]), srcDirty: dirty, programDir: PROGRAM_DIR };
      } else {
        const commit = git(["rev-parse", `${args.newRef}^{commit}`]);
        const newSrc = path.join(workDir, "new-src");
        // The whole tree: program/src also reads repo-root files (tealbrick.app.json, contracts).
        await extractRef(commit, [], newSrc);
        newProgramDir = path.join(newSrc, "program");
        const lockSame = sha256File(path.join(newProgramDir, "pnpm-lock.yaml")) === sha256File(path.join(PROGRAM_DIR, "pnpm-lock.yaml"));
        s.expect(
          lockSame,
          `program/pnpm-lock.yaml at ${args.newRef} differs from this checkout: check out ${args.newRef}, run pnpm install there, and run this script from that checkout with --new-ref worktree`,
        );
        if (!lockSame) throw new Abort("lockfile differs");
        await symlink(path.join(PROGRAM_DIR, "node_modules"), path.join(newProgramDir, "node_modules"), "dir");
        refs.new = { ref: args.newRef, commit, programDir: newProgramDir, nodeModules: "symlinked from this checkout (identical lockfile)" };
      }
      newMods = await loadNewModules(newProgramDir);
      channelTables = newMods.channelStore.CHANNEL_TABLES;
      const pkg = JSON.parse(readFileSync(path.join(newProgramDir, "package.json"), "utf8")) as { version: string };
      (refs.new as Record<string, unknown>).packageVersion = pkg.version;
      s.ev({ ...(refs.new as Record<string, unknown>), channelTables });
      s.expect(channelTables.length > 0, "the NEW store declares channel tables");
    });
    const mods = newMods as unknown as NewModules;
    refs.node = process.version;

    const oldEnv = async (extra: Record<string, string> = {}) => {
      const port = await freePort();
      return {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(workDir, "home"),
        NODE_ENV: "production",
        MARKETPLACE_HOST: "127.0.0.1",
        MARKETPLACE_PORT: String(port),
        MARKETPLACE_DATA_DIR: stateDir,
        MARKETPLACE_DATABASE_PATH: dbPath,
        MARKETPLACE_INTERNAL_AUTH_TOKEN: secrets.internal,
        MARKETPLACE_HANDOFF_ENCRYPTION_KEY: secrets.handoffKey,
        MARKETPLACE_ORGANIZATION_ID: TENANT,
        MARKETPLACE_OPERATOR_ACCESS_TOKEN: secrets.operatorAccess,
        MARKETPLACE_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
        COMPOSIO_API_KEY: secrets.composioKey,
        COMPOSIO_BASE_URL: composio.baseUrl,
        ...extra,
      };
    };
    const bearer = { authorization: `Bearer ${secrets.internal}` };
    const operatorLogin = async (proc: OldProcess) => {
      const origin = proc.base;
      const res = await httpJson(`${proc.base}/api/marketplace/auth/session`, { method: "POST", headers: { origin }, body: { accessToken: secrets.operatorAccess } });
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const csrf = String(asRecord(asRecord(res.body).session).csrfToken ?? "");
      return { status: res.status, headers: { cookie, "x-csrf-token": csrf, origin } };
    };
    const readOldEndpoints = async (proc: OldProcess, label: string) => {
      const login = await operatorLogin(proc);
      const answers: Record<string, number> = {};
      const bodies: Record<string, unknown> = {};
      for (const endpoint of OLD_READ_ENDPOINTS) {
        const headers = endpoint.auth === "bearer" ? bearer : endpoint.auth === "operator" ? login.headers : {};
        const res = await httpJson(`${proc.base}${endpoint.path}`, { headers });
        answers[endpoint.path] = res.status;
        bodies[endpoint.path] = res.body;
      }
      oldEndpointAnswers[label] = answers;
      return { answers, bodies, login: login.status };
    };

    // -------------------------------------------------------------------------------------------------------------
    // Phase 1: OLD on an empty data dir, pre-existing state
    // -------------------------------------------------------------------------------------------------------------
    const p1 = new Phase("P1", `OLD ${args.oldRef}: start, create pre-existing state, record, stop`);
    phases.push(p1.record);
    let old: OldProcess | null = null;
    const p1Log = path.join(runLogs, "p1-old.log");
    oldLogFiles.push(p1Log);
    await p1.must("start the 0.1.19 bundle on the temp data dir and pass /healthz", async (s) => {
      old = await startOld({ bundleDir, env: await oldEnv(), logFile: p1Log });
      const health = await httpJson(`${old.base}/healthz`);
      s.ev({ port: old.port, healthz: health.body });
      s.expect(health.status === 200 && asRecord(health.body).ok === true, "/healthz answers ok");
    });
    const oldProc = () => old as unknown as OldProcess;
    const composioPluginId = "composio-github-rehearsal";
    let customPluginId = "";
    await p1.must("create pre-existing state through the 0.1.19 API (Composio import, custom MCP with an encrypted secret header)", async (s) => {
      const imported = await httpJson(`${oldProc().base}/api/marketplace/catalog/composio/import`, {
        method: "POST",
        headers: bearer,
        body: {
          workspaceSlug: TENANT,
          actorId: "operator-rehearsal",
          toolkit: "github",
          pluginId: composioPluginId,
          displayName: "GitHub (rehearsal)",
          description: "Composio GitHub import created by the 0.2.0 upgrade rehearsal.",
          tools: [
            {
              slug: "GITHUB_CREATE_AN_ISSUE",
              name: "Create an issue",
              description: "Create a new issue in a repository.",
              toolkit: { slug: "github" },
              input_parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" } }, required: ["owner", "repo", "title"] },
            },
            {
              slug: "GITHUB_LIST_REPOSITORY_ISSUES",
              name: "List repository issues",
              description: "List issues in a repository.",
              toolkit: { slug: "github" },
              input_parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] },
            },
          ],
          autoEnable: true,
        },
      });
      const login = await operatorLogin(oldProc());
      const custom = await httpJson(`${oldProc().base}/api/marketplace/connectors/custom`, {
        method: "POST",
        headers: login.headers,
        body: {
          displayName: "Rehearsal MCP",
          slug: "rehearsal-mcp",
          description: "Custom MCP server created by the 0.2.0 upgrade rehearsal.",
          transport: "streamable-http",
          url: "https://mcp.rehearsal.example/mcp",
          headers: { "x-rehearsal": "plain" },
          secretHeaders: { authorization: `Bearer rehearsal-mcp-${b64(12)}` },
        },
      });
      customPluginId = String(asRecord(asRecord(custom.body).connector).pluginId ?? "");
      s.ev({ composioImportHttp: imported.status, operatorLoginHttp: login.status, customMcpHttp: custom.status, customPluginId });
      s.expect(imported.status === 200 || imported.status === 201, `Composio import answered ${imported.status}: ${imported.text.slice(0, 300)}`);
      s.expect(custom.status === 201, `custom MCP create answered ${custom.status}: ${custom.text.slice(0, 300)}`);
    });
    let p1Identity: IdentityView = { file: "", sha256: null, instanceId: null };
    await p1.step("record version, served claim identity and the normal read endpoints", async (s) => {
      const { answers, login } = await readOldEndpoints(oldProc(), "P1");
      const claim = await httpJson(`${oldProc().base}/api/tealbrick/claim`, { headers: bearer });
      p1Identity = { ...readIdentity(stateDir), servedInstanceId: String(asRecord(claim.body).instanceId ?? "") || null };
      s.ev({ answers, operatorLogin: login, identity: { sha256: p1Identity.sha256, instanceId: p1Identity.instanceId, served: p1Identity.servedInstanceId } });
      s.expect(Object.values(answers).every((status) => status === 200), "every read endpoint answers 200");
      s.expect(p1Identity.sha256 !== null && p1Identity.instanceId === p1Identity.servedInstanceId, "the claim identity file exists and is the one served");
    });
    let oldVersion: string | null = null;
    await p1.must("stop 0.1.19 cleanly (SIGTERM)", async (s) => {
      const health = await httpJson(`${oldProc().base}/healthz`);
      oldVersion = String(asRecord(health.body).version ?? "") || null;
      const stopped = await oldProc().stop();
      s.ev({ ...stopped, version: oldVersion });
      s.expect(stopped.code === 0, `0.1.19 exited with ${stopped.code ?? stopped.signal}`);
    });
    await p1.step("snapshot: table list, row counts, identity, data files", async (s) => {
      const snap = snapshotDb(dbPath);
      snapshots.P1 = snap;
      oldTables = snap.tables;
      p1.record.snapshot = { version: oldVersion, tables: snap.tables, counts: countsOf(snap, snap.tables), identity: p1Identity, dataFiles: walkFiles(stateDir) };
      s.ev({ tables: snap.tables.length, listing: snap.perTable.marketplace_listing?.count, connectorSecret: snap.perTable.connector_secret?.count, install: snap.perTable.workspace_plugin_install?.count });
      s.expect(channelTables.every((table) => !snap.tables.includes(table)), "0.1.19 created no channel tables");
      s.expect((snap.perTable.connector_secret?.count ?? 0) >= 1 && (snap.perTable.workspace_plugin_install?.count ?? 0) >= 1, "pre-existing state rows exist");
    });
    const postState = (postId: string) =>
      queryDb<{ status: string; reason: string | null; receipt: string | null; detail: string | null }>(
        dbPath,
        "SELECT p.status AS status, p.reason AS reason, r.status AS receipt, r.detail AS detail FROM channel_post p LEFT JOIN channel_receipt r ON r.post_id = p.id WHERE p.id = ?",
        postId,
      )[0];
    const entityRows = () => ({
      composioListing: queryDb(dbPath, "SELECT * FROM marketplace_listing WHERE plugin_id = ?", composioPluginId).map(rowHash),
      customListing: queryDb(dbPath, "SELECT * FROM marketplace_listing WHERE plugin_id = ?", customPluginId).map(rowHash),
      connectorSecret: queryDb(dbPath, "SELECT * FROM connector_secret ORDER BY rowid").map(rowHash),
      installs: queryDb(dbPath, "SELECT * FROM workspace_plugin_install ORDER BY rowid").map(rowHash),
      registry: queryDb(dbPath, "SELECT * FROM plugin_registry ORDER BY rowid").map(rowHash),
      bindings: queryDb(dbPath, "SELECT * FROM plugin_capability_binding ORDER BY rowid").map(rowHash),
    });
    const p1Entities = entityRows();
    /** marketplace_listing rows by plugin_id; which columns of which listings changed between two reads. */
    const listingRows = () =>
      Object.fromEntries(queryDb(dbPath, "SELECT * FROM marketplace_listing").map((row) => [String(row.plugin_id), row] as const));
    const listingChanges = (before: Record<string, Record<string, unknown>>, after: Record<string, Record<string, unknown>>) => {
      const columns = new Set<string>();
      const plugins: string[] = [];
      for (const [pluginId, row] of Object.entries(after)) {
        const prior = before[pluginId];
        if (!prior) continue;
        const differing = Object.keys(row).filter((column) => JSON.stringify(row[column]) !== JSON.stringify(prior[column]));
        if (differing.length > 0) plugins.push(pluginId);
        differing.forEach((column) => columns.add(column));
      }
      return { plugins, columns: [...columns].sort() };
    };
    const listingsAt: Record<string, Record<string, Record<string, unknown>>> = { P1: listingRows() };

    // -------------------------------------------------------------------------------------------------------------
    // Phase 2: NEW in-process on the same data dir
    // -------------------------------------------------------------------------------------------------------------
    const p2 = new Phase("P2", `NEW ${args.newRef}: upgrade in-process, create channel state, stop`);
    phases.push(p2.record);
    console.log = console.info = console.warn = console.error = console.debug = (...parts: unknown[]) => void capturedLogs.push(parts.map(String).join(" "));
    const telegram = mods.fixture.fakeProvider("telegram", secrets.telegram);
    const discord = mods.fixture.fakeProvider("discord", secrets.discord);
    let fresh: NewApp | null = null;
    await p2.must("start NEW in-process (fake Portal, fake Telegram/Discord, scheduler on, virtual clock)", async (s) => {
      fresh = await startNew({ mods, dbPath, secrets, composioBaseUrl: composio.baseUrl, clock, scheduler: true, telegram, discord });
      const health = await fresh.owner("GET", "/healthz");
      const overview = await fresh.owner("GET", "/api/marketplace/channels");
      const body = overview.json() as Record<string, unknown>;
      s.ev({ healthz: health.json(), schedulerStarted: fresh.runtime.schedulerStarted, configured: fresh.runtime.configured, readiness: body.readiness });
      s.expect(health.statusCode === 200, "NEW /healthz answers 200");
      s.expect(fresh.runtime.configured && fresh.runtime.schedulerStarted, "Channels configured and the scheduler started");
      s.expect(asRecord(body.readiness).telegram === "available" && asRecord(body.readiness).discord === "available", "both fake providers are available");
    });
    const app2 = () => fresh as unknown as NewApp;
    const newVersion = String(asRecord((await app2().owner("GET", "/healthz")).json()).version ?? "") || null;
    await p2.step("pre-existing state intact after the upgrade boot (entity rows, identity, endpoints)", async (s) => {
      const claim = await app2().service("GET", "/api/tealbrick/claim");
      const plugins = await app2().service("GET", "/api/marketplace/plugins");
      const identity = readIdentity(stateDir);
      const now = entityRows();
      const changed = Object.entries(now).filter(([key, rows]) => JSON.stringify(rows) !== JSON.stringify(p1Entities[key as keyof typeof p1Entities])).map(([key]) => key);
      s.ev({ identitySha256: identity.sha256, servedInstanceId: asRecord(claim.json()).instanceId, pluginsHttp: plugins.statusCode, changedEntityGroups: changed });
      s.expect(identity.sha256 === p1Identity.sha256 && asRecord(claim.json()).instanceId === p1Identity.instanceId, "claim identity unchanged (file sha256 and served instanceId)");
      s.expect(changed.length === 0, `pre-existing entity rows changed: ${changed.join(", ")}`);
      s.expect(plugins.statusCode === 200 && plugins.body.includes(composioPluginId), "the Composio import is still listed");
    });
    let channelA: ChannelView | null = null;
    let channelB: ChannelView | null = null;
    const createChannel = async (provider: "telegram" | "discord", slug: string) => {
      const discovered = await app2().owner("GET", `/api/marketplace/channels/discover?provider=${provider}`);
      if (discovered.statusCode !== 200) throw new Error(`discover ${provider}: ${discovered.statusCode} ${discovered.body}`);
      const destination = (asRecord(discovered.json()).destinations as ChannelDestination[])[0]!;
      const created = await app2().owner(
        "POST",
        "/api/marketplace/channels",
        {
          provider,
          slug,
          label: `Rehearsal ${slug}`,
          destination: { externalId: destination.externalId, ...(destination.parentId ? { parentId: destination.parentId } : {}) },
          purpose: "Community announcements (upgrade rehearsal)",
          policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
        },
        { "idempotency-key": `rehearsal-create-${slug}` },
      );
      if (created.statusCode !== 201) throw new Error(`create ${slug}: ${created.statusCode} ${created.body}`);
      return asRecord(created.json()).channel as ChannelView;
    };
    let grantId = "";
    const scheduled: { expired?: { postId: string; text: string }; onTime?: { postId: string; text: string } } = {};
    let held: { approvalId: string; digest: string; key: string; text: string } | null = null;
    const probe: Partial<Record<"approve" | "deny", { approvalId: string; key: string; text: string; postId: string }>> = {};
    await p2.must("create two channels (Telegram, Discord) and the agent's outward consents", async (s) => {
      channelA = await createChannel("telegram", "rehearsal-announce");
      channelB = await createChannel("discord", "rehearsal-held");
      app2().consentFor(channelA);
      app2().consentFor(channelB);
      const list = await app2().agent("GET", "/api/marketplace/v1/agent/channels");
      const ids = asArray(asRecord(list.json()).channels).map((entry) => asRecord(entry).id);
      s.ev({ channelA: channelA.id, channelB: channelB.id, agentListHttp: list.statusCode, agentSees: ids.length });
      s.expect(list.statusCode === 200 && ids.includes(channelA.id) && ids.includes(channelB.id), "the agent sees both consented channels");
    });
    const chA = () => channelA as unknown as ChannelView;
    const chB = () => channelB as unknown as ChannelView;
    await p2.must("standing grant on channel A: agent proposes, owner approves", async (s) => {
      const proposed = await app2().agent("POST", `/api/marketplace/v1/agent/channels/${chA().id}/grants`, {
        key: "rehearsal-grant-propose",
        payload: {
          purpose: "weekly meetup announce, reminder and recap",
          caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true },
          scope: { files: false, immediate: true, scheduled: true },
          expires: new Date(T0 + 30 * 86_400_000).toISOString(),
        },
      });
      grantId = String(asRecord(asRecord(proposed.json()).grant).id ?? "");
      const proposedStatus = asRecord(asRecord(proposed.json()).grant).status;
      const approved = await app2().owner("POST", `/api/marketplace/channels/grants/${grantId}/approve`, {});
      const grant = asRecord(asRecord(approved.json()).grant);
      s.ev({ proposeHttp: proposed.statusCode, proposedStatus, approveHttp: approved.statusCode, grantStatus: grant.status, digest: String(grant.digest ?? "").slice(0, 16) });
      s.expect(proposed.statusCode === 201 && proposedStatus === "proposed", `the proposal is created as proposed (http ${proposed.statusCode}: ${proposed.body.slice(0, 200)})`);
      s.expect(approved.statusCode === 200 && grant.status === "active", `owner approval makes it active (http ${approved.statusCode})`);
    });
    await p2.must("schedule two posts under the grant (sendAt T0+2 min and T0+20 min)", async (s) => {
      for (const [slot, sendAt] of [["expired", plan.expiredSendAt], ["onTime", plan.onTimeSendAt]] as const) {
        const text = `[rehearsal ${runId}] scheduled ${slot}`;
        const res = await app2().agent("POST", `/api/marketplace/v1/agent/channels/${chA().id}/scheduled`, {
          key: `rehearsal-scheduled-${slot}`,
          payload: { text, sendAt: new Date(sendAt).toISOString() },
        });
        const receipt = asRecord(asRecord(res.json()).receipt);
        scheduled[slot] = { postId: String(receipt.postId ?? ""), text };
        s.ev({ [slot]: { http: res.statusCode, status: receipt.status, sendAt: new Date(sendAt).toISOString() } });
        s.expect(res.statusCode === 200 && receipt.status === "pending", `${slot}: scheduled receipt is pending (http ${res.statusCode}: ${res.body.slice(0, 200)})`);
      }
      s.expect(telegram.sends.length === 0, "nothing was sent yet");
    });
    await p2.must("one held post on channel B (no grant): 202 approval_pending, no provider call", async (s) => {
      const text = `[rehearsal ${runId}] held for owner approval`;
      const key = "rehearsal-held-post";
      const res = await app2().agent("POST", `/api/marketplace/v1/agent/channels/${chB().id}/posts`, { key, payload: { text } });
      const body = asRecord(res.json());
      held = { approvalId: String(body.approvalId ?? ""), digest: String(body.digest ?? ""), key, text };
      s.ev({ http: res.statusCode, error: body.error, approvalId: held.approvalId, digest: held.digest.slice(0, 16) });
      s.expect(res.statusCode === 202 && body.error === "approval_pending" && held.approvalId.length > 0, `the post is held (http ${res.statusCode}: ${res.body.slice(0, 200)})`);
      s.expect(discord.sends.length === 0, "no Discord send while held");
    });
    await p2.must("two more held posts on channel B for the rollback probe (decided by the owner on 0.1.19 in phase R)", async (s) => {
      for (const decision of ["approve", "deny"] as const) {
        const text = `[rehearsal ${runId}] held, owner will ${decision} it on 0.1.19`;
        const key = `rehearsal-held-${decision}-on-old`;
        const res = await app2().agent("POST", `/api/marketplace/v1/agent/channels/${chB().id}/posts`, { key, payload: { text } });
        const body = asRecord(res.json());
        const approvalId = String(body.approvalId ?? "");
        const postId = app2().store.channels.getPostByIdempotencyKey(TENANT, AGENT_ID, key)?.id ?? "";
        probe[decision] = { approvalId, key, text, postId };
        s.ev({ [decision]: { http: res.statusCode, error: body.error, approvalId } });
        s.expect(res.statusCode === 202 && body.error === "approval_pending" && approvalId.length > 0, `${decision}: the post is held (http ${res.statusCode})`);
      }
    });
    await p2.must("stop NEW cleanly (app.close stops the scheduler)", async (s) => {
      const closed = await app2().close();
      s.ev(closed);
      s.expect(closed.intervalsCreatedAtBuild >= 1, "the scheduler interval was created at boot");
      s.expect(closed.intervalsStillActiveAfterClose === 0, "no scheduler interval remains after close");
    });
    await p2.step("snapshot: additive channel tables exist, old tables intact, channel counts", async (s) => {
      const snap = snapshotDb(dbPath);
      snapshots.P2 = snap;
      const identity = readIdentity(stateDir);
      p2.record.snapshot = { version: newVersion, tables: snap.tables, counts: countsOf(snap, snap.tables), identity, dataFiles: walkFiles(stateDir) };
      const missingOld = oldTables.filter((table) => !snap.tables.includes(table));
      const missingChannel = channelTables.filter((table) => !snap.tables.includes(table));
      const extra = snap.tables.filter((table) => !oldTables.includes(table) && !channelTables.includes(table));
      const oldChanges = Object.fromEntries(
        oldTables
          .map((table) => [table, diffTable(snapshots.P1!.perTable[table], snap.perTable[table])] as const)
          .filter(([, diff]) => diff.added.length + diff.removed.length + diff.changed.length > 0)
          .map(([table, diff]) => [table, { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length }]),
      );
      listingsAt.P2 = listingRows();
      const listing = listingChanges(listingsAt.P1!, listingsAt.P2);
      s.ev({ channelCounts: countsOf(snap, channelTables), oldTableChanges: oldChanges, listingRefresh: listing, extraTables: extra });
      s.expect(!listing.plugins.includes(composioPluginId) && !listing.plugins.includes(customPluginId), "the rehearsal-created listings are unchanged");
      s.expect(listing.columns.every((column) => column === "updated_at"), `built-in listings changed beyond the boot seed refresh (updated_at): ${listing.columns.join(", ")}`);
      s.expect(missingOld.length === 0, `old tables missing: ${missingOld.join(", ")}`);
      s.expect(missingChannel.length === 0, `channel tables missing: ${missingChannel.join(", ")}`);
      const removed = Object.entries(oldChanges).filter(([, diff]) => diff.removed > 0).map(([table]) => table);
      s.expect(removed.length === 0, `rows removed from old tables: ${removed.join(", ")}`);
      s.expect(identity.sha256 === p1Identity.sha256, "claim identity file unchanged");
      s.expect(snap.perTable.channel?.count === 2 && snap.perTable.channel_standing_grant?.count === 1 && snap.perTable.channel_post?.count === 5, "2 channels, 1 grant, 5 posts (2 scheduled, 3 held) recorded");
    });

    // -------------------------------------------------------------------------------------------------------------
    // Phase 3: rollback to OLD on the same data dir
    // -------------------------------------------------------------------------------------------------------------
    const p3 = new Phase("P3", `rollback: OLD ${args.oldRef} on the upgraded data dir`);
    phases.push(p3.record);
    const p3Log = path.join(runLogs, "p3-old.log");
    oldLogFiles.push(p3Log);
    await p3.must("start 0.1.19 on the upgraded data dir (Channels env vars still set, as a Railway image rollback leaves them) and pass /healthz", async (s) => {
      old = await startOld({
        bundleDir,
        env: await oldEnv({ MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: secrets.telegram, MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: secrets.discord }),
        logFile: p3Log,
      });
      const health = await httpJson(`${oldProc().base}/healthz`);
      s.ev({ port: oldProc().port, healthz: health.body });
      s.expect(health.status === 200 && asRecord(health.body).ok === true && asRecord(health.body).version === oldVersion, "/healthz answers ok with the old version");
    });
    await p3.step("normal 0.1.19 endpoints still answer as in phase 1; pre-existing state visible", async (s) => {
      const { answers, bodies } = await readOldEndpoints(oldProc(), "P3");
      const differing = Object.keys(answers).filter((key) => answers[key] !== oldEndpointAnswers.P1?.[key]);
      const approvals = asArray(asRecord(bodies["/api/marketplace/company-box/approvals"]).approvals);
      const plugins = JSON.stringify(bodies["/api/marketplace/plugins"] ?? null);
      const custom = JSON.stringify(bodies["/api/marketplace/connectors/custom"] ?? null);
      s.ev({ answers, differingFromP1: differing, approvalsListed: approvals.length, heldChannelApprovalListed: approvals.some((entry) => asRecord(entry).id === held?.approvalId) });
      s.expect(differing.length === 0, `endpoints answer differently than in phase 1: ${differing.map((key) => `${key} ${oldEndpointAnswers.P1?.[key]} -> ${answers[key]}`).join(", ")}`);
      s.expect(plugins.includes(composioPluginId), "the Composio import is listed");
      s.expect(custom.includes(customPluginId), "the custom MCP connector is listed");
    });
    await p3.step("claim identity unchanged (file and served instanceId)", async (s) => {
      const claim = await httpJson(`${oldProc().base}/api/tealbrick/claim`, { headers: bearer });
      const identity = readIdentity(stateDir);
      s.ev({ sha256: identity.sha256, served: asRecord(claim.body).instanceId });
      s.expect(identity.sha256 === p1Identity.sha256 && asRecord(claim.body).instanceId === p1Identity.instanceId, "same identity as phase 1");
    });
    await p3.must("stop 0.1.19 cleanly", async (s) => {
      const stopped = await oldProc().stop();
      s.ev(stopped);
      s.expect(stopped.code === 0, `0.1.19 exited with ${stopped.code ?? stopped.signal}`);
    });
    await p3.step("snapshot: channel tables present and untouched, old-table row counts unchanged", async (s) => {
      const snap = snapshotDb(dbPath);
      snapshots.P3 = snap;
      p3.record.snapshot = { version: oldVersion, tables: snap.tables, counts: countsOf(snap, snap.tables), identity: readIdentity(stateDir), dataFiles: walkFiles(stateDir) };
      const before = snapshots.P2!;
      const countChanges = oldTables.filter((table) => before.perTable[table]?.count !== snap.perTable[table]?.count);
      const rowChanges = Object.fromEntries(
        [...oldTables, ...channelTables]
          .map((table) => [table, diffTable(before.perTable[table], snap.perTable[table])] as const)
          .filter(([, diff]) => diff.added.length + diff.removed.length + diff.changed.length > 0)
          .map(([table, diff]) => [table, { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length }]),
      );
      const channelTouched = channelTables.filter((table) => snap.perTable[table]?.hash !== before.perTable[table]?.hash);
      const entityNow = entityRows();
      const entityChanged = Object.keys(entityNow).filter((key) => JSON.stringify(entityNow[key as keyof typeof entityNow]) !== JSON.stringify(p1Entities[key as keyof typeof p1Entities]));
      s.expect(entityChanged.length === 0, `phase-1 entity rows changed: ${entityChanged.join(", ")}`);
      listingsAt.P3 = listingRows();
      const listing = listingChanges(listingsAt.P2!, listingsAt.P3);
      s.expect(!listing.plugins.includes(composioPluginId) && !listing.plugins.includes(customPluginId), "the rehearsal-created listings are unchanged");
      s.expect(listing.columns.every((column) => column === "updated_at"), `built-in listings changed beyond the boot seed refresh (updated_at): ${listing.columns.join(", ")}`);
      s.ev({ tables: snap.tables.length, oldTableCountChanges: countChanges, rowChangesVsP2: rowChanges, listingRefresh: listing, postStatuses: queryDb(dbPath, "SELECT status, COUNT(*) AS n FROM channel_post GROUP BY status") });
      s.expect(channelTables.every((table) => snap.tables.includes(table)), "the channel tables are still present (ignored by 0.1.19)");
      s.expect(channelTouched.length === 0, `0.1.19 changed channel rows: ${channelTouched.join(", ")}`);
      s.expect(countChanges.length === 0, `old-table row counts changed across the 0.1.19 run: ${countChanges.map((table) => `${table} ${before.perTable[table]?.count} -> ${snap.perTable[table]?.count}`).join(", ")}`);
      s.expect(telegram.sends.length === 0 && discord.sends.length === 0, "no scheduled post fired while on 0.1.19");
    });

    // -------------------------------------------------------------------------------------------------------------
    // Phase R: the owner decides channel holds while rolled back (0.1.19 lists them in its approval queue)
    // -------------------------------------------------------------------------------------------------------------
    const pr = new Phase("R", `rollback probe: the owner approves / denies channel holds on OLD ${args.oldRef}`);
    phases.push(pr.record);
    const prLog = path.join(runLogs, "pr-old.log");
    oldLogFiles.push(prLog);
    await pr.must("start 0.1.19 again on the same data dir", async (s) => {
      old = await startOld({
        bundleDir,
        env: await oldEnv({ MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: secrets.telegram, MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: secrets.discord }),
        logFile: prLog,
      });
      s.ev({ port: oldProc().port });
    });
    await pr.step("0.1.19 lists the channel holds as pending approvals; the owner approves one and denies one there", async (s) => {
      const login = await operatorLogin(oldProc());
      const list = await httpJson(`${oldProc().base}/api/marketplace/company-box/approvals?state=pending`, { headers: login.headers });
      const pending = asArray(asRecord(list.body).approvals).map(asRecord);
      const approve = await httpJson(`${oldProc().base}/api/marketplace/company-box/approvals/${probe.approve?.approvalId}/approve`, { method: "POST", headers: login.headers, body: {} });
      const deny = await httpJson(`${oldProc().base}/api/marketplace/company-box/approvals/${probe.deny?.approvalId}/deny`, { method: "POST", headers: login.headers, body: {} });
      s.ev({
        pendingListed: pending.map((entry) => ({ id: entry.id, pluginId: entry.pluginId, actionKey: entry.actionKey, state: entry.state })),
        approveOnOld: { http: approve.status, body: approve.body },
        denyOnOld: { http: deny.status, state: asRecord(asRecord(deny.body).approval).state },
      });
      s.expect(list.status === 200, "0.1.19 lists approvals");
      s.expect(pending.some((entry) => entry.id === held?.approvalId), "the channel hold is visible in the 0.1.19 owner queue");
      s.expect(approve.status === 200 && deny.status === 200, "0.1.19 answers both decisions without a crash");
    });
    await pr.must("stop 0.1.19 cleanly; nothing was sent", async (s) => {
      const stopped = await oldProc().stop();
      const rows = queryDb<{ id: string; state: string; error: string | null }>(dbPath, "SELECT id, state, error FROM company_box_approval WHERE id IN (?, ?, ?)", held!.approvalId, probe.approve!.approvalId, probe.deny!.approvalId);
      s.ev({ ...stopped, approvals: rows, sends: { telegram: telegram.sends.length, discord: discord.sends.length } });
      s.expect(stopped.code === 0, `0.1.19 exited with ${stopped.code ?? stopped.signal}`);
      s.expect(rows.find((row) => row.id === held!.approvalId)?.state === "pending", "the untouched hold is still pending");
      snapshots.R = snapshotDb(dbPath);
      const untouched = channelTables.filter((table) => snapshots.R!.perTable[table]?.hash === snapshots.P3!.perTable[table]?.hash);
      s.expect(untouched.length === channelTables.length, "0.1.19 changed no channel rows");
    });

    // -------------------------------------------------------------------------------------------------------------
    // Phase 4: NEW again, scheduler after the rollback window
    // -------------------------------------------------------------------------------------------------------------
    const p4 = new Phase("P4", `re-upgrade: NEW ${args.newRef} after the rollback, scheduler and owner approval`);
    phases.push(p4.record);
    clock.now = plan.tickAt;
    let again: NewApp | null = null;
    await p4.must("start NEW in-process again (scheduler driven by explicit ticks, virtual clock T0+22 min)", async (s) => {
      again = await startNew({ mods, dbPath, secrets, composioBaseUrl: composio.baseUrl, clock, scheduler: false, telegram, discord });
      const health = await again.owner("GET", "/healthz");
      s.ev({ healthz: health.json(), clock: new Date(clock.now).toISOString() });
      s.expect(health.statusCode === 200, "NEW /healthz answers 200");
    });
    const app4 = () => again as unknown as NewApp;
    await p4.step("channel, standing grant, scheduled posts and held post are intact", async (s) => {
      const overview = await app4().owner("GET", "/api/marketplace/channels");
      const channels = asArray(asRecord(overview.json()).channels).map((entry) => asRecord(entry).id);
      const grants = await app4().agent("GET", "/api/marketplace/v1/agent/channels/grants");
      const grant = asArray(asRecord(grants.json()).grants).map(asRecord).find((entry) => entry.id === grantId);
      const posts = queryDb<{ id: string; status: string; mode: string }>(dbPath, "SELECT id, status, mode FROM channel_post ORDER BY created_at");
      const approval = await app4().owner("GET", `/api/marketplace/company-box/approvals/${held?.approvalId}`);
      const approvalState = asRecord(asRecord(approval.json()).approval).state;
      s.ev({ channels: channels.length, grantStatus: grant?.status, posts, heldApprovalState: approvalState });
      s.expect(channels.includes(chA().id) && channels.includes(chB().id), "both channels are listed");
      s.expect(grant?.status === "active", "the standing grant is still active");
      s.expect(posts.filter((post) => post.status === "scheduled").length === 2 && posts.filter((post) => post.status === "held").length === 3, "2 scheduled and 3 held posts");
      s.expect(approvalState === "pending", `the held post still awaits owner approval (state ${String(approvalState)})`);
    });
    await p4.step("scheduler tick at T0+22 min: the 20-min-late post is expired, the 2-min-late post is sent exactly once", async (s) => {
      const report = await app4().runtime.tick(new Date(clock.now));
      const status = (postId: string) => postState(postId)?.status;
      const receipt = (postId: string) => postState(postId);
      const sentTexts = telegram.sends.map((send) => send.message.text);
      s.ev({
        tick: report,
        lateness: { expired: `${(plan.tickAt - plan.expiredSendAt) / 60_000} min`, onTime: `${(plan.tickAt - plan.onTimeSendAt) / 60_000} min`, lateLimit: `${mods.service.CHANNEL_SCHEDULE_LATE_MS / 60_000} min` },
        expiredPost: { status: status(scheduled.expired!.postId), receipt: receipt(scheduled.expired!.postId) },
        onTimePost: { status: status(scheduled.onTime!.postId), receipt: receipt(scheduled.onTime!.postId) },
        telegramSends: telegram.sends.length,
      });
      s.expect(status(scheduled.expired!.postId) === "expired", "the post more than 15 min late is expired");
      s.expect(status(scheduled.onTime!.postId) === "sent", "the post less than 15 min late is sent");
      s.expect(telegram.sends.length === 1 && sentTexts[0] === scheduled.onTime!.text, "exactly one Telegram send, the on-time post");
      s.expect(!sentTexts.includes(scheduled.expired!.text), "the expired post never reached the provider");
    });
    await p4.step("owner approves the held post through the owner route: sent exactly once", async (s) => {
      const approved = await app4().owner("POST", `/api/marketplace/company-box/approvals/${held!.approvalId}/approve`, {});
      const body = asRecord(approved.json());
      const receipt = asRecord(asRecord(body.channel).receipt);
      s.ev({ http: approved.statusCode, approvalState: asRecord(body.approval).state, receiptStatus: receipt.status, digestMatches: receipt.digest === held!.digest, discordSends: discord.sends.length });
      s.expect(approved.statusCode === 200 && receipt.status === "sent", `the approval sends the post (http ${approved.statusCode}: ${approved.body.slice(0, 200)})`);
      s.expect(receipt.digest === held!.digest, "the sent digest is the held digest");
      s.expect(discord.sends.length === 1 && discord.sends[0]?.message.text === held!.text, "exactly one Discord send, the held post");
    });
    await p4.step("re-run the tick and retry the held post's idempotency key: no second send", async (s) => {
      clock.now += 60_000;
      const report = await app4().runtime.tick(new Date(clock.now));
      const retry = await app4().agent("POST", `/api/marketplace/v1/agent/channels/${chB().id}/posts`, { key: held!.key, payload: { text: held!.text } });
      s.ev({ tick: report, retryHttp: retry.statusCode, retryStatus: asRecord(asRecord(retry.json()).receipt).status, telegramSends: telegram.sends.length, discordSends: discord.sends.length });
      s.expect(report.sent === 0, "the second tick sends nothing");
      s.expect(telegram.sends.length === 1 && discord.sends.length === 1, "provider send counts stay at 1 and 1");
    });
    await p4.step("rollback probe outcome: holds the owner decided on 0.1.19 are settled by NEW, never sent", async (s) => {
      const approveRetry = await app4().agent("POST", `/api/marketplace/v1/agent/channels/${chB().id}/posts`, { key: probe.approve!.key, payload: { text: probe.approve!.text } });
      const denyRetry = await app4().agent("POST", `/api/marketplace/v1/agent/channels/${chB().id}/posts`, { key: probe.deny!.key, payload: { text: probe.deny!.text } });
      await app4().runtime.tick(new Date(clock.now));
      const approvedOnOld = postState(probe.approve!.postId);
      const deniedOnOld = postState(probe.deny!.postId);
      const approvalRow = (id: string) => queryDb<{ state: string; error: string | null }>(dbPath, "SELECT state, error FROM company_box_approval WHERE id = ?", id)[0];
      const sentTexts = discord.sends.map((send) => send.message.text);
      s.ev({
        approvedOnOld: { post: approvedOnOld, approval: approvalRow(probe.approve!.approvalId), agentRetry: { http: approveRetry.statusCode, error: asRecord(approveRetry.json()).error } },
        deniedOnOld: { post: deniedOnOld, approval: approvalRow(probe.deny!.approvalId), agentRetry: { http: denyRetry.statusCode, error: asRecord(denyRetry.json()).error } },
      });
      s.expect(!sentTexts.includes(probe.approve!.text) && !sentTexts.includes(probe.deny!.text), "no hold decided on 0.1.19 reached the provider");
      s.expect(deniedOnOld?.status === "skipped", `the hold denied on 0.1.19 ends skipped (status ${String(deniedOnOld?.status)})`);
      s.expect(
        approvedOnOld?.status !== "held",
        `the hold approved on 0.1.19 (its approval is now ${String(approvalRow(probe.approve!.approvalId)?.state)}/${String(approvalRow(probe.approve!.approvalId)?.error)}) stays held with no way to settle it: the tick ignores a failed approval, the agent retry answers ${approveRetry.statusCode} ${String(asRecord(approveRetry.json()).error)}, owner cancel covers scheduled posts only`,
      );
    });
    await p4.step("stop NEW cleanly", async (s) => {
      const closed = await app4().close();
      s.ev(closed);
    });
    await p4.step("snapshot and identity", async (s) => {
      const snap = snapshotDb(dbPath);
      snapshots.P4 = snap;
      const identity = readIdentity(stateDir);
      p4.record.snapshot = { version: newVersion, tables: snap.tables, counts: countsOf(snap, snap.tables), identity, dataFiles: walkFiles(stateDir) };
      s.ev({ channelCounts: countsOf(snap, channelTables), postStatuses: queryDb(dbPath, "SELECT status, COUNT(*) AS n FROM channel_post GROUP BY status") });
      s.expect(identity.sha256 === p1Identity.sha256, "claim identity file unchanged");
    });

    // -------------------------------------------------------------------------------------------------------------
    // Hygiene and network
    // -------------------------------------------------------------------------------------------------------------
    const hygiene = new Phase("H", "token hygiene and network isolation");
    phases.push(hygiene.record);
    await hygiene.step("the fake bot tokens appear in no data file (DB, WAL, logs), process log or response", async (s) => {
      const files = Object.keys(walkFiles(dataRoot));
      const leaks: string[] = [];
      for (const rel of files) {
        const bytes = readFileSync(path.join(dataRoot, rel));
        for (const token of botTokens) if (bytes.includes(Buffer.from(token))) leaks.push(`data/${rel}`);
      }
      for (const file of oldLogFiles) {
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        for (const token of botTokens) if (text.includes(token)) leaks.push(path.basename(file));
      }
      const inProcess = [...capturedLogs, ...(app2().responses ?? []), ...(app4().responses ?? [])];
      for (const token of botTokens) if (inProcess.some((text) => text.includes(token))) leaks.push("in-process logs/responses");
      await writeFile(path.join(runLogs, "new-in-process.log"), capturedLogs.map(redact).join("\n"));
      s.ev({ dataFiles: files, oldLogs: oldLogFiles.map((file) => path.basename(file)), inProcessLogLines: capturedLogs.length, responses: inProcess.length - capturedLogs.length, leaks });
      s.expect(leaks.length === 0, `a bot token was found in: ${[...new Set(leaks)].join(", ")}`);
    });
    await hygiene.step("no real network: in-process fetch reached only 127.0.0.1, 0.1.19 only the local fake Composio", async (s) => {
      const fakeSends = { telegram: telegram.sends.length, discord: discord.sends.length };
      s.ev({ blockedFetches: guard.blocked, fakeComposioRequests: composio.requests, portalRequests: [...new Set([...(app2().portalRequests ?? []), ...(app4().portalRequests ?? [])])], fakeSends });
      s.expect(guard.blocked.length === 0, `the in-process app tried to reach: ${guard.blocked.join(", ")}`);
    });
  } catch (error) {
    if (error instanceof Abort) aborted = error.message;
    else {
      aborted = `unexpected error: ${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`;
    }
    out(`ABORTED: ${aborted}`);
  } finally {
    Object.assign(console, consoleOriginal);
    guard.restore();
    await composio.close();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------------------------------------------------
  const expectedPhases = ["P0", "P1", "P2", "P3", "R", "P4", "H"];
  const ok = aborted === null && expectedPhases.every((id) => phases.some((phase) => phase.id === id)) && phases.every((phase) => phase.status === "PASS");
  const finishedAt = new Date();
  const countTable = Object.fromEntries(
    [...new Set([...oldTables, ...channelTables])].map((table) => [table, Object.fromEntries(Object.entries(snapshots).map(([phase, snap]) => [phase, snap.perTable[table]?.count ?? null]))]),
  );
  const report = {
    runId,
    ok,
    aborted,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    refs,
    args,
    workDir,
    dataDir: stateDir,
    virtualClock: { T0: new Date(T0).toISOString(), expiredSendAt: new Date(plan.expiredSendAt).toISOString(), onTimeSendAt: new Date(plan.onTimeSendAt).toISOString(), tickAt: new Date(plan.tickAt).toISOString() },
    oldTables,
    channelTables,
    rowCounts: countTable,
    oldEndpointAnswers,
    phases,
    failures: phases.flatMap((phase) => phase.steps.filter((step) => step.status === "FAIL").map((step) => ({ phase: phase.id, step: step.name, failures: step.failures }))),
  };
  const json = redact(JSON.stringify(report, null, 2));
  const md = redact(renderMarkdown(report));
  const reportLeak = botTokens.some((token) => json.includes(token) || md.includes(token));
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "rehearsal.json"), `${json}\n`);
  await writeFile(path.join(outDir, "rehearsal.md"), md);
  for (const file of [...oldLogFiles, path.join(runLogs, "new-in-process.log")]) {
    if (existsSync(file)) await writeFile(path.join(outDir, path.basename(file)), redact(await readFile(file, "utf8")));
  }
  out(`\nRESULT: ${ok && !reportLeak ? "PASS" : "FAIL"}${aborted ? ` (aborted: ${aborted})` : ""}`);
  for (const phase of phases) out(`  ${phase.status} ${phase.id} ${phase.title}`);
  out(`evidence: ${outDir}`);
  if (ok && !reportLeak && !args.keep) await rm(workDir, { recursive: true, force: true });
  else out(`work dir kept: ${workDir}`);
  return ok && !reportLeak;
}

type Report = {
  runId: string;
  ok: boolean;
  aborted: string | null;
  startedAt: string;
  finishedAt: string;
  refs: Record<string, unknown>;
  dataDir: string;
  virtualClock: Record<string, string>;
  oldTables: string[];
  channelTables: readonly string[];
  rowCounts: Record<string, Record<string, number | null>>;
  oldEndpointAnswers: Record<string, Record<string, number>>;
  phases: PhaseRecord[];
  failures: Array<{ phase: string; step: string; failures: string[] }>;
};

function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  const old = asRecord(report.refs.old);
  const fresh = asRecord(report.refs.new);
  lines.push(`# Marketplace 0.2.0 Channels upgrade/rollback rehearsal ${report.runId}`, "");
  lines.push(`Result: **${report.ok ? "PASS" : "FAIL"}**${report.aborted ? ` (aborted: ${report.aborted})` : ""}`, "");
  lines.push(`- Started ${report.startedAt}, finished ${report.finishedAt}, Node ${String(report.refs.node)}`);
  lines.push(`- OLD: \`${String(old.ref)}\` commit \`${String(old.commit)}\`, source snapshot \`${String(old.sourceSnapshot)}\`, bundle sha256 \`${String(old.bundleSha256)}\` (bundle manifest mismatches: ${asArray(old.manifestMismatches).length})`);
  lines.push(`- OLD started as: ${String(old.startedAs)}`);
  lines.push(`- NEW: \`${String(fresh.ref)}\` commit \`${String(fresh.commit)}\`${fresh.srcDirty ? " (program/src has uncommitted changes)" : ""}, package version ${String(fresh.packageVersion)}, in-process buildMarketplaceApp`);
  lines.push(`- Virtual clock: T0 ${report.virtualClock.T0}; scheduled ${report.virtualClock.expiredSendAt} and ${report.virtualClock.onTimeSendAt}; phase-4 tick ${report.virtualClock.tickAt}`, "");
  lines.push("## Phases", "", "| Phase | Result | Title |", "|---|---|---|");
  for (const phase of report.phases) lines.push(`| ${phase.id} | ${phase.status} | ${phase.title} |`);
  lines.push("");
  for (const phase of report.phases) {
    lines.push(`### ${phase.id}: ${phase.title} (${phase.status})`, "");
    for (const step of phase.steps) {
      lines.push(`- **${step.status}** ${step.name}`);
      const evidence = JSON.stringify(step.evidence);
      if (evidence !== "{}") lines.push(`  - evidence: \`${evidence.length > 1200 ? `${evidence.slice(0, 1200)}...` : evidence}\``);
      for (const failure of step.failures) lines.push(`  - FAIL: ${failure}`);
    }
    if (phase.snapshot) {
      lines.push(`- version: ${String(phase.snapshot.version)}; tables: ${phase.snapshot.tables.length}; identity sha256 \`${String(phase.snapshot.identity.sha256)}\`, instanceId \`${String(phase.snapshot.identity.instanceId)}\``);
      lines.push(`- data files: ${Object.entries(phase.snapshot.dataFiles).map(([file, hash]) => `${file} \`${hash.slice(0, 12)}\``).join(", ")}`);
    }
    lines.push("");
  }
  const phaseIds = [...new Set(Object.values(report.rowCounts).flatMap((row) => Object.keys(row)))];
  lines.push("## Row counts per table", "", `| Table | ${phaseIds.join(" | ")} |`, `|---|${phaseIds.map(() => "---").join("|")}|`);
  for (const [table, row] of Object.entries(report.rowCounts)) {
    lines.push(`| ${table}${report.channelTables.includes(table) ? " (channel)" : ""} | ${phaseIds.map((id) => String(row[id] ?? "-")).join(" | ")} |`);
  }
  lines.push("", "## 0.1.19 read endpoints (HTTP status)", "", "| Endpoint | P1 | P3 |", "|---|---|---|");
  for (const endpoint of Object.keys(report.oldEndpointAnswers.P1 ?? {})) {
    lines.push(`| ${endpoint} | ${report.oldEndpointAnswers.P1?.[endpoint] ?? "-"} | ${report.oldEndpointAnswers.P3?.[endpoint] ?? "-"} |`);
  }
  lines.push("", `Old tables (${report.oldTables.length}): ${report.oldTables.join(", ")}`, "", `Channel tables (${report.channelTables.length}): ${report.channelTables.join(", ")}`, "");
  if (report.failures.length > 0) {
    lines.push("## Failures", "");
    for (const failure of report.failures) lines.push(`- ${failure.phase} / ${failure.step}`, ...failure.failures.map((text) => `  - ${text}`));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------------------------

const invokedDirectly = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url : false;
if (invokedDirectly) {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nusage: tsx scripts/channels-upgrade-rehearsal.ts [--old-ref v0.1.19] [--new-ref worktree|<git ref>] [--keep]\n`);
    process.exit(2);
  }
  runRehearsal(args).then(
    (ok) => process.exit(ok ? 0 : 1),
    (error: unknown) => {
      process.stderr.write(`${redact(error instanceof Error ? error.stack ?? error.message : String(error))}\n`);
      process.exit(1);
    },
  );
}


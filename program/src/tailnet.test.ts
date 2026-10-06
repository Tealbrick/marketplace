import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  appEnvironment,
  launchMarketplace,
  startTailnet,
  tailnetRequested,
  TAILNET_PROXY_URL,
} from "../../deploy/railway/image/tailnet.mjs";
import { buildMarketplaceApp } from "./app.js";
import { listMcpTools, McpRemoteError } from "./mcp-remote-client.js";
import { assertMcpUrlAllowed, McpUrlPolicyError } from "./mcp-url-policy.js";
import { parseOpenApiDocument } from "./openapi-adapter.js";
import { callOpenApiOperation, OpenApiCallError } from "./openapi-http.js";
import { SqliteMarketplaceStore } from "./store.js";
import { isTailnetHost, routeOutbound, tailnetConfig, tailnetHealth, TailnetUnavailableError } from "./tailnet.js";
import { startFakeMcpServer } from "./testing/fake-mcp-server.js";
import { startFakeRestServer } from "./testing/fake-rest-server.js";

const KEY = "tskey-auth-fixture-SECRET-0001";
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0).reverse()) await close();
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fake tailscaled outbound proxy: tunnels CONNECT (and forwards absolute-form) to one local server. */
async function startFakeProxy(targetPort: number) {
  const seen: string[] = [];
  const server: Server = createHttpServer((request, response) => {
    seen.push(`forward ${new URL(request.url!).host}`);
    const upstream = httpRequest(
      { host: "127.0.0.1", port: targetPort, method: request.method, path: new URL(request.url!).pathname + new URL(request.url!).search, headers: request.headers },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  server.on("connect", (request, socket, head) => {
    seen.push(`CONNECT ${request.url}`);
    const upstream = connect(targetPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${port}`, seen };
}

const health = parseOpenApiDocument({
  openapi: "3.0.0",
  info: { title: "x", version: "1" },
  paths: { "/health": { get: { operationId: "getHealth", responses: { 200: { description: "ok" } } } } },
}).operations[0]!;

describe("tailnet routing decisions", () => {
  const proxy = { MARKETPLACE_TAILNET_PROXY: "http://127.0.0.1:1055" };

  it("sends *.ts.net and 100.64/10 through the proxy and everything else direct", () => {
    expect(routeOutbound(new URL("https://notes.tail1234.ts.net:8443/api"), proxy)).toEqual({ kind: "proxy", proxyUrl: "http://127.0.0.1:1055" });
    expect(routeOutbound(new URL("https://100.101.102.103/api"), proxy)).toMatchObject({ kind: "proxy" });
    expect(routeOutbound(new URL("https://api.example.com/v1"), proxy)).toEqual({ kind: "direct" });
    expect(routeOutbound(new URL("https://100.128.0.1/"), proxy)).toEqual({ kind: "direct" });
    expect(routeOutbound(new URL("https://ts.net/"), proxy)).toEqual({ kind: "direct" });
    // Disabled (default): unchanged, direct.
    expect(routeOutbound(new URL("https://notes.tail1234.ts.net/"), {})).toEqual({ kind: "direct" });
    // Configured but down: tailnet hosts fail clearly, public hosts are unaffected.
    expect(() => routeOutbound(new URL("https://notes.tail1234.ts.net/"), { MARKETPLACE_TAILNET_STATE: "unavailable" })).toThrow(TailnetUnavailableError);
    expect(routeOutbound(new URL("https://api.example.com/"), { MARKETPLACE_TAILNET_STATE: "unavailable" })).toEqual({ kind: "direct" });
    expect(isTailnetHost("100.63.255.255")).toBe(false);
    expect(isTailnetHost("100.64.0.1")).toBe(true);
    // Only a loopback http proxy is trusted.
    expect(tailnetConfig({ MARKETPLACE_TAILNET_PROXY: "http://10.0.0.5:1055" }).mode).toBe("unavailable");
    expect(tailnetConfig({ MARKETPLACE_TAILNET_PROXY: "https://127.0.0.1:1055" }).mode).toBe("unavailable");
  });

  it("skips local DNS only for *.ts.net with the proxy configured, and keeps every other rule", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("local resolution fails in userspace mode");
    });
    await expect(assertMcpUrlAllowed("https://notes.tail1234.ts.net:8443", { env: proxy, lookup })).resolves.toBeInstanceOf(URL);
    expect(lookup).not.toHaveBeenCalled();
    await expect(assertMcpUrlAllowed("https://notes.tail1234.ts.net", { env: {}, lookup })).rejects.toMatchObject({ reason: "dns_lookup_failed" });
    for (const [url, reason, answer] of [
      ["http://notes.tail1234.ts.net", "scheme_not_https", null],
      ["https://10.0.0.5", "address_not_allowed", null],
      ["https://192.168.1.4:8443", "address_not_allowed", null],
      ["https://intranet.example.com", "address_not_allowed", "172.16.0.9"],
      ["https://notes.tail1234.ts.net/?key=1", "query_not_allowed", null],
    ] as const) {
      const resolver = async () => [{ address: answer ?? "8.8.8.8", family: 4 }];
      const error = await assertMcpUrlAllowed(url, { env: proxy, lookup: resolver }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(McpUrlPolicyError);
      expect(error).toMatchObject({ reason });
    }
  });

  it("reports health as disabled, connected or unavailable without details", async () => {
    expect(await tailnetHealth({})).toBe("disabled");
    expect(await tailnetHealth({ MARKETPLACE_TAILNET_STATE: "unavailable" })).toBe("unavailable");
    const listener = createTcpServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as AddressInfo).port;
    closers.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    expect(await tailnetHealth({ MARKETPLACE_TAILNET_PROXY: `http://127.0.0.1:${port}` }, { cacheMs: 0 })).toBe("connected");
    const closed = createTcpServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await tailnetHealth({ MARKETPLACE_TAILNET_PROXY: `http://127.0.0.1:${closedPort}` }, { cacheMs: 0 })).toBe("unavailable");
  });
});

describe("tailnet proxy in the REST executor and MCP client", () => {
  it("sends tailnet hosts through the CONNECT proxy and public hosts direct", async () => {
    const rest = await startFakeRestServer();
    closers.push(rest.close);
    const restPort = Number(new URL(rest.origin).port);
    const proxy = await startFakeProxy(restPort);
    const tailnetOrigin = `http://notes.tail1234.ts.net:${restPort}`;
    const env = { MARKETPLACE_TAILNET_PROXY: proxy.url, MARKETPLACE_MCP_ALLOWED_ORIGINS: `${tailnetOrigin},${rest.origin}` };
    const direct = vi.fn((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
    const viaTailnet = await callOpenApiOperation({ baseUrl: tailnetOrigin, operation: health, args: {}, auth: { type: "none" }, credentials: {}, env, fetchImpl: direct });
    expect(viaTailnet.status).toBe(200);
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toMatch(new RegExp(`^(CONNECT|forward) notes\\.tail1234\\.ts\\.net:${restPort}$`, "u"));
    expect(direct).not.toHaveBeenCalled();
    expect(rest.requests.at(-1)).toMatchObject({ path: "/health" });

    const publicCall = await callOpenApiOperation({ baseUrl: rest.origin, operation: health, args: {}, auth: { type: "none" }, credentials: {}, env, fetchImpl: direct });
    expect(publicCall.status).toBe(200);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(proxy.seen).toHaveLength(1);
  });

  it("routes the remote MCP client through the proxy for tailnet servers", async () => {
    const mcp = await startFakeMcpServer();
    closers.push(mcp.close);
    const port = Number(new URL(mcp.origin).port);
    const proxy = await startFakeProxy(port);
    const origin = `http://tracker.tail1234.ts.net:${port}`;
    const tools = await listMcpTools({
      url: `${origin}/mcp`,
      transport: "streamable-http",
      env: { MARKETPLACE_TAILNET_PROXY: proxy.url, MARKETPLACE_MCP_ALLOWED_ORIGINS: origin },
    });
    expect(tools.map((tool) => tool.name)).toContain("echo");
    expect(proxy.seen.length).toBeGreaterThan(0);
    expect(proxy.seen.every((entry) => entry.endsWith(`tracker.tail1234.ts.net:${port}`))).toBe(true);
  });

  it("reports tailnet_unavailable when the tailnet was configured but is down", async () => {
    const env = { MARKETPLACE_TAILNET_STATE: "unavailable", MARKETPLACE_MCP_ALLOWED_ORIGINS: "http://notes.tail1234.ts.net:1" };
    const rest = await callOpenApiOperation({ baseUrl: "http://notes.tail1234.ts.net:1", operation: health, args: {}, auth: { type: "none" }, credentials: {}, env }).catch((error: unknown) => error);
    expect(rest).toBeInstanceOf(OpenApiCallError);
    expect(rest).toMatchObject({ code: "tailnet_unavailable" });
    const mcp = await listMcpTools({ url: "http://notes.tail1234.ts.net:1/mcp", transport: "streamable-http", env }).catch((error: unknown) => error);
    expect(mcp).toBeInstanceOf(McpRemoteError);
    expect(mcp).toMatchObject({ code: "tailnet_unavailable" });
  });

  it("exposes only the tailnet state on health endpoints", async () => {
    const dir = tempDir("tailnet-health-");
    const store = new SqliteMarketplaceStore(path.join(dir, "m.sqlite"));
    const app = await buildMarketplaceApp({ store, environment: { NODE_ENV: "test", MARKETPLACE_TAILNET_STATE: "unavailable" } });
    closers.push(async () => {
      await app.close();
      store.close();
    });
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.json()).toMatchObject({ ok: true, tailnet: "unavailable" });
    expect(Object.keys(response.json()).sort()).toEqual(["ok", "service", "status", "tailnet", "time"]);
  });
});

describe("image entrypoint tailnet launch", () => {
  it("is inert without TS_AUTHKEY: the app is imported in-process with an untouched environment", async () => {
    for (const value of [undefined, "", "   "]) {
      const env: Record<string, string | undefined> = { NODE_ENV: "production", MARKETPLACE_PORT: "5314", ...(value === undefined ? {} : { TS_AUTHKEY: value }) };
      const before = JSON.stringify(env);
      const importApp = vi.fn(async () => undefined);
      const spawnApp = vi.fn();
      const start = vi.fn();
      expect(tailnetRequested(env)).toBe(false);
      expect(await launchMarketplace({ env, importApp, spawnApp, startTailnet: start })).toEqual({ mode: "direct" });
      expect(importApp).toHaveBeenCalledTimes(1);
      expect(spawnApp).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(JSON.stringify(env)).toBe(before);
    }
  });

  it("starts the app as a child without TS_AUTHKEY, with the proxy or an unavailable marker", async () => {
    const env = { TS_AUTHKEY: KEY, TS_HOSTNAME: "mp", MARKETPLACE_PORT: "5314" };
    for (const outcome of [{ state: "connected" as const, stop: () => undefined, daemon: {} as never }, { state: "unavailable" as const, reason: "up_failed" }]) {
      const spawnApp = vi.fn((childEnv: Record<string, string | undefined>) => childEnv);
      const launched = await launchMarketplace({ env, importApp: vi.fn(), spawnApp, startTailnet: async () => outcome });
      const childEnv = spawnApp.mock.calls[0]![0];
      expect(launched.mode).toBe("supervised");
      expect(childEnv).not.toHaveProperty("TS_AUTHKEY");
      expect(JSON.stringify(childEnv)).not.toContain(KEY);
      expect(childEnv).toMatchObject({ MARKETPLACE_PORT: "5314", TS_HOSTNAME: "mp" });
      if (outcome.state === "connected") expect(childEnv.MARKETPLACE_TAILNET_PROXY).toBe(TAILNET_PROXY_URL);
      else expect(childEnv).toMatchObject({ MARKETPLACE_TAILNET_STATE: "unavailable" });
    }
    expect(appEnvironment({ TS_AUTHKEY: KEY, MARKETPLACE_TAILNET_PROXY: "http://evil:1" }, { state: "unavailable" })).toEqual({ MARKETPLACE_TAILNET_STATE: "unavailable" });
  });

  function fakeBinaries(options: { upExit?: number; daemonExits?: boolean } = {}) {
    const dir = tempDir("tailnet-bin-");
    const record = path.join(dir, "calls.jsonl");
    const node = process.execPath;
    writeFileSync(
      path.join(dir, "tailscaled"),
      `#!${node}
const fs = require("node:fs");
const socket = process.argv.find((arg) => arg.startsWith("--socket=")).slice(9);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ bin: "tailscaled", argv: process.argv.slice(2), env: process.env }) + "\\n");
${options.daemonExits ? "process.exit(1);" : 'fs.writeFileSync(socket, ""); setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(0));'}
`,
    );
    writeFileSync(
      path.join(dir, "tailscale"),
      `#!${node}
const fs = require("node:fs");
const args = process.argv.slice(2);
const keyArg = args.find((arg) => arg.startsWith("--auth-key=file:"));
const key = keyArg ? fs.readFileSync(keyArg.slice("--auth-key=file:".length), "utf8") : null;
const keyMode = keyArg ? (fs.statSync(keyArg.slice("--auth-key=file:".length)).mode & 0o777) : null;
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ bin: "tailscale", argv: args, env: process.env, key, keyMode }) + "\\n");
if (args.includes("status")) { process.stdout.write(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["100.64.0.9"] } })); process.exit(0); }
if (args.includes("up")) { process.stderr.write("noise"); process.exit(${options.upExit ?? 0}); }
`,
    );
    chmodSync(path.join(dir, "tailscaled"), 0o755);
    chmodSync(path.join(dir, "tailscale"), 0o755);
    const calls = () =>
      existsSync(record)
        ? readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { bin: string; argv: string[]; env: Record<string, string>; key: string | null; keyMode: number | null })
        : [];
    return { dir, calls };
  }

  it("starts userspace tailscaled and brings the node up without exposing the key", async () => {
    const bin = fakeBinaries();
    const logs: string[] = [];
    const outcome = await startTailnet({ env: { TS_AUTHKEY: KEY, TS_HOSTNAME: "Market-1", PATH: process.env.PATH }, binDir: bin.dir, tmpDir: tempDir("tailnet-tmp-"), log: (line) => logs.push(line), timeoutMs: 10_000 });
    expect(outcome.state).toBe("connected");
    const calls = bin.calls();
    const daemon = calls.find((call) => call.bin === "tailscaled")!;
    expect(daemon.argv).toEqual([
      "--tun=userspace-networking",
      "--state=mem:",
      expect.stringMatching(/^--socket=.+tailscaled\.sock$/u),
      "--outbound-http-proxy-listen=127.0.0.1:1055",
      "--no-logs-no-support",
    ]);
    const up = calls.find((call) => call.bin === "tailscale" && call.argv.includes("up"))!;
    expect(up.argv).toEqual([
      expect.stringMatching(/^--socket=/u),
      "up",
      expect.stringMatching(/^--auth-key=file:.+authkey$/u),
      "--hostname=market-1",
      "--accept-dns=false",
      expect.stringMatching(/^--timeout=\d+s$/u),
    ]);
    expect(up.key).toBe(KEY);
    expect(up.keyMode).toBe(0o600);
    expect(existsSync(up.argv[2]!.slice("--auth-key=file:".length))).toBe(false);
    for (const call of calls) {
      expect(call.env).not.toHaveProperty("TS_AUTHKEY");
      expect(call.argv.join(" ")).not.toContain(KEY);
    }
    expect(logs).toEqual(["marketplace tailnet connected as market-1"]);
    if (outcome.state === "connected") outcome.stop();
  });

  it("reports unavailable with a clear, non-secret error when the node cannot come up", async () => {
    for (const options of [{ upExit: 1 }, { daemonExits: true }]) {
      const bin = fakeBinaries(options);
      const logs: string[] = [];
      const outcome = await startTailnet({ env: { TS_AUTHKEY: KEY }, binDir: bin.dir, tmpDir: tempDir("tailnet-tmp-"), log: (line) => logs.push(line), timeoutMs: 5_000 });
      expect(outcome).toMatchObject({ state: "unavailable", reason: options.daemonExits ? "tailscaled_exited" : "up_failed" });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^marketplace tailnet unavailable: .+; starting without the tailnet$/u);
      expect(logs.join("\n")).not.toContain(KEY);
    }
    const missing = await startTailnet({ env: { TS_AUTHKEY: KEY }, binDir: tempDir("tailnet-empty-"), log: () => undefined });
    expect(missing).toEqual({ state: "unavailable", reason: "binaries_missing" });
  });
});

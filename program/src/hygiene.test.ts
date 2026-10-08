import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { SqliteMarketplaceStore } from "./store.js";
import { MARKETPLACE_VERSION } from "./version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const SERVICE = "marketplace-service-token-1234";
const ORIGIN = "http://127.0.0.1:5314";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-hygiene-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "data", "marketplace.sqlite"), {
    debug: true,
    logPath: path.join(root, "logs", "marketplace-debug.jsonl"),
  });
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: "org-1",
    operatorSessionManager: new MarketplaceOperatorSessionManager({
      accessToken: "marketplace-operator-token-1234",
      operatorId: "operator-1",
      organizationId: "org-1",
    }),
    env: {},
  });
  const unlocked = await app.inject({
    method: "POST",
    url: "/api/marketplace/auth/session",
    headers: { origin: ORIGIN },
    payload: { accessToken: "marketplace-operator-token-1234" },
  });
  const cookie = unlocked.headers["set-cookie"] as string;
  return { app, store, cookie, close: async () => { await app.close(); store.close(); } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release version source of truth", () => {
  it("keeps package.json, manifest.json, and the Railway recipe on one version", async () => {
    const readJson = async (file: string) => JSON.parse(await readFile(path.join(repoRoot, file), "utf8")) as { version: string };
    const [programPackage, manifest, recipe, contractManifest] = await Promise.all([
      readJson("program/package.json"),
      readJson("manifest.json"),
      readJson("deploy/railway/recipe.json"),
      readJson("tealbrick.app.json").then((value) => ({ version: (value as unknown as { app: { version: string } }).app.version })),
    ]);
    expect(MARKETPLACE_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(programPackage.version).toBe(MARKETPLACE_VERSION);
    expect(manifest.version).toBe(MARKETPLACE_VERSION);
    expect(recipe.version).toBe(MARKETPLACE_VERSION);
    expect(contractManifest.version).toBe(MARKETPLACE_VERSION);
  });

  it("serves the real version from bootstrap, status, and OpenAPI", async () => {
    const { app, close } = await fixture();
    for (const url of ["/bootstrap.json", "/status"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.json().program.version).toBe(MARKETPLACE_VERSION);
    }
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(openapi.json().info.version).toBe(MARKETPLACE_VERSION);
    await close();
  });
});

describe("internal-only diagnostics", () => {
  it("restricts /api/status and /api/debug/logs to the internal service bearer", async () => {
    const { app, cookie, close } = await fixture();
    for (const url of ["/api/status", "/api/debug/logs"]) {
      const anonymous = await app.inject({ method: "GET", url });
      expect(anonymous.statusCode).toBe(401);
      const operator = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(operator.statusCode).toBe(403);
      expect(operator.body).not.toContain("marketplace.sqlite");
      expect(operator.body).not.toContain("marketplace-debug.jsonl");
      const service = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${SERVICE}` } });
      expect(service.statusCode).not.toBe(401);
      expect(service.statusCode).not.toBe(403);
    }
    const status = await app.inject({ method: "GET", url: "/api/status", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(status.json()).toMatchObject({ ok: true, service: "marketplace", version: MARKETPLACE_VERSION });
    await close();
  });
});

describe("500 responses", () => {
  it("never return raw error messages and log them server-side", async () => {
    const { app, store, cookie, close } = await fixture();
    vi.spyOn(store, "listAudit").mockImplementation(() => {
      throw new Error("SQLITE_CORRUPT at /var/lib/secret/path.sqlite");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app.inject({ method: "GET", url: "/api/marketplace/audit?workspaceSlug=org-1", headers: { cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ ok: false, error: "marketplace_program_error", errorId: expect.stringMatching(/^err_/u) });
    expect(response.body).not.toContain("SQLITE_CORRUPT");
    expect(response.body).not.toContain("/var/lib/secret");
    expect(logged).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(entry).toMatchObject({ event: "marketplace.request.error", errorId: response.json().errorId, message: expect.stringContaining("SQLITE_CORRUPT") });
    await close();
  });

  it("keeps Fastify client errors as 4xx without echoing the parser message", async () => {
    const { app, cookie, close } = await fixture();
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings/providers/composio",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    expect(response.body).not.toContain("Unexpected token");
    await close();
  });
});

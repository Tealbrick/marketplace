import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { loadConfig } from "./config.js";
import { defaultMicroappsRoot } from "./extension-settings-projection.js";
import {
  acceptedIds,
  compatDebugEnabled,
  isAcceptedId,
  LEGACY_IDS,
  manifestNamespace,
  readCompatEnv,
  resetLegacyWarnings,
  resolveDefaultStateRoot,
} from "./legacy-ids.js";
import { makeRulesClient } from "./rules-client.js";
import { parseRulesReadinessPrincipal } from "./rules-readiness.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];

async function tempHome() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tealbrick-marketplace-legacy-ids-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetLegacyWarnings();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy id aliases", () => {
  it("maps every tealbrick id to exactly one legacy doppelganger id", () => {
    for (const [current, legacy] of Object.entries(LEGACY_IDS)) {
      expect(current.startsWith("tealbrick")).toBe(true);
      expect(legacy).toBe(current.replace(/^tealbrick/u, "doppelganger"));
      expect(acceptedIds(current as keyof typeof LEGACY_IDS)).toEqual([current, legacy]);
    }
  });

  it("accepts both spellings and nothing else", () => {
    expect(isAcceptedId("tealbrick.rules.evaluate", "tealbrick.rules.evaluate")).toBe(true);
    expect(isAcceptedId("tealbrick.rules.evaluate", "doppelganger.rules.evaluate")).toBe(true);
    for (const value of ["rules.evaluate", "TEALBRICK.RULES.EVALUATE", "", null, undefined, ["tealbrick.rules.evaluate"]]) {
      expect(isAcceptedId("tealbrick.rules.evaluate", value)).toBe(false);
    }
  });

  it("reads the manifest namespace from the tealbrick key, then the legacy key", () => {
    expect(manifestNamespace({ doppelganger: { a: 1 } })).toEqual({ a: 1 });
    expect(manifestNamespace({ tealbrick: { b: 2 }, doppelganger: { a: 1 } })).toEqual({ b: 2 });
    expect(manifestNamespace({ tealbrick: "nope", doppelganger: { a: 1 } })).toEqual({ a: 1 });
    expect(manifestNamespace({})).toBeUndefined();
    expect(manifestNamespace(undefined)).toBeUndefined();
  });
});

describe("TEALBRICK_* env with DOPPELGANGER_* fallback", () => {
  it("prefers the new name and does not warn", () => {
    const warn = vi.fn();
    expect(readCompatEnv({ TEALBRICK_DEBUG: "1", DOPPELGANGER_DEBUG: "0" }, "DEBUG", warn)).toBe("1");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the old name with a one-time deprecation warning", () => {
    const warn = vi.fn();
    const env = { DOPPELGANGER_RUNTIME_FILE: " /tmp/runtime.json " };
    expect(readCompatEnv(env, "RUNTIME_FILE", warn)).toBe("/tmp/runtime.json");
    expect(readCompatEnv(env, "RUNTIME_FILE", warn)).toBe("/tmp/runtime.json");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/DOPPELGANGER_RUNTIME_FILE is deprecated; set TEALBRICK_RUNTIME_FILE/u);
  });

  it("returns undefined when neither name is set", () => {
    const warn = vi.fn();
    expect(readCompatEnv({ TEALBRICK_DEBUG: "  " }, "DEBUG", warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("enables debug from either name", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(compatDebugEnabled({ TEALBRICK_DEBUG: "1" })).toBe(true);
    expect(compatDebugEnabled({ DOPPELGANGER_DEBUG: "1" })).toBe(true);
    expect(compatDebugEnabled({})).toBe(false);
  });

  it("loads product workspace and internal token from either name", async () => {
    const homeDir = await tempHome();
    const warn = vi.fn();
    expect(
      loadConfig({ TEALBRICK_PRODUCT_WORKSPACE_DIR: "/tmp/tb-state" }, { homeDir, warn }).dbPath,
    ).toBe("/tmp/tb-state/data/marketplace.sqlite");
    expect(
      loadConfig({ TEALBRICK_PRODUCT_WORKSPACE_DIR: "/tmp/tb-new", DOPPELGANGER_PRODUCT_WORKSPACE_DIR: "/tmp/tb-old" }, { homeDir, warn }).dbPath,
    ).toBe("/tmp/tb-new/data/marketplace.sqlite");
    expect(
      loadConfig({ DOPPELGANGER_PRODUCT_WORKSPACE_DIR: "/tmp/tb-old" }, { homeDir, warn }).dbPath,
    ).toBe("/tmp/tb-old/data/marketplace.sqlite");
    expect(loadConfig({ TEALBRICK_MARKETPLACE_INTERNAL_AUTH_TOKEN: "new-token" }, { homeDir, warn }).internalAuthToken).toBe("new-token");
    expect(loadConfig({ DOPPELGANGER_MARKETPLACE_INTERNAL_AUTH_TOKEN: "old-token" }, { homeDir, warn }).internalAuthToken).toBe("old-token");
    expect(
      loadConfig({ MARKETPLACE_INTERNAL_AUTH_TOKEN: "primary", TEALBRICK_MARKETPLACE_INTERNAL_AUTH_TOKEN: "new-token" }, { homeDir, warn }).internalAuthToken,
    ).toBe("primary");
    expect(warn.mock.calls.map(([message]) => String(message).split(" ")[1])).toEqual([
      "DOPPELGANGER_PRODUCT_WORKSPACE_DIR",
      "DOPPELGANGER_MARKETPLACE_INTERNAL_AUTH_TOKEN",
    ]);
  });

  it("resolves the Micro-apps root from TEALBRICK_MICROAPPS_ROOT", async () => {
    const root = await tempHome();
    expect(() => defaultMicroappsRoot({ TEALBRICK_MICROAPPS_ROOT: root })).toThrow(
      /^TEALBRICK_MICROAPPS_ROOT does not contain Extension manifests/u,
    );
  });
});

describe("default state directory migration", () => {
  const newRoot = (home: string) => path.join(home, ".tealbrick", "programs", "marketplace");
  const oldRoot = (home: string) => path.join(home, ".doppelganger", "programs", "marketplace");

  async function seedLegacy(home: string) {
    await mkdir(path.join(oldRoot(home), "data"), { recursive: true });
    await writeFile(path.join(oldRoot(home), "data", "marketplace.sqlite"), "legacy-db");
    await mkdir(path.join(home, ".doppelganger", "agent", "plugins"), { recursive: true });
  }

  it("fresh install uses ~/.tealbrick without creating or warning", async () => {
    const home = await tempHome();
    const warn = vi.fn();
    expect(resolveDefaultStateRoot({ homeDir: home, migrate: true, warn })).toEqual({
      root: newRoot(home),
      status: "fresh",
    });
    expect(loadConfig({}, { homeDir: home, migrateLegacyStateDir: true, warn }).dbPath).toBe(
      path.join(newRoot(home), "data", "marketplace.sqlite"),
    );
    expect(fs.existsSync(path.join(home, ".doppelganger"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("old-only: moves Marketplace's subtree once, keeps a symlink, never touches siblings", async () => {
    const home = await tempHome();
    await seedLegacy(home);
    const warn = vi.fn();
    const config = loadConfig({}, { homeDir: home, migrateLegacyStateDir: true, warn });
    expect(config.dbPath).toBe(path.join(newRoot(home), "data", "marketplace.sqlite"));
    expect(await readFile(config.dbPath, "utf8")).toBe("legacy-db");
    expect(await readlink(oldRoot(home))).toBe(newRoot(home));
    expect(await readFile(path.join(oldRoot(home), "data", "marketplace.sqlite"), "utf8")).toBe("legacy-db");
    expect(fs.existsSync(path.join(home, ".doppelganger", "agent", "plugins"))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/Moved state from/u);

    // Second start: already migrated, no further warnings.
    expect(resolveDefaultStateRoot({ homeDir: home, migrate: true, warn })).toEqual({
      root: newRoot(home),
      status: "current",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("old-only without migrate (non-server callers) keeps reading the legacy path", async () => {
    const home = await tempHome();
    await seedLegacy(home);
    expect(resolveDefaultStateRoot({ homeDir: home })).toEqual({
      root: oldRoot(home),
      status: "legacy-in-place",
    });
    expect(loadConfig({}, { homeDir: home }).dbPath).toBe(path.join(oldRoot(home), "data", "marketplace.sqlite"));
    expect(fs.existsSync(path.join(home, ".tealbrick"))).toBe(false);
  });

  it("old-only on another filesystem: keeps using the legacy path and warns", async () => {
    const home = await tempHome();
    await seedLegacy(home);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    });
    const warn = vi.fn();
    expect(resolveDefaultStateRoot({ homeDir: home, migrate: true, warn })).toEqual({
      root: oldRoot(home),
      status: "legacy-in-place",
    });
    expect(warn.mock.calls[0]?.[0]).toMatch(/EXDEV.*continuing to use the legacy path/u);
    expect(await readFile(path.join(oldRoot(home), "data", "marketplace.sqlite"), "utf8")).toBe("legacy-db");
  });

  it("both present: new wins, legacy is left untouched with a warning", async () => {
    const home = await tempHome();
    await seedLegacy(home);
    await mkdir(path.join(newRoot(home), "data"), { recursive: true });
    const warn = vi.fn();
    expect(resolveDefaultStateRoot({ homeDir: home, migrate: true, warn })).toEqual({
      root: newRoot(home),
      status: "both-present",
    });
    expect(warn.mock.calls[0]?.[0]).toMatch(/not modified or removed/u);
    expect(fs.lstatSync(oldRoot(home)).isDirectory()).toBe(true);
    expect(await readFile(path.join(oldRoot(home), "data", "marketplace.sqlite"), "utf8")).toBe("legacy-db");
  });

  it("explicit overrides win unchanged and skip migration", async () => {
    const home = await tempHome();
    await seedLegacy(home);
    const warn = vi.fn();
    const override = path.join(home, "custom");
    expect(loadConfig({ MARKETPLACE_DATA_DIR: override }, { homeDir: home, migrateLegacyStateDir: true, warn }).dbPath).toBe(
      path.join(override, "marketplace.sqlite"),
    );
    expect(loadConfig({ PRODUCT_WORKSPACE_DIR: override }, { homeDir: home, migrateLegacyStateDir: true, warn }).dbPath).toBe(
      path.join(override, "data", "marketplace.sqlite"),
    );
    expect(fs.existsSync(path.join(home, ".tealbrick"))).toBe(false);
    expect(fs.lstatSync(oldRoot(home)).isDirectory()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("Rules wire ids", () => {
  const principal = (method: string) => ({
    ok: true,
    principal: {
      active: true,
      kind: "scoped-evaluation",
      clientId: "marketplace",
      targetKind: "plugin",
      companyId: "tenant",
      workspaceSlug: "tenant",
      credentialId: "credential",
      allowedMethods: [method],
      allowedRuleKeys: ["marketplace.plugin"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  it("accepts either Rules method from introspection and keeps emitting the legacy id", () => {
    for (const method of ["doppelganger.rules.evaluate", "tealbrick.rules.evaluate"]) {
      const parsed = parseRulesReadinessPrincipal({ response: principal(method), organizationId: "tenant" });
      expect(parsed.allowedMethods).toEqual(["doppelganger.rules.evaluate"]);
    }
    expect(() =>
      parseRulesReadinessPrincipal({ response: principal("tealbrick.rules.write"), organizationId: "tenant" }),
    ).toThrow(/rules_readiness_principal_invalid/u);
  });

  it("sends the legacy method, treats tealbrick-agent as an agent, and honours both grant contract ids", async () => {
    const bodies: Array<Record<string, any>> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ effect: "deny", reason: "no live ruleset matched this request" }),
        { status: 200 },
      );
    });
    const client = makeRulesClient({
      host: "127.0.0.1",
      port: 0,
      dbPath: ":memory:",
      settingsPath: "/dev/null",
      secretsPath: "/dev/null",
      rules: { baseUrl: "http://rules.invalid" },
    });
    const call = (actorId: string, payload: Record<string, unknown>) =>
      client!({
        workspaceSlug: "tenant",
        actorId,
        pluginId: "plugin",
        capability: "connector.dispatch",
        operation: "execute",
        payload,
      } as Parameters<NonNullable<typeof client>>[0]);

    const legacyAgent = await call("doppelganger-agent", {});
    const newAgent = await call("tealbrick-agent", {});
    // Agent lane + no matching policy + not a grant path => operator-enabled allow.
    expect(legacyAgent.effect).toBe("allow");
    expect(newAgent.effect).toBe("allow");
    expect(bodies.map((body) => body.method)).toEqual(["doppelganger.rules.evaluate", "doppelganger.rules.evaluate"]);
    expect(bodies.map((body) => body.params.actor.kind)).toEqual(["agent", "agent"]);

    const legacyGrant = await call("tealbrick-agent", { contractVersion: "doppelganger.marketplace.agent-connector-grant.v1" });
    const newGrant = await call("tealbrick-agent", { contractVersion: "tealbrick.marketplace.agent-connector-grant.v1" });
    expect(legacyGrant.effect).toBe("deny");
    expect(newGrant.effect).toBe("deny");
  });
});

describe("cross-app broker execute contract", () => {
  it("accepts the tealbrick contract id, emits the legacy id, and rejects unknown ids", async () => {
    const home = await tempHome();
    const store = new SqliteMarketplaceStore(path.join(home, "marketplace.sqlite"));
    const providerFetch: typeof fetch = async (input) => {
      if (String(input).includes("/tools/execute/LINEAR_LIST_ISSUES")) {
        return new Response(JSON.stringify({ data: [{ id: "LIN-1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const app = await buildMarketplaceApp({
      store,
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      internalAuthToken: "marketplace-service-token",
      organizationId: "atlas",
      providerFetch,
      rulesClient: async () => ({ effect: "allow", decisionId: "rules-allow" }),
    });
    const imported = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "linear",
        pluginId: "linear-composio",
        tools: [{ name: "LINEAR_LIST_ISSUES", description: "List Linear issues." }],
        autoEnable: true,
      },
    });
    expect(imported.statusCode).toBe(201);
    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "linear-composio",
      provider: "linear",
      backend: "composio",
      state: "connected",
      detail: "Test connected account",
      metadata: { connectedAccountId: "ca_linear" },
    });

    const execute = (contractVersion: string, run: string) =>
      app.inject({
        method: "POST",
        url: "/api/marketplace/v1/broker/composio/execute",
        headers: { authorization: "Bearer marketplace-service-token" },
        payload: {
          contractVersion,
          sourceMiniappId: "live-artifacts",
          sourceId: "live-linear-board",
          eventType: "live-artifact.connector.refresh",
          idempotencyKey: `live-linear-board:${run}`,
          traceId: `trace-${run}`,
          workspaceSlug: "atlas",
          pluginId: "linear-composio",
          action: { type: "linear.list.issues" },
        },
      });

    for (const [contractVersion, run] of [
      ["tealbrick.cross-app.marketplace.broker-execute.v1", "run-new"],
      ["doppelganger.cross-app.marketplace.broker-execute.v1", "run-old"],
    ] as const) {
      const response = await execute(contractVersion, run);
      expect(response.statusCode).toBe(200);
      expect(response.json().crossApp.contractVersion).toBe(
        "doppelganger.cross-app.marketplace.broker-execute.v1",
      );
    }
    const unknown = await execute("tealbrick.cross-app.marketplace.broker-execute.v2", "run-bad");
    expect(unknown.statusCode).not.toBe(200);

    await app.close();
    store.close();
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { allowedComposioOrigin, buildMarketplaceApp } from "./app.js";
import { MarketplaceOperatorSessionManager } from "./operator-auth.js";
import { MarketplaceProviderSettingsStore } from "./provider-settings.js";
import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];
const ORIGIN = "http://127.0.0.1:5314";

async function fixture(input: { bootstrapKey?: string; providerFetch?: typeof fetch } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-provider-settings-"));
  roots.push(root);
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
  const env = input.bootstrapKey ? { COMPOSIO_API_KEY: input.bootstrapKey } : {};
  const providerSettings = new MarketplaceProviderSettingsStore(
    path.join(root, "provider-settings.json"),
    path.join(root, "provider-secrets.json"),
    env,
  );
  const app = await buildMarketplaceApp({
    store,
    providerSettings,
    internalAuthToken: "marketplace-service-token-1234",
    organizationId: "org-1",
    operatorSessionManager: new MarketplaceOperatorSessionManager({
      accessToken: "marketplace-operator-token-1234",
      operatorId: "operator-1",
      organizationId: "org-1",
    }),
    env,
    providerFetch: input.providerFetch,
  });
  const unlocked = await app.inject({
    method: "POST",
    url: "/api/marketplace/auth/session",
    headers: { origin: ORIGIN },
    payload: { accessToken: "marketplace-operator-token-1234" },
  });
  const cookie = unlocked.headers["set-cookie"] as string;
  const headers = { cookie, origin: ORIGIN, "x-csrf-token": unlocked.json().session.csrfToken as string };
  const settings = (extra: Record<string, unknown> = {}) => ({
    settings: {
      composioBaseUrl: "https://backend.composio.dev/api/v3.1",
      composioDefaultUserId: "org-1",
      composioDefaultConnectedAccountId: "",
      ...extra,
    },
  });
  const close = async () => { await app.close(); store.close(); };
  return { app, store, headers, settings, root, close };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Composio base URL allowlist", () => {
  it("accepts only https composio.dev hosts unless an exact origin is configured", () => {
    expect(allowedComposioOrigin("https://backend.composio.dev/api/v3.1", {})).toBe(true);
    expect(allowedComposioOrigin("https://eu.backend.composio.dev/api", {})).toBe(true);
    expect(allowedComposioOrigin("http://backend.composio.dev/api", {})).toBe(false);
    expect(allowedComposioOrigin("https://composio.dev.attacker.invalid/api", {})).toBe(false);
    expect(allowedComposioOrigin("https://user:pass@backend.composio.dev/api", {})).toBe(false);
    expect(allowedComposioOrigin("http://127.0.0.1:9000/api", {})).toBe(false);
    expect(allowedComposioOrigin("not a url", {})).toBe(false);
    expect(allowedComposioOrigin("http://127.0.0.1:9000/api", { MARKETPLACE_COMPOSIO_ALLOWED_ORIGINS: "http://127.0.0.1:9000" })).toBe(true);
  });
});

describe("Composio provider settings routes", () => {
  it("maps malformed keys and URLs to 4xx instead of 500", async () => {
    const { app, headers, settings, close } = await fixture();
    const badKey = await app.inject({ method: "PUT", url: "/api/settings/providers/composio", headers, payload: settings({ composioApiKey: "has a space" }) });
    expect(badKey.statusCode).toBe(400);
    const badUrl = await app.inject({ method: "PUT", url: "/api/settings/providers/composio", headers, payload: settings({ composioBaseUrl: "not a url" }) });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json()).toMatchObject({ error: "validation_failed" });
    await close();
  });

  it("audits saves and removals without recording the key", async () => {
    const { app, store, headers, settings, root, close } = await fixture();
    const saved = await app.inject({ method: "PUT", url: "/api/settings/providers/composio", headers, payload: settings({ composioApiKey: "ak_test_secret_value_1234" }) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().status.composioApiKey).toMatchObject({ configured: true, source: "program", keyTail: "1234" });

    const removed = await app.inject({ method: "DELETE", url: "/api/settings/providers/composio/key", headers });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ removed: true, status: { composioApiKey: { configured: false, source: null } } });
    expect(await readFile(path.join(root, "provider-secrets.json"), "utf8")).not.toContain("ak_test_secret_value_1234");

    const again = await app.inject({ method: "DELETE", url: "/api/settings/providers/composio/key", headers });
    expect(again.json()).toMatchObject({ removed: false });

    const audit = store.listAudit({ workspaceSlug: "org-1" }) as Array<{ event_type: string; actor_id: string; metadata: string }>;
    const types = audit.map((entry) => entry.event_type);
    expect(types).toEqual(expect.arrayContaining(["marketplace.provider.settings.updated", "marketplace.provider.key.removed"]));
    expect(types.filter((type) => type === "marketplace.provider.key.removed")).toHaveLength(1);
    expect(audit.every((entry) => entry.actor_id === "operator-1")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("ak_test_secret_value_1234");
    await close();
  });

  it("refuses to remove a key supplied by the deployment environment", async () => {
    const { app, headers, close } = await fixture({ bootstrapKey: "env_key_abcdef" });
    const response = await app.inject({ method: "DELETE", url: "/api/settings/providers/composio/key", headers });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ ok: false, error: "composio_key_managed_by_environment" });
    await close();
  });

  it("requires CSRF proof for key removal and testing", async () => {
    const { app, headers, close } = await fixture();
    const { "x-csrf-token": _csrf, ...noCsrf } = headers;
    for (const [method, url] of [["DELETE", "/api/settings/providers/composio/key"], ["POST", "/api/settings/providers/composio/test"]] as const) {
      const response = await app.inject({ method, url, headers: noCsrf, payload: method === "POST" ? {} : undefined });
      expect(response.statusCode).toBe(403);
    }
    await close();
  });

  it("tests keys only against the allowlisted Composio host and maps outcomes", async () => {
    const requests: Array<{ url: string; key: string | null; redirect: RequestInit["redirect"] }> = [];
    let providerStatus = 200;
    const { app, store, headers, close } = await fixture({
      providerFetch: async (input, init) => {
        requests.push({
          url: String(input),
          key: new Headers(init?.headers).get("x-api-key"),
          redirect: init?.redirect,
        });
        return new Response("{}", { status: providerStatus });
      },
    });

    const missing = await app.inject({ method: "POST", url: "/api/settings/providers/composio/test", headers, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "composio_key_missing" });

    const malformed = await app.inject({ method: "POST", url: "/api/settings/providers/composio/test", headers, payload: { composioApiKey: "bad key" } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: "composio_api_key_invalid" });

    const valid = await app.inject({ method: "POST", url: "/api/settings/providers/composio/test", headers, payload: { composioApiKey: "draft_key_1234" } });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ ok: true, status: "valid" });
    expect(valid.body).not.toContain("draft_key_1234");
    expect(requests.at(-1)).toEqual({
      url: "https://backend.composio.dev/api/v3.1/connected_accounts?limit=1",
      key: "draft_key_1234",
      redirect: "error",
    });

    providerStatus = 401;
    const rejected = await app.inject({ method: "POST", url: "/api/settings/providers/composio/test", headers, payload: { composioApiKey: "draft_key_1234" } });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toEqual({ ok: false, error: "composio_key_rejected" });

    providerStatus = 500;
    const unreachable = await app.inject({ method: "POST", url: "/api/settings/providers/composio/test", headers, payload: { composioApiKey: "draft_key_1234" } });
    expect(unreachable.statusCode).toBe(502);
    expect(unreachable.json()).toEqual({ ok: false, error: "composio_unreachable" });

    const tested = (store.listAudit({ workspaceSlug: "org-1" }) as Array<{ event_type: string; metadata: string }>)
      .filter((entry) => entry.event_type === "marketplace.provider.key.tested");
    expect(tested).toHaveLength(3);
    expect(JSON.stringify(tested)).not.toContain("draft_key_1234");
    await close();
  });
});

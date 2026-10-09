import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { SqliteMarketplaceStore } from "./store.js";

const tempRoots: string[] = [];
const SECRET = "github-oauth-client-secret";

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tealbrick-marketplace-connect-mode-"));
  tempRoots.push(root);
  return new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
}

const TOOLKITS = [
  { slug: "github", name: "GitHub", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [], meta: {} },
  { slug: "gmail", name: "Gmail", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"], meta: {} },
  { slug: "_1password", name: "1Password", auth_schemes: ["API_KEY"], composio_managed_auth_schemes: [], meta: {} },
  { slug: "hackernews", name: "Hacker News", auth_schemes: [], composio_managed_auth_schemes: [], no_auth: true, meta: {} },
];

function authConfig(id: string, toolkit: string) {
  return {
    id,
    toolkit: { slug: toolkit },
    is_composio_managed: false,
    auth_scheme: "OAUTH2",
    status: "ENABLED",
    credentials: { client_id: "client-id", client_secret: SECRET },
  };
}

async function buildApp(input: { knownCustomConfigs: unknown[] }) {
  const store = await tempStore();
  const linkBodies: Array<Record<string, unknown>> = [];
  const app = await buildMarketplaceApp({
    store,
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    environment: { MARKETPLACE_PUBLIC_ORIGIN: "http://127.0.0.1:5314" },
    rulesClient: async () => ({ effect: "allow", decisionId: "rules-connect-mode" }),
    providerFetch: async (request, init) => {
      const url = new URL(String(request));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/toolkits")) {
        return new Response(JSON.stringify({ items: TOOLKITS }), { status: 200 });
      }
      if (url.pathname.endsWith("/connected_accounts")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/tools")) {
        return new Response(JSON.stringify({ items: [{ name: "GITHUB_LIST_REPOS", description: "List repos" }] }), { status: 200 });
      }
      const byId = /\/auth_configs\/([^/]+)$/u.exec(url.pathname);
      if (byId) {
        const all = [authConfig("ac_github", "github"), authConfig("ac_slack", "slack")];
        const found = all.find((entry) => entry.id === decodeURIComponent(byId[1]!));
        return new Response(JSON.stringify(found ?? { error: "not found" }), { status: found ? 200 : 404 });
      }
      if (url.pathname.endsWith("/auth_configs") && method === "GET") {
        const toolkit = url.searchParams.get("toolkit_slug");
        const items = toolkit ? [] : input.knownCustomConfigs;
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      if (url.pathname.endsWith("/connected_accounts/link")) {
        linkBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ connected_account_id: "ca_pending", redirect_url: "https://auth.composio.test/x", status: "PENDING" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
  });
  return { app, store, linkBodies };
}

type Summary = {
  connectModeCounts: Record<string, number>;
  filteredTotal: number;
  items: Array<{ pluginId: string; connectMode: string }>;
};

describe("connect mode on the cards API", () => {
  it("exposes connectMode, per-mode counts and a status filter", async () => {
    const { app, store } = await buildApp({ knownCustomConfigs: [] });

    const summary = await app.inject({ method: "GET", url: "/api/marketplace/cards/summary?workspaceSlug=default&limit=100" });
    expect(summary.statusCode).toBe(200);
    const body = summary.json<Summary>();
    const modes = Object.fromEntries(body.items.map((item) => [item.pluginId, item.connectMode]));
    expect(modes).toMatchObject({
      "composio-github": "needs_auth_config",
      "composio-gmail": "ready_managed",
      "composio-1password": "ready_user_key",
      "composio-hackernews": "no_auth",
    });
    // no_auth also counts the seeded composio-bootstrap listing.
    expect(modes["composio-bootstrap"]).toBe("no_auth");
    expect(body.connectModeCounts).toMatchObject({ needs_auth_config: 1, ready_managed: 1, ready_user_key: 1, no_auth: 2 });

    const filtered = await app.inject({
      method: "GET",
      url: "/api/marketplace/cards/summary?workspaceSlug=default&limit=100&connectMode=needs_auth_config",
    });
    const filteredBody = filtered.json<Summary>();
    expect(filteredBody.items.map((item) => item.pluginId)).toEqual(["composio-github"]);
    expect(filteredBody.filteredTotal).toBe(1);
    expect(filteredBody.connectModeCounts).toEqual(body.connectModeCounts);

    const invalid = await app.inject({ method: "GET", url: "/api/marketplace/cards/summary?connectMode=bogus" });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);

    const cards = await app.inject({ method: "GET", url: "/api/marketplace/cards?workspaceSlug=default" });
    const github = cards.json<{ cards: Array<{ listing: { pluginId: string }; connectMode: string }> }>().cards.find(
      (card) => card.listing.pluginId === "composio-github",
    );
    expect(github?.connectMode).toBe("needs_auth_config");

    const detail = await app.inject({ method: "GET", url: "/api/marketplace/cards/composio-github?workspaceSlug=default" });
    expect(detail.json()).toMatchObject({
      card: { connectMode: "needs_auth_config", connectInfo: { toolkit: "github", authSchemes: ["OAUTH2"], managedAuthSchemes: [] } },
    });

    await app.close();
    store.close();
  });

  it("marks toolkits with a known custom auth config as ready without exposing credentials", async () => {
    const { app, store } = await buildApp({ knownCustomConfigs: [authConfig("ac_github", "github")] });
    const summary = await app.inject({ method: "GET", url: "/api/marketplace/cards/summary?workspaceSlug=default&limit=100" });
    const github = summary.json<Summary>().items.find((item) => item.pluginId === "composio-github");
    expect(github?.connectMode).toBe("ready_auth_config");
    expect(summary.body).not.toContain(SECRET);
    const detail = await app.inject({ method: "GET", url: "/api/marketplace/cards/composio-github?workspaceSlug=default" });
    expect(detail.body).not.toContain(SECRET);
    expect(JSON.stringify(store.getListing("composio-github"))).not.toContain(SECRET);
    await app.close();
    store.close();
  });

  it("connects with a passed authConfigId and refuses one from another toolkit", async () => {
    const { app, store, linkBodies } = await buildApp({ knownCustomConfigs: [] });
    await app.inject({ method: "GET", url: "/api/marketplace/cards/summary?workspaceSlug=default" });
    const connect = (authConfigId?: string) =>
      app.inject({
        method: "POST",
        url: "/api/marketplace/plugins/composio-github/connection",
        payload: { workspaceSlug: "default", actorId: "operator", provider: "github", backend: "composio", ...(authConfigId ? { authConfigId } : {}) },
      });

    const required = await connect();
    expect(required.statusCode).toBe(409);
    expect(required.json()).toMatchObject({ ok: false, error: "composio_auth_config_required" });

    const mismatch = await connect("ac_slack");
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ ok: false, error: "composio_auth_config_toolkit_mismatch" });
    expect(mismatch.body).not.toContain(SECRET);

    const missing = await connect("ac_nope");
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "composio_auth_config_not_found" });
    expect(linkBodies).toHaveLength(0);

    const ok = await connect("ac_github");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ auth: { authConfigId: "ac_github", kind: "redirect-required" }, connection: { state: "pending" } });
    expect(ok.body).not.toContain(SECRET);
    expect(linkBodies).toEqual([expect.objectContaining({ auth_config_id: "ac_github" })]);

    // The pending connection remembers the auth config, so the card is ready to reconnect.
    const summary = await app.inject({ method: "GET", url: "/api/marketplace/cards/summary?workspaceSlug=default&limit=100" });
    expect(summary.json<Summary>().items.find((item) => item.pluginId === "composio-github")?.connectMode).toBe("ready_auth_config");

    await app.close();
    store.close();
  });
});

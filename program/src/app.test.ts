import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildComposioCatalogListing } from "./connectors.js";
import { type MarketplaceListing } from "./types.js";
import { makeRulesClient } from "./rules-client.js";
import { MARKETPLACE_TABLES, SqliteMarketplaceStore } from "./store.js";
import { scanConnectorPromotionCandidates } from "./usage-ledger.js";

const tempRoots: string[] = [];

async function tempDbPath() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tealbrick-marketplace-"),
  );
  tempRoots.push(root);
  return path.join(root, "marketplace.sqlite");
}

async function tempRuntimePaths() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tealbrick-marketplace-runtime-"),
  );
  tempRoots.push(root);
  return {
    dbPath: path.join(root, "data", "marketplace.sqlite"),
    logPath: path.join(root, "logs", "marketplace-debug.jsonl"),
    root,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Marketplace Program", () => {
  it("projects every paginated Composio toolkit as its own Plugin card", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const requestedUrls: string[] = [];
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "projection-token",
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      providerFetch: async (input) => {
        const url = new URL(String(input));
        requestedUrls.push(url.toString());
        if (url.pathname === "/api/v3.1/connected_accounts") {
          return new Response(
            JSON.stringify({
              total_items: 1,
              items: [
                {
                  id: "ca_gmail_active",
                  toolkit: { slug: "gmail" },
                  status: "ACTIVE",
                  is_disabled: false,
                  updated_at: "2026-07-21T12:00:00Z",
                  user_id: "doppelganger",
                },
              ],
              next_cursor: null,
            }),
            { status: 200 },
          );
        }
        expect(url.pathname).toBe("/api/v3.1/toolkits");
        expect(url.searchParams.get("limit")).toBe("1000");
        if (!url.searchParams.get("cursor")) {
          return new Response(
            JSON.stringify({
              total_items: 2,
              items: [
                {
                  slug: "gmail",
                  name: "Gmail",
                  auth_schemes: ["OAUTH2"],
                  composio_managed_auth_schemes: ["OAUTH2"],
                  no_auth: false,
                  meta: {
                    description: "Email from Google.",
                    logo: "https://logos.composio.dev/api/gmail",
                    tools_count: 61,
                    triggers_count: 2,
                    categories: [{ name: "email" }],
                    version: "20260721_00",
                  },
                },
              ],
              next_cursor: "page-two",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            total_items: 2,
            items: [
              {
                slug: "slack",
                name: "Slack",
                auth_schemes: ["OAUTH2"],
                meta: {
                  description: "Team messaging.",
                  logo: "https://logos.composio.dev/api/slack",
                  tools_count: 40,
                  triggers_count: 4,
                  categories: [{ name: "communication" }],
                },
              },
            ],
            next_cursor: null,
          }),
          { status: 200 },
        );
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/hub/records?workspaceSlug=default",
      headers: { authorization: "Bearer projection-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(requestedUrls).toHaveLength(3);
    expect(response.json().pluginRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "composio-gmail",
          displayName: "Gmail",
          iconUrl: "https://logos.composio.dev/api/gmail",
          lifecycle: "available",
          connection: expect.objectContaining({ state: "connected" }),
          allowedActions: ["install"],
        }),
        expect.objectContaining({
          pluginId: "composio-slack",
          displayName: "Slack",
          iconUrl: "https://logos.composio.dev/api/slack",
          connection: expect.objectContaining({ state: "auth-required" }),
          allowedActions: ["authenticate"],
        }),
      ]),
    );
    expect(response.json().actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerRecordId: "plugin:composio-gmail",
          operation: "install",
          label: "Enable",
        }),
        expect.objectContaining({
          ownerRecordId: "plugin:composio-slack",
          operation: "authenticate",
          label: "Connect",
        }),
      ]),
    );
    expect(store.getListing("composio-gmail")?.manifest).toMatchObject({
      role: "composio-catalog-connector",
      composio: {
        catalog: {
          logoUrl: "https://logos.composio.dev/api/gmail",
          toolsCount: 61,
          triggersCount: 2,
        },
      },
    });

    await app.close();
    store.close();
  });

  it("Rules-gates catalog Connect before hydration or Agent enablement", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    store.upsertListing({
      pluginId: "composio-gmail",
      displayName: "Gmail",
      kind: "connector",
      provider: "gmail",
      description: "Email from Google.",
      capabilities: ["connector.observe", "connector.dispatch"],
      actions: [],
      source: "composio",
      authOwner: "composio",
      executionOwner: "composio",
      enabledByDefault: false,
      manifest: {
        role: "composio-catalog-connector",
        composio: {
          catalog: { logoUrl: "https://logos.composio.dev/api/gmail" },
        },
      },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    let providerCalls = 0;
    const app = await buildMarketplaceApp({
      store,
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      // Configured Rules that is down: the client fails closed.
      rulesClient: async () => ({
        effect: "deny",
        reason: "Rules request failed closed: connect ECONNREFUSED",
      }),
      providerFetch: async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/composio-gmail/connection",
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        provider: "gmail",
        toolkit: "gmail",
        backend: "composio",
      },
    });

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "rules_denied" });
    expect(providerCalls).toBe(0);
    expect(store.getInstall("default", "composio-gmail")).toBeNull();
    expect(store.getListing("composio-gmail")?.actions).toEqual([]);

    await app.close();
    store.close();
  });

  it("hydrates and enables a catalog connector only after Rules allows Connect", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    store.upsertListing({
      pluginId: "composio-gmail",
      displayName: "Gmail",
      kind: "connector",
      provider: "gmail",
      description: "Email from Google.",
      capabilities: ["connector.observe", "connector.dispatch"],
      actions: [],
      source: "composio",
      authOwner: "composio",
      executionOwner: "composio",
      enabledByDefault: false,
      manifest: {
        role: "composio-catalog-connector",
        composio: {
          catalog: { logoUrl: "https://logos.composio.dev/api/gmail" },
        },
      },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    });
    const calls: string[] = [];
    const app = await buildMarketplaceApp({
      store,
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      environment: { MARKETPLACE_PUBLIC_ORIGIN: "http://127.0.0.1:5314" },
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-connect",
      }),
      providerFetch: async (input) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith("/tools")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  name: "GMAIL_FETCH_EMAILS",
                  description: "Fetch Gmail messages",
                  input_parameters: { type: "object", properties: {} },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith("/auth_configs")) {
          return new Response(
            JSON.stringify({
              items: [{ id: "authcfg_gmail", toolkit: { slug: "gmail" } }],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith("/connected_accounts/link")) {
          return new Response(
            JSON.stringify({
              connected_account_id: "ca_gmail_pending",
              redirect_url: "https://auth.composio.test/gmail",
              status: "PENDING",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });

    const connected = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/composio-gmail/connection",
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        provider: "gmail",
        toolkit: "gmail",
        backend: "composio",
      },
    });

    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      auth: {
        kind: "redirect-required",
        redirectUrl: "https://auth.composio.test/gmail",
      },
      connection: { state: "pending" },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        "/api/v3.1/tools",
        "/api/v3.1/auth_configs",
        "/api/v3/connected_accounts/link",
      ]),
    );
    expect(store.getInstall("default", "composio-gmail")).toMatchObject({
      lifecycle: "installed",
      enabled: true,
    });
    expect(store.getListing("composio-gmail")?.actions).toContain(
      "gmail.fetch.emails",
    );

    await app.close();
    store.close();
  });

  it("preserves exact Composio toolkit slugs and uses hosted custom auth for API-key connectors", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const listing = buildComposioCatalogListing({
      toolkit: {
        slug: "_1password",
        name: "1Password",
        auth_schemes: ["API_KEY"],
        composio_managed_auth_schemes: [],
        no_auth: false,
        meta: { description: "Password manager.", tools_count: 8 },
      },
    });
    expect(listing).not.toBeNull();
    const composio = listing!.manifest.composio as Record<string, unknown>;
    const catalog = composio.catalog as Record<string, unknown>;
    store.upsertListing({
      ...listing!,
      runtimeSources: listing!.runtimeSources?.map((source) => ({
        ...source,
        toolkitSlug: "1password",
      })),
      manifest: {
        ...listing!.manifest,
        role: "composio-imported-plugin",
        composio: {
          ...composio,
          toolkit: "1password",
          catalog: { ...catalog, slug: "1password" },
        },
      },
    });

    const requestedToolkits: string[] = [];
    const authConfigBodies: Array<Record<string, unknown>> = [];
    const authLinkUrls: string[] = [];
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "projection-token",
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      environment: { MARKETPLACE_PUBLIC_ORIGIN: "http://127.0.0.1:5314" },
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-connect-api-key",
      }),
      providerFetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/toolkits")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  slug: "_1password",
                  name: "1Password",
                  auth_schemes: ["API_KEY"],
                  composio_managed_auth_schemes: [],
                  no_auth: false,
                  meta: { description: "Password manager.", tools_count: 8 },
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith("/connected_accounts")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (url.pathname.endsWith("/tools")) {
          requestedToolkits.push(url.searchParams.get("toolkit_slug") ?? "");
          return new Response(
            JSON.stringify({
              items: [
                {
                  name: "_1PASSWORD_LIST_VAULTS",
                  description: "List vaults",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.pathname.endsWith("/auth_configs")) {
          if ((init?.method ?? "GET") === "POST") {
            authConfigBodies.push(
              JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            );
            return new Response(
              JSON.stringify({
                id: "authcfg_1password",
                toolkit: { slug: "_1password" },
              }),
              { status: 200 },
            );
          }
          expect(url.searchParams.get("toolkit_slug")).toBe("_1password");
          expect(url.searchParams.get("is_composio_managed")).toBe("false");
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (url.pathname.endsWith("/connected_accounts/link")) {
          authLinkUrls.push(url.toString());
          return new Response(
            JSON.stringify({
              connected_account_id: "ca_1password_pending",
              redirect_url: "https://auth.composio.test/1password",
              status: "PENDING",
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });

    const refreshed = await app.inject({
      method: "GET",
      url: "/api/marketplace/hub/records?workspaceSlug=default",
      headers: { authorization: "Bearer projection-token" },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(store.getListing("composio-1password")).toMatchObject({
      manifest: {
        role: "composio-catalog-connector",
        composio: { toolkit: "_1password", catalog: { slug: "_1password" } },
      },
    });

    const connected = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/composio-1password/connection",
      payload: {
        workspaceSlug: "default",
        actorId: "operator",
        provider: "1password",
        toolkit: "1password",
        backend: "composio",
      },
    });

    expect(connected.statusCode).toBe(200);
    expect(requestedToolkits).toEqual(["_1password"]);
    expect(authLinkUrls).toEqual([
      "https://backend.composio.dev/api/v3/connected_accounts/link",
    ]);
    expect(authConfigBodies).toEqual([
      {
        toolkit: { slug: "_1password" },
        auth_config: {
          type: "use_custom_auth",
          authScheme: "API_KEY",
          credentials: {},
          restrict_to_following_tools: [],
        },
      },
    ]);
    expect(store.getListing("composio-1password")).toMatchObject({
      provider: "1password",
      manifest: {
        role: "composio-catalog-connector",
        composio: { toolkit: "_1password" },
      },
      runtimeSources: [expect.objectContaining({ toolkitSlug: "_1password" })],
    });

    await app.close();
    store.close();
  });

  it("protects and serves the registry-declared Extension settings projection", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "projection-token",
    });

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/plugins/marketplace-hub/records",
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/plugins/marketplace-hub/records",
      headers: { authorization: "Bearer projection-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      host: {
        entry: "capabilities",
        tabs: ["skills", "plugins", "extensions"],
      },
      settingsSurfaces: expect.arrayContaining([
        expect.objectContaining({
          settingsSurfaceId: "marketplace.settings",
          submitActionId: "extension:marketplace:configure",
        }),
      ]),
    });

    await app.close();
    store.close();
  });

  it("stores managed sidecar state under the App-provided product workspace", () => {
    const config = loadConfig({
      DOPPELGANGER_PRODUCT_WORKSPACE_DIR: "/tmp/doppelganger-marketplace-state",
      MARKETPLACE_PORT: "0",
    });

    expect(config.dbPath).toBe(
      "/tmp/doppelganger-marketplace-state/data/marketplace.sqlite",
    );
  });

  it("loads the Rules gateway authority and company scope from deployment env", () => {
    const config = loadConfig({
      MARKETPLACE_PORT: "0",
      RULES_BASE_URL: "http://127.0.0.1:5313",
      RULES_INTERNAL_AUTH_TOKEN: "rules-token",
      RULES_COMPANY_ID: "default-company",
    });

    expect(config.rules).toEqual({
      baseUrl: "http://127.0.0.1:5313",
      internalAuthToken: "rules-token",
      companyId: "default-company",
    });
  });

  it("creates the PRD-owned SQLite tables", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());

    expect(store.listTables().sort()).toEqual([...MARKETPLACE_TABLES].sort());

    store.close();
  });

  it("records Agent thread to remote Hermes session correlations in Product storage", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({ store });

    const recordResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/session-correlations",
      headers: { "x-trace-id": "session-correlation-test" },
      payload: {
        workspaceSlug: "atlas",
        appThreadId: "thread-dg-copyable",
        providerInstanceId: "hermes",
        hermesLiveSessionId: "live-1234",
        hermesStoredSessionId: "20260630_111111_abcd",
        profile: "max",
        runtimeMode: "full-access",
        cwd: "/tmp/marketplace-fixture",
        eventType: "session.create",
      },
    });

    expect(recordResponse.statusCode).toBe(201);
    expect(recordResponse.json()).toMatchObject({
      ok: true,
      correlation: {
        workspaceSlug: "atlas",
        appThreadId: "thread-dg-copyable",
        provider: "hermes",
        providerInstanceId: "hermes",
        remoteSessionId: "20260630_111111_abcd",
        hermesLiveSessionId: "live-1234",
        hermesStoredSessionId: "20260630_111111_abcd",
        profile: "max",
      },
    });

    const queryResponse = await app.inject({
      method: "GET",
      url: "/api/marketplace/session-correlations?workspaceSlug=atlas&appThreadId=thread-dg-copyable",
    });

    expect(queryResponse.statusCode).toBe(200);
    expect(queryResponse.json()).toMatchObject({
      correlations: [
        {
          appThreadId: "thread-dg-copyable",
          remoteSessionId: "20260630_111111_abcd",
          hermesLiveSessionId: "live-1234",
          hermesStoredSessionId: "20260630_111111_abcd",
        },
      ],
    });

    store.close();
  });

  it("installs a native connector listing and exposes capability bindings", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/marketplace/plugins?workspaceSlug=atlas",
    });
    expect(listResponse.statusCode).toBe(200);
    const listings = listResponse.json<{
      items: Array<{ pluginId: string }>;
    }>();
    expect(listings.items.map((item) => item.pluginId)).toContain(
      "github-native",
    );

    const installResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/install",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });
    expect(installResponse.statusCode).toBe(201);
    expect(installResponse.json()).toMatchObject({
      install: {
        workspaceSlug: "atlas",
        pluginId: "github-native",
        enabled: true,
      },
      rules: {
        effect: "allow",
      },
    });

    const bindResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/capability-binding",
      payload: {
        workspaceSlug: "atlas",
        capability: "connector.observe",
        enabled: true,
      },
    });
    expect(bindResponse.statusCode).toBe(201);
    expect(bindResponse.json()).toMatchObject({
      binding: {
        workspaceSlug: "atlas",
        pluginId: "github-native",
        capability: "connector.observe",
        enabled: true,
      },
    });

    await app.close();
    store.close();
  });

  it("fails closed for governed actions when Rules is configured but has no client", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      rules: { baseUrl: "http://127.0.0.1:9", internalAuthToken: "rules-token" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/install",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "rules_unavailable",
      governedCapability: "connector.admin",
    });

    await app.close();
    store.close();
  });

  it("fails closed for governed lifecycle and exposure mutations when Rules is configured but has no client", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    store.install("atlas", "github-native");
    const app = await buildMarketplaceApp({
      store,
      rules: { baseUrl: "http://127.0.0.1:9", internalAuthToken: "rules-token" },
    });

    const bindCapabilityResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/capability-binding",
      payload: {
        workspaceSlug: "atlas",
        capability: "connector.observe",
        enabled: true,
      },
    });
    expect(bindCapabilityResponse.statusCode).toBe(503);
    expect(bindCapabilityResponse.json()).toMatchObject({
      ok: false,
      error: "rules_unavailable",
      governedCapability: "connector.admin",
    });
    expect(() =>
      store.requireCapabilityBinding(
        "atlas",
        "github-native",
        "connector.observe",
      ),
    ).toThrow(/no connector\.observe binding/u);

    const bindActionResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/action-binding",
      payload: {
        workspaceSlug: "atlas",
        actionKey: "github.repositories.list",
        enabled: false,
      },
    });
    expect(bindActionResponse.statusCode).toBe(503);
    expect(bindActionResponse.json()).toMatchObject({
      ok: false,
      error: "rules_unavailable",
      governedCapability: "connector.admin",
    });

    const uninstallResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/uninstall",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });
    expect(uninstallResponse.statusCode).toBe(503);
    expect(uninstallResponse.json()).toMatchObject({
      ok: false,
      error: "rules_unavailable",
      governedCapability: "connector.admin",
    });
    expect(store.getInstall("atlas", "github-native")).toMatchObject({
      enabled: true,
      lifecycle: "installed",
    });

    await app.close();
    store.close();
  });

  it("uses configured Rules service for governed install decisions", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const rules = Fastify();
    let capturedRequest: {
      authorization?: string;
      body?: Record<string, unknown>;
    } = {};

    rules.post("/api/rules/gateway/evaluate", async (request) => {
      capturedRequest = {
        authorization: request.headers.authorization,
        body: request.body as Record<string, unknown>,
      };
      return {
        allowed: true,
        reason: "allowed by configured Rules service",
        decisionId: "rules-http-allow",
      };
    });
    await rules.listen({ host: "127.0.0.1", port: 0 });
    const address = rules.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Rules test server did not bind to a TCP port.");
    }

    const app = await buildMarketplaceApp({
      store,
      rulesClient: makeRulesClient({
        host: "127.0.0.1",
        port: 0,
        dbPath: store.dbPath,
        settingsPath: `${store.dbPath}.provider-settings.json`,
        secretsPath: `${store.dbPath}.provider-secrets.json`,
        rules: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          internalAuthToken: "rules-test-token",
          companyId: "default-company",
        },
      }),
    });

    const installResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/install",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });

    expect(installResponse.statusCode).toBe(201);
    expect(installResponse.json()).toMatchObject({
      rules: {
        effect: "allow",
        decisionId: "rules-http-allow",
      },
    });
    expect(capturedRequest.authorization).toBe("Bearer rules-test-token");
    expect(capturedRequest.body).toMatchObject({
      method: "doppelganger.rules.evaluate",
      params: {
        companyId: "default-company",
        ruleKey: "marketplace.plugin",
        operation: "install",
        target: {
          kind: "plugin",
          id: "github-native",
          pluginId: "github-native",
          capability: "connector.admin",
          companyId: "default-company",
        },
      },
    });

    await app.close();
    await rules.close();
    store.close();
  });

  it("lets an operator complete connector setup only when Rules has no matching lifecycle policy", async () => {
    const rules = Fastify();
    const capturedRequests: Array<Record<string, unknown>> = [];
    rules.post("/api/rules/gateway/evaluate", async (request) => {
      capturedRequests.push(request.body as Record<string, unknown>);
      const body = request.body as {
        params?: { target?: { pluginId?: string } };
      };
      const explicitDeny =
        body.params?.target?.pluginId === "composio-explicit-deny";
      return {
        allowed: false,
        reason: explicitDeny
          ? "Denied by the workspace connector policy."
          : "gateway request denied: no live ruleset matched this request",
      };
    });
    await rules.listen({ host: "127.0.0.1", port: 0 });
    const address = rules.server.address();
    if (!address || typeof address === "string")
      throw new Error("Rules test server did not bind.");
    const dbPath = await tempDbPath();
    const client = makeRulesClient({
      host: "127.0.0.1",
      port: 0,
      dbPath,
      settingsPath: `${dbPath}.settings.json`,
      secretsPath: `${dbPath}.secrets.json`,
      rules: { baseUrl: `http://127.0.0.1:${address.port}` },
    });
    expect(client).toBeDefined();
    const base = {
      workspaceSlug: "default",
      operation: "composio.connect",
      capability: "connector.admin" as const,
      pluginId: "composio-linear",
      payload: {},
    };
    await expect(
      client!({ ...base, actorId: "operator" }),
    ).resolves.toMatchObject({
      effect: "allow",
      decisionId: "operator-confirmed:composio.connect:composio-linear",
    });
    // Operator sessions bind actorId to the principal id, not "operator".
    for (const actorId of ["martin", "portal-user:3f32db87", "marketplace-service"]) {
      await expect(
        client!({ ...base, operation: "install", actorId }),
      ).resolves.toMatchObject({
        effect: "allow",
        decisionId: "operator-confirmed:install:composio-linear",
      });
    }
    await expect(
      client!({ ...base, operation: "custom-mcp.create", actorId: "martin" }),
    ).resolves.toMatchObject({ effect: "allow" });
    await expect(
      client!({ ...base, operation: "install", actorId: "martin", pluginId: "composio-explicit-deny" }),
    ).resolves.toMatchObject({ effect: "deny", reason: "Denied by the workspace connector policy." });
    for (const actorId of ["agent", "agent:henry", "agent-smoke"]) {
      await expect(
        client!({ ...base, operation: "install", actorId }),
      ).resolves.toMatchObject({ effect: "deny" });
    }
    await expect(client!({ ...base, actorId: "agent" })).resolves.toMatchObject(
      { effect: "deny" },
    );
    await expect(
      client!({
        ...base,
        operation: "execute",
        capability: "connector.observe",
        actorId: "agent-smoke",
      }),
    ).resolves.toMatchObject({
      effect: "allow",
      decisionId: "operator-enabled:execute:composio-linear",
    });
    expect(capturedRequests.at(-1)).toMatchObject({
      params: {
        actor: {
          kind: "agent",
          roles: ["agent"],
        },
        runtimeContext: {
          lane: "agent",
        },
      },
    });
    await expect(
      client!({
        workspaceSlug: "default",
        operation: "execute",
        capability: "connector.observe",
        actorId: "agent:agent-1",
        pluginId: "composio-linear",
        payload: {
          contractVersion: "doppelganger.marketplace.agent-connector-grant.v1",
          phase: "grant",
          agentGrantId: "agent_grant_fixture",
          resourceRef: "account:fixture",
        },
      }),
    ).resolves.toMatchObject({
      effect: "deny",
      reason: "gateway request denied: no live ruleset matched this request",
    });
    await expect(
      client!({
        ...base,
        operation: "execute",
        capability: "connector.observe",
        actorId: "agent:agent-1",
        payload: {
          contractVersion: "tealbrick.marketplace.operator-handoff.v1.1",
          phase: "execute",
          consentId: "consent_fixture",
          resourceRef: "account:fixture",
        },
      }),
    ).resolves.toMatchObject({
      effect: "deny",
      reason: "gateway request denied: no live ruleset matched this request",
    });
    await expect(
      client!({
        ...base,
        operation: "execute",
        capability: "connector.admin",
        actorId: "agent",
      }),
    ).resolves.toMatchObject({ effect: "deny" });
    await expect(
      client!({
        ...base,
        operation: "hub.lifecycle.disable",
        actorId: "operator",
      }),
    ).resolves.toMatchObject({
      effect: "allow",
      decisionId:
        "operator-confirmed:hub.lifecycle.disable:composio-linear",
    });
    await expect(
      client!({
        ...base,
        operation: "action.bind",
        actorId: "operator",
      }),
    ).resolves.toMatchObject({
      effect: "allow",
      decisionId: "operator-confirmed:action.bind:composio-linear",
    });
    await expect(
      client!({
        ...base,
        operation: "composio.import",
        actorId: "operator",
      }),
    ).resolves.toMatchObject({
      effect: "allow",
      decisionId: "operator-confirmed:composio.import:composio-linear",
    });
    await expect(
      client!({
        ...base,
        actorId: "operator",
        pluginId: "composio-explicit-deny",
      }),
    ).resolves.toMatchObject({ effect: "deny" });
    await expect(
      client!({
        ...base,
        operation: "execute",
        capability: "connector.observe",
        actorId: "agent",
        pluginId: "composio-explicit-deny",
      }),
    ).resolves.toMatchObject({ effect: "deny" });
    await rules.close();
  });

  it("reports missing provider sidecars honestly", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({ store });

    const response = await app.inject({
      method: "GET",
      url: "/api/marketplace/provider-health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providers: {
        nango: {
          state: "missing",
          configured: false,
        },
        activepieces: {
          state: "missing",
          configured: false,
        },
        composio: {
          state: "missing",
          configured: false,
        },
      },
    });

    await app.close();
    store.close();
  });

  it("allows the desktop App origin to read health, status, and events", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({ store });
    const origin = "http://localhost:5733";

    const healthResponse = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin },
    });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.headers["access-control-allow-origin"]).toBe(origin);
    expect(healthResponse.headers.vary).toBe("Origin");

    const preflightResponse = await app.inject({
      method: "OPTIONS",
      url: "/api/status",
      headers: {
        origin,
        "access-control-request-method": "GET",
      },
    });
    expect(preflightResponse.statusCode).toBe(204);
    expect(preflightResponse.headers["access-control-allow-origin"]).toBe(
      origin,
    );
    expect(preflightResponse.headers["access-control-allow-methods"]).toContain(
      "GET",
    );

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/events",
      headers: { origin },
    });
    expect(eventsResponse.statusCode).toBe(200);
    expect(eventsResponse.headers["access-control-allow-origin"]).toBe(origin);
    expect(eventsResponse.headers["content-type"]).toContain(
      "text/event-stream",
    );

    await app.close();
    store.close();
  });

  it("records traceable event envelopes and debug logs under the hidden runtime home", async () => {
    const runtime = await tempRuntimePaths();
    const store = new SqliteMarketplaceStore(runtime.dbPath, {
      logPath: runtime.logPath,
      debug: true,
    });
    const app = await buildMarketplaceApp({
      store,
      debug: true,
      logPath: runtime.logPath,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const installResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/install",
      headers: {
        "x-trace-id": "trace-install-1",
      },
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });
    expect(installResponse.statusCode).toBe(201);

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/api/debug/events?workspaceSlug=atlas",
    });
    expect(eventsResponse.statusCode).toBe(200);
    expect(eventsResponse.json()).toMatchObject({
      debug: {
        enabled: true,
        logPath: runtime.logPath,
      },
      events: [
        expect.objectContaining({
          type: "marketplace.plugin.installed",
          traceId: "trace-install-1",
          workspaceSlug: "atlas",
          pluginId: "github-native",
        }),
      ],
    });

    const logText = await readFile(runtime.logPath, "utf8");
    expect(logText).toContain("marketplace.plugin.installed");
    expect(logText).toContain("trace-install-1");

    await app.close();
    store.close();
  });

  it("does not project registered native connectors as executable Agent tools", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const registerResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/register",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });
    expect(registerResponse.statusCode).toBe(201);

    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/install",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/capability-binding",
      payload: {
        workspaceSlug: "atlas",
        capability: "connector.observe",
        enabled: true,
      },
    });

    const capabilitiesResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });
    expect(capabilitiesResponse.statusCode).toBe(200);
    expect(capabilitiesResponse.json()).toMatchObject({ capabilities: [] });

    const unregisterResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/unregister",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });
    expect(unregisterResponse.statusCode).toBe(200);

    const afterUnregisterResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });
    expect(afterUnregisterResponse.json()).toMatchObject({ capabilities: [] });

    await app.close();
    store.close();
  });

  it("does not project MCP placeholders as executable Agent tools", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const listing = store.getListing("mcp-runtime");
    expect(listing).toMatchObject({
      provider: "mcp",
      source: "mcp",
      executionOwner: "mcp",
      runtimeSources: [
        expect.objectContaining({
          kind: "mcp",
          primary: true,
        }),
      ],
    });

    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/mcp-runtime/register",
      payload: { workspaceSlug: "atlas", actorId: "operator" },
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/mcp-runtime/install",
      payload: { workspaceSlug: "atlas", actorId: "operator" },
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/mcp-runtime/capability-binding",
      payload: {
        workspaceSlug: "atlas",
        capability: "connector.observe",
        enabled: true,
      },
    });

    const capabilitiesResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });

    expect(capabilitiesResponse.statusCode).toBe(200);
    expect(capabilitiesResponse.json()).toMatchObject({ capabilities: [] });

    await app.close();
    store.close();
  });

  it("redacts MCP env and headers from browser listing routes", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const listing = store.getListing("mcp-runtime") as MarketplaceListing;
    store.upsertListing({
      ...listing,
      pluginId: "mcp-sensitive",
      displayName: "Sensitive MCP fixture",
      manifest: {
        ...listing.manifest,
        skillsHub: {
          custom: true,
          adapter: {
            type: "mcp",
            mcp: {
              transport: "stdio",
              command: "sensitive-mcp",
              env: { MCP_TOKEN: "secret-value" },
              headers: { authorization: "Bearer secret-value" },
            },
          },
        },
      },
    });
    const app = await buildMarketplaceApp({ store });

    for (const url of [
      "/api/marketplace/catalog?workspaceSlug=default",
      "/api/marketplace/plugins?workspaceSlug=default",
      "/api/marketplace/plugins/mcp-sensitive?workspaceSlug=default",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("secret-value");
      expect(response.body).not.toContain("MCP_TOKEN");
      // The header name only: Company Box action keys such as `chatwoot.twitter-authorization-create` legitimately contain the word.
      expect(response.body).not.toContain('"authorization"');
    }

    await app.close();
    store.close();
  });

  it("starts and completes a Composio auth popup without storing raw secrets", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const fetchCalls: string[] = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/auth_configs")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "authcfg_linear", toolkit: { slug: "linear" } }],
          }),
          {
            status: 200,
          },
        );
      }
      if (url.includes("/connected_accounts/link")) {
        return new Response(
          JSON.stringify({
            redirect_url: "https://auth.composio.test/linear",
            connected_account_id: "ca_pending_linear",
            status: "PENDING",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const app = await buildMarketplaceApp({
      store,
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      environment: { MARKETPLACE_PUBLIC_ORIGIN: "http://localhost:5733" },
      providerFetch,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/composio-bootstrap/connection",
      headers: { "x-trace-id": "trace-composio-start" },
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        provider: "linear",
        toolkit: "linear",
        backend: "composio",
        callbackUrl: "https://attacker.invalid/oauth/callback",
        callbackBaseUrl: "https://attacker.invalid",
      },
    });

    expect(response.statusCode).toBe(200);
    const started = response.json<{
      connection: {
        state: string;
        metadata: {
          state: string;
          redirectUrl: string;
          connectedAccountId: string;
        };
      };
      auth: { kind: string; redirectUrl: string };
    }>();
    expect(started).toMatchObject({
      connection: {
        state: "pending",
        metadata: {
          redirectUrl: "https://auth.composio.test/linear",
          connectedAccountId: "ca_pending_linear",
        },
      },
      auth: {
        kind: "redirect-required",
        redirectUrl: "https://auth.composio.test/linear",
      },
    });
    expect(JSON.stringify(started)).not.toContain("test-composio-key");

    const callbackResponse = await app.inject({
      method: "GET",
      url: `/api/marketplace/plugins/composio-bootstrap/oauth/composio/callback?state=${encodeURIComponent(started.connection.metadata.state)}&connected_account_id=ca_linear&status=ACTIVE`,
    });
    expect(callbackResponse.statusCode).toBe(200);
    expect(callbackResponse.body).toContain("Teal Brick connection complete");
    expect(store.getConnection("atlas", "composio-bootstrap")).toMatchObject({
      state: "connected",
      metadata: {
        connectedAccountId: "ca_linear",
      },
    });
    expect(fetchCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/auth_configs"),
        expect.stringContaining("/connected_accounts/link"),
      ]),
    );

    await app.close();
    store.close();
  });

  it("imports Composio toolkit tools, gates projection on connection, and executes through the Agent tool route", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const composioExecutions: Array<Record<string, unknown>> = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/tools/execute/LINEAR_LIST_ISSUES")) {
        composioExecutions.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            data: [{ id: "LIN-1", title: "Imported tool works" }],
          }),
          {
            status: 200,
          },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const app = await buildMarketplaceApp({
      store,
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      providerFetch,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      headers: { "x-trace-id": "trace-composio-import" },
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "linear",
        pluginId: "linear-composio",
        displayName: "Linear",
        tools: [
          { name: "LINEAR_LIST_ISSUES", description: "List Linear issues." },
          {
            name: "LINEAR_CREATE_ISSUE",
            description: "Create a Linear issue.",
          },
        ],
        autoEnable: true,
      },
    });
    expect(importResponse.statusCode).toBe(201);
    expect(importResponse.json()).toMatchObject({
      listing: {
        pluginId: "linear-composio",
        provider: "linear",
        source: "composio",
        actions: ["linear.create.issue", "linear.list.issues"],
      },
      import: {
        lifecycle: "enabled",
        importedActionKeys: ["linear.create.issue", "linear.list.issues"],
      },
    });

    const beforeConnectionResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });
    expect(beforeConnectionResponse.statusCode).toBe(200);
    expect(beforeConnectionResponse.json()).toMatchObject({ capabilities: [] });

    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "linear-composio",
      provider: "linear",
      backend: "composio",
      state: "connected",
      detail: "Test connected account",
      metadata: { connectedAccountId: "ca_linear" },
    });

    const capabilitiesResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });
    expect(capabilitiesResponse.statusCode).toBe(200);
    expect(capabilitiesResponse.json()).toMatchObject({
      capabilities: [
        expect.objectContaining({
          pluginId: "linear-composio",
          provider: "linear",
          actionType: "linear.create.issue",
          toolName: "marketplace.linear.create.issue",
          requiredCapabilities: ["connector.dispatch"],
          runtimeSource: "composio",
          connectionState: "connected",
        }),
        expect.objectContaining({
          pluginId: "linear-composio",
          provider: "linear",
          actionType: "linear.list.issues",
          toolName: "marketplace.linear.list.issues",
          requiredCapabilities: ["connector.observe"],
        }),
      ],
    });

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.linear.list.issues",
      headers: { "x-trace-id": "trace-composio-execute" },
      payload: {
        workspaceSlug: "atlas",
        actorId: "agent-smoke",
        pluginId: "linear-composio",
        input: { query: "status:open" },
      },
    });
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json()).toMatchObject({
      ok: true,
      traceId: "trace-composio-execute",
      result: {
        simulated: false,
        summary: "Executed LINEAR_LIST_ISSUES through Composio.",
      },
      usage: {
        sourceExecutor: "composio",
        sourceActionKey: "linear.list.issues",
      },
    });
    expect(composioExecutions).toEqual([
      expect.objectContaining({
        connected_account_id: "ca_linear",
        arguments: {
          query: "status:open",
        },
      }),
    ]);

    await app.close();
    store.close();
  });

  it("brokers scoped Composio execution for another miniapp without exposing the API key", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const composioExecutions: Array<Record<string, unknown>> = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/tools/execute/LINEAR_LIST_ISSUES")) {
        composioExecutions.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            data: [{ id: "LIN-7", title: "Brokered call works" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const app = await buildMarketplaceApp({
      store,
      internalAuthToken: "marketplace-service-token",
      organizationId: "atlas",
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      providerFetch,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "linear",
        pluginId: "linear-composio",
        tools: [
          { name: "LINEAR_LIST_ISSUES", description: "List Linear issues." },
          {
            name: "LINEAR_CREATE_ISSUE",
            description: "Create a Linear issue.",
          },
        ],
        autoEnable: true,
      },
    });
    expect(importResponse.statusCode).toBe(201);

    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "linear-composio",
      provider: "linear",
      backend: "composio",
      state: "connected",
      detail: "Test connected account",
      metadata: { connectedAccountId: "ca_linear" },
    });

    const overlongGrant = await app.inject({
      method: "POST",
      url: "/api/marketplace/broker/grants",
      headers: { authorization: "Bearer marketplace-service-token" },
      payload: {
        workspaceSlug: "atlas",
        actorId: "live-artifacts",
        requesterMiniappId: "live-artifacts",
        pluginId: "linear-composio",
        actionKeys: ["linear.list.issues"],
        ttlSeconds: 901,
      },
    });
    expect(overlongGrant.statusCode).toBe(400);

    const grantResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/broker/grants",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-trace-id": "trace-live-artifacts-grant",
      },
      payload: {
        workspaceSlug: "atlas",
        actorId: "live-artifacts",
        requesterMiniappId: "live-artifacts",
        pluginId: "linear-composio",
        actionKeys: ["linear.list.issues"],
        ttlSeconds: 300,
        metadata: {
          purpose: "hydrate artifact source rows",
        },
      },
    });
    expect(grantResponse.statusCode).toBe(201);
    const grant = grantResponse.json<{
      token: string;
      grant: {
        id: string;
        requesterMiniappId: string;
        pluginId: string;
        actionKeys: string[];
        capabilities: string[];
        tokenHash?: string;
      };
    }>();
    expect(grant.token).toMatch(/^broker_/);
    expect(grant.grant).toMatchObject({
      requesterMiniappId: "live-artifacts",
      pluginId: "linear-composio",
      actionKeys: ["linear.list.issues"],
      capabilities: ["connector.observe"],
    });
    expect(grant.grant.tokenHash).toBeUndefined();
    expect(JSON.stringify(grant)).not.toContain("test-composio-key");

    const deniedAction = await app.inject({
      method: "POST",
      url: "/api/marketplace/broker/composio/execute",
      payload: {
        workspaceSlug: "atlas",
        requesterMiniappId: "live-artifacts",
        pluginId: "linear-composio",
        brokerToken: grant.token,
        action: {
          type: "linear.create.issue",
          title: "Should be denied",
        },
      },
    });
    expect(deniedAction.statusCode).toBe(403);
    expect(deniedAction.json()).toMatchObject({
      ok: false,
      error: "broker_action_not_granted",
    });

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/broker/composio/execute",
      headers: { "x-trace-id": "trace-live-artifacts-execute" },
      payload: {
        workspaceSlug: "atlas",
        requesterMiniappId: "live-artifacts",
        pluginId: "linear-composio",
        brokerToken: grant.token,
        action: {
          type: "linear.list.issues",
          query: "status:open",
        },
      },
    });
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json()).toMatchObject({
      ok: true,
      broker: {
        grantId: grant.grant.id,
        requesterMiniappId: "live-artifacts",
        pluginId: "linear-composio",
        actionKey: "linear.list.issues",
        rawSecretReturned: false,
      },
      result: {
        simulated: false,
        summary: "Executed LINEAR_LIST_ISSUES through Composio.",
      },
    });
    expect(JSON.stringify(executeResponse.json())).not.toContain(
      "test-composio-key",
    );
    expect(composioExecutions).toEqual([
      expect.objectContaining({
        connected_account_id: "ca_linear",
        arguments: {
          query: "status:open",
        },
      }),
    ]);

    const replayResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/broker/composio/execute",
      payload: {
        workspaceSlug: "atlas",
        requesterMiniappId: "live-artifacts",
        pluginId: "linear-composio",
        brokerToken: grant.token,
        action: {
          type: "linear.list.issues",
          query: "status:open",
        },
      },
    });
    expect(replayResponse.statusCode).toBe(401);
    expect(replayResponse.json()).toMatchObject({
      ok: false,
      error: "broker_grant_not_found",
    });

    await app.close();
    store.close();
  });

  it("accepts typed Live Artifacts cross-app broker execution only through bearer auth and Rules", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const rulesCalls: Array<Record<string, unknown>> = [];
    const composioExecutions: Array<Record<string, unknown>> = [];
    const providerFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/tools/execute/LINEAR_LIST_ISSUES")) {
        composioExecutions.push(
          JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            data: [{ id: "LIN-8", title: "Cross-app call works" }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };
    const app = await buildMarketplaceApp({
      store,
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      internalAuthToken: "marketplace-service-token",
      organizationId: "atlas",
      providerFetch,
      rulesClient: async (input) => {
        rulesCalls.push(input);
        return {
          effect: "allow",
          decisionId: `rules-${rulesCalls.length}`,
        };
      },
    });

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "linear",
        pluginId: "linear-composio",
        tools: [
          { name: "LINEAR_LIST_ISSUES", description: "List Linear issues." },
        ],
        autoEnable: true,
      },
    });
    expect(importResponse.statusCode).toBe(201);

    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "linear-composio",
      provider: "linear",
      backend: "composio",
      state: "connected",
      detail: "Test connected account",
      metadata: { connectedAccountId: "ca_linear" },
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/marketplace/v1/broker/composio/execute",
      payload: {
        contractVersion: "doppelganger.cross-app.marketplace.broker-execute.v1",
        sourceMiniappId: "live-artifacts",
        sourceId: "live-linear-board",
        eventType: "live-artifact.connector.refresh",
        idempotencyKey: "live-linear-board:linear-open-issues:run-1",
        traceId: "trace-live-artifacts-cross-app",
        workspaceSlug: "atlas",
        pluginId: "linear-composio",
        action: {
          type: "linear.list.issues",
          query: "status:open",
        },
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/v1/broker/composio/execute",
      headers: {
        authorization: "Bearer marketplace-service-token",
        "x-trace-id": "trace-live-artifacts-cross-app",
      },
      payload: {
        contractVersion: "doppelganger.cross-app.marketplace.broker-execute.v1",
        sourceMiniappId: "live-artifacts",
        sourceId: "live-linear-board",
        eventType: "live-artifact.connector.refresh",
        idempotencyKey: "live-linear-board:linear-open-issues:run-1",
        traceId: "trace-live-artifacts-cross-app",
        workspaceSlug: "atlas",
        pluginId: "linear-composio",
        action: {
          type: "linear.list.issues",
          query: "status:open",
        },
        metadata: {
          dataSourceId: "linear-open-issues",
        },
      },
    });
    expect(executeResponse.statusCode).toBe(200);
    expect(executeResponse.json()).toMatchObject({
      ok: true,
      crossApp: {
        contractVersion: "doppelganger.cross-app.marketplace.broker-execute.v1",
        sourceMiniappId: "live-artifacts",
        sourceId: "live-linear-board",
        idempotencyKey: "live-linear-board:linear-open-issues:run-1",
      },
      broker: {
        requesterMiniappId: "live-artifacts",
        pluginId: "linear-composio",
        actionKey: "linear.list.issues",
        rawSecretReturned: false,
      },
      result: {
        simulated: false,
        summary: "Executed LINEAR_LIST_ISSUES through Composio.",
      },
    });
    expect(JSON.stringify(executeResponse.json())).not.toContain(
      "test-composio-key",
    );
    const crossAppRulesCalls = rulesCalls.filter((call) =>
      ["broker.grant", "execute"].includes(String(call.operation)),
    );
    expect(crossAppRulesCalls.map((call) => call.operation)).toEqual([
      "broker.grant",
      "execute",
    ]);
    expect(crossAppRulesCalls[0]).toMatchObject({
      actorId: "marketplace-service",
      payload: {
        requesterMiniappId: "live-artifacts",
        idempotencyKey: "live-linear-board:linear-open-issues:run-1",
      },
    });
    expect(composioExecutions).toEqual([
      expect.objectContaining({
        connected_account_id: "ca_linear",
        arguments: {
          query: "status:open",
        },
      }),
    ]);

    await app.close();
    store.close();
  });

  it("builds plugin cards and honors action-level tool selection", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      env: { COMPOSIO_API_KEY: "test-composio-key" },
      providerFetch: async (input) => {
        const url = String(input);
        if (url.includes("/tools?")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  name: "LINEAR_LIST_ISSUES",
                  description: "List Linear issues.",
                },
                {
                  name: "LINEAR_CREATE_ISSUE",
                  description: "Create a Linear issue.",
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    const toolsResponse = await app.inject({
      method: "GET",
      url: "/api/marketplace/catalog/composio/tools?toolkit=linear",
    });
    expect(toolsResponse.statusCode).toBe(200);
    expect(toolsResponse.json()).toMatchObject({
      toolkit: "linear",
      tools: expect.arrayContaining([
        expect.objectContaining({ action: "linear.create.issue" }),
        expect.objectContaining({ action: "linear.list.issues" }),
      ]),
      skills: [
        expect.objectContaining({
          skillId: "linear",
          requiresConnectors: ["linear"],
        }),
      ],
    });

    const importResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
        toolkit: "linear",
        pluginId: "linear-composio",
        actionKeys: ["linear.list.issues"],
        autoEnable: true,
      },
    });
    expect(importResponse.statusCode).toBe(201);
    expect(importResponse.json()).toMatchObject({
      listing: {
        actions: ["linear.list.issues"],
        manifest: {
          skills: [
            expect.objectContaining({
              skillId: "linear",
            }),
          ],
        },
      },
      actionBindings: [
        expect.objectContaining({
          actionKey: "linear.list.issues",
          enabled: true,
        }),
      ],
    });

    store.upsertConnection({
      workspaceSlug: "atlas",
      pluginId: "linear-composio",
      provider: "linear",
      backend: "composio",
      state: "connected",
      detail: "Test connected account",
      metadata: { connectedAccountId: "ca_linear" },
    });

    const cardsResponse = await app.inject({
      method: "GET",
      url: "/api/marketplace/cards?workspaceSlug=atlas",
    });
    expect(cardsResponse.statusCode).toBe(200);
    expect(cardsResponse.json()).toMatchObject({
      cards: expect.arrayContaining([
        expect.objectContaining({
          addon: expect.objectContaining({ pluginId: "linear-composio" }),
          state: expect.objectContaining({ status: "ready", ready: true }),
          installPlan: expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                kind: "app-connect",
                status: "complete",
              }),
              expect.objectContaining({
                kind: "ui-promotion",
                status: "complete",
              }),
            ]),
          }),
          toolSelection: expect.objectContaining({
            total: 1,
            enabled: 1,
            actions: [
              expect.objectContaining({
                actionKey: "linear.list.issues",
                enabled: true,
              }),
            ],
          }),
        }),
      ]),
    });

    const disableResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/linear-composio/action-binding",
      payload: {
        workspaceSlug: "atlas",
        actionKey: "linear.list.issues",
        enabled: false,
      },
    });
    expect(disableResponse.statusCode).toBe(201);

    const capabilitiesResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });
    expect(capabilitiesResponse.statusCode).toBe(200);
    expect(capabilitiesResponse.json()).toMatchObject({ capabilities: [] });

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/linear-composio/execute",
      payload: {
        workspaceSlug: "atlas",
        actorId: "agent-smoke",
        capability: "connector.observe",
        action: { type: "linear.list.issues" },
      },
    });
    expect(executeResponse.statusCode).toBe(403);
    expect(executeResponse.json()).toMatchObject({
      error: "connector_action_denied",
    });

    await app.close();
    store.close();
  });

  it("never records simulated native execution as successful usage", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      rulesClient: async () => ({
        effect: "allow",
        decisionId: "rules-allow-test",
      }),
    });

    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/install",
      payload: {
        workspaceSlug: "atlas",
        actorId: "operator",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/capability-binding",
      payload: {
        workspaceSlug: "atlas",
        capability: "connector.observe",
        enabled: true,
      },
    });

    const executeResponse = await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/execute",
      payload: {
        workspaceSlug: "atlas",
        capability: "connector.observe",
        action: {
          type: "github.repositories.list",
          owner: "Tealbrick",
        },
        runId: "run-unsupported",
        sessionId: "session-test",
      },
    });
    expect(executeResponse.statusCode).toBe(501);
    expect(executeResponse.json()).toMatchObject({
      ok: false,
      error: "connector_execution_not_supported",
      executionOwner: "native",
      supportedExecutionOwners: ["composio", "mcp", "openapi"],
    });

    const ledgerResponse = await app.inject({
      method: "GET",
      url: "/api/marketplace/audit?workspaceSlug=atlas",
    });
    expect(ledgerResponse.statusCode).toBe(200);
    expect(ledgerResponse.json<{ usage: unknown[] }>().usage).toHaveLength(0);

    const candidates = scanConnectorPromotionCandidates(
      store.listUsage({ workspaceSlug: "atlas" }),
      {
        threshold: 3,
      },
    );
    expect(candidates).toEqual([]);

    await app.close();
    store.close();
  });

  it("keeps unsupported native connectors out of the Agent tool projection", async () => {
    const store = new SqliteMarketplaceStore(await tempDbPath());
    const app = await buildMarketplaceApp({
      store,
      rulesClient: async () => ({ effect: "allow", decisionId: "rules-allow-test" }),
    });

    const discoveryResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });
    expect(discoveryResponse.statusCode).toBe(200);
    expect(discoveryResponse.json()).toMatchObject({ capabilities: [] });

    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/register",
      payload: { workspaceSlug: "atlas", actorId: "agent-smoke" },
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/install",
      payload: { workspaceSlug: "atlas", actorId: "agent-smoke" },
    });
    await app.inject({
      method: "POST",
      url: "/api/marketplace/plugins/github-native/capability-binding",
      payload: {
        workspaceSlug: "atlas",
        capability: "connector.observe",
        enabled: true,
      },
    });

    const boundCapabilitiesResponse = await app.inject({
      method: "GET",
      url: "/api/agent/capabilities?workspaceSlug=atlas",
    });
    expect(
      boundCapabilitiesResponse.json<{ capabilities: unknown[] }>()
        .capabilities,
    ).toHaveLength(0);

    const deniedResponse = await app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.repositories.list",
      headers: { "x-trace-id": "execute-denied" },
      payload: {
        workspaceSlug: "atlas",
        actorId: "agent-smoke",
        pluginId: "github-native",
        input: { owner: "Tealbrick" },
      },
    });
    expect(deniedResponse.statusCode).toBe(404);
    expect(deniedResponse.json()).toMatchObject({
      ok: false,
      error: "agent_tool_not_available",
    });

    const allowedResponse = await app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.github.repositories.list",
      headers: { "x-trace-id": "execute-allowed" },
      payload: {
        workspaceSlug: "atlas",
        actorId: "agent-smoke",
        pluginId: "github-native",
        input: { owner: "Tealbrick" },
      },
    });
    expect(allowedResponse.statusCode).toBe(404);
    expect(allowedResponse.json()).toMatchObject({
      ok: false,
      error: "agent_tool_not_available",
    });

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/api/debug/events?workspaceSlug=atlas",
    });
    const eventTypes = eventsResponse
      .json<{ events: Array<{ type: string }> }>()
      .events.map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "marketplace.plugin.installed",
        "marketplace.capability.bound",
      ]),
    );

    await app.close();
    store.close();
  });
});

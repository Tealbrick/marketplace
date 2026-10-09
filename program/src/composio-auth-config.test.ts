import { describe, expect, it } from "vitest";

import {
  ComposioAuthConfigError,
  fetchComposioAuthConfigs,
  getOrCreateComposioAuthConfig,
  summarizeComposioAuthConfig,
} from "./provider-health.js";

const BASE = "https://backend.composio.test/api/v3.1";
const SECRET = "oauth-client-secret-value";

type Call = { method: string; url: URL; body: unknown };

function mockComposio(routes: {
  byId?: Record<string, { status: number; body?: unknown }>;
  list?: unknown[];
  listStatus?: number;
  created?: unknown;
}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const idMatch = /\/auth_configs\/([^/]+)$/u.exec(url.pathname);
    if (method === "GET" && idMatch) {
      const route = routes.byId?.[decodeURIComponent(idMatch[1]!)] ?? { status: 404, body: { error: "not found" } };
      return new Response(JSON.stringify(route.body ?? {}), { status: route.status });
    }
    if (method === "GET" && url.pathname.endsWith("/auth_configs")) {
      return new Response(JSON.stringify({ items: routes.list ?? [] }), { status: routes.listStatus ?? 200 });
    }
    if (method === "POST" && url.pathname.endsWith("/auth_configs")) {
      return new Response(JSON.stringify(routes.created ?? { id: "ac_created" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, fetchImpl };
}

function config(input: {
  id: string;
  toolkit: string;
  managed: boolean | undefined;
  scheme?: string;
  status?: string;
}) {
  return {
    id: input.id,
    toolkit: { slug: input.toolkit },
    ...(input.managed === undefined ? {} : { is_composio_managed: input.managed }),
    auth_scheme: input.scheme ?? "OAUTH2",
    status: input.status ?? "ENABLED",
    credentials: { client_id: "client-id", client_secret: SECRET },
  };
}

const run = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof getOrCreateComposioAuthConfig>[0]> = {}) =>
  getOrCreateComposioAuthConfig({
    baseUrl: BASE,
    apiKey: "test-composio-key",
    toolkit: "github",
    fetchImpl,
    authSchemes: ["OAUTH2"],
    managedAuthSchemes: [],
    ...extra,
  });

describe("getOrCreateComposioAuthConfig lookup order", () => {
  it("1. uses a passed authConfigId after checking it belongs to the toolkit", async () => {
    const { calls, fetchImpl } = mockComposio({
      byId: { ac_passed: { status: 200, body: config({ id: "ac_passed", toolkit: "github", managed: false }) } },
      list: [config({ id: "ac_other_custom", toolkit: "github", managed: false })],
    });
    await expect(run(fetchImpl, { authConfigId: " ac_passed " })).resolves.toBe("ac_passed");
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(["GET /api/v3.1/auth_configs/ac_passed"]);
  });

  it("refuses a passed authConfigId for another toolkit with a clear 400 code", async () => {
    const { fetchImpl } = mockComposio({
      byId: { ac_slack: { status: 200, body: config({ id: "ac_slack", toolkit: "slack", managed: false }) } },
    });
    const error = await run(fetchImpl, { authConfigId: "ac_slack" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComposioAuthConfigError);
    expect(error).toMatchObject({ code: "composio_auth_config_toolkit_mismatch", statusCode: 400 });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("refuses unknown and disabled passed authConfigIds", async () => {
    const { fetchImpl } = mockComposio({
      byId: { ac_off: { status: 200, body: config({ id: "ac_off", toolkit: "github", managed: false, status: "DISABLED" }) } },
    });
    await expect(run(fetchImpl, { authConfigId: "ac_missing" })).rejects.toMatchObject({
      code: "composio_auth_config_not_found",
      statusCode: 400,
    });
    await expect(run(fetchImpl, { authConfigId: "ac_off" })).rejects.toMatchObject({
      code: "composio_auth_config_disabled",
      statusCode: 400,
    });
  });

  it("2. prefers an existing enabled custom config over a managed one, before throwing", async () => {
    const { calls, fetchImpl } = mockComposio({
      list: [
        config({ id: "ac_disabled_custom", toolkit: "github", managed: false, status: "DISABLED" }),
        config({ id: "ac_managed", toolkit: "github", managed: true }),
        config({ id: "ac_custom", toolkit: "github", managed: false }),
      ],
    });
    await expect(run(fetchImpl)).resolves.toBe("ac_custom");
    const lookup = calls.find((call) => call.method === "GET");
    expect(lookup?.url.searchParams.get("toolkit_slug")).toBe("github");
    expect(lookup?.url.searchParams.has("is_composio_managed")).toBe(false);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("skips custom configs for a scheme the toolkit does not support", async () => {
    const { fetchImpl } = mockComposio({
      list: [
        config({ id: "ac_key", toolkit: "github", managed: false, scheme: "API_KEY" }),
        config({ id: "ac_managed", toolkit: "github", managed: true }),
      ],
    });
    await expect(run(fetchImpl, { managedAuthSchemes: ["OAUTH2"] })).resolves.toBe("ac_managed");
  });

  it("3. reuses an existing managed config", async () => {
    const { calls, fetchImpl } = mockComposio({
      list: [config({ id: "ac_managed", toolkit: "gmail", managed: true })],
    });
    await expect(run(fetchImpl, { toolkit: "gmail", managedAuthSchemes: ["OAUTH2"] })).resolves.toBe("ac_managed");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("4. creates managed or custom configs as before when none exist", async () => {
    const managed = mockComposio({ list: [], created: { id: "ac_new_managed" } });
    await expect(run(managed.fetchImpl, { toolkit: "gmail", managedAuthSchemes: ["OAUTH2"] })).resolves.toBe("ac_new_managed");
    expect(managed.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      toolkit: { slug: "gmail" },
      auth_config: { type: "use_composio_managed_auth" },
    });

    const custom = mockComposio({ list: [], created: { auth_config: { id: "ac_new_custom" } } });
    await expect(run(custom.fetchImpl, { toolkit: "linear", authSchemes: ["OAUTH2", "API_KEY"] })).resolves.toBe("ac_new_custom");
    expect(custom.calls.find((call) => call.method === "POST")?.body).toMatchObject({
      auth_config: { type: "use_custom_auth", authScheme: "API_KEY" },
    });
  });

  it("5. throws the same required-config error when nothing exists and nothing can be created", async () => {
    const { calls, fetchImpl } = mockComposio({ list: [config({ id: "ac_slack", toolkit: "slack", managed: false })] });
    await expect(run(fetchImpl)).rejects.toMatchObject({
      code: "composio_auth_config_required",
      message: "Composio toolkit github requires custom OAUTH2 configuration before it can be connected.",
    });
    // The lookup happens before the error, and nothing is created.
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("keeps rejecting no-auth toolkits with a typed error", async () => {
    const { fetchImpl } = mockComposio({});
    await expect(run(fetchImpl, { noAuth: true })).rejects.toMatchObject({ code: "composio_toolkit_no_auth" });
  });
});

describe("Composio auth-config summaries", () => {
  it("never carries credentials", async () => {
    const summary = summarizeComposioAuthConfig(config({ id: "ac_1", toolkit: "github", managed: false }));
    expect(summary).toEqual({ id: "ac_1", toolkit: "github", authScheme: "OAUTH2", composioManaged: false, enabled: true });
    expect(JSON.stringify(summary)).not.toContain(SECRET);

    const { fetchImpl } = mockComposio({ list: [config({ id: "ac_1", toolkit: "github", managed: false })] });
    const listed = await fetchComposioAuthConfigs({ COMPOSIO_API_KEY: "k", COMPOSIO_BASE_URL: BASE }, fetchImpl);
    expect(listed).toEqual([summary]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });
});

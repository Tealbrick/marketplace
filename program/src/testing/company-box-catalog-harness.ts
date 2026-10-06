/**
 * Shared harness for the shipped Company Box catalog tests: the per-entry
 * expectations, a spec operation counter, and the agent-path suite that drives
 * every exposed operation of an entry through the real Marketplace app against
 * a fake REST server. Each entry has its own `company-box-agent-<id>.test.ts`
 * file so vitest runs the big ones in parallel workers.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildMarketplaceApp } from "../app.js";
import { DEFAULT_COMPANY_BOX_CATALOG_DIR, loadCompanyBoxCatalog, type CompiledOpenApiEntry } from "../company-box.js";
import { applyMergePatch } from "../openapi-adapter.js";
import { compileArgumentValidator } from "../openapi-validate.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "../operator-auth.js";
import { SqliteMarketplaceStore } from "../store.js";
import type { RulesClient } from "../types.js";
import { startFakeRestServer, type FakeRestRequest } from "./fake-rest-server.js";

const ORIGIN = "http://127.0.0.1:5314";
const SERVICE_TOKEN = "marketplace-service-token-1234";
const SERVICE = { authorization: `Bearer ${SERVICE_TOKEN}` };
const AGENT = { ...SERVICE, "x-tealbrick-agent-token": "agent-1", "x-tealbrick-attachment": "attachment-1" };
const SECRET = "cb-catalog-secret-value-0001";
const USER = "api-user";
export const METHODS = ["get", "post", "put", "patch", "delete"] as const;


export type Expectation = {
  total: number;
  exposed: number;
  excluded: number;
  outward: number;
  reads: string[];
  exposure: "direct" | "discovery";
  auth: Record<string, unknown>;
  credentials: Record<string, string>;
  health: string;
  /** Header expected on every upstream call: [name, value]. */
  expectHeader: [string, string];
};

export const EXPECTED: Record<string, Expectation> = {
  authentik: {
    total: 1099,
    exposed: 1091,
    excluded: 8,
    outward: 43,
    reads: ["POST /admin/system/", "POST /stages/authenticator/duo/{stage_uuid}/enrollment_status/", "POST /stages/prompt/prompts/preview/"],
    exposure: "discovery",
    auth: { type: "header", name: "Authorization", prefix: "Bearer " },
    credentials: { token: SECRET },
    health: "core_users_me_retrieve",
    expectHeader: ["authorization", `Bearer ${SECRET}`],
  },
  changedetection: {
    total: 23,
    exposed: 23,
    excluded: 0,
    outward: 7,
    reads: [],
    exposure: "direct",
    auth: { type: "header", name: "x-api-key" },
    credentials: { token: SECRET },
    health: "getSystemInfo",
    expectHeader: ["x-api-key", SECRET],
  },
  chatwoot: {
    total: 450,
    exposed: 448,
    excluded: 2,
    outward: 58,
    reads: [
      "POST /api/v1/accounts/{account_id}/contact_inboxes/filter",
      "POST /api/v1/accounts/{account_id}/contacts/filter",
      "POST /api/v1/accounts/{account_id}/conversations/filter",
    ],
    exposure: "discovery",
    auth: { type: "header", name: "api_access_token" },
    credentials: { token: SECRET },
    health: "fetchProfile",
    expectHeader: ["api_access_token", SECRET],
  },
  documenso: {
    total: 89,
    exposed: 89,
    excluded: 0,
    outward: 11,
    reads: ["POST /document/get-many", "POST /embedding/verify-presign-token", "POST /envelope/get-many", "POST /template/get-many"],
    exposure: "discovery",
    auth: { type: "header", name: "Authorization" },
    credentials: { token: SECRET },
    health: "folder-findFolders",
    expectHeader: ["authorization", SECRET],
  },
  forgejo: {
    total: 469,
    exposed: 459,
    excluded: 10,
    outward: 21,
    reads: ["POST /markdown", "POST /markdown/raw", "POST /markup"],
    exposure: "discovery",
    auth: { type: "header", name: "Authorization", prefix: "token " },
    credentials: { token: SECRET },
    health: "getVersion",
    expectHeader: ["authorization", `token ${SECRET}`],
  },
  glitchtip: {
    total: 175,
    exposed: 175,
    excluded: 0,
    outward: 20,
    reads: [],
    exposure: "discovery",
    auth: { type: "header", name: "Authorization", prefix: "Bearer " },
    credentials: { token: SECRET },
    health: "apps_organizations_ext_api_list_organizations",
    expectHeader: ["authorization", `Bearer ${SECRET}`],
  },
  easyappointments: {
    total: 59,
    exposed: 51,
    excluded: 8,
    outward: 5,
    reads: [],
    exposure: "direct",
    auth: { type: "header", name: "Authorization", prefix: "Bearer " },
    credentials: { token: SECRET },
    health: "GET /services",
    expectHeader: ["authorization", `Bearer ${SECRET}`],
  },
  formbricks: {
    total: 113,
    exposed: 108,
    excluded: 5,
    outward: 25,
    reads: ["POST /api/v3/surveys/validate", "POST /api/v3/workflows/{workflowId}/test", "POST /api/v3/feedbackRecords/search/semantic"],
    exposure: "discovery",
    auth: { type: "header", name: "x-api-key" },
    credentials: { token: SECRET },
    health: "me",
    expectHeader: ["x-api-key", SECRET],
  },
  listmonk: {
    total: 107,
    exposed: 104,
    excluded: 3,
    outward: 9,
    reads: ["POST /api/campaigns/{id}/preview", "POST /api/campaigns/{id}/preview/archive", "POST /api/campaigns/{id}/text", "POST /api/templates/preview"],
    exposure: "discovery",
    auth: { type: "basic" },
    credentials: { username: USER, password: SECRET },
    health: "getAboutInfo",
    expectHeader: ["authorization", `Basic ${Buffer.from(`${USER}:${SECRET}`).toString("base64")}`],
  },
  postiz: {
    total: 31,
    exposed: 31,
    excluded: 0,
    outward: 13,
    reads: [],
    exposure: "direct",
    auth: { type: "header", name: "Authorization" },
    credentials: { token: SECRET },
    health: "PublicIntegrationsController_getActiveIntegrations",
    expectHeader: ["authorization", SECRET],
  },
  pretix: {
    total: 370,
    exposed: 370,
    excluded: 0,
    outward: 53,
    reads: ["POST /api/v1/organizers/{organizer}/events/{event}/exporters/{identifier}/run/", "POST /api/v1/organizers/{organizer}/events/{event}/orderpositions/{id}/price_calc/", "POST /api/v1/organizers/{organizer}/events/{event}/shredders/export/", "POST /api/v1/organizers/{organizer}/events/{event}/ticketpdfrenderer/render_batch/", "POST /api/v1/organizers/{organizer}/exporters/{identifier}/run/"],
    exposure: "discovery",
    auth: { type: "header", name: "Authorization", prefix: "Token " },
    credentials: { token: SECRET },
    health: "version.get",
    expectHeader: ["authorization", `Token ${SECRET}`],
  },
};

/**
 * Operations in the pinned spec after its overlay (the same document the
 * engine compiles): every path x method.
 */
export function specOperationCount(id: string) {
  const dir = path.join(DEFAULT_COMPANY_BOX_CATALOG_DIR, id);
  const entry = JSON.parse(readFileSync(path.join(dir, "entry.json"), "utf8")) as {
    openapi: { spec: string; overlay?: { file: string } };
  };
  let spec: unknown = JSON.parse(readFileSync(path.join(dir, entry.openapi.spec), "utf8"));
  if (entry.openapi.overlay) {
    spec = applyMergePatch(spec, JSON.parse(readFileSync(path.join(dir, entry.openapi.overlay.file), "utf8")));
  }
  const paths = (spec as { paths: Record<string, Record<string, unknown>> }).paths;
  return Object.values(paths).reduce((sum, item) => sum + METHODS.filter((method) => item[method]).length, 0);
}

/** Raw (pre-overlay) operation count of the vendored file. */
export function rawSpecOperationCount(id: string, specFile = "openapi.json") {
  const spec = JSON.parse(readFileSync(path.join(DEFAULT_COMPANY_BOX_CATALOG_DIR, id, specFile), "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.values(spec.paths).reduce((sum, item) => sum + METHODS.filter((method) => item[method]).length, 0);
}

// ---------------------------------------------------------------------------
// Agent path against the fake REST server.
// ---------------------------------------------------------------------------

type JsonSchemaLike = Record<string, unknown>;

function isRecord(value: unknown): value is JsonSchemaLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` satisfies `schema` under the engine's own argument validator. */
function satisfies(schema: unknown, value: unknown, defs: Record<string, unknown>) {
  try {
    return compileArgumentValidator({ ...(schema as JsonSchemaLike), $defs: defs } as never)(value as never).ok;
  } catch {
    return false;
  }
}

/** A short string that satisfies `schema.pattern` (and its length bounds), trying a few shapes patterns commonly describe. */
function stringMatching(schema: JsonSchemaLike, fallback: string) {
  let pattern: RegExp;
  try {
    pattern = new RegExp(String(schema.pattern), "u");
  } catch {
    return fallback;
  }
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : Number.POSITIVE_INFINITY;
  const candidates = [
    fallback,
    "person@example.test",
    "https://example.test/x",
    "2026-10-06",
    ...[1, 2, 8, 16, 24, 32, 36, 40, 64].map((length) => "7".repeat(length)),
    ...[2, 8, 16, 32, 40, 64].map((length) => "a".repeat(length)),
    "a-b",
    "my-slug",
  ];
  return candidates.find((candidate) => candidate.length >= min && candidate.length <= max && pattern.test(candidate)) ?? fallback;
}

/** Smallest value that satisfies a described schema (required members only). */
function synth(schema: unknown, defs: Record<string, unknown>, depth = 0): unknown {
  if (!isRecord(schema) || depth > 10) return {};
  if (typeof schema.$ref === "string") {
    return synth(defs[schema.$ref.replace(/^#\/\$defs\//u, "")], defs, depth + 1);
  }
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const parts: unknown[] = [];
  if (Array.isArray(schema.allOf)) parts.push(...schema.allOf.map((part) => synth(part, defs, depth + 1)));
  for (const key of ["oneOf", "anyOf"] as const) {
    const options = schema[key];
    if (!Array.isArray(options) || !options.length) continue;
    const candidates = options.map((option) => synth(option, defs, depth + 1));
    const index = candidates.findIndex((candidate, at) => satisfies(options[at], candidate, defs));
    parts.push(candidates[index >= 0 ? index : 0]);
  }
  const declared = Array.isArray(schema.type) ? schema.type.find((type) => type !== "null") : schema.type;
  const type = declared ?? (isRecord(schema.properties) ? "object" : parts.length ? undefined : undefined);
  let own: unknown;
  switch (type) {
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const names = [...required];
      const minProperties = typeof schema.minProperties === "number" ? schema.minProperties : 0;
      for (const name of Object.keys(properties)) {
        if (names.length >= minProperties) break;
        if (!names.includes(name)) names.push(name);
      }
      // File values ({base64, filename?, contentType?}) need strictly valid base64.
      own = Object.fromEntries(
        names.map((name) => [name, name === "base64" ? "aGVsbG8=" : synth(properties[name], defs, depth + 1)]),
      );
      break;
    }
    case "array": {
      const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
      own = Array.from({ length: Math.min(minItems, 2) }, () => synth(schema.items, defs, depth + 1));
      break;
    }
    case "integer":
    case "number": {
      const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
      const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;
      own = Math.min(Math.max(7, minimum ?? 7), maximum ?? Number.POSITIVE_INFINITY);
      break;
    }
    case "boolean":
      own = true;
      break;
    case "string": {
      switch (schema.format) {
        case "binary":
          own = "hello";
          break;
        case "date-time":
          own = "2026-10-06T00:00:00Z";
          break;
        case "date":
          own = "2026-10-06";
          break;
        case "email":
          own = "person@example.test";
          break;
        case "uri":
        case "url":
          own = "https://example.test/x";
          break;
        case "uuid":
          own = "00000000-0000-4000-8000-000000000001";
          break;
        default: {
          const minLength = typeof schema.minLength === "number" ? schema.minLength : 1;
          own = "7".padEnd(Math.max(minLength, 1), "x");
          if (typeof schema.maxLength === "number") own = (own as string).slice(0, schema.maxLength);
          if (typeof schema.pattern === "string") own = stringMatching(schema, own as string);
        }
      }
      break;
    }
    default:
      own = parts.length ? undefined : "7";
  }
  if (!parts.length) return own;
  const objects = [own, ...parts].filter(isRecord);
  return objects.length ? Object.assign({}, ...objects) : (parts[0] ?? own);
}

const RAW_SPECS = new Map<string, { paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { example?: unknown; examples?: Record<string, { value?: unknown }> }> } }>> }>();
function rawSpec(id: string) {
  if (!RAW_SPECS.has(id)) {
    RAW_SPECS.set(id, JSON.parse(readFileSync(path.join(DEFAULT_COMPANY_BOX_CATALOG_DIR, id, "openapi.json"), "utf8")));
  }
  return RAW_SPECS.get(id)!;
}

/** The first documented example body of an operation, when the spec has one. */
function exampleBody(id: string, operation: { method: string; path: string }) {
  const content = rawSpec(id).paths[operation.path]?.[operation.method]?.requestBody?.content ?? {};
  for (const media of Object.values(content)) {
    if (media.example !== undefined) return media.example;
    const first = Object.values(media.examples ?? {}).find((candidate) => candidate.value !== undefined);
    if (first) return first.value;
  }
  return undefined;
}

/** Minimal arguments for an operation; falls back to its documented example body for schemas too intricate to synthesize. */
function argumentsFor(id: string, operation: { method: string; path: string }, inputSchema: JsonSchemaLike) {
  const defs = isRecord(inputSchema.$defs) ? inputSchema.$defs : {};
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  const args: Record<string, unknown> = {};
  for (const group of ["path", "query", "header"] as const) {
    if (!required.includes(group)) continue;
    args[group] = synth(properties[group], defs);
  }
  if (required.includes("body")) {
    const body = properties.body;
    const contentType = isRecord(body) ? String(body["x-content-type"] ?? "") : "";
    let value = synth(body, defs);
    if (contentType.startsWith("application/x-www-form-urlencoded") && isRecord(value)) {
      value = Object.fromEntries(Object.entries(value).filter(([, child]) => typeof child !== "object"));
    }
    args.body = value;
  }
  if (!satisfies(inputSchema, args, defs) && required.includes("body")) {
    const example = exampleBody(id, operation);
    if (example !== undefined) args.body = example;
  }
  return args;
}

type CapabilityEntry = { toolName: string; actionType: string; pluginId: string; exposure?: string; operationCount?: number };

export async function fixture(id: string, mode: "allow" | "review" | "owner") {
  const expected = EXPECTED[id]!;
  const root = mkdtempSync(path.join(os.tmpdir(), "company-box-shipped-"));
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), { handoffEncryptionKey: "a".repeat(64) });
  const rest = await startFakeRestServer({
    authorize: (request: FakeRestRequest) => request.headers[expected.expectHeader[0]] === expected.expectHeader[1],
  });
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234" });
  const rulesCalls: Array<Parameters<RulesClient>[0]> = [];
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE_TOKEN,
    organizationId: "ws-a",
    operatorSessionManager: sessions,
    env: {},
    environment: { NODE_ENV: "test", MARKETPLACE_MCP_ALLOWED_ORIGINS: rest.origin },
    mcpFetch: (resource, init) => fetch(resource, init),
    companyBoxCatalogDir: DEFAULT_COMPANY_BOX_CATALOG_DIR,
    agentScopeVerifier: async ({ requiredCapability }) => ({
      organizationId: "ws-a",
      agentId: "agent-1",
      attachmentId: "attachment-1",
      capabilities: [requiredCapability],
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }),
    ...(mode === "owner"
      ? {}
      : {
          rulesClient: async (input: Parameters<RulesClient>[0]) => {
            rulesCalls.push(input);
            const outward = (input.payload.risk as { outward?: boolean } | undefined)?.outward;
            return mode === "review" && outward
              ? { effect: "review", decisionId: "rules-review" }
              : { effect: "allow", decisionId: "rules-allow" };
          },
        }),
  });
  const close = async () => {
    await app.close();
    store.close();
    await rest.close();
    rmSync(root, { recursive: true, force: true });
  };
  const { token, status } = sessions.issuePortalSession({ id: "operator-ws-a", organizationId: "ws-a" });
  const operator = {
    cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    origin: ORIGIN,
    "x-csrf-token": status.csrfToken!,
  };
  const inject = (method: "GET" | "POST" | "DELETE", url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  const plugin = `company-box-${id}`;
  const setup = await inject("POST", `/api/marketplace/company-box/${id}/setup`, operator, {
    baseUrl: rest.origin,
    credentials: expected.credentials,
  });
  expect(setup.statusCode, setup.body).toBe(200);
  expect(setup.json().entry).toMatchObject({ installed: true, connection: { state: "connected" } });
  const grants = new Map<string, string>();
  const grant = async (actionKey: string) => {
    const cached = grants.get(actionKey);
    if (cached) return cached;
    const response = await inject("POST", "/api/marketplace/agent/grants", AGENT, {
      workspaceSlug: "ws-a",
      pluginId: plugin,
      actionKey,
      accountId: "connector",
      resourceKind: `${plugin}.connected-account`,
      resourceRef: "account:connector",
    });
    expect(response.statusCode, response.body).toBe(201);
    grants.set(actionKey, response.json().grant.id as string);
    return grants.get(actionKey)!;
  };
  const tool = (toolName: string, input: Record<string, unknown>, grantId?: string) =>
    inject("POST", `/api/agent/tools/${toolName}`, AGENT, {
      workspaceSlug: "ws-a",
      pluginId: plugin,
      input,
      ...(grantId ? { grantId } : {}),
    });
  const capabilities = (await inject("GET", "/api/agent/capabilities?workspaceSlug=ws-a", SERVICE)).json()
    .capabilities as CapabilityEntry[];
  const tools = capabilities.filter((entry) => entry.pluginId === plugin);
  const call = (key: string, args: Record<string, unknown>, grantId: string) =>
    expected.exposure === "discovery"
      ? tool(`marketplace.${plugin}.operations.call`, { operation: key, arguments: args }, grantId)
      : tool(tools.find((entry) => entry.actionType === key)!.toolName, args, grantId);
  return { inject, operator, plugin, rest, rulesCalls, grant, tool, call, tools, close };
}

function pathMatcher(compiled: CompiledOpenApiEntry, template: string) {
  const escaped = `${compiled.apiBasePath}${template}`
    .split(/\{[^}]+\}/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[^/]+");
  return new RegExp(`^${escaped}$`, "u");
}
/**
 * Registers the agent-path suite for one entry. Large entries are split over
 * several test files (`shardIndex` of `shardCount`) so vitest runs the slices
 * in separate workers; shard 0 also checks the tool surface, pagination, the
 * action catalog and the outward holds, and every shard calls its slice of the
 * exposed operations.
 */
export function registerAgentPathTests(id: string, shardIndex = 0, shardCount = 1) {
  describe(`agent path: ${id}${shardCount > 1 ? ` (shard ${shardIndex + 1}/${shardCount})` : ""}`, () => {
    const expected = EXPECTED[id]!;
    const compiled = loadCompanyBoxCatalog(DEFAULT_COMPANY_BOX_CATALOG_DIR).get(id) as CompiledOpenApiEntry;
    const allKeys = [...compiled.byKey.keys()].sort();
    const shard = shardIndex;
    const mine = allKeys.filter((_key, index) => index % shardCount === shardIndex);

    beforeAll(() => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterAll(() => {
      vi.restoreAllMocks();
    });

    it.concurrent(
      "reaches every exposed operation through the agent surface",
      async () => {
        const f = await fixture(id, "allow");
        try {
          const healthRequests = f.rest.requests.length;
          expect(f.rest.requests.at(-1)).toMatchObject({ method: "GET", path: expect.stringMatching(pathMatcher(compiled, compiled.healthOperation!.path)) });

          if (shard === 0) {
            if (expected.exposure === "discovery") {
              expect(f.tools.map((entry) => entry.toolName)).toEqual([
                `marketplace.${f.plugin}.operations.search`,
                `marketplace.${f.plugin}.operations.describe`,
                `marketplace.${f.plugin}.operations.call`,
                `marketplace.${f.plugin}.approvals.status`,
              ]);
              expect(f.tools[0]).toMatchObject({ exposure: "discovery", operationCount: expected.exposed });
            } else {
              expect(f.tools).toHaveLength(expected.exposed + 1);
              expect(f.tools.at(-1)?.toolName).toBe(`marketplace.${f.plugin}.approvals.status`);
              expect(f.tools.every((entry) => !entry.toolName.includes(".operations."))).toBe(true);
            }

            // Every operation is found through paginated search, with nothing dropped.
            const keys: string[] = [];
            const outwardFlagged = new Set<string>();
            let cursor: string | null = null;
            do {
              const page = await f.tool(`marketplace.${f.plugin}.operations.search`, { limit: 100, ...(cursor ? { cursor } : {}) });
              expect(page.statusCode, page.body).toBe(200);
              const body = page.json();
              expect(body.total).toBe(expected.exposed);
              for (const operation of body.operations as Array<{ key: string; outward?: boolean }>) {
                keys.push(operation.key);
                if (operation.outward) outwardFlagged.add(operation.key);
              }
              cursor = body.nextCursor;
            } while (cursor);
            expect(new Set(keys).size).toBe(expected.exposed);
            expect(outwardFlagged.size).toBe(expected.outward);
            expect([...keys].sort()).toEqual(allKeys);
            const actionCatalog = (await f.inject("GET", "/api/marketplace/v1/agent/action-catalog?workspaceSlug=ws-a", SERVICE)).json()
              .actions as Array<{ pluginId: string; actionKey: string }>;
            expect(actionCatalog.filter((entry) => entry.pluginId === f.plugin).map((entry) => entry.actionKey).sort()).toEqual(allKeys);
          }

          for (const key of mine) {
            const operation = compiled.byKey.get(key)!;
            const described = await f.tool(`marketplace.${f.plugin}.operations.describe`, { operation: key });
            expect(described.statusCode, `${key}: ${described.body}`).toBe(200);
            const inputSchema = described.json().operation.inputSchema as JsonSchemaLike;
            expect(inputSchema).toMatchObject({ type: "object" });
            const called = await f.call(key, argumentsFor(id, operation, inputSchema), await f.grant(key));
            expect(called.statusCode, `${key}: ${called.body}`).toBe(200);
            expect(called.json().result.details.operation.key).toBe(key);
            const seen = f.rest.requests.at(-1)!;
            expect(seen.method, key).toBe(operation.method.toUpperCase());
            expect(seen.path, key).toMatch(pathMatcher(compiled, operation.path));
            expect(seen.headers[expected.expectHeader[0]], key).toBe(expected.expectHeader[1]);
          }
          expect(f.rest.requests.length - healthRequests).toBe(mine.length);
          const outwardCalls = f.rulesCalls.filter(
            (call) => call.operation === "execute" && (call.payload.risk as { outward?: boolean } | undefined)?.outward && call.payload.phase === undefined,
          );
          expect(outwardCalls).toHaveLength(mine.filter((key) => compiled.byKey.get(key)!.outward).length);

          if (shard === 0) {
            // Excluded operations have no action and cannot be called.
            const missing =
              expected.exposure === "discovery"
                ? await f.call(`${f.plugin}.not-an-operation`, {}, await f.grant(allKeys[0]!))
                : await f.tool(`marketplace.${f.plugin}.not-an-operation`, {}, await f.grant(allKeys[0]!));
            expect(missing.statusCode).toBe(404);
          }
        } finally {
          await f.close();
        }
      },
      600_000,
    );

    for (const mode of shard === 0 ? (["review", "owner"] as const) : []) {
      it.concurrent(`holds every outward operation (${mode === "review" ? "Rules review" : "approval queue"})`, async () => {
        const f = await fixture(id, mode);
        try {
          const outward = compiled.operations.filter((operation) => operation.outward);
          expect(outward).toHaveLength(expected.outward);
          const before = f.rest.requests.length;
          let pending = 0;
          for (const operation of outward) {
            const described = await f.tool(`marketplace.${f.plugin}.operations.describe`, { operation: operation.key });
            expect(described.json().operation.risk).toMatchObject({ outward: true });
            const held = await f.call(operation.key, argumentsFor(id, operation, described.json().operation.inputSchema), await f.grant(operation.key));
            if (mode === "review") {
              expect(held.statusCode, `${operation.key}: ${held.body}`).toBe(409);
              expect(held.json()).toMatchObject({ error: "rules_review_required" });
            } else if (held.statusCode === 202) {
              expect(held.json()).toMatchObject({ ok: false, status: "approval_pending", approvalId: expect.any(String) });
              pending += 1;
            } else {
              // The per-agent approval queue is bounded; a full queue still refuses the call.
              expect(held.statusCode, `${operation.key}: ${held.body}`).toBe(429);
              expect(held.json()).toMatchObject({ error: "approval_queue_full" });
            }
          }
          if (mode === "owner") expect(pending).toBe(Math.min(outward.length, 50));
          expect(f.rest.requests.length).toBe(before);
          if (mode === "review") {
            const reviewed = f.rulesCalls.filter((call) => (call.payload.risk as { outward?: boolean } | undefined)?.outward);
            expect(reviewed).toHaveLength(expected.outward);
          }
        } finally {
          await f.close();
        }
      }, 600_000);
    }
  });
}

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { operationInputSchema, parseOpenApiDocument, type OpenApiOperation } from "./openapi-adapter.js";
import { compileArgumentValidator } from "./openapi-validate.js";
import { callOpenApiOperation, OpenApiCallError, type OpenApiAuth } from "./openapi-http.js";
import { startFakeRestServer, type FakeRestRequest, type FakeRestRoute } from "./testing/fake-rest-server.js";

const SECRET = "tok-fixture-secret-0001";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const notes = parseOpenApiDocument(
  JSON.parse(readFileSync(path.join(import.meta.dirname, "testing", "company-box", "notes", "openapi.json"), "utf8")),
);
const operation = (id: string) =>
  notes.operations.find((candidate) => candidate.operationId === id || candidate.ref === id)!;

async function server(routes: FakeRestRoute[] = [], authorize?: (request: FakeRestRequest) => boolean) {
  const fake = await startFakeRestServer({ routes, authorize });
  closers.push(fake.close);
  return fake;
}

function call(
  origin: string,
  target: Pick<OpenApiOperation, "method" | "path" | "parameters" | "requestBody">,
  args: Record<string, unknown>,
  extra: { auth?: OpenApiAuth; credentials?: Record<string, string>; maxResponseBytes?: number; maxBinaryBytes?: number; timeoutMs?: number } = {},
) {
  return callOpenApiOperation({
    baseUrl: `${origin}/prefix`,
    apiBasePath: "/api/v1",
    operation: target,
    args,
    auth: extra.auth ?? { type: "header", name: "Authorization", prefix: "Bearer " },
    credentials: extra.credentials ?? { token: SECRET },
    env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: origin },
    ...(extra.maxResponseBytes ? { maxResponseBytes: extra.maxResponseBytes } : {}),
    ...(extra.maxBinaryBytes ? { maxBinaryBytes: extra.maxBinaryBytes } : {}),
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
  });
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenApiCallError) return error;
    throw error;
  }
  throw new Error("expected failure");
}

describe("Company Box REST executor: parameter mapping", () => {
  it("maps path, query (arrays, user_id), header and JSON body", async () => {
    const fake = await server();
    const listed = await call(fake.origin, operation("listNotes"), {
      query: { limit: 5, tag: ["a", "b"], user_id: "u-1" },
      header: { "X-Request-Id": "req-1" },
    });
    expect(listed).toMatchObject({ status: 200, bodyKind: "json", headers: { "x-total-count": "1" } });
    const request = fake.requests.at(-1)!;
    expect(request.path).toBe("/prefix/api/v1/notes");
    expect(request.query).toEqual({ limit: ["5"], tag: ["a", "b"], user_id: ["u-1"] });
    expect(request.headers["x-request-id"]).toBe("req-1");
    expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);

    await call(fake.origin, operation("updateNote"), { path: { id: "a b?c" }, body: { title: "New" } });
    expect(fake.requests.at(-1)).toMatchObject({ method: "PATCH", path: "/prefix/api/v1/notes/a%20b%3Fc", body: '{"title":"New"}' });
    expect(fake.requests.at(-1)!.headers["content-type"]).toBe("application/json");
  });

  it("refuses undeclared, reserved and path-escaping arguments before sending", async () => {
    const fake = await server();
    for (const [target, args, field] of [
      ["getNote", { path: { id: ".." } }, "path.id"],
      ["getNote", { path: { id: "a/b" } }, "path.id"],
      ["getNote", { path: { id: "a\\b" } }, "path.id"],
      ["getNote", { path: { id: "a%2Fb" } }, "path.id"],
      ["getNote", { path: { id: "a%5cb" } }, "path.id"],
      ["getNote", { path: { id: "%2E%2e" } }, "path.id"],
      ["getNote", { path: { id: "." } }, "path.id"],
      ["getNote", { path: {} }, "path.id"],
      ["listNotes", { query: { nope: 1 } }, "query.nope"],
      ["listNotes", { limit: 1 }, "limit"],
      ["updateNote", { path: { id: "1" } }, "body"],
      ["getHealth", { body: { x: 1 } }, "body"],
    ] as const) {
      const error = await failure(call(fake.origin, operation(target), args as Record<string, unknown>));
      expect(error).toMatchObject({ code: "openapi_argument_invalid", detail: { field } });
    }
    const reserved = await failure(
      call(fake.origin, { method: "get", path: "/x", requestBody: null, parameters: [{ name: "Authorization", in: "header", required: false, schema: {} }] }, { header: { Authorization: "Bearer other" } }),
    );
    expect(reserved).toMatchObject({ code: "openapi_argument_invalid", detail: { field: "header.Authorization" } });
    expect(fake.requests).toHaveLength(0);
  });

  it("sends form bodies for form operations", async () => {
    const fake = await server();
    await call(
      fake.origin,
      {
        method: "post",
        path: "/res/{id}/publish",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, contentType: "application/x-www-form-urlencoded", contentTypes: [], schema: {} },
      },
      { path: { id: "7" }, body: { channel: "email" } },
    );
    expect(fake.requests.at(-1)).toMatchObject({ path: "/prefix/api/v1/res/7/publish", body: "channel=email" });
  });
});

describe("Company Box REST executor: credentials", () => {
  it("supports header, basic and query auth and scrubs echoed secrets", async () => {
    const echoSecret: FakeRestRoute = (request, response) => {
      if (!request.path.endsWith("/health")) return false;
      response.writeHead(200, { "content-type": "application/json", link: `<https://x/?api_key=${SECRET}>` });
      response.end(JSON.stringify({ seen: request.headers.authorization ?? request.query.api_key?.[0] ?? null }));
      return true;
    };
    const fake = await server([echoSecret]);
    const header = await call(fake.origin, operation("getHealth"), {});
    expect(JSON.stringify(header)).not.toContain(SECRET);
    expect(header.body).toEqual({ seen: "Bearer [redacted]" });

    const basic = await call(fake.origin, operation("getHealth"), {}, { auth: { type: "basic" }, credentials: { username: "ops", password: SECRET } });
    expect(fake.requests.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from(`ops:${SECRET}`).toString("base64")}`);
    expect(basic.body).toEqual({ seen: "Basic [redacted]" });

    const query = await call(fake.origin, operation("getHealth"), {}, { auth: { type: "query", name: "api_key" }, credentials: { apiKey: SECRET } });
    expect(fake.requests.at(-1)!.query).toEqual({ api_key: [SECRET] });
    expect(JSON.stringify(query)).not.toContain(SECRET);
    expect(query.headers.link).toBe("<https://x/?api_key=[redacted]>");

    const missing = await failure(call(fake.origin, operation("getHealth"), {}, { credentials: {} }));
    expect(missing.code).toBe("openapi_credentials_missing");
  });

  it("maps 401 to auth_rejected and returns a scrubbed, bounded error body", async () => {
    const fake = await server([
      (request, response) => {
        if (!request.path.endsWith("/notes")) return false;
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `bad token ${SECRET}`, pad: "x".repeat(10_000) }));
        return true;
      },
    ], (request) => request.headers.authorization === `Bearer ${SECRET}`);
    const rejected = await failure(call(fake.origin, operation("getHealth"), {}, { credentials: { token: "wrong-token" } }));
    expect(rejected).toMatchObject({ code: "openapi_auth_rejected", detail: { status: 401 } });
    const invalid = await failure(call(fake.origin, operation("listNotes"), {}));
    expect(invalid).toMatchObject({ code: "openapi_http_error", detail: { status: 422 } });
    expect(String(invalid.detail.body)).toContain("bad token [redacted]");
    expect(String(invalid.detail.body).length).toBeLessThanOrEqual(4_096);
    expect(invalid.message).not.toContain(SECRET);
  });
});

describe("Company Box REST executor: response handling and limits", () => {
  it("returns binary as base64 within the cap and refuses oversized bodies", async () => {
    const fake = await server([
      (request, response) => {
        if (request.path.endsWith("/attachment")) {
          response.writeHead(200, { "content-type": "application/octet-stream" });
          response.end(Buffer.from([0, 1, 2, 255]));
          return true;
        }
        if (request.path.endsWith("/folders")) {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("y".repeat(5_000));
          return true;
        }
        return false;
      },
    ]);
    const binary = await call(fake.origin, operation("GET /notes/{id}/attachment"), { path: { id: "1" } });
    expect(binary).toMatchObject({ bodyKind: "binary", base64: "AAEC/w==", bytes: 4 });
    const binaryTooLarge = await failure(call(fake.origin, operation("GET /notes/{id}/attachment"), { path: { id: "1" } }, { maxBinaryBytes: 2 }));
    expect(binaryTooLarge.code).toBe("openapi_response_too_large");
    const text = await call(fake.origin, operation("listFolders"), {});
    expect(text).toMatchObject({ bodyKind: "text" });
    const tooLarge = await failure(call(fake.origin, operation("listFolders"), {}, { maxResponseBytes: 1_000 }));
    expect(tooLarge.code).toBe("openapi_response_too_large");
  });

  it("never follows redirects and times out slow apps", async () => {
    const fake = await server([
      (request, response) => {
        if (request.path.endsWith("/health")) {
          response.writeHead(302, { location: "https://elsewhere.example/steal" });
          response.end();
          return true;
        }
        if (request.path.endsWith("/folders")) {
          setTimeout(() => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
          }, 500);
          return true;
        }
        return false;
      },
    ]);
    const redirected = await failure(call(fake.origin, operation("getHealth"), {}));
    expect(redirected.code).toBe("openapi_unreachable");
    expect(fake.requests).toHaveLength(1);
    const slow = await failure(call(fake.origin, operation("listFolders"), {}, { timeoutMs: 50 }));
    expect(slow.code).toBe("openapi_timeout");
  });

  it("enforces the outbound URL policy: tailnet allowed, private and metadata refused", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const base = {
      operation: operation("getHealth"),
      args: {},
      auth: { type: "none" } as const,
      credentials: {},
      fetchImpl,
      env: {},
    };
    await callOpenApiOperation({ ...base, baseUrl: "https://notes.tail1234.ts.net", lookup: async () => [{ address: "100.101.102.103", family: 4 }] });
    await callOpenApiOperation({ ...base, baseUrl: "https://100.64.0.7/notes" });
    expect(seen).toEqual(["https://notes.tail1234.ts.net/health", "https://100.64.0.7/notes/health"]);
    for (const [baseUrl, lookup, reason] of [
      ["http://notes.tail1234.ts.net", undefined, "scheme_not_https"],
      ["https://169.254.169.254", undefined, "address_not_allowed"],
      ["https://notes.internal", undefined, "hostname_not_allowed"],
      ["https://notes.example.com", async () => [{ address: "10.0.0.5", family: 4 }], "address_not_allowed"],
      ["https://notes.example.com/?key=1", undefined, "query_not_allowed"],
    ] as const) {
      const error = await failure(callOpenApiOperation({ ...base, baseUrl, ...(lookup ? { lookup } : {}) }));
      expect(error).toMatchObject({ code: "openapi_base_url_not_allowed", detail: { reason } });
    }
    expect(seen).toHaveLength(2);
  });
});

describe("Company Box REST executor: review hardening", () => {
  const SLASHED = "tok/fixture+secret==0002";

  it("scrubs JSON-escaped, URL-encoded and base64 forms from success and error bodies, before truncation", async () => {
    const forms = [
      SLASHED,
      SLASHED.replace(/\//gu, "\\/"),
      encodeURIComponent(SLASHED),
      Buffer.from(SLASHED).toString("base64"),
      Buffer.from(SLASHED).toString("base64url"),
    ];
    const fake = await server([
      (request, response) => {
        if (request.path.endsWith("/health")) {
          // Raw JSON text with a \/-escaped echo, plus encoded variants.
          response.writeHead(200, { "content-type": "application/json" });
          response.end(`{"echo":"${SLASHED.replace(/\//gu, "\\/")}","u":"${encodeURIComponent(SLASHED)}","b":"${Buffer.from(SLASHED).toString("base64")}","b2":"${Buffer.from(SLASHED).toString("base64url")}","unicode":"\\u0074${SLASHED.slice(1).replace(/\//gu, "\\/")}"}`);
          return true;
        }
        if (request.path.endsWith("/notes")) {
          response.writeHead(400, { "content-type": "application/json" });
          // The echo sits past the 4 KB mark: scrubbing must happen before truncation.
          response.end(`{"pad":"${"x".repeat(4_090)}","echo":"${SLASHED.replace(/\//gu, "\\/")}"}`);
          return true;
        }
        return false;
      },
    ]);
    const ok = await call(fake.origin, operation("getHealth"), {}, { credentials: { token: SLASHED } });
    const okText = JSON.stringify(ok);
    for (const form of forms) expect(okText).not.toContain(form);
    expect(ok.body).toMatchObject({ echo: "[redacted]", unicode: "[redacted]" });
    const failed = await failure(call(fake.origin, operation("listNotes"), {}, { credentials: { token: SLASHED } }));
    const failedText = JSON.stringify(failed.detail);
    for (const form of forms) expect(failedText).not.toContain(form);
    expect(String(failed.detail.body).length).toBeLessThanOrEqual(4_096);
  });

  it("validates arguments against the operation schema before any request", async () => {
    const fake = await server();
    const list = operation("listNotes");
    const validateArguments = compileArgumentValidator(operationInputSchema(list, notes.defs));
    for (const [args, field] of [
      [{ query: { limit: "5" } }, "query.limit"],
      [{ query: { limit: 500 } }, "query.limit"],
      [{ query: { tag: "one" } }, "query.tag"],
    ] as const) {
      const error = await failure(callOpenApiOperation({ baseUrl: fake.origin, operation: list, args, auth: { type: "none" }, credentials: {}, env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: fake.origin }, validateArguments }));
      expect(error).toMatchObject({ code: "openapi_argument_invalid", detail: { field } });
    }
    const create = operation("createNote");
    const createValidator = compileArgumentValidator(operationInputSchema(create, notes.defs));
    const missing = await failure(callOpenApiOperation({ baseUrl: fake.origin, operation: create, args: { body: { body: "no title" } }, auth: { type: "none" }, credentials: {}, env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: fake.origin }, validateArguments: createValidator }));
    expect(missing).toMatchObject({ code: "openapi_argument_invalid", detail: { field: "body.title" } });
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses method-override and credential parameter names, and explodes only declared object keys", async () => {
    const fake = await server();
    const target = {
      method: "get" as const,
      path: "/x",
      requestBody: null,
      parameters: [
        { name: "_method", in: "query" as const, required: false, schema: { type: "string" } },
        { name: "API_KEY", in: "query" as const, required: false, schema: { type: "string" } },
        { name: "X-HTTP-Method-Override", in: "header" as const, required: false, schema: { type: "string" } },
        { name: "filter", in: "query" as const, required: false, schema: { type: "object", properties: { state: { type: "string" } } } },
        { name: "q", in: "query" as const, required: false, schema: { type: "string" } },
      ],
    };
    const queryAuth = { auth: { type: "query" as const, name: "api_key" }, credentials: { apiKey: SECRET } };
    for (const [args, field] of [
      [{ query: { _method: "DELETE" } }, "query._method"],
      [{ query: { API_KEY: "other" } }, "query.API_KEY"],
      [{ header: { "X-HTTP-Method-Override": "DELETE" } }, "header.X-HTTP-Method-Override"],
      [{ query: { filter: { api_key: "other" } } }, "query.filter.api_key"],
      [{ query: { filter: { _method: "x" } } }, "query.filter._method"],
      [{ query: { q: { state: "open" } } }, "query.q"],
    ] as const) {
      const error = await failure(call(fake.origin, target, args as Record<string, unknown>, queryAuth));
      expect(error).toMatchObject({ code: "openapi_argument_invalid", detail: { field } });
    }
    await call(fake.origin, target, { query: { filter: { state: "open" } } }, queryAuth);
    expect(fake.requests.at(-1)!.query).toEqual({ state: ["open"], api_key: [SECRET] });
  });
});

describe("Company Box REST executor: DNS pinning", () => {
  it("refuses a name that rebinds to a private address between the check and the connection", async () => {
    let calls = 0;
    const lookup = async () => {
      calls += 1;
      return [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    };
    const error = await failure(
      callOpenApiOperation({ baseUrl: "https://rebind.example.test", operation: operation("getHealth"), args: {}, auth: { type: "none" }, credentials: {}, env: {}, lookup, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("openapi_unreachable");
    expect(calls).toBe(2);
  });
});

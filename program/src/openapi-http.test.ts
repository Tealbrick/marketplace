import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpenApiDocument, type OpenApiOperation } from "./openapi-adapter.js";
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

    await call(fake.origin, operation("updateNote"), { path: { id: "a b/c" }, body: { title: "New" } });
    expect(fake.requests.at(-1)).toMatchObject({ method: "PATCH", path: "/prefix/api/v1/notes/a%20b%2Fc", body: '{"title":"New"}' });
    expect(fake.requests.at(-1)!.headers["content-type"]).toBe("application/json");
  });

  it("refuses undeclared, reserved and path-escaping arguments before sending", async () => {
    const fake = await server();
    for (const [target, args, field] of [
      ["getNote", { path: { id: ".." } }, "path.id"],
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

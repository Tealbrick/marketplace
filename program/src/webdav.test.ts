import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCompanyBoxCatalog, type CompiledOpenApiEntry } from "./company-box.js";
import { companyBoxCoverageReport } from "./company-box-coverage.js";
import { callOpenApiOperation, OpenApiCallError } from "./openapi-http.js";
import { startFakeRestServer, type FakeRestRoute } from "./testing/fake-rest-server.js";

const SECRET = "nc-app-password-fixture-0001";
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const FILE = "/remote.php/dav/files/{user}/{path}";
const xmlBody = { required: true, content: { "application/xml": { schema: { type: "string" } } } };
const destination = (template = "/remote.php/dav/files/{user}/{Destination}") => [
  { name: "Destination", in: "header", required: true, schema: { type: "string" }, "x-destination-template": template },
  { name: "Overwrite", in: "header", schema: { type: "string", default: "F" } },
];

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Nextcloud-like WebDAV", version: "30.0.0" },
  paths: {
    "/ocs/v2.php/cloud/capabilities": {
      get: {
        operationId: "getCapabilities",
        tags: ["ocs"],
        parameters: [{ name: "OCS-APIRequest", in: "header", required: true, schema: { type: "string", const: "true" } }],
        responses: { 200: { description: "ok" } },
      },
    },
    [FILE]: {
      parameters: [
        { name: "user", in: "path", required: true, schema: { type: "string" } },
        { name: "path", in: "path", required: true, "x-multi-segment": true, schema: { type: "string" } },
      ],
      get: { operationId: "downloadFile", tags: ["files"], responses: { 200: { description: "bytes" } } },
      put: { operationId: "uploadFile", tags: ["files"], requestBody: { content: { "application/octet-stream": {} } }, responses: { 201: { description: "ok" } } },
      delete: { operationId: "deleteFile", tags: ["files"], responses: { 204: { description: "ok" } } },
      "x-propfind": {
        operationId: "listFolder",
        tags: ["files"],
        parameters: [{ name: "Depth", in: "header", schema: { type: "string", default: "1" } }],
        requestBody: { content: { "application/xml": { schema: { type: "string" } } } },
        responses: { 207: { description: "multistatus" } },
      },
      "x-proppatch": { operationId: "setProperties", tags: ["files"], requestBody: xmlBody, responses: { 207: { description: "ok" } } },
      "x-mkcol": { operationId: "createFolder", tags: ["files"], responses: { 201: { description: "ok" } } },
      "x-move": { operationId: "moveFile", tags: ["files"], parameters: destination(), responses: { 201: { description: "ok" } } },
      "x-copy": { operationId: "copyFile", tags: ["files"], parameters: destination(), responses: { 201: { description: "ok" } } },
      "x-report": { operationId: "searchFiles", tags: ["files"], requestBody: xmlBody, responses: { 207: { description: "ok" } } },
      "x-lock": { operationId: "lockFile", tags: ["files"], requestBody: xmlBody, responses: { 200: { description: "ok" } } },
      "x-unlock": {
        operationId: "unlockFile",
        tags: ["files"],
        parameters: [{ name: "Lock-Token", in: "header", required: true, schema: { type: "string" } }],
        responses: { 204: { description: "ok" } },
      },
    },
  },
};

function entryDir(spec: unknown, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "company-box-dav-"));
  closers.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "nextcloud");
  mkdirSync(dir);
  const text = JSON.stringify(spec);
  writeFileSync(path.join(dir, "openapi.json"), text);
  writeFileSync(
    path.join(dir, "entry.json"),
    JSON.stringify({
      schema: 1,
      id: "nextcloud",
      displayName: "Nextcloud",
      description: "Fixture: Nextcloud-like WebDAV.",
      app: { version: "30.0.0" },
      source: "openapi",
      openapi: { spec: "openapi.json", sha256: createHash("sha256").update(text).digest("hex") },
      auth: { type: "basic" },
      healthOperation: "getCapabilities",
      ...extra,
    }),
  );
  return root;
}

function compiled(spec: unknown = SPEC) {
  const entry = loadCompanyBoxCatalog(entryDir(spec)).get("nextcloud") as CompiledOpenApiEntry;
  expect(entry.errors).toEqual([]);
  return entry;
}

const multistatus = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/alice/Documents/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

async function davServer() {
  const routes: FakeRestRoute[] = [
    (request, response) => {
      if (request.method !== "PROPFIND" && request.method !== "REPORT") return false;
      response.writeHead(207, { "content-type": "application/xml; charset=utf-8" });
      response.end(multistatus);
      return true;
    },
  ];
  const server = await startFakeRestServer({
    routes,
    authorize: (request) => request.headers.authorization === `Basic ${Buffer.from(`alice:${SECRET}`).toString("base64")}`,
  });
  closers.push(server.close);
  return server;
}

function caller(entry: CompiledOpenApiEntry, origin: string, baseUrl = origin) {
  return (key: string, args: Record<string, unknown>) => {
    const operation = entry.byKey.get(`company-box-nextcloud.${key}`)!;
    return callOpenApiOperation({
      baseUrl,
      apiBasePath: entry.apiBasePath,
      operation: operation.operation,
      args,
      auth: { type: "basic" },
      credentials: { username: "alice", password: SECRET },
      env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: origin },
      validateArguments: operation.validateArguments,
    });
  };
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

describe("WebDAV operations", () => {
  it("parses x-<method> operations, classifies them and covers every one", () => {
    const entry = compiled();
    const byKey = Object.fromEntries(entry.operations.map((operation) => [operation.key.split(".")[1], [operation.method.toUpperCase(), operation.capability]]));
    expect(byKey).toEqual({
      "get-capabilities": ["GET", "connector.observe"],
      "download-file": ["GET", "connector.observe"],
      "upload-file": ["PUT", "connector.dispatch"],
      "delete-file": ["DELETE", "connector.admin"],
      "list-folder": ["PROPFIND", "connector.observe"],
      "set-properties": ["PROPPATCH", "connector.dispatch"],
      "create-folder": ["MKCOL", "connector.dispatch"],
      "move-file": ["MOVE", "connector.admin"],
      "copy-file": ["COPY", "connector.admin"],
      "search-files": ["REPORT", "connector.observe"],
      "lock-file": ["LOCK", "connector.dispatch"],
      "unlock-file": ["UNLOCK", "connector.dispatch"],
    });
    // Without operationIds, keys come from the WebDAV method.
    const anonymous = JSON.parse(JSON.stringify(SPEC));
    delete anonymous.paths[FILE]["x-mkcol"].operationId;
    expect(compiled(anonymous).byKey.has("company-box-nextcloud.mkcol-remote-php-dav-files-by-user-by-path")).toBe(true);
    const report = companyBoxCoverageReport(entryDir(SPEC));
    expect(report.entries[0]).toMatchObject({ ok: true, total: 12, exposed: 12 });
    expect(report.entries[0]!.items.map((item) => item.method)).toEqual(expect.arrayContaining(["PROPFIND", "PROPPATCH", "MKCOL", "MOVE", "COPY", "REPORT", "LOCK", "UNLOCK"]));
  });

  it("sends each method to nested paths, with multistatus XML passed through", async () => {
    const entry = compiled();
    const server = await davServer();
    const call = caller(entry, server.origin);
    const nested = "/remote.php/dav/files/alice/Documents/Q3%20report/notes.md";
    for (const [key, method, args] of [
      ["download-file", "GET", {}],
      ["upload-file", "PUT", { body: { base64: Buffer.from("hello").toString("base64") } }],
      ["delete-file", "DELETE", {}],
      ["set-properties", "PROPPATCH", { body: "<d:propertyupdate xmlns:d=\"DAV:\"/>" }],
      ["create-folder", "MKCOL", {}],
      ["lock-file", "LOCK", { body: "<d:lockinfo xmlns:d=\"DAV:\"/>" }],
      ["unlock-file", "UNLOCK", { header: { "Lock-Token": "<opaquelocktoken:abc>" } }],
    ] as const) {
      const result = await call(key, { path: { user: "alice", path: "Documents/Q3 report/notes.md" }, ...args });
      expect(result.status).toBeLessThan(300);
      expect(server.requests.at(-1)).toMatchObject({ method, path: nested });
    }
    const listed = await call("list-folder", { path: { user: "alice", path: "/Documents/" }, body: "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>" });
    expect(listed).toMatchObject({ status: 207, bodyKind: "text", contentType: "application/xml; charset=utf-8", text: multistatus });
    expect(server.requests.at(-1)).toMatchObject({ method: "PROPFIND", path: "/remote.php/dav/files/alice/Documents" });
    expect(server.requests.at(-1)!.headers.depth).toBe("1");
    expect(server.requests.at(-1)!.headers["content-type"]).toBe("application/xml");
    const searched = await call("search-files", { path: { user: "alice", path: "Documents" }, body: "<d:searchrequest xmlns:d=\"DAV:\"/>" });
    expect(searched.status).toBe(207);
  });

  it("refuses traversal in multi-segment and single-segment path values", async () => {
    const entry = compiled();
    const server = await davServer();
    const call = caller(entry, server.origin);
    for (const [user, value] of [
      ["alice", "a/../b"],
      ["alice", "%2e%2e/etc"],
      ["alice", "a/%2E/b"],
      ["alice", "a//b"],
      ["alice", "a\\b"],
      ["alice", "a/b%2Fc"],
      ["alice", "a/b%5cc"],
      ["alice", "//"],
      ["al/ice", "notes.md"],
      ["..", "notes.md"],
    ] as const) {
      const error = await failure(call("download-file", { path: { user, path: value } }));
      expect(error, `${user} ${value}`).toMatchObject({ code: "openapi_argument_invalid" });
    }
    expect(server.requests).toHaveLength(0);
  });

  it("builds Destination from the configured origin and never lets it escape", async () => {
    const entry = compiled();
    const server = await davServer();
    const call = caller(entry, server.origin, `${server.origin}/nc`);
    await call("move-file", { path: { user: "alice", path: "Documents/a.md" }, header: { Destination: "Archive/2026/a b.md" } });
    const moved = server.requests.at(-1)!;
    expect(moved).toMatchObject({ method: "MOVE", path: "/nc/remote.php/dav/files/alice/Documents/a.md" });
    expect(moved.headers.destination).toBe(`${server.origin}/nc/remote.php/dav/files/alice/Archive/2026/a%20b.md`);
    expect(moved.headers.overwrite).toBe("F");
    await call("copy-file", { path: { user: "alice", path: "Documents/a.md" }, header: { Destination: "/Copies/a.md", Overwrite: "T" } });
    expect(server.requests.at(-1)!.headers).toMatchObject({ destination: `${server.origin}/nc/remote.php/dav/files/alice/Copies/a.md`, overwrite: "T" });
    const before = server.requests.length;
    for (const destinationValue of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "../../../../etc/passwd",
      "Archive/../../x",
      "Archive/%2e%2e/x",
      "Archive\\x",
      "Archive/%2fx",
    ]) {
      const error = await failure(call("move-file", { path: { user: "alice", path: "a.md" }, header: { Destination: destinationValue } }));
      expect(error, destinationValue).toMatchObject({ code: "openapi_argument_invalid", detail: { field: "header.Destination" } });
    }
    expect((await failure(call("move-file", { path: { user: "alice", path: "a.md" }, header: { Destination: "x", Overwrite: "yes" } }))).detail.field).toBe("header.Overwrite");
    expect(server.requests.length).toBe(before);
  });

  it("refuses a Destination header without a template at compile time", () => {
    const spec = JSON.parse(JSON.stringify(SPEC));
    delete spec.paths[FILE]["x-move"].parameters[0]["x-destination-template"];
    const entry = loadCompanyBoxCatalog(entryDir(spec)).get("nextcloud") as CompiledOpenApiEntry;
    expect(entry.coverage.find((item) => item.ref === "moveFile")).toMatchObject({ status: "failed", reason: expect.stringContaining("x-destination-template") });
  });
});

describe("header parameter defaults", () => {
  it("sends default and const headers the agent omitted, and accepts such a health operation", async () => {
    const entry = compiled();
    expect(entry.healthOperation?.ref).toBe("getCapabilities");
    const server = await davServer();
    const call = caller(entry, server.origin);
    expect((await call("get-capabilities", {})).status).toBe(200);
    expect(server.requests.at(-1)!.headers["ocs-apirequest"]).toBe("true");
    const wrong = await failure(call("get-capabilities", { header: { "OCS-APIRequest": "false" } }));
    expect(wrong).toMatchObject({ code: "openapi_argument_invalid", detail: { field: "header.OCS-APIRequest" } });
    await call("list-folder", { path: { user: "alice", path: "Documents" }, header: { Depth: "0" } });
    expect(server.requests.at(-1)!.headers.depth).toBe("0");
    const depth = await failure(call("list-folder", { path: { user: "alice", path: "Documents" }, header: { Depth: "2" } }));
    expect(depth.detail.field).toBe("header.Depth");
    // The schema agents see does not require defaulted headers.
    const schema = entry.byKey.get("company-box-nextcloud.get-capabilities")!.inputSchema;
    expect(schema.required).toEqual([]);
  });
});

describe("WebDAV review fixes", () => {
  function variant(mutate: (spec: typeof SPEC & { paths: Record<string, Record<string, Record<string, unknown>>> }) => void) {
    const spec = JSON.parse(JSON.stringify(SPEC));
    mutate(spec);
    return loadCompanyBoxCatalog(entryDir(spec)).get("nextcloud") as CompiledOpenApiEntry;
  }

  it("keeps COPY non-destructive only with Overwrite const F, and refuses Overwrite defaults other than F", () => {
    const fixed = variant((spec) => {
      (spec.paths[FILE]!["x-copy"]!.parameters as Array<Record<string, unknown>>)[1] = { name: "Overwrite", in: "header", schema: { type: "string", const: "F" } };
    });
    expect(fixed.byKey.get("company-box-nextcloud.copy-file")).toMatchObject({ capability: "connector.dispatch", destructive: false });
    const unsafe = variant((spec) => {
      (spec.paths[FILE]!["x-copy"]!.parameters as Array<Record<string, unknown>>)[1] = { name: "Overwrite", in: "header", schema: { type: "string", default: "T" } };
    });
    expect(unsafe.coverage.find((item) => item.ref === "copyFile")).toMatchObject({ status: "failed", reason: expect.stringContaining("Overwrite header default must be F") });
  });

  it("ignores and reports reads patterns on non-POST writes", () => {
    const root = entryDir(SPEC, { reads: ["moveFile", "PUT /remote.php/dav/files/{user}/{path}", "createFolder"] });
    const entry = loadCompanyBoxCatalog(root).get("nextcloud") as CompiledOpenApiEntry;
    expect(entry.byKey.get("company-box-nextcloud.move-file")).toMatchObject({ capability: "connector.admin" });
    expect(entry.byKey.get("company-box-nextcloud.upload-file")).toMatchObject({ capability: "connector.dispatch" });
    expect(entry.byKey.get("company-box-nextcloud.create-folder")).toMatchObject({ capability: "connector.dispatch" });
    expect(entry.warnings).toEqual(
      expect.arrayContaining([
        'reads pattern "moveFile" ignored for MOVE /remote.php/dav/files/{user}/{path}: only POST can be read-class.',
        'reads pattern "createFolder" ignored for MKCOL /remote.php/dav/files/{user}/{path}: only POST can be read-class.',
      ]),
    );
  });

  it("refuses reserved header names in the spec and at send time, defaults included", async () => {
    const entry = variant((spec) => {
      (spec.paths["/ocs/v2.php/cloud/capabilities"]!.get!.parameters as unknown[]).push({ name: "X-HTTP-Method-Override", in: "header", schema: { type: "string", default: "DELETE" } });
    });
    expect(entry.coverage.find((item) => item.ref === "getCapabilities")).toMatchObject({ status: "failed", reason: expect.stringContaining("reserved name") });
    const server = await davServer();
    const sent = await callOpenApiOperation({
      baseUrl: server.origin,
      operation: { method: "get", path: "/x", requestBody: null, parameters: [{ name: "X-HTTP-Method-Override", in: "header", required: false, schema: { type: "string", default: "DELETE" } }] },
      args: {},
      auth: { type: "none" },
      credentials: {},
      env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin },
    }).catch((error: unknown) => error);
    expect(sent).toMatchObject({ code: "openapi_argument_invalid", detail: { field: "header.X-HTTP-Method-Override", reason: "reserved header" } });
    expect(server.requests).toHaveLength(0);
  });

  it("maps lone surrogates in path and Destination values to a 400-class argument error", async () => {
    const entry = compiled();
    const server = await davServer();
    const call = caller(entry, server.origin);
    expect(await failure(call("download-file", { path: { user: "alice", path: "Docs/\ud800.md" } }))).toMatchObject({ code: "openapi_argument_invalid", detail: { field: "path.path", reason: "not valid Unicode" } });
    expect(await failure(call("download-file", { path: { user: "\udfff", path: "a.md" } }))).toMatchObject({ code: "openapi_argument_invalid", detail: { field: "path.user" } });
    expect(await failure(call("move-file", { path: { user: "alice", path: "a.md" }, header: { Destination: "x/\ud800" } }))).toMatchObject({ code: "openapi_argument_invalid" });
    expect(server.requests).toHaveLength(0);
  });

  it("enforces header const in the request builder itself", async () => {
    const server = await davServer();
    const operation = { method: "get" as const, path: "/ocs", requestBody: null, parameters: [{ name: "OCS-APIRequest", in: "header" as const, required: true, schema: { type: "string", const: "true" } }] };
    const send = (args: Record<string, unknown>) =>
      callOpenApiOperation({ baseUrl: server.origin, operation, args, auth: { type: "basic" }, credentials: { username: "alice", password: SECRET }, env: { MARKETPLACE_MCP_ALLOWED_ORIGINS: server.origin } });
    expect(await failure(send({ header: { "OCS-APIRequest": "false" } }))).toMatchObject({ detail: { field: "header.OCS-APIRequest", reason: "must be true" } });
    expect(server.requests).toHaveLength(0);
    await send({});
    expect(server.requests.at(-1)!.headers["ocs-apirequest"]).toBe("true");
  });
});

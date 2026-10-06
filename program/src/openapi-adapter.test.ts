import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  boundedToolSchema,
  deriveOperationActionKeys,
  inlineDefs,
  OPENAPI_ACTION_KEY_PATTERN,
  operationGroup,
  operationInputSchema,
  operationRisk,
  OpenApiSpecError,
  parseOpenApiDocument,
} from "./openapi-adapter.js";
import { compileArgumentValidator } from "./openapi-validate.js";

const FIXTURES = path.join(import.meta.dirname, "testing", "company-box");
const notesSpec = () => JSON.parse(readFileSync(path.join(FIXTURES, "notes", "openapi.json"), "utf8"));
const bigSpec = () => JSON.parse(readFileSync(path.join(FIXTURES, "bigapp", "swagger.json"), "utf8"));

function op(method: string, path: string, operationId: string | null = null) {
  return { method: method as "get", path, operationId };
}

describe("OpenAPI action key derivation", () => {
  it("uses operationId in kebab case, or method + path without one", () => {
    expect(
      deriveOperationActionKeys("company-box-notes", [
        op("get", "/notes", "listNotes"),
        op("get", "/notes/{id}/attachment"),
        op("post", "/HTTPServer/reload", "reloadHTTPServer"),
        op("get", "/2fa", "2faStatus"),
        op("get", "/", null),
      ]),
    ).toEqual([
      "company-box-notes.list-notes",
      "company-box-notes.get-notes-by-id-attachment",
      "company-box-notes.reload-http-server",
      "company-box-notes.op-2fa-status",
      "company-box-notes.get",
    ]);
  });

  it("resolves collisions deterministically, independent of spec order", () => {
    const operations = [
      op("get", "/res/{id}", "getRes"),
      op("get", "/legacy/res/{id}", "get_res"),
      op("get", "/v2/res/{id}", "GetRes"),
      op("post", "/notes"),
      op("post", "/notes/", null),
    ];
    const keys = deriveOperationActionKeys("app", operations);
    expect(new Set(keys).size).toBe(keys.length);
    // The member with the lowest `METHOD /path` keeps the base key.
    expect(keys[1]).toBe("app.get-res");
    expect(keys[0]).toMatch(/^app\.get-res-[0-9a-f]{6}$/u);
    expect(keys[2]).toMatch(/^app\.get-res-[0-9a-f]{6}$/u);
    const reversed = deriveOperationActionKeys("app", [...operations].reverse());
    expect([...reversed].reverse()).toEqual(keys);
    // Adding an unrelated operation renames nothing.
    expect(deriveOperationActionKeys("app", [...operations, op("get", "/other", "other")]).slice(0, 5)).toEqual(keys);
  });

  it("keeps every key inside the action key pattern and length", () => {
    const keys = deriveOperationActionKeys("company-box-very-long-application-name", [
      op("get", "/x", `get${"VeryLongName".repeat(20)}`),
      op("get", "/y", `get${"VeryLongName".repeat(20)}Other`),
    ]);
    for (const key of keys) {
      expect(key.length).toBeLessThanOrEqual(128);
      expect(key).toMatch(OPENAPI_ACTION_KEY_PATTERN);
    }
    expect(new Set(keys).size).toBe(2);
  });
});

describe("OpenAPI 3 parsing", () => {
  it("merges path-level and $ref parameters and resolves $ref request bodies", () => {
    const document = parseOpenApiDocument(notesSpec());
    expect(document).toMatchObject({ format: "openapi-3", basePath: "/api/v1", title: "Notes API" });
    expect(document.operations).toHaveLength(11);
    const list = document.operations.find((operation) => operation.operationId === "listNotes")!;
    expect(list.parameters.map((parameter) => `${parameter.in}:${parameter.name}`)).toEqual([
      "header:X-Request-Id",
      "query:limit",
      "query:tag",
      "query:user_id",
    ]);
    const create = document.operations.find((operation) => operation.operationId === "createNote")!;
    expect(create.requestBody).toMatchObject({ required: true, contentType: "application/json" });
    const schema = operationInputSchema(create, document.defs);
    expect(schema).toMatchObject({
      required: ["body"],
      properties: { body: { $ref: "#/$defs/NoteInput", "x-content-type": "application/json" } },
      $defs: {
        NoteInput: { properties: { tags: { items: { $ref: "#/$defs/Tag" } } } },
        Tag: { type: "string" },
      },
    });
    // Inlined form for the tool listing keeps the sibling content type.
    expect(inlineDefs({ ...schema, $defs: undefined }, document.defs)).toMatchObject({
      properties: { body: { type: "object", "x-content-type": "application/json", properties: { tags: { items: { pattern: "^[a-z0-9-]+$" } } } } },
    });
  });

  it("keeps recursive schemas finite through $defs", () => {
    const document = parseOpenApiDocument(notesSpec());
    const createFolder = document.operations.find((operation) => operation.operationId === "createFolder")!;
    const schema = operationInputSchema(createFolder, document.defs);
    expect(schema.$defs).toEqual({
      Folder: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/Folder" } } },
      },
    });
    expect(inlineDefs({ properties: schema.properties }, document.defs)).toBeNull();
    const bounded = boundedToolSchema(schema);
    expect(bounded).toEqual({ schema, truncated: false });
  });

  it("namespaces arguments so real parameters never clash with the agent denylist", () => {
    const document = parseOpenApiDocument(notesSpec());
    const list = document.operations.find((operation) => operation.operationId === "listNotes")!;
    const schema = operationInputSchema(list, document.defs);
    expect(Object.keys(schema.properties as object)).toEqual(["query", "header"]);
    expect((schema.properties as Record<string, { properties: object }>).query.properties).toHaveProperty("user_id");
  });

  it("refuses external refs and unsupported versions", () => {
    expect(() =>
      parseOpenApiDocument({
        openapi: "3.1.0",
        paths: { "/x": { get: { parameters: [{ $ref: "other.json#/p" }] } } },
      }),
    ).toThrow(OpenApiSpecError);
    expect(() => parseOpenApiDocument({ swagger: "1.2", paths: {} })).toThrow(/Only OpenAPI 3.x and Swagger 2.0/u);
  });
});

describe("OpenAPI 3.0 nullable without type", () => {
  it("rewrites `nullable: true` beside oneOf/anyOf as an anyOf with null so validators accept it", () => {
    const document = parseOpenApiDocument({
      openapi: "3.0.3",
      paths: {
        "/x": {
          post: {
            operationId: "createX",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      meta: { nullable: true, oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] },
                      plain: { nullable: false, anyOf: [{ type: "string" }, { type: "number" }] },
                      nullable: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const schema = operationInputSchema(document.operations[0]!, document.defs);
    const body = (schema.properties as Record<string, { properties: Record<string, unknown> }>).body!;
    expect(body.properties.meta).toEqual({
      anyOf: [{ oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] }, { type: "null" }],
    });
    expect(body.properties.plain).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
    // A property that is itself called `nullable` is left alone.
    expect(body.properties.nullable).toEqual({ type: "string" });
    const validate = compileArgumentValidator(schema);
    expect(validate({ body: { meta: null } }).ok).toBe(true);
    expect(validate({ body: { meta: "text" } }).ok).toBe(true);
    expect(validate({ body: { meta: 4 } }).ok).toBe(false);
  });
});

describe("Swagger 2.0 conversion", () => {
  it("maps body, formData, collectionFormat and definitions", () => {
    const document = parseOpenApiDocument(bigSpec());
    expect(document).toMatchObject({ format: "swagger-2", basePath: "/api" });
    expect(document.operations).toHaveLength(152);
    const create = document.operations.find((operation) => operation.operationId === "createRes01")!;
    expect(create.requestBody).toMatchObject({ required: true, contentType: "application/json", schema: { $ref: "#/$defs/Item" } });
    const list = document.operations.find((operation) => operation.operationId === "listRes01")!;
    expect(list.parameters.find((parameter) => parameter.name === "ids")).toMatchObject({ explode: true, schema: { type: "array" } });
    const publish = document.operations.find((operation) => operation.operationId === "publishRes01")!;
    expect(publish.requestBody).toMatchObject({
      contentType: "application/x-www-form-urlencoded",
      required: true,
      schema: { properties: { channel: { type: "string", enum: ["email", "web"] } }, required: ["channel"] },
    });
    expect(Object.keys(document.defs)).toEqual(["Item", "Owner"]);
  });
});

describe("schema bounds and risk", () => {
  it("truncates oversized tool schemas but keeps the full schema", () => {
    const big = {
      openapi: "3.0.0",
      info: { title: "x", version: "1" },
      paths: {
        "/bulk": {
          post: {
            operationId: "bulk",
            parameters: [{ name: "dry", in: "query", schema: { type: "boolean" } }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: Object.fromEntries(
                      Array.from({ length: 600 }, (_, index) => [`field${index}`, { type: "string", description: "x".repeat(40) }]),
                    ),
                  },
                },
              },
            },
          },
        },
      },
    };
    const document = parseOpenApiDocument(big);
    const full = operationInputSchema(document.operations[0]!, document.defs);
    const bounded = boundedToolSchema(full);
    expect(bounded.truncated).toBe(true);
    expect(bounded.schema).toMatchObject({
      "x-truncated": true,
      properties: { query: { properties: { dry: { type: "boolean" } } }, body: { type: "object", description: expect.stringContaining("operations.describe") } },
    });
    expect(Buffer.byteLength(JSON.stringify(bounded.schema))).toBeLessThanOrEqual(16_384);
    expect(Object.keys((full.properties as { body: { properties: object } }).body.properties)).toHaveLength(600);
  });

  it("classifies reads, writes, destructive and outward operations", () => {
    const patterns = { outward: ["send*", "POST /campaigns/{id}/test"], destructive: ["purge*"] };
    expect(operationRisk(op("get", "/x", "list"), patterns)).toEqual({ capability: "connector.observe", write: false, outward: false, destructive: false });
    expect(operationRisk(op("post", "/x", "create"), patterns)).toEqual({ capability: "connector.dispatch", write: true, outward: false, destructive: false });
    expect(operationRisk(op("delete", "/x/{id}", "remove"), patterns)).toEqual({ capability: "connector.admin", write: true, outward: false, destructive: true });
    expect(operationRisk(op("put", "/campaigns/{id}/send", "sendCampaign"), patterns)).toMatchObject({ capability: "connector.dispatch", outward: true });
    expect(operationRisk(op("post", "/campaigns/{id}/test"), patterns)).toMatchObject({ outward: true });
    expect(operationRisk(op("post", "/cache", "purgeCache"), patterns)).toMatchObject({ capability: "connector.admin", destructive: true });
  });

  it("treats `reads` matches as read-class unless also outward or destructive", () => {
    const patterns = { outward: ["sendDigest"], destructive: ["purgeSearch"], reads: ["search*", "POST /graphql", "sendDigest", "purgeSearch", "DELETE /cache/{key}"] };
    expect(operationRisk(op("post", "/notes/search", "searchNotes"), patterns)).toEqual({ capability: "connector.observe", write: false, outward: false, destructive: false });
    expect(operationRisk(op("post", "/graphql"), patterns)).toEqual({ capability: "connector.observe", write: false, outward: false, destructive: false });
    // Also listed as outward / destructive: those flags still apply.
    expect(operationRisk(op("post", "/digest", "sendDigest"), patterns)).toEqual({ capability: "connector.observe", write: false, outward: true, destructive: false });
    expect(operationRisk(op("post", "/search/purge", "purgeSearch"), patterns)).toEqual({ capability: "connector.admin", write: true, outward: false, destructive: true });
    // A DELETE marked read-class is not destructive unless listed there.
    expect(operationRisk(op("delete", "/cache/{key}"), patterns)).toEqual({ capability: "connector.observe", write: false, outward: false, destructive: false });
    expect(operationRisk(op("post", "/notes", "createNote"), patterns)).toMatchObject({ capability: "connector.dispatch", write: true });
  });

  it("groups operations by first tag, else first path segment", () => {
    expect(operationGroup({ tags: ["Mailing Lists"], path: "/lists" })).toBe("mailing-lists");
    expect(operationGroup({ tags: [], path: "/{org}/campaigns/{id}" })).toBe("campaigns");
    expect(operationGroup({ tags: [], path: "/" })).toBe("general");
  });
});

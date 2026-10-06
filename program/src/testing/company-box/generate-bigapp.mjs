// Regenerates the ~150-operation Swagger 2.0 fixture used to exercise
// discovery exposure. Run: node src/testing/company-box/generate-bigapp.mjs
// then update bigapp/entry.json's sha256 (the coverage test reports it).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resources = Array.from({ length: 25 }, (_, index) => `res${String(index).padStart(2, "0")}`);
const paths = {
  "/ping": { get: { operationId: "ping", summary: "Ping", tags: ["system"], responses: { 200: { description: "pong" } } } },
};
for (const resource of resources) {
  const Name = resource[0].toUpperCase() + resource.slice(1);
  paths[`/${resource}`] = {
    get: {
      operationId: `list${Name}`,
      summary: `List ${resource}`,
      tags: [resource],
      parameters: [
        { name: "page", in: "query", type: "integer" },
        { name: "ids", in: "query", type: "array", items: { type: "string" }, collectionFormat: "multi" },
      ],
      responses: { 200: { description: "ok" } },
    },
    post: {
      operationId: `create${Name}`,
      summary: `Create ${resource}`,
      tags: [resource],
      parameters: [{ name: "payload", in: "body", required: true, schema: { $ref: "#/definitions/Item" } }],
      responses: { 201: { description: "created" } },
    },
  };
  paths[`/${resource}/{id}`] = {
    parameters: [{ name: "id", in: "path", required: true, type: "string" }],
    get: { operationId: `get${Name}`, summary: `Get ${resource}`, tags: [resource], responses: { 200: { description: "ok" } } },
    put: {
      operationId: `update${Name}`,
      summary: `Update ${resource}`,
      tags: [resource],
      parameters: [{ name: "payload", in: "body", required: true, schema: { $ref: "#/definitions/Item" } }],
      responses: { 200: { description: "ok" } },
    },
    delete: { operationId: `delete${Name}`, summary: `Delete ${resource}`, tags: [resource], responses: { 204: { description: "gone" } } },
  };
  paths[`/${resource}/{id}/publish`] = {
    post: {
      // Every fifth resource has no operationId: keys come from method + path.
      ...(Number(resource.slice(3)) % 5 === 0 ? {} : { operationId: `publish${Name}` }),
      summary: `Publish ${resource} to subscribers`,
      tags: [resource, "publishing"],
      consumes: ["application/x-www-form-urlencoded"],
      parameters: [
        { name: "id", in: "path", required: true, type: "string" },
        { name: "channel", in: "formData", required: true, type: "string", enum: ["email", "web"] },
      ],
      responses: { 202: { description: "queued" } },
    },
  };
}
// A deliberate key collision: getRes00 vs get_res00 both kebab to get-res00.
paths["/legacy/res00/{id}"] = {
  get: {
    operationId: "get_res00",
    summary: "Legacy get res00",
    tags: ["legacy"],
    parameters: [{ name: "id", in: "path", required: true, type: "string" }],
    responses: { 200: { description: "ok" } },
  },
};
const spec = {
  swagger: "2.0",
  info: { title: "Big App", version: "9.1.0" },
  basePath: "/api",
  consumes: ["application/json"],
  produces: ["application/json"],
  paths,
  definitions: {
    Item: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" }, owner: { $ref: "#/definitions/Owner" }, parent: { $ref: "#/definitions/Item" } },
    },
    Owner: { type: "object", properties: { user_id: { type: "string" } } },
  },
};
const file = path.join(here, "bigapp", "swagger.json");
writeFileSync(file, `${JSON.stringify(spec, null, 1)}\n`);
const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
console.log(`bigapp/swagger.json sha256 ${sha}`);

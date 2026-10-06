/**
 * Company Box OpenAPI adapter: turns a vendored, pinned OpenAPI 3.x or
 * Swagger 2.0 document into addressable Marketplace actions.
 *
 * - Every path × method is one operation. Nothing is dropped silently: an
 *   operation leaves the action list only through the entry's explicit
 *   `excluded` list (see company-box.ts and the coverage report).
 * - Local `$ref`s are resolved. Component schemas become `$defs` of a
 *   self-contained input schema, so recursive schemas stay finite. External
 *   refs are refused: vendored specs must be self-contained.
 * - Arguments are namespaced by location: `{ path, query, header, body }`.
 *   Parameter names never collide and never clash with the agent argument
 *   denylist (e.g. a real `user_id` query parameter stays reachable).
 */
import { createHash } from "node:crypto";

import type { ConnectorCapability } from "./types.js";

export const OPENAPI_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/**
 * WebDAV methods. OpenAPI has no slot for them, so a spec declares each as
 * an Operation Object under an `x-<method>` key of the path item
 * (`x-propfind`, `x-mkcol`, …).
 */
export const WEBDAV_METHODS = [
  "propfind",
  "proppatch",
  "mkcol",
  "move",
  "copy",
  "report",
  "lock",
  "unlock",
] as const;
export type OpenApiMethod = (typeof OPENAPI_METHODS)[number] | (typeof WEBDAV_METHODS)[number];

/** Methods that only read (grant as connector.observe). */
export const READ_METHODS: ReadonlySet<string> = new Set(["get", "head", "options", "propfind", "report"]);

export type JsonSchema = Record<string, unknown>;

export const OPENAPI_MAX_ACTION_KEY_LENGTH = 128;
export const OPENAPI_ACTION_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,7}$/u;
/** Bounded per-tool schema; the full schema stays reachable through describe. */
export const OPENAPI_TOOL_SCHEMA_MAX_BYTES = 16_384;
export const OPENAPI_TITLE_MAX = 200;
export const OPENAPI_SUMMARY_MAX = 300;
export const OPENAPI_DESCRIPTION_MAX = 1_000;
export const OPENAPI_FULL_DESCRIPTION_MAX = 20_000;
const MAX_REF_DEPTH = 64;
const INLINE_NODE_BUDGET = 4_000;

export type OpenApiSpecErrorCode =
  | "openapi_spec_invalid"
  | "openapi_spec_unsupported_version"
  | "openapi_external_ref"
  | "openapi_ref_unresolved";

export class OpenApiSpecError extends Error {
  constructor(
    readonly code: OpenApiSpecErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type OpenApiParameterLocation = "path" | "query" | "header";

export type OpenApiParameter = {
  name: string;
  in: OpenApiParameterLocation;
  required: boolean;
  schema: JsonSchema;
  description?: string;
  style?: string;
  explode?: boolean;
  /** Path only (`x-multi-segment: true`): the value may span `/`-separated segments. */
  multiSegment?: boolean;
  /**
   * `Destination` header only (`x-destination-template`): a path template
   * relative to the API base. The header is always built as base origin +
   * prefix + this template; `{<header name>}` takes the caller's relative
   * path (multi-segment), other `{name}`s the operation's path arguments.
   */
  destinationTemplate?: string;
};

/** A header param the agent may omit because the spec fixes or defaults it. */
export function parameterDefault(parameter: Pick<OpenApiParameter, "schema">): unknown {
  if ("const" in parameter.schema) return parameter.schema.const;
  if ("default" in parameter.schema) return parameter.schema.default;
  return undefined;
}

export function parameterHasDefault(parameter: Pick<OpenApiParameter, "in" | "schema">) {
  return parameter.in === "header" && parameterDefault(parameter) !== undefined;
}

/** Required and not filled in by a default/const. */
export function parameterNeedsArgument(parameter: Pick<OpenApiParameter, "in" | "schema" | "required">) {
  return parameter.required && !parameterHasDefault(parameter);
}

export type OpenApiRequestBody = {
  required: boolean;
  contentType: string;
  contentTypes: string[];
  schema: JsonSchema;
  description?: string;
};

export type OpenApiOperation = {
  /** `operationId` when present, otherwise `METHOD /path`. */
  ref: string;
  operationId: string | null;
  method: OpenApiMethod;
  path: string;
  summary: string | null;
  description: string | null;
  tags: string[];
  deprecated: boolean;
  parameters: OpenApiParameter[];
  /** Parameters the adapter cannot send (cookie params); reported, not hidden. */
  unsupportedParameters: Array<{ name: string; in: string }>;
  requestBody: OpenApiRequestBody | null;
};

export type OpenApiDocument = {
  format: "openapi-3" | "swagger-2";
  specVersion: string;
  title: string;
  apiVersion: string;
  /** Path prefix from Swagger `basePath` or the first server URL. */
  basePath: string;
  /** Component schemas, refs rewritten to `#/$defs/<name>`. */
  defs: Record<string, JsonSchema>;
  operations: OpenApiOperation[];
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function operationIdentity(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

function decodePointerToken(token: string) {
  return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function encodePointerToken(token: string) {
  return token.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#")) {
    throw new OpenApiSpecError("openapi_external_ref", `External $ref ${ref} is not supported.`);
  }
  const pointer = ref.slice(1);
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) {
    throw new OpenApiSpecError("openapi_ref_unresolved", `Unresolvable $ref ${ref}.`);
  }
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = decodePointerToken(decodeURIComponent(raw));
    if (Array.isArray(current)) {
      current = current[Number(token)];
    } else {
      const record = recordValue(current);
      current = record ? record[token] : undefined;
    }
    if (current === undefined) {
      throw new OpenApiSpecError("openapi_ref_unresolved", `Unresolvable $ref ${ref}.`);
    }
  }
  return current;
}

/** Follow `$ref` chains on a non-schema object (parameter, requestBody). */
function derefObject(document: unknown, value: unknown): Record<string, unknown> | null {
  let current = recordValue(value);
  for (let depth = 0; current && typeof current.$ref === "string"; depth += 1) {
    if (depth > MAX_REF_DEPTH) {
      throw new OpenApiSpecError("openapi_ref_unresolved", "Circular $ref chain.");
    }
    current = recordValue(resolvePointer(document, current.$ref));
  }
  return current;
}

type SchemaContext = {
  document: unknown;
  /** JSON pointer prefixes that map to `$defs`. */
  defPrefixes: string[];
};

/**
 * Deep-copy a schema, rewriting component refs to `#/$defs/...`. Any other
 * local ref is inlined (with a cycle guard); external refs throw.
 */
function rewriteSchema(context: SchemaContext, value: unknown, seen: Set<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteSchema(context, item, seen));
  const record = recordValue(value);
  if (!record) return value;
  if (typeof record.$ref === "string") {
    const ref = record.$ref;
    for (const prefix of context.defPrefixes) {
      if (ref.startsWith(prefix)) {
        const { $ref: _ignored, ...siblings } = record;
        const rewritten = { $ref: `#/$defs/${ref.slice(prefix.length)}` };
        return Object.keys(siblings).length
          ? { allOf: [rewritten], ...(rewriteSchema(context, siblings, seen) as JsonSchema) }
          : rewritten;
      }
    }
    if (seen.has(ref) || seen.size > MAX_REF_DEPTH) {
      return { description: `Recursive reference ${ref}.` };
    }
    const target = resolvePointer(context.document, ref);
    return rewriteSchema(context, target, new Set([...seen, ref]));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    out[key] = rewriteSchema(context, child, seen);
  }
  return out;
}

function collectDefRefs(value: unknown, into: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectDefRefs(item, into);
    return;
  }
  const record = recordValue(value);
  if (!record) return;
  if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/")) {
    const name = decodePointerToken(record.$ref.slice("#/$defs/".length).split("/")[0] ?? "");
    if (name) into.add(name);
  }
  for (const child of Object.values(record)) collectDefRefs(child, into);
}

/** The `$defs` subset reachable from `schema`. */
export function reachableDefs(schema: unknown, defs: Record<string, JsonSchema>) {
  const names = new Set<string>();
  collectDefRefs(schema, names);
  const out: Record<string, JsonSchema> = {};
  const queue = [...names];
  while (queue.length) {
    const name = queue.shift()!;
    if (name in out) continue;
    const def = defs[name];
    if (!def) {
      throw new OpenApiSpecError("openapi_ref_unresolved", `Unresolvable schema ${name}.`);
    }
    out[name] = def;
    const nested = new Set<string>();
    collectDefRefs(def, nested);
    for (const next of nested) if (!(next in out)) queue.push(next);
  }
  return out;
}

/**
 * Fully inline `$defs` refs. Returns null on a cycle or when the result
 * would exceed the node budget, so callers fall back to the `$defs` form.
 */
export function inlineDefs(schema: unknown, defs: Record<string, JsonSchema>): unknown | null {
  let nodes = 0;
  const walk = (value: unknown, stack: string[]): unknown => {
    nodes += 1;
    if (nodes > INLINE_NODE_BUDGET) throw new Error("budget");
    if (Array.isArray(value)) return value.map((item) => walk(item, stack));
    const record = recordValue(value);
    if (!record) return value;
    if (typeof record.$ref === "string" && record.$ref.startsWith("#/$defs/")) {
      const path = record.$ref.slice("#/$defs/".length).split("/").map(decodePointerToken);
      const name = path[0]!;
      if (stack.includes(name)) throw new Error("cycle");
      let target: unknown = defs[name];
      for (const token of path.slice(1)) target = recordValue(target)?.[token];
      if (target === undefined) throw new Error("missing");
      const { $ref: _ref, ...siblings } = record;
      const resolved = walk(target, [...stack, name]);
      if (!Object.keys(siblings).length) return resolved;
      const extra = walk(siblings, stack) as Record<string, unknown>;
      return recordValue(resolved) ? { ...(resolved as Record<string, unknown>), ...extra } : { allOf: [resolved], ...extra };
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) out[key] = walk(child, stack);
    return out;
  };
  try {
    return walk(schema, []);
  } catch {
    return null;
  }
}

function swaggerParameterSchema(parameter: Record<string, unknown>): JsonSchema {
  const schema: JsonSchema = {};
  for (const key of [
    "type",
    "format",
    "items",
    "enum",
    "default",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "pattern",
    "minItems",
    "maxItems",
    "uniqueItems",
    "multipleOf",
  ]) {
    if (key in parameter) schema[key] = parameter[key];
  }
  if (schema.type === "file") {
    schema.type = "string";
    schema.format = "binary";
  }
  return schema;
}

const BODY_CONTENT_PREFERENCE = [
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "application/octet-stream",
];

export function preferredContentType(contentTypes: readonly string[]) {
  const lower = contentTypes.map((type) => type.toLowerCase());
  for (const preferred of BODY_CONTENT_PREFERENCE) {
    const index = lower.findIndex((type) => type.split(";")[0]!.trim() === preferred);
    if (index >= 0) return contentTypes[index]!;
    if (preferred === "application/json") {
      const json = lower.findIndex((type) => /\+json\b/u.test(type) || type.endsWith("/json"));
      if (json >= 0) return contentTypes[json]!;
    }
  }
  return contentTypes[0] ?? "application/json";
}

function mergeParameters(
  document: unknown,
  pathLevel: unknown,
  operationLevel: unknown,
): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>();
  for (const list of [pathLevel, operationLevel]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const parameter = derefObject(document, raw);
      const name = stringValue(parameter?.name);
      const location = stringValue(parameter?.in);
      if (!parameter || !name || !location) {
        throw new OpenApiSpecError("openapi_spec_invalid", "A parameter is missing name or in.");
      }
      merged.set(`${location}\u0000${name}`, parameter);
    }
  }
  return [...merged.values()];
}

function boundedText(value: unknown, max: number) {
  const text = stringValue(value);
  return text ? text.slice(0, max) : null;
}

/** Parse and normalize an OpenAPI 3.x or Swagger 2.0 document. */
export function parseOpenApiDocument(raw: unknown): OpenApiDocument {
  const document = recordValue(raw);
  if (!document) throw new OpenApiSpecError("openapi_spec_invalid", "The spec is not a JSON object.");
  const openapi = stringValue(document.openapi);
  const swagger = stringValue(document.swagger);
  let format: OpenApiDocument["format"];
  if (openapi && /^3\.\d+(\.\d+)?$/u.test(openapi)) format = "openapi-3";
  else if (swagger === "2.0") format = "swagger-2";
  else {
    throw new OpenApiSpecError(
      "openapi_spec_unsupported_version",
      "Only OpenAPI 3.x and Swagger 2.0 documents are supported.",
    );
  }
  const paths = recordValue(document.paths);
  if (!paths) throw new OpenApiSpecError("openapi_spec_invalid", "The spec has no paths object.");
  const context: SchemaContext = {
    document,
    defPrefixes: format === "openapi-3" ? ["#/components/schemas/"] : ["#/definitions/"],
  };
  const rawDefs =
    format === "openapi-3"
      ? (recordValue(recordValue(document.components)?.schemas) ?? {})
      : (recordValue(document.definitions) ?? {});
  const defs: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(rawDefs)) {
    defs[name] = (recordValue(rewriteSchema(context, schema)) ?? {}) as JsonSchema;
  }
  const info = recordValue(document.info) ?? {};
  let basePath = "";
  if (format === "swagger-2") {
    basePath = stringValue(document.basePath) ?? "";
  } else {
    const server = stringValue(recordValue((document.servers as unknown[] | undefined)?.[0])?.url);
    if (server) {
      try {
        basePath = new URL(server, "http://placeholder.invalid").pathname;
      } catch {
        basePath = "";
      }
    }
  }
  basePath = basePath.replace(/\/+$/u, "");
  if (basePath && !basePath.startsWith("/")) basePath = `/${basePath}`;
  const globalConsumes = Array.isArray(document.consumes)
    ? document.consumes.filter((item): item is string => typeof item === "string")
    : [];

  const operations: OpenApiOperation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = derefObject(document, rawItem);
    if (!item) continue;
    for (const method of [...OPENAPI_METHODS, ...WEBDAV_METHODS]) {
      const operation = recordValue(
        (WEBDAV_METHODS as readonly string[]).includes(method) ? item[`x-${method}`] : item[method],
      );
      if (!operation) continue;
      const operationId = stringValue(operation.operationId);
      const parameters: OpenApiParameter[] = [];
      const unsupportedParameters: OpenApiOperation["unsupportedParameters"] = [];
      let requestBody: OpenApiRequestBody | null = null;
      const formFields: Array<{ name: string; required: boolean; schema: JsonSchema; file: boolean }> = [];
      for (const parameter of mergeParameters(document, item.parameters, operation.parameters)) {
        const name = String(parameter.name);
        const location = String(parameter.in);
        const description = boundedText(parameter.description, OPENAPI_DESCRIPTION_MAX);
        if (format === "swagger-2" && location === "body") {
          const schema = recordValue(rewriteSchema(context, parameter.schema ?? {})) ?? {};
          const consumes = Array.isArray(operation.consumes)
            ? operation.consumes.filter((type): type is string => typeof type === "string")
            : globalConsumes;
          const contentTypes = consumes.length ? consumes : ["application/json"];
          requestBody = {
            required: parameter.required === true,
            contentType: preferredContentType(contentTypes),
            contentTypes,
            schema,
            ...(description ? { description } : {}),
          };
          continue;
        }
        if (format === "swagger-2" && location === "formData") {
          formFields.push({
            name,
            required: parameter.required === true,
            schema: swaggerParameterSchema(parameter),
            file: parameter.type === "file",
          });
          continue;
        }
        if (location !== "path" && location !== "query" && location !== "header") {
          unsupportedParameters.push({ name, in: location });
          continue;
        }
        const schema =
          format === "swagger-2"
            ? (recordValue(rewriteSchema(context, swaggerParameterSchema(parameter))) ?? {})
            : (recordValue(
                rewriteSchema(
                  context,
                  parameter.schema ??
                    recordValue(Object.values(recordValue(parameter.content) ?? {})[0])?.schema ??
                    {},
                ),
              ) ?? {});
        const lowerName = name.toLowerCase();
        // WebDAV headers with fixed vocabularies are always validated.
        const constrained =
          location === "header" && lowerName === "overwrite"
            ? { ...schema, type: "string", enum: ["T", "F"] }
            : location === "header" && lowerName === "depth"
              ? { ...schema, type: "string", enum: ["0", "1", "infinity"] }
              : schema;
        parameters.push({
          name,
          in: location,
          required: location === "path" ? true : parameter.required === true,
          schema:
            location === "path" && parameter["x-multi-segment"] === true
              ? { description: "A path; may contain / between segments (no empty, . or .. segments).", ...constrained, "x-multi-segment": true }
              : location === "header" && lowerName === "destination"
                ? { description: "Destination path relative to the app (not a URL); Marketplace builds the full address.", ...constrained }
                : constrained,
          ...(location === "path" && parameter["x-multi-segment"] === true ? { multiSegment: true } : {}),
          ...(location === "header" && lowerName === "destination" && typeof parameter["x-destination-template"] === "string"
            ? { destinationTemplate: parameter["x-destination-template"] }
            : {}),
          ...(description ? { description } : {}),
          ...(typeof parameter.style === "string" ? { style: parameter.style } : {}),
          ...(typeof parameter.explode === "boolean" ? { explode: parameter.explode } : {}),
          ...(format === "swagger-2" && parameter.collectionFormat === "multi"
            ? { explode: true }
            : format === "swagger-2" && parameter.type === "array"
              ? { explode: false }
              : {}),
        });
      }
      if (formFields.length) {
        const multipart = formFields.some((field) => field.file);
        const consumes = Array.isArray(operation.consumes)
          ? operation.consumes.filter((type): type is string => typeof type === "string")
          : globalConsumes;
        const contentType = multipart
          ? "multipart/form-data"
          : (consumes.find((type) => type.startsWith("multipart/form-data")) ??
            "application/x-www-form-urlencoded");
        requestBody = {
          required: formFields.some((field) => field.required),
          contentType,
          contentTypes: [contentType],
          schema: {
            type: "object",
            properties: Object.fromEntries(formFields.map((field) => [field.name, field.schema])),
            required: formFields.filter((field) => field.required).map((field) => field.name),
          },
        };
      }
      if (format === "openapi-3" && operation.requestBody !== undefined) {
        const body = derefObject(document, operation.requestBody);
        const content = recordValue(body?.content) ?? {};
        const contentTypes = Object.keys(content);
        if (contentTypes.length) {
          const contentType = preferredContentType(contentTypes);
          const description = boundedText(body?.description, OPENAPI_DESCRIPTION_MAX);
          requestBody = {
            required: body?.required === true,
            contentType,
            contentTypes,
            schema:
              (recordValue(rewriteSchema(context, recordValue(content[contentType])?.schema ?? {})) ??
                {}) as JsonSchema,
            ...(description ? { description } : {}),
          };
        }
      }
      // A `{param}` used in the path template but never declared is still
      // required to build the URL: treat it as a required string.
      for (const match of path.matchAll(/\{([^}]+)\}/gu)) {
        const name = match[1]!;
        if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name)) {
          parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
        }
      }
      if (requestBody) {
        requestBody = { ...requestBody, schema: fileAwareBodySchema(requestBody.contentType, requestBody.schema, defs) };
      }
      operations.push({
        ref: operationId ?? operationIdentity(method, path),
        operationId,
        method,
        path,
        summary: boundedText(operation.summary, OPENAPI_TITLE_MAX),
        description: boundedText(operation.description, OPENAPI_FULL_DESCRIPTION_MAX),
        tags: Array.isArray(operation.tags)
          ? operation.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20)
          : [],
        deprecated: operation.deprecated === true,
        parameters,
        unsupportedParameters,
        requestBody,
      });
    }
  }
  return {
    format,
    specVersion: (openapi ?? swagger)!,
    title: stringValue(info.title) ?? "API",
    apiVersion: stringValue(info.version) ?? "",
    basePath,
    defs,
    operations,
  };
}

function kebab(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function shortHash(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** Base segment before collision handling. */
export function operationKeySegment(operation: Pick<OpenApiOperation, "operationId" | "method" | "path">) {
  let segment = operation.operationId
    ? kebab(operation.operationId)
    : kebab(`${operation.method} ${operation.path.replace(/\{([^}]*)\}/gu, " by $1 ")}`);
  if (!segment) segment = "operation";
  if (!/^[a-z]/u.test(segment)) segment = `op-${segment}`;
  return segment;
}

/**
 * Action key rule (extension of the custom MCP rule in custom-mcp.ts):
 *
 * `<provider>.<segment>` where segment is the operationId in kebab case
 * (`listNotes` → `list-notes`), or, without an operationId,
 * `<method>-<path>` with `{param}` read as `by-param`
 * (`GET /notes/{id}` → `get-notes-by-id`); prefixed `op-` when it would not
 * start with a letter and truncated to fit 128 chars.
 *
 * Collisions are resolved without depending on spec order: members of a
 * colliding group are sorted by `METHOD /path`; the first keeps the base and
 * every other member gets `-<6 hex of sha256("METHOD /path")>` (lengthened
 * on the astronomically unlikely second collision). Adding an unrelated
 * operation therefore never renames an existing key.
 */
export function deriveOperationActionKeys(
  provider: string,
  operations: ReadonlyArray<Pick<OpenApiOperation, "operationId" | "method" | "path">>,
): string[] {
  const budget = OPENAPI_MAX_ACTION_KEY_LENGTH - provider.length - 1;
  if (budget < 16) throw new Error(`Provider ${provider} is too long for action keys.`);
  const bases = operations.map((operation) =>
    operationKeySegment(operation).slice(0, budget).replace(/-+$/u, ""),
  );
  const groups = new Map<string, number[]>();
  bases.forEach((base, index) => groups.set(base, [...(groups.get(base) ?? []), index]));
  const keys: string[] = new Array(operations.length);
  const used = new Set<string>();
  // Singletons first so a suffixed key can never steal an unsuffixed one.
  for (const [base, members] of groups) {
    if (members.length === 1) {
      keys[members[0]!] = `${provider}.${base}`;
      used.add(keys[members[0]!]!);
    }
  }
  for (const [base, members] of groups) {
    if (members.length === 1) continue;
    const sorted = [...members].sort((left, right) => {
      const a = operationIdentity(operations[left]!.method, operations[left]!.path);
      const b = operationIdentity(operations[right]!.method, operations[right]!.path);
      return a < b ? -1 : a > b ? 1 : left - right;
    });
    sorted.forEach((index, position) => {
      if (position === 0 && !used.has(`${provider}.${base}`)) {
        keys[index] = `${provider}.${base}`;
        used.add(keys[index]!);
        return;
      }
      const identity = operationIdentity(operations[index]!.method, operations[index]!.path);
      for (let length = 6; length <= 64; length += 2) {
        const suffix = `-${shortHash(identity, length)}`;
        const trimmed = base.slice(0, budget - suffix.length).replace(/-+$/u, "");
        const candidate = `${provider}.${trimmed}${suffix}`;
        if (!used.has(candidate)) {
          keys[index] = candidate;
          used.add(candidate);
          return;
        }
      }
      throw new Error(`Could not derive a unique action key for ${identity}.`);
    });
  }
  for (const key of keys) {
    if (!OPENAPI_ACTION_KEY_PATTERN.test(key) || key.length > OPENAPI_MAX_ACTION_KEY_LENGTH) {
      throw new Error(`Derived action key ${key} is invalid.`);
    }
  }
  return keys;
}

/** `*` wildcard, case-insensitive, matched against operationId and `METHOD /path`. */
export function operationPatternMatches(
  pattern: string,
  operation: Pick<OpenApiOperation, "operationId" | "method" | "path">,
) {
  const regex = new RegExp(
    `^${pattern
      .trim()
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "iu",
  );
  return (
    (operation.operationId !== null && regex.test(operation.operationId)) ||
    regex.test(operationIdentity(operation.method, operation.path))
  );
}

export type OperationRisk = {
  capability: ConnectorCapability;
  write: boolean;
  outward: boolean;
  destructive: boolean;
};

/**
 * GET/HEAD/OPTIONS read (observe). Every other method writes (dispatch),
 * unless it matches the entry's `reads` patterns (POST search endpoints,
 * GraphQL queries): those are read-class and are never destructive or
 * outward unless also listed in those patterns. DELETE, or a match in
 * `destructive`, is destructive (admin). A match in `outward` marks the call
 * as reaching people or systems outside the workspace; governance requires
 * approval for it.
 */
export function operationRisk(
  operation: Pick<OpenApiOperation, "operationId" | "method" | "path">,
  patterns: { outward: readonly string[]; destructive: readonly string[]; reads?: readonly string[] },
): OperationRisk {
  const readMethod = READ_METHODS.has(operation.method);
  const readClass =
    !readMethod && (patterns.reads ?? []).some((pattern) => operationPatternMatches(pattern, operation));
  const write = !readMethod && !readClass;
  const destructive =
    (operation.method === "delete" && !readClass) ||
    patterns.destructive.some((pattern) => operationPatternMatches(pattern, operation));
  const outward = patterns.outward.some((pattern) => operationPatternMatches(pattern, operation));
  return {
    capability: destructive ? "connector.admin" : write ? "connector.dispatch" : "connector.observe",
    write: write || destructive,
    outward,
    destructive,
  };
}

/**
 * Stable group for catalog grouping: the first tag, else the first literal
 * path segment, in kebab case; `general` when neither exists.
 */
export function operationGroup(operation: Pick<OpenApiOperation, "tags" | "path">) {
  const tag = operation.tags.map(kebab).find(Boolean);
  if (tag) return tag;
  const segment = operation.path
    .split("/")
    .filter((part) => part && !part.startsWith("{"))
    .map(kebab)
    .find(Boolean);
  return segment ?? "general";
}

function groupSchema(parameters: readonly OpenApiParameter[]) {
  return {
    type: "object",
    properties: Object.fromEntries(
      parameters.map((parameter) => [
        parameter.name,
        parameter.description && !("description" in parameter.schema)
          ? { ...parameter.schema, description: parameter.description }
          : parameter.schema,
      ]),
    ),
    required: parameters.filter(parameterNeedsArgument).map((parameter) => parameter.name),
    additionalProperties: false,
  };
}

/** Argument groups this operation accepts, in a stable order. */
export function operationArgumentGroups(operation: Pick<OpenApiOperation, "parameters" | "requestBody">) {
  const groups: Array<"path" | "query" | "header" | "body"> = [];
  for (const location of ["path", "query", "header"] as const) {
    if (operation.parameters.some((parameter) => parameter.in === location)) groups.push(location);
  }
  if (operation.requestBody) groups.push("body");
  return groups;
}

/** Self-contained input schema: `{ path, query, header, body }` plus `$defs`. */
export function operationInputSchema(
  operation: Pick<OpenApiOperation, "parameters" | "requestBody">,
  defs: Record<string, JsonSchema>,
): JsonSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const location of ["path", "query", "header"] as const) {
    const parameters = operation.parameters.filter((parameter) => parameter.in === location);
    if (!parameters.length) continue;
    properties[location] = groupSchema(parameters);
    if (parameters.some(parameterNeedsArgument)) required.push(location);
  }
  if (operation.requestBody) {
    properties.body = {
      ...operation.requestBody.schema,
      ...(operation.requestBody.description && !("description" in operation.requestBody.schema)
        ? { description: operation.requestBody.description }
        : {}),
      "x-content-type": operation.requestBody.contentType,
    };
    if (operation.requestBody.required) required.push("body");
  }
  const schema: JsonSchema = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  const reachable = reachableDefs(schema, defs);
  return Object.keys(reachable).length ? { ...schema, $defs: reachable } : schema;
}

function byteLength(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Bounded tool schema. Prefers a fully inlined schema, then the `$defs`
 * form, then a truncated outline that names each argument group and points
 * at `operations.describe` for the full schema.
 */
export function boundedToolSchema(
  full: JsonSchema,
  maxBytes = OPENAPI_TOOL_SCHEMA_MAX_BYTES,
): { schema: JsonSchema; truncated: boolean } {
  const { $defs, ...rest } = full as JsonSchema & { $defs?: Record<string, JsonSchema> };
  if ($defs) {
    const inlined = inlineDefs(rest, $defs);
    if (inlined && byteLength(inlined) <= maxBytes) {
      return { schema: inlined as JsonSchema, truncated: false };
    }
  }
  if (byteLength(full) <= maxBytes) return { schema: full, truncated: false };
  const note = "Schema too large to list. Call operations.describe for the full schema.";
  const properties = recordValue(full.properties) ?? {};
  const outline: Record<string, unknown> = {};
  for (const [group, value] of Object.entries(properties)) {
    const groupSchemaValue = recordValue(value) ?? {};
    const small = { ...groupSchemaValue };
    delete small.$defs;
    outline[group] =
      group !== "body" && byteLength(small) <= maxBytes / 4 && !JSON.stringify(small).includes("#/$defs/")
        ? small
        : {
            ...(typeof groupSchemaValue.type === "string" ? { type: groupSchemaValue.type } : {}),
            description: note,
          };
  }
  const truncated: JsonSchema = {
    type: "object",
    properties: outline,
    required: Array.isArray(full.required) ? full.required : [],
    description: note,
    "x-truncated": true,
  };
  return byteLength(truncated) <= maxBytes
    ? { schema: truncated, truncated: true }
    : { schema: { type: "object", description: note, "x-truncated": true }, truncated: true };
}

export function encodeDefPointer(name: string) {
  return `#/$defs/${encodePointerToken(name)}`;
}

export function sha256Hex(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

/** RFC 7396 JSON merge patch (used for pinned entry overlays). */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const base: Record<string, unknown> =
    target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete base[key];
    else base[key] = applyMergePatch(base[key], value);
  }
  return base;
}

/** What agents send for a file: base64 content plus optional name and media type. */
export const FILE_UPLOAD_SCHEMA: JsonSchema = {
  type: "object",
  description: "File upload: base64-encoded content, with an optional file name and media type.",
  required: ["base64"],
  properties: {
    base64: { type: "string", description: "File content, base64-encoded." },
    filename: { type: "string", maxLength: 255 },
    contentType: { type: "string", maxLength: 255 },
  },
  additionalProperties: false,
  "x-file-upload": true,
};

/** `format: binary` (OAS 3.0 / Swagger file), or OAS 3.1 contentMediaType / contentEncoding. */
export function isBinarySchema(schema: unknown) {
  const record = recordValue(schema);
  if (!record) return false;
  return (
    record.format === "binary" ||
    (typeof record.contentMediaType === "string" && record.type !== "object" && record.type !== "array") ||
    typeof record.contentEncoding === "string"
  );
}

function fileAware(schema: unknown): unknown {
  if (isBinarySchema(schema)) return FILE_UPLOAD_SCHEMA;
  const record = recordValue(schema);
  if (record?.type === "array" && isBinarySchema(record.items)) return { ...record, items: FILE_UPLOAD_SCHEMA };
  return schema;
}

/**
 * Multipart and raw binary bodies: binary parts become the file object the
 * body builder sends (`{ base64, filename?, contentType? }`), so tool and
 * describe schemas and argument validation all agree on that shape.
 */
export function fileAwareBodySchema(contentType: string, schema: JsonSchema, defs: Record<string, JsonSchema>): JsonSchema {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  if (base === "application/octet-stream" || base.startsWith("image/") || base.startsWith("video/") || base.startsWith("audio/")) {
    // A raw binary body is one file (OAS 3.1 often gives no schema at all).
    return !Object.keys(schema).length || isBinarySchema(schema) ? FILE_UPLOAD_SCHEMA : schema;
  }
  if (base !== "multipart/form-data") return schema;
  let target = schema;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/$defs/")) {
    // Inline the referenced part schema so its binary properties can change.
    const name = decodePointerToken(schema.$ref.slice("#/$defs/".length));
    if (!name.includes("/") && defs[name]) target = { ...defs[name] };
  }
  const properties = recordValue(target.properties);
  if (!properties) return schema;
  const next = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, fileAware(value)]));
  return Object.values(next).some((value, index) => value !== Object.values(properties)[index])
    ? { ...target, properties: next }
    : schema;
}

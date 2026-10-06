/**
 * Company Box: curated connectors that expose a self-hosted app's ENTIRE
 * API toolkit, installed once per workspace and granted per agent.
 *
 * A catalog entry lives in `<catalog>/<id>/entry.json` next to a vendored,
 * sha256-pinned spec:
 * - `openapi`: an OpenAPI 3.x / Swagger 2.0 document. Marketplace hosts the
 *   REST adapter; every operation becomes one action.
 * - `mcp`: the app's official remote MCP server (URL template) plus a
 *   vendored `tools.json` snapshot. Installs reuse the custom remote MCP path.
 *
 * Nothing is dropped silently: an operation (or tool) is either exposed or
 * listed in `excluded` with a reason. The coverage report enforces it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  capabilityForTool,
  customMcpPluginId,
  deriveActionKeys,
} from "./custom-mcp.js";
import type { McpRemoteTool } from "./mcp-remote-client.js";
import { compileArgumentValidator, type ArgumentValidator } from "./openapi-validate.js";
import {
  applyMergePatch,
  boundedToolSchema,
  deriveOperationActionKeys,
  operationArgumentGroups,
  operationGroup,
  operationIdentity,
  operationInputSchema,
  operationPatternMatches,
  operationRisk,
  parameterNeedsArgument,
  READ_METHODS,
  READS_DOWNGRADABLE_METHODS,
  OPENAPI_DESCRIPTION_MAX,
  OPENAPI_SUMMARY_MAX,
  OPENAPI_TITLE_MAX,
  OpenApiSpecError,
  parseOpenApiDocument,
  sha256Hex,
  type JsonSchema,
  type OpenApiDocument,
  type OpenApiOperation,
} from "./openapi-adapter.js";
import { reservedParameterName, type OpenApiAuth } from "./openapi-http.js";
import type { ConnectorCapability, MarketplaceListing } from "./types.js";

export const COMPANY_BOX_COLLECTION = {
  id: "company-box",
  label: "Company Box",
  description:
    "Your self-hosted apps, whole. Each one installs once for the workspace with its full API, reached over your tailnet.",
} as const;

/** Operation count above which an entry switches to discovery exposure. */
export const COMPANY_BOX_DEFAULT_DIRECT_MAX_OPERATIONS = 64;
export const COMPANY_BOX_PLUGIN_PREFIX = "company-box-";
export const COMPANY_BOX_MCP_SLUG_PREFIX = "cb-";
export const COMPANY_BOX_SEARCH_DEFAULT_LIMIT = 25;
export const COMPANY_BOX_SEARCH_MAX_LIMIT = 100;
const MAX_SPEC_BYTES = 64 * 1024 * 1024;

export const DEFAULT_COMPANY_BOX_CATALOG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "catalog",
  "company-box",
);

export function companyBoxCatalogDir(env: Record<string, string | undefined> = process.env) {
  return env.MARKETPLACE_COMPANY_BOX_DIR?.trim() || DEFAULT_COMPANY_BOX_CATALOG_DIR;
}

export function companyBoxDirectMaxOperations(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.MARKETPLACE_COMPANY_BOX_DIRECT_MAX_OPERATIONS);
  return Number.isInteger(value) && value > 0 ? value : COMPANY_BOX_DEFAULT_DIRECT_MAX_OPERATIONS;
}

const ENTRY_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/u;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RELATIVE_FILE_PATTERN = /^[A-Za-z0-9._-]{1,120}$/u;

const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("header"),
      name: z.string().regex(HEADER_NAME_PATTERN),
      prefix: z.string().max(40).optional(),
      label: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z.object({ type: z.literal("basic") }).strict(),
  z
    .object({
      type: z.literal("query"),
      name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u),
      label: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
]);

const ExclusionSchema = z
  .object({
    /** operationId, `METHOD /path`, or (mcp) a tool name. Exact match. */
    operation: z.string().trim().min(1).max(300),
    /** Required; the coverage report fails on a missing or empty reason. */
    reason: z.string().max(500).optional(),
  })
  .strict();

export const CompanyBoxEntrySchema = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(ENTRY_ID_PATTERN),
    displayName: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    category: z.string().trim().max(40).optional(),
    app: z
      .object({
        /** Pinned upstream app version the spec was taken from. */
        version: z.string().trim().min(1).max(40),
        homepage: z.string().url().optional(),
        license: z.string().trim().max(60).optional(),
        specSource: z.string().url().optional(),
      })
      .strict(),
    source: z.enum(["openapi", "mcp"]),
    openapi: z
      .object({
        spec: z.string().regex(RELATIVE_FILE_PATTERN),
        sha256: z.string().regex(SHA256_PATTERN),
        /** Overrides the spec's basePath / server path. "" disables it. */
        basePath: z.string().max(200).optional(),
        /**
         * JSON merge patch (RFC 7396) applied to the vendored spec before it is
         * parsed, so supplements live outside the upstream file. Pinned too.
         */
        overlay: z
          .object({ file: z.string().regex(RELATIVE_FILE_PATTERN), sha256: z.string().regex(SHA256_PATTERN) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    mcp: z
      .object({
        /** `{baseUrl}` is replaced with the operator's base URL. */
        urlTemplate: z.string().min(1).max(500),
        transport: z.enum(["streamable-http", "sse"]).default("streamable-http"),
        tools: z.string().regex(RELATIVE_FILE_PATTERN),
        sha256: z.string().regex(SHA256_PATTERN),
      })
      .strict()
      .optional(),
    auth: AuthSchema,
    baseUrlExample: z.string().max(300).optional(),
    /** openapi: one safe GET operation (operationId or `GET /path`) used as the connection test. */
    healthOperation: z.string().trim().min(1).max(300).optional(),
    /** Patterns (`*` wildcard) for operations that reach outside the workspace. */
    outward: z.array(z.string().trim().min(1).max(300)).max(500).default([]),
    /** Patterns for destructive operations beyond DELETE. */
    destructive: z.array(z.string().trim().min(1).max(300)).max(500).default([]),
    /** Patterns for POST/PUT/… operations that only read (search, GraphQL queries). */
    reads: z.array(z.string().trim().min(1).max(300)).max(500).default([]),
    exposure: z.enum(["auto", "direct", "discovery"]).default("auto"),
    excluded: z.array(ExclusionSchema).max(5_000).default([]),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.source === "openapi" && !entry.openapi) {
      context.addIssue({ code: "custom", path: ["openapi"], message: "openapi entries need an openapi block" });
    }
    if (entry.source === "openapi" && !entry.healthOperation) {
      context.addIssue({ code: "custom", path: ["healthOperation"], message: "openapi entries need a healthOperation" });
    }
    if (entry.source === "mcp" && !entry.mcp) {
      context.addIssue({ code: "custom", path: ["mcp"], message: "mcp entries need an mcp block" });
    }
    if (entry.source === "mcp" && entry.auth.type === "query") {
      context.addIssue({ code: "custom", path: ["auth"], message: "mcp entries cannot send credentials in the URL" });
    }
    if (entry.mcp && !entry.mcp.urlTemplate.includes("{baseUrl}")) {
      context.addIssue({ code: "custom", path: ["mcp", "urlTemplate"], message: "urlTemplate must contain {baseUrl}" });
    }
  });

export type CompanyBoxEntry = z.infer<typeof CompanyBoxEntrySchema>;

export type CompanyBoxCredentialField = {
  key: "token" | "username" | "password" | "apiKey";
  label: string;
  secret: boolean;
};

/** Credential fields the install form asks for, derived from `auth`. */
export function credentialFieldsFor(auth: CompanyBoxEntry["auth"]): CompanyBoxCredentialField[] {
  switch (auth.type) {
    case "header":
      return [{ key: "token", label: auth.label ?? "API token", secret: true }];
    case "basic":
      return [
        { key: "username", label: "Username", secret: false },
        { key: "password", label: "Password", secret: true },
      ];
    case "query":
      return [{ key: "apiKey", label: auth.label ?? "API key", secret: true }];
    default:
      return [];
  }
}

export function runtimeAuthFor(auth: CompanyBoxEntry["auth"]): OpenApiAuth {
  switch (auth.type) {
    case "header":
      return { type: "header", name: auth.name, ...(auth.prefix ? { prefix: auth.prefix } : {}) };
    case "basic":
      return { type: "basic" };
    case "query":
      return { type: "query", name: auth.name };
    default:
      return { type: "none" };
  }
}

export type CompanyBoxRisk = {
  capability: ConnectorCapability;
  write: boolean;
  outward: boolean;
  destructive: boolean;
};

export type CompanyBoxOperation = CompanyBoxRisk & {
  key: string;
  ref: string;
  operationId: string | null;
  method: OpenApiOperation["method"];
  path: string;
  title: string;
  summary: string;
  description: string;
  tags: string[];
  /** Stable catalog group (first tag or path segment). */
  group: string;
  deprecated: boolean;
  argumentGroups: Array<"path" | "query" | "header" | "body">;
  operation: OpenApiOperation;
  inputSchema: JsonSchema;
  /** Strict schema check run before any request is built. */
  validateArguments: ArgumentValidator;
  toolSchema: JsonSchema;
  schemaTruncated: boolean;
};

export type CompanyBoxCoverageItem = {
  ref: string;
  method?: string;
  path?: string;
  status: "exposed" | "excluded" | "failed";
  key?: string;
  reason?: string;
  /** Excluded by the engine (not the entry), with an `auto:` reason. */
  auto?: boolean;
  capability?: ConnectorCapability;
  outward?: boolean;
  destructive?: boolean;
};

type CompiledBase = {
  entry: CompanyBoxEntry;
  dir: string;
  /** Every operation/tool in the vendored spec, with its coverage status. */
  coverage: CompanyBoxCoverageItem[];
  errors: string[];
  warnings: string[];
  exposure: "direct" | "discovery";
};

export type CompiledOpenApiEntry = CompiledBase & {
  kind: "openapi";
  pluginId: string;
  specSha256: string;
  spec: Pick<OpenApiDocument, "format" | "specVersion" | "title" | "apiVersion">;
  apiBasePath: string;
  operations: CompanyBoxOperation[];
  byKey: Map<string, CompanyBoxOperation>;
  healthOperation: CompanyBoxOperation | null;
};

export type CompanyBoxMcpTool = CompanyBoxRisk & {
  name: string;
  /** Full snapshot input schema (served by describe when the live one is too large to keep). */
  inputSchema: Record<string, unknown> | null;
  inputSchemaBytes: number;
  /** Action key for a sample workspace (keys are workspace-scoped at install). */
  sampleKey: string;
  title: string;
  description: string;
};

export type CompiledMcpEntry = CompiledBase & {
  kind: "mcp";
  snapshotSha256: string;
  server: { name: string; version: string } | null;
  tools: CompanyBoxMcpTool[];
  excludedToolNames: Set<string>;
};

export type CompiledCompanyBoxEntry = CompiledOpenApiEntry | CompiledMcpEntry;

export type CompanyBoxLoadError = { entry: string; code: string; message: string };

export function companyBoxPluginId(entryId: string) {
  return `${COMPANY_BOX_PLUGIN_PREFIX}${entryId}`;
}

/** Workspace-owned custom MCP connector id for an `mcp` entry. */
export function companyBoxMcpPluginId(entryId: string, workspaceSlug: string, displayName: string) {
  return customMcpPluginId({ workspaceSlug, slug: `${COMPANY_BOX_MCP_SLUG_PREFIX}${entryId}`, displayName });
}

function bounded(value: string | null | undefined, max: number) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function exclusionMatches(exclusion: string, operation: Pick<OpenApiOperation, "operationId" | "method" | "path">) {
  const trimmed = exclusion.trim();
  if (operation.operationId !== null && trimmed === operation.operationId) return true;
  const space = trimmed.indexOf(" ");
  if (space < 0) return false;
  return (
    trimmed.slice(0, space).toLowerCase() === operation.method &&
    trimmed.slice(space + 1).trim() === operation.path
  );
}

function exposureFor(entry: CompanyBoxEntry, count: number, directMax: number): "direct" | "discovery" {
  if (entry.exposure === "direct" || entry.exposure === "discovery") return entry.exposure;
  return count > directMax ? "discovery" : "direct";
}

function checkExclusions(
  entry: CompanyBoxEntry,
  matchedBy: Map<number, number>,
  errors: string[],
) {
  const seen = new Set<string>();
  entry.excluded.forEach((exclusion, index) => {
    if (!exclusion.reason?.trim()) {
      errors.push(`Exclusion "${exclusion.operation}" has no reason.`);
    }
    if (seen.has(exclusion.operation)) {
      errors.push(`Exclusion "${exclusion.operation}" is listed twice.`);
    }
    seen.add(exclusion.operation);
    if (!matchedBy.has(index)) {
      errors.push(`Exclusion "${exclusion.operation}" matches no operation in the pinned spec.`);
    }
  });
}

function readPinnedFile(dir: string, file: string, sha256: string) {
  const resolved = path.resolve(dir, file);
  if (path.dirname(resolved) !== path.resolve(dir)) throw new Error(`${file} must sit next to entry.json.`);
  const stat = fs.statSync(resolved);
  if (stat.size > MAX_SPEC_BYTES) throw new Error(`${file} is larger than ${MAX_SPEC_BYTES} bytes.`);
  const bytes = fs.readFileSync(resolved);
  const actual = sha256Hex(bytes);
  if (actual !== sha256) {
    throw new Error(`${file} does not match its pinned sha256 (expected ${sha256}, found ${actual}).`);
  }
  return { bytes, sha256: actual };
}

function compileOpenApi(
  entry: CompanyBoxEntry,
  dir: string,
  directMax: number,
): CompiledOpenApiEntry {
  const pluginId = companyBoxPluginId(entry.id);
  const pinned = readPinnedFile(dir, entry.openapi!.spec, entry.openapi!.sha256);
  let raw: unknown = JSON.parse(pinned.bytes.toString("utf8"));
  if (entry.openapi!.overlay) {
    const overlay = readPinnedFile(dir, entry.openapi!.overlay.file, entry.openapi!.overlay.sha256);
    raw = applyMergePatch(raw, JSON.parse(overlay.bytes.toString("utf8")));
  }
  const document = parseOpenApiDocument(raw);
  const errors: string[] = [];
  const warnings: string[] = [];
  // A declared parameter that carries the entry's own credential is dropped:
  // Marketplace sets it, callers never do.
  const authHeader =
    entry.auth.type === "header" ? entry.auth.name.toLowerCase() : entry.auth.type === "basic" ? "authorization" : null;
  const authQuery = entry.auth.type === "query" ? entry.auth.name.toLowerCase() : null;
  let droppedAuthParams = 0;
  for (const operation of document.operations) {
    const before = operation.parameters.length;
    operation.parameters = operation.parameters.filter(
      (parameter) =>
        !(
          (parameter.in === "header" && parameter.name.toLowerCase() === authHeader) ||
          (parameter.in === "query" && parameter.name.toLowerCase() === authQuery)
        ),
    );
    droppedAuthParams += before - operation.parameters.length;
  }
  if (droppedAuthParams) {
    warnings.push(`${droppedAuthParams} declared credential parameter(s) dropped; Marketplace sets the credential itself.`);
  }
  const matchedBy = new Map<number, number>();
  const excludedAt = new Map<number, string | undefined>();
  const autoExcluded = new Set<number>();
  document.operations.forEach((operation, index) => {
    entry.excluded.forEach((exclusion, exclusionIndex) => {
      if (exclusionMatches(exclusion.operation, operation)) {
        if (excludedAt.has(index)) {
          errors.push(`Operation ${operation.ref} is excluded more than once.`);
        }
        excludedAt.set(index, exclusion.reason);
        matchedBy.set(exclusionIndex, index);
      }
    });
  });
  checkExclusions(entry, matchedBy, errors);
  // Safe default: a GET/HEAD that declares a request body is never sent
  // (bodies on GET are dropped or rejected by proxies, so the call would not
  // do what the spec says). It is reported as an automatic exclusion.
  document.operations.forEach((operation, index) => {
    if ((operation.method === "get" || operation.method === "head") && operation.requestBody && !excludedAt.has(index)) {
      excludedAt.set(index, "auto: GET/HEAD operation with a request body; bodies are not sent on GET");
      autoExcluded.add(index);
    }
  });
  const exposedIndexes = document.operations.map((_operation, index) => index).filter((index) => !excludedAt.has(index));
  const keys = deriveOperationActionKeys(
    pluginId,
    exposedIndexes.map((index) => document.operations[index]!),
  );
  const patterns = { outward: entry.outward, destructive: entry.destructive, reads: entry.reads };
  const coverage: CompanyBoxCoverageItem[] = new Array(document.operations.length);
  const operations: CompanyBoxOperation[] = [];
  for (const [index, reason] of excludedAt) {
    const operation = document.operations[index]!;
    coverage[index] = {
      ref: operation.ref,
      method: operation.method.toUpperCase(),
      path: operation.path,
      status: "excluded",
      ...(reason ? { reason } : {}),
      ...(autoExcluded.has(index) ? { auto: true } : {}),
    };
  }
  exposedIndexes.forEach((index, position) => {
    const operation = document.operations[index]!;
    const key = keys[position]!;
    const risk = operationRisk(operation, patterns);
    try {
      const reserved = operation.parameters.find(
        (parameter) =>
          (parameter.in === "header" || parameter.in === "query") &&
          reservedParameterName(parameter.name, runtimeAuthFor(entry.auth)),
      );
      if (reserved) {
        throw new Error(`Parameter ${reserved.in} ${reserved.name} is a reserved name (method override or credential).`);
      }
      const overwrite = operation.parameters.find(
        (parameter) => parameter.in === "header" && parameter.name.toLowerCase() === "overwrite",
      );
      if (overwrite && "default" in overwrite.schema && overwrite.schema.default !== "F") {
        throw new Error("An Overwrite header default must be F; overwriting must be asked for explicitly.");
      }
      const destination = operation.parameters.find(
        (parameter) => parameter.in === "header" && parameter.name.toLowerCase() === "destination",
      );
      if (destination && !destination.destinationTemplate) {
        throw new Error("A Destination header needs x-destination-template; Marketplace never forwards a caller-supplied URL.");
      }
      const inputSchema = operationInputSchema(operation, document.defs);
      const tool = boundedToolSchema(inputSchema);
      const validateArguments = compileArgumentValidator(inputSchema);
      const compiled: CompanyBoxOperation = {
        key,
        ref: operation.ref,
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        title: bounded(operation.summary ?? operation.operationId ?? operationIdentity(operation.method, operation.path), OPENAPI_TITLE_MAX),
        summary: bounded(operation.summary ?? operation.description ?? "", OPENAPI_SUMMARY_MAX),
        description: operation.description ?? operation.summary ?? "",
        tags: operation.tags,
        group: operationGroup(operation),
        deprecated: operation.deprecated,
        argumentGroups: operationArgumentGroups(operation),
        operation,
        inputSchema,
        validateArguments,
        toolSchema: tool.schema,
        schemaTruncated: tool.truncated,
        ...risk,
      };
      operations.push(compiled);
      coverage[index] = {
        ref: operation.ref,
        method: operation.method.toUpperCase(),
        path: operation.path,
        status: "exposed",
        key,
        capability: risk.capability,
        outward: risk.outward,
        destructive: risk.destructive,
      };
      if (operation.unsupportedParameters.length) {
        warnings.push(
          `${operation.ref}: ${operation.unsupportedParameters.map((parameter) => `${parameter.in} parameter ${parameter.name}`).join(", ")} cannot be sent.`,
        );
      }
    } catch (error) {
      coverage[index] = {
        ref: operation.ref,
        method: operation.method.toUpperCase(),
        path: operation.path,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
      errors.push(`${operation.ref}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  for (const [kind, list] of [["outward", entry.outward], ["destructive", entry.destructive], ["reads", entry.reads]] as const) {
    for (const pattern of list) {
      if (!document.operations.some((operation) => operationPatternMatches(pattern, operation))) {
        warnings.push(`${kind} pattern "${pattern}" matches no operation.`);
      }
    }
  }
  for (const pattern of entry.reads) {
    for (const operation of document.operations) {
      if (
        operationPatternMatches(pattern, operation) &&
        !READ_METHODS.has(operation.method) &&
        !READS_DOWNGRADABLE_METHODS.has(operation.method)
      ) {
        warnings.push(
          `reads pattern "${pattern}" ignored for ${operationIdentity(operation.method, operation.path)}: only POST can be read-class.`,
        );
      }
    }
  }
  const byKey = new Map(operations.map((operation) => [operation.key, operation]));
  const health = entry.healthOperation
    ? (operations.find((operation) => exclusionMatches(entry.healthOperation!, operation.operation)) ?? null)
    : null;
  if (!health) {
    errors.push(`healthOperation "${entry.healthOperation}" is not an exposed operation.`);
  } else if (!READ_METHODS.has(health.method)) {
    errors.push(`healthOperation "${entry.healthOperation}" must be a read (GET, HEAD, PROPFIND, …) operation.`);
  } else if (health.operation.parameters.some(parameterNeedsArgument) || health.operation.requestBody?.required) {
    errors.push(`healthOperation "${entry.healthOperation}" must not need arguments.`);
  }
  const apiBasePath = (entry.openapi!.basePath ?? document.basePath).replace(/\/+$/u, "");
  return {
    kind: "openapi",
    entry,
    dir,
    pluginId,
    specSha256: pinned.sha256,
    spec: {
      format: document.format,
      specVersion: document.specVersion,
      title: document.title,
      apiVersion: document.apiVersion,
    },
    apiBasePath: apiBasePath && !apiBasePath.startsWith("/") ? `/${apiBasePath}` : apiBasePath,
    operations,
    byKey,
    healthOperation: health,
    coverage,
    errors,
    warnings,
    exposure: exposureFor(entry, operations.length, directMax),
  };
}

const ToolsSnapshotSchema = z
  .object({
    server: z.object({ name: z.string(), version: z.string() }).partial().optional(),
    capturedAt: z.string().optional(),
    tools: z.array(
      z
        .object({
          name: z.string().min(1).max(200),
          title: z.string().optional(),
          description: z.string().optional(),
          inputSchema: z.unknown().optional(),
          annotations: z.record(z.unknown()).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Tool name → risk for an `mcp` entry (annotations, then entry patterns). */
export function companyBoxMcpToolRisk(
  entry: Pick<CompanyBoxEntry, "outward" | "destructive" | "reads">,
  tool: Pick<McpRemoteTool, "name" | "annotations">,
  actionSegment: string,
): CompanyBoxRisk {
  const asOperation = { operationId: tool.name, method: "post" as const, path: "" };
  const destructivePattern = entry.destructive.some((pattern) => operationPatternMatches(pattern, asOperation));
  const readPattern = (entry.reads ?? []).some((pattern) => operationPatternMatches(pattern, asOperation));
  const capability = destructivePattern
    ? "connector.admin"
    : readPattern
      ? "connector.observe"
      : capabilityForTool(tool, actionSegment);
  return {
    capability,
    write: capability !== "connector.observe",
    outward: entry.outward.some((pattern) => operationPatternMatches(pattern, asOperation)),
    destructive: capability === "connector.admin",
  };
}

function compileMcp(entry: CompanyBoxEntry, dir: string, directMax: number): CompiledMcpEntry {
  const pinned = readPinnedFile(dir, entry.mcp!.tools, entry.mcp!.sha256);
  const snapshot = ToolsSnapshotSchema.parse(JSON.parse(pinned.bytes.toString("utf8")));
  const errors: string[] = [];
  const warnings: string[] = [];
  const matchedBy = new Map<number, number>();
  const excludedAt = new Map<number, string | undefined>();
  const names = new Set<string>();
  snapshot.tools.forEach((tool, index) => {
    if (names.has(tool.name)) errors.push(`Tool ${tool.name} appears twice in the snapshot.`);
    names.add(tool.name);
    entry.excluded.forEach((exclusion, exclusionIndex) => {
      if (exclusion.operation === tool.name) {
        excludedAt.set(index, exclusion.reason);
        matchedBy.set(exclusionIndex, index);
      }
    });
  });
  checkExclusions(entry, matchedBy, errors);
  const sampleProvider = companyBoxMcpPluginId(entry.id, "workspace", entry.displayName);
  const exposedIndexes = snapshot.tools.map((_tool, index) => index).filter((index) => !excludedAt.has(index));
  const keys = deriveActionKeys(
    sampleProvider,
    exposedIndexes.map((index) => snapshot.tools[index]!.name),
  );
  const coverage: CompanyBoxCoverageItem[] = new Array(snapshot.tools.length);
  for (const [index, reason] of excludedAt) {
    coverage[index] = { ref: snapshot.tools[index]!.name, status: "excluded", ...(reason ? { reason } : {}) };
  }
  const tools: CompanyBoxMcpTool[] = exposedIndexes.map((index, position) => {
    const tool = snapshot.tools[index]!;
    const key = keys[position]!;
    const risk = companyBoxMcpToolRisk(entry, tool, key.slice(sampleProvider.length + 1));
    coverage[index] = {
      ref: tool.name,
      status: "exposed",
      key,
      capability: risk.capability,
      outward: risk.outward,
      destructive: risk.destructive,
    };
    const schema =
      tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
        ? (tool.inputSchema as Record<string, unknown>)
        : null;
    return {
      name: tool.name,
      inputSchema: schema,
      inputSchemaBytes: schema ? Buffer.byteLength(JSON.stringify(schema)) : 0,
      sampleKey: key,
      title: bounded(tool.title ?? tool.name, OPENAPI_TITLE_MAX),
      description: bounded(tool.description ?? "", OPENAPI_DESCRIPTION_MAX),
      ...risk,
    };
  });
  for (const [kind, list] of [["outward", entry.outward], ["destructive", entry.destructive], ["reads", entry.reads]] as const) {
    for (const pattern of list) {
      if (!snapshot.tools.some((tool) => operationPatternMatches(pattern, { operationId: tool.name, method: "post", path: "" }))) {
        warnings.push(`${kind} pattern "${pattern}" matches no tool.`);
      }
    }
  }
  const server = snapshot.server?.name ? { name: snapshot.server.name, version: snapshot.server.version ?? "" } : null;
  return {
    kind: "mcp",
    entry,
    dir,
    snapshotSha256: pinned.sha256,
    server,
    tools,
    excludedToolNames: new Set(
      entry.excluded.map((exclusion) => exclusion.operation).filter((name) => names.has(name)),
    ),
    coverage,
    errors,
    warnings,
    exposure: exposureFor(entry, tools.length, directMax),
  };
}

export function compileCompanyBoxEntry(
  dir: string,
  options: { directMaxOperations?: number } = {},
): CompiledCompanyBoxEntry {
  const entry = CompanyBoxEntrySchema.parse(
    JSON.parse(fs.readFileSync(path.join(dir, "entry.json"), "utf8")),
  );
  if (path.basename(dir) !== entry.id) {
    throw new Error(`entry.json id "${entry.id}" must match its directory name.`);
  }
  const directMax = options.directMaxOperations ?? COMPANY_BOX_DEFAULT_DIRECT_MAX_OPERATIONS;
  return entry.source === "openapi" ? compileOpenApi(entry, dir, directMax) : compileMcp(entry, dir, directMax);
}

function loadErrorCode(error: unknown) {
  if (error instanceof OpenApiSpecError) return error.code;
  if (error instanceof z.ZodError) return "company_box_entry_invalid";
  if (error instanceof SyntaxError) return "company_box_json_invalid";
  return "company_box_entry_unreadable";
}

function loadErrorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

/** The compiled catalog: entries by id plus per-entry load errors. */
export class CompanyBoxCatalog {
  readonly entries: CompiledCompanyBoxEntry[];
  readonly loadErrors: CompanyBoxLoadError[];
  private readonly byId: Map<string, CompiledCompanyBoxEntry>;
  private readonly byPluginId: Map<string, CompiledOpenApiEntry>;

  constructor(
    readonly dir: string,
    entries: CompiledCompanyBoxEntry[],
    loadErrors: CompanyBoxLoadError[],
  ) {
    this.entries = [...entries].sort((left, right) => left.entry.displayName.localeCompare(right.entry.displayName));
    this.loadErrors = loadErrors;
    this.byId = new Map(entries.map((entry) => [entry.entry.id, entry]));
    this.byPluginId = new Map(
      entries.flatMap((entry) => (entry.kind === "openapi" ? [[entry.pluginId, entry] as const] : [])),
    );
  }

  static empty() {
    return new CompanyBoxCatalog("", [], []);
  }

  get(entryId: string) {
    return this.byId.get(entryId) ?? null;
  }

  /** Usable entries: compiled with no errors. */
  usable() {
    return this.entries.filter((entry) => entry.errors.length === 0);
  }

  openApiForPluginId(pluginId: string) {
    const entry = this.byPluginId.get(pluginId);
    return entry && entry.errors.length === 0 ? entry : null;
  }
}

export function loadCompanyBoxCatalog(
  dir: string,
  options: { directMaxOperations?: number } = {},
): CompanyBoxCatalog {
  if (!dir || !fs.existsSync(dir)) return new CompanyBoxCatalog(dir, [], []);
  const entries: CompiledCompanyBoxEntry[] = [];
  const loadErrors: CompanyBoxLoadError[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const entryDir = path.join(dir, name);
    if (!fs.statSync(entryDir).isDirectory() || !fs.existsSync(path.join(entryDir, "entry.json"))) continue;
    try {
      entries.push(compileCompanyBoxEntry(entryDir, options));
    } catch (error) {
      loadErrors.push({ entry: name, code: loadErrorCode(error), message: loadErrorMessage(error) });
    }
  }
  return new CompanyBoxCatalog(dir, entries, loadErrors);
}

/** Operation summaries stored in the listing manifest (no schemas). */
export type CompanyBoxOperationSummary = {
  key: string;
  ref: string;
  method: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  group: string;
  capability: ConnectorCapability;
  outward: boolean;
  destructive: boolean;
  args: Array<"path" | "query" | "header" | "body">;
};

export type CompanyBoxListingManifest = {
  entryId: string;
  collection: typeof COMPANY_BOX_COLLECTION.id;
  source: "openapi";
  specSha256: string;
  appVersion: string;
  exposure: "direct" | "discovery";
  operationCount: number;
  excludedCount: number;
  operations: CompanyBoxOperationSummary[];
};

export function companyBoxListing(compiled: CompiledOpenApiEntry, createdAt?: string): MarketplaceListing {
  const now = new Date().toISOString();
  const { entry, pluginId } = compiled;
  const capabilities = (["connector.observe", "connector.dispatch", "connector.admin"] as const).filter(
    (capability) => compiled.operations.some((operation) => operation.capability === capability),
  );
  const manifest: CompanyBoxListingManifest = {
    entryId: entry.id,
    collection: COMPANY_BOX_COLLECTION.id,
    source: "openapi",
    specSha256: compiled.specSha256,
    appVersion: entry.app.version,
    exposure: compiled.exposure,
    operationCount: compiled.operations.length,
    excludedCount: compiled.coverage.filter((item) => item.status === "excluded").length,
    operations: compiled.operations.map((operation) => ({
      key: operation.key,
      ref: operation.ref,
      method: operation.method.toUpperCase(),
      path: operation.path,
      title: operation.title,
      summary: operation.summary,
      tags: operation.tags,
      group: operation.group,
      capability: operation.capability,
      outward: operation.outward,
      destructive: operation.destructive,
      args: operation.argumentGroups,
    })),
  };
  return {
    pluginId,
    displayName: entry.displayName,
    kind: "toolset",
    provider: pluginId,
    description: entry.description,
    capabilities,
    actions: compiled.operations.map((operation) => operation.key),
    source: "openapi",
    authOwner: "program",
    executionOwner: "openapi",
    runtimeSources: [
      {
        runtimeSourceId: `${pluginId}-openapi`,
        kind: "native-api",
        label: "Company Box REST adapter",
        primary: true,
      },
    ],
    enabledByDefault: false,
    manifest: {
      version: entry.app.version,
      kind: "plugin",
      collection: COMPANY_BOX_COLLECTION.id,
      actionRequirements: Object.fromEntries(
        compiled.operations.map((operation) => [operation.key, { kind: pluginId, capability: operation.capability }]),
      ),
      companyBox: manifest,
    },
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

/** A listing whose Company Box entry is gone or broken: kept, but with no actions. */
export function retiredCompanyBoxListing(listing: MarketplaceListing): MarketplaceListing {
  return {
    ...listing,
    capabilities: [],
    actions: [],
    manifest: { ...listing.manifest, actionRequirements: {}, companyBox: { ...companyBoxManifest(listing), operations: [], operationCount: 0, retired: true } },
    updatedAt: new Date().toISOString(),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function listingIsCompanyBoxOpenApi(listing: MarketplaceListing) {
  return (
    listing.source === "openapi" &&
    listing.executionOwner === "openapi" &&
    listing.pluginId.startsWith(COMPANY_BOX_PLUGIN_PREFIX) &&
    recordValue(listing.manifest.companyBox) !== null
  );
}

export function companyBoxManifest(listing: MarketplaceListing): CompanyBoxListingManifest {
  const raw = recordValue(listing.manifest.companyBox) ?? {};
  return {
    entryId: typeof raw.entryId === "string" ? raw.entryId : "",
    collection: COMPANY_BOX_COLLECTION.id,
    source: "openapi",
    specSha256: typeof raw.specSha256 === "string" ? raw.specSha256 : "",
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
    exposure: raw.exposure === "discovery" ? "discovery" : "direct",
    operationCount: typeof raw.operationCount === "number" ? raw.operationCount : 0,
    excludedCount: typeof raw.excludedCount === "number" ? raw.excludedCount : 0,
    operations: (Array.isArray(raw.operations) ? raw.operations : []).flatMap((value) => {
      const operation = recordValue(value);
      if (!operation || typeof operation.key !== "string") return [];
      return [operation as unknown as CompanyBoxOperationSummary];
    }),
  };
}

export function companyBoxOperationSummary(listing: MarketplaceListing, actionKey: string) {
  return companyBoxManifest(listing).operations.find((operation) => operation.key === actionKey) ?? null;
}

/** Fill an `mcp` entry's URL template with the operator's base URL. */
export function companyBoxMcpUrl(entry: CompanyBoxEntry, baseUrl: string) {
  return entry.mcp!.urlTemplate.split("{baseUrl}").join(baseUrl.replace(/\/+$/u, ""));
}

/** Secret header an `mcp` entry sends, built from the credential fields. */
export function companyBoxMcpSecretHeader(
  entry: CompanyBoxEntry,
  credentials: Record<string, string>,
): { name: string; value: string } | null {
  if (entry.auth.type === "header" && credentials.token) {
    return { name: entry.auth.name.toLowerCase(), value: `${entry.auth.prefix ?? ""}${credentials.token}` };
  }
  if (entry.auth.type === "basic" && credentials.username !== undefined && credentials.password !== undefined) {
    return {
      name: "authorization",
      value: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
    };
  }
  return null;
}

/** One searchable/describable operation, for both openapi and mcp listings. */
export type AgentOperation = {
  key: string;
  title: string;
  summary: string;
  tags: string[];
  group: string;
  capability: ConnectorCapability;
  outward: boolean;
  destructive: boolean;
};

export function searchAgentOperations(
  operations: readonly AgentOperation[],
  input: { query?: string; tag?: string; capability?: ConnectorCapability; cursor?: string; limit?: number },
) {
  const terms = (input.query ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  const tag = input.tag?.trim().toLowerCase();
  const filtered = operations.filter((operation) => {
    if (tag && operation.group !== tag && !operation.tags.some((value) => value.toLowerCase() === tag)) return false;
    if (input.capability && operation.capability !== input.capability) return false;
    if (!terms.length) return true;
    const haystack = `${operation.key} ${operation.title} ${operation.summary} ${operation.group} ${operation.tags.join(" ")}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  const offset = input.cursor && /^\d{1,7}$/u.test(input.cursor) ? Number(input.cursor) : 0;
  const limit = Math.min(Math.max(input.limit ?? COMPANY_BOX_SEARCH_DEFAULT_LIMIT, 1), COMPANY_BOX_SEARCH_MAX_LIMIT);
  const page = filtered.slice(offset, offset + limit);
  return {
    total: filtered.length,
    offset,
    limit,
    nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
    operations: page,
  };
}

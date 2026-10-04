/**
 * Operator custom MCP connectors: request schemas, header validation,
 * listing construction, tool → action derivation, and browser-safe views.
 *
 * Secret header values never enter the listing manifest; they live in the
 * encrypted connector_secret table and are attached to outbound requests only.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import {
  inferConnectorCapabilityFromAction,
  normalizeConnectorSlug,
} from "./connectors.js";
import { listingIsOperatorCustomMcp } from "./hub.js";
import type { McpRemoteTool, McpTransport } from "./mcp-remote-client.js";
import type { SqliteMarketplaceStore } from "./store.js";
import type { ConnectorCapability, MarketplaceListing } from "./types.js";

export { listingIsOperatorCustomMcp };

export const CUSTOM_MCP_MAX_HEADERS = 20;
export const CUSTOM_MCP_MAX_SECRET_HEADERS = 10;
const MAX_HEADER_VALUE_LENGTH = 4_096;
const MAX_INPUT_SCHEMA_BYTES = 16_384;
const MAX_TOOL_DESCRIPTION = 1_000;
const MAX_TOOL_TITLE = 200;
const MAX_ACTION_KEY_LENGTH = 128;
const ACTION_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,7}$/u;

/** Fields that would turn a remote connector into a local process. */
export const STDIO_ONLY_FIELDS = ["command", "args", "env", "cwd"] as const;

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;
// Transport-owned or hop-by-hop headers an operator may not override.
const RESERVED_HEADER_NAMES = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class CustomMcpInputError extends Error {
  constructor(
    readonly code:
      | "custom_mcp_header_invalid"
      | "custom_mcp_header_conflict"
      | "custom_mcp_header_limit",
    readonly field?: string,
  ) {
    super(code);
  }
}

const TransportSchema = z.enum(["streamable-http", "sse"]);

export const CustomMcpCreateSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(500).optional(),
  transport: TransportSchema.default("streamable-http"),
  url: z.string().trim().min(1).max(2_048),
  headers: z.record(z.string()).optional(),
  secretHeaders: z.record(z.string()).optional(),
});

export const CustomMcpPatchSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  transport: TransportSchema.optional(),
  url: z.string().trim().min(1).max(2_048).optional(),
  headers: z.record(z.string()).optional(),
  /** string = set/replace, null = remove, omitted = keep. */
  secretHeaders: z.record(z.string().nullable()).optional(),
});

/** True when the request body asks for a local (stdio) MCP process. */
export function requestsStdioTransport(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return (
    record.transport === "stdio" ||
    STDIO_ONLY_FIELDS.some((field) => field in record)
  );
}

function normalizeHeaderName(name: string, field: string) {
  const trimmed = name.trim();
  if (!HEADER_NAME_PATTERN.test(trimmed)) {
    throw new CustomMcpInputError("custom_mcp_header_invalid", field);
  }
  const lower = trimmed.toLowerCase();
  if (RESERVED_HEADER_NAMES.has(lower) || lower.startsWith("proxy-")) {
    throw new CustomMcpInputError("custom_mcp_header_invalid", field);
  }
  return lower;
}

function validHeaderValue(value: string) {
  return (
    value.length <= MAX_HEADER_VALUE_LENGTH &&
    // Visible ASCII/Latin-1 plus space and tab; no CR, LF, or NUL.
    /^[\t\x20-\x7e\x80-\xff]*$/u.test(value)
  );
}

/** Validate and lowercase a plain (non-secret) header map. */
export function normalizePlainHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const entries = Object.entries(headers ?? {});
  if (entries.length > CUSTOM_MCP_MAX_HEADERS) {
    throw new CustomMcpInputError("custom_mcp_header_limit", "headers");
  }
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    const key = normalizeHeaderName(name, "headers");
    const trimmed = value.trim();
    if (!validHeaderValue(trimmed) || key in normalized) {
      throw new CustomMcpInputError("custom_mcp_header_invalid", "headers");
    }
    normalized[key] = trimmed;
  }
  return normalized;
}

/** Validate secret header changes. `null` values mean "remove". */
export function normalizeSecretHeaderChanges(
  headers: Record<string, string | null> | undefined,
): Map<string, string | null> {
  const changes = new Map<string, string | null>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = normalizeHeaderName(name, "secretHeaders");
    if (changes.has(key)) {
      throw new CustomMcpInputError("custom_mcp_header_invalid", "secretHeaders");
    }
    if (value === null) {
      changes.set(key, null);
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || !validHeaderValue(trimmed)) {
      throw new CustomMcpInputError("custom_mcp_header_invalid", "secretHeaders");
    }
    changes.set(key, trimmed);
  }
  return changes;
}

export function assertHeaderSets(input: {
  plainNames: Iterable<string>;
  secretNames: Iterable<string>;
}) {
  const plain = new Set(input.plainNames);
  const secret = [...new Set(input.secretNames)];
  if (secret.length > CUSTOM_MCP_MAX_SECRET_HEADERS) {
    throw new CustomMcpInputError("custom_mcp_header_limit", "secretHeaders");
  }
  if (secret.some((name) => plain.has(name))) {
    throw new CustomMcpInputError("custom_mcp_header_conflict");
  }
}

export function workspaceHash(workspaceSlug: string) {
  return createHash("sha256").update(workspaceSlug).digest("hex").slice(0, 8);
}

/** `mcp-<slug>-<first 8 hex of sha256(workspaceSlug)>`; no dots, ever. */
export function customMcpPluginId(input: {
  workspaceSlug: string;
  slug?: string;
  displayName: string;
}) {
  let slug = normalizeConnectorSlug(input.slug ?? input.displayName);
  if (!slug) slug = "connector";
  if (!/^[a-z]/u.test(slug)) slug = `c-${slug}`;
  slug = slug.slice(0, 40).replace(/-+$/u, "");
  return `mcp-${slug}-${workspaceHash(input.workspaceSlug)}`;
}

export function displayUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

export type CustomMcpToolRecord = {
  name: string;
  action: string;
  title?: string;
  description?: string;
  capability: ConnectorCapability;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
};

export type CustomMcpLastRefresh = {
  at: string;
  ok: boolean;
  errorCode: string | null;
};

export type CustomMcpManifest = {
  operatorManaged: true;
  transport: McpTransport;
  url: string;
  headers: Record<string, string>;
  tools: CustomMcpToolRecord[];
  lastRefresh: CustomMcpLastRefresh | null;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isCapability(value: unknown): value is ConnectorCapability {
  return (
    value === "connector.observe" ||
    value === "connector.dispatch" ||
    value === "connector.admin"
  );
}

export function customMcpManifest(listing: MarketplaceListing): CustomMcpManifest {
  const mcp = recordValue(listing.manifest.mcp) ?? {};
  const headers = recordValue(mcp.headers) ?? {};
  const lastRefresh = recordValue(mcp.lastRefresh);
  return {
    operatorManaged: true,
    transport: mcp.transport === "sse" ? "sse" : "streamable-http",
    url: typeof mcp.url === "string" ? mcp.url : "",
    headers: Object.fromEntries(
      Object.entries(headers).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    tools: (Array.isArray(mcp.tools) ? mcp.tools : []).flatMap((entry) => {
      const tool = recordValue(entry);
      if (
        !tool ||
        typeof tool.name !== "string" ||
        typeof tool.action !== "string" ||
        !isCapability(tool.capability)
      ) {
        return [];
      }
      return [
        {
          name: tool.name,
          action: tool.action,
          ...(typeof tool.title === "string" ? { title: tool.title } : {}),
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          capability: tool.capability,
          inputSchema: recordValue(tool.inputSchema) ?? { type: "object" },
          annotations: recordValue(tool.annotations) ?? {},
        },
      ];
    }),
    lastRefresh: lastRefresh
      ? {
          at: String(lastRefresh.at ?? ""),
          ok: lastRefresh.ok === true,
          errorCode:
            typeof lastRefresh.errorCode === "string" ? lastRefresh.errorCode : null,
        }
      : null,
  };
}

/** Build (or rebuild) the listing; tools/actions derive from `manifest.tools`. */
export function customMcpListing(input: {
  pluginId: string;
  workspaceSlug: string;
  displayName: string;
  description?: string;
  manifest: CustomMcpManifest;
  version?: string;
  createdAt?: string;
}): MarketplaceListing {
  const now = new Date().toISOString();
  const { manifest } = input;
  const capabilities = (
    ["connector.observe", "connector.dispatch", "connector.admin"] as const
  ).filter((capability) =>
    manifest.tools.some((tool) => tool.capability === capability),
  );
  return {
    pluginId: input.pluginId,
    displayName: input.displayName,
    kind: "toolset",
    provider: input.pluginId,
    description:
      input.description?.trim() || "Custom connector using a remote MCP server.",
    capabilities,
    actions: manifest.tools.map((tool) => tool.action),
    source: "mcp",
    authOwner: "program",
    executionOwner: "mcp",
    runtimeSources: [
      {
        runtimeSourceId: `${input.pluginId}-mcp`,
        kind: "mcp",
        label: "Custom MCP server",
        primary: true,
        mcpServerId: input.pluginId,
      },
    ],
    enabledByDefault: false,
    ownerWorkspaceSlug: input.workspaceSlug,
    manifest: {
      version: input.version ?? "0.1.0",
      kind: "plugin",
      actionRequirements: Object.fromEntries(
        manifest.tools.map((tool) => [
          tool.action,
          { kind: input.pluginId, capability: tool.capability },
        ]),
      ),
      mcp: manifest,
      skillsHub: {
        custom: true,
        operatorManaged: true,
        required: false,
        unitId: input.pluginId,
        contributions: [],
        adapter: {
          type: "mcp",
          // Origin + path only: a query string may carry credentials.
          mcp: { transport: manifest.transport, url: displayUrl(manifest.url), config: {} },
        },
      },
    },
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

function actionSegment(name: string) {
  let segment = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!segment) segment = "tool";
  if (!/^[a-z]/u.test(segment)) segment = `tool-${segment}`;
  return segment;
}

/**
 * Action key rule: `<provider>.<tool name lowercased, runs of non [a-z0-9]
 * → "-", trimmed>`, prefixed `tool-` when it does not start with a letter,
 * truncated to 128 chars, and suffixed `-2`, `-3`, … on collision.
 */
export function deriveActionKeys(provider: string, toolNames: readonly string[]) {
  const used = new Set<string>();
  const budget = MAX_ACTION_KEY_LENGTH - provider.length - 1 - 4;
  return toolNames.map((name) => {
    const base = actionSegment(name).slice(0, Math.max(1, budget)).replace(/-+$/u, "");
    let candidate = `${provider}.${base}`;
    for (let suffix = 2; used.has(candidate); suffix += 1) {
      candidate = `${provider}.${base}-${suffix}`;
    }
    if (!ACTION_KEY_PATTERN.test(candidate) || candidate.length > MAX_ACTION_KEY_LENGTH) {
      throw new Error(`Derived action key ${candidate} is invalid.`);
    }
    used.add(candidate);
    return candidate;
  });
}

/**
 * Capability rule: `readOnlyHint: true` → observe; `destructiveHint: true` →
 * admin; any other explicit hint → dispatch; no hints → infer from the tool
 * segment of the action key (inferConnectorCapabilityFromAction).
 */
export function capabilityForTool(
  tool: Pick<McpRemoteTool, "annotations">,
  actionSegmentValue: string,
): ConnectorCapability {
  const annotations = tool.annotations ?? {};
  if (annotations.readOnlyHint === true) return "connector.observe";
  if (annotations.destructiveHint === true) return "connector.admin";
  if (
    typeof annotations.readOnlyHint === "boolean" ||
    typeof annotations.destructiveHint === "boolean"
  ) {
    return "connector.dispatch";
  }
  return inferConnectorCapabilityFromAction(actionSegmentValue);
}

function boundedText(value: string | undefined, max: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function toolRecordsFromRemote(
  provider: string,
  tools: readonly McpRemoteTool[],
): CustomMcpToolRecord[] {
  const actions = deriveActionKeys(
    provider,
    tools.map((tool) => tool.name),
  );
  return tools.map((tool, index) => {
    const action = actions[index]!;
    const schema = recordValue(tool.inputSchema);
    const schemaJson = schema ? JSON.stringify(schema) : "";
    const annotations = recordValue(tool.annotations) ?? {};
    const title = boundedText(tool.title, MAX_TOOL_TITLE) ??
      boundedText(typeof annotations.title === "string" ? annotations.title : undefined, MAX_TOOL_TITLE);
    const description = boundedText(tool.description, MAX_TOOL_DESCRIPTION);
    return {
      name: tool.name,
      action,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      capability: capabilityForTool(tool, action.slice(provider.length + 1)),
      inputSchema:
        schema && Buffer.byteLength(schemaJson) <= MAX_INPUT_SCHEMA_BYTES
          ? schema
          : { type: "object" },
      annotations: Object.fromEntries(
        Object.entries(annotations).filter(
          ([key, value]) =>
            ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].includes(key) &&
            typeof value === "boolean",
        ),
      ),
    };
  });
}

export function customMcpToolForAction(
  listing: MarketplaceListing,
  action: string,
): CustomMcpToolRecord | null {
  return customMcpManifest(listing).tools.find((tool) => tool.action === action) ?? null;
}

/** Browser-safe projection. Never includes secret values or the full URL. */
export function customConnectorView(
  store: SqliteMarketplaceStore,
  workspaceSlug: string,
  listing: MarketplaceListing,
) {
  const manifest = customMcpManifest(listing);
  const install = store.getInstall(workspaceSlug, listing.pluginId);
  const connection = store.getConnection(workspaceSlug, listing.pluginId);
  return {
    pluginId: listing.pluginId,
    displayName: listing.displayName,
    description: listing.description,
    transport: manifest.transport,
    url: displayUrl(manifest.url),
    headers: Object.entries(manifest.headers).map(([name, value]) => ({ name, value })),
    secretHeaders: store
      .listConnectorSecrets({ workspaceSlug, pluginId: listing.pluginId })
      .map((secret) => ({ name: secret.name, configured: true, fingerprint: secret.fingerprint })),
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      action: tool.action,
      title: tool.title ?? null,
      description: tool.description ?? null,
      capability: tool.capability,
    })),
    lastRefresh: manifest.lastRefresh,
    install: {
      installed: install?.lifecycle === "installed",
      enabled: install?.lifecycle === "installed" && install.enabled,
      lifecycle: install?.lifecycle ?? null,
    },
    connection: connection
      ? { state: connection.state, detail: connection.detail, updatedAt: connection.updatedAt }
      : null,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
  };
}

/** Bind a custom connector's capabilities and actions the way Hub install does, keeping operator choices. */
export function bindCustomMcpForWorkspace(
  store: SqliteMarketplaceStore,
  workspaceSlug: string,
  listing: MarketplaceListing,
) {
  store.registerPlugin(listing.pluginId);
  for (const capability of listing.capabilities) {
    if (!store.getCapabilityBinding(workspaceSlug, listing.pluginId, capability)) {
      store.bindCapability({ workspaceSlug, pluginId: listing.pluginId, capability, enabled: true });
    }
  }
  for (const actionKey of listing.actions) {
    if (!store.getActionBinding(workspaceSlug, listing.pluginId, actionKey)) {
      store.bindAction({ workspaceSlug, pluginId: listing.pluginId, actionKey, enabled: true });
    }
  }
}

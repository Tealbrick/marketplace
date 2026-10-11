import { randomUUID } from "node:crypto";

import { composioToolClassification } from "./composio-policy.js";
import type {
  ConnectorCapability,
  ConnectorKind,
  MarketplaceListing,
  MarketplaceSkillDeclaration,
} from "./types.js";

export type ActionRequirement = {
  kind: string;
  capability: ConnectorCapability;
};

export const CONNECTOR_SUPPORTED_CAPABILITIES: Record<
  ConnectorKind,
  ConnectorCapability[]
> = {
  github: ["connector.observe", "connector.dispatch"],
  coolify: ["connector.observe", "connector.dispatch"],
  cloudflare: ["connector.observe", "connector.admin"],
  telegram: ["connector.observe", "connector.dispatch"],
  whatsapp: ["connector.observe", "connector.dispatch"],
};

export const CONNECTOR_DEFAULT_CAPABILITIES: Record<
  ConnectorKind,
  ConnectorCapability[]
> = {
  github: ["connector.observe"],
  coolify: ["connector.observe"],
  cloudflare: ["connector.observe"],
  telegram: ["connector.observe"],
  whatsapp: ["connector.observe"],
};

export const CONNECTOR_ACTION_REQUIREMENTS: Record<string, ActionRequirement> =
  {
    "github.repositories.list": {
      kind: "github",
      capability: "connector.observe",
    },
    "github.check-runs.trigger": {
      kind: "github",
      capability: "connector.dispatch",
    },
    "coolify.services.list": {
      kind: "coolify",
      capability: "connector.observe",
    },
    "coolify.deployments.trigger": {
      kind: "coolify",
      capability: "connector.dispatch",
    },
    "cloudflare.zones.list": {
      kind: "cloudflare",
      capability: "connector.observe",
    },
    "cloudflare.cache.purge": {
      kind: "cloudflare",
      capability: "connector.admin",
    },
    "telegram.chats.list": {
      kind: "telegram",
      capability: "connector.observe",
    },
    "telegram.messages.send": {
      kind: "telegram",
      capability: "connector.dispatch",
    },
    "whatsapp.chats.list": {
      kind: "whatsapp",
      capability: "connector.observe",
    },
    "whatsapp.messages.send": {
      kind: "whatsapp",
      capability: "connector.dispatch",
    },
    "activepieces.catalog.list": {
      kind: "activepieces",
      capability: "connector.observe",
    },
    "activepieces.scaffold": {
      kind: "activepieces",
      capability: "connector.admin",
    },
    "composio.catalog.list": {
      kind: "composio",
      capability: "connector.observe",
    },
    "composio.toolkit.import": {
      kind: "composio",
      capability: "connector.admin",
    },
    "composio.tool.execute": {
      kind: "composio",
      capability: "connector.dispatch",
    },
    "mcp.servers.list": { kind: "mcp", capability: "connector.observe" },
    "mcp.tools.list": { kind: "mcp", capability: "connector.observe" },
    "mcp.tools.call": { kind: "mcp", capability: "connector.dispatch" },
  };

const CAPABILITIES = new Set<ConnectorCapability>([
  "connector.observe",
  "connector.dispatch",
  "connector.admin",
]);

const ADMIN_ACTION_PARTS = new Set([
  "admin",
  "auth",
  "connect",
  "disconnect",
  "delete",
  "remove",
  "purge",
  "revoke",
]);
const DISPATCH_ACTION_PARTS = new Set([
  "add",
  "append",
  "archive",
  "assign",
  "create",
  "dispatch",
  "execute",
  "import",
  "invite",
  "mark",
  "mutate",
  "post",
  "reply",
  "run",
  "send",
  "submit",
  "sync",
  "trigger",
  "update",
  "upload",
  "write",
]);

const ACTIONS_BY_KIND: Record<ConnectorKind, string[]> = {
  github: ["github.repositories.list", "github.check-runs.trigger"],
  coolify: ["coolify.services.list", "coolify.deployments.trigger"],
  cloudflare: ["cloudflare.zones.list", "cloudflare.cache.purge"],
  telegram: ["telegram.chats.list", "telegram.messages.send"],
  whatsapp: ["whatsapp.chats.list", "whatsapp.messages.send"],
};

const LABELS: Record<ConnectorKind, string> = {
  github: "GitHub",
  coolify: "Coolify",
  cloudflare: "Cloudflare",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

type ComposioToolRecord = {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  description?: unknown;
  input_parameters?: unknown;
  inputParameters?: unknown;
  input_schema?: unknown;
  inputSchema?: unknown;
};

export type ComposioListingTool = {
  action: string;
  toolName: string;
  displayName: string;
  description: string;
  capability: ConnectorCapability;
  /**
   * Top-level argument names from the Composio tool input schema, when the
   * tool record carried one. Used as the agent argument allowlist.
   */
  inputArguments?: string[];
  /** From the toolkit's Composio policy: reaches outside the workspace. */
  outward?: "always" | "unlessQuiet";
  /** From the toolkit's Composio policy: destructive (needs connector.admin). */
  destructive?: true;
};

export function normalizeConnectorSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export function inferConnectorCapabilityFromAction(
  action: string,
): ConnectorCapability {
  const parts = action
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (parts.some((part) => ADMIN_ACTION_PARTS.has(part))) {
    return "connector.admin";
  }
  if (parts.some((part) => DISPATCH_ACTION_PARTS.has(part))) {
    return "connector.dispatch";
  }
  return "connector.observe";
}

/** Listings that execute through Composio. */
export function listingIsComposio(listing: MarketplaceListing) {
  return listing.source === "composio" || listing.executionOwner === "composio";
}

export function resolveActionRequirement(
  listing: MarketplaceListing,
  action: string,
): ActionRequirement | null {
  const requirement = declaredActionRequirement(listing, action);
  if (!requirement || !listingIsComposio(listing)) return requirement;
  // Composio: the toolkit's curated policy, or for an uncurated toolkit the
  // reviewed read allowlist, decides; a stored (or name-inferred) observe
  // never makes an unreviewed tool read-only.
  const classification = composioToolClassification(
    listing.provider,
    composioToolNameForAction(listing, action),
    requirement.capability,
  );
  return classification.curated ? requirement : { ...requirement, capability: classification.capability };
}

function declaredActionRequirement(
  listing: MarketplaceListing,
  action: string,
): ActionRequirement | null {
  const staticRequirement = CONNECTOR_ACTION_REQUIREMENTS[action];
  if (staticRequirement) {
    return staticRequirement;
  }
  const actionRequirements = recordValue(listing.manifest.actionRequirements);
  const declaredRequirement = recordValue(actionRequirements?.[action]);
  const declaredCapability = declaredRequirement?.capability;
  if (
    typeof declaredCapability === "string" &&
    CAPABILITIES.has(declaredCapability as ConnectorCapability)
  ) {
    return {
      kind: listing.provider,
      capability: declaredCapability as ConnectorCapability,
    };
  }
  if (
    listing.source === "composio" &&
    action.startsWith(`${listing.provider}.`)
  ) {
    return {
      kind: listing.provider,
      capability: inferConnectorCapabilityFromAction(action),
    };
  }
  return null;
}

export function composioToolNameForAction(
  listing: MarketplaceListing,
  action: string,
): string {
  const composio = recordValue(listing.manifest.composio);
  const tools = Array.isArray(composio?.tools) ? composio.tools : [];
  for (const tool of tools) {
    const record = recordValue(tool);
    if (
      record?.action === action &&
      typeof record.toolName === "string" &&
      record.toolName.trim()
    ) {
      return record.toolName.trim();
    }
  }
  return action;
}

export function buildComposioListingFromTools(input: {
  toolkit: string;
  upstreamToolkit?: string;
  pluginId?: string;
  displayName?: string;
  description?: string;
  tools: unknown[];
  selectedActions?: readonly string[];
  skills?: readonly MarketplaceSkillDeclaration[];
  now?: string;
}): MarketplaceListing {
  const now = input.now ?? new Date().toISOString();
  const toolkit = normalizeConnectorSlug(input.toolkit);
  const upstreamToolkit = input.upstreamToolkit?.trim() || input.toolkit.trim();
  const pluginId = input.pluginId?.trim() || `composio-${toolkit}`;
  const selectedActions = new Set(
    (input.selectedActions ?? [])
      .map((action) => action.trim())
      .filter(Boolean),
  );
  const allNormalizedTools = normalizeComposioTools(toolkit, input.tools);
  const normalizedTools =
    selectedActions.size > 0
      ? allNormalizedTools.filter(
          (tool) =>
            selectedActions.has(tool.action) ||
            selectedActions.has(tool.toolName),
        )
      : allNormalizedTools;
  const fallbackTools =
    normalizedTools.length > 0
      ? normalizedTools
      : [
          {
            action: `${toolkit}.tool.execute`,
            toolName: `${toolkit}.tool.execute`,
            displayName: `${titleCase(toolkit)} Tool Execute`,
            description: `Execute ${titleCase(toolkit)} tools through Composio.`,
            capability: "connector.dispatch" as const,
          },
        ];
  const actions = [...new Set(fallbackTools.map((tool) => tool.action))].sort();
  const capabilities = [
    ...new Set(fallbackTools.map((tool) => tool.capability)),
  ].sort() as ConnectorCapability[];
  const actionRequirements = Object.fromEntries(
    fallbackTools.map((tool) => [
      tool.action,
      {
        kind: toolkit,
        capability: tool.capability,
        runtimeSourceId: `composio:${toolkit}`,
        composioToolName: tool.toolName,
      },
    ]),
  );

  return {
    pluginId,
    displayName:
      input.displayName?.trim() || `${titleCase(toolkit)} via Composio`,
    kind: "connector",
    provider: toolkit,
    description:
      input.description?.trim() ||
      `Composio-backed ${titleCase(toolkit)} connector imported into Teal Brick Marketplace.`,
    capabilities,
    actions,
    source: "composio",
    authOwner: "composio",
    executionOwner: "composio",
    runtimeSources: [
      {
        runtimeSourceId: `composio:${toolkit}`,
        kind: "composio",
        label: `${titleCase(toolkit)} via Composio`,
        primary: true,
        toolkitSlug: upstreamToolkit,
        requiredEnv: ["COMPOSIO_API_KEY"],
      },
    ],
    enabledByDefault: false,
    manifest: {
      kind: "connector",
      provider: toolkit,
      role: "composio-imported-plugin",
      runtimeSources: [
        {
          runtimeSourceId: `composio:${toolkit}`,
          kind: "composio",
          label: `${titleCase(toolkit)} via Composio`,
          primary: true,
          toolkitSlug: upstreamToolkit,
        },
      ],
      authRequirements: [
        {
          requirementId: `composio:${toolkit}`,
          kind: "composio",
          targetId: upstreamToolkit,
          status: "required",
        },
      ],
      actionRequirements,
      skills: input.skills ?? defaultSkillsForComposioToolkit(toolkit),
      composio: {
        toolkit: upstreamToolkit,
        tools: fallbackTools,
      },
      actions,
      governedBy: ["rules-approvals"],
      secretTargets: ["COMPOSIO_API_KEY", "credential_ref"],
    },
    createdAt: now,
    updatedAt: now,
  };
}

export type ComposioToolkitCatalogItem = {
  slug: string;
  connectorSlug: string;
  name: string;
  description: string;
  logoUrl: string | null;
  appUrl: string | null;
  categories: string[];
  authSchemes: string[];
  managedAuthSchemes: string[];
  toolsCount: number;
  triggersCount: number;
  version: string | null;
  noAuth: boolean;
};

export function normalizeComposioToolkit(
  value: unknown,
): ComposioToolkitCatalogItem | null {
  const record = recordValue(value);
  const meta = recordValue(record?.meta);
  const slugValue = stringValue(record?.slug);
  if (!slugValue) {
    return null;
  }
  const slug = slugValue.trim();
  const connectorSlug = normalizeConnectorSlug(slug);
  if (!connectorSlug) {
    return null;
  }
  const categories = Array.isArray(meta?.categories)
    ? meta.categories.flatMap((category) => {
        const categoryRecord = recordValue(category);
        const name = stringValue(categoryRecord?.name);
        return name ? [name] : [];
      })
    : [];
  const numberValue = (candidate: unknown) =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, Math.trunc(candidate))
      : 0;

  return {
    slug,
    connectorSlug,
    name: stringValue(record?.name) ?? titleCase(connectorSlug),
    description: stringValue(meta?.description) ?? "",
    logoUrl: stringValue(meta?.logo) ?? null,
    appUrl: stringValue(meta?.app_url) ?? null,
    categories,
    authSchemes: Array.isArray(record?.auth_schemes)
      ? record.auth_schemes.map(String)
      : [],
    managedAuthSchemes: Array.isArray(
      record?.composio_managed_auth_schemes,
    )
      ? record.composio_managed_auth_schemes.map(String)
      : [],
    toolsCount: numberValue(meta?.tools_count),
    triggersCount: numberValue(meta?.triggers_count),
    version: stringValue(meta?.version) ?? null,
    noAuth: record?.no_auth === true,
  };
}

/** Project one Composio toolkit into the same generic Marketplace listing
 * contract as native and MCP Plugins. This is catalog discovery only: tools
 * are hydrated when the operator installs the connector. */
export function buildComposioCatalogListing(input: {
  toolkit: unknown;
  now?: string;
}): MarketplaceListing | null {
  const toolkit = normalizeComposioToolkit(input.toolkit);
  if (!toolkit) {
    return null;
  }
  const listing = buildComposioListingFromTools({
    toolkit: toolkit.connectorSlug,
    upstreamToolkit: toolkit.slug,
    pluginId: `composio-${toolkit.connectorSlug}`,
    displayName: toolkit.name,
    description:
      toolkit.description ||
      `Connect ${toolkit.name} to Teal Brick through Composio.`,
    tools: [],
    now: input.now,
  });
  const composio = recordValue(listing.manifest.composio) ?? {};

  return {
    ...listing,
    manifest: {
      ...listing.manifest,
      role: "composio-catalog-connector",
      ...(toolkit.version ? { version: toolkit.version } : {}),
      composio: {
        ...composio,
        catalog: {
          slug: toolkit.slug,
          connectorSlug: toolkit.connectorSlug,
          name: toolkit.name,
          description: toolkit.description,
          logoUrl: toolkit.logoUrl,
          appUrl: toolkit.appUrl,
          categories: toolkit.categories,
          authSchemes: toolkit.authSchemes,
          managedAuthSchemes: toolkit.managedAuthSchemes,
          toolsCount: toolkit.toolsCount,
          triggersCount: toolkit.triggersCount,
          version: toolkit.version,
          noAuth: toolkit.noAuth,
        },
      },
    },
  };
}

export function normalizeComposioTools(
  toolkit: string,
  tools: unknown[],
): ComposioListingTool[] {
  const normalizedToolkit = normalizeConnectorSlug(toolkit);
  return tools.flatMap((tool) =>
    normalizeComposioTool(tool, normalizedToolkit),
  );
}

export function defaultSkillsForComposioToolkit(
  toolkitInput: string,
): MarketplaceSkillDeclaration[] {
  const toolkit = normalizeConnectorSlug(toolkitInput);
  const label = titleCase(toolkit);
  const curated: Record<string, MarketplaceSkillDeclaration> = {
    linear: {
      skillId: "linear",
      skillName: "linear",
      displayName: "Linear",
      description:
        "Use Linear when the Agent needs to read, create, update, or triage issues and project work through the connected workspace.",
      requiresConnectors: ["linear"],
    },
    attio: {
      skillId: "attio",
      skillName: "attio",
      displayName: "Attio",
      description:
        "Use Attio when the Agent needs to work with customer records, companies, notes, and CRM follow-up through the connected workspace.",
      requiresConnectors: ["attio"],
    },
    clay: {
      skillId: "clay",
      skillName: "clay",
      displayName: "Clay",
      description:
        "Use Clay when the Agent needs to enrich people, companies, tables, or outbound research workflows through the connected workspace.",
      requiresConnectors: ["clay"],
    },
  };
  const selected = curated[toolkit];
  if (selected) {
    return [selected];
  }
  return [
    {
      skillId: `${toolkit}-composio`,
      skillName: `${toolkit}-composio`,
      displayName: `${label} Connector`,
      description: `Use ${label} through the connected Composio plugin when the Agent needs authenticated ${label} actions.`,
      requiresConnectors: [toolkit],
    },
  ];
}

export function nativeConnectorListings(
  now = new Date().toISOString(),
): MarketplaceListing[] {
  return (Object.keys(LABELS) as ConnectorKind[]).map((kind) => ({
    pluginId: `${kind}-native`,
    displayName: `${LABELS[kind]} Native Connector`,
    kind: "connector",
    provider: kind,
    description: `Teal Brick native ${LABELS[kind]} connector candidate ported from the donor connector contract.`,
    capabilities: CONNECTOR_SUPPORTED_CAPABILITIES[kind],
    actions: ACTIONS_BY_KIND[kind],
    source: "native",
    authOwner: "nango",
    executionOwner: "native",
    enabledByDefault: false,
    manifest: {
      kind: "connector",
      provider: kind,
      auth: { owner: "nango", state: "connection-ref-only" },
      actions: ACTIONS_BY_KIND[kind],
      runtimeTools: ACTIONS_BY_KIND[kind].map(
        (action) => `connector.${kind}.${action}`,
      ),
      healthChecks: ["provider-health", "credential-ref", "capability-binding"],
      secretTargets: ["credential_ref"],
    },
    createdAt: now,
    updatedAt: now,
  }));
}

function normalizeComposioTool(
  tool: unknown,
  toolkit: string,
): ComposioListingTool[] {
  const record = recordValue(tool) as ComposioToolRecord | undefined;
  if (!record) {
    return [];
  }
  const rawToolName =
    stringValue(record.name) ??
    stringValue(record.slug) ??
    stringValue(record.id);
  if (!rawToolName) {
    return [];
  }
  const actionSuffix = actionSuffixFromToolName(rawToolName, toolkit);
  const action = `${toolkit}.${actionSuffix}`;
  const inferred = inferConnectorCapabilityFromAction(action);
  // A curated toolkit policy pins outward, destructive and write tools;
  // without one, only a reviewed read is observe: everything else is outward.
  const governed = composioToolClassification(toolkit, rawToolName, inferred);
  const capability = governed.capability;
  const inputArguments = composioToolInputArguments(record);
  return [
    {
      action,
      toolName: rawToolName,
      displayName:
        stringValue(record.displayName) ??
        stringValue(record.display_name) ??
        titleCase(actionSuffix),
      description: stringValue(record.description) ?? "",
      capability,
      ...(inputArguments ? { inputArguments } : {}),
      ...(governed.outward ? { outward: governed.outward } : {}),
      ...(governed.destructive ? { destructive: true as const } : {}),
    },
  ];
}

/**
 * Re-apply the toolkit's Composio classification to a stored listing
 * (listings imported before the policy existed or changed, and uncurated
 * listings imported before unreviewed tools became outward). Returns null
 * when nothing changes.
 */
export function applyComposioPolicyToListing(listing: MarketplaceListing): MarketplaceListing | null {
  if (listing.source !== "composio") return null;
  const composio = recordValue(listing.manifest.composio);
  const tools = Array.isArray(composio?.tools) ? composio.tools : [];
  if (!tools.length) return null;
  const requirements = { ...(recordValue(listing.manifest.actionRequirements) ?? {}) };
  let changed = false;
  const nextTools = tools.map((value) => {
    const tool = recordValue(value);
    const toolName = stringValue(tool?.toolName);
    const action = stringValue(tool?.action);
    if (!tool || !toolName || !action) return value;
    const governed = composioToolClassification(listing.provider, toolName, inferConnectorCapabilityFromAction(action));
    const next: Record<string, unknown> = { ...tool, capability: governed.capability };
    delete next.outward;
    delete next.destructive;
    if (governed.outward) next.outward = governed.outward;
    if (governed.destructive) next.destructive = true;
    const requirement = recordValue(requirements[action]);
    if (requirement && requirement.capability !== governed.capability) {
      requirements[action] = { ...requirement, capability: governed.capability };
      changed = true;
    }
    if (JSON.stringify(next) !== JSON.stringify(tool)) changed = true;
    return next;
  });
  if (!changed) return null;
  const capabilities = [
    ...new Set(
      Object.values(requirements)
        .map((requirement) => recordValue(requirement)?.capability)
        .filter((capability): capability is ConnectorCapability => CAPABILITIES.has(capability as ConnectorCapability)),
    ),
  ].sort() as ConnectorCapability[];
  return {
    ...listing,
    capabilities,
    manifest: {
      ...listing.manifest,
      actionRequirements: requirements,
      composio: { ...composio, tools: nextTools },
    },
    updatedAt: new Date().toISOString(),
  };
}

function composioToolInputArguments(record: ComposioToolRecord) {
  const schema = recordValue(
    record.input_parameters ??
      record.inputParameters ??
      record.input_schema ??
      record.inputSchema,
  );
  const properties = recordValue(schema?.properties);
  if (!properties) {
    return undefined;
  }
  return Object.keys(properties)
    .filter((name) => /^[A-Za-z0-9_.-]{1,128}$/u.test(name))
    .sort();
}

function actionSuffixFromToolName(toolName: string, toolkit: string) {
  const normalized = toolName
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "");
  const toolkitDot = toolkit.replace(/[^a-z0-9]+/gu, ".");
  if (normalized === toolkitDot) {
    return "tool.execute";
  }
  if (normalized.startsWith(`${toolkitDot}.`)) {
    return normalized.slice(toolkitDot.length + 1) || "tool.execute";
  }
  return normalized || "tool.execute";
}

function titleCase(value: string) {
  return value
    .split(/[^a-z0-9]+/iu)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function providerBackedListings(
  now = new Date().toISOString(),
): MarketplaceListing[] {
  return [
    {
      pluginId: "activepieces-pack-generator",
      displayName: "Activepieces Pack Generator",
      kind: "toolset",
      provider: "activepieces",
      description:
        "Generates connector plugin candidates from Activepieces pieces and pack bindings.",
      capabilities: ["connector.admin"],
      actions: ["activepieces.catalog.list", "activepieces.scaffold"],
      source: "activepieces",
      authOwner: "external",
      executionOwner: "activepieces",
      runtimeSources: [
        {
          runtimeSourceId: "activepieces-pack-runtime",
          kind: "activepieces",
          label: "Activepieces pack runtime",
          primary: true,
          requiredEnv: ["ACTIVEPIECES_BASE_URL", "ACTIVEPIECES_API_KEY"],
        },
      ],
      enabledByDefault: false,
      manifest: {
        kind: "toolset",
        setup: { sidecar: "activepieces", failClosedWhenMissing: true },
        runtimeSources: [
          {
            runtimeSourceId: "activepieces-pack-runtime",
            kind: "activepieces",
            label: "Activepieces pack runtime",
            primary: true,
          },
        ],
        actions: ["activepieces.catalog.list", "activepieces.scaffold"],
        configSchema: {
          ACTIVEPIECES_BASE_URL: "string",
          ACTIVEPIECES_API_KEY: "secret-ref",
        },
      },
      createdAt: now,
      updatedAt: now,
    },
    {
      pluginId: "composio-bootstrap",
      displayName: "Composio Bootstrap",
      kind: "toolset",
      provider: "composio",
      description:
        "Discovers and imports long-tail Composio-backed connector candidates before native promotion.",
      capabilities: ["connector.admin", "connector.dispatch"],
      actions: [
        "composio.catalog.list",
        "composio.toolkit.import",
        "composio.tool.execute",
      ],
      source: "composio",
      authOwner: "composio",
      executionOwner: "composio",
      runtimeSources: [
        {
          runtimeSourceId: "composio-primary",
          kind: "composio",
          label: "Composio connector runtime",
          primary: true,
          requiredEnv: ["COMPOSIO_API_KEY"],
        },
      ],
      enabledByDefault: false,
      manifest: {
        kind: "toolset",
        role: "primary-plugin-connector",
        setup: { sidecar: "composio", failClosedWhenMissing: true },
        runtimeSources: [
          {
            runtimeSourceId: "composio-primary",
            kind: "composio",
            label: "Composio connector runtime",
            primary: true,
          },
        ],
        actions: [
          "composio.catalog.list",
          "composio.toolkit.import",
          "composio.tool.execute",
        ],
        secretTargets: ["COMPOSIO_API_KEY"],
      },
      createdAt: now,
      updatedAt: now,
    },
    {
      pluginId: "mcp-runtime",
      displayName: "MCP Runtime",
      kind: "toolset",
      provider: "mcp",
      description:
        "Consumes configured MCP servers and projects allowed MCP tools into governed Teal Brick plugin capabilities.",
      capabilities: ["connector.observe", "connector.dispatch"],
      actions: ["mcp.servers.list", "mcp.tools.list", "mcp.tools.call"],
      source: "mcp",
      authOwner: "program",
      executionOwner: "mcp",
      runtimeSources: [
        {
          runtimeSourceId: "mcp-tool-transport",
          kind: "mcp",
          label: "MCP tool transport",
          primary: true,
        },
      ],
      enabledByDefault: false,
      manifest: {
        kind: "toolset",
        setup: { transport: "mcp", failClosedWhenMissing: true },
        runtimeSources: [
          {
            runtimeSourceId: "mcp-tool-transport",
            kind: "mcp",
            label: "MCP tool transport",
            primary: true,
          },
        ],
        actions: ["mcp.servers.list", "mcp.tools.list", "mcp.tools.call"],
        governedBy: ["rules-approvals"],
      },
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function buildNativeActionResult(input: {
  pluginId: string;
  workspaceSlug: string;
  provider: string;
  capability: ConnectorCapability;
  action: Record<string, unknown>;
  performedAt: string;
}) {
  const actionType = String(input.action.type);
  const base = {
    pluginId: input.pluginId,
    workspaceSlug: input.workspaceSlug,
    provider: input.provider,
    capability: input.capability,
    actionType,
    performedAt: input.performedAt,
    simulated: true,
  };

  switch (actionType) {
    case "github.repositories.list":
      return {
        ...base,
        summary: `Listed GitHub repositories for ${String(input.action.owner ?? "Tealbrick")}`,
        details: {
          repositories: [
            `${String(input.action.owner ?? "Tealbrick")}/runtime-control`,
            `${String(input.action.owner ?? "Tealbrick")}/connector-observer`,
          ],
        },
      };
    case "github.check-runs.trigger":
      return {
        ...base,
        summary: `Queued simulated GitHub check for ${String(input.action.repository)}`,
        details: {
          repository: input.action.repository,
          sha: input.action.sha,
          checkRunId: `ghcheck_${randomUUID()}`,
          status: "queued",
        },
      };
    case "coolify.services.list":
      return {
        ...base,
        summary: "Listed Coolify services",
        details: { services: ["api", "worker", "temporal"] },
      };
    case "coolify.deployments.trigger":
      return {
        ...base,
        summary: "Queued simulated Coolify deployment",
        details: { deploymentId: `coolify_${randomUUID()}` },
      };
    case "cloudflare.zones.list":
      return {
        ...base,
        summary: "Listed Cloudflare zones",
        details: { zones: ["doppelganger.vc"] },
      };
    case "cloudflare.cache.purge":
      return {
        ...base,
        summary: "Simulated Cloudflare cache purge",
        details: { purgeId: `purge_${randomUUID()}` },
      };
    case "telegram.chats.list":
      return {
        ...base,
        summary: "Listed Telegram chats",
        details: { chats: [{ id: "tg_ops", title: "Ops Room" }] },
      };
    case "telegram.messages.send":
      return {
        ...base,
        summary: `Simulated Telegram send to ${String(input.action.chatId)}`,
        details: { messageId: `tgmsg_${randomUUID()}` },
      };
    case "whatsapp.chats.list":
      return {
        ...base,
        summary: "Listed WhatsApp chats",
        details: { chats: [{ id: "wa_alerts", title: "Alerts" }] },
      };
    case "whatsapp.messages.send":
      return {
        ...base,
        summary: `Simulated WhatsApp send to ${String(input.action.recipient)}`,
        details: { messageId: `wamsg_${randomUUID()}` },
      };
    default:
      return { ...base, summary: `Simulated ${actionType}`, details: {} };
  }
}

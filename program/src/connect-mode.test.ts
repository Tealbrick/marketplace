import { describe, expect, it } from "vitest";

import { CONNECT_MODES, connectMode, countConnectModes } from "./connect-mode.js";
import { buildComposioCatalogListing } from "./connectors.js";
import type { MarketplaceListing } from "./types.js";

function composioListing(toolkit: {
  slug: string;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  no_auth?: boolean;
}, customAuthConfigs?: Array<{ id: string; authScheme: string | null }>): MarketplaceListing {
  const listing = buildComposioCatalogListing({
    toolkit: { name: toolkit.slug, meta: {}, ...toolkit },
  });
  if (!listing) throw new Error("listing");
  if (!customAuthConfigs) return listing;
  const composio = listing.manifest.composio as Record<string, unknown>;
  return {
    ...listing,
    manifest: {
      ...listing.manifest,
      composio: {
        ...composio,
        catalog: { ...(composio.catalog as Record<string, unknown>), customAuthConfigs },
      },
    },
  };
}

function baseListing(overrides: Partial<MarketplaceListing>): MarketplaceListing {
  return {
    pluginId: "x",
    displayName: "X",
    kind: "connector",
    provider: "x",
    description: "",
    capabilities: ["connector.observe"],
    actions: [],
    source: "native",
    authOwner: "program",
    executionOwner: "native",
    enabledByDefault: false,
    manifest: {},
    createdAt: "2026-10-09T00:00:00.000Z",
    updatedAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  } as MarketplaceListing;
}

describe("connectMode", () => {
  it("reports connected when the listing has a connected connection", () => {
    const listing = composioListing({ slug: "github", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] });
    expect(connectMode(listing, { pluginId: listing.pluginId, state: "connected" })).toBe("connected");
    // Connections for other listings, or not yet connected, do not count.
    expect(
      connectMode(listing, [
        { pluginId: "composio-other", state: "connected" },
        { pluginId: listing.pluginId, state: "pending" },
      ]),
    ).toBe("needs_auth_config");
  });

  it("reports no_auth for Composio no-auth toolkits and the bootstrap listing", () => {
    expect(connectMode(composioListing({ slug: "hackernews", no_auth: true }), null)).toBe("no_auth");
    expect(connectMode(composioListing({ slug: "weather", auth_schemes: ["NO_AUTH"] }), null)).toBe("no_auth");
    expect(
      connectMode(
        baseListing({ pluginId: "composio-bootstrap", source: "composio", authOwner: "composio", executionOwner: "composio" }),
        null,
      ),
    ).toBe("no_auth");
  });

  it("reports ready_managed when Composio manages auth or the toolkit lists no schemes", () => {
    expect(
      connectMode(composioListing({ slug: "gmail", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: ["OAUTH2"] }), null),
    ).toBe("ready_managed");
    expect(connectMode(composioListing({ slug: "mystery" }), null)).toBe("ready_managed");
  });

  it("reports ready_user_key for API_KEY, BEARER_TOKEN and BASIC toolkits", () => {
    for (const scheme of ["API_KEY", "BEARER_TOKEN", "BASIC"]) {
      expect(connectMode(composioListing({ slug: `t${scheme.toLowerCase()}`, auth_schemes: ["OAUTH2", scheme] }), undefined)).toBe("ready_user_key");
    }
  });

  it("reports needs_auth_config for owner-configured schemes without a known custom config", () => {
    const listing = composioListing({ slug: "github", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] });
    expect(connectMode(listing, null)).toBe("needs_auth_config");
    expect(connectMode(composioListing({ slug: "gcp", auth_schemes: ["GOOGLE_SERVICE_ACCOUNT"] }), null)).toBe("needs_auth_config");
  });

  it("reports ready_auth_config once a custom auth config is known", () => {
    const known = composioListing(
      { slug: "github", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] },
      [{ id: "ac_github_custom", authScheme: "OAUTH2" }],
    );
    expect(connectMode(known, null)).toBe("ready_auth_config");
    // A config for a scheme the toolkit does not support is ignored.
    const wrongScheme = composioListing(
      { slug: "github", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] },
      [{ id: "ac_github_key", authScheme: "API_KEY" }],
    );
    expect(connectMode(wrongScheme, null)).toBe("needs_auth_config");
    // A previous connection that used an auth config also counts.
    const plain = composioListing({ slug: "github", auth_schemes: ["OAUTH2"], composio_managed_auth_schemes: [] });
    expect(
      connectMode(plain, { pluginId: plain.pluginId, state: "disconnected", metadata: { authConfigId: "ac_prev" } }),
    ).toBe("ready_auth_config");
  });

  it("reports not_supported for unknown schemes and non-runnable backends", () => {
    expect(connectMode(composioListing({ slug: "odd", auth_schemes: ["CALCOM_AUTH"] }), null)).toBe("not_supported");
    expect(connectMode(baseListing({ source: "activepieces", executionOwner: "activepieces" }), null)).toBe("not_supported");
    expect(connectMode(baseListing({ source: "native" }), null)).toBe("not_supported");
  });

  it("maps custom MCP and Company Box connectors to needs_credentials until connected", () => {
    const customMcp = baseListing({
      pluginId: "mcp-custom-docs",
      source: "mcp",
      executionOwner: "mcp",
      ownerWorkspaceSlug: "ws-a",
      manifest: { skillsHub: { custom: true, operatorManaged: true } },
    });
    expect(connectMode(customMcp, null, { workspaceSlug: "ws-a" })).toBe("needs_credentials");
    expect(connectMode(customMcp, null, { workspaceSlug: "ws-b" })).toBe("not_supported");
    expect(connectMode(customMcp, { pluginId: customMcp.pluginId, state: "connected" }, { workspaceSlug: "ws-a" })).toBe("connected");

    const companyBox = baseListing({
      pluginId: "company-box-forgejo",
      source: "openapi" as MarketplaceListing["source"],
      executionOwner: "openapi",
      manifest: { companyBox: { entryId: "forgejo" } },
    });
    expect(connectMode(companyBox, null)).toBe("needs_credentials");
    expect(connectMode(companyBox, { pluginId: companyBox.pluginId, state: "connected" })).toBe("connected");
  });

  it("counts every mode, including unused ones", () => {
    const counts = countConnectModes(["connected", "ready_managed", "ready_managed"]);
    expect(Object.keys(counts).sort()).toEqual([...CONNECT_MODES].sort());
    expect(counts).toMatchObject({ connected: 1, ready_managed: 2, needs_auth_config: 0 });
  });
});

import { listingIsCompanyBoxOpenApi } from "./company-box.js";
import { listingIsOperatorCustomMcp } from "./hub.js";
import {
  COMPOSIO_OWNER_CONFIGURED_AUTH_SCHEMES,
  COMPOSIO_USER_KEY_AUTH_SCHEMES,
} from "./provider-health.js";
import type { ConnectorConnection, MarketplaceListing } from "./types.js";

/**
 * How a catalog listing can be connected, derived once on the server so the
 * browser never re-derives it from raw Composio metadata.
 *
 * - `connected`: the workspace already has a connected connection.
 * - `no_auth`: nothing to sign in to (Composio `no_auth` toolkits and the
 *   Composio bootstrap listing).
 * - `ready_auth_config`: a custom auth config for this toolkit is already
 *   known (from the catalog sync or a previous connection), so Connect uses it.
 * - `ready_managed`: Composio-managed auth exists for the toolkit (or the
 *   toolkit lists no schemes, which Composio treats as managed).
 * - `ready_user_key`: API_KEY, BEARER_TOKEN or BASIC; the user enters the key
 *   on the Composio link page.
 * - `needs_auth_config`: only owner-configured schemes such as OAUTH2 and no
 *   custom auth config is known; the owner must create one in the Composio
 *   dashboard first.
 * - `needs_credentials`: custom MCP or Company Box connectors that are not
 *   connected yet (refresh tools / test the connection with credentials).
 * - `not_supported`: nothing Marketplace can connect (unknown schemes only,
 *   or an execution backend this launch profile does not run).
 */
export const CONNECT_MODES = [
  "connected",
  "no_auth",
  "ready_auth_config",
  "ready_managed",
  "ready_user_key",
  "needs_auth_config",
  "needs_credentials",
  "not_supported",
] as const;

export type ConnectMode = (typeof CONNECT_MODES)[number];

type ConnectionLike = Pick<ConnectorConnection, "pluginId" | "state"> & {
  metadata?: Record<string, unknown>;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function upperStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim().toUpperCase())
    : [];
}

/** Composio auth facts stored on a catalog listing by the catalog sync. */
export function composioAuthProfile(listing: MarketplaceListing) {
  const composio = recordValue(recordValue(listing.manifest)?.composio);
  const catalog = recordValue(composio?.catalog);
  const customAuthConfigs = Array.isArray(catalog?.customAuthConfigs)
    ? catalog.customAuthConfigs.flatMap((entry) => {
        const record = recordValue(entry);
        const id = typeof record?.id === "string" ? record.id.trim() : "";
        if (!id) return [];
        const authScheme =
          typeof record?.authScheme === "string" ? record.authScheme.trim().toUpperCase() : null;
        return [{ id, authScheme }];
      })
    : [];
  return {
    authSchemes: upperStrings(catalog?.authSchemes),
    managedAuthSchemes: upperStrings(catalog?.managedAuthSchemes),
    noAuth: catalog?.noAuth === true,
    customAuthConfigs,
  };
}

function listingNeedsComposioAccount(listing: MarketplaceListing) {
  return (
    listing.source === "composio" &&
    listing.authOwner === "composio" &&
    listing.pluginId !== "composio-bootstrap"
  );
}

/**
 * Derive the connect mode for one listing in one workspace.
 *
 * `connections` may be the workspace's connection for this listing, a list of
 * connections (only entries for this listing count), or nothing.
 */
export function connectMode(
  listing: MarketplaceListing,
  connections: ConnectionLike | readonly ConnectionLike[] | null | undefined,
  options: { workspaceSlug?: string } = {},
): ConnectMode {
  const own = (Array.isArray(connections) ? connections : connections ? [connections] : [])
    .filter((connection: ConnectionLike) => connection.pluginId === listing.pluginId);
  if (own.some((connection) => connection.state === "connected")) {
    return "connected";
  }

  if (listingIsOperatorCustomMcp(listing)) {
    const ownedHere =
      listing.executionOwner === "mcp" &&
      (options.workspaceSlug === undefined || listing.ownerWorkspaceSlug === options.workspaceSlug);
    return ownedHere ? "needs_credentials" : "not_supported";
  }
  if (listingIsCompanyBoxOpenApi(listing)) {
    return "needs_credentials";
  }
  if (listing.executionOwner !== "composio") {
    return "not_supported";
  }
  if (!listingNeedsComposioAccount(listing)) {
    return "no_auth";
  }

  const profile = composioAuthProfile(listing);
  if (profile.noAuth || profile.authSchemes.includes("NO_AUTH")) {
    return "no_auth";
  }
  const knownFromConnection = own.some(
    (connection) => typeof connection.metadata?.authConfigId === "string" && connection.metadata.authConfigId.trim() !== "",
  );
  const knownCustomConfig = profile.customAuthConfigs.some(
    (config) =>
      config.authScheme === null ||
      profile.authSchemes.length === 0 ||
      profile.authSchemes.includes(config.authScheme),
  );
  if (knownCustomConfig) {
    return "ready_auth_config";
  }
  if (profile.managedAuthSchemes.length > 0 || profile.authSchemes.length === 0) {
    return "ready_managed";
  }
  if (profile.authSchemes.some((scheme) => (COMPOSIO_USER_KEY_AUTH_SCHEMES as readonly string[]).includes(scheme))) {
    return "ready_user_key";
  }
  if (knownFromConnection) {
    return "ready_auth_config";
  }
  if (profile.authSchemes.some((scheme) => (COMPOSIO_OWNER_CONFIGURED_AUTH_SCHEMES as readonly string[]).includes(scheme))) {
    return "needs_auth_config";
  }
  return "not_supported";
}

/** Count listings per connect mode; every mode is present (zero when unused). */
export function countConnectModes(modes: Iterable<ConnectMode>): Record<ConnectMode, number> {
  const counts = Object.fromEntries(CONNECT_MODES.map((mode) => [mode, 0])) as Record<ConnectMode, number>;
  for (const mode of modes) {
    counts[mode] += 1;
  }
  return counts;
}

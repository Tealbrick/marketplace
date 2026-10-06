import { manifestNamespace } from "./legacy-ids.js";
import type { MarketplaceListing } from "./types.js";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/**
 * Listing manifests written by earlier releases carry their custom-connector
 * and required-plugin flags under the `skillsHub` key. That key is persisted
 * data, so it keeps being read (and written by operator custom MCP) even
 * though the Skills Hub adapter itself is gone.
 */
function legacyHubMetadata(listing: MarketplaceListing): JsonRecord {
  return recordValue(listing.manifest.skillsHub) ?? {};
}

export function listingIsRequired(listing: MarketplaceListing): boolean {
  const hub = legacyHubMetadata(listing);
  const directSystem = recordValue(listing.manifest.system);
  const namespacedSystem = recordValue(
    manifestNamespace(recordValue(listing.manifest))?.system,
  );
  return (
    hub.required === true ||
    directSystem?.required === true ||
    namespacedSystem?.required === true
  );
}

export function listingIsCustomMcp(listing: MarketplaceListing): boolean {
  return listing.source === "mcp" && legacyHubMetadata(listing).custom === true;
}

/**
 * Custom MCP connector created by an operator for one workspace through the
 * operator-session routes. Its secrets live in the encrypted connector secret
 * store.
 */
export function listingIsOperatorCustomMcp(
  listing: MarketplaceListing,
): boolean {
  return (
    listingIsCustomMcp(listing) &&
    legacyHubMetadata(listing).operatorManaged === true &&
    typeof listing.ownerWorkspaceSlug === "string"
  );
}

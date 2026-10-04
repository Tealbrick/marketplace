import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteMarketplaceStore } from "./store.js";

const roots: string[] = [];
const handoffKey = "b".repeat(64);
const sessionToken = "s".repeat(43);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function databasePath() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-store-"));
  roots.push(root);
  return path.join(root, "marketplace.sqlite");
}

function handoffSession() {
  return {
    portalIssuer: "https://portal.test",
    deploymentId: "deployment-1",
    portalOrgId: "portal-org-1",
    productTenantId: "tenant-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    sessionToken,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

describe("Portal handoff session storage", () => {
  it("encrypts session bearers at rest and decrypts them after reopen", async () => {
    const dbPath = await databasePath();
    const store = new SqliteMarketplaceStore(dbPath, {
      handoffEncryptionKey: handoffKey,
    });
    store.upsertPortalHandoffSession(handoffSession());
    store.close();

    const databaseBytes = (await readFile(dbPath)).toString("utf8");
    expect(databaseBytes).not.toContain(sessionToken);

    const reopened = new SqliteMarketplaceStore(dbPath, {
      handoffEncryptionKey: handoffKey,
    });
    expect(reopened.getPortalHandoffSession("deployment-1")).toMatchObject({
      sessionToken,
    });
    reopened.close();
  });

  it("re-encrypts a legacy plaintext session during migration", async () => {
    const dbPath = await databasePath();
    const store = new SqliteMarketplaceStore(dbPath, {
      handoffEncryptionKey: handoffKey,
    });
    store.upsertPortalHandoffSession(handoffSession());
    store.close();

    const database = new DatabaseSync(dbPath);
    database
      .prepare(
        "UPDATE marketplace_portal_handoff_session SET session_token = ? WHERE deployment_id = ?",
      )
      .run(sessionToken, "deployment-1");
    database.close();

    const migrated = new SqliteMarketplaceStore(dbPath, {
      handoffEncryptionKey: handoffKey,
    });
    expect(migrated.getPortalHandoffSession("deployment-1")).toMatchObject({
      sessionToken,
    });
    migrated.close();

    const databaseBytes = (await readFile(dbPath)).toString("utf8");
    expect(databaseBytes).not.toContain(sessionToken);
  });

  it("fails closed when a Portal handoff write has no external encryption key", async () => {
    const dbPath = await databasePath();
    const store = new SqliteMarketplaceStore(dbPath);
    expect(() => store.upsertPortalHandoffSession(handoffSession())).toThrow(
      "MARKETPLACE_HANDOFF_ENCRYPTION_KEY is required",
    );
    store.close();
  });

  it("fails closed on reopen with a missing or wrong key without overwriting data", async () => {
    const dbPath = await databasePath();
    const store = new SqliteMarketplaceStore(dbPath, {
      handoffEncryptionKey: handoffKey,
    });
    store.upsertPortalHandoffSession(handoffSession());
    store.close();
    const before = await readFile(dbPath);

    expect(() => new SqliteMarketplaceStore(dbPath)).toThrow(
      "MARKETPLACE_HANDOFF_ENCRYPTION_KEY is required",
    );
    expect(() =>
      new SqliteMarketplaceStore(dbPath, {
        handoffEncryptionKey: "c".repeat(64),
      }),
    ).toThrow();

    expect(await readFile(dbPath)).toEqual(before);
  });

  it("keeps the same external key across retry and restart", async () => {
    const dbPath = await databasePath();
    const first = new SqliteMarketplaceStore(dbPath, {
      handoffEncryptionKey: handoffKey,
    });
    first.upsertPortalHandoffSession(handoffSession());
    const firstSession = first.getPortalHandoffSession("deployment-1");
    first.close();

    const second = new SqliteMarketplaceStore(dbPath, {
      handoffEncryptionKey: handoffKey,
    });
    expect(second.getPortalHandoffSession("deployment-1")).toMatchObject({
      sessionToken: firstSession?.sessionToken,
    });
    second.close();
  });
});

function ownedListing(pluginId: string, ownerWorkspaceSlug?: string) {
  const now = new Date().toISOString();
  return {
    pluginId,
    displayName: pluginId,
    kind: "toolset" as const,
    provider: pluginId,
    description: "fixture",
    capabilities: [],
    actions: [],
    source: "mcp" as const,
    authOwner: "program" as const,
    executionOwner: "mcp" as const,
    enabledByDefault: false,
    manifest: { skillsHub: { custom: true } },
    ...(ownerWorkspaceSlug ? { ownerWorkspaceSlug } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

describe("workspace-owned listings", () => {
  it("adds the workspace_slug column idempotently to an existing database", async () => {
    const dbPath = await databasePath();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE marketplace_listing (
      plugin_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL,
      provider TEXT NOT NULL, description TEXT NOT NULL, capabilities TEXT NOT NULL,
      actions TEXT NOT NULL, source TEXT NOT NULL, auth_owner TEXT NOT NULL,
      execution_owner TEXT NOT NULL, enabled_by_default INTEGER NOT NULL DEFAULT 0,
      manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    legacy.close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = new SqliteMarketplaceStore(dbPath);
      expect(store.getListing("github-native")?.ownerWorkspaceSlug).toBeUndefined();
      store.close();
    }
    const inspect = new DatabaseSync(dbPath);
    const columns = (inspect.prepare("PRAGMA table_info(marketplace_listing)").all() as Array<{ name: string }>).map((column) => column.name);
    inspect.close();
    expect(columns).toEqual(expect.arrayContaining(["workspace_slug", "runtime_sources_json"]));
  });

  it("scopes owned listings to their workspace and keeps ownership sticky", async () => {
    const store = new SqliteMarketplaceStore(await databasePath());
    store.upsertListing(ownedListing("mcp-a-1", "ws-a"));
    expect(store.getListingForWorkspace("mcp-a-1", "ws-a")?.ownerWorkspaceSlug).toBe("ws-a");
    expect(store.getListingForWorkspace("mcp-a-1", "ws-b")).toBeNull();
    expect(store.getListingForWorkspace("github-native", "ws-b")?.pluginId).toBe("github-native");
    expect(store.listListingsForWorkspace("ws-b").some((listing) => listing.pluginId === "mcp-a-1")).toBe(false);
    expect(store.listListingsForWorkspace("ws-a").some((listing) => listing.pluginId === "mcp-a-1")).toBe(true);
    expect(store.listOwnedListings("ws-a").map((listing) => listing.pluginId)).toEqual(["mcp-a-1"]);
    // An upsert without an owner (for example from the Hub adapter) cannot
    // turn a workspace-owned listing into a global one.
    store.upsertListing(ownedListing("mcp-a-1"));
    expect(store.getListingForWorkspace("mcp-a-1", "ws-b")).toBeNull();
    store.close();
  });
});

describe("connector secret storage", () => {
  const secretValue = "sk-live-connector-secret-value-123456";

  it("encrypts secrets at rest, returns only metadata, and records a credential ref", async () => {
    const dbPath = await databasePath();
    const store = new SqliteMarketplaceStore(dbPath, { handoffEncryptionKey: handoffKey });
    expect(store.connectorSecretStoreAvailable()).toBe(true);
    const metadata = store.putConnectorSecret({ workspaceSlug: "ws-a", pluginId: "mcp-a-1", name: "authorization", value: secretValue });
    expect(metadata.fingerprint).toMatch(/^[0-9a-f]{12}$/u);
    expect(JSON.stringify(metadata)).not.toContain(secretValue);
    expect(store.listConnectorSecrets({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toEqual([expect.objectContaining({ name: "authorization", fingerprint: metadata.fingerprint })]);
    expect(store.listConnectorSecrets({ workspaceSlug: "ws-b", pluginId: "mcp-a-1" })).toEqual([]);
    const refs = store.listCredentialRefs({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" });
    expect(refs).toEqual([expect.objectContaining({ providerHint: "mcp", secretRefKey: `marketplace-secret:${metadata.id}`, state: "active" })]);
    expect(JSON.stringify(refs)).not.toContain(secretValue);

    const replaced = store.putConnectorSecret({ workspaceSlug: "ws-a", pluginId: "mcp-a-1", name: "authorization", value: `${secretValue}-v2` });
    expect(replaced.id).toBe(metadata.id);
    expect(replaced.fingerprint).not.toBe(metadata.fingerprint);
    expect(store.listCredentialRefs({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toHaveLength(1);
    store.close();

    const database = new DatabaseSync(dbPath);
    const rows = database.prepare("SELECT * FROM connector_secret").all();
    database.close();
    expect(JSON.stringify(rows)).not.toContain(secretValue);
    expect((await readFile(dbPath)).toString("utf8")).not.toContain(secretValue);

    const reopened = new SqliteMarketplaceStore(dbPath, { handoffEncryptionKey: handoffKey });
    expect(reopened.readConnectorSecretValues({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toEqual({ authorization: `${secretValue}-v2` });
    expect(reopened.deleteConnectorSecret({ workspaceSlug: "ws-a", pluginId: "mcp-a-1", name: "authorization" })).toBe(true);
    expect(reopened.readConnectorSecretValues({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toEqual({});
    expect(reopened.listCredentialRefs({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toEqual([]);
    reopened.close();
  });

  it("fails closed without the encryption key and removes secrets with the listing", async () => {
    const dbPath = await databasePath();
    const keyless = new SqliteMarketplaceStore(dbPath);
    expect(keyless.connectorSecretStoreAvailable()).toBe(false);
    expect(() => keyless.putConnectorSecret({ workspaceSlug: "ws-a", pluginId: "mcp-a-1", name: "x-api-key", value: secretValue })).toThrow(expect.objectContaining({ code: "connector_secret_store_unavailable" }));
    expect(keyless.readConnectorSecretValues({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toEqual({});
    keyless.close();

    const store = new SqliteMarketplaceStore(dbPath, { handoffEncryptionKey: handoffKey });
    store.upsertListing(ownedListing("mcp-a-1", "ws-a"));
    store.putConnectorSecret({ workspaceSlug: "ws-a", pluginId: "mcp-a-1", name: "x-api-key", value: secretValue });
    store.close();

    const withoutKey = new SqliteMarketplaceStore(dbPath);
    expect(() => withoutKey.readConnectorSecretValues({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toThrow(expect.objectContaining({ code: "connector_secret_store_unavailable" }));
    withoutKey.deleteListing("mcp-a-1");
    expect(withoutKey.listConnectorSecrets({ workspaceSlug: "ws-a", pluginId: "mcp-a-1" })).toEqual([]);
    withoutKey.close();
  });
});

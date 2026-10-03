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

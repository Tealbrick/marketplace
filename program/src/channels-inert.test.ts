import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GRANT_A, PROOF, TENANT, channelFixture, type ChannelFixture } from "./channels/app-fixture.js";
import { CHANNEL_TABLES } from "./channels/store.js";
import { SqliteMarketplaceStore } from "./store.js";

// Reviewer condition: with no channel credential, Marketplace behaves exactly as before Channels.

const fixtures: ChannelFixture[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const NO_TOKENS = { MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: undefined, MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: undefined };

async function inert(options: Parameters<typeof channelFixture>[0] = {}) {
  const f = await channelFixture({ ...options, environment: { ...NO_TOKENS, ...options.environment } });
  fixtures.push(f);
  return f;
}

describe("channels inert mode (no credentials)", () => {
  it("does not start the scheduler timer, and the tick does nothing", async () => {
    const f = await inert({ options: { channelScheduler: true } });
    expect(f.runtime.configured).toBe(false);
    expect(f.runtime.schedulerStarted).toBe(false);
    expect(await f.runtime.tick(new Date())).toEqual({ recovered: 0, expired: 0, sent: 0, skipped: 0, claimed: 0 });
    const configured = await channelFixture({ options: { channelScheduler: true } });
    fixtures.push(configured);
    expect(configured.runtime.schedulerStarted).toBe(true);
  });

  it("keeps /api/portal/readiness in its pre-Channels shape", async () => {
    const f = await inert();
    const readiness = await f.app.inject({ method: "GET", url: "/api/portal/readiness", headers: { "x-tealbrick-instance-proof": PROOF } });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toEqual({
      ok: true,
      schema: 2,
      product: "marketplace",
      deploymentId: "deployment-1",
      orgId: "portal-org-1",
      workspaceId: TENANT,
      productTenantId: TENANT,
      publicOrigin: "https://marketplace.fixture.invalid",
      portal: { configured: true, baseUrl: "https://portal.test", instanceProofHeader: "x-tealbrick-instance-proof" },
      tenant: { configured: true, productTenantId: TENANT },
      auth: { configured: true, instanceProofHeader: "x-tealbrick-instance-proof" },
      rules: { configured: false, reachable: false, effect: null, detail: "scoped_rules_credential_not_configured" },
    });
    expect(readiness.body).not.toContain("channels");
  });

  it("answers 409 channels_not_configured on every channel op except the owner browse", async () => {
    const f = await inert();
    const browse = await f.owner("GET", "/api/marketplace/channels");
    expect(browse.statusCode).toBe(200);
    expect(browse.json()).toEqual({
      ok: true,
      schema: 1,
      configured: false,
      providers: [
        { id: "telegram", readiness: "credential_missing" },
        { id: "discord", readiness: "credential_missing" },
      ],
    });
    const agent = (method: "GET" | "POST", url: string, payload?: unknown) =>
      f.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${GRANT_A}`, "idempotency-key": "inert-key-0001", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
    const calls = [
      await agent("GET", "/api/marketplace/v1/agent/channels"),
      await agent("GET", "/api/marketplace/v1/agent/channels/chn_x"),
      await agent("GET", "/api/marketplace/v1/agent/channels/receipts"),
      await agent("GET", "/api/marketplace/v1/agent/channels/grants"),
      await agent("POST", "/api/marketplace/v1/agent/channels/chn_x/posts", { text: "hi" }),
      await agent("POST", "/api/marketplace/v1/agent/channels/chn_x/scheduled", { text: "hi", sendAt: new Date().toISOString() }),
      await agent("POST", "/api/marketplace/v1/agent/channels/chn_x/scheduled/chp_x/cancel", {}),
      await agent("POST", "/api/marketplace/v1/agent/channels/chn_x/grants", {}),
      await agent("POST", "/api/marketplace/v1/agent/channels/grants/chg_x/narrow", {}),
      await agent("POST", "/api/marketplace/v1/agent/channels/grants/chg_x/withdraw", {}),
      await f.owner("GET", "/api/marketplace/channels/discover?provider=telegram"),
      await f.owner("POST", "/api/marketplace/channels", { provider: "telegram" }, { "idempotency-key": "inert-key-0002" }),
      await f.owner("PATCH", "/api/marketplace/channels/chn_x", {}),
      await f.owner("POST", "/api/marketplace/channels/chn_x/pause", {}),
      await f.owner("POST", "/api/marketplace/channels/chn_x/test", {}, { "idempotency-key": "inert-key-0003" }),
      await f.owner("POST", "/api/marketplace/channels/grants/chg_x/approve", {}),
      await f.owner("POST", "/api/marketplace/channels/grants/chg_x/revoke", {}),
      await f.owner("POST", "/api/marketplace/channels/posts/chp_x/resolve", { status: "sent" }),
      await f.owner("GET", "/api/marketplace/channels/receipts/export"),
      await f.owner("POST", "/api/marketplace/channels/receipts/purge", {}),
    ];
    for (const response of calls) {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ error: "channels_not_configured" });
    }
    const upload = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/channels/attachments?name=a.png",
      headers: { authorization: `Bearer ${GRANT_A}`, "idempotency-key": "inert-key-0004", "content-type": "image/png" },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(upload.statusCode).toBe(409);
    expect(f.store.getConnection(TENANT, "channels-telegram")).toBeNull();
  });
});

describe("upgrade from a 0.1.19 data directory", () => {
  it("adds only the channel tables and leaves every existing table as it was", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-0119-"));
    roots.push(root);
    const file = path.join(root, "marketplace.sqlite");
    new SqliteMarketplaceStore(file, { handoffEncryptionKey: "a".repeat(64) }).close();
    // Make it 0.1.19-shaped: no channel tables.
    const raw = new DatabaseSync(file);
    for (const table of CHANNEL_TABLES) raw.exec(`DROP TABLE IF EXISTS ${table}`);
    const schema = () =>
      new Map(
        (raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ type: string; name: string; sql: string | null }>).map(
          (row) => [`${row.type}:${row.name}`, row.sql],
        ),
      );
    const before = schema();
    raw.close();
    new SqliteMarketplaceStore(file, { handoffEncryptionKey: "a".repeat(64) }).close();
    const reopened = new DatabaseSync(file);
    const after = new Map(
      (reopened.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ type: string; name: string; sql: string | null }>).map(
        (row) => [`${row.type}:${row.name}`, row.sql],
      ),
    );
    reopened.close();
    for (const [name, sql] of before) expect(after.get(name), name).toBe(sql);
    const added = [...after.keys()].filter((name) => !before.has(name));
    expect(added.filter((name) => name.startsWith("table:")).sort()).toEqual(CHANNEL_TABLES.map((table) => `table:${table}`).sort());
    for (const name of added) expect(name.startsWith("table:channel") || name.startsWith("index:idx_channel") || name === "table:marketplace_used_approval_proof", name).toBe(true);
  });
});

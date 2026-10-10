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
      await agent("GET", "/api/marketplace/v1/agent/channels/inbound"),
      await agent("POST", "/api/marketplace/v1/agent/channels/inbound/cie_x/reply", { text: "hi" }),
      await f.app.inject({ method: "PUT", url: "/api/marketplace/channels/chn_x/inbound", payload: { enabled: true, agentId: "agent-1" } }),
      await f.owner("GET", "/api/marketplace/channels/inbound/events"),
      await f.app.inject({ method: "PUT", url: "/api/marketplace/channels/inbound/settings", payload: { textRetentionDays: 7 } }),
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

  it("still applies inbound retention (bounded, on the owner browse) after Channels went inert (F7)", async () => {
    const f = await inert();
    const channel = f.store.channels.createChannel({
      workspaceSlug: TENANT, slug: "old-slack", label: "Old", kind: "chat", provider: "slack", connectionId: "conn-slack",
      destination: { type: "channel", externalId: "C0OLD0001", title: "old" }, status: "active", now: new Date(f.now - 40 * 86_400_000),
    });
    const { event } = f.store.channels.inbound.insertEvent({
      workspaceSlug: TENANT,
      routeChannelId: channel.id,
      now: new Date(f.now - 40 * 86_400_000),
      message: { platform: "slack", channelId: "C0OLD0001", messageId: "1.000001", senderUserId: "U1", senderDisplay: "Ada", text: "old text", attachments: [] },
    });
    f.store.channels.inbound.recordTelegramDestinations(TENANT, [{ type: "group", externalId: "-100old", title: "Old chat" }], new Date(f.now - 40 * 86_400_000));
    expect((await f.owner("GET", "/api/marketplace/channels")).statusCode).toBe(200);
    expect(f.store.channels.inbound.getEvent(TENANT, event.id)).toMatchObject({ text: "", senderDisplay: "", purgedAt: expect.any(String) });
    expect(f.store.channels.inbound.listTelegramDestinations(TENANT)).toEqual([]);
  });

  it("starts no inbound receiver: the public inbound routes refuse after their cheap checks and nothing is stored", async () => {
    const f = await inert({ environment: { MARKETPLACE_CHANNELS_SLACK_SIGNING_SECRET: "slack-signing-secret-0000" } });
    expect(f.runtime.inbound.worker.discordGateway).toBeNull();
    const timestamp = String(Math.floor(f.now / 1000));
    const slack = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/channels/slack/events",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${"0".repeat(64)}` },
      payload: { type: "url_verification", challenge: "abc" },
    });
    expect(slack.statusCode).toBe(503);
    expect(slack.json()).toEqual({ error: "channels_slack_inbound_not_configured" });
    const telegram = await f.app.inject({
      method: "POST",
      url: `/api/marketplace/channels/telegram/webhook/${"A".repeat(43)}`,
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "secret" },
      payload: { update_id: 1 },
    });
    expect(telegram.statusCode).toBe(404);
    expect(f.store.channels.inbound.listEvents(TENANT, { limit: 10 })).toEqual([]);
    expect(f.store.channels.inbound.listRoutes(TENANT)).toEqual([]);
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

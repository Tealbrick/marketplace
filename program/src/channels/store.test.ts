import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MARKETPLACE_TABLES, SqliteMarketplaceStore } from "../store.js";
import { sha256Hex } from "./canonical-json.js";
import type { ChannelCaps } from "./policy.js";
import {
  CHANNEL_TABLES,
  ChannelStoreError,
  migrateChannelTables,
  readAttachmentBytes,
  writeAttachmentBytes,
  type ChannelStore,
  type ReservePostInput,
} from "./store.js";

const roots: string[] = [];
const stores: SqliteMarketplaceStore[] = [];
const WS = "org-1";
const T0 = Date.parse("2026-10-09T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const CEILING: ChannelCaps = { perDay: 6, minIntervalSeconds: 600, onePerPhase: true };

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-channels-"));
  roots.push(root);
  return root;
}

async function fixture() {
  const root = await tempRoot();
  const store = new SqliteMarketplaceStore(path.join(root, "data", "marketplace.sqlite"), {
    logPath: path.join(root, "logs", "marketplace-debug.jsonl"),
  });
  stores.push(store);
  const channels = store.channels;
  const channel = channels.createChannel({
    workspaceSlug: WS,
    slug: "henry-promo",
    label: "Henry promo",
    kind: "chat",
    provider: "telegram",
    connectionId: "conn_1",
    destination: { type: "channel", externalId: "-100123", title: "Promo" },
    status: "active",
    now: at(0),
  });
  return { root, store, channels, channel };
}

let keySeq = 0;
function reserveInput(
  channelId: string,
  overrides: Partial<ReservePostInput> = {},
): ReservePostInput {
  keySeq += 1;
  return {
    workspaceSlug: WS,
    channelId,
    agentId: "agent-a",
    consentId: "consent-a",
    mode: "immediate",
    text: `post ${keySeq}`,
    digest: "d".repeat(64),
    authority: "approval:apr_1",
    idempotencyKey: `key-${keySeq}`,
    ceiling: CEILING,
    now: at(0),
    ...overrides,
  };
}

function mustReserve(channels: ChannelStore, input: ReservePostInput) {
  const result = channels.reservePost(input);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.post;
}

describe("channel schema", () => {
  it("lists the channel tables in the Marketplace inventory and creates them", async () => {
    const { store } = await fixture();
    for (const table of CHANNEL_TABLES) expect(MARKETPLACE_TABLES).toContain(table);
    expect(store.listTables().sort()).toEqual([...MARKETPLACE_TABLES].sort());
  });

  it("is additive: existing tables and rows are untouched and reopening is idempotent", async () => {
    const root = await tempRoot();
    const dbPath = path.join(root, "old.sqlite");
    const old = new DatabaseSync(dbPath);
    old.exec("CREATE TABLE audit_event (id TEXT PRIMARY KEY, metadata TEXT NOT NULL)");
    old.prepare("INSERT INTO audit_event VALUES (?, ?)").run("evt_1", "{}");
    const before = old.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all();
    migrateChannelTables(old);
    migrateChannelTables(old);
    const after = old.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all() as Array<{ name: string }>;
    for (const entry of before) expect(after).toContainEqual(entry);
    const added = after.map((entry) => entry.name).filter((name) => name !== "audit_event");
    expect(added.every((name) => name.startsWith("channel") || name.startsWith("idx_channel") || name.startsWith("marketplace_used") || name.startsWith("sqlite_autoindex_"))).toBe(true);
    expect(old.prepare("SELECT * FROM audit_event").all()).toEqual([{ id: "evt_1", metadata: "{}" }]);
    old.close();

    const { store } = await fixture();
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new SqliteMarketplaceStore(store.dbPath);
    stores.push(reopened);
    expect(reopened.channels.getChannelBySlug(WS, "henry-promo")?.label).toBe("Henry promo");
  });
});

describe("channel records", () => {
  it("creates channels with defaults and enforces slug format and per-workspace uniqueness", async () => {
    const { channels, channel } = await fixture();
    expect(channel).toMatchObject({
      slug: "henry-promo",
      status: "active",
      revision: 1,
      destination: { externalId: "-100123" },
      policy: { standingGrants: "disabled", caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true } },
    });
    const base = {
      workspaceSlug: WS,
      label: "x",
      kind: "chat" as const,
      provider: "discord",
      connectionId: "conn_2",
      destination: { type: "channel", externalId: "1", title: "x" },
    };
    expect(() => channels.createChannel({ ...base, slug: "Bad Slug" })).toThrow(ChannelStoreError);
    expect(() => channels.createChannel({ ...base, slug: "a" })).toThrow(/slug/u);
    expect(() => channels.createChannel({ ...base, slug: "henry-promo" })).toThrow(/already exists/u);
    expect(channels.createChannel({ ...base, workspaceSlug: "org-2", slug: "henry-promo" }).workspaceSlug).toBe("org-2");
    expect(() => channels.createChannel({ ...base, slug: "bad-policy", policy: { caps: { perDay: 0 } } })).toThrow(/policy/u);
    expect(channels.getChannel("org-2", channel.id)).toBeNull();
  });

  it("bumps revision only on a policy change and supports compare-and-set", async () => {
    const { channels, channel } = await fixture();
    const relabeled = channels.updateChannel(WS, channel.id, { label: "Promo" });
    expect(relabeled.revision).toBe(1);
    const tightened = channels.updateChannel(WS, channel.id, { policy: { caps: { perDay: 3 } } }, { expectRevision: 1 });
    expect(tightened).toMatchObject({ revision: 2, policy: { caps: { perDay: 3 } } });
    expect(() => channels.updateChannel(WS, channel.id, { label: "x" }, { expectRevision: 1 })).toThrow(/changed/u);
    expect(channels.setChannelStatus(WS, channel.id, "paused").status).toBe("paused");
    expect(channels.listChannels(WS, { status: "paused" }).map((item) => item.id)).toEqual([channel.id]);
  });

  it("stores standing grants and guards status transitions", async () => {
    const { channels, channel } = await fixture();
    const grant = channels.createStandingGrant({
      workspaceSlug: WS,
      channelId: channel.id,
      agentId: "agent-a",
      consentId: "consent-a",
      purpose: "weekly meetup announce/reminder/recap",
      caps: { perDay: 3, minIntervalSeconds: 900, onePerPhase: true },
      scope: { phases: ["announce"], files: false, immediate: true, scheduled: true },
      expires: at(60 * 24 * 30),
      now: at(0),
    });
    expect(grant).toMatchObject({ status: "proposed", digest: null, approvedBy: null, expires: at(60 * 24 * 30) });
    const approved = channels.updateStandingGrant(
      WS,
      grant.id,
      { status: "active", digest: "e".repeat(64), approvedBy: "owner-1", approvedAt: at(1), approvalSource: "marketplace-ui", now: at(1) },
      { expectStatus: "proposed" },
    );
    expect(approved).toMatchObject({ status: "active", approvedBy: "owner-1", approvalSource: "marketplace-ui" });
    // A second decision that expected `proposed` loses.
    expect(channels.updateStandingGrant(WS, grant.id, { status: "declined" }, { expectStatus: "proposed" })).toBeNull();
    expect(channels.listStandingGrants(WS, { agentId: "agent-a", status: "active" })).toHaveLength(1);
    expect(channels.getStandingGrant("org-2", grant.id)).toBeNull();
    expect(() =>
      channels.createStandingGrant({ ...grant, purpose: " ", notBefore: null }),
    ).toThrow(/purpose/u);
  });

  it("stores attachment metadata and writes bytes atomically under a root", async () => {
    const { root, channels } = await fixture();
    const dir = path.join(root, "data", "channels", "attachments");
    const bytes = Buffer.from("poster bytes");
    const sha = sha256Hex(bytes);
    expect(() => writeAttachmentBytes(dir, bytes, "0".repeat(64))).toThrow(/match/u);
    const written = writeAttachmentBytes(dir, bytes, sha);
    expect(written).toEqual({ sha256: sha, path: path.join(dir, sha), bytes: bytes.length });
    expect(writeAttachmentBytes(dir, bytes).path).toBe(written.path);
    expect(await readdir(dir)).toEqual([sha]);
    expect(readAttachmentBytes(dir, sha).toString()).toBe("poster bytes");
    await writeFile(written.path, "tampered");
    expect(() => readAttachmentBytes(dir, sha)).toThrow(/corrupt/u);
    expect(() => readAttachmentBytes(dir, "../etc/passwd")).toThrow(/Invalid/u);

    const record = channels.insertAttachment({
      workspaceSlug: WS,
      sha256: sha,
      contentType: "image/png",
      bytes: bytes.length,
      name: "poster.png",
      createdBy: "agent-a",
    });
    expect(channels.getAttachments(WS, [record.id, "missing"])).toEqual([record]);
    expect(channels.getAttachment("org-2", record.id)).toBeNull();
  });

  it("keeps one receipt per post and purges by age", async () => {
    const { channels, channel } = await fixture();
    const post = mustReserve(channels, reserveInput(channel.id));
    const base = {
      postId: post.id,
      workspaceSlug: WS,
      channelId: channel.id,
      agentId: "agent-a",
      provider: "telegram",
      digest: post.digest,
      authority: post.authority,
      text: post.text,
    };
    channels.upsertReceipt({ ...base, status: "pending", now: at(0) });
    const sent = channels.upsertReceipt({
      ...base,
      status: "sent",
      resultIds: ["42"],
      resultUrls: ["https://t.me/c/123/42"],
      sentAt: at(1),
      now: at(1),
    });
    expect(sent).toMatchObject({ status: "sent", resultIds: ["42"], sentAt: at(1), createdAt: at(0) });
    expect(channels.listReceipts(WS, { agentId: "agent-a" })).toHaveLength(1);
    expect(channels.listReceipts(WS, { agentId: "agent-b" })).toHaveLength(0);
    expect(() => channels.upsertReceipt({ ...base, workspaceSlug: "org-2", status: "sent" })).toThrow(/another workspace/u);
    expect(channels.purgeReceipts(WS, at(-1))).toBe(0);
    expect(channels.purgeReceipts(WS, at(5))).toBe(1);
    expect(channels.getReceiptByPost(WS, post.id)).toBeNull();
  });
});

describe("caps reservation", () => {
  it("allows 6 posts a day and refuses the 7th with retryAfterSeconds", async () => {
    const { channels, channel } = await fixture();
    for (let i = 0; i < 6; i += 1) {
      const post = mustReserve(channels, reserveInput(channel.id, { now: at(i * 11) }));
      expect(post).toMatchObject({ status: "sending", reservedAt: at(i * 11) });
    }
    const refused = channels.reservePost(reserveInput(channel.id, { now: at(70) }));
    expect(refused).toEqual({ ok: false, error: "channel_cap_per_day", retryAfterSeconds: (24 * 60 - 70) * 60 });
    expect(channels.listPosts(WS, { channelId: channel.id })).toHaveLength(6);
    // The oldest post leaves the 24 h window.
    expect(channels.reservePost(reserveInput(channel.id, { now: at(24 * 60 + 1) })).ok).toBe(true);
  });

  it("shares the channel ceiling across agents", async () => {
    const { channels, channel } = await fixture();
    const ceiling = { ...CEILING, perDay: 2, minIntervalSeconds: 0 };
    mustReserve(channels, reserveInput(channel.id, { ceiling, agentId: "agent-a", now: at(0) }));
    mustReserve(channels, reserveInput(channel.id, { ceiling, agentId: "agent-b", consentId: "consent-b", now: at(1) }));
    const refused = channels.reservePost(reserveInput(channel.id, { ceiling, agentId: "agent-c", consentId: "consent-c", now: at(2) }));
    expect(refused).toMatchObject({ ok: false, error: "channel_cap_per_day" });
  });

  it("applies the hourly cap", async () => {
    const { channels, channel } = await fixture();
    const ceiling = { ...CEILING, perHour: 1, minIntervalSeconds: 0 };
    mustReserve(channels, reserveInput(channel.id, { ceiling, now: at(0) }));
    expect(channels.reservePost(reserveInput(channel.id, { ceiling, now: at(30) }))).toEqual({
      ok: false,
      error: "channel_cap_per_hour",
      retryAfterSeconds: 30 * 60,
    });
    expect(channels.reservePost(reserveInput(channel.id, { ceiling, now: at(61) })).ok).toBe(true);
  });

  it("refuses inside the minimum interval with retryAfterSeconds", async () => {
    const { channels, channel } = await fixture();
    mustReserve(channels, reserveInput(channel.id, { now: at(0) }));
    expect(channels.reservePost(reserveInput(channel.id, { now: at(5) }))).toEqual({
      ok: false,
      error: "channel_min_interval",
      retryAfterSeconds: 300,
    });
    expect(channels.reservePost(reserveInput(channel.id, { now: at(10) })).ok).toBe(true);
  });

  it("refuses a second post for the same campaign ref and phase", async () => {
    const { channels, channel } = await fixture();
    const campaign = { ref: "https://lu.ma/abc", phase: "announce" };
    mustReserve(channels, reserveInput(channel.id, { campaign, now: at(0) }));
    expect(channels.reservePost(reserveInput(channel.id, { campaign, now: at(30) }))).toEqual({
      ok: false,
      error: "channel_phase_duplicate",
    });
    expect(channels.reservePost(reserveInput(channel.id, { campaign: { ...campaign, phase: "reminder" }, now: at(30) })).ok).toBe(true);
    const relaxed = { ...CEILING, onePerPhase: false };
    expect(channels.reservePost(reserveInput(channel.id, { campaign, ceiling: relaxed, now: at(60) })).ok).toBe(true);
  });

  it("does not count failed, skipped, cancelled or expired posts, but counts uncertain ones", async () => {
    const { channels, channel } = await fixture();
    const ceiling = { ...CEILING, perDay: 1 };
    const campaign = { ref: "https://lu.ma/abc", phase: "announce" };
    for (const status of ["failed", "skipped", "cancelled", "expired"] as const) {
      const post = mustReserve(channels, reserveInput(channel.id, { ceiling, campaign, now: at(0) }));
      expect(channels.finishPost(WS, post.id, { status, reason: "test" })?.status).toBe(status);
    }
    const uncertain = mustReserve(channels, reserveInput(channel.id, { ceiling, campaign, now: at(0) }));
    channels.finishPost(WS, uncertain.id, { status: "uncertain", from: ["sending"] });
    expect(channels.reservePost(reserveInput(channel.id, { ceiling: { ...ceiling, perDay: 6 }, campaign, now: at(30) }))).toEqual({
      ok: false,
      error: "channel_phase_duplicate",
    });
    expect(channels.reservePost(reserveInput(channel.id, { ceiling, now: at(30) }))).toMatchObject({
      ok: false,
      error: "channel_cap_per_day",
    });
  });

  it("applies grant caps to the grant's own posts and effective = min(grant, ceiling)", async () => {
    const { channels, channel } = await fixture();
    const grant = { id: "chg_1", caps: { perDay: 2, minIntervalSeconds: 0, onePerPhase: false } };
    mustReserve(channels, reserveInput(channel.id, { grant, authority: "grant:chg_1", now: at(0) }));
    mustReserve(channels, reserveInput(channel.id, { grant, authority: undefined, now: at(10) }));
    // Ceiling minIntervalSeconds 600 still applies to the grant (effective = tighter).
    expect(channels.reservePost(reserveInput(channel.id, { grant, authority: undefined, now: at(15) }))).toMatchObject({
      ok: false,
      error: "channel_min_interval",
    });
    expect(channels.reservePost(reserveInput(channel.id, { grant, authority: undefined, now: at(25) }))).toMatchObject({
      ok: false,
      error: "channel_cap_per_day",
    });
    // An owner-approved post is outside the grant's own budget but inside the ceiling.
    const approved = mustReserve(channels, reserveInput(channel.id, { now: at(25) }));
    expect(approved.authority).toBe("approval:apr_1");
    expect(() => channels.reservePost(reserveInput(channel.id, { grant, authority: "grant:other" }))).toThrow(/Authority/u);
  });

  it("is idempotent on (workspace, agent, idempotency key)", async () => {
    const { channels, channel } = await fixture();
    const input = reserveInput(channel.id, { now: at(0) });
    const first = channels.reservePost(input);
    const second = channels.reservePost({ ...input, now: at(1) });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, post: { id: first.post.id } });
    expect(channels.listPosts(WS)).toHaveLength(1);
    // A different agent with the same key is a different post.
    expect(channels.reservePost({ ...input, agentId: "agent-b", now: at(20) })).toMatchObject({ ok: true, replayed: false });
  });

  it("rolls back and leaves no transaction open after a refusal or an error", async () => {
    const { channels, channel } = await fixture();
    mustReserve(channels, reserveInput(channel.id, { now: at(0) }));
    expect(channels.reservePost(reserveInput(channel.id, { now: at(1) })).ok).toBe(false);
    expect(() => channels.reservePost(reserveInput(channel.id, { mode: "scheduled", sendAt: null, now: at(20) }))).toThrow(/sendAt/u);
    expect(channels.reservePost(reserveInput(channel.id, { now: at(20) })).ok).toBe(true);
    expect(channels.listPosts(WS)).toHaveLength(2);
  });
});

describe("scheduler claims", () => {
  async function scheduled(channels: ChannelStore, channelId: string, sendAt: string, key: string) {
    return channels.insertPost({
      workspaceSlug: WS,
      channelId,
      agentId: "agent-a",
      consentId: "consent-a",
      mode: "scheduled",
      sendAt,
      text: "later",
      digest: "f".repeat(64),
      authority: "grant:chg_1",
      idempotencyKey: key,
      status: "scheduled",
      now: at(0),
    }).post;
  }

  it("claims only due scheduled rows, never twice while the lease holds", async () => {
    const { channels, channel } = await fixture();
    const due = await scheduled(channels, channel.id, at(10), "s1");
    await scheduled(channels, channel.id, at(60), "s2");
    expect(channels.claimDuePosts({ now: at(5), claimer: "tick-a", leaseMs: 60_000 })).toEqual([]);
    const claimed = channels.claimDuePosts({ now: at(10), claimer: "tick-a", leaseMs: 60_000 });
    expect(claimed.map((post) => post.id)).toEqual([due.id]);
    expect(claimed[0]).toMatchObject({ claimedBy: "tick-a", claimExpiresAt: new Date(T0 + 10 * 60_000 + 60_000).toISOString() });
    expect(channels.claimDuePosts({ now: at(10.5), claimer: "tick-b", leaseMs: 60_000 })).toEqual([]);
  });

  it("lets another claimer take over after the lease expires", async () => {
    const { channels, channel } = await fixture();
    const due = await scheduled(channels, channel.id, at(10), "s1");
    channels.claimDuePosts({ now: at(10), claimer: "tick-a", leaseMs: 60_000 });
    const takeover = channels.claimDuePosts({ now: at(12), claimer: "tick-b", leaseMs: 60_000 });
    expect(takeover.map((post) => [post.id, post.claimedBy])).toEqual([[due.id, "tick-b"]]);
    // The stale claimer can no longer reserve or finish the post.
    expect(channels.reserveScheduledPost({ workspaceSlug: WS, postId: due.id, claimer: "tick-a", ceiling: CEILING, now: at(12) })).toEqual({
      ok: false,
      error: "channel_post_not_claimed",
    });
    expect(channels.finishPost(WS, due.id, { status: "skipped", claimer: "tick-a" })).toBeNull();
  });

  it("reserves a claimed post at send time and clears the claim when finished", async () => {
    const { channels, channel } = await fixture();
    const due = await scheduled(channels, channel.id, at(10), "s1");
    channels.claimDuePosts({ now: at(10), claimer: "tick-a", leaseMs: 60_000 });
    const grant = { id: "chg_1", caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true } };
    const reserved = channels.reserveScheduledPost({ workspaceSlug: WS, postId: due.id, claimer: "tick-a", grant, ceiling: CEILING, now: at(10) });
    expect(reserved).toMatchObject({ ok: true, post: { status: "sending", reservedAt: at(10), claimedBy: "tick-a" } });
    // A `sending` row is never claimable again, even after its lease expires.
    expect(channels.claimDuePosts({ now: at(30), claimer: "tick-b", leaseMs: 60_000 })).toEqual([]);
    const finished = channels.finishPost(WS, due.id, { status: "sent", claimer: "tick-a", from: ["sending"] });
    expect(finished).toMatchObject({ status: "sent", claimedBy: null, claimExpiresAt: null });
  });

  it("applies caps at send time", async () => {
    const { channels, channel } = await fixture();
    mustReserve(channels, reserveInput(channel.id, { now: at(5) }));
    const due = await scheduled(channels, channel.id, at(10), "s1");
    channels.claimDuePosts({ now: at(10), claimer: "tick-a", leaseMs: 60_000 });
    expect(channels.reserveScheduledPost({ workspaceSlug: WS, postId: due.id, claimer: "tick-a", ceiling: CEILING, now: at(10) })).toEqual({
      ok: false,
      error: "channel_min_interval",
      retryAfterSeconds: 300,
    });
    expect(channels.getPost(WS, due.id)?.status).toBe("scheduled");
  });

  it("insertPost is idempotent and requires sendAt for scheduled posts", async () => {
    const { channels, channel } = await fixture();
    const first = await scheduled(channels, channel.id, at(10), "s1");
    const again = channels.insertPost({ ...first, campaign: null, status: "scheduled" });
    expect(again).toMatchObject({ created: false, post: { id: first.id } });
    expect(() => channels.insertPost({ ...first, idempotencyKey: "s2", sendAt: null, campaign: null, status: "scheduled" })).toThrow(/sendAt/u);
  });
});

describe("used approval proofs", () => {
  it("accepts a proof once, instance-wide, and prunes expired rows", async () => {
    const { store, channels } = await fixture();
    expect(channels.markUsedApprovalProof({ proofId: "evt_1", kind: "nostr", expiresAt: at(15), now: at(0) })).toEqual({ ok: true });
    expect(channels.markUsedApprovalProof({ proofId: "evt_1", kind: "nostr", expiresAt: at(15), now: at(1) })).toEqual({
      ok: false,
      error: "approval_proof_reused",
    });
    expect(channels.markUsedApprovalProof({ proofId: "jti_1", kind: "portal", expiresAt: at(5), now: at(1) }).ok).toBe(true);
    // Pruning happens on the next mark after expiry.
    channels.markUsedApprovalProof({ proofId: "evt_2", kind: "nostr", expiresAt: at(30), now: at(10) });
    expect(channels.isApprovalProofUsed("jti_1")).toBe(false);
    expect(channels.isApprovalProofUsed("evt_1")).toBe(true);
    // The table has no workspace column: one proof resolves one call in the whole instance.
    const raw = new DatabaseSync(store.dbPath);
    const columns = (raw.prepare("PRAGMA table_info(marketplace_used_approval_proof)").all() as Array<{ name: string }>).map((c) => c.name);
    raw.close();
    expect(columns).toEqual(["proof_id", "kind", "expires_at"]);
  });
});

describe("credential hygiene", () => {
  it("has no credential-shaped columns in the channel tables", async () => {
    const { store } = await fixture();
    const raw = new DatabaseSync(store.dbPath);
    for (const table of CHANNEL_TABLES) {
      const columns = (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns.filter((name) => /token|secret|password|api_key|credential/u.test(name))).toEqual([]);
    }
    raw.close();
    expect((await readFile(store.dbPath)).length).toBeGreaterThan(0);
  });
});

import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MARKETPLACE_TABLES, SqliteMarketplaceStore } from "../store.js";
import { sha256Hex } from "./canonical-json.js";
import type { ChannelCaps } from "./policy.js";
import {
  CHANNEL_POST_TRANSITIONS,
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
    reserver: "req-1",
    ...overrides,
  };
}

/** Test-only: sets a row's status on a second connection, bypassing the transition table. */
function forceStatus(store: SqliteMarketplaceStore, postId: string, status: string) {
  const raw = new DatabaseSync(store.dbPath);
  raw.prepare("UPDATE channel_post SET status = ? WHERE id = ?").run(status, postId);
  raw.close();
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

  it("sets a 5 s busy timeout on the store connection", async () => {
    const { store } = await fixture();
    const db = (store as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
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
    const { store, channels, channel } = await fixture();
    const ceiling = { ...CEILING, perDay: 1 };
    const campaign = { ref: "https://lu.ma/abc", phase: "announce" };
    for (const status of ["failed", "skipped", "cancelled", "expired"] as const) {
      const post = mustReserve(channels, reserveInput(channel.id, { ceiling, campaign, now: at(0) }));
      // Only `failed` is reachable from `sending`; the others are forced to prove they never count.
      if (status === "failed") channels.finishPost(WS, post.id, { status, from: ["sending"], reason: "test" });
      else forceStatus(store, post.id, status);
      expect(channels.getPost(WS, post.id)?.status).toBe(status);
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
    const result = channels.insertPost({
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
    });
    if (!result.ok) throw new Error(result.error);
    return result.post;
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
    expect(channels.finishPost(WS, due.id, { status: "skipped", from: ["scheduled"], claimer: "tick-a" })).toBeNull();
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
    expect(again).toMatchObject({ ok: true, created: false, post: { id: first.id } });
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

describe("post transitions (R1)", () => {
  const ALL = ["held", "scheduled", "sending", "sent", "failed", "uncertain", "skipped", "cancelled", "expired"] as const;
  const ALLOWED: Record<string, string[]> = {
    held: ["cancelled", "expired", "skipped"],
    scheduled: ["cancelled", "skipped", "expired"],
    sending: ["sent", "failed", "uncertain"],
    uncertain: ["sent", "failed"],
  };

  it("pins the transition table", () => {
    for (const from of ALL) {
      expect([...CHANNEL_POST_TRANSITIONS[from]].sort()).toEqual([...(ALLOWED[from] ?? [])].sort());
    }
  });

  it("allows exactly the table and refuses every other pair, including uncertain → scheduled", async () => {
    const { store, channels, channel } = await fixture();
    for (const from of ALL) {
      for (const to of ALL) {
        const post = mustReserve(channels, reserveInput(channel.id, { ceiling: { ...CEILING, perDay: 10_000, minIntervalSeconds: 0, onePerPhase: false } }));
        forceStatus(store, post.id, from);
        if ((ALLOWED[from] ?? []).includes(to)) {
          expect(channels.finishPost(WS, post.id, { status: to, from: [from] }), `${from} → ${to}`).toMatchObject({
            status: to,
            claimedBy: null,
            claimExpiresAt: null,
          });
        } else {
          expect(() => channels.finishPost(WS, post.id, { status: to, from: [from] }), `${from} → ${to}`).toThrow(
            expect.objectContaining({ code: "channel_transition_refused" }),
          );
          expect(channels.getPost(WS, post.id)?.status).toBe(from);
        }
      }
    }
    // Terminal and scheduled/sending targets are never reachable.
    for (const terminal of ["sent", "failed", "skipped", "cancelled", "expired"] as const) {
      expect(CHANNEL_POST_TRANSITIONS[terminal]).toEqual([]);
    }
    for (const from of ALL) {
      expect(CHANNEL_POST_TRANSITIONS[from]).not.toContain("scheduled");
      expect(CHANNEL_POST_TRANSITIONS[from]).not.toContain("sending");
    }
  });

  it("requires from and returns null when the current status is not in it", async () => {
    const { channels, channel } = await fixture();
    const post = mustReserve(channels, reserveInput(channel.id));
    expect(() => channels.finishPost(WS, post.id, { status: "sent", from: [] })).toThrow(/allowed current statuses/u);
    expect(channels.finishPost(WS, post.id, { status: "sent", from: ["uncertain"] })).toBeNull();
    expect(channels.getPost(WS, post.id)?.status).toBe("sending");
  });
});

describe("send lease recovery (R2)", () => {
  it("gives immediate reservations a lease", async () => {
    const { channels, channel } = await fixture();
    const post = mustReserve(channels, reserveInput(channel.id, { reserver: "proc-1", leaseMs: 60_000, now: at(0) }));
    expect(post).toMatchObject({ status: "sending", claimedBy: "proc-1", claimExpiresAt: at(1) });
    expect(() => channels.reservePost(reserveInput(channel.id, { reserver: "" }))).toThrow(/reserver/u);
  });

  it("recovers a crash after reserve as uncertain: never re-claimable, never re-sent", async () => {
    const { channels, channel } = await fixture();
    const input = reserveInput(channel.id, { reserver: "proc-1", leaseMs: 60_000, now: at(0) });
    const post = mustReserve(channels, input);
    expect(channels.recoverStaleSending({ now: at(0.5) })).toEqual([]);
    const recovered = channels.recoverStaleSending({ now: at(2) });
    expect(recovered).toMatchObject([{ id: post.id, status: "uncertain", reason: "send_lease_expired", claimedBy: null }]);
    expect(channels.recoverStaleSending({ now: at(3) })).toEqual([]);
    // Not claimable by the scheduler and not reservable again.
    expect(channels.claimDuePosts({ now: at(3), claimer: "tick-a", leaseMs: 60_000 })).toEqual([]);
    expect(channels.reserveScheduledPost({ workspaceSlug: WS, postId: post.id, claimer: "proc-1", ceiling: CEILING, now: at(3) })).toEqual({
      ok: false,
      error: "channel_post_not_claimed",
    });
    // The crashed process cannot report a late result as a fresh send, and the retry replays the uncertain row.
    expect(channels.finishPost(WS, post.id, { status: "sent", from: ["sending"], claimer: "proc-1" })).toBeNull();
    expect(channels.reservePost({ ...input, now: at(30) })).toMatchObject({ ok: true, replayed: true, post: { status: "uncertain" } });
    expect(channels.listPosts(WS)).toHaveLength(1);
    // Uncertain still counts against caps until the owner resolves it.
    expect(channels.reservePost(reserveInput(channel.id, { ceiling: { ...CEILING, perDay: 1 }, now: at(30) }))).toMatchObject({
      ok: false,
      error: "channel_cap_per_day",
    });
    expect(channels.finishPost(WS, post.id, { status: "sent", from: ["uncertain"] })?.status).toBe("sent");
  });

  it("refreshes the lease when a scheduled post starts sending and recovers it the same way", async () => {
    const { channels, channel } = await fixture();
    const inserted = channels.insertPost({
      workspaceSlug: WS,
      channelId: channel.id,
      agentId: "agent-a",
      consentId: "consent-a",
      mode: "scheduled",
      sendAt: at(10),
      text: "later",
      digest: "f".repeat(64),
      authority: "approval:apr_1",
      idempotencyKey: "s1",
      status: "scheduled",
      now: at(0),
    });
    if (!inserted.ok) throw new Error(inserted.error);
    channels.claimDuePosts({ now: at(10), claimer: "tick-a", leaseMs: 60_000 });
    const sending = channels.reserveScheduledPost({ workspaceSlug: WS, postId: inserted.post.id, claimer: "tick-a", ceiling: CEILING, now: at(10.5), leaseMs: 120_000 });
    expect(sending).toMatchObject({ ok: true, post: { status: "sending", claimExpiresAt: at(12.5) } });
    expect(channels.recoverStaleSending({ now: at(12) })).toEqual([]);
    expect(channels.recoverStaleSending({ now: at(13) }).map((post) => post.status)).toEqual(["uncertain"]);
    expect(channels.claimDuePosts({ now: at(14), claimer: "tick-b", leaseMs: 60_000 })).toEqual([]);
  });
});

describe("idempotency conflicts (R3)", () => {
  it("replays the same digest and channel and refuses a different digest or channel", async () => {
    const { channels, channel } = await fixture();
    const other = channels.createChannel({
      workspaceSlug: WS,
      slug: "other",
      label: "Other",
      kind: "chat",
      provider: "telegram",
      connectionId: "conn_1",
      destination: { type: "channel", externalId: "-100999", title: "Other" },
    });
    const input = reserveInput(channel.id, { now: at(0) });
    const first = mustReserve(channels, input);
    expect(channels.reservePost({ ...input, now: at(1) })).toMatchObject({ ok: true, replayed: true, post: { id: first.id } });
    expect(channels.reservePost({ ...input, digest: "0".repeat(64), now: at(20) })).toEqual({ ok: false, error: "channel_idempotency_conflict" });
    expect(channels.reservePost({ ...input, channelId: other.id, now: at(20) })).toEqual({ ok: false, error: "channel_idempotency_conflict" });
    expect(channels.listPosts(WS)).toHaveLength(1);
  });

  it("applies the same rule to insertPost", async () => {
    const { channels, channel } = await fixture();
    const base = {
      workspaceSlug: WS,
      channelId: channel.id,
      agentId: "agent-a",
      consentId: "consent-a",
      mode: "immediate" as const,
      text: "held",
      digest: "a".repeat(64),
      idempotencyKey: "h1",
      status: "held" as const,
    };
    const first = channels.insertPost(base);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(channels.insertPost(base)).toMatchObject({ ok: true, created: false });
    expect(channels.insertPost({ ...base, digest: "b".repeat(64) })).toEqual({ ok: false, error: "channel_idempotency_conflict" });
    expect(() => channels.insertPost({ ...base, idempotencyKey: "h2", status: "sending" })).toThrow(/held or scheduled/u);
  });
});

describe("tenant isolation (R4)", () => {
  it("refuses another workspace's channel in reservePost, insertPost and createStandingGrant", async () => {
    const { channels, channel } = await fixture();
    expect(channels.reservePost(reserveInput(channel.id, { workspaceSlug: "org-2" }))).toEqual({ ok: false, error: "channel_not_found" });
    expect(
      channels.insertPost({
        workspaceSlug: "org-2",
        channelId: channel.id,
        agentId: "agent-b",
        consentId: "consent-b",
        mode: "immediate",
        text: "x",
        digest: "a".repeat(64),
        idempotencyKey: "k",
        status: "held",
      }),
    ).toEqual({ ok: false, error: "channel_not_found" });
    expect(() =>
      channels.createStandingGrant({
        workspaceSlug: "org-2",
        channelId: channel.id,
        agentId: "agent-b",
        consentId: "consent-b",
        purpose: "probe",
        caps: { perDay: 1, minIntervalSeconds: 600, onePerPhase: true },
        scope: { files: false, immediate: true, scheduled: false },
        expires: at(60 * 24),
      }),
    ).toThrow(expect.objectContaining({ code: "channel_not_found" }));
    expect(channels.listPosts("org-2")).toEqual([]);
    expect(channels.listStandingGrants("org-2")).toEqual([]);
  });

  it("never counts another workspace's posts against caps", async () => {
    const { store, channels, channel } = await fixture();
    const b = channels.createChannel({
      workspaceSlug: "org-2",
      slug: "b-promo",
      label: "B",
      kind: "chat",
      provider: "telegram",
      connectionId: "conn_b",
      destination: { type: "channel", externalId: "-200", title: "B" },
    });
    const campaign = { ref: "https://lu.ma/abc", phase: "announce" };
    const grant = { id: "chg_shared", caps: { perDay: 1, minIntervalSeconds: 600, onePerPhase: true } };
    const a = mustReserve(channels, reserveInput(channel.id, { grant, authority: "grant:chg_shared", campaign, now: at(0) }));
    // Probe: a row of workspace A that names B's channel id must not leak into B's counts.
    const raw = new DatabaseSync(store.dbPath);
    raw.prepare("UPDATE channel_post SET channel_id = ? WHERE id = ?").run(b.id, a.id);
    raw.close();
    const ceiling = { ...CEILING, perDay: 1 };
    expect(
      channels.reservePost(reserveInput(b.id, { workspaceSlug: "org-2", agentId: "agent-b", ceiling, grant, authority: "grant:chg_shared", campaign, now: at(1) })),
    ).toMatchObject({ ok: true, replayed: false });
  });
});

describe("reserveHeldPost (review condition 8b(iv))", () => {
  async function heldFixture(input: { mode?: "immediate" | "scheduled"; sendAt?: string } = {}) {
    const f = await fixture();
    const now = new Date();
    const post = f.channels.insertPost({
      workspaceSlug: WS,
      channelId: f.channel.id,
      agentId: "agent-1",
      consentId: "consent-row-1",
      mode: input.mode ?? "immediate",
      sendAt: input.sendAt ?? null,
      text: "Meetup tonight",
      attachments: [{ id: "cha_1", kind: "image" }],
      digest: "d".repeat(64),
      idempotencyKey: "held-key-0001",
      status: "held",
      now,
    });
    if (!post.ok) throw new Error(post.error);
    const approval = f.store.createCompanyBoxApproval({
      workspaceSlug: WS,
      pluginId: "channels-telegram",
      actionKey: "channel.post",
      capability: "connector.dispatch",
      agentId: "agent-1",
      sourceKind: "channel-consent",
      sourceRef: "consent-row-1",
      idempotencyKey: `channel-post:${post.post.id}`,
      fingerprint: "d".repeat(64),
      arguments: { postId: post.post.id },
      argumentsPreview: "",
      ttlMs: 3_600_000,
    });
    return { ...f, now, post: post.post, approval };
  }
  const reserve = (f: Awaited<ReturnType<typeof heldFixture>>, extra: Partial<Parameters<ChannelStore["reserveHeldPost"]>[0]> = {}) =>
    f.channels.reserveHeldPost({
      workspaceSlug: WS,
      postId: f.post.id,
      approvalId: f.approval.id,
      ceiling: CEILING,
      now: f.now,
      reserver: "test-reserver",
      ...extra,
    });

  it("stores the attachment kinds and transcripts of a post in order", async () => {
    const f = await heldFixture();
    expect(f.post.attachmentIds).toEqual(["cha_1"]);
    expect(f.post.attachments).toEqual([{ id: "cha_1", kind: "image" }]);
  });

  it("refuses a pending, denied or foreign-digest approval and changes nothing", async () => {
    const f = await heldFixture();
    expect(reserve(f)).toEqual({ ok: false, error: "channel_approval_invalid" });
    f.store.decideCompanyBoxApproval({ id: f.approval.id, workspaceSlug: WS, decision: "deny", decidedBy: "owner" });
    expect(reserve(f)).toEqual({ ok: false, error: "channel_approval_invalid" });
    expect(f.channels.getPost(WS, f.post.id)!.status).toBe("held");
  });

  it("moves an approved held post to sending exactly once, counted, with the approval authority and a lease", async () => {
    const f = await heldFixture();
    f.store.decideCompanyBoxApproval({ id: f.approval.id, workspaceSlug: WS, decision: "approve", decidedBy: "owner" });
    const first = reserve(f);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.post).toMatchObject({ status: "sending", authority: `approval:${f.approval.id}`, claimedBy: "test-reserver" });
    expect(first.post.reservedAt).not.toBeNull();
    expect(first.post.claimExpiresAt).not.toBeNull();
    expect(reserve(f)).toEqual({ ok: false, error: "channel_post_not_held" });
  });

  it("leaves the post held and the approval unused when the ceiling refuses", async () => {
    const f = await heldFixture();
    f.store.decideCompanyBoxApproval({ id: f.approval.id, workspaceSlug: WS, decision: "approve", decidedBy: "owner" });
    const busy = f.channels.reservePost({
      workspaceSlug: WS,
      channelId: f.channel.id,
      agentId: "agent-2",
      consentId: "c2",
      mode: "immediate",
      text: "other",
      digest: "e".repeat(64),
      idempotencyKey: "other-key-0001",
      ceiling: CEILING,
      now: f.now,
      reserver: "r",
    });
    expect(busy.ok).toBe(true);
    const refused = reserve(f);
    expect(refused).toMatchObject({ ok: false, error: "channel_min_interval" });
    expect(f.channels.getPost(WS, f.post.id)!.status).toBe("held");
    expect(f.store.getCompanyBoxApproval(f.approval.id)!.state).toBe("executing");
  });

  it("never offers held -> sending through finishPost", async () => {
    const f = await heldFixture();
    expect(() => f.channels.finishPost(WS, f.post.id, { status: "sending", from: ["held"] })).toThrow(ChannelStoreError);
    expect(CHANNEL_POST_TRANSITIONS.held).not.toContain("sending");
  });
});

describe("reservation live check (review M2)", () => {
  it("refuses a paused channel, an inactive consent row and an inactive grant inside the transaction", async () => {
    const { store, channels, channel } = await fixture();
    const base = {
      workspaceSlug: WS,
      channelId: channel.id,
      agentId: "agent-1",
      consentId: "consent-row-x",
      mode: "immediate" as const,
      text: "hello",
      digest: "a".repeat(64),
      ceiling: CEILING,
      now: at(0),
      reserver: "r",
    };
    expect(channels.reservePost({ ...base, idempotencyKey: "live-key-0001", live: { consentRowId: "missing-consent", grantId: null } })).toEqual({
      ok: false,
      error: "consent_inactive",
    });
    const grant = channels.createStandingGrant({
      workspaceSlug: WS,
      channelId: channel.id,
      agentId: "agent-1",
      consentId: "consent-row-x",
      purpose: "p",
      caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true },
      scope: { files: false, immediate: true, scheduled: true },
      expires: at(60 * 24),
      now: at(0),
    });
    expect(
      channels.reservePost({ ...base, idempotencyKey: "live-key-0002", grant: { id: grant.id, caps: grant.caps }, live: { consentRowId: null, grantId: grant.id } }),
    ).toEqual({ ok: false, error: "grant_inactive" });
    channels.setChannelStatus(WS, channel.id, "paused", at(0));
    expect(channels.reservePost({ ...base, idempotencyKey: "live-key-0003", live: { consentRowId: null, grantId: null } })).toEqual({
      ok: false,
      error: "channel_paused",
    });
    expect(channels.listPosts(WS)).toEqual([]);
    void store;
  });
});

describe("reserveHeldPost binds the approval to its post (review F2)", () => {
  it("refuses post B with post A's approval even when both have the same digest", async () => {
    const { store, channels, channel } = await fixture();
    const now = new Date();
    const held = (key: string) => {
      const inserted = channels.insertPost({
        workspaceSlug: WS,
        channelId: channel.id,
        agentId: "agent-1",
        consentId: "consent-row-1",
        mode: "immediate",
        text: "Same payload",
        digest: "c".repeat(64),
        idempotencyKey: key,
        status: "held",
        now,
      });
      if (!inserted.ok) throw new Error(inserted.error);
      return inserted.post;
    };
    const a = held("same-digest-a-0001");
    const b = held("same-digest-b-0001");
    const approve = (postId: string) => {
      const approval = store.createCompanyBoxApproval({
        workspaceSlug: WS,
        pluginId: "channels-telegram",
        actionKey: "channel.post",
        capability: "connector.dispatch",
        agentId: "agent-1",
        sourceKind: "channel-consent",
        sourceRef: "consent-row-1",
        idempotencyKey: `channel-post:${postId}`,
        fingerprint: "c".repeat(64),
        arguments: { postId },
        argumentsPreview: "",
        ttlMs: 3_600_000,
      });
      return approval;
    };
    const approvalA = approve(a.id);
    approve(b.id); // B's approval stays pending
    store.decideCompanyBoxApproval({ id: approvalA.id, workspaceSlug: WS, decision: "approve", decidedBy: "owner" });
    const reserve = (postId: string) =>
      channels.reserveHeldPost({ workspaceSlug: WS, postId, approvalId: approvalA.id, ceiling: { ...CEILING, minIntervalSeconds: 0 }, now, reserver: "r" });
    expect(reserve(b.id)).toEqual({ ok: false, error: "channel_approval_invalid" });
    expect(channels.getPost(WS, b.id)!.status).toBe("held");
    expect(channels.denyApprovedHold({ workspaceSlug: WS, approvalId: approvalA.id, postId: b.id, decidedBy: "owner", now })).toBe(false);
    expect(reserve(a.id)).toMatchObject({ ok: true, post: { id: a.id, status: "sending", authority: `approval:${approvalA.id}` } });
    expect(reserve(a.id)).toEqual({ ok: false, error: "channel_post_not_held" });
    expect(channels.getPost(WS, b.id)!.status).toBe("held");
  });
});

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildSilenceOpus } from "../scripts/lib/ogg-opus.js";

import { afterEach, describe, expect, it } from "vitest";

import {
  DISCORD_TOKEN,
  GRANT_A,
  GRANT_ALL,
  GRANT_B,
  PROOF,
  SERVICE,
  TELEGRAM_TOKEN,
  TENANT,
  channelFixture,
  type ChannelFixture,
} from "./channels/app-fixture.js";
import type { ChannelCapabilities } from "./channels/providers/types.js";

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});
async function setup(input: Parameters<typeof channelFixture>[0] = {}) {
  const f = await channelFixture(input);
  fixtures.push(f);
  return f;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
let keyCounter = 0;
const key = (prefix = "post") => `${prefix}-key-${String(++keyCounter).padStart(6, "0")}`;
const text = (value = "Meetup tonight at 7") => ({ text: value });

describe("channels: post with a standing grant (§10 item 1)", () => {
  it("sends through the shared execution path and returns a sent receipt with a URL", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const grant = await f.proposeAndApprove(channel.id);
    const sent = await f.post(channel.id, text(), "agent-post-0001");
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json()).toMatchObject({
      ok: true,
      schema: 1,
      receipt: {
        status: "sent",
        channelId: channel.id,
        provider: "telegram",
        authority: `grant:${grant.id}`,
        resultIds: ["m1"],
        resultUrls: ["https://t.me/c/1234/1"],
      },
    });
    expect(sent.json().receipt.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(sent.json().usageId).toEqual(expect.any(String));
    expect(f.telegram.sends).toHaveLength(1);
    expect(f.telegram.sends[0]!.message.text).toBe("Meetup tonight at 7");
    // Same ledger and audit as every consented call: shapes only, metadata + SHA-256 only.
    const usage = f.store.listUsage({ workspaceSlug: TENANT, provider: "telegram" });
    expect(usage).toEqual([
      expect.objectContaining({ pluginId: "channels-telegram", sourceExecutor: "native", sourceActionKey: "channel.post", status: "succeeded" }),
    ]);
    expect(JSON.stringify(usage)).not.toContain("Meetup tonight");
    const audit = JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }));
    expect(audit).toContain("marketplace.channels.post.sent");
    expect(audit).toContain("marketplace.runtime.execution.completed");
    expect(audit).not.toContain("Meetup tonight");

    // Replay: the same key and payload answers from the stored post; no second send.
    const replay = await f.post(channel.id, text(), "agent-post-0001");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true, replayed: true, receipt: { status: "sent", postId: sent.json().receipt.postId } });
    // Conflict: the same key with another payload.
    const conflict = await f.post(channel.id, text("Something else"), "agent-post-0001");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "channel_idempotency_conflict" });
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("lists only consented channels with effective capabilities and usage, and 404s the rest", async () => {
    const f = await setup();
    const own = await f.createChannel({ slug: "community" });
    const other = await f.createChannel({ slug: "private-chat", externalId: "-1005678" });
    f.consentFor("agent-1", own);
    const list = await f.agent("GET", "/api/marketplace/v1/agent/channels");
    expect(list.statusCode).toBe(200);
    const channels = list.json().channels as Array<Record<string, unknown>>;
    expect(channels.map((entry) => entry.id)).toEqual([own.id]);
    expect(channels[0]).toMatchObject({
      grantClass: "outward",
      usageToday: { counted: 0, perDay: 6 },
      capabilities: {
        channelCapabilities: 2,
        text: { maxChars: 4096 },
        voice: { native: true, types: ["audio/ogg"] },
        video: false,
        // Telegram declares reactions, edit, delete, polls and markdown-v2, but no agent operation uses them yet:
        // the wired filter keeps them out. Replies are wired (marketplace.channels.reply), and so is inbound.
        markup: "plain",
        mentions: { users: false, broadcast: "suppressed" },
        dm: { open: false, maxMembers: 0 },
        thread: { replies: true, topics: true, forum: false },
        reactions: { add: false, remove: false, custom: false },
        edit: { own: false },
        delete: { own: false },
        poll: false,
        canvas: false,
        presence: { typing: false, status: false },
        ephemeral: false,
        live: false,
        inbound: { mode: "webhook", dedupe: true },
      },
    });
    expect(channels[0]!.capabilities).not.toHaveProperty("markupOptions");
    expect(list.body).not.toContain("-1001234");
    const foreign = await f.agent("GET", `/api/marketplace/v1/agent/channels/${other.id}`);
    const unknown = await f.agent("GET", "/api/marketplace/v1/agent/channels/chn_unknown");
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(unknown.json());
    const posted = await f.post(other.id, text(), key());
    expect(posted.statusCode).toBe(404);
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("never exposes a declared feature that no agent operation uses (wired filter)", async () => {
    const f = await setup();
    // The adapter declares reactions, edit, delete, DMs, mentions and inbound, but no route performs them.
    const provider = f.telegram.provider as { capabilities: ChannelCapabilities };
    provider.capabilities = {
      ...provider.capabilities,
      reactions: { add: true, remove: true, custom: true },
      edit: { own: true, windowSeconds: 900 },
      delete: { own: true },
      dm: { open: true, maxMembers: 8 },
      mentions: { users: true, broadcast: "suppressed" },
      inbound: { mode: "webhook", dedupe: true },
    };
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const hidden = {
      reactions: { add: false, remove: false, custom: false },
      edit: { own: false },
      delete: { own: false },
      dm: { open: false, maxMembers: 0 },
      mentions: { users: false, broadcast: "suppressed" },
    };
    const list = await f.agent("GET", "/api/marketplace/v1/agent/channels");
    // Inbound and reply to source are wired (marketplace.channels.inbound / .reply).
    expect(list.json().channels[0].capabilities).toMatchObject({ ...hidden, inbound: { mode: "webhook", dedupe: true }, thread: { topics: true, replies: true }, voice: { native: true } });
    const one = await f.agent("GET", `/api/marketplace/v1/agent/channels/${channel.id}`);
    expect(one.json().channel.capabilities).toMatchObject(hidden);
    const browse = await f.owner("GET", "/api/marketplace/channels");
    const telegram = (browse.json().providers as Array<{ id: string; capabilities?: unknown }>).find((entry) => entry.id === "telegram");
    expect(telegram?.capabilities).toMatchObject(hidden);
    expect(browse.json().channels[0].capabilities).toMatchObject(hidden);
  });
});

describe("channels: caps and refusals (§10 item 2)", () => {
  it("refuses the 7th post of the day, a post inside the minimum interval and a second announce for a campaign", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    for (let index = 0; index < 6; index += 1) {
      const ok = await f.post(channel.id, text(`Post ${index}`), key());
      expect(ok.statusCode, ok.body).toBe(200);
      f.advance(1_000);
    }
    const seventh = await f.post(channel.id, text("Post 7"), key());
    expect(seventh.statusCode).toBe(429);
    expect(seventh.json()).toMatchObject({ error: "channel_cap_per_day", retryAfterSeconds: expect.any(Number) });
    expect(f.telegram.sends).toHaveLength(6);

    const g = await setup();
    const spaced = await g.createChannel({
      slug: "spaced",
      policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true } },
    });
    g.consentFor("agent-1", spaced);
    await g.proposeAndApprove(spaced.id, { caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true } });
    const ref = "https://lu.ma/meetup-1";
    expect((await g.post(spaced.id, { text: "Announce", campaign: { ref, phase: "announce" } }, key())).statusCode).toBe(200);
    g.advance(5 * 60_000);
    const early = await g.post(spaced.id, text("Too soon"), key());
    expect(early.statusCode).toBe(429);
    expect(early.json()).toMatchObject({ error: "channel_min_interval", retryAfterSeconds: 300 });
    g.advance(6 * 60_000);
    const duplicate = await g.post(spaced.id, { text: "Announce again", campaign: { ref, phase: "announce" } }, key());
    expect(duplicate.statusCode).toBe(429);
    expect(duplicate.json()).toMatchObject({ error: "channel_phase_duplicate" });
    // Nothing was consumed by the refusals: one post counted, one send.
    expect(g.store.channels.countCountedPosts(TENANT, spaced.id, new Date(0))).toBe(1);
    expect(g.telegram.sends).toHaveLength(1);
  });

  it("refuses content, capability and attachment problems before anything is held, reserved or sent", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    const denied = await f.post(channel.id, text("This has a FORBIDDEN-TERM inside"), key());
    expect(denied.statusCode).toBe(422);
    expect(denied.json()).toMatchObject({ error: "channel_content_denied" });
    const long = await f.post(channel.id, text("x".repeat(4097)), key());
    expect(long.statusCode).toBe(422);
    expect(long.json()).toMatchObject({ error: "channel_text_too_long" });
    const missing = await f.post(channel.id, { text: "with file", attachments: [{ attachmentId: "cha_missing", kind: "image" }] }, key());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "channel_attachment_not_found" });
    expect(f.telegram.sends).toHaveLength(0);
    expect(f.store.channels.listPosts(TENANT)).toEqual([]);
    expect(f.store.listCompanyBoxApprovals({ workspaceSlug: TENANT })).toEqual([]);
  });

  it("requires an Idempotency-Key and an outward consent", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel, "read");
    const noKey = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/posts`, { payload: text() });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({ error: "idempotency_key_required" });
    const readOnly = await f.post(channel.id, text(), key());
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json()).toMatchObject({ error: "channel_outward_consent_required" });
    // Read suffices for list and get.
    expect((await f.agent("GET", `/api/marketplace/v1/agent/channels/${channel.id}`)).json()).toMatchObject({ channel: { grantClass: "read" } });
  });
});

describe("channels: hold and owner approval (§10 item 3)", () => {
  it("holds a post without a grant, sends it once after the owner approves, and replays the receipt", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, text("Needs approval"), "agent-hold-0001");
    expect(held.statusCode, held.body).toBe(202);
    const pending = held.json();
    expect(pending).toMatchObject({
      error: "approval_pending",
      approvalId: expect.any(String),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      expiresAt: expect.any(String),
      payloadView: { files: [] },
    });
    // K1: the body is the strict contract shape; the post id travels as a header.
    expect(held.headers["tealbrick-post-id"]).toEqual(expect.any(String));
    expect(JSON.parse(pending.payloadView.canonical)).toMatchObject({ text: "Needs approval", channelId: channel.id, op: "post" });
    // No provider call while held (conformance (b)).
    expect(f.telegram.sends).toHaveLength(0);
    const again = await f.post(channel.id, text("Needs approval"), "agent-hold-0001");
    expect(again.statusCode).toBe(202);
    expect(again.json().approvalId).toBe(pending.approvalId);

    // The owner sees the exact payload and approves in the existing Approvals queue.
    const detail = await f.owner("GET", `/api/marketplace/company-box/approvals/${pending.approvalId}`);
    expect(detail.json()).toMatchObject({
      approval: { channel: { channelId: channel.id, digest: pending.digest, postStatus: "held" } },
      payloadView: { text: "Needs approval", digest: pending.digest, matchesHeldDigest: true },
    });
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${pending.approvalId}/approve`, {});
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ ok: true, approval: { state: "succeeded" }, channel: { receipt: { status: "sent", authority: `approval:${pending.approvalId}` } } });
    expect(f.telegram.sends).toHaveLength(1);
    const twice = await f.owner("POST", `/api/marketplace/company-box/approvals/${pending.approvalId}/approve`, {});
    expect(twice.statusCode).toBe(409);
    expect(f.telegram.sends).toHaveLength(1);

    // The agent's retry with the same key posts nothing new: it gets the approved post's receipt.
    const retry = await f.post(channel.id, text("Needs approval"), "agent-hold-0001");
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ replayed: true, receipt: { status: "sent", digest: pending.digest } });
    expect(f.telegram.sends).toHaveLength(1);

    // A changed text needs a new approval.
    const changed = await f.post(channel.id, text("Needs approval!"), "agent-hold-0002");
    expect(changed.statusCode).toBe(202);
    expect(changed.json().approvalId).not.toBe(pending.approvalId);
    expect(changed.json().digest).not.toBe(pending.digest);
  });

  it("skips a denied post and never sends it", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, text("Deny me"), "agent-deny-0001");
    const denied = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/deny`, {});
    expect(denied.statusCode).toBe(200);
    const retry = await f.post(channel.id, text("Deny me"), "agent-deny-0001");
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: "channel_post_skipped", receipt: { status: "skipped" } });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("ends an owner-approved held post as skipped when the ceiling refuses it (review M1); the agent must ask again", async () => {
    const f = await setup();
    const channel = await f.createChannel({
      slug: "community",
      policy: { standingGrants: "allowed", caps: { perDay: 1, minIntervalSeconds: 0, onePerPhase: true } },
    });
    f.consentFor("agent-1", channel);
    await f.owner("POST", `/api/marketplace/channels/${channel.id}/test`, {}, { "idempotency-key": "owner-test-0001" });
    expect(f.telegram.sends).toHaveLength(1);
    const held = await f.post(channel.id, text("Second today"), "agent-full-0001");
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ ok: false, approval: { state: "failed", error: "channel_cap_per_day" }, channel: { error: "channel_cap_per_day" } });
    expect(f.store.channels.getPost(TENANT, held.headers["tealbrick-post-id"] as string)).toMatchObject({ status: "skipped", reason: "channel_cap_per_day" });
    expect(f.store.channels.getReceiptByPost(TENANT, held.headers["tealbrick-post-id"] as string)).toMatchObject({ status: "skipped" });
    // Days later the same key does not send the old approval: the post ended.
    f.advance(3 * 86_400_000);
    const retry = await f.post(channel.id, text("Second today"), "agent-full-0001");
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: "channel_post_skipped" });
    const again = await f.post(channel.id, text("Second today"), "agent-full-0002");
    expect(again.statusCode).toBe(202);
    expect(again.json().approvalId).not.toBe(held.json().approvalId);
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("ends holds and suspends grants when the owner moves the channel to another destination (review L6)", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const grant = await f.proposeAndApprove(channel.id);
    const heldChannel = await f.createChannel({ slug: "held-only", externalId: "-1005678" });
    f.consentFor("agent-1", heldChannel);
    const held = await f.post(heldChannel.id, text("Bound to the destination"), "agent-dest-0001");
    expect(held.statusCode).toBe(202);
    await f.owner("GET", "/api/marketplace/channels/discover?provider=telegram");
    const moved = await f.owner("PATCH", `/api/marketplace/channels/${heldChannel.id}`, { destination: { externalId: "-1001234" } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(f.store.channels.getPost(TENANT, held.headers["tealbrick-post-id"] as string)).toMatchObject({ status: "skipped", reason: "destination_changed" });
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)!.state).toBe("denied");
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(approved.statusCode).toBe(409);
    const movedGrantChannel = await f.owner("PATCH", `/api/marketplace/channels/${channel.id}`, { destination: { externalId: "-1005678" } });
    expect(movedGrantChannel.json().suspendedGrants.map((entry: { id: string }) => entry.id)).toEqual([grant.id]);
    expect(f.store.channels.getStandingGrant(TENANT, grant.id)).toMatchObject({ status: "suspended", decidedReason: "destination_changed" });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("refuses an approved post whose digest no longer matches the current destination at send time (8b(i))", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, text("Bound to the destination"), "agent-dest-0002");
    // A change that bypasses the route (e.g. a restored row): only the send-time recompute catches it.
    f.store.channels.updateChannel(TENANT, channel.id, { destination: { type: "channel", externalId: "-1005678", title: "other" } });
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ approval: { state: "failed", error: "channel_digest_mismatch" }, channel: { error: "channel_digest_mismatch" } });
    expect(f.store.channels.getPost(TENANT, held.headers["tealbrick-post-id"] as string)).toMatchObject({ status: "skipped", reason: "channel_digest_mismatch" });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("refuses a post whose attachment bytes changed on disk after approval (8b(i))", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const uploaded = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/channels/attachments?name=flyer.png",
      headers: { authorization: `Bearer ${GRANT_A}`, "idempotency-key": "upload-key-0001", "content-type": "image/png" },
      payload: PNG,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const held = await f.post(channel.id, { text: "With flyer", attachments: [{ attachmentId: uploaded.json().attachmentId, kind: "image" }] }, "agent-file-0001");
    expect(held.statusCode).toBe(202);
    expect(held.json().payloadView.files).toEqual([{ name: "flyer.png", sha256: uploaded.json().sha256, contentType: "image/png" }]);
    const dir = path.join(f.root, "channels", "attachments");
    await writeFile(path.join(dir, uploaded.json().sha256), "tampered");
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ channel: { error: "channel_file_digest_mismatch" } });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("refuses another agent's attachment instead of dropping it (8b(i))", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    f.consentFor("agent-2", channel);
    const uploaded = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/channels/attachments?name=flyer.png",
      headers: { authorization: `Bearer ${GRANT_B}`, "idempotency-key": "upload-key-0002", "content-type": "image/png" },
      payload: Buffer.concat([PNG, Buffer.from("agent-2")]),
    });
    expect(uploaded.statusCode).toBe(201);
    const foreign = await f.post(channel.id, { text: "Steal", attachments: [{ attachmentId: uploaded.json().attachmentId, kind: "image" }] }, key());
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: "channel_attachment_not_found" });
  });
});

describe("channels: standing grants (§10 items 4 and 7)", () => {
  it("refuses a wider proposal, lets the owner narrow and approve, and refuses an agent widening", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const expires = new Date(f.now + 30 * 86_400_000).toISOString();
    const base = { purpose: "weekly meetup posts", scope: { files: false, immediate: true, scheduled: true }, expires };
    const wide = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/grants`, {
      key: key("grant"),
      payload: { ...base, caps: { perDay: 10, minIntervalSeconds: 0, onePerPhase: true } },
    });
    expect(wide.statusCode).toBe(422);
    expect(wide.json()).toMatchObject({ error: "grant_exceeds_ceiling", fields: ["caps.perDay"] });
    const tooLong = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/grants`, {
      key: key("grant"),
      payload: { ...base, caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, expires: new Date(f.now + 91 * 86_400_000).toISOString() },
    });
    expect(tooLong.json()).toMatchObject({ error: "grant_exceeds_ceiling", fields: ["expires"] });
    const proposed = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/grants`, {
      key: "grant-key-propose-1",
      payload: { ...base, caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
    });
    expect(proposed.statusCode).toBe(201);
    const grant = proposed.json().grant;
    expect(grant).toMatchObject({ status: "proposed", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    // A proposal never authorises anything.
    expect((await f.post(channel.id, text(), key())).statusCode).toBe(202);
    const finalWide = await f.owner("POST", `/api/marketplace/channels/grants/${grant.id}/approve`, {
      final: { caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, scope: { files: {}, immediate: true, scheduled: true }, expires },
    });
    expect(finalWide.statusCode).toBe(422);
    expect(finalWide.json()).toMatchObject({ error: "grant_widening_refused" });
    const narrowed = await f.owner("POST", `/api/marketplace/channels/grants/${grant.id}/approve`, {
      final: { caps: { perDay: 3, minIntervalSeconds: 0, onePerPhase: true }, scope: { files: false, phases: ["announce"], immediate: true, scheduled: false }, expires },
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().grant).toMatchObject({ status: "active", approvalSource: "marketplace-ui", caps: { perDay: 3 } });
    expect(narrowed.json().grant.digest).not.toBe(grant.digest);
    const widen = await f.agent("POST", `/api/marketplace/v1/agent/channels/grants/${grant.id}/narrow`, {
      key: key("narrow"),
      payload: { caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, scope: { files: false, phases: ["announce"], immediate: true, scheduled: false }, expires },
    });
    expect(widen.statusCode).toBe(422);
    expect(widen.json()).toMatchObject({ error: "grant_widening_refused", fields: ["caps.perDay"] });
    const narrower = await f.agent("POST", `/api/marketplace/v1/agent/channels/grants/${grant.id}/narrow`, {
      key: key("narrow"),
      payload: { caps: { perDay: 2, minIntervalSeconds: 0, onePerPhase: true }, scope: { files: false, phases: ["announce"], immediate: true, scheduled: false }, expires },
    });
    expect(narrower.json().grant).toMatchObject({ status: "active", caps: { perDay: 2 } });
    // Only an announce is covered; anything else waits for the owner.
    expect((await f.post(channel.id, { text: "Announce", campaign: { ref: "https://lu.ma/x", phase: "announce" } }, key())).statusCode).toBe(200);
    expect((await f.post(channel.id, { text: "Recap", campaign: { ref: "https://lu.ma/x", phase: "recap" } }, key())).statusCode).toBe(202);
    // Cross-agent: another agent cannot narrow or withdraw this grant.
    const crossed = await f.agent("POST", `/api/marketplace/v1/agent/channels/grants/${grant.id}/withdraw`, { token: GRANT_B });
    expect(crossed.statusCode).toBe(404);
  });

  it("refuses proposals on a channel without standing grants", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community", policy: { standingGrants: "disabled" } });
    f.consentFor("agent-1", channel);
    const refused = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/grants`, {
      key: key("grant"),
      payload: { purpose: "p", caps: { perDay: 1, minIntervalSeconds: 600, onePerPhase: true }, scope: { files: false, immediate: true, scheduled: false }, expires: new Date(f.now + 86_400_000).toISOString() },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "standing_grants_disabled" });
  });

  it("suspends the grant when the Portal consent is revoked and refuses the next post", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    const consent = f.consentFor("agent-1", channel);
    const grant = await f.proposeAndApprove(channel.id);
    expect((await f.post(channel.id, text("Before"), key())).statusCode).toBe(200);
    const revoked = await f.app.inject({
      method: "POST",
      url: `/api/marketplace/agent/grants/${consent.id}/revoke`,
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    expect(f.store.channels.getStandingGrant(TENANT, grant.id)).toMatchObject({ status: "suspended", decidedReason: "consent_inactive" });
    const after = await f.post(channel.id, text("After"), key());
    expect(after.statusCode).toBe(404);
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("suspends grants when the ceiling drops below them or the channel is paused", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const grant = await f.proposeAndApprove(channel.id);
    const lowered = await f.owner("PATCH", `/api/marketplace/channels/${channel.id}`, {
      policy: { standingGrants: "allowed", caps: { perDay: 2, minIntervalSeconds: 0, onePerPhase: true } },
    });
    expect(lowered.statusCode).toBe(200);
    expect(lowered.json().channel.revision).toBe(channel.revision + 1);
    expect(lowered.json().suspendedGrants.map((entry: { id: string }) => entry.id)).toEqual([grant.id]);
    expect((await f.post(channel.id, text(), key())).statusCode).toBe(202);
    const second = await f.proposeAndApprove(channel.id, { caps: { perDay: 2, minIntervalSeconds: 0, onePerPhase: true } });
    const paused = await f.owner("POST", `/api/marketplace/channels/${channel.id}/pause`, {});
    expect(paused.json().suspendedGrants.map((entry: { id: string }) => entry.id)).toEqual([second.id]);
    const blocked = await f.post(channel.id, text("Paused"), key());
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "channel_not_active" });
  });
});

describe("channels: native features and fallbacks (§10 item 6)", () => {
  const uploadVoice = (f: ChannelFixture, token = GRANT_A) =>
    f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/channels/attachments?name=note.ogg",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": key("upload"), "content-type": "audio/ogg" },
      payload: Buffer.from(buildSilenceOpus()),
    });

  it("sends voice natively on Telegram and on Discord (no fallback); the Discord digest covers duration and waveform", async () => {
    const f = await setup();
    const telegram = await f.createChannel({ slug: "tg" });
    const discord = await f.createChannel({ slug: "dc", provider: "discord" });
    f.consentFor("agent-1", telegram);
    f.consentFor("agent-1", discord);
    await f.proposeAndApprove(telegram.id);
    await f.proposeAndApprove(discord.id);
    const voice = (await uploadVoice(f)).json();
    const body = { text: "Voice note", attachments: [{ attachmentId: voice.attachmentId, kind: "voice", transcript: "Hello everyone" }] };
    const tg = await f.post(telegram.id, body, key());
    expect(tg.statusCode, tg.body).toBe(200);
    expect(f.telegram.sends[0]!.message.attachments![0]).toMatchObject({ kind: "voice", contentType: "audio/ogg" });
    expect(tg.json().receipt.fallback).toBeUndefined();
    const dc = await f.post(discord.id, body, key());
    expect(dc.statusCode, dc.body).toBe(200);
    expect(f.discord.sends[0]!.message).toMatchObject({ text: "Voice note" });
    expect(f.discord.sends[0]!.message.attachments![0]).toMatchObject({ kind: "voice", contentType: "audio/ogg", transcript: "Hello everyone" });
    expect(dc.json().receipt.fallback).toBeUndefined();
  });

  it("refuses a Discord voice note that is not a usable Ogg/Opus file, before any digest", async () => {
    const f = await setup();
    const discord = await f.createChannel({ slug: "dc", provider: "discord" });
    f.consentFor("agent-1", discord);
    const bad = (
      await f.app.inject({
        method: "POST",
        url: "/api/marketplace/v1/agent/channels/attachments?name=bad.ogg",
        headers: { authorization: `Bearer ${GRANT_A}`, "idempotency-key": key("upload"), "content-type": "audio/ogg" },
        payload: Buffer.from("OggS voice bytes"),
      })
    ).json();
    const refused = await f.post(discord.id, { text: "x", attachments: [{ attachmentId: bad.attachmentId, kind: "voice" }] }, key());
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "channel_voice_invalid" });
    expect(f.discord.sends).toHaveLength(0);
  });

  it("applies the fallback before the content rules: a forbidden term only in the transcript is refused (8b(iii))", async () => {
    const f = await setup();
    const discord = await f.createChannel({ slug: "dc", provider: "discord" });
    const telegram = await f.createChannel({ slug: "tg" });
    f.consentFor("agent-1", discord);
    f.consentFor("agent-1", telegram);
    const voice = (await uploadVoice(f)).json();
    for (const channel of [discord, telegram]) {
      const refused = await f.post(channel.id, { text: "Clean text", attachments: [{ attachmentId: voice.attachmentId, kind: "voice", transcript: "a forbidden-term here" }] }, key());
      expect(refused.statusCode, channel.slug).toBe(422);
      expect(refused.json()).toMatchObject({ error: "channel_content_denied" });
    }
    // The held view (and digest) shows exactly what Discord gets: the native voice message with its duration and
    // waveform, and the transcript that goes in the second message.
    const held = await f.post(discord.id, { text: "Clean text", attachments: [{ attachmentId: voice.attachmentId, kind: "voice", transcript: "all good" }] }, key());
    expect(held.statusCode).toBe(202);
    const canonical = JSON.parse(held.json().payloadView.canonical);
    expect(canonical).toMatchObject({ text: "Clean text", attachments: [{ kind: "voice", transcript: "all good", voiceMessage: { flags: 8192 } }] });
    expect(canonical.attachments[0].voiceMessage.durationSecs).toBeCloseTo(1.01, 2);
    expect(Buffer.from(canonical.attachments[0].voiceMessage.waveform, "base64").length).toBeLessThanOrEqual(256);
    expect(f.discord.sends).toHaveLength(0);
  });

  it("refuses an undeclared kind with channel_capability_unavailable", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "tg" });
    f.consentFor("agent-1", channel);
    const voice = (await uploadVoice(f)).json();
    const refused = await f.post(channel.id, { text: "Poll", attachments: [{ attachmentId: voice.attachmentId, kind: "poll" }] }, key());
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "channel_capability_unavailable" });
  });
});

describe("channels: uncertain delivery and owner resolve", () => {
  it("counts an uncertain post, blocks a retry of the same key, and resolves to sent", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    f.telegram.reply({ status: "uncertain", resultIds: [], resultUrls: [], errorCode: "provider_timeout", detail: "timed out" });
    const first = await f.post(channel.id, text(), "agent-unc-0001");
    expect(first.statusCode).toBe(502);
    expect(first.json()).toMatchObject({ error: "channel_send_uncertain", receipt: { status: "uncertain" } });
    expect(f.store.channels.countCountedPosts(TENANT, channel.id, new Date(0))).toBe(1);
    const retry = await f.post(channel.id, text(), "agent-unc-0001");
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: "channel_post_uncertain" });
    expect(f.telegram.sends).toHaveLength(1);
    const postId = first.json().receipt.postId;
    const resolved = await f.owner("POST", `/api/marketplace/channels/posts/${postId}/resolve`, { status: "sent" });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ post: { status: "sent" }, receipt: { status: "sent" } });
    const replay = await f.post(channel.id, text(), "agent-unc-0001");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, receipt: { status: "sent" } });
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("does not count a failed post", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    f.telegram.reply({ status: "failed", resultIds: [], resultUrls: [], errorCode: "provider_rejected", detail: "chat not found" });
    const failed = await f.post(channel.id, text(), key());
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: "channel_send_failed", receipt: { status: "failed" } });
    expect(f.store.channels.countCountedPosts(TENANT, channel.id, new Date(0))).toBe(0);
  });
});

describe("channels: owner routes", () => {
  it("shows provider readiness and connections without the tokens; a test send returns an owner-test receipt", async () => {
    const f = await setup();
    const browse = await f.owner("GET", "/api/marketplace/channels");
    expect(browse.statusCode).toBe(200);
    expect(browse.json()).toMatchObject({
      readiness: { telegram: "available", discord: "available" },
      connections: { telegram: { state: "connected", botUsername: "telegram_test_bot", credentialRef: "provider-env:MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN" } },
    });
    const channel = await f.createChannel({ slug: "community" });
    const test = await f.owner("POST", `/api/marketplace/channels/${channel.id}/test`, {}, { "idempotency-key": "owner-test-0002" });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json()).toMatchObject({ receipt: { status: "sent", authority: "owner-test" } });
    const replay = await f.owner("POST", `/api/marketplace/channels/${channel.id}/test`, {}, { "idempotency-key": "owner-test-0002" });
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(f.telegram.sends).toHaveLength(1);
    const readiness = await f.app.inject({ method: "GET", url: "/api/portal/readiness", headers: { "x-tealbrick-instance-proof": PROOF } });
    expect(readiness.json()).toMatchObject({ channels: { providers: { telegram: "available", discord: "available" } } });
    for (const body of [browse.body, test.body, readiness.body]) {
      expect(body).not.toContain(TELEGRAM_TOKEN);
      expect(body).not.toContain(DISCORD_TOKEN);
    }
  });

  it("reports a missing or invalid credential, and creates channels only from discovered destinations", async () => {
    const f = await setup({ environment: { MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: "111:wrong-token-value", MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: undefined } });
    const browse = await f.owner("GET", "/api/marketplace/channels");
    expect(browse.json().readiness).toEqual({ telegram: "credential_invalid", discord: "credential_missing" });
    expect(browse.body).not.toContain("wrong-token-value");
    const g = await setup();
    const typed = await g.owner(
      "POST",
      "/api/marketplace/channels",
      { provider: "telegram", slug: "typed", label: "Typed", destination: { externalId: "-100999" } },
      { "idempotency-key": "owner-create-typed" },
    );
    expect(typed.statusCode).toBe(409);
    expect(typed.json()).toMatchObject({ error: "channel_destination_not_discovered" });
  });

  it("closes the owner routes to anonymous callers and to the service bearer", async () => {
    const { MarketplaceOperatorSessionManager } = await import("./operator-auth.js");
    const f = await setup({
      options: {
        allowUnauthenticatedOperator: false,
        operatorSessionManager: new MarketplaceOperatorSessionManager({ accessToken: "marketplace-operator-token-1234", operatorId: "operator-1", organizationId: TENANT }),
      },
    });
    const anonymous = await f.app.inject({ method: "GET", url: "/api/marketplace/channels" });
    expect(anonymous.statusCode).toBe(401);
    const service = await f.app.inject({ method: "GET", url: "/api/marketplace/channels", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(service.statusCode).toBe(403);
    const agent = await f.app.inject({ method: "GET", url: "/api/marketplace/channels", headers: { authorization: `Bearer ${GRANT_ALL}` } });
    expect(agent.statusCode).toBe(403);
    expect(agent.json()).toEqual({ error: "operation_owner_only" });
  });
});

describe("channels: hygiene (§10 item 8, review condition 8b(ii))", () => {
  it("never writes or answers a bot token, even when the provider echoes it", async () => {
    const lines: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      const f = await setup();
      const bodies: string[] = [];
      const channel = await f.createChannel({ slug: "community" });
      const discord = await f.createChannel({ slug: "dc", provider: "discord" });
      f.consentFor("agent-1", channel);
      f.consentFor("agent-1", discord);
      await f.proposeAndApprove(channel.id);
      await f.proposeAndApprove(discord.id);
      f.telegram.reply(
        { status: "failed", resultIds: [], resultUrls: [], errorCode: "provider_rejected", detail: `bad request for bot${TELEGRAM_TOKEN}` },
        { status: "uncertain", resultIds: [`id-${TELEGRAM_TOKEN}`], resultUrls: [`https://api.telegram.org/bot${TELEGRAM_TOKEN}/x`], detail: TELEGRAM_TOKEN },
      );
      f.discord.reply({ status: "failed", resultIds: [], resultUrls: [], detail: `Bot ${DISCORD_TOKEN}` });
      bodies.push((await f.post(channel.id, text(`echo ${TELEGRAM_TOKEN.slice(0, 5)}`), key())).body);
      bodies.push((await f.post(channel.id, text("second"), key())).body);
      bodies.push((await f.post(discord.id, text("third"), key())).body);
      bodies.push((await f.post(channel.id, text("fourth"), key())).body);
      bodies.push((await f.owner("GET", "/api/marketplace/channels")).body);
      bodies.push((await f.owner("GET", "/api/marketplace/channels/receipts/export")).body);
      bodies.push((await f.agent("GET", "/api/marketplace/v1/agent/channels/receipts")).body);
      bodies.push((await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/settings", headers: { authorization: `Bearer ${PROOF}` } })).body);
      for (const body of bodies) {
        expect(body).not.toContain(TELEGRAM_TOKEN);
        expect(body).not.toContain(DISCORD_TOKEN);
      }
      const receipts = f.store.channels.listReceipts(TENANT, { limit: 100 });
      expect(receipts.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(receipts)).not.toContain(TELEGRAM_TOKEN);
      expect(JSON.stringify(f.store.channels.listPosts(TENANT, { limit: 100 }))).not.toContain(TELEGRAM_TOKEN);
      // Every byte of the database and the data directory.
      await f.app.close();
      const files: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else files.push(full);
        }
      };
      await walk(f.root);
      for (const file of files) {
        const bytes = (await readFile(file)).toString("latin1");
        expect(bytes.includes(TELEGRAM_TOKEN), file).toBe(false);
        expect(bytes.includes(DISCORD_TOKEN), file).toBe(false);
      }
    } finally {
      Object.assign(console, original);
    }
    expect(lines.join("\n")).not.toContain(TELEGRAM_TOKEN);
    expect(lines.join("\n")).not.toContain(DISCORD_TOKEN);
  });
});

describe("channels: confirmed event (live check at send time)", () => {
  it("sends only when the campaign listing is on a listing host and answers 2xx now", async () => {
    let listing = 404;
    const checked: string[] = [];
    const f = await setup({
      options: {
        channelEventFetch: (async (url: string | URL | Request) => {
          checked.push(String(url));
          return new Response("", { status: listing });
        }) as typeof fetch,
      },
    });
    const channel = await f.createChannel({
      slug: "events",
      policy: {
        standingGrants: "allowed",
        caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true },
        content: { requireConfirmedEvent: true, listingHosts: ["lu.ma"] },
      },
    });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    const offHost = await f.post(channel.id, { text: "Event", campaign: { ref: "https://evil.example/e", phase: "announce" } }, key());
    expect(offHost.statusCode).toBe(422);
    expect(offHost.json()).toMatchObject({ error: "channel_event_unconfirmed" });
    expect(checked).toEqual([]);
    const gone = await f.post(channel.id, { text: "Event", campaign: { ref: "https://lu.ma/meetup", phase: "announce" } }, key());
    expect(gone.statusCode).toBe(422);
    expect(gone.json()).toMatchObject({ error: "channel_event_unconfirmed" });
    expect(checked).toEqual(["https://lu.ma/meetup"]);
    listing = 200;
    const live = await f.post(channel.id, { text: "Event", campaign: { ref: "https://lu.ma/meetup", phase: "announce" } }, key());
    expect(live.statusCode, live.body).toBe(200);
    expect(f.telegram.sends).toHaveLength(1);
  });
});

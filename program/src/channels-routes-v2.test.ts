import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { DISCORD_TOKEN, GRANT_B, TELEGRAM_TOKEN, TENANT, channelFixture, fakeProvider, type ChannelFixture } from "./channels/app-fixture.js";
import { encodeTeamsCredential } from "./channels/providers/teams.js";
import type { ChannelProviderId } from "./channels/providers/types.js";

// Channels P2 routes v2: reactions, edits, deletes, direct messages to named people, polls, markup and named mentions,
// all through the one outward path (executeConsentedCall → authority → caps → idempotency → receipt → audit).

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SLACK_TOKEN = ["xoxb", "5550001112", "2223334445", "SentinelSLACKtokenValue99"].join("-");
const TEAMS = { appId: "11111111-2222-4333-8444-555555555555", appSecret: "TeamsSentinelSecretValue~0123456789", tenantId: "99999999-8888-4777-8666-555555555555" };
const TEAMS_TOKEN = encodeTeamsCredential(TEAMS);
const CAPS = { perDay: 50, minIntervalSeconds: 0, onePerPhase: true };
const POLICY = { standingGrants: "allowed", caps: CAPS, content: { files: { types: ["png"] }, denyPatterns: ["forbidden-term"] } };
const ALL_FLAGS = { reactions: true, edits: true, deletes: true, polls: true, dms: true };

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

let counter = 0;
const key = (prefix = "v2") => `${prefix}-key-${String(++counter).padStart(6, "0")}`;

async function setup() {
  const fakes = {
    telegram: fakeProvider("telegram", TELEGRAM_TOKEN),
    discord: fakeProvider("discord", DISCORD_TOKEN),
    slack: fakeProvider("slack", SLACK_TOKEN),
    teams: fakeProvider("teams", TEAMS_TOKEN),
  };
  const f = await channelFixture({
    ownerPin: true,
    environment: {
      MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN: SLACK_TOKEN,
      MARKETPLACE_CHANNELS_TEAMS_APP_ID: TEAMS.appId,
      MARKETPLACE_CHANNELS_TEAMS_APP_SECRET: TEAMS.appSecret,
      MARKETPLACE_CHANNELS_TEAMS_TENANT_ID: TEAMS.tenantId,
    },
    options: { channelProviders: { telegram: fakes.telegram.provider, discord: fakes.discord.provider, slack: fakes.slack.provider, teams: fakes.teams.provider } },
  });
  fixtures.push(f);
  const channelFor = async (provider: ChannelProviderId, slug: string, externalId?: string) => {
    const channel = await f.createChannel({ provider, slug, policy: POLICY, ...(externalId ? { externalId } : {}) });
    f.consentFor("agent-1", channel);
    return channel;
  };
  const grant = (channelId: string, scope: Record<string, unknown> = {}) =>
    f.proposeAndApprove(channelId, { caps: CAPS, scope: { files: false, immediate: true, scheduled: true, ...scope } });
  const react = (channelId: string, messageId: string, body: Record<string, unknown>, k = key("react")) =>
    f.agent("POST", `/api/marketplace/v1/agent/channels/${channelId}/messages/${encodeURIComponent(messageId)}/reactions`, { payload: body, key: k });
  const edit = (channelId: string, messageId: string, text: string, k = key("edit")) =>
    f.agent("PATCH", `/api/marketplace/v1/agent/channels/${channelId}/messages/${encodeURIComponent(messageId)}`, { payload: { text }, key: k });
  const remove = (channelId: string, messageId: string, k = key("delete")) =>
    f.agent("DELETE", `/api/marketplace/v1/agent/channels/${channelId}/messages/${encodeURIComponent(messageId)}`, { key: k });
  const find = (channelId: string, query: Record<string, string>, k = key("find")) =>
    f.agent("POST", `/api/marketplace/v1/agent/channels/${channelId}/people/find`, { payload: query, key: k });
  const dm = (channelId: string, personRef: string, text: string, k = key("dm")) =>
    f.agent("POST", `/api/marketplace/v1/agent/channels/${channelId}/people/${personRef}/messages`, { payload: { text }, key: k });
  const approve = (approvalId: string) => f.owner("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, {});
  const setPolicy = (connectionId: string, policy: Record<string, unknown>) => f.ownerWrite("PUT", `/api/marketplace/channels/connections/${connectionId}/people-policy`, policy);
  /** A message Marketplace posts to the channel under a grant: returns its provider message id. */
  const posted = async (channelId: string, text = "Meetup on Friday") => {
    const sent = await f.post(channelId, { text }, key("post"));
    expect(sent.statusCode, sent.body).toBe(200);
    return (sent.json().receipt.resultIds as string[])[0]!;
  };
  return { f, fakes, channelFor, grant, react, edit, remove, find, dm, approve, setPolicy, posted };
}

const auditOf = (f: ChannelFixture) =>
  (f.store.listAudit({ workspaceSlug: TENANT, limit: 1000 }) as Array<{ event_type: string; metadata: string }>).map((row) => ({
    eventType: row.event_type,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  }));

describe("routes v2: reactions, edits and deletes (R1, R3)", () => {
  it("runs each operation on Slack, Discord, Telegram and Teams under the matching grant flag, with receipt and audit", async () => {
    const t = await setup();
    for (const provider of ["slack", "discord", "telegram", "teams"] as const) {
      const channel = await t.channelFor(provider, `${provider}-ops`);
      await t.grant(channel.id, { reactions: true, edits: true, deletes: true });
      const messageId = await t.posted(channel.id);
      const fake = t.fakes[provider];
      if (provider === "teams") {
        // Teams bots cannot add reactions: undeclared, refused before anything is held or sent.
        const refused = await t.react(channel.id, messageId, { emoji: "like" });
        expect(refused.statusCode, refused.body).toBe(422);
        expect(refused.json()).toMatchObject({ error: "channel_capability_unavailable" });
      } else {
        const reacted = await t.react(channel.id, messageId, { emoji: provider === "telegram" ? "👍" : "tada" });
        expect(reacted.statusCode, reacted.body).toBe(200);
        expect(reacted.json().receipt).toMatchObject({ status: "sent", authority: expect.stringMatching(/^grant:/u), resultIds: [] });
        const unreact = await t.react(channel.id, messageId, { emoji: provider === "telegram" ? "👍" : "tada", remove: true });
        expect(unreact.statusCode, unreact.body).toBe(200);
      }
      const edited = await t.edit(channel.id, messageId, "Meetup on Saturday");
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().receipt).toMatchObject({ status: "sent", resultIds: [messageId] });
      const deleted = await t.remove(channel.id, messageId);
      expect(deleted.statusCode, deleted.body).toBe(200);
      // A deleted message cannot be changed again.
      const again = await t.edit(channel.id, messageId, "too late");
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: "channel_message_removed" });
      const kinds = fake.actions.map((action) => action.kind);
      expect(kinds).toEqual(provider === "teams" ? ["edit", "remove"] : ["react", "react", "edit", "remove"]);
      for (const action of fake.actions) {
        if ("messageId" in action) expect(action.messageId).toBe(messageId);
      }
    }
    const events = auditOf(t.f).filter((event) => event.eventType === "marketplace.channels.post.sent");
    expect(events.map((event) => event.metadata.op)).toEqual(expect.arrayContaining(["post", "react", "edit", "delete"]));
    // Audit has the digest and target id only, never the text.
    expect(JSON.stringify(events)).not.toContain("Meetup on Saturday");
  });

  it("replays the same key without a second provider call and refuses the same key with another body", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "replay");
    await t.grant(channel.id, { reactions: true });
    const messageId = await t.posted(channel.id);
    const first = await t.react(channel.id, messageId, { emoji: "tada" }, "react-replay-0001");
    const second = await t.react(channel.id, messageId, { emoji: "tada" }, "react-replay-0001");
    expect(second.json()).toMatchObject({ replayed: true, receipt: { postId: first.json().receipt.postId } });
    expect(t.fakes.slack.actions).toHaveLength(1);
    const conflict = await t.react(channel.id, messageId, { emoji: "eyes" }, "react-replay-0001");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "channel_idempotency_conflict" });
    // A refused call stores nothing that blocks a corrected retry with the same key.
    const refusedFirst = await t.f.post(channel.id, { text: "hi", markup: "html" }, "post-corrected-0001");
    expect(refusedFirst.json()).toMatchObject({ error: "channel_capability_unavailable" });
    const corrected = await t.f.post(channel.id, { text: "hi" }, "post-corrected-0001");
    expect(corrected.statusCode, corrected.body).toBe(200);
    // The internal key is per operation: the same agent key on a post is its own row.
    const plain = await t.f.post(channel.id, { text: "Separate post" }, "react-replay-0001");
    expect(plain.statusCode, plain.body).toBe(200);
  });

  it("refuses message ids that Marketplace did not post to THAT channel, before any hold or provider call (R3)", async () => {
    const t = await setup();
    const a = await t.channelFor("slack", "slack-a", "C0ANNOUNCE");
    const b = await t.channelFor("slack", "slack-b", "C0SECOND0");
    await t.grant(a.id, ALL_FLAGS);
    await t.grant(b.id, ALL_FLAGS);
    const inB = await t.posted(b.id);
    for (const [label, call] of [
      ["unknown id", () => t.edit(a.id, "1800000000.999999", "x")],
      ["posted to another channel", () => t.edit(a.id, inB, "x")],
      ["delete of another channel's message", () => t.remove(a.id, inB)],
      ["reaction on someone else's message", () => t.react(a.id, "1700000000.000001", { emoji: "tada" })],
    ] as const) {
      const response = await call();
      expect(response.statusCode, label).toBe(404);
      expect(response.json(), label).toMatchObject({ error: "channel_message_not_ours" });
    }
    expect(t.fakes.slack.actions).toHaveLength(0);
    expect(t.f.store.channels.listPosts(TENANT, { status: "held", limit: 10 })).toHaveLength(0);
    // Another agent on the same channel cannot change this agent's message (the agent's own message only).
    const inA = await t.posted(a.id);
    t.f.consentFor("agent-2", a);
    const foreign = await t.f.agent("PATCH", `/api/marketplace/v1/agent/channels/${a.id}/messages/${encodeURIComponent(inA)}`, { token: GRANT_B, key: key("edit"), payload: { text: "hijack" } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: "channel_message_not_ours" });
    // Nor can an agent change the owner's test message.
    const test = await t.f.owner("POST", `/api/marketplace/channels/${a.id}/test`, {}, { "idempotency-key": "owner-test-v2-0001" });
    expect((await t.remove(a.id, test.json().receipt.resultIds[0])).json()).toMatchObject({ error: "channel_message_not_ours" });
    // A purged receipt ends the right to change the message.
    t.f.advance(91 * 86_400_000);
    t.f.store.channels.purgeReceipts(TENANT, new Date(t.f.now - 90 * 86_400_000));
    expect((await t.edit(a.id, inA, "late")).json()).toMatchObject({ error: "channel_message_not_ours" });
  });

  it("binds the target to the channel destination: a new destination makes old ids not ours", async () => {
    const t = await setup();
    const channel = await t.channelFor("telegram", "moves", "-1001234");
    await t.grant(channel.id, ALL_FLAGS);
    const messageId = await t.posted(channel.id);
    await t.f.owner("GET", "/api/marketplace/channels/discover?provider=telegram");
    const moved = await t.f.owner("PATCH", `/api/marketplace/channels/${channel.id}`, { destination: { externalId: "-1005678" } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await t.remove(channel.id, messageId)).json()).toMatchObject({ error: "channel_message_not_ours" });
  });

  it("respects the Telegram 48 hour delete window, at request time and again when an approved delete runs", async () => {
    const t = await setup();
    const channel = await t.channelFor("telegram", "window");
    await t.grant(channel.id, { deletes: true });
    const old = await t.posted(channel.id, "old");
    t.f.advance(48 * 3_600_000);
    const late = await t.remove(channel.id, old);
    expect(late.statusCode).toBe(422);
    expect(late.json()).toMatchObject({ error: "channel_delete_window_passed" });

    // A held delete (no grant on this channel) approved after the window: skipped, never sent.
    const other = await t.channelFor("telegram", "window-held", "-1005678");
    await t.grant(other.id);
    const fresh = await t.posted(other.id, "fresh");
    const held = await t.remove(other.id, fresh);
    expect(held.statusCode, held.body).toBe(202);
    t.f.advance(48 * 3_600_000);
    const approved = await t.approve(held.json().approvalId);
    expect(approved.json()).toMatchObject({ approval: { state: "failed", error: "channel_delete_window_passed" } });
    expect(t.fakes.telegram.actions.filter((action) => action.kind === "remove")).toHaveLength(0);
  });
});

describe("routes v2: action caps (own caps, never the post caps)", () => {
  async function tight(t: Awaited<ReturnType<typeof setup>>, actions: Record<string, number> = {}) {
    // One post per day, ten minutes apart: the post caps are exhausted by the single post.
    const channel = await t.f.createChannel({
      provider: "slack",
      slug: `tight-${++counter}`,
      policy: { ...POLICY, caps: { perDay: 1, minIntervalSeconds: 600, onePerPhase: true, actions } },
    });
    t.f.consentFor("agent-1", channel);
    await t.f.proposeAndApprove(channel.id, { caps: { perDay: 1, minIntervalSeconds: 600, onePerPhase: true }, scope: { files: false, immediate: true, scheduled: false, reactions: true, edits: true, deletes: true } });
    return channel;
  }

  it("deletes a mistaken post immediately under scope.deletes, although the post caps are used up", async () => {
    const t = await setup();
    const channel = await tight(t);
    const messageId = await t.posted(channel.id, "Wrong date!");
    const another = await t.f.post(channel.id, { text: "Second post" }, key());
    expect(another.statusCode).toBe(429);
    const deleted = await t.remove(channel.id, messageId);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().receipt).toMatchObject({ status: "sent", authority: expect.stringMatching(/^grant:/u) });
    // Actions never count as posts: usage today still shows the one post.
    const browse = await t.f.owner("GET", "/api/marketplace/channels");
    expect(browse.json().channels.find((entry: { id: string }) => entry.id === channel.id).usageToday).toBe(1);
  });

  it("spaces edits of the same message (30 s by default) but not edits of different messages", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "edit-gap");
    await t.grant(channel.id, { edits: true });
    const first = await t.posted(channel.id, "one");
    const second = await t.posted(channel.id, "two");
    expect((await t.edit(channel.id, first, "one, fixed")).statusCode).toBe(200);
    const tooSoon = await t.edit(channel.id, first, "one, fixed again");
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json()).toMatchObject({ error: "channel_edit_min_interval", retryAfterSeconds: 30 });
    expect((await t.edit(channel.id, second, "two, fixed")).statusCode).toBe(200);
    t.f.advance(30_000);
    expect((await t.edit(channel.id, first, "one, fixed again")).statusCode).toBe(200);
  });

  it("caps each action kind on its own (reactions, edits, deletes)", async () => {
    const t = await setup();
    const channel = await tight(t, { reactionsPerDay: 2, editsPerDay: 1, deletesPerDay: 1 });
    const a = await t.posted(channel.id, "a");
    expect((await t.react(channel.id, a, { emoji: "tada" })).statusCode).toBe(200);
    expect((await t.react(channel.id, a, { emoji: "eyes" })).statusCode).toBe(200);
    const thirdReaction = await t.react(channel.id, a, { emoji: "rocket" });
    expect(thirdReaction.statusCode).toBe(429);
    expect(thirdReaction.json()).toMatchObject({ error: "channel_cap_reactions_per_day", retryAfterSeconds: expect.any(Number) });
    expect((await t.edit(channel.id, a, "a!")).statusCode).toBe(200);
    t.f.advance(60_000);
    expect((await t.edit(channel.id, a, "a!!")).json()).toMatchObject({ error: "channel_cap_edits_per_day" });
    expect((await t.remove(channel.id, a)).statusCode).toBe(200);
    // Deletes: a channel with room for posts, one delete per day.
    const roomy = await t.f.createChannel({ provider: "slack", slug: "delete-cap", externalId: "C0SECOND0", policy: { ...POLICY, caps: { ...CAPS, actions: { deletesPerDay: 1 } } } });
    t.f.consentFor("agent-1", roomy);
    await t.grant(roomy.id, { deletes: true });
    const x = await t.posted(roomy.id, "x");
    const y = await t.posted(roomy.id, "y");
    expect((await t.remove(roomy.id, x)).statusCode).toBe(200);
    const capped = await t.remove(roomy.id, y);
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: "channel_cap_deletes_per_day" });
    // Posts are not affected by the delete cap.
    expect((await t.f.post(roomy.id, { text: "z" }, key())).statusCode).toBe(200);
    // A grant's own action caps narrow further (deletesPerDay 0 here: no delete under that grant).
    const strict = await t.f.createChannel({ provider: "slack", slug: "delete-grant-cap", externalId: "C0ANNOUNCE", policy: POLICY });
    t.f.consentFor("agent-1", strict);
    await t.f.proposeAndApprove(strict.id, { caps: { ...CAPS, actions: { deletesPerDay: 0 } }, scope: { files: false, immediate: true, scheduled: false, deletes: true } });
    const s1 = await t.posted(strict.id, "s1");
    expect((await t.remove(strict.id, s1)).json()).toMatchObject({ error: "channel_cap_deletes_per_day" });
  });

  it("keeps polls and DMs on the post caps", async () => {
    const t = await setup();
    const channel = await t.f.createChannel({ provider: "telegram", slug: "poll-caps", policy: { ...POLICY, caps: { perDay: 1, minIntervalSeconds: 0, onePerPhase: true } } });
    t.f.consentFor("agent-1", channel);
    await t.f.proposeAndApprove(channel.id, { caps: { perDay: 1, minIntervalSeconds: 0, onePerPhase: true }, scope: { files: false, immediate: true, scheduled: false, polls: true } });
    expect((await t.f.post(channel.id, { text: "", poll: { question: "Day?", options: ["Fri", "Sat"] } }, key())).statusCode).toBe(200);
    expect((await t.f.post(channel.id, { text: "", poll: { question: "Time?", options: ["6", "7"] } }, key())).json()).toMatchObject({ error: "channel_cap_per_day" });
  });
});

describe("routes v2: authority and digests (R1, R2, R4)", () => {
  it("holds each operation without its grant flag; the owner sees the kind, excerpt or emoji and approves exactly once", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "held");
    await t.grant(channel.id); // posts only: no reactions, edits or deletes
    const messageId = await t.posted(channel.id, "The original announcement text");
    const reaction = await t.react(channel.id, messageId, { emoji: "tada" });
    const editing = await t.edit(channel.id, messageId, "The corrected announcement text");
    const deleting = await t.remove(channel.id, messageId);
    for (const held of [reaction, editing, deleting]) {
      expect(held.statusCode, held.body).toBe(202);
      expect(Object.keys(held.json()).sort()).toEqual(["approvalId", "digest", "error", "expiresAt", "payloadView"]);
    }
    expect(t.fakes.slack.actions).toHaveLength(0);
    expect(JSON.parse(reaction.json().payloadView.canonical)).toMatchObject({ op: "react", emoji: "tada", targetMessageId: messageId, text: "" });
    expect(JSON.parse(editing.json().payloadView.canonical)).toMatchObject({ op: "edit", targetMessageId: messageId, text: "The corrected announcement text" });
    expect(JSON.parse(deleting.json().payloadView.canonical)).toMatchObject({ op: "delete", targetMessageId: messageId });

    const queue = await t.f.owner("GET", "/api/marketplace/company-box/approvals?state=pending");
    const byId = new Map((queue.json().approvals as Array<{ id: string; channel: { action: Record<string, unknown> } }>).map((entry) => [entry.id, entry.channel.action]));
    expect(byId.get(reaction.json().approvalId)).toMatchObject({ op: "react", emoji: "tada", remove: false, targetExcerpt: "The original announcement text" });
    expect(byId.get(editing.json().approvalId)).toMatchObject({ op: "edit", targetMessageId: messageId, targetExcerpt: "The original announcement text" });
    expect(byId.get(deleting.json().approvalId)).toMatchObject({ op: "delete", targetExcerpt: "The original announcement text" });
    const approvals = t.f.store.listCompanyBoxApprovals({ workspaceSlug: TENANT, state: "pending", limit: 10 }).map((entry) => entry.actionKey).sort();
    expect(approvals).toEqual(["channel.delete", "channel.edit", "channel.react"]);

    const sent = await t.approve(editing.json().approvalId);
    expect(sent.json()).toMatchObject({ approval: { state: "succeeded" }, channel: { receipt: { status: "sent", authority: `approval:${editing.json().approvalId}` } } });
    expect(await t.approve(editing.json().approvalId)).toMatchObject({ statusCode: 409 });
    expect(t.fakes.slack.actions.filter((action) => action.kind === "edit")).toHaveLength(1);
  });

  it("changes the digest with every field (op, target, emoji, text, person, markup, mentions, poll)", async () => {
    const t = await setup();
    const slack = await t.channelFor("slack", "digests");
    const telegram = await t.channelFor("telegram", "digests-tg");
    const m1 = await (async () => {
      await t.grant(slack.id);
      return t.posted(slack.id, "first");
    })();
    const m2 = await t.posted(slack.id, "second");
    const digests = new Set<string>();
    const add = (response: { statusCode: number; json(): { digest: string } }, label: string) => {
      expect(response.statusCode, label).toBe(202);
      expect(digests.has(response.json().digest), label).toBe(false);
      digests.add(response.json().digest);
    };
    add(await t.react(slack.id, m1, { emoji: "tada" }), "react");
    add(await t.react(slack.id, m1, { emoji: "eyes" }), "emoji");
    add(await t.react(slack.id, m1, { emoji: "tada", remove: true }), "remove");
    add(await t.react(slack.id, m2, { emoji: "tada" }), "target");
    add(await t.edit(slack.id, m1, "edited"), "edit");
    add(await t.edit(slack.id, m1, "edited again"), "text");
    add(await t.remove(slack.id, m1), "delete");
    await t.grant(telegram.id); // no polls flag: a poll holds
    add(await t.f.post(telegram.id, { text: "Vote", poll: { question: "When?", options: ["Mon", "Tue"] } }, key()), "poll");
    add(await t.f.post(telegram.id, { text: "Vote", poll: { question: "When?", options: ["Tue", "Mon"] } }, key()), "poll options");
    add(await t.f.post(telegram.id, { text: "Vote", poll: { question: "When?", options: ["Mon", "Tue"], allowsMultiple: true } }, key()), "poll flags");
    // Markup and mentions are bound too (and refused where undeclared).
    const slackFresh = await t.channelFor("slack", "digests-mentions", "C0SECOND0");
    add(await t.f.post(slackFresh.id, { text: "Hi", mentions: ["U0ALICE"] }, key()), "mentions");
    add(await t.f.post(slackFresh.id, { text: "Hi", mentions: ["U0BOB"] }, key()), "other mention");
    add(await t.f.post(slackFresh.id, { text: "Hi" }, key()), "no mention");
    const telegramFresh = await t.channelFor("telegram", "digests-markup", "-1005678");
    add(await t.f.post(telegramFresh.id, { text: "*Hi*", markup: "markdown-v2" }, key()), "markup");
    add(await t.f.post(telegramFresh.id, { text: "*Hi*" }, key()), "plain");
  });

  it("covers polls and markup with a grant, sends them to the provider, and refuses undeclared or invalid ones", async () => {
    const t = await setup();
    const telegram = await t.channelFor("telegram", "polls");
    await t.grant(telegram.id, { polls: true });
    const poll = await t.f.post(telegram.id, { text: "", poll: { question: "Which day?", options: ["Fri", "Sat"] } }, key());
    expect(poll.statusCode, poll.body).toBe(200);
    expect(t.fakes.telegram.sends.at(-1)!.message).toMatchObject({ poll: { question: "Which day?", options: ["Fri", "Sat"] } });
    const markup = await t.f.post(telegram.id, { text: "*bold*", markup: "markdown-v2" }, key());
    expect(markup.statusCode, markup.body).toBe(200);
    expect(t.fakes.telegram.sends.at(-1)!.message).toMatchObject({ markup: "markdown-v2", text: "*bold*" });
    const refusals: Array<[string, Promise<{ statusCode: number; json(): unknown }>, number, string]> = [
      ["one option", t.f.post(telegram.id, { text: "", poll: { question: "Q?", options: ["only"] } }, key()), 422, "channel_poll_invalid"],
      ["poll with a file", t.f.post(telegram.id, { text: "", poll: { question: "Q?", options: ["a", "b"] }, attachments: [{ attachmentId: "att_x", kind: "image" }] }, key()), 422, "channel_poll_invalid"],
      ["html markup", t.f.post(telegram.id, { text: "<b>x</b>", markup: "html" }, key()), 422, "channel_capability_unavailable"],
      ["telegram mentions", t.f.post(telegram.id, { text: "hi", mentions: ["123"] }, key()), 422, "channel_capability_unavailable"],
      ["denied poll text", t.f.post(telegram.id, { text: "", poll: { question: "forbidden-term?", options: ["a", "b"] } }, key()), 422, "channel_content_denied"],
    ];
    for (const [label, pending, status, error] of refusals) {
      const response = await pending;
      expect(response.statusCode, label).toBe(status);
      expect(response.json(), label).toMatchObject({ error });
    }
    // A scheduled post takes no poll (strict body).
    const scheduled = await t.f.agent("POST", `/api/marketplace/v1/agent/channels/${telegram.id}/scheduled`, {
      key: key(),
      payload: { text: "", sendAt: new Date(t.f.now + 3_600_000).toISOString(), poll: { question: "Q?", options: ["a", "b"] } },
    });
    expect(scheduled.statusCode).toBe(400);
    // Slack named mentions reach the adapter as user ids.
    const slack = await t.channelFor("slack", "mentions");
    await t.grant(slack.id);
    const mentioned = await t.f.post(slack.id, { text: "Thanks <@U0ALICE>", mentions: ["U0ALICE", { userId: "U0BOB" }] }, key());
    expect(mentioned.statusCode, mentioned.body).toBe(200);
    expect(t.fakes.slack.sends.at(-1)!.message.mentions).toEqual([{ userId: "U0ALICE" }, { userId: "U0BOB" }]);
    // Teams needs each mention's name in the text, checked before any hold.
    const teams = await t.channelFor("teams", "teams-mentions");
    const noName = await t.f.post(teams.id, { text: "Hi", mentions: ["11111111-0000-4000-8000-000000000001"] }, key());
    expect(noName.json()).toMatchObject({ error: "channel_mention_invalid" });
  });

  it("proposes and narrows grants with the new flags (true is wider)", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "flags");
    const grant = await t.grant(channel.id, { reactions: true, edits: true });
    const view = (await t.f.agent("GET", "/api/marketplace/v1/agent/channels/grants")).json().grants.find((entry: { id: string }) => entry.id === grant.id);
    expect(view.scope).toMatchObject({ reactions: true, edits: true });
    const terms = { caps: CAPS, scope: { files: false, immediate: true, scheduled: true, reactions: true }, expires: new Date(t.f.now + 10 * 86_400_000).toISOString() };
    const narrowed = await t.f.agent("POST", `/api/marketplace/v1/agent/channels/grants/${grant.id}/narrow`, { key: key(), payload: terms });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const wider = await t.f.agent("POST", `/api/marketplace/v1/agent/channels/grants/${grant.id}/narrow`, { key: key(), payload: { ...terms, scope: { ...terms.scope, deletes: true } } });
    expect(wider.statusCode).toBe(422);
    expect(wider.json()).toMatchObject({ error: "grant_widening_refused", fields: ["scope.deletes"] });
  });
});

describe("routes v2: people policy and direct messages (R5)", () => {
  it("finds nobody under the default policy (none), without asking the platform", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "people-none");
    t.fakes.slack.addPerson("alice@example.com", { userId: "U0ALICE", displayName: "Alice" });
    const refused = await t.find(channel.id, { email: "alice@example.com" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "channel_people_disabled" });
    expect(t.fakes.slack.actions).toHaveLength(0);
    const browse = await t.f.owner("GET", "/api/marketplace/channels");
    expect(browse.json().connections.slack.peoplePolicy).toMatchObject({ mode: "none", people: [], domains: [] });
  });

  it("allowlist: named people and email domains only; the policy is checked again when the message is sent", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "people-allow");
    t.fakes.slack.addPerson("alice@example.com", { userId: "U0ALICE", displayName: "Alice" });
    t.fakes.slack.addPerson("bob@partner.org", { userId: "U0BOB", displayName: "Bob" });
    t.fakes.slack.addPerson("eve@elsewhere.net", { userId: "U0EVE", displayName: "Eve" });
    const invalid = await t.setPolicy(channel.connectionId, { mode: "allowlist", people: ["not an email@"], domains: ["bad domain"] });
    expect(invalid.statusCode).toBe(422);
    const set = await t.setPolicy(channel.connectionId, { mode: "allowlist", people: ["Alice@Example.com"], domains: ["@partner.org"] });
    expect(set.json().policy).toMatchObject({ mode: "allowlist", people: ["alice@example.com"], domains: ["partner.org"] });
    expect((await t.find(channel.id, { email: "alice@example.com" })).statusCode).toBe(200);
    expect((await t.find(channel.id, { email: "bob@partner.org" })).statusCode).toBe(200);
    const eve = await t.find(channel.id, { email: "eve@elsewhere.net" });
    expect(eve.statusCode).toBe(403);
    expect(eve.json()).toMatchObject({ error: "channel_person_not_allowed" });
    expect(t.fakes.slack.actions.filter((action) => action.kind === "findPerson")).toHaveLength(2);
    // Slack: by email only in this release (users:read is not requested).
    expect((await t.find(channel.id, { handle: "alice" })).json()).toMatchObject({ error: "channel_person_query_unsupported" });

    // A held first message is refused at send time once the owner narrows the policy.
    await t.grant(channel.id, { dms: true });
    const alice = (await t.find(channel.id, { email: "alice@example.com" })).json().person.personRef as string;
    const held = await t.dm(channel.id, alice, "Hello Alice");
    expect(held.statusCode, held.body).toBe(202);
    await t.setPolicy(channel.connectionId, { mode: "allowlist", domains: ["partner.org"] });
    const approved = await t.approve(held.json().approvalId);
    expect(approved.json()).toMatchObject({ approval: { state: "failed", error: "channel_person_not_allowed" } });
    expect(t.fakes.slack.sends.filter((send) => send.destination.type === "person")).toHaveLength(0);
    await t.setPolicy(channel.connectionId, { mode: "none" });
    expect((await t.dm(channel.id, alice, "Hello again")).json()).toMatchObject({ error: "channel_people_disabled" });
  });

  it("workspace: the first message always needs the owner's approval (even with scope.dms); later ones use the grant; revoke resets", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "people-workspace");
    t.fakes.slack.addPerson("alice@example.com", { userId: "U0ALICE", displayName: "Alice Example" });
    await t.setPolicy(channel.connectionId, { mode: "workspace" });
    await t.grant(channel.id, { dms: true });
    const found = await t.find(channel.id, { email: "alice@example.com" });
    expect(found.statusCode, found.body).toBe(200);
    // Exactly one person, an opaque reference, the name to confirm: never a list, never the platform id.
    expect(Object.keys(found.json().person).sort()).toEqual(["approved", "displayName", "personRef"]);
    expect(found.json().person).toMatchObject({ displayName: "Alice Example", approved: false, personRef: expect.stringMatching(/^prs_/u) });
    expect(found.body).not.toContain("U0ALICE");
    const ref = found.json().person.personRef as string;

    const first = await t.dm(channel.id, ref, "Hi Alice, welcome to the community");
    expect(first.statusCode, first.body).toBe(202);
    expect(JSON.parse(first.json().payloadView.canonical)).toMatchObject({ op: "dm", personId: "U0ALICE", personName: "Alice Example", destination: "person:U0ALICE" });
    const queue = await t.f.owner("GET", "/api/marketplace/company-box/approvals?state=pending");
    expect(queue.json().approvals[0].channel.action).toMatchObject({ op: "dm", person: { displayName: "Alice Example", approved: false } });
    expect(t.fakes.slack.sends.filter((send) => send.destination.type === "person")).toHaveLength(0);
    const approved = await t.approve(first.json().approvalId);
    expect(approved.json()).toMatchObject({ approval: { state: "succeeded" }, channel: { receipt: { status: "sent" } } });
    const dmSends = () => t.fakes.slack.sends.filter((send) => send.destination.type === "person");
    expect(dmSends()).toHaveLength(1);
    expect(dmSends()[0]!.destination).toMatchObject({ externalId: "dm-U0ALICE", personId: "U0ALICE" });
    expect(t.fakes.slack.actions.filter((action) => action.kind === "openDirect")).toEqual([{ kind: "openDirect", userId: "U0ALICE" }]);

    // Approved now: the next message is covered by the grant's scope.dms.
    const later = await t.dm(channel.id, ref, "Reminder: meetup on Friday");
    expect(later.statusCode, later.body).toBe(200);
    expect(later.json().receipt).toMatchObject({ status: "sent", authority: expect.stringMatching(/^grant:/u) });
    expect(dmSends()).toHaveLength(2);
    expect((await t.find(channel.id, { email: "alice@example.com" })).json().person).toMatchObject({ personRef: ref, approved: true });

    // The owner sees the approved person and revokes: the next message needs approval again.
    const people = await t.f.owner("GET", `/api/marketplace/channels/connections/${channel.connectionId}/people?approved=true`);
    expect(people.json().people).toEqual([expect.objectContaining({ personRef: ref, displayName: "Alice Example", approved: true, lookup: { kind: "email", value: "alice@example.com" } })]);
    const revoked = await t.f.ownerWrite("POST", `/api/marketplace/channels/connections/${channel.connectionId}/people/${ref}/revoke`, {});
    expect(revoked.json().person).toMatchObject({ approved: false, revokedAt: expect.any(String) });
    expect((await t.dm(channel.id, ref, "After revoke")).statusCode).toBe(202);
    const audit = auditOf(t.f);
    expect(audit.map((event) => event.eventType)).toEqual(expect.arrayContaining(["marketplace.channels.person.approved", "marketplace.channels.person.revoked", "marketplace.channels.person.lookup"]));
    // The lookup audit never carries the email.
    expect(JSON.stringify(audit)).not.toContain("alice@example.com");
  });

  it("without scope.dms even an approved person's messages hold; a grant never covers a first contact", async () => {
    const t = await setup();
    const channel = await t.channelFor("discord", "people-discord");
    t.fakes.discord.addPerson("ana", { userId: "4400001", displayName: "Ana" });
    await t.setPolicy(channel.connectionId, { mode: "workspace" });
    await t.grant(channel.id, { reactions: true, polls: true });
    const ref = (await t.find(channel.id, { handle: "@Ana" })).json().person.personRef as string;
    const first = await t.dm(channel.id, ref, "Hi Ana");
    expect(first.statusCode).toBe(202);
    await t.approve(first.json().approvalId);
    expect((await t.dm(channel.id, ref, "Second")).statusCode).toBe(202);
  });

  it("never gives the agent a member list: ambiguity, unknown people and other connections are refusals", async () => {
    const t = await setup();
    const slack = await t.channelFor("slack", "people-list");
    const discord = await t.channelFor("discord", "people-list-dc");
    t.fakes.slack.addPerson("team@example.com", "ambiguous");
    await t.setPolicy(slack.connectionId, { mode: "workspace" });
    await t.setPolicy(discord.connectionId, { mode: "workspace" });
    const ambiguous = await t.find(slack.id, { email: "team@example.com" });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toMatchObject({ error: "channel_person_ambiguous" });
    const unknown = await t.find(slack.id, { email: "nobody@example.com" });
    expect(unknown.statusCode).toBe(404);
    for (const body of [ambiguous.body, unknown.body]) {
      expect(body).not.toMatch(/"people"|"members"|"users"/u);
    }
    // A person found on Slack is unknown on the Discord connection.
    t.fakes.slack.addPerson("alice@example.com", { userId: "U0ALICE", displayName: "Alice" });
    const ref = (await t.find(slack.id, { email: "alice@example.com" })).json().person.personRef as string;
    expect((await t.dm(discord.id, ref, "hi")).json()).toMatchObject({ error: "channel_person_not_found" });
    // Telegram bots cannot start a DM: refused.
    const telegram = await t.channelFor("telegram", "people-tg");
    expect((await t.find(telegram.id, { handle: "someone" })).json()).toMatchObject({ error: "channel_capability_unavailable" });
    // No agent operation lists people; the owner listing is owner-only.
    const agentList = await t.f.agent("GET", `/api/marketplace/channels/connections/${slack.connectionId}/people`);
    expect(agentList.statusCode).toBe(403);
  });

  it("caps finds per agent", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "people-cap");
    await t.setPolicy(channel.connectionId, { mode: "workspace" });
    for (let index = 0; index < 50; index += 1) await t.find(channel.id, { email: `p${index}@example.com` });
    const capped = await t.find(channel.id, { email: "p51@example.com" });
    expect(capped.statusCode).toBe(429);
    expect(capped.json()).toMatchObject({ error: "channel_person_lookup_cap" });
  });
});

describe("routes v2: people are per agent (review of PR #51)", () => {
  it("never lets another agent reuse a person reference or another agent's first-contact approval", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "two-agents");
    t.f.consentFor("agent-2", channel);
    t.fakes.slack.addPerson("alice@example.com", { userId: "U0ALICE", displayName: "Alice" });
    await t.setPolicy(channel.connectionId, { mode: "workspace" });
    await t.grant(channel.id, { dms: true });
    await t.f.proposeAndApprove(channel.id, { caps: CAPS, scope: { files: false, immediate: true, scheduled: true, dms: true } }, GRANT_B);
    // agent-1: find, first DM held, the owner approves, it is sent.
    const ref1 = (await t.find(channel.id, { email: "alice@example.com" })).json().person.personRef as string;
    const held1 = await t.dm(channel.id, ref1, "Hi Alice (agent-1)");
    expect(held1.statusCode).toBe(202);
    await t.approve(held1.json().approvalId);
    expect((await t.dm(channel.id, ref1, "Later (agent-1)")).statusCode).toBe(200);
    // agent-2 (own consent and a grant with dms, never contacted Alice): its own reference, not approved.
    const found2 = await t.f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/people/find`, { token: GRANT_B, key: key("find"), payload: { email: "alice@example.com" } });
    expect(found2.statusCode, found2.body).toBe(200);
    expect(found2.json().person.personRef).not.toBe(ref1);
    expect(found2.json().person.approved).toBe(false);
    // agent-1's reference is unknown to agent-2, exactly like an unknown reference.
    const reused = await t.f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/people/${ref1}/messages`, { token: GRANT_B, key: key("dm"), payload: { text: "reuse" } });
    expect(reused.statusCode).toBe(404);
    expect(reused.json()).toMatchObject({ error: "channel_person_not_found" });
    // agent-2's first DM is held for the owner despite its grant.
    const first2 = await t.f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/people/${found2.json().person.personRef}/messages`, { token: GRANT_B, key: key("dm"), payload: { text: "Hi Alice (agent-2)" } });
    expect(first2.statusCode, first2.body).toBe(202);
    const dmSends = t.fakes.slack.sends.filter((send) => send.destination.type === "person");
    expect(dmSends.map((send) => send.message.text)).toEqual(["Hi Alice (agent-1)", "Later (agent-1)"]);
    // The owner sees one row per agent and revokes agent-1's approval only.
    const people = (await t.f.owner("GET", `/api/marketplace/channels/connections/${channel.connectionId}/people`)).json().people as Array<{ personRef: string; agentId: string; approved: boolean }>;
    expect(people.map((person) => [person.agentId, person.approved]).sort()).toEqual([["agent-1", true], ["agent-2", false]]);
    await t.f.ownerWrite("POST", `/api/marketplace/channels/connections/${channel.connectionId}/people/${ref1}/revoke`, {});
    expect((await t.dm(channel.id, ref1, "After revoke")).statusCode).toBe(202);
  });

  it("matches a Discord allowlist on the immutable user id, never on a display name or nickname", async () => {
    const t = await setup();
    const channel = await t.channelFor("discord", "discord-allow");
    // An impostor set the nickname "ana"; the owner listed the handle "ana".
    t.fakes.discord.addPerson("ana", { userId: "4400666", displayName: "ana" });
    await t.setPolicy(channel.connectionId, { mode: "allowlist", people: ["ana"] });
    const spoofed = await t.find(channel.id, { handle: "ana" });
    expect(spoofed.statusCode).toBe(403);
    expect(spoofed.json()).toMatchObject({ error: "channel_person_not_allowed" });
    t.fakes.discord.addPerson("ana", { userId: "4400001", displayName: "Ana" });
    await t.setPolicy(channel.connectionId, { mode: "allowlist", people: ["4400001"] });
    const real = await t.find(channel.id, { handle: "ana" });
    expect(real.statusCode, real.body).toBe(200);
    await t.grant(channel.id);
    const held = await t.dm(channel.id, real.json().person.personRef, "Hi Ana");
    const queue = await t.f.owner("GET", "/api/marketplace/company-box/approvals?state=pending");
    expect(queue.json().approvals.find((entry: { id: string }) => entry.id === held.json().approvalId).channel.action.person).toMatchObject({ displayName: "Ana", platformUserId: "4400001", lookup: { kind: "handle", value: "ana" } });
  });

  it("changes the people policy and revokes only through the pinned owner's own session", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "strict-owner");
    const plain = await t.f.owner("PUT", `/api/marketplace/channels/connections/${channel.connectionId}/people-policy`, { mode: "workspace" });
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toMatchObject({ error: "owner_session_required" });
    expect((await t.f.owner("GET", `/api/marketplace/channels/connections/${channel.connectionId}/people-policy`)).json().policy.mode).toBe("none");
    expect((await t.setPolicy(channel.connectionId, { mode: "workspace" })).statusCode).toBe(200);
    const revoke = await t.f.owner("POST", `/api/marketplace/channels/connections/${channel.connectionId}/people/prs_00000000-0000-4000-8000-000000000000/revoke`, {});
    expect(revoke.statusCode).toBe(403);
  });

  it("holds the find cap under concurrent finds and purges sent-message rows with their receipts", async () => {
    const t = await setup();
    const channel = await t.channelFor("slack", "cap-race");
    await t.setPolicy(channel.connectionId, { mode: "workspace" });
    const answers = await Promise.all(Array.from({ length: 60 }, (_unused, index) => t.find(channel.id, { email: `p${index}@example.com` })));
    expect(answers.filter((answer) => answer.statusCode === 429)).toHaveLength(10);
    expect(t.fakes.slack.actions.filter((action) => action.kind === "findPerson")).toHaveLength(50);

    await t.grant(channel.id);
    await t.posted(channel.id, "kept for 90 days");
    const count = () => (t.f.store.channels.actions.recentSentMessageIds(TENANT, ["C0ANNOUNCE|"], new Date(0))).size;
    expect(count()).toBe(1);
    t.f.advance(91 * 86_400_000);
    await t.f.runtime.tick(new Date(t.f.now));
    expect(count()).toBe(0);
  });
});

describe("routes v2: exposure and setup (R6, R7)", () => {
  it("shows the wired features to agents where the adapter declares them", async () => {
    const t = await setup();
    const slack = await t.channelFor("slack", "caps-slack");
    const telegram = await t.channelFor("telegram", "caps-tg");
    const list = (await t.f.agent("GET", "/api/marketplace/v1/agent/channels")).json().channels as Array<{ id: string; capabilities: Record<string, unknown> }>;
    expect(list.find((entry) => entry.id === slack.id)!.capabilities).toMatchObject({
      dm: { open: true, maxMembers: 1 },
      mentions: { users: true },
      reactions: { add: true, remove: true, custom: true },
      edit: { own: true },
      delete: { own: true },
      poll: false,
    });
    expect(list.find((entry) => entry.id === telegram.id)!.capabilities).toMatchObject({
      markupOptions: ["markdown-v2"],
      poll: { maxOptions: 12 },
      dm: { open: false },
      delete: { own: true, windowSeconds: 172_800 },
    });
  });

  it("asks Slack for users:read.email, im:write and reactions:write only, with the features (and documents them)", async () => {
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "docs/channels-slack-app-manifest.json"), "utf8")) as { oauth_config: { scopes: { bot: string[] } } };
    expect(manifest.oauth_config.scopes.bot).toEqual(["chat:write", "channels:read", "groups:read", "files:write", "users:read.email", "im:write", "reactions:write"]);
    expect(manifest.oauth_config.scopes.bot).not.toContain("users:read");
    const inbound = JSON.parse(await readFile(path.join(repoRoot, "docs/channels-slack-app-manifest.inbound.json"), "utf8")) as { oauth_config: { scopes: { bot: string[] } } };
    expect(inbound.oauth_config.scopes.bot).toEqual(expect.arrayContaining(["users:read.email", "im:write", "reactions:write"]));
    const contract = await readFile(path.join(repoRoot, "docs/contract.md"), "utf8");
    expect(contract).toContain("marketplace.channel-messages.react");
    expect(contract).toContain("users:read.email");
  });
});

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_WIRED_FEATURES, capabilityForKind, capabilitySupports, wiredCapabilities } from "./capabilities.js";
import { createReplayGuard, scrubSecrets } from "./common.js";
import { createDiscordProvider } from "./discord.js";
import {
  SLACK_DIRECTORY_TTL_MS,
  SLACK_EVENT_DEDUPE_TTL_MS,
  SLACK_MAX_TEXT_CHARS,
  acceptSlackEvent,
  createSlackEventDedupe,
  createSlackProvider,
  escapeSlackText,
  parseSlackEvent,
  renderSlackText,
  slackFailure,
  slackMessageUrl,
  verifySlackSignature,
} from "./slack.js";
import { createTelegramProvider } from "./telegram.js";
import { attachment, createFakeClock, createFakeFetch, jsonResponse, type FakeReply, type RecordedRequest } from "./test-support.js";
import type { ChannelDestination, ChannelProvider } from "./types.js";
import { CHANNEL_PROVIDER_IDS, CHANNEL_TOKEN_ENV, defaultChannelProviders, resolveSlackSigningSecret } from "../runtime.js";

const MiB = 1024 * 1024;

// A fake bot token in the Slack shape, assembled at runtime so secret scanners do not flag the source.
const TOKEN = ["xoxb", "1234567890", "0987654321", "FakeFakeFakeFakeFake1234"].join("-");
const API = "https://slack.com/api";
const UPLOAD = "https://files.slack.com/upload/v1/ABC123";

type Made = { fake: ReturnType<typeof createFakeFetch>; clock: ReturnType<typeof createFakeClock>; provider: Required<ChannelProvider> };

function make(replies: FakeReply[] = [], extra: { timeoutMs?: number } = {}): Made {
  const fake = createFakeFetch(replies);
  const clock = createFakeClock(1_800_000_000_000);
  const provider = createSlackProvider({ fetchImpl: fake.fetchImpl, sleep: clock.sleep, now: clock.now, ...extra }) as Required<ChannelProvider>;
  return { fake, clock, provider };
}

const ok = (body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => jsonResponse(200, { ok: true, ...body }, headers);
const slackError = (error: string) => jsonResponse(200, { ok: false, error });
const posted = (ts = "1800000000.000100") => ok({ channel: "C0123ABC", ts, message: { text: "x" } });

const channel: ChannelDestination = { type: "channel", externalId: "C0123ABC", title: "#general", url: "https://acme.slack.com/archives/C0123ABC" };

function form(request: RecordedRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(request.body as string));
}
function method(request: RecordedRequest): string {
  return request.url.startsWith(`${API}/`) ? request.url.slice(API.length + 1) : request.url;
}
function noToken(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("FakeFakeFake");
}

describe("slack capabilities", () => {
  it("declares only what the adapter does", () => {
    const { provider } = make();
    expect(provider.id).toBe("slack");
    expect(provider.capabilities).toEqual({
      channelCapabilities: 2,
      text: { maxChars: 40_000 },
      markup: "mrkdwn",
      mentions: { users: true, broadcast: "suppressed" },
      dm: { open: true, maxMembers: 1 },
      image: { types: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 50 * MiB, albumMax: 4 },
      file: { types: ["application/pdf", "text/plain", "application/zip", "application/octet-stream"], maxBytes: 50 * MiB },
      audio: { types: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 50 * MiB },
      voice: { fallback: "audio+transcript", types: ["audio/ogg"], maxBytes: 50 * MiB },
      video: { types: ["video/mp4"], maxBytes: 50 * MiB },
      thread: { replies: true, topics: false, forum: false },
      reactions: { add: true, remove: true, custom: true },
      buttons: { url: false, callback: false },
      poll: false,
      edit: { own: true },
      delete: { own: true },
      canvas: false,
      presence: { typing: false, status: false },
      ephemeral: false,
      live: false,
      schedule: { native: true },
      events: { create: false },
      discover: "list",
      inbound: { mode: "webhook", dedupe: true },
      audience: { count: false },
      limits: { perChatPerSecond: 1, retryAfter: "honoured" },
    });
    expect(capabilityForKind(provider.capabilities, "voice")).toBe("fallback");
    for (const feature of ["dm", "thread.replies", "mentions.users", "reactions.add", "reactions.remove", "edit", "delete", "schedule.native", "inbound"]) {
      expect(capabilitySupports(provider.capabilities, feature), feature).toBe(true);
    }
    for (const feature of ["live.join", "canvas", "ephemeral", "poll", "thread.topics"]) {
      expect(capabilitySupports(provider.capabilities, feature), feature).toBe(false);
    }
  });

  it("is registered; each P2 method exists exactly where its feature is declared", () => {
    expect(CHANNEL_PROVIDER_IDS).toContain("slack");
    expect(CHANNEL_TOKEN_ENV.slack).toBe("MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN");
    expect(defaultChannelProviders().slack?.id).toBe("slack");
    const telegram = createTelegramProvider();
    const discord = createDiscordProvider();
    for (const other of [telegram, discord]) {
      expect(typeof other.react).toBe("function");
      expect(typeof other.edit).toBe("function");
      expect(typeof other.remove).toBe("function");
      expect(other.scheduleNative).toBeUndefined();
    }
    // Telegram bots cannot start a conversation with a person; Discord opens a DM by user id.
    expect(telegram.findPerson).toBeUndefined();
    expect(telegram.openDirect).toBeUndefined();
    expect(typeof discord.findPerson).toBe("function");
    expect(typeof discord.openDirect).toBe("function");
  });

  it("reads the signing secret from env first, then the connector secret", () => {
    const reads: string[] = [];
    const readSecretValue = (pluginId: string, name: string) => {
      reads.push(`${pluginId}/${name}`);
      return "stored-secret";
    };
    expect(resolveSlackSigningSecret({ environment: { MARKETPLACE_CHANNELS_SLACK_SIGNING_SECRET: " env-secret " }, readSecretValue })).toBe("env-secret");
    expect(reads).toEqual([]);
    expect(resolveSlackSigningSecret({ environment: {}, readSecretValue })).toBe("stored-secret");
    expect(reads).toEqual(["channels-slack/signingSecret"]);
    expect(resolveSlackSigningSecret({ environment: {}, readSecretValue: () => null })).toBeNull();
  });

  it("scrubs Slack token shapes from any text", () => {
    expect(scrubSecrets(`token ${TOKEN} and xoxp-1-2-abcdefghij and xapp-1-A0-abcdefghij`, [])).toBe("token [redacted] and [redacted] and [redacted]");
  });
});

describe("slack verify (auth.test)", () => {
  it("POSTs form-encoded with a Bearer header and never puts the token in the URL", async () => {
    const { provider, fake } = make([ok({ url: "https://acme.slack.com/", team: "Acme", user: "marketplace", team_id: "T0ACME", user_id: "U0BOT1", bot_id: "B0BOT1" })]);
    await expect(provider.verify(` ${TOKEN} `)).resolves.toEqual({ ok: true, botId: "U0BOT1", botUsername: "marketplace", teamId: "T0ACME" });
    const request = fake.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${API}/auth.test`);
    expect(request.url).not.toContain("xoxb");
    expect(request.headers.authorization === `Bearer ${TOKEN}`).toBe(true);
    expect(request.headers["content-type"]).toBe("application/x-www-form-urlencoded; charset=utf-8");
    expect(request.body).toBe("");
  });

  it("requires the installed team id (team_id) from auth.test", async () => {
    const { provider } = make([
      ok({ url: "https://acme.slack.com/", user: "marketplace", user_id: "U0BOT1" }),
      ok({ url: "https://acme.slack.com/", user: "marketplace", user_id: "U0BOT1", team_id: "acme" }),
    ]);
    await expect(provider.verify(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
    await expect(provider.verify(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
  });

  it("maps every failure without echoing the token", async () => {
    const { provider, fake } = make([
      slackError("invalid_auth"),
      slackError("token_revoked"),
      jsonResponse(503, {}),
      new Error(`connect ECONNREFUSED ${TOKEN}`),
      ok({ user_id: "not-an-id" }),
      jsonResponse(500, { error: TOKEN }),
    ]);
    await expect(provider.verify("")).resolves.toEqual({ ok: false, reason: "credential_missing" });
    await expect(provider.verify(null)).resolves.toEqual({ ok: false, reason: "credential_missing" });
    await expect(provider.verify("xoxp-1234567890-user-token")).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    await expect(provider.verify("xoxb-has space-1234567890")).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    expect(fake.requests).toHaveLength(0);
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await provider.verify(TOKEN));
    expect(results).toEqual([
      { ok: false, reason: "credential_invalid" },
      { ok: false, reason: "credential_invalid" },
      { ok: false, reason: "provider_unavailable" },
      { ok: false, reason: "provider_unavailable" },
      { ok: false, reason: "provider_unavailable" },
      { ok: false, reason: "provider_unavailable" },
    ]);
    noToken(results);
  });
});

describe("slack discover (conversations.list)", () => {
  it("lists member channels (public and private), excludes archived and DMs, follows the cursor", async () => {
    const { provider, fake } = make([
      ok({ url: "https://acme.slack.com/", user_id: "U0BOT1" }),
      ok({
        channels: [
          { id: "C01", name: "general", is_member: true, is_private: false },
          { id: "C02", name: "random", is_member: false },
          { id: "G03", name: "leads", is_member: true, is_private: true },
          { id: "C04", name: "old", is_member: true, is_archived: true },
          { id: "D05", is_im: true, is_member: true },
          { id: "bad id", name: "x", is_member: true },
        ],
        response_metadata: { next_cursor: "dGVhbTpDMDY=" },
      }),
      ok({ channels: [{ id: "C06", name: `evil\u0000‮${"y".repeat(300)}`, is_member: true }], response_metadata: { next_cursor: "" } }),
    ]);
    const result = await provider.discover(TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.destinations.slice(0, 2)).toEqual([
      { type: "channel", externalId: "C01", title: "#general", url: "https://acme.slack.com/archives/C01" },
      { type: "group", externalId: "G03", title: "#leads", url: "https://acme.slack.com/archives/G03" },
    ]);
    const evil = result.destinations[2]!;
    expect(evil.externalId).toBe("C06");
    expect(Array.from(evil.title).length).toBeLessThanOrEqual(128);
    expect(/[\u0000‮]/u.test(evil.title)).toBe(false);
    expect(result.destinations).toHaveLength(3);
    expect(fake.requests.map(method)).toEqual(["auth.test", "conversations.list", "conversations.list"]);
    expect(form(fake.requests[1]!)).toEqual({ types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
    expect(form(fake.requests[2]!)).toMatchObject({ cursor: "dGVhbTpDMDY=" });
  });

  it("caps the result at 1000 destinations and omits links when the team URL is unknown", async () => {
    const page = (start: number) =>
      ok({
        channels: Array.from({ length: 200 }, (_, i) => ({ id: `C${String(start + i).padStart(6, "0")}`, name: `c${start + i}`, is_member: true })),
        response_metadata: { next_cursor: `cursor${start}` },
      });
    const { provider, fake } = make([ok({ url: "http://evil.example/", user_id: "U0BOT1" }), ...[0, 200, 400, 600, 800, 1000].map(page)]);
    const result = await provider.discover(TOKEN);
    expect(result.ok && result.destinations.length).toBe(1000);
    expect(result.ok && result.destinations[0]!.url).toBeUndefined();
    expect(fake.requests).toHaveLength(6);
  });

  it("maps failures", async () => {
    const { provider } = make([
      slackError("missing_scope"),
      ok({ url: "https://acme.slack.com/" }),
      slackError("invalid_auth"),
      ok({ url: "https://acme.slack.com/" }),
      jsonResponse(500, {}),
      ok({ url: "https://acme.slack.com/" }),
      ok({ channels: "nope" }),
    ]);
    await expect(provider.discover(undefined)).resolves.toEqual({ ok: false, reason: "credential_missing" });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
  });
});

describe("slack formatting and mentions", () => {
  it("escapes mrkdwn control characters so broadcasts, mentions and links cannot be injected", () => {
    expect(escapeSlackText("a & <!channel> <!here|here> <!everyone> <@U123> <#C1> <!subteam^S1> <https://x.example|ok>")).toBe(
      "a &amp; &lt;!channel&gt; &lt;!here|here&gt; &lt;!everyone&gt; &lt;@U123&gt; &lt;#C1&gt; &lt;!subteam^S1&gt; &lt;https://x.example|ok&gt;",
    );
  });

  it("keeps a listed <@USERID> in place, escapes unlisted ones and puts missing listed mentions first", () => {
    expect(renderSlackText("Hi <@U0AAA> and <@U0BBB> <!channel>", [{ userId: "U0AAA" }, { userId: "W0CCC" }, { userId: "U0AAA" }])).toEqual({
      ok: true,
      text: "<@W0CCC> Hi <@U0AAA> and &lt;@U0BBB&gt; &lt;!channel&gt;",
    });
    expect(renderSlackText("", [{ userId: "U0AAA" }])).toEqual({ ok: true, text: "<@U0AAA>" });
    expect(renderSlackText("plain @here @channel", [])).toEqual({ ok: true, text: "plain @here @channel" });
  });

  it("refuses invalid mention lists and a rendered text over 40,000 characters", () => {
    expect(renderSlackText("x", [{ userId: "!channel" }])).toMatchObject({ ok: false, error: { errorCode: "channel_mention_invalid" } });
    expect(renderSlackText("x", Array.from({ length: 21 }, (_, i) => ({ userId: `U0${i}AAA` })))).toMatchObject({ ok: false, error: { errorCode: "channel_mention_invalid" } });
    expect(renderSlackText("&".repeat(10_001))).toMatchObject({ ok: false, error: { errorCode: "channel_text_too_long" } });
    expect(renderSlackText("x".repeat(SLACK_MAX_TEXT_CHARS))).toMatchObject({ ok: true });
  });

  it("builds permalinks only from a Slack archives URL", () => {
    expect(slackMessageUrl("https://acme.slack.com/archives/C0123ABC", "1800000000.000100")).toBe("https://acme.slack.com/archives/C0123ABC/p1800000000000100");
    expect(slackMessageUrl("https://acme.slack.com/archives/C0123ABC", "1800000000.000200", "1800000000.000100")).toBe(
      "https://acme.slack.com/archives/C0123ABC/p1800000000000200?thread_ts=1800000000.000100&cid=C0123ABC",
    );
    expect(slackMessageUrl("https://evil.example/archives/C0123ABC", "1800000000.000100")).toBeUndefined();
    expect(slackMessageUrl(undefined, "1800000000.000100")).toBeUndefined();
  });
});

describe("slack send: text", () => {
  it("posts chat.postMessage with mrkdwn, parse none, link_names false and escaped text", async () => {
    const { provider, fake } = make([posted()]);
    const result = await provider.send(TOKEN, channel, { text: "Hello <!channel> <@U0BBB> *bold*", mentions: [{ userId: "U0AAA" }] });
    expect(result).toEqual({ status: "sent", resultIds: ["1800000000.000100"], resultUrls: ["https://acme.slack.com/archives/C0123ABC/p1800000000000100"] });
    expect(method(fake.requests[0]!)).toBe("chat.postMessage");
    expect(form(fake.requests[0]!)).toEqual({
      channel: "C0123ABC",
      text: "<@U0AAA> Hello &lt;!channel&gt; &lt;@U0BBB&gt; *bold*",
      mrkdwn: "true",
      parse: "none",
      link_names: "false",
    });
  });

  it("replies in a thread with thread_ts, from replyTo or a thread destination", async () => {
    const { provider, fake } = make([posted("1800000000.000300"), posted("1800000000.000400")]);
    const reply = await provider.send(TOKEN, channel, { text: "reply", replyTo: "1800000000.000100" });
    expect(reply.resultUrls).toEqual(["https://acme.slack.com/archives/C0123ABC/p1800000000000300?thread_ts=1800000000.000100&cid=C0123ABC"]);
    expect(form(fake.requests[0]!).thread_ts).toBe("1800000000.000100");
    await provider.send(TOKEN, { type: "thread", externalId: "C0123ABC", title: "t", parentId: "1800000000.000200" }, { text: "in thread" });
    expect(form(fake.requests[1]!).thread_ts).toBe("1800000000.000200");
  });

  it("refuses before any request: credentials, ids, replyTo, mentions, length, empty", async () => {
    const { provider, fake } = make();
    const refusals = [
      await provider.send(undefined, channel, { text: "x" }),
      await provider.send("xoxp-123-abc-defghijkl", channel, { text: "x" }),
      await provider.send(TOKEN, { ...channel, externalId: "general" }, { text: "x" }),
      await provider.send(TOKEN, channel, { text: "x", replyTo: "123" }),
      await provider.send(TOKEN, channel, { text: "x", mentions: [{ userId: "<!here>" }] }),
      await provider.send(TOKEN, channel, { text: "x".repeat(40_001) }),
      await provider.send(TOKEN, channel, { text: "<".repeat(10_001) }),
      await provider.send(TOKEN, channel, { text: "   " }),
    ];
    expect(refusals.map((r) => [r.status, r.errorCode])).toEqual([
      ["failed", "credential_missing"],
      ["failed", "credential_invalid"],
      ["failed", "channel_destination_invalid"],
      ["failed", "channel_reply_invalid"],
      ["failed", "channel_mention_invalid"],
      ["failed", "channel_text_too_long"],
      ["failed", "channel_text_too_long"],
      ["failed", "channel_message_empty"],
    ]);
    expect(fake.requests).toHaveLength(0);
    noToken(refusals);
  });

  it("classifies every failure class", async () => {
    const replies: FakeReply[] = [
      slackError("invalid_auth"),
      slackError("channel_not_found"),
      slackError("not_in_channel"),
      slackError("msg_too_long"),
      slackError("ratelimited"),
      slackError("internal_error"),
      slackError("fatal_error"),
      slackError("service_unavailable"),
      slackError("something_new"),
      jsonResponse(500, {}),
      jsonResponse(502, {}),
      jsonResponse(504, {}),
      jsonResponse(503, {}),
      jsonResponse(400, { ok: false, error: "invalid_arguments" }),
      jsonResponse(404, {}),
      new Error("socket hang up"),
      ok({ channel: "C0123ABC" }),
      new Response("<html>", { status: 200 }),
    ];
    const { provider, clock } = make(replies);
    const results = [];
    for (let i = 0; i < replies.length; i += 1) {
      clock.advance(5000);
      results.push(await provider.send(TOKEN, channel, { text: `post ${i}` }));
    }
    expect(results.map((r) => [r.status, r.errorCode])).toEqual([
      ["failed", "credential_invalid"],
      ["failed", "provider_not_found"],
      ["failed", "provider_forbidden"],
      ["failed", "channel_text_too_long"],
      ["failed", "provider_rate_limited"],
      ["uncertain", "provider_unexpected_status"],
      ["uncertain", "provider_unexpected_status"],
      ["failed", "provider_unavailable"],
      ["failed", "provider_rejected"],
      ["uncertain", "provider_unexpected_status"],
      ["uncertain", "provider_unexpected_status"],
      ["uncertain", "provider_unexpected_status"],
      ["failed", "provider_unavailable"],
      ["failed", "provider_rejected"],
      ["failed", "provider_not_found"],
      ["uncertain", "provider_timeout"],
      ["uncertain", "provider_bad_response"],
      ["uncertain", "provider_bad_response"],
    ]);
    expect(results[8]!.detail).toBe("slack: something_new");
    expect(results.every((r) => r.resultIds.length === 0 && r.partial === undefined)).toBe(true);
  });

  it("is uncertain on a timeout after the request started", async () => {
    const { provider } = make(["hang"], { timeoutMs: 5 });
    await expect(provider.send(TOKEN, channel, { text: "slow" })).resolves.toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
  });

  it("never returns the token, whatever the provider echoes", async () => {
    const { provider, clock } = make([
      jsonResponse(400, { ok: false, error: TOKEN }),
      slackError(`bad ${TOKEN}`),
      new Error(`getaddrinfo ENOTFOUND slack.com ${TOKEN}`),
      jsonResponse(500, { error: `Bearer ${TOKEN}` }),
    ]);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      clock.advance(5000);
      results.push(await provider.send(TOKEN, channel, { text: "x" }));
    }
    noToken(results);
    expect(results[0]!.detail).toBe("slack: unknown_error");
  });
});

describe("slack send: rate limits", () => {
  it("honours one 429 Retry-After header, then sends", async () => {
    const { provider, fake, clock } = make([jsonResponse(429, { ok: false, error: "ratelimited" }, { "retry-after": "3" }), posted()]);
    await expect(provider.send(TOKEN, channel, { text: "x" })).resolves.toMatchObject({ status: "sent" });
    expect(clock.sleeps).toEqual([3000]);
    expect(fake.requests).toHaveLength(2);
  });

  it("fails on a second 429 or a Retry-After over 30 s, without waiting", async () => {
    const { provider, clock } = make([
      jsonResponse(429, {}, { "retry-after": "1" }),
      jsonResponse(429, {}, { "retry-after": "1" }),
      jsonResponse(429, {}, { "retry-after": "120" }),
    ]);
    const twice = await provider.send(TOKEN, channel, { text: "x" });
    expect(twice).toMatchObject({ status: "failed", errorCode: "provider_rate_limited", detail: "rate limited by the provider; retry_after 1s" });
    clock.advance(5000);
    const long = await provider.send(TOKEN, channel, { text: "y" });
    expect(long).toMatchObject({ status: "failed", errorCode: "provider_rate_limited" });
    expect(clock.sleeps).toEqual([1000]);
  });

  it("spaces messages to one channel at one per second, other channels are independent", async () => {
    const { provider, clock } = make([posted(), posted(), posted()]);
    await provider.send(TOKEN, channel, { text: "1" });
    await provider.send(TOKEN, { ...channel, externalId: "C0OTHER", url: undefined }, { text: "2" });
    expect(clock.sleeps).toEqual([]);
    await provider.send(TOKEN, channel, { text: "3" });
    expect(clock.sleeps).toEqual([1000]);
  });
});

describe("slack send: files (upload v2)", () => {
  const ticket = (id: string, url = UPLOAD) => ok({ upload_url: url, file_id: id });
  const uploadOk = () => new Response("OK - 7", { status: 200 });

  it("gets an upload URL per file, uploads bytes without the token, then shares once with initial_comment", async () => {
    const { provider, fake } = make([
      ticket("F0AAA1"),
      uploadOk(),
      ticket("F0BBB2", "https://files.slack.com/upload/v1/DEF456"),
      uploadOk(),
      ok({ files: [{ id: "F0AAA1", title: "pic.png" }, { id: "F0BBB2", title: "doc.pdf" }] }),
    ]);
    const files = [attachment("pic.png", "image/png"), attachment("doc.pdf", "application/pdf")];
    const result = await provider.send(TOKEN, channel, { text: "See <!here>", attachments: files, replyTo: "1800000000.000100", mentions: [{ userId: "U0AAA" }] });
    expect(result).toEqual({ status: "sent", resultIds: ["F0AAA1", "F0BBB2"], resultUrls: [] });
    expect(fake.requests.map(method)).toEqual(["files.getUploadURLExternal", UPLOAD, "files.getUploadURLExternal", "https://files.slack.com/upload/v1/DEF456", "files.completeUploadExternal"]);
    expect(form(fake.requests[0]!)).toEqual({ filename: "pic.png", length: "7" });
    const upload = fake.requests[1]!;
    expect(upload.method).toBe("POST");
    expect(upload.headers.authorization).toBeUndefined();
    expect(upload.headers["content-type"]).toBe("image/png");
    expect(await (upload.body as unknown as Blob).text()).toBe("pic.png");
    expect(form(fake.requests[4]!)).toEqual({
      files: JSON.stringify([{ id: "F0AAA1", title: "pic.png" }, { id: "F0BBB2", title: "doc.pdf" }]),
      channel_id: "C0123ABC",
      thread_ts: "1800000000.000100",
      initial_comment: "<@U0AAA> See &lt;!here&gt;",
    });
  });

  it("sends voice as an audio file plus its transcript line, naming the fallback", async () => {
    const { provider, fake } = make([ticket("F0VVV1"), uploadOk(), ok({ files: [{ id: "F0VVV1" }] })]);
    const voice = attachment("note.ogg", "audio/ogg", "OggS....", { kind: "voice", transcript: "Hello team" });
    const result = await provider.send(TOKEN, channel, { text: "Voice note", attachments: [voice] });
    expect(result).toEqual({ status: "sent", resultIds: ["F0VVV1"], resultUrls: [], fallback: "voice→audio+transcript" });
    expect(form(fake.requests[2]!).initial_comment).toBe("Voice note\nTranscript: Hello team");
  });

  it("omits initial_comment for a file-only post and refuses undeclared or mismatched files", async () => {
    const { provider, fake } = make([ticket("F0AAA1"), uploadOk(), ok({ files: [{ id: "F0AAA1" }] })]);
    await provider.send(TOKEN, channel, { text: "", attachments: [attachment("pic.png", "image/png")] });
    expect(form(fake.requests[2]!)).not.toHaveProperty("initial_comment");
    const bad = { ...attachment("x.png", "image/png"), sha256: "0".repeat(64) };
    expect(await provider.send(TOKEN, channel, { text: "x", attachments: [bad] })).toMatchObject({ status: "failed", errorCode: "channel_file_digest_mismatch" });
    expect(await provider.send(TOKEN, channel, { text: "x", attachments: [attachment("x.exe", "application/x-msdownload", "MZ", { kind: "file" })] })).toMatchObject({
      status: "failed",
      errorCode: "channel_file_type_not_allowed",
    });
    expect(fake.requests).toHaveLength(3);
  });

  it("is failed (nothing posted) when a step before the share fails, even on a timeout", async () => {
    const pic = () => [attachment("pic.png", "image/png")];
    const { provider, fake, clock } = make([
      ticket("F0AAA1", "https://evil.example/upload"),
      slackError("invalid_auth"),
      ticket("F0AAA1"),
      jsonResponse(500, {}),
      ticket("F0AAA1"),
      new Error("socket hang up"),
    ]);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      clock.advance(5000);
      results.push(await provider.send(TOKEN, channel, { text: "x", attachments: pic() }));
    }
    expect(results.map((r) => [r.status, r.errorCode])).toEqual([
      ["failed", "provider_bad_response"],
      ["failed", "credential_invalid"],
      ["failed", "provider_unexpected_status"],
      ["failed", "provider_timeout"],
    ]);
    expect(results.every((r) => /before the share step; nothing was posted/u.test(r.detail ?? ""))).toBe(true);
    expect(fake.requests.map(method)).not.toContain("files.completeUploadExternal");
    expect(fake.requests.map((r) => r.url)).not.toContain("https://evil.example/upload");
  });

  it("is uncertain (or partial) when the share step fails or is not understood", async () => {
    const pics = () => [attachment("a.png", "image/png"), attachment("b.png", "image/png")];
    const flow = (complete: FakeReply): FakeReply[] => [ticket("F0AAA1"), uploadOk(), ticket("F0BBB2"), uploadOk(), complete];
    const { provider, clock } = make([
      ...flow(new Error("socket hang up")),
      ...flow(slackError("internal_error")),
      ...flow(ok({})),
      ...flow(ok({ files: [{ id: "F0AAA1" }] })),
      ...flow(slackError("not_in_channel")),
    ]);
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      clock.advance(5000);
      results.push(await provider.send(TOKEN, channel, { text: "x", attachments: pics() }));
    }
    expect(results.map((r) => [r.status, r.errorCode, r.partial ?? null, r.resultIds])).toEqual([
      ["uncertain", "provider_timeout", null, []],
      ["uncertain", "provider_unexpected_status", null, []],
      ["uncertain", "provider_bad_response", null, []],
      ["uncertain", "provider_bad_response", true, ["F0AAA1"]],
      ["failed", "provider_forbidden", null, []],
    ]);
  });
});

describe("slack react, edit, remove", () => {
  it("adds and removes reactions; an already-applied state is not an error", async () => {
    const { provider, fake } = make([ok(), ok(), slackError("already_reacted"), slackError("no_reaction"), slackError("message_not_found"), new Error("reset")]);
    expect(await provider.react(TOKEN, channel, "1800000000.000100", ":tada:")).toEqual({ status: "sent" });
    expect(method(fake.requests[0]!)).toBe("reactions.add");
    expect(form(fake.requests[0]!)).toEqual({ channel: "C0123ABC", timestamp: "1800000000.000100", name: "tada" });
    expect(await provider.react(TOKEN, channel, "1800000000.000100", "thumbsup::skin-tone-3", { remove: true })).toEqual({ status: "sent" });
    expect(method(fake.requests[1]!)).toBe("reactions.remove");
    expect(form(fake.requests[1]!).name).toBe("thumbsup::skin-tone-3");
    expect(await provider.react(TOKEN, channel, "1800000000.000100", "tada")).toMatchObject({ status: "sent", detail: "the reaction was already there" });
    expect(await provider.react(TOKEN, channel, "1800000000.000100", "tada", { remove: true })).toMatchObject({ status: "sent" });
    expect(await provider.react(TOKEN, channel, "1800000000.000100", "tada")).toEqual({ status: "failed", errorCode: "provider_not_found", detail: "slack: message_not_found" });
    expect(await provider.react(TOKEN, channel, "1800000000.000100", "tada")).toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
  });

  it("refuses bad emoji, ids and credentials without a request", async () => {
    const { provider, fake } = make();
    expect(await provider.react(TOKEN, channel, "1800000000.000100", "<!channel>")).toMatchObject({ status: "failed", errorCode: "channel_reaction_invalid" });
    expect(await provider.react(TOKEN, channel, "abc", "tada")).toMatchObject({ errorCode: "channel_message_id_invalid" });
    expect(await provider.react(TOKEN, { ...channel, externalId: "x" }, "1800000000.000100", "tada")).toMatchObject({ errorCode: "channel_destination_invalid" });
    expect(await provider.react("", channel, "1800000000.000100", "tada")).toMatchObject({ errorCode: "credential_missing" });
    expect(await provider.edit(TOKEN, channel, "1.2.3", { text: "x" })).toMatchObject({ errorCode: "channel_message_id_invalid" });
    expect(await provider.edit(TOKEN, channel, "1800000000.000100", { text: " " })).toMatchObject({ errorCode: "channel_message_empty" });
    expect(await provider.edit(TOKEN, channel, "1800000000.000100", { text: "x".repeat(40_001) })).toMatchObject({ errorCode: "channel_text_too_long" });
    expect(await provider.remove(TOKEN, channel, "nope")).toMatchObject({ errorCode: "channel_message_id_invalid" });
    expect(fake.requests).toHaveLength(0);
  });

  it("edits the bot's own message with chat.update (escaped, mentions allowed)", async () => {
    const { provider, fake } = make([ok({ channel: "C0123ABC", ts: "1800000000.000100" }), slackError("cant_update_message"), jsonResponse(502, {})]);
    const result = await provider.edit(TOKEN, channel, "1800000000.000100", { text: "Fixed <!everyone> <@U0AAA>", mentions: [{ userId: "U0AAA" }] });
    expect(result).toEqual({ status: "sent", resultIds: ["1800000000.000100"], resultUrls: ["https://acme.slack.com/archives/C0123ABC/p1800000000000100"] });
    expect(method(fake.requests[0]!)).toBe("chat.update");
    expect(form(fake.requests[0]!)).toEqual({ channel: "C0123ABC", ts: "1800000000.000100", text: "Fixed &lt;!everyone&gt; <@U0AAA>", parse: "none", link_names: "false" });
    expect(await provider.edit(TOKEN, channel, "1800000000.000100", { text: "again" })).toMatchObject({ status: "failed", errorCode: "provider_forbidden" });
    expect(await provider.edit(TOKEN, channel, "1800000000.000100", { text: "third" })).toMatchObject({ status: "uncertain" });
  });

  it("deletes the bot's own message with chat.delete", async () => {
    const { provider, fake } = make([ok({ channel: "C0123ABC", ts: "1800000000.000100" }), slackError("cant_delete_message"), "hang"]);
    expect(await provider.remove(TOKEN, channel, "1800000000.000100")).toEqual({ status: "sent" });
    expect(method(fake.requests[0]!)).toBe("chat.delete");
    expect(form(fake.requests[0]!)).toEqual({ channel: "C0123ABC", ts: "1800000000.000100" });
    expect(await provider.remove(TOKEN, channel, "1800000000.000100")).toMatchObject({ status: "failed", errorCode: "provider_forbidden" });
    const slow = createSlackProvider({ fetchImpl: createFakeFetch(["hang"]).fetchImpl, timeoutMs: 5 });
    expect(await slow.remove!(TOKEN, channel, "1800000000.000100")).toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
  });
});

describe("slack findPerson and openDirect", () => {
  const member = (id: string, name: string, display: string, extra: Record<string, unknown> = {}) => ({ id, name, real_name: `${display} Real`, profile: { display_name: display }, ...extra });

  it("looks up by email in the form body (never the URL)", async () => {
    const { provider, fake } = make([ok({ user: member("U0ANNA", "anna", "Anna") }), slackError("users_not_found"), ok({ user: member("U0GONE", "gone", "Gone", { deleted: true }) }), slackError("missing_scope")]);
    expect(await provider.findPerson(TOKEN, { email: "anna@example.com" })).toEqual({ ok: true, userId: "U0ANNA", displayName: "Anna" });
    expect(method(fake.requests[0]!)).toBe("users.lookupByEmail");
    expect(fake.requests[0]!.url).not.toContain("anna");
    expect(form(fake.requests[0]!)).toEqual({ email: "anna@example.com" });
    expect(await provider.findPerson(TOKEN, { email: "nobody@example.com" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await provider.findPerson(TOKEN, { email: "gone@example.com" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await provider.findPerson(TOKEN, { email: "anna@example.com" })).toEqual({ ok: false, reason: "failed", errorCode: "provider_forbidden", detail: "slack: missing_scope" });
  });

  it("finds by handle from a cached users.list (at most 10 minutes), never returning the list", async () => {
    const list1 = ok({ members: [member("U0ANNA", "anna", "Anna"), member("U0BOT", "bot", "Bot", { is_bot: true })], response_metadata: { next_cursor: "page2" } });
    const list2 = ok({ members: [member("U0BEN", "ben", "Benny"), member("U0BEN2", "ben.k", "benny")], response_metadata: { next_cursor: "" } });
    const list3 = ok({ members: [member("U0ANNA", "anna", "Anna")] });
    const { provider, fake, clock } = make([list1, list2, list3]);
    expect(await provider.findPerson(TOKEN, { handle: "@Anna" })).toEqual({ ok: true, userId: "U0ANNA", displayName: "Anna" });
    expect(fake.requests.map(method)).toEqual(["users.list", "users.list"]);
    expect(form(fake.requests[0]!)).toEqual({ limit: "200" });
    expect(form(fake.requests[1]!)).toEqual({ limit: "200", cursor: "page2" });
    expect(await provider.findPerson(TOKEN, { handle: "ben" })).toEqual({ ok: true, userId: "U0BEN", displayName: "Benny" });
    expect(await provider.findPerson(TOKEN, { handle: "benny" })).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(await provider.findPerson(TOKEN, { handle: "bot" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(fake.requests).toHaveLength(2);
    clock.advance(SLACK_DIRECTORY_TTL_MS);
    expect(await provider.findPerson(TOKEN, { handle: "ben" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(fake.requests).toHaveLength(3);
  });

  it("refuses a bad query without a request", async () => {
    const { provider, fake } = make();
    expect(await provider.findPerson(TOKEN, {})).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    expect(await provider.findPerson(TOKEN, { email: "a@example.com", handle: "a" })).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    expect(await provider.findPerson(TOKEN, { email: "not-an-email" })).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    expect(await provider.findPerson(TOKEN, { handle: "<!channel>" })).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    expect(await provider.findPerson(null, { handle: "anna" })).toMatchObject({ ok: false, errorCode: "credential_missing" });
    expect(fake.requests).toHaveLength(0);
  });

  it("opens a DM with conversations.open and returns a person destination", async () => {
    const { provider, fake } = make([ok({ channel: { id: "D0DM1" } }), slackError("cannot_dm_bot"), ok({ channel: { id: "C0NOTDM" } })]);
    expect(await provider.openDirect(TOKEN, "U0ANNA")).toEqual({
      ok: true,
      destination: { type: "person", externalId: "D0DM1", title: "Direct message: U0ANNA", personId: "U0ANNA" },
    });
    expect(method(fake.requests[0]!)).toBe("conversations.open");
    expect(form(fake.requests[0]!)).toEqual({ users: "U0ANNA", return_im: "true" });
    expect(await provider.openDirect(TOKEN, "U0BOT")).toEqual({ ok: false, errorCode: "provider_forbidden", detail: "slack: cannot_dm_bot" });
    expect(await provider.openDirect(TOKEN, "U0ANNA")).toMatchObject({ ok: false, errorCode: "provider_bad_response" });
    expect(await provider.openDirect(TOKEN, "U0ANNA,U0BEN")).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    expect(fake.requests).toHaveLength(3);
  });

  it("sends into the DM destination like any channel", async () => {
    const { provider, fake } = make([ok({ channel: "D0DM1", ts: "1800000000.000900" })]);
    const result = await provider.send(TOKEN, { type: "person", externalId: "D0DM1", title: "Direct message: Anna", personId: "U0ANNA" }, { text: "Hi Anna" });
    expect(result).toEqual({ status: "sent", resultIds: ["1800000000.000900"], resultUrls: [] });
    expect(form(fake.requests[0]!).channel).toBe("D0DM1");
  });
});

describe("slack scheduleNative (chat.scheduleMessage)", () => {
  it("schedules with post_at in seconds and returns the scheduled_message_id", async () => {
    const { provider, fake, clock } = make([ok({ channel: "C0123ABC", scheduled_message_id: "Q1298393284", post_at: 1_800_003_600 })]);
    const postAt = new Date(clock.now() + 3_600_000);
    const result = await provider.scheduleNative(TOKEN, channel, { text: "Later <!here>", postAt, replyTo: "1800000000.000100" });
    expect(result).toEqual({ status: "scheduled", scheduledMessageId: "Q1298393284", postAt: new Date(1_800_003_600_000).toISOString() });
    expect(method(fake.requests[0]!)).toBe("chat.scheduleMessage");
    expect(form(fake.requests[0]!)).toEqual({
      channel: "C0123ABC",
      post_at: String(Math.floor(postAt.getTime() / 1000)),
      text: "Later &lt;!here&gt;",
      parse: "none",
      link_names: "false",
      thread_ts: "1800000000.000100",
    });
  });

  it("refuses outside 1 minute to 120 days, empty text and long text, without a request", async () => {
    const { provider, fake, clock } = make();
    const at = (ms: number) => new Date(clock.now() + ms);
    expect(await provider.scheduleNative(TOKEN, channel, { text: "x", postAt: at(30_000) })).toMatchObject({ status: "failed", errorCode: "channel_schedule_window" });
    expect(await provider.scheduleNative(TOKEN, channel, { text: "x", postAt: at(121 * 86_400_000) })).toMatchObject({ errorCode: "channel_schedule_window" });
    expect(await provider.scheduleNative(TOKEN, channel, { text: "x", postAt: new Date(Number.NaN) })).toMatchObject({ errorCode: "channel_schedule_window" });
    expect(await provider.scheduleNative(TOKEN, channel, { text: "", postAt: at(3_600_000) })).toMatchObject({ errorCode: "channel_message_empty" });
    expect(await provider.scheduleNative(TOKEN, channel, { text: "x".repeat(40_001), postAt: at(3_600_000) })).toMatchObject({ errorCode: "channel_text_too_long" });
    expect(fake.requests).toHaveLength(0);
  });

  it("maps provider errors and keeps 30 per 5 minutes per channel", async () => {
    const replies: FakeReply[] = [slackError("time_too_far"), slackError("restricted_too_many"), jsonResponse(500, {}), ok({ scheduled_message_id: "nope" })];
    for (let i = 0; i < 31; i += 1) replies.push(ok({ scheduled_message_id: `Q${i}AAA`, post_at: 1_800_003_600 }));
    const { provider, clock } = make(replies);
    const postAt = () => new Date(clock.now() + 3_600_000);
    expect(await provider.scheduleNative(TOKEN, channel, { text: "a", postAt: postAt() })).toMatchObject({ status: "failed", errorCode: "provider_rejected", detail: "slack: time_too_far" });
    expect(await provider.scheduleNative(TOKEN, channel, { text: "b", postAt: postAt() })).toMatchObject({ status: "failed", errorCode: "provider_rate_limited" });
    expect(await provider.scheduleNative(TOKEN, channel, { text: "c", postAt: postAt() })).toMatchObject({ status: "uncertain" });
    expect(await provider.scheduleNative(TOKEN, channel, { text: "d", postAt: postAt() })).toMatchObject({ status: "uncertain", errorCode: "provider_bad_response" });
    clock.advance(300_000);
    for (let i = 0; i < 31; i += 1) await provider.scheduleNative(TOKEN, channel, { text: `n${i}`, postAt: postAt() });
    // The 31st in the window waits for a free slot (10 s at 30 per 300 s).
    expect(clock.sleeps).toEqual([10_000]);
  });
});

describe("slack inbound helpers", () => {
  const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
  const sign = (timestamp: string, body: string, secret = SECRET) => `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const body = JSON.stringify({ type: "event_callback", event_id: "Ev0ABC", event: { type: "message" } });

  it("verifies X-Slack-Signature over v0:{timestamp}:{raw body} within five minutes", () => {
    const nowMs = 1_800_000_000_000;
    const ts = "1800000000";
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: body, nowMs })).toEqual({ ok: true });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: new TextEncoder().encode(body), nowMs })).toEqual({ ok: true });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: body, nowMs: nowMs + 300_000 })).toEqual({ ok: true });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: body, nowMs: nowMs + 301_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, body), rawBody: `${body} `, nowMs })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackSignature({ signingSecret: "other", timestamp: ts, signature: sign(ts, body), rawBody: body, nowMs })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: "v1=abc", rawBody: body, nowMs })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: "12a", signature: sign(ts, body), rawBody: body, nowMs })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: undefined, signature: sign(ts, body), rawBody: body, nowMs })).toEqual({ ok: false, reason: "header_missing" });
    expect(verifySlackSignature({ signingSecret: "", timestamp: ts, signature: sign(ts, body), rawBody: body, nowMs })).toEqual({ ok: false, reason: "secret_missing" });
  });

  const SELF = { teamId: "T0TEAM" };
  const envelope = (event: Record<string, unknown>) => ({ type: "event_callback", team_id: "T0TEAM", event_id: "Ev0ABC123", event });

  it("answers url_verification and normalises a message event", () => {
    expect(parseSlackEvent({ type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" }, SELF)).toEqual({
      kind: "url_verification",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    });
    const parsed = parseSlackEvent(
      JSON.stringify(
        envelope({
          type: "message",
          channel: "C0123ABC",
          user: "U0ANNA",
          ts: "1800000000.000200",
          thread_ts: "1800000000.000100",
          text: "Hi &lt;@U0BOT1&gt; &amp; team\u0007‮",
          user_profile: { display_name: "Anna\u0000" },
          files: [{ id: "F0AAA1", name: "../plan.pdf", mimetype: "application/pdf; x=1", size: 1234 }, { id: "bad" }],
        }),
      ),
      { ...SELF, botUserId: "U0BOT1" },
    );
    expect(parsed).toEqual({
      kind: "message",
      eventId: "Ev0ABC123",
      teamId: "T0TEAM",
      message: {
        platform: "slack",
        channelId: "C0123ABC",
        threadId: "1800000000.000100",
        messageId: "1800000000.000200",
        senderUserId: "U0ANNA",
        senderDisplay: "Anna",
        text: "Hi <@U0BOT1> & team",
        attachments: [{ id: "F0AAA1", name: "_plan.pdf", contentType: "application/pdf", bytes: 1234 }],
      },
    });
  });

  it("treats a thread root (thread_ts = ts) as top level and accepts app_mention", () => {
    const parsed = parseSlackEvent(envelope({ type: "app_mention", channel: "C0123ABC", user: "U0ANNA", ts: "1800000000.000100", thread_ts: "1800000000.000100", text: "hey" }), SELF);
    expect(parsed.kind).toBe("message");
    if (parsed.kind === "message") {
      expect(parsed.message.threadId).toBeUndefined();
      expect(parsed.message.senderDisplay).toBe("U0ANNA");
    }
  });

  it("ignores bots, its own messages, edits, deletes and malformed events", () => {
    const base = { type: "message", channel: "C0123ABC", user: "U0ANNA", ts: "1800000000.000100", text: "x" };
    expect(parseSlackEvent(envelope({ ...base, subtype: "bot_message", bot_id: "B1" }), SELF)).toEqual({ kind: "ignored", reason: "bot_message" });
    expect(parseSlackEvent(envelope({ ...base, bot_id: "B0BOT1" }), SELF)).toEqual({ kind: "ignored", reason: "bot_message" });
    expect(parseSlackEvent(envelope({ ...base, user: "U0BOT1" }), { ...SELF, botUserId: "U0BOT1" })).toEqual({ kind: "ignored", reason: "own_message" });
    expect(parseSlackEvent(envelope({ ...base, subtype: "message_changed" }), SELF)).toEqual({ kind: "ignored", reason: "unsupported_subtype" });
    expect(parseSlackEvent(envelope({ ...base, subtype: "message_deleted" }), SELF)).toEqual({ kind: "ignored", reason: "unsupported_subtype" });
    expect(parseSlackEvent(envelope({ ...base, subtype: "thread_broadcast" }), SELF).kind).toBe("message");
    expect(parseSlackEvent(envelope({ ...base, type: "reaction_added" }), SELF)).toEqual({ kind: "ignored", reason: "unsupported_event" });
    expect(parseSlackEvent(envelope({ ...base, channel: "general" }), SELF)).toEqual({ kind: "ignored", reason: "malformed" });
    expect(parseSlackEvent({ type: "event_callback", team_id: "T0TEAM", event_id: "x", event: base }, SELF)).toEqual({ kind: "ignored", reason: "malformed" });
    expect(parseSlackEvent("{not json", SELF)).toEqual({ kind: "ignored", reason: "malformed" });
    expect(parseSlackEvent({ type: "app_rate_limited" }, SELF)).toEqual({ kind: "ignored", reason: "not_an_event" });
  });
});

describe("slack inbound: team binding, event_id dedupe and the full check", () => {
  const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
  const nowMs = 1_800_000_000_000;
  const ts = "1800000000";
  const sign = (body: string) => `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  const event = (team: string | undefined, eventId = "Ev0ABC123") =>
    JSON.stringify({
      type: "event_callback",
      ...(team ? { team_id: team } : {}),
      event_id: eventId,
      event: { type: "message", channel: "C0123ABC", user: "U0ANNA", ts: "1800000000.000100", text: "hi" },
    });

  it("ignores a signature-verified event of another team, without a team, or when the installed team is unknown", () => {
    expect(parseSlackEvent(event("T0OTHER"), { teamId: "T0ACME" })).toEqual({ kind: "ignored", reason: "team_mismatch" });
    expect(parseSlackEvent(event(undefined), { teamId: "T0ACME" })).toEqual({ kind: "ignored", reason: "team_mismatch" });
    expect(parseSlackEvent(event("T0ACME"), { teamId: "" })).toEqual({ kind: "ignored", reason: "team_unknown" });
    expect(parseSlackEvent(event("T0ACME"), {} as never)).toEqual({ kind: "ignored", reason: "team_unknown" });
    expect(parseSlackEvent(event("T0ACME"), { teamId: "T0ACME" })).toMatchObject({ kind: "message", teamId: "T0ACME" });
  });

  it("remembers ids for the TTL, bounded, oldest first", () => {
    let clock = 0;
    const guard = createReplayGuard({ ttlMs: 1000, maxEntries: 3, now: () => clock });
    expect(guard.firstSeen("a")).toBe(true);
    expect(guard.firstSeen("a")).toBe(false);
    clock = 999;
    expect(guard.firstSeen("a")).toBe(false);
    clock = 1000;
    expect(guard.firstSeen("a")).toBe(true);
    for (const id of ["b", "c", "d"]) expect(guard.firstSeen(id)).toBe(true);
    expect(guard.size).toBe(3);
    // "a" was the oldest and was dropped to stay inside the bound.
    expect(guard.firstSeen("a")).toBe(true);
    expect(SLACK_EVENT_DEDUPE_TTL_MS).toBeGreaterThanOrEqual(2 * 300_000);
  });

  it("acceptSlackEvent: signature first, then team, then event_id dedupe", () => {
    const dedupe = createSlackEventDedupe(() => nowMs);
    const self = { teamId: "T0ACME", botUserId: "U0BOT1" };
    const body = event("T0ACME");
    const check = (raw: string, signature = sign(raw)) =>
      acceptSlackEvent({ signingSecret: SECRET, timestamp: ts, signature, rawBody: raw, self, dedupe, nowMs });
    expect(check(body, sign("other"))).toEqual({ kind: "rejected", reason: "mismatch" });
    expect(dedupe.size).toBe(0);
    expect(check(body)).toMatchObject({ kind: "message", eventId: "Ev0ABC123", teamId: "T0ACME" });
    // A Slack retry or a captured request replayed inside the window.
    expect(check(body)).toEqual({ kind: "ignored", reason: "duplicate" });
    expect(check(event("T0OTHER", "Ev0OTHER1"))).toEqual({ kind: "ignored", reason: "team_mismatch" });
    expect(acceptSlackEvent({ signingSecret: SECRET, timestamp: ts, signature: sign(body), rawBody: new TextEncoder().encode(event("T0ACME", "Ev0NEXT1")), self, dedupe, nowMs }).kind).toBe("rejected");
    const next = event("T0ACME", "Ev0NEXT1");
    expect(acceptSlackEvent({ signingSecret: SECRET, timestamp: ts, signature: sign(next), rawBody: new TextEncoder().encode(next), self, dedupe, nowMs }).kind).toBe("message");
  });
});

describe("slack capabilities exposed to agents (wired filter)", () => {
  it("hides DM, reactions, edit, delete, mentions and native schedule until their operations ship; inbound and replies are wired", () => {
    const effective = wiredCapabilities(createSlackProvider().capabilities);
    for (const feature of ["inbound", "thread.replies"]) expect(capabilitySupports(effective, feature), feature).toBe(true);
    for (const feature of ["dm", "reactions.add", "reactions.remove", "reactions.custom", "edit", "delete", "mentions.users", "schedule.native"]) {
      expect(AGENT_WIRED_FEATURES.has(feature as never), feature).toBe(false);
      expect(capabilitySupports(effective, feature), feature).toBe(false);
    }
    for (const feature of ["image", "file", "audio", "voice", "video"]) expect(capabilitySupports(effective, feature), feature).toBe(true);
  });
});

describe("slackFailure", () => {
  it("never echoes an unexpected error string", () => {
    expect(slackFailure("Some Weird Thing")).toEqual({ status: "failed", errorCode: "provider_rejected", detail: "slack: unknown_error" });
    expect(slackFailure("token_expired")).toMatchObject({ errorCode: "credential_invalid" });
  });
});

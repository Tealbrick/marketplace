import { describe, expect, it } from "vitest";
import {
  DISCORD_VOICE_MESSAGE_FLAG,
  buildDiscordVoicePayload,
  createDiscordProvider,
  discordReactionPath,
  parseDiscordMessageCreate,
  renderDiscordContent,
} from "./discord.js";
import { readOggOpus } from "./ogg-opus.js";
import { createTelegramProvider } from "./telegram.js";
import { attachment, buildOggOpus, createFakeClock, createFakeFetch, jsonResponse, type FakeReply } from "./test-support.js";
import { applyFallbacks, capabilityForKind } from "./capabilities.js";
import type { ChannelDestination } from "./types.js";

const MiB = 1024 * 1024;

// A fake token in the Discord shape, assembled at runtime so secret scanners do not flag the source.
const TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GabcDE", "fakefakefakefakefakefakefakefake12"].join(".");
const API = "https://discord.com/api/v10";

function make(replies: FakeReply[] = [], extra: { timeoutMs?: number } = {}) {
  const fake = createFakeFetch(replies);
  const clock = createFakeClock();
  const provider = createDiscordProvider({ fetchImpl: fake.fetchImpl, sleep: clock.sleep, now: clock.now, ...extra });
  return { fake, clock, provider };
}

const channel: ChannelDestination = { type: "channel", externalId: "2002", title: "general", parentId: "1001" };
const okMessage = (id: string) => jsonResponse(200, { id, channel_id: "2002", content: "x" });

function noToken(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(TOKEN);
  expect(JSON.stringify(value)).not.toContain("fakefakefakefake");
}

describe("discord capabilities", () => {
  it("declares the spec 3.1 vocabulary", () => {
    const { provider } = make();
    expect(provider.id).toBe("discord");
    expect(provider.capabilities).toEqual({
      channelCapabilities: 2,
      text: { maxChars: 2000 },
      markup: "discord-markdown",
      mentions: { users: true, broadcast: "suppressed" },
      dm: { open: true, maxMembers: 1 },
      image: { types: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 10 * MiB, albumMax: 4 },
      file: { types: ["application/pdf", "text/plain", "application/zip", "application/octet-stream"], maxBytes: 10 * MiB },
      audio: { types: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 10 * MiB },
      voice: { native: true, types: ["audio/ogg"], maxBytes: 10 * MiB },
      video: { types: ["video/mp4"], maxBytes: 10 * MiB },
      thread: { replies: true, topics: false, forum: false },
      reactions: { add: true, remove: true, custom: true },
      buttons: { url: false, callback: false },
      poll: { questionMaxChars: 300, minOptions: 1, maxOptions: 10, optionMaxChars: 55, multiple: true, durationHours: { min: 1, max: 768, default: 24 } },
      edit: { own: true },
      delete: { own: true },
      canvas: false,
      presence: { typing: false, status: false },
      ephemeral: false,
      live: false,
      schedule: { native: false },
      events: { create: false },
      discover: "list",
      inbound: { mode: "none", dedupe: false },
      audience: { count: false },
      limits: { perChatPerSecond: 1, perChatPerMinute: 60, retryAfter: "honoured" },
    });
    expect(capabilityForKind(provider.capabilities, "voice")).toMatchObject({ native: true });
    expect(capabilityForKind(provider.capabilities, "video")).toMatchObject({ types: ["video/mp4"] });
  });
});

describe("discord verify", () => {
  it("calls GET /users/@me with the bot authorization and user agent", async () => {
    const { provider, fake } = make([jsonResponse(200, { id: "999", username: "tb-bot" })]);
    await expect(provider.verify(TOKEN)).resolves.toEqual({ ok: true, botId: "999", botUsername: "tb-bot" });
    const request = fake.requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url).toBe(`${API}/users/@me`);
    expect(request.headers.authorization === `Bot ${TOKEN}`).toBe(true);
    expect(request.headers["user-agent"]).toBe("DiscordBot (https://tealbrick.com, 1)");
  });

  it("maps failures", async () => {
    const { provider, fake } = make([jsonResponse(401, { message: "401: Unauthorized", code: 0 }), jsonResponse(503, {}), new Error(`dns ${TOKEN}`)]);
    await expect(provider.verify("")).resolves.toEqual({ ok: false, reason: "credential_missing" });
    await expect(provider.verify("has space")).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    expect(fake.requests).toHaveLength(0);
    await expect(provider.verify(TOKEN)).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    await expect(provider.verify(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
    const last = await provider.verify(TOKEN);
    expect(last).toEqual({ ok: false, reason: "provider_unavailable" });
    noToken(last);
  });
});

describe("discord discover", () => {
  it("lists guilds then keeps text (0) and announcement (5) channels", async () => {
    const { provider, fake } = make([
      jsonResponse(200, [{ id: "1001", name: "Tealbrick" }, { id: "1002", name: "Hidden" }]),
      jsonResponse(200, [
        { id: "3", type: 2, name: "voice" },
        { id: "2", type: 5, name: "announcements", position: 1 },
        { id: "1", type: 0, name: "general", position: 0 },
        { id: "4", type: 4, name: "category" },
        { id: "5", type: 15, name: "forum" },
      ]),
      jsonResponse(200, {
        threads: [
          { id: "71", type: 11, name: "launch plan", parent_id: "1" },
          { id: "72", type: 12, name: "private", parent_id: "2" },
          { id: "73", type: 11, name: "locked", parent_id: "1", thread_metadata: { locked: true } },
          { id: "74", type: 11, name: "in the forum", parent_id: "5" },
          { id: "75", type: 0, name: "not a thread", parent_id: "1" },
        ],
        members: [],
      }),
      jsonResponse(403, { message: "Missing Access", code: 50001 }),
    ]);
    const result = await provider.discover(TOKEN);
    expect(result).toEqual({
      ok: true,
      destinations: [
        { type: "channel", externalId: "1", title: "Tealbrick / #general", url: "https://discord.com/channels/1001/1", parentId: "1001" },
        { type: "channel", externalId: "2", title: "Tealbrick / #announcements", url: "https://discord.com/channels/1001/2", parentId: "1001" },
        { type: "thread", externalId: "71", title: "Tealbrick / #general / launch plan", url: "https://discord.com/channels/1001/71", parentId: "1001" },
        { type: "thread", externalId: "72", title: "Tealbrick / #announcements / private", url: "https://discord.com/channels/1001/72", parentId: "1001" },
      ],
    });
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${API}/users/@me/guilds`,
      `GET ${API}/guilds/1001/channels`,
      `GET ${API}/guilds/1001/threads/active`,
      `GET ${API}/guilds/1002/channels`,
    ]);
  });

  it("still lists the channels, with a note, when the active threads cannot be read", async () => {
    const { provider } = make([
      jsonResponse(200, [{ id: "1001", name: "Tealbrick" }]),
      jsonResponse(200, [{ id: "1", type: 0, name: "general" }]),
      jsonResponse(403, { message: "Missing Access", code: 50001 }),
    ]);
    const result = await provider.discover(TOKEN);
    expect(result).toEqual({
      ok: true,
      destinations: [{ type: "channel", externalId: "1", title: "Tealbrick / #general", url: "https://discord.com/channels/1001/1", parentId: "1001" }],
      notes: ["Active threads of Tealbrick could not be listed."],
    });
  });

  it("sanitises names and maps failures", async () => {
    const { provider } = make([
      jsonResponse(200, [{ id: "1", name: "G\u0000" }]),
      jsonResponse(200, [{ id: "9", type: 0, name: `evil‮${"y".repeat(500)}` }]),
      jsonResponse(200, { threads: [] }),
      jsonResponse(401, {}),
      jsonResponse(200, [{ id: "1", name: "G" }]),
      jsonResponse(500, {}),
    ]);
    const first = await provider.discover(TOKEN);
    expect(first.ok).toBe(true);
    if (first.ok) {
      const title = first.destinations[0]!.title;
      expect(Array.from(title).length).toBeLessThanOrEqual(128);
      expect(/[\u0000‮]/u.test(title)).toBe(false);
    }
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
    await expect(provider.discover(null)).resolves.toEqual({ ok: false, reason: "credential_missing" });
  });
});

describe("discord send: request shape", () => {
  it("posts JSON with allowed_mentions.parse empty and returns the receipt url", async () => {
    const { provider, fake } = make([okMessage("3003")]);
    const result = await provider.send(TOKEN, channel, { text: "hello @everyone @here <@&5> <@6>" });
    expect(result).toEqual({ status: "sent", resultIds: ["3003"], resultUrls: ["https://discord.com/channels/1001/2002/3003"] });
    const request = fake.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${API}/channels/2002/messages`);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers.authorization === `Bot ${TOKEN}`).toBe(true);
    expect(request.headers["user-agent"]).toBe("DiscordBot (https://tealbrick.com, 1)");
    expect(JSON.parse(request.body as string)).toEqual({
      content: "hello @everyone @here <@&5> <@6>",
      allowed_mentions: { parse: [] },
    });
  });

  it("sends attachments as multipart with payload_json (allowed_mentions still present) and files[n]", async () => {
    const { provider, fake } = make([okMessage("3004")]);
    const files = [attachment("pic.png", "image/png"), attachment("doc.pdf", "application/pdf")];
    const result = await provider.send(TOKEN, channel, { text: "with files", attachments: files });
    expect(result.status).toBe("sent");
    const form = fake.requests[0]!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(form.get("payload_json") as string)).toEqual({
      content: "with files",
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: "pic.png" }, { id: 1, filename: "doc.pdf" }],
    });
    const first = form.get("files[0]") as File;
    expect(first.name).toBe("pic.png");
    expect(first.type).toBe("image/png");
    expect(await first.text()).toBe("pic.png");
    expect((form.get("files[1]") as File).name).toBe("doc.pdf");
  });

  it("omits content when only a file is sent", async () => {
    const { provider, fake } = make([okMessage("3005")]);
    await provider.send(TOKEN, channel, { text: "", attachments: [attachment("pic.png", "image/png")] });
    const payload = JSON.parse(((fake.requests[0]!.body as FormData).get("payload_json")) as string);
    expect(payload).not.toHaveProperty("content");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("omits the url when the guild is unknown", async () => {
    const { provider } = make([okMessage("3006")]);
    const result = await provider.send(TOKEN, { type: "channel", externalId: "2002", title: "x" }, { text: "hi" });
    expect(result).toEqual({ status: "sent", resultIds: ["3006"], resultUrls: [] });
  });
});

describe("discord send: refusals without any request", () => {
  it("refuses text over 2000 and accepts exactly 2000", async () => {
    const { provider, fake } = make([okMessage("1")]);
    const refused = await provider.send(TOKEN, channel, { text: "x".repeat(2001) });
    expect(refused).toMatchObject({ status: "failed", errorCode: "channel_text_too_long", resultIds: [], resultUrls: [] });
    expect(fake.requests).toHaveLength(0);
    expect((await provider.send(TOKEN, channel, { text: "x".repeat(2000) })).status).toBe("sent");
  });

  it("refuses bad files, ids, empty messages and credentials", async () => {
    const { provider, fake } = make();
    const png = attachment("p.png", "image/png");
    const code = async (message: Parameters<typeof provider.send>[2], destination = channel, credential: string | null = TOKEN) =>
      (await provider.send(credential, destination, message)).errorCode;
    expect(await code({ text: "x", attachments: Array.from({ length: 5 }, () => png) })).toBe("channel_too_many_files");
    expect(await code({ text: "x", attachments: [attachment("a.exe", "application/x-msdownload")] })).toBe("channel_file_type_not_allowed");
    expect(await code({ text: "x", attachments: [{ ...png, sha256: "f".repeat(64) }] })).toBe("channel_file_digest_mismatch");
    expect(await code({ text: "" })).toBe("channel_message_empty");
    expect(await code({ text: "x" }, { ...channel, externalId: "2002/../x" })).toBe("channel_destination_invalid");
    expect(await code({ text: "x" }, channel, null)).toBe("credential_missing");
    expect(await code({ text: "x" }, channel, "bad\ntoken")).toBe("credential_invalid");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("discord send: failures", () => {
  it("honours a 429 retry_after (JSON body, seconds) once, then succeeds", async () => {
    const { provider, fake, clock } = make([jsonResponse(429, { message: "You are being rate limited.", retry_after: 1.5, global: false }), okMessage("7")]);
    const result = await provider.send(TOKEN, channel, { text: "hi" });
    expect(result.status).toBe("sent");
    expect(fake.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([1500]);
  });

  it("uses the Retry-After header when the body has none", async () => {
    const { provider, clock } = make([jsonResponse(429, {}, { "retry-after": "2" }), okMessage("8")]);
    expect((await provider.send(TOKEN, channel, { text: "hi" })).status).toBe("sent");
    expect(clock.sleeps).toEqual([2000]);
  });

  it("fails with provider_rate_limited after the second 429 or when retry_after is over 30 s", async () => {
    const twice = make([jsonResponse(429, { retry_after: 1 }), jsonResponse(429, { retry_after: 1 })]);
    expect(await twice.provider.send(TOKEN, channel, { text: "hi" })).toMatchObject({ status: "failed", errorCode: "provider_rate_limited" });
    expect(twice.fake.requests).toHaveLength(2);
    const long = make([jsonResponse(429, { retry_after: 120 })]);
    expect(await long.provider.send(TOKEN, channel, { text: "hi" })).toMatchObject({ status: "failed", errorCode: "provider_rate_limited" });
    expect(long.fake.requests).toHaveLength(1);
    expect(long.clock.sleeps).toEqual([]);
  });

  it("returns uncertain / provider_timeout on a timeout", async () => {
    const { provider } = make(["hang"], { timeoutMs: 15 });
    expect(await provider.send(TOKEN, channel, { text: "hi" })).toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
  });

  it("classifies HTTP statuses with token-free detail", async () => {
    const { provider } = make([
      jsonResponse(401, { message: "401: Unauthorized", code: 0 }),
      jsonResponse(403, { message: "Missing Permissions", code: 50013 }),
      jsonResponse(404, { message: "Unknown Channel", code: 10003 }),
      jsonResponse(400, { message: `Cannot send an empty message ${TOKEN}`, code: 50006 }),
      jsonResponse(500, {}),
      jsonResponse(503, {}),
      jsonResponse(522, {}),
    ]);
    const run = () => provider.send(TOKEN, channel, { text: "hi" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "credential_invalid" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "provider_forbidden", detail: "Missing Permissions (code 50013)" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "provider_not_found", detail: "Unknown Channel (code 10003)" });
    const rejected = await run();
    expect(rejected).toMatchObject({ status: "failed", errorCode: "provider_rejected" });
    noToken(rejected);
    expect(await run()).toMatchObject({ status: "uncertain", errorCode: "provider_unexpected_status" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(await run()).toMatchObject({ status: "uncertain", errorCode: "provider_unexpected_status" });
  });

  it("treats an unreadable success reply as uncertain", async () => {
    const { provider } = make([new Response("nope", { status: 200 })]);
    expect(await provider.send(TOKEN, channel, { text: "hi" })).toMatchObject({ status: "uncertain", errorCode: "provider_bad_response" });
  });
});

describe("discord local rate limiting", () => {
  it("allows a burst of 5 in one channel, then waits for a slot", async () => {
    const { provider, clock } = make(Array.from({ length: 6 }, (_, i) => okMessage(String(100 + i))));
    for (let i = 0; i < 6; i++) {
      await provider.send(TOKEN, channel, { text: `m${i}` });
    }
    expect(clock.sleeps).toEqual([1000]);
  });
});

describe("discord never leaks the token", () => {
  it("keeps the token out of every returned value", async () => {
    const echo = (status: number) => jsonResponse(status, { message: `bad ${TOKEN} Bot ${TOKEN}`, code: 1 });
    const { provider } = make([
      echo(400),
      echo(403),
      echo(404),
      echo(401),
      new Error(`fetch failed ${TOKEN}`),
      new Error(`fetch failed ${TOKEN}`),
      new Error(`fetch failed ${TOKEN}`),
      () => {
        throw new Error(`explode ${TOKEN}`);
      },
    ]);
    const results: unknown[] = [];
    results.push(await provider.send(TOKEN, channel, { text: "a" }));
    results.push(await provider.send(TOKEN, channel, { text: "a" }));
    results.push(await provider.send(TOKEN, channel, { text: "a" }));
    results.push(await provider.verify(TOKEN));
    results.push(await provider.send(TOKEN, channel, { text: "a" }));
    results.push(await provider.verify(TOKEN));
    results.push(await provider.discover(TOKEN));
    results.push(await provider.send(TOKEN, channel, { text: "a" }));
    for (const result of results) {
      noToken(result);
    }
    expect((results[0] as { detail: string }).detail).toContain("[redacted]");
  });
});

describe("discord send is one request", () => {
  it("posts text and several attachments in one request, so a send can never be partly delivered", async () => {
    const { provider, fake } = make([okMessage("3010")]);
    const result = await provider.send(TOKEN, channel, {
      text: "hello",
      attachments: [attachment("a.png", "image/png"), attachment("b.pdf", "application/pdf")],
    });
    expect(result).toMatchObject({ status: "sent", resultIds: ["3010"] });
    expect(result).not.toHaveProperty("partial");
    expect(fake.requests).toHaveLength(1);
  });
});

describe("discord native voice message", () => {
  // 2 s of audio: quiet first half, loud second half.
  const ogg = () => buildOggOpus([...Array.from({ length: 50 }, () => 3), ...Array.from({ length: 50 }, () => 120)]);
  const voice = (transcript?: string, bytes: Uint8Array = ogg()) =>
    attachment("note.ogg", "audio/ogg", bytes, { kind: "voice", ...(transcript !== undefined ? { transcript } : {}) });
  const decodeWaveform = (value: string) => Uint8Array.from(Buffer.from(value, "base64"));

  it("posts one OGG attachment with IS_VOICE_MESSAGE, duration and waveform, and NO content", async () => {
    const { provider, fake } = make([okMessage("4001")]);
    const result = await provider.send(TOKEN, channel, { text: "", attachments: [voice()] });
    expect(result).toEqual({ status: "sent", resultIds: ["4001"], resultUrls: ["https://discord.com/channels/1001/2002/4001"] });
    expect(result).not.toHaveProperty("fallback");
    expect(fake.requests).toHaveLength(1);
    const form = fake.requests[0]!.body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string);
    expect(payload.flags).toBe(8192);
    expect(DISCORD_VOICE_MESSAGE_FLAG).toBe(1 << 13);
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("embeds");
    expect(payload.attachments).toHaveLength(1);
    const [meta] = payload.attachments;
    expect(meta).toMatchObject({ id: 0, filename: "voice-message.ogg" });
    // 100 packets x 960 samples = 96000, minus the 312 sample pre-skip, at 48 kHz.
    expect(meta.duration_secs).toBeCloseTo((96_000 - 312) / 48_000, 2);
    const waveform = decodeWaveform(meta.waveform);
    expect(waveform.length).toBeGreaterThan(0);
    expect(waveform.length).toBeLessThanOrEqual(256);
    expect(Math.max(...waveform)).toBe(255);
    expect(waveform[0]).toBe(0); // the quiet half is silence-sized packets
    expect(waveform[waveform.length - 1]).toBe(255);
    const file = form.get("files[0]") as File;
    expect(file.type).toBe("audio/ogg");
    expect(form.get("files[1]")).toBeNull();
  });

  it("sends the text and transcript as a SECOND message replying to the voice message", async () => {
    const { provider, fake } = make([okMessage("4001"), okMessage("4002")]);
    const result = await provider.send(TOKEN, channel, { text: "listen @everyone", attachments: [voice("hello there")] });
    expect(result).toEqual({
      status: "sent",
      resultIds: ["4001", "4002"],
      resultUrls: ["https://discord.com/channels/1001/2002/4001", "https://discord.com/channels/1001/2002/4002"],
    });
    expect(fake.requests).toHaveLength(2);
    expect(JSON.parse((fake.requests[0]!.body as FormData).get("payload_json") as string)).not.toHaveProperty("content");
    expect(fake.requests[1]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(fake.requests[1]!.body as string)).toEqual({
      content: "listen @everyone\nTranscript: hello there",
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: "4001", fail_if_not_exists: true },
    });
  });

  it("is uncertain and partial when the transcript message fails after the voice message was posted", async () => {
    const { provider } = make([okMessage("4001"), jsonResponse(400, { message: `bad ${TOKEN}`, code: 50035 })]);
    const result = await provider.send(TOKEN, channel, { text: "", attachments: [voice("hi")] });
    expect(result).toMatchObject({ status: "uncertain", partial: true, resultIds: ["4001"], errorCode: "provider_rejected" });
    expect(result.detail).toContain("partial delivery");
    noToken(result);
  });

  it("fails cleanly (not partial) when the voice message itself fails", async () => {
    const { provider, fake } = make([jsonResponse(403, { message: "Missing Permissions", code: 50013 })]);
    const result = await provider.send(TOKEN, channel, { text: "x", attachments: [voice("hi")] });
    expect(result).toMatchObject({ status: "failed", errorCode: "provider_forbidden", resultIds: [] });
    expect(result).not.toHaveProperty("partial");
    expect(fake.requests).toHaveLength(1);
  });

  it("reserves both messages at once, so a local limit never cuts the pair", async () => {
    const replies = Array.from({ length: 10 }, (_, i) => okMessage(String(500 + i)));
    const { provider, clock } = make(replies);
    for (let i = 0; i < 4; i++) await provider.send(TOKEN, channel, { text: `m${i}` });
    await provider.send(TOKEN, channel, { text: "", attachments: [voice("hi")] });
    // 4 tokens used, 1 left: the 2-message plan waits for the second token before the first request.
    expect(clock.sleeps).toEqual([1000]);
  });

  it("refuses before any request: other attachments, a bad OGG, a wrong type, too large, a long transcript", async () => {
    const { provider, fake } = make();
    const code = async (attachments: ReturnType<typeof attachment>[], text = "x") => (await provider.send(TOKEN, channel, { text, attachments })).errorCode;
    expect(await code([voice(), attachment("p.png", "image/png")])).toBe("channel_voice_alone");
    expect(await code([attachment("n.ogg", "audio/ogg", "OggS but not really", { kind: "voice" })])).toBe("channel_voice_invalid");
    expect(await code([attachment("n.mp3", "audio/mpeg", "x", { kind: "voice" })])).toBe("channel_file_type_not_allowed");
    expect(await code([voice(undefined, new Uint8Array(10 * MiB + 1))])).toBe("channel_file_too_large");
    expect(await code([voice("t".repeat(1001))])).toBe("channel_transcript_too_long");
    expect(await code([voice("tt")], "a".repeat(2000))).toBe("channel_text_too_long");
    expect(fake.requests).toHaveLength(0);
  });

  it("buildDiscordVoicePayload is pure and deterministic: the digest input the route needs", () => {
    const input = { attachment: voice("hello"), text: "note" };
    const first = buildDiscordVoicePayload(input);
    const second = buildDiscordVoicePayload(input);
    expect(first.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.payload.waveform).toBe(second.payload.waveform);
    expect(first.payload.durationSecs).toBe(second.payload.durationSecs);
    expect(first.payload.voice.flags).toBe(8192);
    expect(first.payload.voice.attachments[0]).toMatchObject({ duration_secs: first.payload.durationSecs, waveform: first.payload.waveform });
    expect(first.payload.followUp).toEqual({ content: "note\nTranscript: hello", allowed_mentions: { parse: [], replied_user: false } });
    expect(buildDiscordVoicePayload({ attachment: voice() }).ok && buildDiscordVoicePayload({ attachment: voice() })).toMatchObject({ payload: { voice: { flags: 8192 } } });
    expect((buildDiscordVoicePayload({ attachment: voice() }) as { payload: object }).payload).not.toHaveProperty("followUp");
    expect(buildDiscordVoicePayload({ attachment: { ...voice(), sha256: "0".repeat(64) } })).toMatchObject({ ok: false, error: { errorCode: "channel_file_digest_mismatch" } });
    expect(buildDiscordVoicePayload({ attachment: voice(), replyTo: "x" })).toMatchObject({ ok: false, error: { errorCode: "channel_reply_invalid" } });
  });

  it("puts the reply reference on the voice message and mentions in the second message", async () => {
    const { provider, fake } = make([okMessage("4001"), okMessage("4002")]);
    await provider.send(TOKEN, channel, { text: "", attachments: [voice()], replyTo: "3999", mentions: [{ userId: "77" }] });
    const first = JSON.parse((fake.requests[0]!.body as FormData).get("payload_json") as string);
    expect(first.message_reference).toEqual({ message_id: "3999", fail_if_not_exists: true });
    expect(JSON.parse(fake.requests[1]!.body as string)).toMatchObject({ content: "<@77>", allowed_mentions: { parse: [], users: ["77"], replied_user: false } });
  });
});

describe("ogg/opus reader", () => {
  it("reads the duration from the last granule minus the pre-skip and the packet sizes", () => {
    const read = readOggOpus(buildOggOpus(Array.from({ length: 120 }, () => 10), { preSkip: 0 }));
    expect(read).toMatchObject({ ok: true, info: { durationSecs: 2.4, channels: 1 } });
    if (read.ok) expect(read.info.packets).toHaveLength(120);
  });

  it("never changes its input, a Node Buffer included", () => {
    const bytes = Buffer.from(buildOggOpus([10, 20, 30]));
    const before = Buffer.from(bytes);
    expect(readOggOpus(bytes).ok).toBe(true);
    expect(bytes.equals(before)).toBe(true);
  });

  it("refuses a bad checksum, a non-Ogg file, missing headers and a zero duration", () => {
    const good = buildOggOpus([10, 10, 10]);
    const flipped = Uint8Array.from(good);
    flipped[flipped.length - 1] ^= 0xff;
    expect(readOggOpus(flipped)).toMatchObject({ ok: false, reason: "bad Ogg page checksum" });
    expect(readOggOpus(new TextEncoder().encode("RIFF....WAVE"))).toMatchObject({ ok: false });
    expect(readOggOpus(new Uint8Array(0))).toMatchObject({ ok: false });
    expect(readOggOpus(buildOggOpus([10], { lastGranule: 100n }))).toMatchObject({ ok: false, reason: "no usable granule position" });
    expect(readOggOpus(good.slice(0, good.length - 3))).toMatchObject({ ok: false, reason: "truncated Ogg page" });
  });

  it("caps the waveform at 256 points for a long file", () => {
    // 60 s of 20 ms packets.
    const built = buildDiscordVoicePayload({ attachment: attachment("long.ogg", "audio/ogg", buildOggOpus(Array.from({ length: 3000 }, (_, i) => 3 + (i % 50))), { kind: "voice" }) });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(Buffer.from(built.payload.waveform, "base64").length).toBe(256);
      expect(built.payload.durationSecs).toBeCloseTo(60, 1);
    }
  });
});

describe("discord mentions, replies and threads", () => {
  it("pings only listed users, puts unlisted listed ids first, and never parses broadcasts", async () => {
    const { provider, fake } = make([okMessage("1")]);
    await provider.send(TOKEN, channel, { text: "hi <@55> and <@66> @everyone", mentions: [{ userId: "55" }, { userId: "77" }] });
    expect(JSON.parse(fake.requests[0]!.body as string)).toEqual({
      content: "<@77> hi <@55> and <@66> @everyone",
      allowed_mentions: { parse: [], users: ["55", "77"] },
    });
  });

  it("refuses bad mentions before any request", async () => {
    const { provider, fake } = make();
    expect((await provider.send(TOKEN, channel, { text: "x", mentions: [{ userId: "everyone" }] })).errorCode).toBe("channel_mention_invalid");
    expect((await provider.send(TOKEN, channel, { text: "x", mentions: Array.from({ length: 21 }, (_, i) => ({ userId: String(i + 1) })) })).errorCode).toBe("channel_mention_invalid");
    expect(renderDiscordContent("x".repeat(1999), [{ userId: "12345" }])).toMatchObject({ ok: false, error: { errorCode: "channel_text_too_long" } });
    expect(fake.requests).toHaveLength(0);
  });

  it("replies with message_reference (fail_if_not_exists) and does not ping the replied-to author", async () => {
    const { provider, fake } = make([okMessage("2")]);
    await provider.send(TOKEN, channel, { text: "answer", replyTo: "1999" });
    expect(JSON.parse(fake.requests[0]!.body as string)).toEqual({
      content: "answer",
      allowed_mentions: { parse: [], replied_user: false },
      message_reference: { message_id: "1999", fail_if_not_exists: true },
    });
    expect((await provider.send(TOKEN, channel, { text: "x", replyTo: "abc" })).errorCode).toBe("channel_reply_invalid");
    expect(fake.requests).toHaveLength(1);
  });

  it("posts into a thread destination by its channel id, with a jump link through the guild", async () => {
    const { provider, fake } = make([okMessage("3")]);
    const thread = { type: "thread" as const, externalId: "71", title: "t", parentId: "1001" };
    const result = await provider.send(TOKEN, thread, { text: "in thread" });
    expect(fake.requests[0]!.url).toBe(`${API}/channels/71/messages`);
    expect(result.resultUrls).toEqual(["https://discord.com/channels/1001/71/3"]);
  });

  it("refuses a markup it does not declare", async () => {
    const { provider, fake } = make();
    expect((await provider.send(TOKEN, channel, { text: "x", markup: "markdown-v2" })).errorCode).toBe("channel_capability_unavailable");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("discord polls", () => {
  it("sends the poll object with question, answers, duration and multiselect next to the content", async () => {
    const { provider, fake } = make([okMessage("9")]);
    const result = await provider.send(TOKEN, channel, { text: "Vote please", poll: { question: "Lunch?", options: ["Pizza", "Sushi"], allowsMultiple: true, durationHours: 48 } });
    expect(result.status).toBe("sent");
    expect(JSON.parse(fake.requests[0]!.body as string)).toEqual({
      content: "Vote please",
      allowed_mentions: { parse: [] },
      poll: { question: { text: "Lunch?" }, answers: [{ poll_media: { text: "Pizza" } }, { poll_media: { text: "Sushi" } }], duration: 48, allow_multiselect: true, layout_type: 1 },
    });
  });

  it("defaults the duration to 24 hours and allows an empty text", async () => {
    const { provider, fake } = make([okMessage("9")]);
    await provider.send(TOKEN, channel, { text: "", poll: { question: "Q", options: ["only one"] } });
    const body = JSON.parse(fake.requests[0]!.body as string);
    expect(body).not.toHaveProperty("content");
    expect(body.poll).toMatchObject({ duration: 24, allow_multiselect: false });
  });

  it("validates against Discord's limits before any request", async () => {
    const { provider, fake } = make();
    const code = async (poll: unknown, extra: Record<string, unknown> = {}) =>
      (await provider.send(TOKEN, channel, { text: "x", poll: poll as never, ...extra })).errorCode;
    expect(await code({ question: "q".repeat(301), options: ["a"] })).toBe("channel_poll_invalid");
    expect(await code({ question: "q", options: [] })).toBe("channel_poll_invalid");
    expect(await code({ question: "q", options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).toBe("channel_poll_invalid");
    expect(await code({ question: "q", options: ["a".repeat(56)] })).toBe("channel_poll_invalid");
    expect(await code({ question: "q", options: ["a", "A"] })).toBe("channel_poll_invalid");
    expect(await code({ question: "two\nlines", options: ["a"] })).toBe("channel_poll_invalid");
    expect(await code({ question: "q", options: ["a"], durationHours: 769 })).toBe("channel_poll_invalid");
    expect(await code({ question: "q", options: ["a"], durationHours: 0 })).toBe("channel_poll_invalid");
    expect(await code({ question: "q", options: ["a"] }, { attachments: [attachment("p.png", "image/png")] })).toBe("channel_poll_invalid");
    expect(fake.requests).toHaveLength(0);
    fake.queue(okMessage("10"));
    expect(await code({ question: "q".repeat(300), options: Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(55, "x")), durationHours: 768 })).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
  });
});

describe("discord reactions, edits and deletes", () => {
  const ok204 = () => new Response(null, { status: 204 });

  it("PUTs and DELETEs the bot's own reaction with a URL-encoded emoji", async () => {
    const { provider, fake } = make([ok204(), ok204(), ok204()]);
    await expect(provider.react!(TOKEN, channel, "3003", "👍")).resolves.toEqual({ status: "sent" });
    await expect(provider.react!(TOKEN, channel, "3003", "👍", { remove: true })).resolves.toEqual({ status: "sent" });
    await expect(provider.react!(TOKEN, channel, "3003", "<:brick:123456>")).resolves.toEqual({ status: "sent" });
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PUT ${API}/channels/2002/messages/3003/reactions/%F0%9F%91%8D/@me`,
      `DELETE ${API}/channels/2002/messages/3003/reactions/%F0%9F%91%8D/@me`,
      `PUT ${API}/channels/2002/messages/3003/reactions/brick%3A123456/@me`,
    ]);
  });

  it("encodes emoji paths and refuses what is not an emoji", async () => {
    expect(discordReactionPath("1️⃣")).toBe(encodeURIComponent("1️⃣"));
    expect(discordReactionPath("brick:123")).toBe("brick%3A123");
    expect(discordReactionPath("<a:dance:99>")).toBe("dance%3A99");
    expect(discordReactionPath("abc:12")).toBe("abc%3A12");
    for (const bad of ["", "thumbsup", "../x", "a b", "👍/../"]) expect(discordReactionPath(bad), bad).toBeUndefined();
    const { provider, fake } = make();
    expect(await provider.react!(TOKEN, channel, "3003", "../../guilds")).toMatchObject({ status: "failed", errorCode: "channel_reaction_invalid" });
    expect(await provider.react!(TOKEN, channel, "x/../1", "👍")).toMatchObject({ status: "failed", errorCode: "channel_message_id_invalid" });
    expect(await provider.react!(null, channel, "3003", "👍")).toMatchObject({ status: "failed", errorCode: "credential_missing" });
    expect(fake.requests).toHaveLength(0);
  });

  it("classifies reaction failures without the token", async () => {
    const { provider } = make([jsonResponse(400, { message: `Unknown Emoji ${TOKEN}`, code: 10014 }), "hang"], { timeoutMs: 15 });
    const rejected = await provider.react!(TOKEN, channel, "3003", "👍");
    expect(rejected).toMatchObject({ status: "failed", errorCode: "provider_rejected" });
    noToken(rejected);
    expect(await provider.react!(TOKEN, channel, "3003", "👍")).toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
  });

  it("PATCHes its own message with allowed_mentions.parse empty", async () => {
    const { provider, fake } = make([jsonResponse(200, { id: "3003", channel_id: "2002" })]);
    const result = await provider.edit!(TOKEN, channel, "3003", { text: "fixed @everyone", mentions: [{ userId: "55" }] });
    expect(result).toEqual({ status: "sent", resultIds: ["3003"], resultUrls: ["https://discord.com/channels/1001/2002/3003"] });
    expect(fake.requests[0]!.method).toBe("PATCH");
    expect(fake.requests[0]!.url).toBe(`${API}/channels/2002/messages/3003`);
    expect(JSON.parse(fake.requests[0]!.body as string)).toEqual({ content: "<@55> fixed @everyone", allowed_mentions: { parse: [], users: ["55"] } });
  });

  it("refuses an empty or long edit and classifies edit failures", async () => {
    const { provider, fake } = make([jsonResponse(403, { message: "Cannot edit a message authored by another user", code: 50005 }), jsonResponse(502, {})]);
    expect((await provider.edit!(TOKEN, channel, "3003", { text: " " })).errorCode).toBe("channel_message_empty");
    expect((await provider.edit!(TOKEN, channel, "3003", { text: "x".repeat(2001) })).errorCode).toBe("channel_text_too_long");
    expect(fake.requests).toHaveLength(0);
    expect(await provider.edit!(TOKEN, channel, "3003", { text: "x" })).toMatchObject({ status: "failed", errorCode: "provider_forbidden" });
    expect(await provider.edit!(TOKEN, channel, "3003", { text: "x" })).toMatchObject({ status: "uncertain", errorCode: "provider_unexpected_status" });
  });

  it("DELETEs its own message", async () => {
    const { provider, fake } = make([ok204(), jsonResponse(404, { message: "Unknown Message", code: 10008 })]);
    await expect(provider.remove!(TOKEN, channel, "3003")).resolves.toEqual({ status: "sent" });
    expect(`${fake.requests[0]!.method} ${fake.requests[0]!.url}`).toBe(`DELETE ${API}/channels/2002/messages/3003`);
    expect(await provider.remove!(TOKEN, channel, "3003")).toMatchObject({ status: "failed", errorCode: "provider_not_found" });
  });
});

describe("discord direct messages", () => {
  const member = (id: string, username: string, extra: Record<string, unknown> = {}) => ({ user: { id, username, ...extra }, ...("nick" in extra ? { nick: extra.nick } : {}) });

  it("finds exactly one member by handle with guild member search (limit 5)", async () => {
    const { provider, fake } = make([
      jsonResponse(200, [{ id: "1001", name: "A" }, { id: "1002", name: "B" }]),
      jsonResponse(200, [member("55", "martin", { global_name: "Martin A" }), member("56", "martina")]),
      jsonResponse(200, [member("55", "martin")]),
    ]);
    await expect(provider.findPerson!(TOKEN, { handle: "@Martin" })).resolves.toEqual({ ok: true, userId: "55", displayName: "Martin A" });
    expect(fake.requests.map((r) => r.url)).toEqual([
      `${API}/users/@me/guilds`,
      `${API}/guilds/1001/members/search?query=Martin&limit=5`,
      `${API}/guilds/1002/members/search?query=Martin&limit=5`,
    ]);
  });

  it("answers not_found, ambiguous, or a refusal, and never a list", async () => {
    const guilds = jsonResponse(200, [{ id: "1001", name: "A" }]);
    const { provider, fake } = make([
      guilds,
      jsonResponse(200, [member("56", "martina")]),
      jsonResponse(200, [{ id: "1001", name: "A" }]),
      jsonResponse(200, [member("55", "sam"), member("57", "sammy", { nick: "sam" })]),
      jsonResponse(200, [{ id: "1001", name: "A" }]),
      jsonResponse(200, [member("58", "bot", { bot: true })]),
    ]);
    expect(await provider.findPerson!(TOKEN, { handle: "martin" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await provider.findPerson!(TOKEN, { handle: "sam" })).toMatchObject({ ok: false, reason: "ambiguous", errorCode: "person_ambiguous" });
    expect(await provider.findPerson!(TOKEN, { handle: "bot" })).toMatchObject({ ok: false, reason: "not_found" });
    const requests = fake.requests.length;
    expect(await provider.findPerson!(TOKEN, { email: "a@b.co" })).toMatchObject({ ok: false, reason: "failed", errorCode: "person_query_invalid" });
    expect(await provider.findPerson!(TOKEN, { handle: "a/b?c" })).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    expect(fake.requests).toHaveLength(requests);
  });

  it("opens a DM channel by user id and returns a person destination", async () => {
    const { provider, fake } = make([jsonResponse(200, { id: "888", type: 1, recipients: [{ id: "55", username: "martin", global_name: "Martin A" }] }), okMessage("9")]);
    const opened = await provider.openDirect!(TOKEN, "55");
    expect(opened).toEqual({ ok: true, destination: { type: "person", externalId: "888", title: "Direct message: Martin A", personId: "55" } });
    expect(fake.requests[0]!.url).toBe(`${API}/users/@me/channels`);
    expect(JSON.parse(fake.requests[0]!.body as string)).toEqual({ recipient_id: "55" });
    if (opened.ok) {
      const sent = await provider.send(TOKEN, opened.destination, { text: "hi" });
      expect(sent.resultUrls).toEqual(["https://discord.com/channels/@me/888/9"]);
    }
  });

  it("refuses a bad user id and classifies failures without the token", async () => {
    const { provider, fake } = make([jsonResponse(403, { message: `Cannot send messages to this user ${TOKEN}`, code: 50007 }), jsonResponse(200, { id: "1", type: 0 })]);
    expect(await provider.openDirect!(TOKEN, "everyone")).toMatchObject({ ok: false, errorCode: "channel_person_invalid" });
    expect(fake.requests).toHaveLength(0);
    const forbidden = await provider.openDirect!(TOKEN, "55");
    expect(forbidden).toMatchObject({ ok: false, errorCode: "provider_forbidden" });
    noToken(forbidden);
    expect(await provider.openDirect!(TOKEN, "55")).toMatchObject({ ok: false, errorCode: "provider_bad_response" });
  });
});

describe("discord inbound MESSAGE_CREATE parsing", () => {
  const dispatch = (d: Record<string, unknown>) => ({ op: 0, t: "MESSAGE_CREATE", s: 1, d });
  const base = { id: "900", channel_id: "2002", guild_id: "1001", type: 0, content: "hello", author: { id: "55", username: "martin", global_name: "Martin A" }, attachments: [] };

  it("maps a message (dispatch or bare) into the inbound shape", () => {
    const parsed = parseDiscordMessageCreate(dispatch({ ...base, member: { nick: "Boss" }, attachments: [{ id: "31", filename: "a.pdf", content_type: "application/pdf; x=y", size: 12 }] }));
    expect(parsed).toEqual({
      kind: "message",
      guildId: "1001",
      message: {
        platform: "discord",
        channelId: "2002",
        messageId: "900",
        senderUserId: "55",
        senderDisplay: "Boss",
        text: "hello",
        attachments: [{ id: "31", name: "a.pdf", contentType: "application/pdf", bytes: 12 }],
      },
    });
    expect(parseDiscordMessageCreate(JSON.stringify(base))).toMatchObject({ kind: "message", message: { senderDisplay: "Martin A" } });
    expect(parseDiscordMessageCreate({ ...base, channel_type: 11 })).toMatchObject({ message: { threadId: "2002" } });
  });

  it("ignores bots, webhooks, its own messages, system types, other events and junk; strips control characters", () => {
    expect(parseDiscordMessageCreate({ ...base, author: { id: "1", username: "b", bot: true } })).toEqual({ kind: "ignored", reason: "bot_message" });
    expect(parseDiscordMessageCreate({ ...base, webhook_id: "7" })).toEqual({ kind: "ignored", reason: "bot_message" });
    expect(parseDiscordMessageCreate(base, { botUserId: "55" })).toEqual({ kind: "ignored", reason: "own_message" });
    expect(parseDiscordMessageCreate({ ...base, type: 7 })).toEqual({ kind: "ignored", reason: "unsupported_type" });
    expect(parseDiscordMessageCreate({ op: 0, t: "TYPING_START", d: {} })).toEqual({ kind: "ignored", reason: "unsupported_event" });
    expect(parseDiscordMessageCreate("{nope")).toEqual({ kind: "ignored", reason: "malformed" });
    expect(parseDiscordMessageCreate({ ...base, id: "x" })).toEqual({ kind: "ignored", reason: "malformed" });
    expect(parseDiscordMessageCreate({ ...base, content: "" })).toEqual({ kind: "ignored", reason: "no_content" });
    expect(parseDiscordMessageCreate({ ...base, content: "a\u0000b‮c\nd" })).toMatchObject({ message: { text: "abc\nd" } });
  });
});

describe("applyFallbacks", () => {
  // A provider with a voice fallback (Slack-like). Discord itself now declares native voice.
  const caps = { ...createDiscordProvider().capabilities, voice: { fallback: "audio+transcript" as const, types: ["audio/ogg"], maxBytes: 10 * MiB } };
  const input = () => ({
    text: "post",
    attachments: [
      attachment("a.png", "image/png"),
      attachment("n.ogg", "audio/ogg", new Uint8Array(5), { kind: "voice", transcript: "line one" }),
    ],
  });

  it("is deterministic and does not mutate its input", () => {
    const original = input();
    const snapshot = JSON.stringify(original, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
    const first = applyFallbacks(caps, original);
    const second = applyFallbacks(caps, original);
    expect(JSON.stringify(first, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))).toBe(
      JSON.stringify(second, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v)),
    );
    expect(JSON.stringify(original, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))).toBe(snapshot);
    expect(first).toMatchObject({ text: "post\nTranscript: line one", fallbacks: ["voice→audio+transcript"] });
    if (!("error" in first)) {
      expect(first.attachments.map((a) => a.kind)).toEqual(["image", "audio"]);
      expect(first.attachments[1]).not.toHaveProperty("transcript");
    }
  });

  it("leaves Discord native voice as voice, with its transcript, and names no fallback", () => {
    const outcome = applyFallbacks(createDiscordProvider().capabilities, input());
    expect(outcome).toMatchObject({ text: "post", fallbacks: [] });
    expect((outcome as { attachments: Array<{ kind: string; transcript?: string }> }).attachments[1]).toMatchObject({ kind: "voice", transcript: "line one" });
  });

  it("leaves a post without voice untouched and reports errors as values", () => {
    expect(applyFallbacks(caps, { text: "plain", attachments: [] })).toEqual({ text: "plain", attachments: [], fallbacks: [] });
    expect(applyFallbacks(caps, { text: "x", attachments: [attachment("n.ogg", "audio/ogg", "n", { kind: "voice" })] })).toEqual({
      error: expect.objectContaining({ errorCode: "channel_voice_transcript_required" }),
    });
    expect(applyFallbacks(caps, { text: "x".repeat(2000), attachments: [attachment("n.ogg", "audio/ogg", "n", { kind: "voice", transcript: "a" })] })).toEqual({
      error: expect.objectContaining({ errorCode: "channel_text_too_long" }),
    });
  });

  it("leaves native voice (Telegram) as voice", () => {
    const telegramCaps = createTelegramProvider().capabilities;
    const outcome = applyFallbacks(telegramCaps, { text: "x", attachments: [attachment("n.ogg", "audio/ogg", "n", { kind: "voice" })] });
    expect(outcome).toMatchObject({ text: "x", fallbacks: [] });
    expect((outcome as { attachments: Array<{ kind: string }> }).attachments[0]!.kind).toBe("voice");
  });
});

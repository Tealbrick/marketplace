import { describe, expect, it } from "vitest";
import { createDiscordProvider } from "./discord.js";
import { createTelegramProvider } from "./telegram.js";
import { attachment, createFakeClock, createFakeFetch, jsonResponse, type FakeReply } from "./test-support.js";
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
      mentions: { users: false, broadcast: "suppressed" },
      dm: { open: false, maxMembers: 0 },
      image: { types: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 10 * MiB, albumMax: 4 },
      file: { types: ["application/pdf", "text/plain", "application/zip", "application/octet-stream"], maxBytes: 10 * MiB },
      audio: { types: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 10 * MiB },
      voice: { fallback: "audio+transcript", types: ["audio/ogg"], maxBytes: 10 * MiB },
      video: { types: ["video/mp4"], maxBytes: 10 * MiB },
      thread: { replies: false, topics: false, forum: false },
      reactions: { add: false, remove: false, custom: false },
      buttons: { url: false, callback: false },
      poll: false,
      edit: { own: false },
      delete: { own: false },
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
    expect(capabilityForKind(provider.capabilities, "voice")).toBe("fallback");
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
      jsonResponse(403, { message: "Missing Access", code: 50001 }),
    ]);
    const result = await provider.discover(TOKEN);
    expect(result).toEqual({
      ok: true,
      destinations: [
        { type: "channel", externalId: "1", title: "Tealbrick / #general", url: "https://discord.com/channels/1001/1", parentId: "1001" },
        { type: "channel", externalId: "2", title: "Tealbrick / #announcements", url: "https://discord.com/channels/1001/2", parentId: "1001" },
      ],
    });
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${API}/users/@me/guilds`,
      `GET ${API}/guilds/1001/channels`,
      `GET ${API}/guilds/1002/channels`,
    ]);
  });

  it("sanitises names and maps failures", async () => {
    const { provider } = make([
      jsonResponse(200, [{ id: "1", name: "G\u0000" }]),
      jsonResponse(200, [{ id: "9", type: 0, name: `evil‮${"y".repeat(500)}` }]),
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

describe("discord voice fallback", () => {
  const voice = (transcript?: string, size = 20) =>
    attachment("note.ogg", "audio/ogg", new Uint8Array(size).fill(3), { kind: "voice", ...(transcript !== undefined ? { transcript } : {}) });

  it("sends the OGG as an attachment plus a Transcript line, in one request, and names the fallback", async () => {
    const { provider, fake } = make([okMessage("4001")]);
    const result = await provider.send(TOKEN, channel, { text: "listen", attachments: [voice("hello there")] });
    expect(result).toEqual({
      status: "sent",
      resultIds: ["4001"],
      resultUrls: ["https://discord.com/channels/1001/2002/4001"],
      fallback: "voice→audio+transcript",
    });
    expect(fake.requests).toHaveLength(1);
    const form = fake.requests[0]!.body as FormData;
    expect(JSON.parse(form.get("payload_json") as string)).toEqual({
      content: "listen\nTranscript: hello there",
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: "note.ogg" }],
    });
    const file = form.get("files[0]") as File;
    expect(file.type).toBe("audio/ogg");
    expect(file.size).toBe(20);
  });

  it("uses only the transcript line as content when the text is empty, and still suppresses mentions", async () => {
    const { provider, fake } = make([okMessage("4002")]);
    await provider.send(TOKEN, channel, { text: "  ", attachments: [voice("@everyone hi")] });
    const payload = JSON.parse((fake.requests[0]!.body as FormData).get("payload_json") as string);
    expect(payload.content).toBe("Transcript: @everyone hi");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("requires a transcript for a fallback voice, before any request", async () => {
    const { provider, fake } = make();
    const result = await provider.send(TOKEN, channel, { text: "x", attachments: [voice()] });
    expect(result).toMatchObject({ status: "failed", errorCode: "channel_voice_transcript_required", resultIds: [] });
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a combined text over 2000 before any request and accepts exactly 2000", async () => {
    const { provider, fake } = make([okMessage("4003")]);
    const line = "Transcript: ".length;
    const refused = await provider.send(TOKEN, channel, { text: "a".repeat(2000 - line), attachments: [voice("tt")] });
    expect(refused).toMatchObject({ status: "failed", errorCode: "channel_text_too_long" });
    expect(fake.requests).toHaveLength(0);
    // 1 newline + 12 prefix + 2 transcript = 15 characters added.
    const ok = await provider.send(TOKEN, channel, { text: "a".repeat(2000 - 15), attachments: [voice("tt")] });
    expect(ok.status).toBe("sent");
  });

  it("refuses a transcript over 1000 characters and an OGG over the size cap", async () => {
    const { provider, fake } = make();
    expect((await provider.send(TOKEN, channel, { text: "x", attachments: [voice("t".repeat(1001))] })).errorCode).toBe("channel_transcript_too_long");
    expect((await provider.send(TOKEN, channel, { text: "x", attachments: [voice("ok", 10 * MiB + 1)] })).errorCode).toBe("channel_file_too_large");
    expect(fake.requests).toHaveLength(0);
  });

  it("sends audio, video and files as attachments of the one message without a fallback marker", async () => {
    const { provider, fake } = make([okMessage("4004")]);
    const result = await provider.send(TOKEN, channel, {
      text: "mix",
      attachments: [attachment("a.mp3", "audio/mpeg"), attachment("v.mp4", "video/mp4"), attachment("t.txt", "text/plain"), attachment("g.gif", "image/gif")],
    });
    expect(result.status).toBe("sent");
    expect(result).not.toHaveProperty("fallback");
    expect(fake.requests).toHaveLength(1);
  });

  it("refuses an undeclared kind or a wrong type without any request", async () => {
    const { provider, fake } = make();
    const poll = { ...attachment("p.png", "image/png"), kind: "poll" } as unknown as ReturnType<typeof attachment>;
    expect((await provider.send(TOKEN, channel, { text: "x", attachments: [poll] })).errorCode).toBe("channel_capability_unavailable");
    expect((await provider.send(TOKEN, channel, { text: "x", attachments: [attachment("a.mp3", "audio/mpeg", "a", { kind: "video" })] })).errorCode).toBe("channel_file_type_not_allowed");
    expect(fake.requests).toHaveLength(0);
  });

  it("never leaks the token on a voice send failure", async () => {
    const { provider } = make([jsonResponse(400, { message: `bad ${TOKEN}`, code: 50035 })]);
    const result = await provider.send(TOKEN, channel, { text: "x", attachments: [voice("hi")] });
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("fallback");
    noToken(result);
  });
});

describe("applyFallbacks", () => {
  const caps = createDiscordProvider().capabilities;
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

  it("gives exactly the text the adapter posts", async () => {
    const outcome = applyFallbacks(caps, input());
    expect("error" in outcome).toBe(false);
    const { provider, fake } = make([okMessage("5001")]);
    const result = await provider.send(TOKEN, channel, input());
    const payload = JSON.parse((fake.requests[0]!.body as FormData).get("payload_json") as string);
    expect(payload.content).toBe((outcome as { text: string }).text);
    expect(result.fallback).toBe((outcome as { fallbacks: string[] }).fallbacks.join(","));
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

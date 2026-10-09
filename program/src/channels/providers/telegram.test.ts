import { describe, expect, it } from "vitest";
import { createTelegramProvider, telegramMessageUrl } from "./telegram.js";
import {
  attachment,
  createFakeClock,
  createFakeFetch,
  jsonResponse,
  telegramMethod,
  type FakeReply,
} from "./test-support.js";
import { capabilityForKind } from "./capabilities.js";
import { CHANNEL_CAPABILITIES_VERSION, type ChannelDestination } from "./types.js";

const MiB = 1024 * 1024;

const TOKEN = `1234567:${"AAHfaketokenfaketokenfaketoken12345".slice(0, 35)}`;

function make(replies: FakeReply[] = [], extra: { timeoutMs?: number } = {}) {
  const fake = createFakeFetch(replies);
  const clock = createFakeClock();
  const provider = createTelegramProvider({ fetchImpl: fake.fetchImpl, sleep: clock.sleep, now: clock.now, ...extra });
  return { fake, clock, provider };
}

const okMessage = (id: number, chat: Record<string, unknown> = { id: -1001234567890, type: "supergroup" }) =>
  jsonResponse(200, { ok: true, result: { message_id: id, chat } });

const group: ChannelDestination = { type: "group", externalId: "-1001234567890", title: "Team" };

function noToken(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(TOKEN);
  expect(JSON.stringify(value)).not.toContain(TOKEN.split(":")[1] as string);
}

describe("telegram capabilities", () => {
  it("declares the spec 3.1 vocabulary", () => {
    const { provider } = make();
    expect(provider.id).toBe("telegram");
    expect(provider.capabilities).toEqual({
      channelCapabilities: 1,
      text: { maxChars: 4096, captionMaxChars: 1024 },
      markup: "plain",
      mentions: "suppressed",
      image: { types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 10 * MiB, albumMax: 4 },
      file: { types: ["application/pdf", "text/plain", "application/zip", "application/octet-stream"], maxBytes: 50 * MiB },
      audio: { types: ["audio/mpeg", "audio/mp4"], maxBytes: 50 * MiB },
      voice: { native: true, types: ["audio/ogg"], maxBytes: MiB },
      video: { types: ["video/mp4"], maxBytes: 50 * MiB },
      thread: { topics: true, replies: false },
      reactions: false,
      buttons: { url: false, callback: false },
      poll: false,
      edit: false,
      delete: false,
      schedule: { native: false },
      events: { create: false },
      discover: "updates",
      inbound: "none",
      audience: { count: false },
      limits: { perChatPerSecond: 1, perChatPerMinute: 20, retryAfter: "honoured" },
    });
    expect(CHANNEL_CAPABILITIES_VERSION).toBe(1);
    expect(capabilityForKind(provider.capabilities, "voice")).toEqual({ native: true, types: ["audio/ogg"], maxBytes: MiB });
    expect(capabilityForKind(provider.capabilities, "image")).toMatchObject({ albumMax: 4 });
  });
});

describe("telegram verify", () => {
  it("calls getMe and returns the bot identity", async () => {
    const { provider, fake } = make([jsonResponse(200, { ok: true, result: { id: 777, is_bot: true, username: "tb_bot" } })]);
    await expect(provider.verify(TOKEN)).resolves.toEqual({ ok: true, botId: "777", botUsername: "tb_bot" });
    expect(fake.requests).toHaveLength(1);
    expect(telegramMethod(fake.requests[0]!, TOKEN)).toBe("getMe");
    expect(fake.requests[0]!.method).toBe("POST");
  });

  it("maps failures to reasons without a request when the credential is missing or malformed", async () => {
    const { provider, fake } = make();
    await expect(provider.verify("")).resolves.toEqual({ ok: false, reason: "credential_missing" });
    await expect(provider.verify(undefined)).resolves.toEqual({ ok: false, reason: "credential_missing" });
    await expect(provider.verify("not a token\n")).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [401, "credential_invalid"],
    [404, "credential_invalid"],
    [500, "provider_unavailable"],
    [429, "provider_unavailable"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    const { provider } = make([jsonResponse(status, { ok: false, description: "x" }), jsonResponse(status, { ok: false })]);
    await expect(provider.verify(TOKEN)).resolves.toEqual({ ok: false, reason });
  });

  it("reports provider_unavailable on a network error and never leaks the token", async () => {
    const { provider } = make([new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`)]);
    const result = await provider.verify(TOKEN);
    expect(result).toEqual({ ok: false, reason: "provider_unavailable" });
    noToken(result);
  });
});

describe("telegram discover", () => {
  const chat = (over: Record<string, unknown>) => ({ id: -100111, type: "supergroup", title: "G", ...over });

  it("maps chats from message, edited_message, channel_post and my_chat_member, and skips private chats", async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, chat: { id: 42, type: "private", first_name: "Ann" } } },
      { update_id: 2, message: { message_id: 2, chat: chat({ id: -100111, title: "Public Group", username: "publicgroup" }) } },
      { update_id: 3, edited_message: { message_id: 3, chat: { id: -4455, type: "group", title: "Basic" } } },
      { update_id: 4, channel_post: { message_id: 4, chat: { id: -100222, type: "channel", title: "News", username: "newschan" } } },
      { update_id: 5, my_chat_member: { chat: { id: -100333, type: "channel", title: "Quiet" }, new_chat_member: { status: "administrator" } } },
      { update_id: 6, message: { message_id: 6, chat: chat({ id: -100111, title: "Public Group", username: "publicgroup" }) } },
    ];
    const { provider, fake } = make([jsonResponse(200, { ok: true, result: updates })]);
    const result = await provider.discover(TOKEN);
    expect(result).toEqual({
      ok: true,
      destinations: [
        { type: "group", externalId: "-100111", title: "Public Group", url: "https://t.me/publicgroup" },
        { type: "group", externalId: "-4455", title: "Basic" },
        { type: "channel", externalId: "-100222", title: "News", url: "https://t.me/newschan" },
        { type: "channel", externalId: "-100333", title: "Quiet" },
      ],
    });
    const request = fake.requests[0]!;
    expect(telegramMethod(request, TOKEN)).toBe("getUpdates");
    expect(JSON.parse(request.body as string)).toEqual({ limit: 100, timeout: 0 });
  });

  it("maps forum topics only when the chat is a forum and a thread id is present", async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, message_thread_id: 55, chat: chat({ id: -100500, title: "Forum", is_forum: true }), reply_to_message: { forum_topic_created: { name: "Announcements" } } } },
      { update_id: 2, message: { message_id: 2, message_thread_id: 55, chat: chat({ id: -100500, title: "Forum", is_forum: true }) } },
      { update_id: 3, message: { message_id: 3, message_thread_id: 9, chat: chat({ id: -100600, title: "Plain reply thread" }) } },
    ];
    const { provider } = make([jsonResponse(200, { ok: true, result: updates })]);
    const result = await provider.discover(TOKEN);
    expect(result).toEqual({
      ok: true,
      destinations: [
        { type: "group", externalId: "-100500", title: "Forum" },
        { type: "topic", externalId: "-100500", title: "Forum / Announcements", parentId: "55" },
        { type: "group", externalId: "-100600", title: "Plain reply thread" },
      ],
    });
  });

  it("drops a chat after the bot is removed from it", async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, chat: chat({ id: -100777, title: "Old" }) } },
      { update_id: 2, my_chat_member: { chat: chat({ id: -100777, title: "Old" }), new_chat_member: { status: "kicked" } } },
    ];
    const { provider } = make([jsonResponse(200, { ok: true, result: updates })]);
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: true, destinations: [] });
  });

  it("treats titles as untrusted text: control characters removed, capped at 128", async () => {
    const hostile = `Evil\u0000\u001b[31m‮group\n${"x".repeat(300)}`;
    const { provider } = make([jsonResponse(200, { ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: chat({ title: hostile }) } }] })]);
    const result = await provider.discover(TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const title = result.destinations[0]!.title;
      expect(Array.from(title).length).toBeLessThanOrEqual(128);
      expect(/[\u0000-\u001f‮]/u.test(title)).toBe(false);
      expect(title.startsWith("Evil")).toBe(true);
    }
  });

  it("reports consumer_conflict on HTTP 409 (webhook set or another consumer)", async () => {
    const { provider } = make([jsonResponse(409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" })]);
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "consumer_conflict" });
  });

  it("maps other failures", async () => {
    const { provider } = make([jsonResponse(401, { ok: false }), jsonResponse(502, "bad"), "hang"], { timeoutMs: 10 });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "credential_invalid" });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
    await expect(provider.discover(TOKEN)).resolves.toEqual({ ok: false, reason: "provider_unavailable" });
    await expect(provider.discover(undefined)).resolves.toEqual({ ok: false, reason: "credential_missing" });
  });
});

describe("telegram send: request shape", () => {
  it("sends plain text as sendMessage JSON with no parse_mode and link previews allowed", async () => {
    const { provider, fake } = make([okMessage(11)]);
    const result = await provider.send(TOKEN, group, { text: "hello @everyone https://example.com" });
    expect(result).toEqual({ status: "sent", resultIds: ["11"], resultUrls: ["https://t.me/c/1234567890/11"] });
    const request = fake.requests[0]!;
    expect(telegramMethod(request, TOKEN)).toBe("sendMessage");
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    const body = JSON.parse(request.body as string);
    expect(body).toEqual({ chat_id: "-1001234567890", text: "hello @everyone https://example.com" });
    expect(body).not.toHaveProperty("parse_mode");
    expect(body).not.toHaveProperty("disable_web_page_preview");
    expect(body).not.toHaveProperty("link_preview_options");
  });

  it("passes message_thread_id from parentId for forum topics", async () => {
    const { provider, fake } = make([okMessage(12)]);
    const topic: ChannelDestination = { type: "topic", externalId: "-1001234567890", title: "T", parentId: "55" };
    const result = await provider.send(TOKEN, topic, { text: "hi" });
    expect(JSON.parse(fake.requests[0]!.body as string)).toEqual({ chat_id: "-1001234567890", message_thread_id: 55, text: "hi" });
    expect(result.resultUrls).toEqual(["https://t.me/c/1234567890/55/12"]);
  });

  it("sends one png as sendPhoto multipart with the caption", async () => {
    const { provider, fake } = make([okMessage(13)]);
    const png = attachment("pic.png", "image/png");
    const result = await provider.send(TOKEN, group, { text: "caption", attachments: [png] });
    expect(result.status).toBe("sent");
    const request = fake.requests[0]!;
    expect(telegramMethod(request, TOKEN)).toBe("sendPhoto");
    const form = request.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("-1001234567890");
    expect(form.get("caption")).toBe("caption");
    const photo = form.get("photo") as File;
    expect(photo.name).toBe("pic.png");
    expect(photo.type).toBe("image/png");
    expect(await photo.text()).toBe("pic.png");
  });

  it("sends a pdf as sendDocument and omits an empty caption", async () => {
    const { provider, fake } = make([okMessage(14)]);
    await provider.send(TOKEN, group, { text: "", attachments: [attachment("a.pdf", "application/pdf")] });
    const request = fake.requests[0]!;
    expect(telegramMethod(request, TOKEN)).toBe("sendDocument");
    const form = request.body as FormData;
    expect(form.has("caption")).toBe(false);
    expect((form.get("document") as File).name).toBe("a.pdf");
  });

  it("sends 2-4 photos as one sendMediaGroup with the caption on the first item", async () => {
    const { provider, fake } = make([jsonResponse(200, { ok: true, result: [{ message_id: 21, chat: { id: -1001234567890 } }, { message_id: 22, chat: { id: -1001234567890 } }, { message_id: 23, chat: { id: -1001234567890 } }] })]);
    const files = [attachment("1.png", "image/png"), attachment("2.jpg", "image/jpeg"), attachment("3.webp", "image/webp")];
    const result = await provider.send(TOKEN, group, { text: "album", attachments: files });
    expect(result).toEqual({
      status: "sent",
      resultIds: ["21", "22", "23"],
      resultUrls: ["https://t.me/c/1234567890/21", "https://t.me/c/1234567890/22", "https://t.me/c/1234567890/23"],
    });
    expect(fake.requests).toHaveLength(1);
    const form = fake.requests[0]!.body as FormData;
    expect(telegramMethod(fake.requests[0]!, TOKEN)).toBe("sendMediaGroup");
    expect(JSON.parse(form.get("media") as string)).toEqual([
      { type: "photo", media: "attach://file0", caption: "album" },
      { type: "photo", media: "attach://file1" },
      { type: "photo", media: "attach://file2" },
    ]);
    expect((form.get("file2") as File).name).toBe("3.webp");
  });

  it("splits a mixed photo and document set into two batches because Telegram refuses mixed albums", async () => {
    const { provider, fake } = make([
      jsonResponse(200, { ok: true, result: [{ message_id: 31 }, { message_id: 32 }] }),
      okMessage(33),
    ]);
    const files = [attachment("a.pdf", "application/pdf"), attachment("1.png", "image/png"), attachment("2.png", "image/png")];
    const result = await provider.send(TOKEN, group, { text: "mixed", attachments: files });
    expect(result.resultIds).toEqual(["31", "32", "33"]);
    expect(fake.requests.map((r) => telegramMethod(r, TOKEN))).toEqual(["sendMediaGroup", "sendDocument"]);
    expect(JSON.parse((fake.requests[0]!.body as FormData).get("media") as string)[0].caption).toBe("mixed");
    expect((fake.requests[1]!.body as FormData).has("caption")).toBe(false);
  });

  it("sends media WITHOUT a caption first, then the full text as a separate message, when text is over 1024", async () => {
    const { provider, fake } = make([okMessage(41), okMessage(42)]);
    const text = "t".repeat(3000);
    const result = await provider.send(TOKEN, group, { text, attachments: [attachment("p.png", "image/png")] });
    expect(result).toEqual({ status: "sent", resultIds: ["41", "42"], resultUrls: ["https://t.me/c/1234567890/41", "https://t.me/c/1234567890/42"] });
    expect(fake.requests.map((r) => telegramMethod(r, TOKEN))).toEqual(["sendPhoto", "sendMessage"]);
    expect((fake.requests[0]!.body as FormData).has("caption")).toBe(false);
    expect(JSON.parse(fake.requests[1]!.body as string).text).toBe(text);
  });

  it("keeps a 1024 character text as the caption", async () => {
    const { provider, fake } = make([okMessage(43)]);
    await provider.send(TOKEN, group, { text: "c".repeat(1024), attachments: [attachment("p.png", "image/png")] });
    expect(fake.requests).toHaveLength(1);
    expect(((fake.requests[0]!.body as FormData).get("caption") as string).length).toBe(1024);
  });
});

describe("telegram send: refusals without any request", () => {
  it("refuses text over 4096 and accepts exactly 4096", async () => {
    const { provider, fake } = make([okMessage(50)]);
    const refused = await provider.send(TOKEN, group, { text: "x".repeat(4097) });
    expect(refused).toMatchObject({ status: "failed", errorCode: "channel_text_too_long", resultIds: [], resultUrls: [] });
    expect(fake.requests).toHaveLength(0);
    const ok = await provider.send(TOKEN, group, { text: "x".repeat(4096) });
    expect(ok.status).toBe("sent");
  });

  it("refuses bad attachments, empty messages, bad ids and a missing credential", async () => {
    const { provider, fake } = make();
    const png = attachment("p.png", "image/png");
    const five = Array.from({ length: 5 }, (_, i) => attachment(`${i}.png`, "image/png"));
    const code = async (message: Parameters<typeof provider.send>[2], destination = group, credential: string | null = TOKEN) =>
      (await provider.send(credential, destination, message)).errorCode;
    expect(await code({ text: "x", attachments: five })).toBe("channel_too_many_files");
    expect(await code({ text: "x", attachments: [attachment("a.exe", "application/x-msdownload")] })).toBe("channel_file_type_not_allowed");
    expect(await code({ text: "x", attachments: [{ ...png, sha256: "0".repeat(64) }] })).toBe("channel_file_digest_mismatch");
    const big = attachment("big.pdf", "application/pdf", new Uint8Array(50 * MiB + 1));
    expect(await code({ text: "x", attachments: [big] })).toBe("channel_file_too_large");
    expect(await code({ text: "   " })).toBe("channel_message_empty");
    expect(await code({ text: "x" }, { ...group, externalId: "../../etc" })).toBe("channel_destination_invalid");
    expect(await code({ text: "x" }, { ...group, parentId: "1/2" })).toBe("channel_destination_invalid");
    expect(await code({ text: "x" }, group, null)).toBe("credential_missing");
    expect(await code({ text: "x" }, group, "bad token")).toBe("credential_invalid");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("telegram receipt urls", () => {
  it("covers every chat kind", async () => {
    // public supergroup / channel: username comes from the API reply
    const publicReply = okMessage(7, { id: -100999, type: "channel", username: "newschan" });
    // public chat known only from the stored destination url
    const storedReply = okMessage(8, { id: -100999, type: "channel" });
    const privateSuper = okMessage(9, { id: -1001234567890, type: "supergroup" });
    const basic = okMessage(10, { id: -4455, type: "group" });
    const { provider } = make([publicReply, storedReply, privateSuper, basic]);
    const dest = (over: Partial<ChannelDestination>): ChannelDestination => ({ type: "channel", externalId: "-100999", title: "t", ...over });

    expect((await provider.send(TOKEN, dest({}), { text: "a" })).resultUrls).toEqual(["https://t.me/newschan/7"]);
    expect((await provider.send(TOKEN, dest({ url: "https://t.me/storedname" }), { text: "a" })).resultUrls).toEqual(["https://t.me/storedname/8"]);
    expect((await provider.send(TOKEN, group, { text: "a" })).resultUrls).toEqual(["https://t.me/c/1234567890/9"]);
    const basicResult = await provider.send(TOKEN, dest({ type: "group", externalId: "-4455" }), { text: "a" });
    expect(basicResult).toEqual({ status: "sent", resultIds: ["10"], resultUrls: [] });
  });

  it("builds urls from parts", () => {
    expect(telegramMessageUrl({ chatId: "-100999", username: "abcde", messageId: "5" })).toBe("https://t.me/abcde/5");
    expect(telegramMessageUrl({ chatId: "-100999", username: "abcde", topicId: "3", messageId: "5" })).toBe("https://t.me/abcde/3/5");
    expect(telegramMessageUrl({ chatId: "-100999", messageId: "5" })).toBe("https://t.me/c/999/5");
    expect(telegramMessageUrl({ chatId: "-4455", messageId: "5" })).toBeUndefined();
    expect(telegramMessageUrl({ chatId: "-100999", username: "bad/name", messageId: "5" })).toBe("https://t.me/c/999/5");
  });
});

describe("telegram send: failures", () => {
  it("honours a 429 retry_after once, then succeeds", async () => {
    const { provider, fake, clock } = make([
      jsonResponse(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }),
      okMessage(60),
    ]);
    const result = await provider.send(TOKEN, group, { text: "hi" });
    expect(result.status).toBe("sent");
    expect(fake.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([3000]);
  });

  it("fails with provider_rate_limited after a second 429", async () => {
    const limited = () => jsonResponse(429, { ok: false, parameters: { retry_after: 2 } });
    const { provider, fake } = make([limited(), limited(), okMessage(1)]);
    const result = await provider.send(TOKEN, group, { text: "hi" });
    expect(result).toMatchObject({ status: "failed", errorCode: "provider_rate_limited", resultIds: [] });
    expect(fake.requests).toHaveLength(2);
  });

  it("does not wait for a retry_after over 30 s", async () => {
    const { provider, fake, clock } = make([jsonResponse(429, { ok: false, parameters: { retry_after: 31 } })]);
    const result = await provider.send(TOKEN, group, { text: "hi" });
    expect(result).toMatchObject({ status: "failed", errorCode: "provider_rate_limited" });
    expect(fake.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("falls back to the Retry-After header", async () => {
    const { provider, clock } = make([jsonResponse(429, { ok: false }, { "retry-after": "4" }), okMessage(61)]);
    expect((await provider.send(TOKEN, group, { text: "hi" })).status).toBe("sent");
    expect(clock.sleeps).toEqual([4000]);
  });

  it("returns uncertain / provider_timeout when the request times out", async () => {
    const { provider } = make(["hang"], { timeoutMs: 15 });
    const result = await provider.send(TOKEN, group, { text: "hi" });
    expect(result).toMatchObject({ status: "uncertain", errorCode: "provider_timeout", resultIds: [] });
  });

  it("returns uncertain on a network error and scrubs a token inside the error message", async () => {
    const { provider } = make([Object.assign(new TypeError(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`), { cause: { code: "ECONNRESET" } })]);
    const result = await provider.send(TOKEN, group, { text: "hi" });
    expect(result).toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
    expect(result.detail).toContain("ECONNRESET");
    noToken(result);
  });

  it("classifies HTTP statuses", async () => {
    const { provider } = make([
      jsonResponse(401, { ok: false, description: "Unauthorized" }),
      jsonResponse(403, { ok: false, description: "Forbidden: bot was kicked from the group chat" }),
      jsonResponse(404, { ok: false, description: "Not Found" }),
      jsonResponse(400, { ok: false, description: "Bad Request: chat not found" }),
      jsonResponse(500, { ok: false }),
      jsonResponse(502, "<html>"),
      jsonResponse(503, {}),
      jsonResponse(504, {}),
      jsonResponse(524, {}),
    ]);
    const run = () => provider.send(TOKEN, group, { text: "hi" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "credential_invalid" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "provider_forbidden", detail: "Forbidden: bot was kicked from the group chat" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "credential_invalid" });
    expect(await run()).toMatchObject({ status: "failed", errorCode: "provider_rejected", detail: "Bad Request: chat not found" });
    for (const status of [500, 502, 503, 504]) {
      expect(await run()).toMatchObject(
        status === 503
          ? { status: "failed", errorCode: "provider_unavailable" }
          : { status: "uncertain", errorCode: "provider_unexpected_status" },
      );
    }
    expect(await run()).toMatchObject({ status: "uncertain", errorCode: "provider_unexpected_status" });
  });

  it("treats an unreadable success reply as uncertain", async () => {
    const { provider } = make([new Response("<html>ok</html>", { status: 200 }), jsonResponse(200, { ok: true, result: {} })]);
    expect(await provider.send(TOKEN, group, { text: "hi" })).toMatchObject({ status: "uncertain", errorCode: "provider_bad_response" });
    expect(await provider.send(TOKEN, group, { text: "hi" })).toMatchObject({ status: "uncertain", errorCode: "provider_bad_response" });
  });

  it("reports a partial delivery when the follow-up text fails after the media was sent", async () => {
    const { provider } = make([okMessage(70), jsonResponse(400, { ok: false, description: "Bad Request: message is too long" })]);
    const result = await provider.send(TOKEN, group, { text: "q".repeat(2000), attachments: [attachment("p.png", "image/png")] });
    expect(result).toMatchObject({ status: "uncertain", errorCode: "provider_rejected", resultIds: ["70"], partial: true });
    expect(result.detail).toContain("partial delivery");
  });

  it("keeps a partial delivery uncertain even when the later failure alone would be failed", async () => {
    const { provider } = make([okMessage(71), jsonResponse(503, {})]);
    const result = await provider.send(TOKEN, group, { text: "q".repeat(2000), attachments: [attachment("p.png", "image/png")] });
    expect(result).toMatchObject({ status: "uncertain", errorCode: "provider_unavailable", resultIds: ["71"], partial: true });
  });
});

describe("telegram local rate limiting", () => {
  it("reserves the whole plan before the first request, so a local limit never cuts a post in half", async () => {
    const replies = [...Array.from({ length: 19 }, (_, i) => okMessage(100 + i)), okMessage(200), okMessage(201)];
    const { provider, fake, clock } = make(replies);
    for (let i = 0; i < 19; i += 1) {
      expect((await provider.send(TOKEN, group, { text: `n${i}` })).status).toBe("sent");
    }
    const sleepsBefore = clock.sleeps.length;
    const requestsBefore = fake.requests.length;
    // Two steps (media, then the long text): both are reserved up front, so the
    // limiter waits before the first request and never between the two.
    const result = await provider.send(TOKEN, group, { text: "q".repeat(2000), attachments: [attachment("p.png", "image/png")] });
    expect(result).toMatchObject({ status: "sent", resultIds: ["200", "201"] });
    expect(result).not.toHaveProperty("partial");
    expect(fake.requests.length - requestsBefore).toBe(2);
    expect(clock.sleeps.length).toBeGreaterThan(sleepsBefore);
  });


  it("spaces two sends to one chat by 1 s and does not delay a different chat", async () => {
    const { provider, clock } = make([okMessage(1), okMessage(2), okMessage(3)]);
    const chat: ChannelDestination = { type: "chat", externalId: "5550001", title: "c" };
    await provider.send(TOKEN, chat, { text: "a" });
    await provider.send(TOKEN, chat, { text: "b" });
    expect(clock.sleeps).toEqual([1000]);
    await provider.send(TOKEN, { ...chat, externalId: "5550002" }, { text: "c" });
    expect(clock.sleeps).toEqual([1000]);
  });
});

describe("telegram never leaks the token", () => {
  it("keeps the token out of every returned value, including provider error text that echoes it", async () => {
    const echo = (status: number) => jsonResponse(status, { ok: false, description: `Bad Request: bot${TOKEN} and ${TOKEN} and ${encodeURIComponent(TOKEN)}` });
    const { provider } = make([
      echo(400),
      echo(403),
      echo(404),
      echo(401),
      echo(409),
      echo(400),
      new Error(`boom ${TOKEN}`),
    ]);
    const results: unknown[] = [];
    results.push(await provider.send(TOKEN, group, { text: "a" }));
    results.push(await provider.send(TOKEN, group, { text: "a" }));
    results.push(await provider.send(TOKEN, group, { text: "a" }));
    results.push(await provider.verify(TOKEN));
    results.push(await provider.discover(TOKEN));
    results.push(await provider.discover(TOKEN));
    results.push(await provider.send(TOKEN, group, { text: "a" }));
    for (const result of results) {
      noToken(result);
    }
    expect((results[0] as { detail: string }).detail).toContain("[redacted]");
  });

  it("never throws, and a thrown-looking failure is a fixed result", async () => {
    const { provider } = make([() => {
      throw new Error(`explode ${TOKEN}`);
    }]);
    const result = await provider.send(TOKEN, group, { text: "a" });
    expect(result.status).toBe("uncertain");
    noToken(result);
  });
});

describe("telegram native media kinds", () => {
  const ogg = (size = 10) => attachment("note.ogg", "audio/ogg", new Uint8Array(size).fill(7), { kind: "voice" });

  it("sends a voice note with sendVoice and the multipart field `voice`", async () => {
    const { provider, fake } = make([okMessage(60)]);
    const result = await provider.send(TOKEN, group, { text: "listen", attachments: [ogg()] });
    expect(result).toEqual({ status: "sent", resultIds: ["60"], resultUrls: ["https://t.me/c/1234567890/60"] });
    expect(result).not.toHaveProperty("fallback");
    const request = fake.requests[0]!;
    expect(telegramMethod(request, TOKEN)).toBe("sendVoice");
    const form = request.body as FormData;
    expect(form.get("caption")).toBe("listen");
    const voice = form.get("voice") as File;
    expect(voice.type).toBe("audio/ogg");
    expect(voice.size).toBe(10);
  });

  it("accepts an Opus content type with parameters and exactly 1 MiB", async () => {
    const { provider, fake } = make([okMessage(61)]);
    const exact = { ...attachment("n.ogg", "audio/ogg; codecs=opus", new Uint8Array(MiB), { kind: "voice" }) };
    expect((await provider.send(TOKEN, group, { text: "", attachments: [exact] })).status).toBe("sent");
    expect(telegramMethod(fake.requests[0]!, TOKEN)).toBe("sendVoice");
  });

  it("does not post the transcript of a native voice", async () => {
    const { provider, fake } = make([okMessage(62)]);
    await provider.send(TOKEN, group, {
      text: "hi",
      attachments: [attachment("n.ogg", "audio/ogg", "ogg", { kind: "voice", transcript: "secret words" })],
    });
    const form = fake.requests[0]!.body as FormData;
    expect(JSON.stringify([...form.entries()].map(([k, v]) => (typeof v === "string" ? v : k)))).not.toContain("secret words");
  });

  it("refuses a voice over 1 MiB and does not turn it into an audio file", async () => {
    const { provider, fake } = make();
    const result = await provider.send(TOKEN, group, { text: "x", attachments: [ogg(MiB + 1)] });
    expect(result).toMatchObject({ status: "failed", errorCode: "channel_file_too_large", resultIds: [] });
    expect(fake.requests).toHaveLength(0);
  });

  it("sends audio with sendAudio and video with sendVideo, one request each, caption on the first", async () => {
    const { provider, fake } = make([okMessage(70), okMessage(71)]);
    const result = await provider.send(TOKEN, group, {
      text: "media",
      attachments: [attachment("v.mp4", "video/mp4"), attachment("a.mp3", "audio/mpeg")],
    });
    expect(result.status).toBe("sent");
    expect(fake.requests.map((r) => telegramMethod(r, TOKEN))).toEqual(["sendAudio", "sendVideo"]);
    const audio = fake.requests[0]!.body as FormData;
    expect(audio.get("caption")).toBe("media");
    expect((audio.get("audio") as File).name).toBe("a.mp3");
    const video = fake.requests[1]!.body as FormData;
    expect(video.has("caption")).toBe(false);
    expect((video.get("video") as File).type).toBe("video/mp4");
  });

  it("sends m4a as audio and a zip as a document", async () => {
    const { provider, fake } = make([okMessage(72), okMessage(73)]);
    await provider.send(TOKEN, group, { text: "", attachments: [attachment("a.m4a", "audio/mp4"), attachment("a.zip", "application/zip")] });
    expect(fake.requests.map((r) => telegramMethod(r, TOKEN))).toEqual(["sendDocument", "sendAudio"]);
  });
});

describe("telegram kind and type validation", () => {
  it("refuses an undeclared kind or a missing kind without any request", async () => {
    const { provider, fake } = make();
    const png = attachment("p.png", "image/png");
    const bogus = { ...png, kind: "poll" } as unknown as typeof png;
    const { kind: _kind, ...kindless } = png;
    for (const bad of [bogus, kindless as unknown as typeof png]) {
      const result = await provider.send(TOKEN, group, { text: "x", attachments: [bad] });
      expect(result).toMatchObject({ status: "failed", errorCode: "channel_capability_unavailable", resultIds: [] });
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses a content type that does not match the kind", async () => {
    const { provider, fake } = make();
    const code = async (name: string, contentType: string, kind: "image" | "file" | "audio" | "voice" | "video") =>
      (await provider.send(TOKEN, group, { text: "x", attachments: [attachment(name, contentType, name, { kind })] })).errorCode;
    expect(await code("p.png", "image/png", "video")).toBe("channel_file_type_not_allowed");
    expect(await code("a.gif", "image/gif", "image")).toBe("channel_file_type_not_allowed");
    expect(await code("a.mp3", "audio/mpeg", "voice")).toBe("channel_file_type_not_allowed");
    expect(await code("a.ogg", "audio/ogg", "audio")).toBe("channel_file_type_not_allowed");
    expect(await code("a.mkv", "video/x-matroska", "video")).toBe("channel_file_type_not_allowed");
    expect(await code("a.html", "text/html", "file")).toBe("channel_file_type_not_allowed");
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses more than four attachments of any mix and bad transcripts", async () => {
    const { provider, fake } = make();
    const mixed = [
      attachment("a.png", "image/png"),
      attachment("b.pdf", "application/pdf"),
      attachment("c.mp3", "audio/mpeg"),
      attachment("d.mp4", "video/mp4"),
      attachment("e.ogg", "audio/ogg", "e", { kind: "voice" }),
    ];
    expect((await provider.send(TOKEN, group, { text: "x", attachments: mixed })).errorCode).toBe("channel_too_many_files");
    const long = attachment("n.ogg", "audio/ogg", "n", { kind: "voice", transcript: "t".repeat(1001) });
    expect((await provider.send(TOKEN, group, { text: "x", attachments: [long] })).errorCode).toBe("channel_transcript_too_long");
    const onImage = attachment("p.png", "image/png", "p", { transcript: "nope" });
    expect((await provider.send(TOKEN, group, { text: "x", attachments: [onImage] })).errorCode).toBe("channel_transcript_unsupported");
    expect(fake.requests).toHaveLength(0);
  });

  it("never leaks the token in a refusal or a failure of a media send", async () => {
    const { provider } = make([jsonResponse(400, { ok: false, description: `Bad Request: ${TOKEN}` })]);
    const refused = await provider.send(TOKEN, group, { text: "x", attachments: [attachment("p.png", "image/png", "p", { kind: "video" })] });
    noToken(refused);
    const failed = await provider.send(TOKEN, group, { text: "x", attachments: [attachment("n.ogg", "audio/ogg", "n", { kind: "voice" })] });
    expect(failed.status).toBe("failed");
    noToken(failed);
  });
});

import { describe, expect, it } from "vitest";

import { capabilitySupports } from "./capabilities.js";
import { attachment, createFakeClock, jsonResponse } from "./test-support.js";
import {
  TEAMS_MAX_TEXT_CHARS,
  createTeamsProvider,
  encodeTeamsCredential,
  parseTeamsActivity,
  parseTeamsCredential,
  teamsMentionEntities,
  type TeamsConversationRef,
  type TeamsConversationSource,
} from "./teams.js";
import type { ChannelDestination } from "./types.js";

const APP_ID = "11111111-2222-4333-8444-555555555555";
const TENANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "Sentinel~TeamsSecret.0123456789_abcdefXYZ";
const CREDENTIAL = encodeTeamsCredential({ appId: APP_ID, appSecret: SECRET, tenantId: TENANT_ID });
const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJib3QifQ.sentinelAccessTokenSignature0123456789";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const API = "https://smba.trafficmanager.net/amer/v3";
const TEAM_ID = "19:teamaaaa0000@thread.tacv2";
const CHANNEL_ID = "19:chanbbbb1111@thread.tacv2";
const PRIVATE_ID = "19:privatedddd@thread.tacv2";
const GROUP_ID = "19:groupcccc2222@thread.v2";
const PERSONAL_ID = "a:1personalConversationXyz_0123";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;

type Recorded = { method: string; url: string; headers: Record<string, string>; body: string | undefined };
type Handler = (request: Recorded) => Response | Error | "hang";

/** A fake fetch that routes by request. Token requests are answered automatically unless `token` overrides them. */
function routedFetch(handler: Handler, token: () => Response = () => jsonResponse(200, { token_type: "Bearer", expires_in: 3600, access_token: ACCESS_TOKEN })) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const request = { method: init?.method ?? "GET", url: String(input), headers, body: typeof init?.body === "string" ? init.body : undefined };
    requests.push(request);
    const reply = request.url === TOKEN_URL ? token() : handler(request);
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  return { fetchImpl, requests, api: () => requests.filter((request) => request.url !== TOKEN_URL) };
}

function memorySource(initial: TeamsConversationRef[] = []): TeamsConversationSource & { refs: TeamsConversationRef[] } {
  const refs = [...initial];
  return {
    refs,
    list: () => refs,
    get: (id) => refs.find((ref) => ref.conversationId === id) ?? null,
    forTeam: (teamId) => refs.find((ref) => ref.teamId === teamId) ?? null,
    forTenant: (tenantId) => refs.find((ref) => ref.tenantId === tenantId) ?? null,
    upsert: (ref) => {
      const index = refs.findIndex((entry) => entry.conversationId === ref.conversationId);
      if (index >= 0) refs[index] = ref;
      else refs.push(ref);
    },
  };
}

const channelRef: TeamsConversationRef = {
  conversationId: CHANNEL_ID,
  type: "channel",
  teamId: TEAM_ID,
  channelId: CHANNEL_ID,
  teamName: "Ops",
  title: "Ops / #announcements",
  membership: "standard",
  serviceUrl: SERVICE_URL,
  tenantId: TENANT_ID,
};
const privateRef: TeamsConversationRef = { ...channelRef, conversationId: PRIVATE_ID, channelId: PRIVATE_ID, title: "Ops / #secret", membership: "private" };
const groupRef: TeamsConversationRef = { conversationId: GROUP_ID, type: "groupChat", teamName: "", title: "Launch crew", membership: "standard", serviceUrl: SERVICE_URL, tenantId: TENANT_ID };
const personalRef: TeamsConversationRef = { conversationId: PERSONAL_ID, type: "personal", teamName: "", title: "Direct chat: Ana", membership: "standard", serviceUrl: SERVICE_URL, tenantId: TENANT_ID };

const channelDestination: ChannelDestination = { type: "channel", externalId: CHANNEL_ID, title: "Ops / #announcements", parentId: TEAM_ID };
const groupDestination: ChannelDestination = { type: "group", externalId: GROUP_ID, title: "Launch crew" };

function make(handler: Handler, extra: { refs?: TeamsConversationRef[]; graphEnabled?: boolean; token?: () => Response; timeoutMs?: number } = {}) {
  const fake = routedFetch(handler, extra.token);
  const clock = createFakeClock();
  const conversations = memorySource(extra.refs ?? [channelRef, privateRef, groupRef, personalRef]);
  const provider = createTeamsProvider({
    fetchImpl: fake.fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    conversations,
    graphEnabled: extra.graphEnabled,
    random: () => 0.5,
    ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
  });
  return { fake, clock, provider, conversations };
}

function noSecret(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(ACCESS_TOKEN);
}

describe("teams capabilities", () => {
  it("declares text, named mentions, thread replies, edit and delete; no files, cards, reactions or inbound", () => {
    const { provider } = make(() => jsonResponse(200, {}));
    expect(provider.id).toBe("teams");
    expect(provider.capabilities).toEqual({
      channelCapabilities: 2,
      text: { maxChars: 28_000 },
      markup: "teams-markdown",
      mentions: { users: true, broadcast: "suppressed" },
      dm: { open: false, maxMembers: 0 },
      image: false,
      file: false,
      audio: false,
      voice: false,
      video: false,
      thread: { replies: true, topics: false, forum: false },
      reactions: { add: false, remove: false, custom: false },
      buttons: { url: false, callback: false },
      poll: false,
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
      limits: { perChatPerSecond: 7, perChatPerMinute: 120, retryAfter: "honoured" },
    });
    expect(provider.react).toBeUndefined();
    expect(capabilitySupports(provider.capabilities, "dm")).toBe(false);
    expect(capabilitySupports(provider.capabilities, "reactions.add")).toBe(false);
  });

  it("declares dm.open only when Graph user lookup is configured", () => {
    const { provider } = make(() => jsonResponse(200, {}), { graphEnabled: true });
    expect(provider.capabilities.dm).toEqual({ open: true, maxMembers: 1 });
  });
});

describe("teams credential", () => {
  it("parses the composed credential and refuses partial or malformed values", () => {
    expect(parseTeamsCredential(CREDENTIAL)).toEqual({ ok: true, credential: { appId: APP_ID, appSecret: SECRET, tenantId: TENANT_ID } });
    expect(parseTeamsCredential(undefined)).toEqual({ ok: false, reason: "credential_missing" });
    expect(parseTeamsCredential(JSON.stringify({ appId: APP_ID, tenantId: TENANT_ID }))).toEqual({ ok: false, reason: "credential_missing" });
    expect(parseTeamsCredential("not json")).toEqual({ ok: false, reason: "credential_invalid" });
    expect(parseTeamsCredential(JSON.stringify({ appId: "bot", appSecret: SECRET, tenantId: TENANT_ID }))).toEqual({ ok: false, reason: "credential_invalid" });
    expect(parseTeamsCredential(JSON.stringify({ appId: APP_ID, appSecret: "has space\nx", tenantId: TENANT_ID }))).toEqual({ ok: false, reason: "credential_invalid" });
  });
});

describe("teams verify", () => {
  it("asks Entra for a client-credentials token at the bot's own tenant and caches it", async () => {
    const { provider, fake } = make(() => jsonResponse(200, {}));
    const verified = await provider.verify(CREDENTIAL);
    expect(verified).toEqual({ ok: true, botId: `28:${APP_ID}`, botUsername: "" });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(TOKEN_URL);
    expect(request!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(request!.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: APP_ID,
      client_secret: SECRET,
      scope: "https://api.botframework.com/.default",
    });
    await provider.verify(CREDENTIAL);
    expect(fake.requests).toHaveLength(1);
    noSecret(verified);
  });

  it("renews the token five minutes before it expires", async () => {
    const { provider, fake, clock } = make(() => jsonResponse(200, {}));
    await provider.verify(CREDENTIAL);
    clock.advance(54 * 60_000);
    await provider.verify(CREDENTIAL);
    expect(fake.requests).toHaveLength(1);
    clock.advance(2 * 60_000);
    await provider.verify(CREDENTIAL);
    expect(fake.requests).toHaveLength(2);
  });

  it("classifies a rejected credential, a missing one and an unreachable Entra", async () => {
    const rejected = make(() => jsonResponse(200, {}), {
      token: () => jsonResponse(401, { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret ${SECRET}` }),
    });
    const invalid = await rejected.provider.verify(CREDENTIAL);
    expect(invalid).toEqual({ ok: false, reason: "credential_invalid" });
    noSecret(invalid);
    expect(await make(() => jsonResponse(200, {})).provider.verify(null)).toEqual({ ok: false, reason: "credential_missing" });
    const down = make(() => jsonResponse(200, {}), { token: () => jsonResponse(503, {}) });
    expect(await down.provider.verify(CREDENTIAL)).toEqual({ ok: false, reason: "provider_unavailable" });
  });
});

describe("teams discover", () => {
  it("lists standard channels of installed teams, group chats and 1:1 chats; private channels are left out and named", async () => {
    const { provider, fake } = make((request) => {
      if (request.url === `${API}/teams/${encodeURIComponent(TEAM_ID)}/conversations`) {
        return jsonResponse(200, {
          conversations: [
            { id: TEAM_ID, name: null },
            { id: CHANNEL_ID, name: "announcements‮" },
            { id: "19:sharedeeee@thread.tacv2", name: "partners", membershipType: "shared" },
            { id: PRIVATE_ID, name: "secret" },
          ],
        });
      }
      return jsonResponse(404, {});
    });
    const result = await provider.discover(CREDENTIAL);
    expect(result).toEqual({
      ok: true,
      destinations: [
        { type: "channel", externalId: TEAM_ID, title: "Ops / #General", parentId: TEAM_ID },
        { type: "channel", externalId: CHANNEL_ID, title: "Ops / #announcements", parentId: TEAM_ID },
        { type: "group", externalId: GROUP_ID, title: "Launch crew" },
        { type: "person", externalId: PERSONAL_ID, title: "Direct chat: Ana" },
      ],
      notes: ["2 private or shared channel(s) not listed: Teams bots cannot post there."],
    });
    const listCall = fake.api()[0]!;
    expect(listCall.method).toBe("GET");
    expect(listCall.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    noSecret(result);
  });

  it("falls back to the stored channels when the live channel list is unavailable, and skips a team the bot left", async () => {
    const down = make(() => jsonResponse(500, {}), { refs: [channelRef] });
    expect(await down.provider.discover(CREDENTIAL)).toEqual({ ok: true, destinations: [{ type: "channel", externalId: CHANNEL_ID, title: "Ops / #announcements", parentId: TEAM_ID }] });
    const gone = make(() => jsonResponse(403, {}), { refs: [channelRef] });
    expect(await gone.provider.discover(CREDENTIAL)).toEqual({ ok: true, destinations: [] });
  });

  it("reports a rejected credential and an empty install", async () => {
    const rejected = make(() => jsonResponse(200, {}), { token: () => jsonResponse(400, { error: "unauthorized_client" }) });
    expect(await rejected.provider.discover(CREDENTIAL)).toEqual({ ok: false, reason: "credential_invalid" });
    const empty = make(() => jsonResponse(200, {}), { refs: [] });
    expect(await empty.provider.discover(CREDENTIAL)).toEqual({ ok: true, destinations: [] });
    expect(empty.fake.requests).toHaveLength(0);
  });
});

describe("teams send", () => {
  it("posts a markdown message activity to the stored conversation and returns the activity id and a deep link", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "1712345678901" }));
    const result = await provider.send(CREDENTIAL, channelDestination, { text: "**Launch** at 10:00" });
    expect(result).toEqual({
      status: "sent",
      resultIds: ["1712345678901"],
      resultUrls: [
        `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL_ID)}/1712345678901?tenantId=${TENANT_ID}&parentMessageId=1712345678901`,
      ],
    });
    const call = fake.api()[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${API}/conversations/${encodeURIComponent(CHANNEL_ID)}/activities`);
    expect(call.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.parse(call.body!)).toEqual({ type: "message", text: "**Launch** at 10:00", textFormat: "markdown" });
    noSecret(result);
  });

  it("replies in a channel thread through the reply route", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "1712345678999" }));
    const result = await provider.send(CREDENTIAL, channelDestination, { text: "Done.", replyTo: "1712345678901" });
    expect(result.status).toBe("sent");
    expect(result.resultUrls[0]).toContain("parentMessageId=1712345678901");
    expect(fake.api()[0]!.url).toBe(`${API}/conversations/${encodeURIComponent(CHANNEL_ID)}/activities/1712345678901`);
  });

  it("refuses a thread reply outside a channel and a malformed reply id, before any request", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "1" }));
    expect(await provider.send(CREDENTIAL, groupDestination, { text: "x", replyTo: "1712345678901" })).toMatchObject({ status: "failed", errorCode: "channel_capability_unavailable" });
    expect(await provider.send(CREDENTIAL, channelDestination, { text: "x", replyTo: "../../x" })).toMatchObject({ status: "failed", errorCode: "channel_reply_invalid" });
    expect(fake.requests).toHaveLength(0);
  });

  it("mentions named users with <at> tags and mention entities; never a team, channel or tag", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "42" }));
    const entraId = "0f0f0f0f-1111-4222-8333-444455556666";
    const result = await provider.send(CREDENTIAL, groupDestination, {
      text: "Hi <at>Ana Lee</at> and <at>Bo</at>",
      mentions: [
        { userId: "29:1AbC-def_ghi", name: "Ana Lee" },
        { userId: entraId, name: "Bo" },
      ],
    });
    expect(result.status).toBe("sent");
    expect(result.resultUrls).toEqual([]);
    expect(JSON.parse(fake.api()[0]!.body!).entities).toEqual([
      { type: "mention", text: "<at>Ana Lee</at>", mentioned: { id: "29:1AbC-def_ghi", name: "Ana Lee" } },
      { type: "mention", text: "<at>Bo</at>", mentioned: { id: entraId, name: "Bo" } },
    ]);
  });

  it("refuses broadcast-shaped and undeclared mentions before any request", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "1" }));
    const cases = [
      { text: "Hello <at>General</at>", mentions: [{ userId: TEAM_ID, name: "General" }] },
      { text: "Hello <at>Everyone</at>" },
      { text: "Hello Ana", mentions: [{ userId: "29:abc", name: "Ana" }] },
      { text: "Hello <at>A<b></at>", mentions: [{ userId: "29:abc", name: "A<b>" }] },
    ];
    for (const message of cases) {
      expect(await provider.send(CREDENTIAL, groupDestination, message)).toMatchObject({ status: "failed", errorCode: "channel_mention_invalid" });
    }
    expect(fake.requests).toHaveLength(0);
    expect(teamsMentionEntities("no mentions", undefined)).toEqual({ ok: true, entities: [] });
  });

  it("refuses text over 28,000 characters, attachments, unknown and private destinations, before any request", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "1" }));
    expect(await provider.send(CREDENTIAL, channelDestination, { text: "x".repeat(TEAMS_MAX_TEXT_CHARS + 1) })).toMatchObject({ status: "failed", errorCode: "channel_text_too_long" });
    expect(await provider.send(CREDENTIAL, channelDestination, { text: "x", attachments: [attachment("a.png", "image/png")] })).toMatchObject({
      status: "failed",
      errorCode: "channel_capability_unavailable",
    });
    expect(await provider.send(CREDENTIAL, { type: "group", externalId: "19:unknown@thread.v2", title: "?" }, { text: "x" })).toMatchObject({
      status: "failed",
      errorCode: "channel_destination_unknown",
    });
    expect(await provider.send(CREDENTIAL, { type: "channel", externalId: PRIVATE_ID, title: "secret", parentId: TEAM_ID }, { text: "x" })).toMatchObject({
      status: "failed",
      errorCode: "channel_capability_unavailable",
    });
    expect(await provider.send(CREDENTIAL, { type: "group", externalId: "19:x/../y", title: "?" }, { text: "x" })).toMatchObject({ status: "failed", errorCode: "channel_destination_invalid" });
    expect(await provider.send(CREDENTIAL, channelDestination, { text: "   " })).toMatchObject({ status: "failed", errorCode: "channel_message_empty" });
    expect(await provider.send(null, channelDestination, { text: "x" })).toMatchObject({ status: "failed", errorCode: "credential_missing" });
    expect(fake.requests).toHaveLength(0);
  });

  it("sends to another standard channel of an installed team through the team's stored reference", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "7" }));
    const other: ChannelDestination = { type: "channel", externalId: "19:otherffff@thread.tacv2", title: "Ops / #other", parentId: TEAM_ID };
    expect((await provider.send(CREDENTIAL, other, { text: "x" })).status).toBe("sent");
    expect(fake.api()[0]!.url).toBe(`${API}/conversations/${encodeURIComponent("19:otherffff@thread.tacv2")}/activities`);
  });

  it("honours Retry-After once on 429 and fails on a second 429", async () => {
    let calls = 0;
    const { provider, clock } = make(() => (++calls === 1 ? jsonResponse(429, {}, { "retry-after": "3" }) : jsonResponse(201, { id: "9" })));
    expect((await provider.send(CREDENTIAL, groupDestination, { text: "x" })).status).toBe("sent");
    expect(clock.sleeps).toContain(3000);
    const twice = make(() => jsonResponse(429, {}, { "retry-after": "1" }));
    expect(await twice.provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "failed", errorCode: "provider_rate_limited" });
    expect(twice.fake.api()).toHaveLength(2);
  });

  it("does not wait for a Retry-After over 30 s", async () => {
    const { provider, fake } = make(() => jsonResponse(429, {}, { "retry-after": "120" }));
    expect(await provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "failed", errorCode: "provider_rate_limited" });
    expect(fake.api()).toHaveLength(1);
  });

  it("retries 412 once with jittered backoff", async () => {
    let calls = 0;
    const { provider, clock } = make(() => (++calls === 1 ? jsonResponse(412, { error: { code: "PreconditionFailed", message: "busy" } }) : jsonResponse(201, { id: "5" })));
    expect((await provider.send(CREDENTIAL, groupDestination, { text: "x" })).status).toBe("sent");
    expect(clock.sleeps).toEqual([1500]);
  });

  it("never retries a send after 502 or 504: the outcome is uncertain", async () => {
    for (const status of [502, 504, 500]) {
      const { provider, fake } = make(() => jsonResponse(status, {}));
      expect(await provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "uncertain", errorCode: "provider_unexpected_status" });
      expect(fake.api()).toHaveLength(1);
    }
  });

  it("classifies 503, 403, 404, timeouts and unreadable success answers", async () => {
    expect(await make(() => jsonResponse(503, {})).provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    const forbidden = await make(() =>
      jsonResponse(403, { errorCode: 209, message: `{"subCode":"MessageWritesBlocked"} ${SECRET}` }),
    ).provider.send(CREDENTIAL, groupDestination, { text: "x" });
    expect(forbidden).toMatchObject({ status: "failed", errorCode: "provider_forbidden" });
    expect(forbidden.detail).toContain("MessageWritesBlocked");
    noSecret(forbidden);
    expect(await make(() => jsonResponse(404, {})).provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "failed", errorCode: "provider_not_found" });
    expect(await make(() => "hang", { timeoutMs: 5 }).provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
    expect(await make(() => new TypeError("fetch failed")).provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "uncertain", errorCode: "provider_timeout" });
    expect(await make(() => jsonResponse(201, {})).provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "uncertain", errorCode: "provider_bad_response" });
  });

  it("renews the access token once when the Bot Connector answers 401", async () => {
    let calls = 0;
    const { provider, fake } = make(() => (++calls === 1 ? jsonResponse(401, {}) : jsonResponse(201, { id: "8" })));
    expect((await provider.send(CREDENTIAL, groupDestination, { text: "x" })).status).toBe("sent");
    expect(fake.requests.filter((request) => request.url === TOKEN_URL)).toHaveLength(2);
    const always = make(() => jsonResponse(401, {}));
    expect(await always.provider.send(CREDENTIAL, groupDestination, { text: "x" })).toMatchObject({ status: "failed", errorCode: "credential_invalid" });
  });

  it("fails without sending when Entra issues no token", async () => {
    const { provider, fake } = make(() => jsonResponse(201, { id: "1" }), { token: () => jsonResponse(401, { error: "invalid_client" }) });
    const result = await provider.send(CREDENTIAL, groupDestination, { text: "x" });
    expect(result).toMatchObject({ status: "failed", errorCode: "credential_invalid" });
    expect(fake.api()).toHaveLength(0);
  });

  it("keeps to 7 messages per second in one conversation", async () => {
    const { provider, clock } = make(() => jsonResponse(201, { id: "1" }));
    for (let index = 0; index < 7; index += 1) await provider.send(CREDENTIAL, groupDestination, { text: `m${index}` });
    expect(clock.sleeps).toEqual([]);
    await provider.send(CREDENTIAL, groupDestination, { text: "m7" });
    expect(clock.sleeps.length).toBeGreaterThan(0);
  });
});

describe("teams edit and remove", () => {
  it("replaces the text of an own message with PUT and deletes with DELETE", async () => {
    const { provider, fake } = make((request) => (request.method === "PUT" ? jsonResponse(200, { id: "77" }) : jsonResponse(200, {})));
    expect(await provider.edit!(CREDENTIAL, channelDestination, "77", { text: "Updated" })).toEqual({ status: "sent", resultIds: ["77"], resultUrls: [] });
    const put = fake.api()[0]!;
    expect(put.url).toBe(`${API}/conversations/${encodeURIComponent(CHANNEL_ID)}/activities/77`);
    expect(JSON.parse(put.body!)).toEqual({ type: "message", id: "77", text: "Updated", textFormat: "markdown" });
    expect(await provider.remove!(CREDENTIAL, channelDestination, "77")).toEqual({ status: "sent" });
    expect(fake.api()[1]).toMatchObject({ method: "DELETE", url: `${API}/conversations/${encodeURIComponent(CHANNEL_ID)}/activities/77`, body: undefined });
  });

  it("retries an idempotent edit once on 502 and reports a repeated 504 as uncertain", async () => {
    let calls = 0;
    const retried = make(() => (++calls === 1 ? jsonResponse(502, {}) : jsonResponse(200, { id: "77" })));
    expect(await retried.provider.edit!(CREDENTIAL, channelDestination, "77", { text: "x" })).toEqual({ status: "sent", resultIds: ["77"], resultUrls: [] });
    const stuck = make(() => jsonResponse(504, {}));
    expect(await stuck.provider.remove!(CREDENTIAL, channelDestination, "77")).toMatchObject({ status: "uncertain" });
    expect(stuck.fake.api()).toHaveLength(2);
  });

  it("edits with declared mentions only", async () => {
    const { provider, fake } = make(() => jsonResponse(200, { id: "77" }));
    expect((await provider.edit!(CREDENTIAL, channelDestination, "77", { text: "cc <at>Ana</at>", mentions: [{ userId: "29:abc", name: "Ana" }] })).status).toBe("sent");
    expect(JSON.parse(fake.api()[0]!.body!).entities).toEqual([{ type: "mention", text: "<at>Ana</at>", mentioned: { id: "29:abc", name: "Ana" } }]);
  });

  it("refuses bad ids, empty edits, undeclared mentions, and reports a missing message", async () => {
    const { provider, fake } = make(() => jsonResponse(404, { error: { code: "NotFound", message: "activity not found" } }));
    expect(await provider.edit!(CREDENTIAL, channelDestination, "../x", { text: "x" })).toMatchObject({ status: "failed", errorCode: "channel_message_invalid" });
    expect(await provider.edit!(CREDENTIAL, channelDestination, "77", { text: " " })).toMatchObject({ status: "failed", errorCode: "channel_message_empty" });
    expect(await provider.edit!(CREDENTIAL, channelDestination, "77", { text: "<at>Ana</at>" })).toMatchObject({ status: "failed", errorCode: "channel_mention_invalid" });
    expect(fake.requests).toHaveLength(0);
    expect(await provider.remove!(CREDENTIAL, channelDestination, "77")).toMatchObject({ status: "failed", errorCode: "provider_not_found" });
  });
});

describe("teams findPerson and openDirect", () => {
  it("refuses both without Graph user lookup, before any request", async () => {
    const { provider, fake } = make(() => jsonResponse(200, {}));
    expect(await provider.findPerson!(CREDENTIAL, { email: "ana@contoso.com" })).toMatchObject({ ok: false, reason: "failed", errorCode: "channel_capability_unavailable" });
    expect(await provider.openDirect!(CREDENTIAL, "29:abc")).toMatchObject({ ok: false, errorCode: "channel_capability_unavailable" });
    expect(fake.requests).toHaveLength(0);
  });

  it("finds exactly one Entra user by email with an app-only Graph token", async () => {
    const userId = "0f0f0f0f-1111-4222-8333-444455556666";
    const { provider, fake } = make(() => jsonResponse(200, { value: [{ id: userId, displayName: "Ana \u0007Lee" }] }), { graphEnabled: true });
    expect(await provider.findPerson!(CREDENTIAL, { email: "ana@contoso.com" })).toEqual({ ok: true, userId, displayName: "Ana Lee" });
    const token = fake.requests.find((request) => request.url === TOKEN_URL)!;
    expect(new URLSearchParams(token.body).get("scope")).toBe("https://graph.microsoft.com/.default");
    const lookup = new URL(fake.api()[0]!.url);
    expect(lookup.origin + lookup.pathname).toBe("https://graph.microsoft.com/v1.0/users");
    expect(lookup.searchParams.get("$filter")).toBe("mail eq 'ana@contoso.com' or userPrincipalName eq 'ana@contoso.com'");
    expect(lookup.searchParams.get("$select")).toBe("id,displayName");
    expect(lookup.searchParams.get("$top")).toBe("2");
  });

  it("answers not_found or ambiguous, never a list; refuses bad input; names a missing Graph permission", async () => {
    expect(await make(() => jsonResponse(200, { value: [] }), { graphEnabled: true }).provider.findPerson!(CREDENTIAL, { email: "x@contoso.com" })).toMatchObject({
      ok: false,
      reason: "not_found",
      errorCode: "person_not_found",
    });
    const two = [{ id: "0f0f0f0f-1111-4222-8333-444455556666" }, { id: "1f0f0f0f-1111-4222-8333-444455556666" }];
    const several = await make(() => jsonResponse(200, { value: two }), { graphEnabled: true }).provider.findPerson!(CREDENTIAL, { email: "x@contoso.com" });
    expect(several).toMatchObject({ ok: false, reason: "ambiguous", errorCode: "person_ambiguous" });
    expect(JSON.stringify(several)).not.toContain("1f0f0f0f");
    const bad = make(() => jsonResponse(200, { value: [] }), { graphEnabled: true });
    expect(await bad.provider.findPerson!(CREDENTIAL, { email: "x' or 1 eq 1 or mail eq 'y@z.com" })).toMatchObject({ ok: false, reason: "failed", errorCode: "person_query_invalid" });
    expect(await bad.provider.findPerson!(CREDENTIAL, { handle: "ana" })).toMatchObject({ ok: false, reason: "failed", errorCode: "person_query_invalid" });
    expect(await bad.provider.findPerson!(CREDENTIAL, {})).toMatchObject({ ok: false, reason: "failed", errorCode: "person_query_invalid" });
    expect(bad.fake.requests).toHaveLength(0);
    expect(await make(() => jsonResponse(403, {}), { graphEnabled: true }).provider.findPerson!(CREDENTIAL, { email: "x@contoso.com" })).toMatchObject({
      ok: false,
      reason: "failed",
      errorCode: "provider_forbidden",
    });
  });

  it("opens a 1:1 chat with createConversation and stores its reference", async () => {
    const created = "a:1newPersonalConversation_456";
    const { provider, fake, conversations } = make(() => jsonResponse(201, { id: created }), { graphEnabled: true, refs: [channelRef] });
    const result = await provider.openDirect!(CREDENTIAL, "0f0f0f0f-1111-4222-8333-444455556666");
    expect(result).toEqual({ ok: true, destination: { type: "person", externalId: created, title: "Direct chat", personId: "0f0f0f0f-1111-4222-8333-444455556666" } });
    const call = fake.api()[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${API}/conversations`);
    expect(JSON.parse(call.body!)).toEqual({
      bot: { id: `28:${APP_ID}` },
      members: [{ id: "0f0f0f0f-1111-4222-8333-444455556666" }],
      isGroup: false,
      tenantId: TENANT_ID,
      channelData: { tenant: { id: TENANT_ID } },
    });
    expect(conversations.get(created)).toMatchObject({ type: "personal", serviceUrl: SERVICE_URL, tenantId: TENANT_ID });
  });

  it("explains a person without the app, refuses bad ids, and needs one stored service address", async () => {
    const blocked = make(() => jsonResponse(403, { error: { code: "Forbidden" } }), { graphEnabled: true });
    expect(await blocked.provider.openDirect!(CREDENTIAL, "29:abc")).toMatchObject({ ok: false, errorCode: "channel_person_unreachable" });
    expect(await blocked.provider.openDirect!(CREDENTIAL, TEAM_ID)).toMatchObject({ ok: false, errorCode: "channel_person_invalid" });
    const none = make(() => jsonResponse(201, { id: "a:1x" }), { graphEnabled: true, refs: [] });
    expect(await none.provider.openDirect!(CREDENTIAL, "29:abc")).toMatchObject({ ok: false, errorCode: "channel_destination_unknown" });
    expect(none.fake.requests).toHaveLength(0);
  });
});

describe("teams inbound activity parsing", () => {
  const base = {
    channelId: "msteams",
    serviceUrl: SERVICE_URL,
    recipient: { id: `28:${APP_ID}`, name: "Agent" },
    from: { id: "29:userAAA", name: "Ana‮ Lee", aadObjectId: "0f0f0f0f-1111-4222-8333-444455556666" },
  };
  const identity = { appId: APP_ID, tenantId: TENANT_ID };

  it("stores a team install (installationUpdate add) with its team and selected channel", () => {
    const event = parseTeamsActivity(
      {
        ...base,
        type: "installationUpdate",
        action: "add",
        conversation: { id: CHANNEL_ID, conversationType: "channel", tenantId: TENANT_ID, name: "announcements" },
        channelData: { team: { id: TEAM_ID, name: "Ops\u0000" }, channel: { id: CHANNEL_ID }, tenant: { id: TENANT_ID } },
      },
      identity,
    );
    expect(event).toEqual({ kind: "install", ref: channelRef });
  });

  it("stores group and personal installs from conversationUpdate when the bot is added", () => {
    expect(
      parseTeamsActivity(
        { ...base, type: "conversationUpdate", membersAdded: [{ id: `28:${APP_ID}` }], conversation: { id: GROUP_ID, conversationType: "groupChat", tenantId: TENANT_ID, name: "Launch crew" } },
        identity,
      ),
    ).toEqual({ kind: "install", ref: groupRef });
    expect(
      parseTeamsActivity(
        { ...base, type: "conversationUpdate", membersAdded: [{ id: `28:${APP_ID}` }], conversation: { id: PERSONAL_ID, conversationType: "personal" }, channelData: { tenant: { id: TENANT_ID } } },
        identity,
      ),
    ).toEqual({ kind: "install", ref: { ...personalRef, title: "Direct chat: Ana Lee" } });
  });

  it("marks a private channel install as private", () => {
    const event = parseTeamsActivity(
      {
        ...base,
        type: "installationUpdate",
        action: "add",
        conversation: { id: PRIVATE_ID, conversationType: "channel", tenantId: TENANT_ID },
        channelData: { team: { id: TEAM_ID, name: "Ops" }, channel: { id: PRIVATE_ID, membershipType: "private" } },
      },
      identity,
    );
    expect(event).toMatchObject({ kind: "install", ref: { membership: "private" } });
  });

  it("removes the whole team on uninstall or bot removal, and one channel on channelDeleted", () => {
    const team = { conversation: { id: CHANNEL_ID, conversationType: "channel", tenantId: TENANT_ID }, channelData: { team: { id: TEAM_ID } } };
    expect(parseTeamsActivity({ ...base, ...team, type: "installationUpdate", action: "remove" }, identity)).toEqual({ kind: "uninstall", teamId: TEAM_ID });
    expect(parseTeamsActivity({ ...base, ...team, type: "conversationUpdate", membersRemoved: [{ id: `28:${APP_ID}` }] }, identity)).toEqual({ kind: "uninstall", teamId: TEAM_ID });
    expect(
      parseTeamsActivity({ ...base, ...team, type: "conversationUpdate", channelData: { team: { id: TEAM_ID }, eventType: "channelDeleted", channel: { id: "19:gone@thread.tacv2" } } }, identity),
    ).toEqual({ kind: "uninstall", conversationId: "19:gone@thread.tacv2" });
    expect(
      parseTeamsActivity({ ...base, type: "installationUpdate", action: "remove", conversation: { id: GROUP_ID, conversationType: "groupChat", tenantId: TENANT_ID } }, identity),
    ).toEqual({ kind: "uninstall", conversationId: GROUP_ID });
  });

  it("normalizes a message: thread id from the conversation id, cleaned text, no inline HTML copy", () => {
    const event = parseTeamsActivity(
      {
        ...base,
        type: "message",
        id: "1712345679000",
        text: "<at>Agent</at> please \u0007summarize\nthis",
        conversation: { id: `${CHANNEL_ID};messageid=1712345678901`, conversationType: "channel", tenantId: TENANT_ID },
        attachments: [
          { contentType: "text/html", content: "<p>copy</p>" },
          { contentType: "image/png", contentUrl: "https://contoso.sharepoint.com/a.png", name: "a.png" },
          { contentType: "application/pdf", contentUrl: "http://insecure.example/b.pdf", name: "b\u0000.pdf" },
        ],
      },
      identity,
    );
    expect(event).toEqual({
      kind: "message",
      message: {
        platform: "teams",
        channelId: CHANNEL_ID,
        threadId: "1712345678901",
        messageId: "1712345679000",
        senderUserId: "29:userAAA",
        senderDisplay: "Ana Lee",
        text: "<at>Agent</at> please  summarize\nthis",
        attachments: [
          { id: "1712345679000:0", name: "a.png", contentType: "image/png", bytes: 0 },
          { id: "1712345679000:1", name: "b .pdf", contentType: "application/pdf", bytes: 0 },
        ],
      },
    });
  });

  it("ignores foreign tenants, other bots, other channels, unlisted service URLs and the bot's own messages", () => {
    const message = { ...base, type: "message", id: "1", text: "x", conversation: { id: GROUP_ID, conversationType: "groupChat", tenantId: TENANT_ID } };
    expect(parseTeamsActivity({ ...message, conversation: { ...message.conversation, tenantId: "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee" } }, identity)).toEqual({ kind: "ignored", reason: "tenant" });
    expect(parseTeamsActivity({ ...message, recipient: { id: "28:other" } }, identity)).toEqual({ kind: "ignored", reason: "recipient" });
    expect(parseTeamsActivity({ ...message, channelId: "slack" }, identity)).toEqual({ kind: "ignored", reason: "not_teams" });
    expect(parseTeamsActivity({ ...message, serviceUrl: "https://evil.example/teams/" }, identity)).toEqual({ kind: "ignored", reason: "service_url" });
    expect(parseTeamsActivity({ ...message, serviceUrl: "http://smba.trafficmanager.net/amer/" }, identity)).toEqual({ kind: "ignored", reason: "service_url" });
    expect(parseTeamsActivity({ ...message, from: { id: `28:${APP_ID}` } }, identity)).toEqual({ kind: "ignored", reason: "own_message" });
    expect(parseTeamsActivity({ ...message, type: "typing" }, identity)).toEqual({ kind: "ignored", reason: "activity_type" });
    expect(parseTeamsActivity("nope", identity)).toEqual({ kind: "ignored", reason: "not_an_activity" });
  });
});

import { describe, expect, it } from "vitest";

import { BUZZ_BRIDGE_CHANNEL_PREFIX, BUZZ_KIND, checkBuzzCredential, createBuzzProvider, encodeBuzzCredential, normalizeRelayUrl, parseBuzzEvent, renderBuzzText } from "./buzz.js";
import { createFakeBuzzRelay, signAuthTag } from "./buzz-test-relay.js";
import { generateSecretKey, npubEncode, publicKeyOf, signEvent, verifyEvent, type NostrEvent } from "./nostr.js";
import { attachment, createFakeClock, jsonResponse } from "./test-support.js";

const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = publicKeyOf(OWNER_SECRET)!;
const START_MS = 1_790_000_000_000;
const START = START_MS / 1000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function setup(input: { conditions?: string; withTag?: boolean } = {}) {
  const clock = createFakeClock(START_MS);
  const relay = createFakeBuzzRelay({ members: [OWNER], now: clock.now });
  const provider = createBuzzProvider({ fetchImpl: relay.fetchImpl, now: clock.now, sleep: clock.sleep, timeoutMs: 50 });
  const secret = generateSecretKey();
  const agent = publicKeyOf(secret)!;
  const aliceSecret = generateSecretKey();
  const alice = publicKeyOf(aliceSecret)!;
  const bobSecret = generateSecretKey();
  const bob = publicKeyOf(bobSecret)!;
  const tag = signAuthTag(OWNER_SECRET, agent, input.conditions ?? `created_at<${START + 30 * 86_400}`);
  const credential = encodeBuzzCredential({ secretKey: secret, relayUrl: relay.relayUrl, authTag: input.withTag === false ? null : tag });
  const channel = relay.createGroup({ name: "general", members: [alice, agent, bob] });
  relay.inject(aliceSecret, { kind: 0, tags: [], content: JSON.stringify({ name: "alice", display_name: "Alice A" }) });
  relay.inject(bobSecret, { kind: 0, tags: [], content: JSON.stringify({ name: "bob", display_name: "Bob" }) });
  const destination = { type: "channel" as const, externalId: channel, title: "#general" };
  const outputs: unknown[] = [];
  const seen = <T>(value: T): T => {
    outputs.push(value);
    return value;
  };
  return { clock, relay, provider, secret, agent, aliceSecret, alice, bob, bobSecret, tag, credential, channel, destination, outputs, seen };
}

/** The agent key (and its credential) never appear in results or anything sent to the relay. */
function expectNoSecret(t: ReturnType<typeof setup>) {
  const everything = JSON.stringify([t.outputs, t.relay.requests, t.relay.events]);
  expect(everything).not.toContain(t.secret);
  expect(everything).not.toContain(t.credential);
}

const lastEvent = (t: ReturnType<typeof setup>, kind: number): NostrEvent => t.relay.eventsOfKind(kind).filter((event) => event.pubkey === t.agent).at(-1)!;

describe("buzz credential", () => {
  it("normalises the owner's relay URL and refuses anything but wss://host", () => {
    expect(normalizeRelayUrl("wss://martinatrin.up.railway.app/")).toEqual({ relayUrl: "wss://martinatrin.up.railway.app", httpBase: "https://martinatrin.up.railway.app", host: "martinatrin.up.railway.app" });
    expect(normalizeRelayUrl("wss://relay.example:8443")?.httpBase).toBe("https://relay.example:8443");
    for (const bad of ["ws://relay.example", "https://relay.example", "wss://user:pw@relay.example", "wss://relay.example/path", "wss://relay.example?x=1", "relay.example", ""]) {
      expect(normalizeRelayUrl(bad), bad).toBeNull();
    }
  });

  it("reports missing and invalid credentials without network", async () => {
    const t = setup({ withTag: false });
    expect(checkBuzzCredential(null, START)).toMatchObject({ ok: false, reason: "credential_missing" });
    expect(checkBuzzCredential(t.credential, START)).toMatchObject({ ok: false, reason: "credential_missing" });
    expect(t.seen(await t.provider.verify(t.credential))).toEqual({ ok: false, reason: "credential_missing" });
    const expired = setup({ conditions: `created_at<${START - 1}` });
    expect(expired.seen(await expired.provider.verify(expired.credential))).toEqual({ ok: false, reason: "credential_invalid" });
    expect(expired.relay.requests).toHaveLength(0);
    expect(checkBuzzCredential("buzz1.not-base64-json", START)).toMatchObject({ ok: false, reason: "credential_invalid" });
    expectNoSecret(t);
  });
});

describe("buzz verify and discover", () => {
  it("verifies with NIP-11 and an authenticated no-op query carrying NIP-98 and the NIP-OA header", async () => {
    const t = setup();
    expect(t.seen(await t.provider.verify(t.credential))).toEqual({ ok: true, botId: t.agent, botUsername: expect.stringMatching(/^npub1.{7}….{6}$/u) });
    const [info, probe] = t.relay.requests;
    expect(info).toMatchObject({ method: "GET", path: "/", headers: { accept: "application/nostr+json" } });
    expect(probe).toMatchObject({ method: "POST", path: "/query" });
    expect(JSON.parse(probe!.headers["x-auth-tag"]!)).toEqual(t.tag);
    const nip98 = JSON.parse(Buffer.from(probe!.headers.authorization!.slice(6), "base64").toString("utf8"));
    expect(nip98).toMatchObject({ kind: 27235, pubkey: t.agent });
    expect(JSON.parse(probe!.body!)).toEqual([{ kinds: [0], authors: [t.agent], limit: 1 }]);
    expectNoSecret(t);
  });

  it("classifies verify failures: not a relay member is credential_invalid, 5xx is provider_unavailable", async () => {
    const t = setup();
    t.relay.removeMember(OWNER);
    expect(await t.provider.verify(t.credential)).toEqual({ ok: false, reason: "credential_invalid" });
    t.relay.addMember(OWNER);
    t.relay.override(() => jsonResponse(502, { error: "bad gateway" }));
    expect(await t.provider.verify(t.credential)).toEqual({ ok: false, reason: "provider_unavailable" });
  });

  it("discovers the agent's channels (member lists), private groups and DMs, leaving out bridge and archived channels", async () => {
    const t = setup();
    const privateGroup = t.relay.createGroup({ name: "core-team", members: [t.agent, t.alice], private: true });
    const dm = t.relay.createGroup({ name: "", members: [t.agent, t.alice], hidden: true, private: true });
    t.relay.createGroup({ name: `${BUZZ_BRIDGE_CHANNEL_PREFIX}slack-general`, members: [t.agent], private: true });
    t.relay.createGroup({ name: "not-mine", members: [t.alice] });
    const result = t.seen(await t.provider.discover(t.credential));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.destinations).toEqual(
      expect.arrayContaining([
        { type: "channel", externalId: t.channel, title: "#general" },
        { type: "group", externalId: privateGroup, title: "#core-team" },
        { type: "person", externalId: dm, title: "Direct message" },
      ]),
    );
    expect(result.destinations).toHaveLength(3);
    expect(result.notes).toEqual(["1 private inbound bridge channel(s) created by Marketplace are not listed."]);
    const membership = JSON.parse(t.relay.requests.find((request) => request.body?.includes("39002"))!.body!);
    expect(membership).toEqual([{ kinds: [39002], "#p": [t.agent], limit: 500 }]);
  });
});

describe("buzz send", () => {
  it("sends a kind-9 message with the h tag and the NIP-OA tag, signed correctly (id recomputed, Schnorr verified)", async () => {
    const t = setup();
    const result = t.seen(await t.provider.send(t.credential, t.destination, { text: "Meetup on Friday" }));
    expect(result).toMatchObject({ status: "sent", resultIds: [expect.stringMatching(/^[0-9a-f]{64}$/u)] });
    const event = lastEvent(t, BUZZ_KIND.message);
    expect(event.id).toBe(result.resultIds[0]);
    expect(t.relay.contractValid(event)).toBe(true);
    expect(event.content).toBe("Meetup on Friday");
    expect(event.tags).toEqual([["h", t.channel], t.tag]);
    expect(event.tags.filter((tag) => tag[0] === "p")).toEqual([]);
    const submit = t.relay.requests.find((request) => request.path === "/events")!;
    expect(submit.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(submit.body!)).toEqual(event);
    expectNoSecret(t);
  });

  it("p-tags only listed mentions and neutralises text that would create mentions (no broadcast)", async () => {
    const t = setup();
    const text = `Hi @everyone and @here, ping nostr:${npubEncode(t.bob)} and nostr:${npubEncode(t.alice)}; (@channel) @all-hands stays`;
    const result = await t.provider.send(t.credential, t.destination, { text, mentions: [{ userId: npubEncode(t.alice) }] });
    expect(result.status).toBe("sent");
    const event = lastEvent(t, BUZZ_KIND.message);
    expect(event.tags.filter((tag) => tag[0] === "p")).toEqual([["p", t.alice]]);
    expect(event.tags.some((tag) => tag[0] === "broadcast")).toBe(false);
    expect(event.content).toContain(`nostr:${npubEncode(t.alice)}`);
    expect(event.content).not.toContain(`nostr:${npubEncode(t.bob)}`);
    expect(event.content).toContain(npubEncode(t.bob));
    expect(event.content).not.toMatch(/@(everyone|here|channel)\b/u);
    expect(event.content).toContain("＠everyone");
    expect(event.content).toContain("@all-hands");
    // A listed mention not in the text is put first.
    expect(renderBuzzText("hello", [{ userId: t.bob }])).toEqual({ ok: true, text: `nostr:${npubEncode(t.bob)} hello`, pubkeys: [t.bob] });
    expect(await t.provider.send(t.credential, t.destination, { text: "x", mentions: [{ userId: "U12345" }] })).toMatchObject({ status: "failed", errorCode: "channel_mention_invalid" });
    expect(await t.provider.send(t.credential, t.destination, { text: "x", mentions: [{ userId: t.agent }] })).toMatchObject({ status: "failed", errorCode: "channel_mention_invalid" });
  });

  it("replies with NIP-10 markers (direct and nested) and refuses an unknown parent before posting", async () => {
    const t = setup();
    const root = t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.channel]], content: "root" });
    expect((await t.provider.send(t.credential, t.destination, { text: "direct", replyTo: root.id })).status).toBe("sent");
    expect(lastEvent(t, 9).tags).toEqual([["h", t.channel], ["e", root.id, "", "reply"], t.tag]);
    const child = t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.channel], ["e", root.id, "", "reply"]], content: "child" });
    expect((await t.provider.send(t.credential, t.destination, { text: "nested", replyTo: child.id })).status).toBe("sent");
    expect(lastEvent(t, 9).tags).toEqual([["h", t.channel], ["e", root.id, "", "root"], ["e", child.id, "", "reply"], t.tag]);
    const before = t.relay.events.length;
    expect(await t.provider.send(t.credential, t.destination, { text: "lost", replyTo: "ab".repeat(32) })).toMatchObject({ status: "failed", errorCode: "channel_reply_invalid" });
    expect(await t.provider.send(t.credential, t.destination, { text: "bad", replyTo: "1700000000.000100" })).toMatchObject({ status: "failed", errorCode: "channel_reply_invalid" });
    expect(t.relay.events.length).toBe(before);
  });

  it("uploads images through Blossom (kind 24242 auth verified by the relay) and adds imeta tags", async () => {
    const t = setup();
    const image = attachment("chart.png", "image/png", PNG);
    const result = await t.provider.send(t.credential, t.destination, { text: "Chart", attachments: [image] });
    expect(result.status).toBe("sent");
    const upload = t.relay.requests.find((request) => request.path === "/media/upload")!;
    expect(upload.method).toBe("PUT");
    expect(upload.headers["x-sha-256"]).toBe(image.sha256);
    expect(JSON.parse(upload.headers["x-auth-tag"]!)).toEqual(t.tag);
    const auth = JSON.parse(Buffer.from(upload.headers.authorization!.slice(6), "base64url").toString("utf8"));
    expect(verifyEvent(auth)).toBe(true);
    expect(auth.tags).toEqual(expect.arrayContaining([["t", "upload"], ["x", image.sha256], ["server", t.relay.host]]));
    const event = lastEvent(t, 9);
    expect(event.tags).toContainEqual(["imeta", `url ${t.relay.httpBase}/media/${image.sha256}.png`, "m image/png", `x ${image.sha256}`, `size ${PNG.byteLength}`, "dim 2x2"]);
    expect(event.content).toBe(`Chart\n![image](${t.relay.httpBase}/media/${image.sha256}.png)`);
  });

  it("declares only verified media: PDF, text and audio are refused before any request; big GIFs too", async () => {
    const t = setup();
    expect(t.provider.capabilities.file).toBe(false);
    expect(t.provider.capabilities.audio).toBe(false);
    expect(t.provider.capabilities.voice).toBe(false);
    expect(t.provider.capabilities.canvas).toBe(false);
    expect(t.provider.capabilities.image && t.provider.capabilities.image.types).toEqual(["image/jpeg", "image/png", "image/gif", "image/webp"]);
    expect(t.provider.capabilities.video && t.provider.capabilities.video.types).toEqual(["video/mp4"]);
    expect(t.provider.capabilities.mentions).toEqual({ users: true, broadcast: "suppressed" });
    expect(t.provider.capabilities.inbound).toEqual({ mode: "socket", dedupe: true });
    expect(await t.provider.send(t.credential, t.destination, { text: "doc", attachments: [attachment("a.pdf", "application/pdf", "%PDF-1.4")] })).toMatchObject({ errorCode: "channel_capability_unavailable" });
    expect(await t.provider.send(t.credential, t.destination, { text: "a", attachments: [attachment("a.ogg", "audio/ogg", "OggS")] })).toMatchObject({ errorCode: "channel_capability_unavailable" });
    const gif = attachment("big.gif", "image/gif", new Uint8Array(10 * 1024 * 1024 + 1));
    expect(await t.provider.send(t.credential, t.destination, { text: "gif", attachments: [gif] })).toMatchObject({ errorCode: "channel_file_too_large" });
    expect(t.relay.requests).toHaveLength(0);
  });

  it("handles relay accepted=false as failed with the relay's scrubbed reason", async () => {
    const t = setup();
    t.relay.rejectKind(9, `restricted: rate limited for ${t.credential} and ${t.secret}`);
    const result = t.seen(await t.provider.send(t.credential, t.destination, { text: "hi" }));
    expect(result).toMatchObject({ status: "failed", errorCode: "provider_rejected", detail: expect.stringContaining("relay: restricted: rate limited") });
    expect(result.detail).toContain("[redacted]");
    expectNoSecret(t);
  });

  it("classifies HTTP failures: 401 credential_invalid, 403 forbidden, 400 rejected, 503 failed, 500/timeout/network uncertain, 429 retried once", async () => {
    const t = setup();
    const cases: Array<[Response | Error | "hang", { status: string; errorCode: string }]> = [
      [jsonResponse(401, { error: "NIP-98: invalid" }), { status: "failed", errorCode: "credential_invalid" }],
      [jsonResponse(403, { error: "restricted: not a member" }), { status: "failed", errorCode: "provider_forbidden" }],
      [jsonResponse(400, { error: "invalid: content too long" }), { status: "failed", errorCode: "provider_rejected" }],
      [jsonResponse(503, { error: "rate-limited: shared admission unavailable" }), { status: "failed", errorCode: "provider_unavailable" }],
      [jsonResponse(500, { error: "internal server error" }), { status: "uncertain", errorCode: "provider_unexpected_status" }],
      ["hang", { status: "uncertain", errorCode: "provider_timeout" }],
      [Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), { status: "uncertain", errorCode: "provider_timeout" }],
    ];
    for (const [reply, expected] of cases) {
      t.relay.override((request) => (request.path === "/events" ? reply : undefined));
      expect(t.seen(await t.provider.send(t.credential, t.destination, { text: "x" }))).toMatchObject(expected);
      t.clock.advance(60_000);
    }
    t.relay.override((request) => (request.path === "/events" ? jsonResponse(429, { error: "rate-limited" }, { "retry-after": "2" }) : undefined));
    expect(await t.provider.send(t.credential, t.destination, { text: "after 429" })).toMatchObject({ status: "sent" });
    expect(t.clock.sleeps).toContain(2000);
    expectNoSecret(t);
  });

  it("keeps a client-side bucket under the relay's 120 messages a minute", async () => {
    const t = setup();
    for (let index = 0; index < 10; index += 1) expect((await t.provider.send(t.credential, t.destination, { text: `m${index}` })).status).toBe("sent");
    const before = t.clock.now();
    expect((await t.provider.send(t.credential, t.destination, { text: "m10" })).status).toBe("sent");
    expect(t.clock.now() - before).toBeGreaterThanOrEqual(500);
    expect(t.relay.eventsOfKind(9).filter((event) => event.pubkey === t.agent)).toHaveLength(11);
  });

  it("refuses a kind the owner's tag does not authorise and an expired tag at send time", async () => {
    const onlyChat = setup({ conditions: `kind=9&created_at<${START + 86_400}` });
    expect((await onlyChat.provider.send(onlyChat.credential, onlyChat.destination, { text: "ok" })).status).toBe("sent");
    const root = lastEvent(onlyChat, 9);
    expect(await onlyChat.provider.react!(onlyChat.credential, onlyChat.destination, root.id, "👍")).toMatchObject({ status: "failed", errorCode: "buzz_auth_kind_not_allowed" });
    const t = setup({ conditions: `created_at<${START + 60}` });
    t.clock.advance(61_000);
    expect(await t.provider.send(t.credential, t.destination, { text: "late" })).toMatchObject({ status: "failed", errorCode: "credential_invalid" });
  });
});

describe("buzz reactions, edits, deletes, typing", () => {
  it("adds a reaction (kind 7) and removes it with a kind-5 deletion of the identity's own reaction", async () => {
    const t = setup();
    const message = t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.channel]], content: "news" });
    expect(await t.provider.react!(t.credential, t.destination, message.id, "🎉")).toEqual({ status: "sent" });
    const reaction = lastEvent(t, 7);
    expect(reaction.content).toBe("🎉");
    expect(reaction.tags).toEqual([["e", message.id], ["h", t.channel], t.tag]);
    expect(reaction.tags.some((tag) => tag[0] === "p")).toBe(false);
    expect(await t.provider.react!(t.credential, t.destination, message.id, "🎉", { remove: true })).toEqual({ status: "sent" });
    expect(lastEvent(t, 5).tags).toEqual([["e", reaction.id], ["h", t.channel], t.tag]);
    expect(t.relay.events.some((event) => event.id === reaction.id)).toBe(false);
    expect(await t.provider.react!(t.credential, t.destination, message.id, "🎉", { remove: true })).toEqual({ status: "sent", detail: "the reaction was not there" });
    // Two matching reactions (e.g. sent twice): one single-target kind 5 each (Buzz rejects multi-target deletes).
    await t.provider.react!(t.credential, t.destination, message.id, "👍");
    await t.provider.react!(t.credential, t.destination, message.id, "👍");
    const deletionsBefore = t.relay.eventsOfKind(5).length;
    expect(await t.provider.react!(t.credential, t.destination, message.id, "👍", { remove: true })).toEqual({ status: "sent" });
    const deletions = t.relay.eventsOfKind(5).slice(deletionsBefore);
    expect(deletions).toHaveLength(2);
    for (const deletion of deletions) expect(deletion.tags.filter((tag) => tag[0] === "e")).toHaveLength(1);
    expect(await t.provider.react!(t.credential, t.destination, message.id, ":custom:")).toMatchObject({ errorCode: "channel_reaction_invalid" });
    expect(await t.provider.react!(t.credential, t.destination, "nope", "👍")).toMatchObject({ errorCode: "channel_message_id_invalid" });
  });

  it("edits (kind 40003) and deletes (kind 5) only the agent's own messages", async () => {
    const t = setup();
    const sent = await t.provider.send(t.credential, t.destination, { text: "draft @everyone" });
    const own = sent.resultIds[0]!;
    expect(await t.provider.edit!(t.credential, t.destination, own, { text: "final @here" })).toEqual({ status: "sent", resultIds: [own], resultUrls: [] });
    const edit = lastEvent(t, 40003);
    expect(edit.tags).toEqual([["h", t.channel], ["e", own], t.tag]);
    expect(edit.content).toBe("final ＠here");
    const theirs = t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.channel]], content: "alice" });
    expect(await t.provider.edit!(t.credential, t.destination, theirs.id, { text: "hijack" })).toMatchObject({ status: "failed", errorCode: "provider_forbidden" });
    expect(await t.provider.edit!(t.credential, t.destination, own, { text: "x", mentions: [{ userId: t.alice }] })).toMatchObject({ errorCode: "channel_mention_invalid" });
    expect(await t.provider.remove!(t.credential, t.destination, theirs.id)).toMatchObject({ status: "failed", errorCode: "provider_forbidden" });
    expect(await t.provider.remove!(t.credential, t.destination, own)).toEqual({ status: "sent" });
    expect(lastEvent(t, 5).tags).toEqual([["h", t.channel], ["e", own], t.tag]);
    expect(await t.provider.remove!(t.credential, t.destination, own)).toMatchObject({ status: "failed", errorCode: "provider_not_found" });
  });

  it("sends a typing signal (kind 20002) at most once per 5 s per channel", async () => {
    const t = setup();
    expect(await t.provider.typing(t.credential, t.destination)).toEqual({ status: "sent" });
    const typing = JSON.parse(t.relay.requests.filter((request) => request.path === "/events").at(-1)!.body!);
    expect(typing).toMatchObject({ kind: 20002, tags: [["h", t.channel], t.tag] });
    expect(await t.provider.typing(t.credential, t.destination)).toEqual({ status: "sent", detail: "a typing signal was sent recently" });
  });
});

describe("buzz people and DMs", () => {
  it("finds one member by npub or exact name, never a list; refuses email and non-members", async () => {
    const t = setup();
    expect(t.seen(await t.provider.findPerson!(t.credential, { handle: npubEncode(t.alice) }))).toEqual({ ok: true, userId: t.alice, displayName: "Alice A" });
    expect(await t.provider.findPerson!(t.credential, { handle: "alice a" })).toEqual({ ok: true, userId: t.alice, displayName: "Alice A" });
    expect(await t.provider.findPerson!(t.credential, { handle: "@bob" })).toEqual({ ok: true, userId: t.bob, displayName: "Bob" });
    expect(await t.provider.findPerson!(t.credential, { handle: "carol" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await t.provider.findPerson!(t.credential, { handle: npubEncode(publicKeyOf(generateSecretKey())!) })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await t.provider.findPerson!(t.credential, { email: "alice@example.com" })).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    const twinSecret = generateSecretKey();
    t.relay.inject(twinSecret, { kind: 9, tags: [["h", t.channel]], content: "hi" });
    t.relay.createGroup({ name: "twins", members: [t.agent, publicKeyOf(twinSecret)!] });
    t.relay.inject(twinSecret, { kind: 0, tags: [], content: JSON.stringify({ name: "Bob" }) });
    expect(await t.provider.findPerson!(t.credential, { handle: "bob" })).toMatchObject({ ok: false, reason: "ambiguous" });
  });

  it("opens a Buzz DM (kind 41010) with one named member and returns the relay's DM channel id", async () => {
    const t = setup();
    const opened = t.seen(await t.provider.openDirect!(t.credential, npubEncode(t.alice)));
    expect(opened).toMatchObject({ ok: true, destination: { type: "person", personId: t.alice } });
    if (!opened.ok) return;
    const dm = lastEvent(t, 41010);
    expect(dm.tags.filter((tag) => tag[0] === "p")).toEqual([["p", t.alice]]);
    expect(dm.tags).toContainEqual(t.tag);
    expect(t.relay.groups.get(opened.destination.externalId)?.hidden).toBe(true);
    // The DM is a normal destination for send.
    expect((await t.provider.send(t.credential, opened.destination, { text: "hello Alice" })).status).toBe("sent");
    const again = await t.provider.openDirect!(t.credential, t.alice);
    expect(again.ok && again.destination.externalId).toBe(opened.destination.externalId);
    expect(await t.provider.openDirect!(t.credential, t.agent)).toMatchObject({ ok: false, errorCode: "person_query_invalid" });
    expectNoSecret(t);
  });
});

describe("buzz inbound parsing", () => {
  it("parses a verified kind-9 event, its thread root and imeta attachments; ignores own, forged and other kinds", () => {
    const t = setup();
    const root = "cd".repeat(32);
    const sha = "ef".repeat(32);
    const event = signEvent(t.aliceSecret, {
      kind: 9,
      created_at: START,
      tags: [["h", t.channel], ["e", root, "", "root"], ["e", "aa".repeat(32), "", "reply"], ["imeta", `url https://x/${sha}.png`, "m image/png", `x ${sha}`, "size 12"]],
      content: "hello\u0007 world",
    });
    expect(parseBuzzEvent(event, { selfPubkey: t.agent })).toEqual({
      kind: "message",
      createdAt: START,
      message: {
        platform: "buzz",
        channelId: t.channel,
        threadId: root,
        messageId: event.id,
        senderUserId: t.alice,
        senderDisplay: expect.stringMatching(/^npub1/u),
        text: "hello world",
        attachments: [{ id: sha, name: "image", contentType: "image/png", bytes: 12 }],
      },
    });
    expect(parseBuzzEvent({ ...event, content: "forged" })).toEqual({ kind: "ignored", reason: "invalid_event" });
    expect(parseBuzzEvent(signEvent(t.secret, { kind: 9, created_at: START, tags: [["h", t.channel]], content: "own" }), { selfPubkey: t.agent })).toEqual({ kind: "ignored", reason: "own_message" });
    expect(parseBuzzEvent(signEvent(t.aliceSecret, { kind: 7, created_at: START, tags: [["e", root]], content: "+" }))).toEqual({ kind: "ignored", reason: "unsupported_kind" });
    expect(parseBuzzEvent(signEvent(t.aliceSecret, { kind: 9, created_at: START, tags: [], content: "x" }))).toEqual({ kind: "ignored", reason: "malformed" });
  });
});

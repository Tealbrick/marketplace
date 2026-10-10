import { describe, expect, it } from "vitest";

import { createBuzzRelaySocket, type BuzzSocketStatus } from "./buzz-relay-socket.js";
import type { Timers } from "./discord-gateway.js";
import { createFakeBuzzRelay, signAuthTag, signTestEvent, type FakeRelaySocket } from "./providers/buzz-test-relay.js";
import { encodeBuzzCredential } from "./providers/buzz.js";
import { generateSecretKey, publicKeyOf, signEvent, verifyEvent } from "./providers/nostr.js";
import type { InboundMessage } from "./providers/types.js";

const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = publicKeyOf(OWNER_SECRET)!;
const START_MS = 1_790_000_000_000;
const START = START_MS / 1000;

function fakeTimers(): Timers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout: (callback, ms) => {
      const id = next++;
      queue.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => void queue.delete(handle as number),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    pending: () => queue.size,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(input: { conditions?: string; leaseFree?: () => boolean; ignore?: Set<string>; authorized?: () => boolean; pinnedOwner?: () => string | null; selfPubkey?: string } = {}) {
  let clock = START_MS;
  const relay = createFakeBuzzRelay({ members: [OWNER], now: () => clock });
  const secret = generateSecretKey();
  const agent = publicKeyOf(secret)!;
  const aliceSecret = generateSecretKey();
  const alice = publicKeyOf(aliceSecret)!;
  const tag = signAuthTag(OWNER_SECRET, agent, input.conditions ?? `created_at<${START + 30 * 86_400}`);
  const credential = encodeBuzzCredential({ secretKey: secret, relayUrl: relay.relayUrl, authTag: tag });
  const general = relay.createGroup({ name: "general", members: [agent, alice] });
  const other = relay.createGroup({ name: "other", members: [agent, alice] });
  const timers = fakeTimers();
  const messages: InboundMessage[] = [];
  const statuses: Array<{ status: BuzzSocketStatus; detail?: string }> = [];
  const membership: Array<{ added: boolean; channelId: string }> = [];
  let releases = 0;
  const socket = createBuzzRelaySocket({
    credential,
    channelIds: [general],
    lease: { acquire: input.leaseFree ?? (() => true), release: () => void (releases += 1) },
    onMessage: (message) => messages.push(message),
    onStatus: (status, detail) => statuses.push({ status, ...(detail ? { detail } : {}) }),
    onMembership: (change) => membership.push(change),
    socketFactory: relay.socketFactory,
    timers,
    random: () => 0,
    now: () => clock,
    ...(input.ignore ? { ignoreAuthors: () => input.ignore! } : {}),
    ...(input.authorized ? { authorized: input.authorized } : {}),
    ...(input.pinnedOwner ? { pinnedOwner: input.pinnedOwner } : {}),
    ...(input.selfPubkey ? { selfPubkey: input.selfPubkey } : {}),
  });
  return {
    relay,
    secret,
    agent,
    aliceSecret,
    alice,
    tag,
    credential,
    general,
    other,
    timers,
    messages,
    statuses,
    membership,
    socket,
    get releases() {
      return releases;
    },
    advanceClock: (ms: number) => void (clock += ms),
    last: () => relay.sockets.at(-1) as FakeRelaySocket,
  };
}

describe("buzz relay socket", () => {
  it("authenticates with NIP-42 (agent key + the owner's NIP-OA tag) and subscribes per Buzz rules", async () => {
    const t = setup();
    t.socket.start();
    await flush();
    const ws = t.last();
    expect(ws.url).toBe(t.relay.relayUrl);
    const auth = ws.sent.find((frame) => frame[0] === "AUTH")![1] as { kind: number; pubkey: string; tags: string[][] };
    expect(verifyEvent(auth)).toBe(true);
    expect(auth.kind).toBe(22242);
    expect(auth.pubkey).toBe(t.agent);
    expect(auth.tags).toEqual([["relay", t.relay.relayUrl], ["challenge", ws.challenge], t.tag]);
    expect(ws.authed).toBe(t.agent);
    expect(t.socket.status).toBe("ready");
    const reqs = ws.sent.filter((frame) => frame[0] === "REQ");
    expect(reqs).toEqual([
      ["REQ", "tb-channels", { kinds: [9], "#h": [t.general], since: START }],
      ["REQ", "tb-membership", { kinds: [44100, 44101], "#p": [t.agent], since: START }],
    ]);
    // The fake relay refuses filters that break the rules, so none was CLOSED.
    expect(ws.received.some((frame) => frame[0] === "CLOSED")).toBe(false);
    expect(JSON.stringify(ws.sent)).not.toContain(t.secret);
  });

  it("feeds channel messages to the pipeline; ignores own events, other channels and forged events", async () => {
    const t = setup();
    t.socket.start();
    await flush();
    const inbound = t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.general]], content: "hello agent" });
    t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.other]], content: "elsewhere" });
    t.relay.inject(t.secret, { kind: 9, tags: [["h", t.general]], content: "own echo" });
    const forged = { ...signEvent(t.aliceSecret, { kind: 9, created_at: START, tags: [["h", t.general]], content: "real" }), content: "forged" };
    t.relay.pushRaw("tb-channels", forged);
    expect(t.messages).toEqual([
      expect.objectContaining({ platform: "buzz", channelId: t.general, messageId: inbound.id, senderUserId: t.alice, text: "hello agent" }),
    ]);
  });

  it("follows the route set with setChannels and reports membership changes", async () => {
    const t = setup();
    t.socket.start();
    await flush();
    t.socket.setChannels([t.general, t.other]);
    const ws = t.last();
    expect(ws.sent.filter((frame) => frame[0] === "REQ" && frame[1] === "tb-channels").at(-1)).toEqual(["REQ", "tb-channels", { kinds: [9], "#h": [t.general, t.other].sort(), since: START }]);
    t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.other]], content: "now routed" });
    expect(t.messages.map((message) => message.text)).toEqual(["now routed"]);
    const dm = t.relay.createGroup({ name: "", members: [t.alice], hidden: true });
    // Alice's client adds the agent (the relay emits 44100 to the agent).
    t.relay.events.push(signTestEvent("11".repeat(32), { kind: 44100, created_at: START, tags: [["p", t.agent], ["h", dm]], content: "" }));
    t.relay.pushRaw("tb-membership", t.relay.events.at(-1));
    expect(t.membership).toEqual([{ added: true, channelId: dm }]);
  });

  it("reconnects with backoff after a drop and resubscribes from the last event time minus 30 s", async () => {
    const t = setup();
    t.socket.start();
    await flush();
    t.advanceClock(5_000);
    const seen = t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.general]], content: "before drop" });
    t.last().drop(1006);
    expect(t.socket.status).toBe("backoff");
    t.timers.advance(500);
    await flush();
    expect(t.relay.sockets).toHaveLength(2);
    expect(t.socket.status).toBe("ready");
    const req = t.last().sent.find((frame) => frame[0] === "REQ" && frame[1] === "tb-channels")!;
    expect(req[2]).toMatchObject({ since: seen.created_at - 30 });
    // The replayed event is delivered again; the pipeline de-duplicates it by message id.
    expect(t.messages.filter((message) => message.messageId === seen.id).length).toBeGreaterThanOrEqual(1);
  });

  it("waits while another instance holds the consumer lease, and stops for good on a tag the relay refuses that no longer verifies", async () => {
    let free = false;
    const waiting = setup({ leaseFree: () => free });
    waiting.socket.start();
    await flush();
    expect(waiting.socket.status).toBe("waiting_lease");
    expect(waiting.relay.sockets).toHaveLength(0);
    free = true;
    waiting.timers.advance(20_000);
    await flush();
    expect(waiting.socket.status).toBe("ready");

    const expiring = setup({ conditions: `created_at<${START + 10}` });
    expiring.socket.start();
    await flush();
    expect(expiring.socket.status).toBe("ready");
    expiring.advanceClock(20_000);
    expiring.relay.removeMember(OWNER);
    expiring.last().drop(1006);
    expiring.timers.advance(1000);
    await flush();
    expect(expiring.socket.status).toBe("failed");
    expect(expiring.socket.detail).toBe("auth_tag_invalid");
    expect(expiring.releases).toBe(1);
  });

  it("backs off and retries when the relay rejects AUTH (owner not a member) while the tag is still valid", async () => {
    const t = setup();
    t.relay.removeMember(OWNER);
    t.socket.start();
    await flush();
    expect(t.last().received.find((frame) => frame[0] === "OK")).toEqual(["OK", expect.any(String), false, "restricted: owner is not a relay member"]);
    expect(t.socket.status).toBe("backoff");
    expect(t.socket.detail).toBe("auth_rejected");
    t.relay.addMember(OWNER);
    t.timers.advance(1000);
    await flush();
    expect(t.socket.status).toBe("ready");
    t.socket.stop();
    expect(t.socket.status).toBe("stopped");
    expect(t.releases).toBe(1);
  });

  it("I4/I5: drops routed agents' events, stops at the tag's end date, when the identity becomes unavailable, and refuses a tag for another pinned owner", async () => {
    const agentSecret = generateSecretKey();
    const agentKey = publicKeyOf(agentSecret)!;
    const t = setup({ ignore: new Set([agentKey]) });
    t.socket.start();
    await flush();
    t.relay.inject(agentSecret, { kind: 9, tags: [["h", t.general]], content: "agent echo" });
    t.relay.inject(t.aliceSecret, { kind: 9, tags: [["h", t.general]], content: "alice" });
    expect(t.messages.map((message) => message.text)).toEqual(["alice"]);

    const expiring = setup({ conditions: `created_at<${START + 60}` });
    expiring.socket.start();
    await flush();
    expect(expiring.socket.status).toBe("ready");
    expiring.timers.advance(60_000);
    expect(expiring.socket.status).toBe("failed");
    expect(expiring.socket.detail).toBe("auth_tag_expired");

    let available = true;
    const revoked = setup({ authorized: () => available });
    revoked.socket.start();
    await flush();
    available = false;
    revoked.relay.inject(revoked.aliceSecret, { kind: 9, tags: [["h", revoked.general]], content: "after revoke" });
    expect(revoked.messages).toEqual([]);
    expect(revoked.socket.detail).toBe("identity_unavailable");

    const otherOwner = setup({ pinnedOwner: () => publicKeyOf(generateSecretKey())! });
    otherOwner.socket.start();
    await flush();
    expect(otherOwner.socket.status).toBe("failed");
    expect(otherOwner.relay.sockets).toHaveLength(0);
  });
});

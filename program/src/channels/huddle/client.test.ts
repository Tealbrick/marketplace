import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { guardedHuddleSocketFactory } from "../buzz-relay-guard.js";
import { verifyEvent, type NostrEvent } from "../providers/nostr.js";

import { createHuddleAudioClient, HUDDLE_STOP_DEADLINE_MS } from "./client.js";
import { HUDDLE_KIND, parseHuddleLifecycle } from "./events.js";
import { encodeFrame, HUDDLE_FLAG_DTX, prefixRelayFrame } from "./frame.js";
import { createFakeHuddleRelay, type FakeHuddleRelay } from "./huddle-test-relay.js";
import type { SpeakerFrame } from "./jitter.js";
import { guardedTestFactory, huddleCredential, OWNER_PUBKEY, opusPacket, waitFor } from "./test-support.js";

const PEER_A = "a1".repeat(32);
const PEER_B = "b2".repeat(32);

let relay: FakeHuddleRelay;
let port: number;
let parentId: string;
let huddleId: string;

beforeEach(async () => {
  relay = createFakeHuddleRelay({ members: [OWNER_PUBKEY] });
  port = await relay.start();
  parentId = randomUUID();
  huddleId = randomUUID();
});

afterEach(async () => {
  await relay.close();
});

function setup(input: { parentMember?: boolean; version?: 2 | 3; maxSessionMs?: number; relayOptions?: Parameters<typeof createFakeHuddleRelay>[0] } = {}) {
  const agent = huddleCredential();
  relay.addChannel(huddleId, { parentId, parentMembers: input.parentMember === false ? [] : [agent.pubkey] });
  const frames: SpeakerFrame[] = [];
  const closed: string[] = [];
  const { factory, lookups } = guardedTestFactory(port, { allowPrivate: true });
  const client = createHuddleAudioClient({
    credential: agent.credential,
    channelId: huddleId,
    parentChannelId: parentId,
    socketFactory: factory,
    ...(input.version ? { protocolVersion: input.version } : {}),
    ...(input.maxSessionMs ? { maxSessionMs: input.maxSessionMs } : {}),
    onFrame: (frame) => frames.push(frame),
    onClosed: (reason) => closed.push(reason),
  });
  return { agent, client, frames, closed, lookups };
}

describe("HuddleAudioClient against a fake relay audio endpoint", () => {
  it("authenticates with NIP-42 over the guarded socket and the relay publishes the lifecycle events", async () => {
    const { agent, client, lookups } = setup();
    const joined = await client.join();
    expect(client.state).toBe("joined");
    expect(joined.peers).toEqual([]);
    // The guarded agent resolved the owner relay host (address pinned) and the socket path is the huddle route.
    expect(lookups).toContain("relay.buzz.test");
    expect(relay.upgrades).toEqual([`/huddle/${huddleId}/audio`]);

    const conn = relay.conns[0]!;
    const auth = conn.textIn[0] as { type: string; event: NostrEvent; parent_channel_id: string; protocol_version: number };
    expect(auth.type).toBe("auth");
    expect(auth.parent_channel_id).toBe(parentId);
    expect(auth.protocol_version).toBe(2);
    expect(verifyEvent(auth.event)).toBe(true);
    expect(auth.event.kind).toBe(22242);
    expect(auth.event.pubkey).toBe(agent.pubkey);
    expect(auth.event.tags.find((tag) => tag[0] === "relay")).toEqual(["relay", "wss://relay.buzz.test"]);
    expect(auth.event.tags.find((tag) => tag[0] === "challenge")).toEqual(["challenge", conn.challenge]);
    expect(auth.event.tags.find((tag) => tag[0] === "auth")?.[1]).toBe(OWNER_PUBKEY);

    await client.leave();
    expect(client.state).toBe("closed");
    await waitFor(() => relay.events.length === 2, 2000, "left event");
    // 48101 joined and 48102 left: signed by the RELAY key, h = parent channel, p = the agent.
    const lifecycle = relay.events.map((event) => parseHuddleLifecycle(event, relay.relayPubkey));
    expect(lifecycle.map((entry) => entry?.type)).toEqual(["joined", "left"]);
    expect(relay.events.map((event) => event.kind)).toEqual([HUDDLE_KIND.joined, HUDDLE_KIND.left]);
    for (const entry of lifecycle) expect(entry).toMatchObject({ parentChannelId: parentId, huddleChannelId: huddleId, participant: agent.pubkey, signer: relay.relayPubkey });
    // A lifecycle event signed by anyone but the relay is not accepted.
    expect(parseHuddleLifecycle({ ...relay.events[0]!, pubkey: agent.pubkey }, relay.relayPubkey)).toBeNull();
    // The agent sent only the AUTH message and `leave` as text: it signs no lifecycle event itself.
    expect(conn.textIn.map((value) => (value as { type: string }).type)).toEqual(["auth", "leave"]);
  });

  it("receives per-speaker streams keyed by pubkey, reordered, and ignores unknown peers", async () => {
    const { client, frames } = setup();
    await client.join();
    const a = relay.addVirtualPeer(huddleId, PEER_A);
    const b = relay.addVirtualPeer(huddleId, PEER_B);
    await waitFor(() => client.peers.length === 2, 2000, "roster");
    const frame = (seq: number, dBov = -20) => encodeFrame({ seq, ts: seq * 960, dBov, flags: 0 }, opusPacket(seq));
    for (const seq of [100, 102, 101, 103]) a.send(frame(seq));
    for (const seq of [7, 8]) b.send(frame(seq, -127));
    // A frame from an index nobody holds is dropped.
    a.sendRaw(prefixRelayFrame(frame(1), 200, 2));
    await waitFor(() => frames.length === 6, 2000, "frames");
    expect(frames.filter((entry) => entry.speakerPubkey === PEER_A).map((entry) => entry.seq)).toEqual([100, 101, 102, 103]);
    expect(frames.filter((entry) => entry.speakerPubkey === PEER_B).map((entry) => [entry.seq, entry.dBov])).toEqual([
      [7, -127],
      [8, -127],
    ]);
    expect(frames[0]!.payload[1]).toBe(100);
    await waitFor(() => client.stats.unknownPeer === 1, 2000, "unknown peer drop");
    b.leave();
    await waitFor(() => client.peers.length === 1, 2000, "left");
    await client.stop();
  });

  it("ignores joined/left/roster entries whose pubkey is not 64 lowercase hex", async () => {
    const { client } = setup();
    await client.join();
    const bad = ["", "zz".repeat(32), "A1".repeat(32), "a1".repeat(31), "a1".repeat(33), 42];
    for (const pubkey of bad) {
      relay.sendControl(huddleId, { type: "joined", revision: 9, pubkey, peer_index: 7, epoch: 0, peers: [{ pubkey, peer_index: 8, epoch: 0 }] });
      relay.sendControl(huddleId, { type: "roster", peers: [{ pubkey, peer_index: 9, epoch: 0 }] });
      relay.sendControl(huddleId, { type: "left", revision: 10, pubkey, peer_index: 0, epoch: 0 });
    }
    const a = relay.addVirtualPeer(huddleId, PEER_A);
    await waitFor(() => client.peers.length === 1, 2000, "valid peer");
    expect(client.peers).toEqual([PEER_A]);
    // A valid roster replaces the map; a bad entry inside it is skipped.
    relay.sendControl(huddleId, { type: "roster", peers: [{ pubkey: PEER_B, peer_index: 3, epoch: 0 }, { pubkey: "nope", peer_index: 4, epoch: 0 }, { pubkey: client.selfPubkey, peer_index: 0, epoch: 0 }] });
    await waitFor(() => client.peers.join() === PEER_B, 2000, "roster");
    a.leave();
    await client.stop();
  });

  it("sends 20 ms frames with consecutive seq/ts, DTX flag and level", async () => {
    const { client } = setup();
    await client.join();
    client.sendPacket(opusPacket(1, 30), { dBov: -18 });
    client.sendPacket(opusPacket(2, 30), { dBov: -24 });
    client.sendPacket(Uint8Array.from([0xf8, 0x00]));
    const conn = relay.conns[0]!;
    await waitFor(() => conn.framesIn.length === 3, 2000, "frames at relay");
    const [first, second, third] = conn.framesIn.map((entry) => entry.header);
    expect(second!.seq).toBe((first!.seq + 1) & 0xffff);
    expect(third!.seq).toBe((first!.seq + 2) & 0xffff);
    expect(second!.ts).toBe((first!.ts + 960) >>> 0);
    expect(third!.ts).toBe((first!.ts + 1920) >>> 0);
    expect([first!.dBov, second!.dBov, third!.dBov]).toEqual([-18, -24, -127]);
    expect([first!.flags, third!.flags]).toEqual([0, HUDDLE_FLAG_DTX]);
    await client.stop();
    expect(() => client.sendPacket(opusPacket(3))).toThrow("huddle_not_joined");
  });

  it("speaks protocol v3 (epoch prefix) when asked", async () => {
    const { client, frames } = setup({ version: 3 });
    await client.join();
    const a = relay.addVirtualPeer(huddleId, PEER_A, 3);
    await waitFor(() => client.peers.length === 1, 2000, "roster");
    a.send(encodeFrame({ seq: 1, ts: 960, dBov: -10, flags: 0 }, opusPacket(9)));
    // Stale epoch for that index: dropped.
    a.sendRaw(prefixRelayFrame(encodeFrame({ seq: 2, ts: 1920, dBov: -10, flags: 0 }, opusPacket(9)), a.peer.index, 3, a.peer.epoch + 1));
    await waitFor(() => frames.length === 1 && client.stats.unknownPeer === 1, 2000, "v3 frames");
    await client.stop();
  });

  it("is refused without membership, without the parent link, with another room version, or without a relay-member owner", async () => {
    const outsider = setup({ parentMember: false });
    await expect(outsider.client.join()).rejects.toThrow("not_member");

    const agent = huddleCredential();
    relay.addChannel(huddleId, { parentId, parentMembers: [agent.pubkey] });
    const { factory } = guardedTestFactory(port, { allowPrivate: true });
    const noParent = createHuddleAudioClient({ credential: agent.credential, channelId: huddleId, socketFactory: factory });
    await expect(noParent.join()).rejects.toThrow("not_member");

    relay.addVirtualPeer(huddleId, PEER_A, 3);
    const v2 = createHuddleAudioClient({ credential: agent.credential, channelId: huddleId, parentChannelId: parentId, socketFactory: factory });
    await expect(v2.join()).rejects.toThrow("upgrade_required");

    const stranger = createFakeHuddleRelay({ members: [] });
    const strangerPort = await stranger.start();
    stranger.addChannel(huddleId, { parentId, parentMembers: [agent.pubkey] });
    const refused = createHuddleAudioClient({ credential: agent.credential, channelId: huddleId, parentChannelId: parentId, socketFactory: guardedTestFactory(strangerPort, { allowPrivate: true }).factory });
    await expect(refused.join()).rejects.toThrow("not_relay_member");
    await stranger.close();
  });

  it("refuses a private relay address in production mode before any connection", async () => {
    const agent = huddleCredential();
    relay.addChannel(huddleId, { parentId, parentMembers: [agent.pubkey] });
    // The real guarded factory: relay.buzz.test resolves to 127.0.0.1, which production rules refuse.
    const { factory, lookups } = guardedTestFactory(port, { allowPrivate: false });
    const client = createHuddleAudioClient({ credential: agent.credential, channelId: huddleId, parentChannelId: parentId, socketFactory: factory });
    await expect(client.join()).rejects.toThrow("connect_failed");
    expect(lookups).toContain("relay.buzz.test");
    expect(relay.upgrades).toEqual([]);

    // The default factory (no injection) follows the env flag: production NODE_ENV ignores the dev flag.
    const prod = createHuddleAudioClient({
      credential: huddleCredential({ relayUrl: "wss://127.0.0.1" }).credential,
      channelId: huddleId,
      parentChannelId: parentId,
      env: { NODE_ENV: "production", MARKETPLACE_CHANNELS_BUZZ_ALLOW_PRIVATE_RELAY: "1" },
    });
    const started = Date.now();
    await expect(prod.join()).rejects.toThrow("connect_failed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(relay.upgrades).toEqual([]);
    // IP literals never reach a DNS lookup, so the factory checks them before a socket exists.
    for (const address of ["127.0.0.1", "10.0.0.1", "[::1]", "169.254.169.254", "[::ffff:192.168.1.1]"]) {
      expect(() => guardedHuddleSocketFactory({ allowPrivate: false })(`wss://${address}/huddle/${huddleId}/audio`), address).toThrow("relay_address_blocked");
    }
  });

  it("stop() leaves within 5 s even when the relay ignores leave and close", async () => {
    await relay.close();
    relay = createFakeHuddleRelay({ members: [OWNER_PUBKEY], ignoreClose: true, ignoreLeave: true });
    port = await relay.start();
    const { client, closed } = setup();
    await client.join();
    const started = Date.now();
    await client.stop("revoked");
    expect(Date.now() - started).toBeLessThan(HUDDLE_STOP_DEADLINE_MS);
    expect(client.state).toBe("closed");
    expect(closed).toEqual(["revoked"]);
    expect(relay.conns[0]!.textIn.map((value) => (value as { type: string }).type)).toEqual(["auth", "leave"]);
    // Idempotent.
    await client.stop("again");
    expect(closed).toEqual(["revoked"]);
  });

  it("ends at the maximum session duration and when the relay ends the room", async () => {
    const short = setup({ maxSessionMs: 150 });
    await short.client.join();
    await waitFor(() => short.client.state === "closed", 3000, "max duration");
    expect(short.closed).toEqual(["max_duration"]);

    huddleId = randomUUID();
    const ended = setup();
    await ended.client.join();
    relay.endRoom(huddleId);
    await waitFor(() => ended.client.state === "closed", 3000, "room ended");
    expect(ended.closed).toEqual(["room_ended"]);
  });
});

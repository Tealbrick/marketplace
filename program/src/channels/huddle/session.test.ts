import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteMarketplaceStore } from "../../store.js";
import type { Timers } from "../discord-gateway.js";
import { AGENT_WIRED_FEATURES } from "../providers/capabilities.js";
import { readOggOpusPackets, writeOggOpus } from "../providers/ogg-opus.js";

import { HUDDLE_STOP_DEADLINE_MS } from "./client.js";
import { encodeFrame, HUDDLE_FLAG_DTX } from "./frame.js";
import { createFakeHuddleRelay, type FakeHuddleRelay } from "./huddle-test-relay.js";
import { createHuddleSession, type HuddleSessionOptions } from "./session.js";
import { createSpeaker } from "./speak.js";
import { createFakeSpeechProvider, guardedTestFactory, huddleCredential, OWNER_PUBKEY, waitFor } from "./test-support.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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

/** A 20 ms CELT packet carrying a 16-byte marker (to look for it on disk later). */
const markedPacket = (marker: Uint8Array, seq: number) => Uint8Array.from([0xf8, seq & 0xff, ...marker, 0x11, 0x22]);

function session(input: Partial<HuddleSessionOptions> & { speech: HuddleSessionOptions["speech"] }) {
  const agent = huddleCredential();
  relay.addChannel(huddleId, { parentId, parentMembers: [agent.pubkey] });
  const transcripts: Array<{ speakerPubkey: string; text: string; startedAt: number; endedAt: number }> = [];
  const usage: Array<{ kind: string; seconds: number }> = [];
  const value = createHuddleSession({
    credential: agent.credential,
    channelId: huddleId,
    parentChannelId: parentId,
    socketFactory: guardedTestFactory(port, { allowPrivate: true }).factory,
    modes: { listen: true },
    vad: { hangoverMs: 200 },
    language: "en",
    onTranscript: (segment) => transcripts.push(segment),
    usage: { onUsage: (entry) => usage.push(entry) },
    ...input,
  });
  return { agent, session: value, transcripts, usage };
}

/** Virtual peer speech: `speech` frames at -20 dBov then `silence` DTX frames, consecutive seq from `start`. */
function speak(peer: { send: (frame: Uint8Array) => void }, marker: Uint8Array, start: number, speech: number, silence: number) {
  for (let index = 0; index < speech + silence; index += 1) {
    const seq = start + index;
    const silent = index >= speech;
    peer.send(encodeFrame({ seq, ts: seq * 960, dBov: silent ? -127 : -20, flags: silent ? HUDDLE_FLAG_DTX : 0 }, silent ? Uint8Array.from([0xf8, 0xff, 0xfe]) : markedPacket(marker, seq)));
  }
}

/**
 * Files containing a marker, written since `since`: every file directly under `root`, and recursively under each
 * directory whose mtime moved since then (a new file or temp dir changes its parent's mtime). Unchanged trees
 * (the temp dir holds hundreds of thousands of old files) are skipped.
 */
async function scanForMarker(root: string, markers: Uint8Array[], since: number, depth = 0): Promise<string[]> {
  const hits: string[] = [];
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      const info = await stat(full);
      if (info.mtimeMs < since - 1000) continue;
      if (entry.isDirectory() && depth < 8) hits.push(...(await scanForMarker(full, markers, since, depth + 1)));
      else if (entry.isFile() && info.size <= 64 * 1024 * 1024) {
        const bytes = await readFile(full);
        if (markers.some((marker) => bytes.indexOf(marker) !== -1)) hits.push(full);
      }
    } catch {
      // Unreadable or vanished: not ours.
    }
  }
  return hits;
}

describe("huddle listen pipeline (createHuddleSession)", () => {
  it("segments each speaker by dBov, wraps utterances in Ogg/Opus, transcribes them and accounts minutes", async () => {
    const fake = createFakeSpeechProvider({ reply: (call, index) => ({ text: ` line ${index + 1} \u0007` }) });
    const { session: huddle, transcripts, usage } = session({ speech: fake.provider, concurrency: 1 });
    await huddle.join();
    const a = relay.addVirtualPeer(huddleId, PEER_A);
    const b = relay.addVirtualPeer(huddleId, PEER_B);
    await waitFor(() => huddle.peers.length === 2, 2000, "roster");
    const markerA = randomBytes(16);
    const markerB = randomBytes(16);
    speak(a, markerA, 1000, 30, 12);
    speak(b, markerB, 50, 20, 12);
    await waitFor(() => transcripts.length === 2, 3000, "transcripts");
    await huddle.idle();

    expect(transcripts.map((segment) => [segment.speakerPubkey, segment.text]).sort()).toEqual([
      [PEER_A, "line 1"],
      [PEER_B, "line 2"],
    ].sort());
    for (const segment of transcripts) expect(segment.endedAt).toBeGreaterThan(segment.startedAt);
    // Transcription call shape: one valid Ogg/Opus file per utterance (speech + 10 hangover frames), language passed.
    expect(fake.invalid).toEqual([]);
    expect(fake.transcribeCalls.map((call) => call.packets).sort()).toEqual([30, 40]);
    expect(fake.transcribeCalls.every((call) => call.language === "en" && call.firstPacketHex.startsWith("f8"))).toBe(true);
    expect(fake.maxInFlight).toBe(1);
    expect(huddle.minutesListened).toBeCloseTo((70 * 0.02) / 60, 6);
    expect(usage.filter((entry) => entry.kind === "listen").map((entry) => entry.seconds).sort()).toEqual([0.6, 0.8]);

    await huddle.stop("done");
    const receipt = huddle.receipt();
    expect(receipt).toMatchObject({ channelId: huddleId, endReason: "done", truncated: false });
    expect(receipt.heard).toHaveLength(2);
    expect(receipt.joinedAt).not.toBeNull();
    expect(receipt.leftAt).toBeGreaterThanOrEqual(receipt.joinedAt!);
    expect(JSON.stringify(receipt)).not.toContain(Buffer.from(markerA).toString("base64"));
  });

  it("refuses spending past the cap and drops utterances beyond the queue bound", async () => {
    const fake = createFakeSpeechProvider();
    let allowed = 1;
    const { session: huddle } = session({ speech: fake.provider, usage: { canSpend: () => allowed-- > 0 } });
    await huddle.join();
    const a = relay.addVirtualPeer(huddleId, PEER_A);
    await waitFor(() => huddle.peers.length === 1, 2000, "roster");
    speak(a, randomBytes(16), 0, 20, 12);
    speak(a, randomBytes(16), 32, 20, 12);
    await waitFor(() => huddle.listenStats.refusedByCap === 1 && fake.transcribeCalls.length === 1, 3000, "cap");
    await huddle.stop();
  });

  it("ignores audio unless the listen mode is granted", async () => {
    const fake = createFakeSpeechProvider();
    const { session: huddle } = session({ speech: fake.provider, modes: {} });
    await huddle.join();
    const a = relay.addVirtualPeer(huddleId, PEER_A);
    await waitFor(() => huddle.peers.length === 1, 2000, "roster");
    speak(a, randomBytes(16), 0, 30, 12);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.transcribeCalls).toEqual([]);
    await expect(huddle.speak(writeOggOpus([markedPacket(randomBytes(16), 1)]))).rejects.toThrow("huddle_mode_not_permitted");
    await expect(huddle.speakText("hello")).rejects.toThrow("huddle_mode_not_permitted");
    await huddle.stop();
  });
});

function fakeTimers(clock: { now: number }) {
  const queue: Array<{ at: number; callback: () => void; id: number }> = [];
  let ids = 0;
  const timers: Timers = {
    setTimeout: (callback, ms) => {
      const id = ++ids;
      queue.push({ at: clock.now + ms, callback, id });
      return id;
    },
    clearTimeout: (handle) => {
      const index = queue.findIndex((entry) => entry.id === handle);
      if (index >= 0) queue.splice(index, 1);
    },
  };
  const advance = (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      queue.sort((left, right) => left.at - right.at || left.id - right.id);
      const next = queue[0];
      if (!next || next.at > until) break;
      queue.shift();
      clock.now = Math.max(clock.now, next.at);
      next.callback();
    }
    clock.now = until;
  };
  return { timers, advance, pending: () => queue.length };
}

describe("huddle speak pipeline", () => {
  it("paces packets at 20 ms (drift-corrected) with a fake clock and accounts minutes spoken", async () => {
    const clock = { now: 10_000 };
    const { timers, advance } = fakeTimers(clock);
    const sent: Array<{ at: number; size: number; meta: { dBov?: number; dtx?: boolean } }> = [];
    const usage: number[] = [];
    const speaker = createSpeaker({
      client: { state: "joined", sendPacket: (packet, meta) => sent.push({ at: clock.now, size: packet.length, meta }) },
      timers,
      now: () => clock.now,
      usage: { onUsage: (entry) => usage.push(entry.seconds) },
    });
    const clip = writeOggOpus([...Array.from({ length: 9 }, (_unused, index) => markedPacket(randomBytes(16), index)), Uint8Array.from([0xf8, 0x00])]);
    const done = speaker.speak(clip);
    expect(sent.map((entry) => entry.at)).toEqual([10_000]);
    advance(45); // timers fire at +20 and +40
    clock.now += 30; // the event loop stalls 30 ms: the next packet is late, later ones stay on the 20 ms grid
    advance(200);
    const result = await done;
    expect(sent.map((entry) => entry.at - 10_000)).toEqual([0, 20, 40, 75, 80, 100, 120, 140, 160, 180]);
    expect(sent.slice(0, 9).every((entry) => entry.meta.dBov === -20 && entry.meta.dtx === false)).toBe(true);
    expect(sent[9]!.meta).toEqual({ dtx: true });
    expect(result).toMatchObject({ packets: 10, seconds: 0.2, aborted: false });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(speaker.minutesSpoken).toBeCloseTo(0.2 / 60, 9);
    expect(usage).toEqual([0.2]);
  });

  it("refuses while not joined, refuses bad clips, and aborts on stop", async () => {
    const clock = { now: 0 };
    const { timers, advance } = fakeTimers(clock);
    const sender = { state: "authenticating", sendPacket: () => undefined };
    const speaker = createSpeaker({ client: sender, timers, now: () => clock.now, maxClipSeconds: 1 });
    const clip = writeOggOpus(Array.from({ length: 20 }, (_unused, index) => markedPacket(randomBytes(16), index)));
    await expect(speaker.speak(clip)).rejects.toThrow("huddle_not_joined");
    await expect(speaker.speakText("hi")).rejects.toThrow("huddle_not_joined");
    sender.state = "joined";
    await expect(speaker.speak(new Uint8Array([1, 2, 3]))).rejects.toThrow("speak_audio_invalid");
    await expect(speaker.speak(writeOggOpus(Array.from({ length: 51 }, (_unused, index) => markedPacket(randomBytes(16), index))))).rejects.toThrow("speak_clip_too_long");
    // A 40 ms packet (SILK 40 ms config) is not a 20 ms frame.
    await expect(speaker.speak(writeOggOpus([Uint8Array.from([0x10, 1, 2])]))).rejects.toThrow("speak_packet_duration_unsupported");
    const playing = speaker.speak(clip);
    await expect(speaker.speak(clip)).rejects.toThrow("huddle_speak_busy");
    advance(100);
    speaker.abort();
    const result = await playing;
    expect(result).toMatchObject({ packets: 6, aborted: true });
  });

  it("speakText synthesises then speaks through the relay; speak refuses before join", async () => {
    const markers: Uint8Array[] = [];
    const fake = createFakeSpeechProvider({
      synthesize: () => {
        const marker = randomBytes(16);
        markers.push(marker);
        return writeOggOpus(Array.from({ length: 5 }, (_unused, index) => markedPacket(marker, index)));
      },
    });
    const { session: huddle } = session({ speech: fake.provider, modes: { speakLive: true, speakApproved: true } });
    await expect(huddle.speakText("before join")).rejects.toThrow("huddle_not_joined");
    await huddle.join();
    const result = await huddle.speakText("Hello huddle", { voice: "calm" });
    expect(result).toMatchObject({ packets: 5, aborted: false, text: "Hello huddle" });
    // Refused before join without calling the provider (no cost).
    expect(fake.synthesizeCalls).toEqual([{ text: "Hello huddle", voice: "calm" }]);
    const conn = relay.conns[0]!;
    await waitFor(() => conn.framesIn.length === 5, 2000, "frames at relay");
    expect(conn.framesIn.map((frame) => frame.payload[1])).toEqual([0, 1, 2, 3, 4]);
    const approved = writeOggOpus(Array.from({ length: 3 }, (_unused, index) => markedPacket(randomBytes(16), index)));
    const clip = await huddle.speak(approved);
    expect(clip.packets).toBe(3);
    await huddle.stop();
    const receipt = huddle.receipt();
    expect(receipt.said.map((entry) => [entry.kind, entry.text ?? null, entry.sha256 === clip.sha256])).toEqual([
      ["text", "Hello huddle", false],
      ["clip", null, true],
    ]);
    expect(receipt.minutesSpoken).toBeCloseTo((8 * 0.02) / 60, 9);
  });
});

describe("huddle stop, memory and persistence", () => {
  it("stop() leaves within 5 s while a transcription hangs and the relay ignores leave and close", async () => {
    await relay.close();
    relay = createFakeHuddleRelay({ members: [OWNER_PUBKEY], ignoreClose: true, ignoreLeave: true });
    port = await relay.start();
    const fake = createFakeSpeechProvider({ hang: true });
    const ended: string[] = [];
    const { session: huddle } = session({ speech: fake.provider, onEnded: (reason) => ended.push(reason) });
    await huddle.join();
    const a = relay.addVirtualPeer(huddleId, PEER_A);
    await waitFor(() => huddle.peers.length === 1, 2000, "roster");
    speak(a, randomBytes(16), 0, 30, 12);
    await waitFor(() => fake.transcribeCalls.length === 1, 3000, "transcription started");
    const started = Date.now();
    await huddle.stop("revoked");
    expect(Date.now() - started).toBeLessThan(HUDDLE_STOP_DEADLINE_MS);
    expect(huddle.state).toBe("closed");
    expect(ended).toEqual(["revoked"]);
    expect(huddle.bufferedAudioBytes).toBe(0);
    expect(huddle.receipt().endReason).toBe("revoked");
  });

  it("never persists raw audio: DB file, temp dirs and the huddle sources", async () => {
    const started = Date.now();
    const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-huddle-audio-scan-"));
    const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), { handoffEncryptionKey: "a".repeat(64) });
    try {
      const markers = [randomBytes(16), randomBytes(16), randomBytes(16)];
      const fake = createFakeSpeechProvider({ synthesize: () => writeOggOpus(Array.from({ length: 5 }, (_unused, index) => markedPacket(markers[2]!, index))) });
      const { session: huddle, transcripts } = session({ speech: fake.provider, modes: { listen: true, speakLive: true } });
      await huddle.join();
      const a = relay.addVirtualPeer(huddleId, PEER_A);
      const b = relay.addVirtualPeer(huddleId, PEER_B);
      await waitFor(() => huddle.peers.length === 2, 2000, "roster");
      speak(a, markers[0]!, 0, 30, 12);
      speak(b, markers[1]!, 0, 30, 12);
      await waitFor(() => transcripts.length === 2, 3000, "transcripts");
      await huddle.speakText("persist nothing");
      await huddle.stop();
      expect(huddle.bufferedAudioBytes).toBe(0);
      store.close();
      // The DB and every file written to the temp dir since the test started.
      expect(await scanForMarker(root, markers, started)).toEqual([]);
      expect(await scanForMarker(os.tmpdir(), markers, started)).toEqual([]);
      // Positive control: the scan does find a marker that was written.
      const control = randomBytes(16);
      await writeFile(path.join(root, "control.bin"), Buffer.concat([randomBytes(100), control]));
      expect(await scanForMarker(os.tmpdir(), [control], started)).toEqual([path.join(root, "control.bin")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    // Statically: no huddle runtime file touches the file system, a database or the store.
    const dir = path.join(SRC, "channels", "huddle");
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "test-support.ts" || name === "huddle-test-relay.ts") continue;
      const text = await readFile(path.join(dir, name), "utf8");
      expect(text, name).not.toMatch(/from "node:fs|from "fs|sqlite|store\.js|writeFile|createWriteStream|appendFile/u);
    }
  });
});

describe("gating: nothing exposes live voice yet", () => {
  async function sourceFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
    }
    return out;
  }

  it("keeps `live` out of the wired capabilities and the huddle module out of every runtime import", async () => {
    expect([...AGENT_WIRED_FEATURES].filter((feature) => feature.startsWith("live"))).toEqual([]);
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const relative = path.relative(SRC, file);
      if (relative.startsWith(path.join("channels", "huddle") + path.sep)) continue;
      const text = await readFile(file, "utf8");
      if (/from "[^"]*huddle\/|createHuddleSession|createHuddleAudioClient|createPortalVoiceSpeechProvider|@tealbrick\/voice/u.test(text)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
    // Inside the module, only the adapter imports @tealbrick/voice.
    const voiceImporters: string[] = [];
    for (const file of await sourceFiles(path.join(SRC, "channels", "huddle"))) {
      if (/from "@tealbrick\/voice"/u.test(await readFile(file, "utf8"))) voiceImporters.push(path.basename(file));
    }
    expect(voiceImporters).toEqual(["voice-speech.ts"]);
  });

  it("round-trips a clip through the writer and reader without touching the input", () => {
    const packets = Array.from({ length: 3 }, (_unused, index) => markedPacket(randomBytes(16), index));
    const ogg = writeOggOpus(packets);
    const before = Buffer.from(ogg).toString("hex");
    const read = readOggOpusPackets(ogg);
    expect(read.ok).toBe(true);
    expect(Buffer.from(ogg).toString("hex")).toBe(before);
  });
});

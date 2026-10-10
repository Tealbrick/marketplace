import { describe, expect, it } from "vitest";

import { clampDbov, decodeFrame, decodeRelayFrame, encodeFrame, HUDDLE_FLAG_DTX, HUDDLE_MAX_FRAME_BYTES, prefixRelayFrame, seqDelta } from "./frame.js";
import { createSpeakerStreams, type SpeakerFrame } from "./jitter.js";
import { createVadSegmenter, type Utterance } from "./listen.js";
import { opusPacket } from "./test-support.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

describe("huddle frame header (v2, buzz-relay audio/wire.rs)", () => {
  it("encodes network byte order and round-trips", () => {
    const packet = Uint8Array.from([0xf8, 0xaa, 0xbb]);
    const frame = encodeFrame({ seq: 0x0102, ts: 0x03040506, dBov: -1, flags: HUDDLE_FLAG_DTX }, packet);
    // Same bytes as the relay's parse_reads_network_byte_order fixture.
    expect([...frame]).toEqual([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0xff, 0x01, 0xf8, 0xaa, 0xbb]);
    const decoded = decodeFrame(frame)!;
    expect(decoded.header).toEqual({ seq: 0x0102, ts: 0x03040506, dBov: -1, flags: 1 });
    expect([...decoded.payload]).toEqual([...packet]);
  });

  it("wraps seq and ts, clamps the level, keeps reserved flag bits", () => {
    const frame = encodeFrame({ seq: 0x1_0005, ts: 2 ** 32 + 7, dBov: 12, flags: 0b1010_1010 }, opusPacket(1, 4));
    const { header } = decodeFrame(frame)!;
    expect(header).toEqual({ seq: 5, ts: 7, dBov: -127, flags: 0b1010_1010 });
    expect(clampDbov(-200)).toBe(-127);
    expect(clampDbov(Number.NaN)).toBe(-127);
    expect(clampDbov(-30.4)).toBe(-30);
    // A raw out-of-range level reads as the silence floor but the frame is kept (relay invariant).
    const raw = Uint8Array.from([0, 7, 0, 0, 3, 0xc0, 0x7f, 0, 0xf8, 1]);
    expect(decodeFrame(raw)!.header.dBov).toBe(-127);
  });

  it("refuses frames without header or payload and oversized packets", () => {
    expect(decodeFrame(new Uint8Array(8))).toBeNull();
    expect(() => encodeFrame({ seq: 0, ts: 0, dBov: 0, flags: 0 }, new Uint8Array(0))).toThrow("huddle_packet_size_invalid");
    expect(() => encodeFrame({ seq: 0, ts: 0, dBov: 0, flags: 0 }, new Uint8Array(HUDDLE_MAX_FRAME_BYTES - 7))).toThrow("huddle_packet_size_invalid");
  });

  it("decodes the relay prefix for v2 (peer_index) and v3 (peer_index, epoch)", () => {
    const frame = encodeFrame({ seq: 9, ts: 960, dBov: -20, flags: 0 }, opusPacket(3, 5));
    const v2 = decodeRelayFrame(prefixRelayFrame(frame, 4, 2), 2)!;
    expect(v2).toMatchObject({ peerIndex: 4, epoch: null, header: { seq: 9, ts: 960, dBov: -20 } });
    const v3 = decodeRelayFrame(prefixRelayFrame(frame, 4, 3, 7), 3)!;
    expect(v3).toMatchObject({ peerIndex: 4, epoch: 7, header: { seq: 9 } });
    expect(decodeRelayFrame(new Uint8Array(HUDDLE_MAX_FRAME_BYTES + 2), 2)).toBeNull();
  });

  it("compares sequence numbers on the u16 circle", () => {
    expect(seqDelta(1, 0xffff)).toBe(2);
    expect(seqDelta(0xffff, 1)).toBe(-2);
    expect(seqDelta(100, 100)).toBe(0);
  });
});

const header = (seq: number, dBov = -20, flags = 0) => ({ seq, ts: seq * 960, dBov, flags });

describe("per-speaker reordering window", () => {
  it("releases frames in sequence order per speaker and drops late and duplicate frames", () => {
    const out: SpeakerFrame[] = [];
    const streams = createSpeakerStreams({ window: 5 }, (frame) => out.push(frame));
    for (const seq of [10, 12, 11, 13]) expect(streams.push(A, header(seq), opusPacket(seq), 0)).toBe("accepted");
    streams.push(B, header(500), opusPacket(1), 0);
    expect(streams.push(A, header(12), opusPacket(12), 0)).toBe("dropped_late");
    streams.push(A, header(15), opusPacket(15), 0);
    expect(streams.push(A, header(15), opusPacket(15), 0)).toBe("dropped_duplicate");
    expect(out.filter((frame) => frame.speakerPubkey === A).map((frame) => frame.seq)).toEqual([10, 11, 12, 13]);
    expect(out.filter((frame) => frame.speakerPubkey === B).map((frame) => frame.seq)).toEqual([500]);
    // 14 never comes: after the jitter delay the gap is skipped.
    const lastOfA = () => out.filter((frame) => frame.speakerPubkey === A).at(-1)!.seq;
    streams.tick(99);
    expect(lastOfA()).toBe(13);
    streams.tick(100);
    expect(lastOfA()).toBe(15);
    expect(streams.stats.skippedGaps).toBe(1);
  });

  it("skips a gap once the window is full and handles sequence wrap", () => {
    const out: number[] = [];
    const streams = createSpeakerStreams({ window: 3 }, (frame) => out.push(frame.seq));
    for (const seq of [0xfffe, 0xffff, 1, 2, 3, 4]) streams.push(A, header(seq), opusPacket(1), 0);
    expect(out).toEqual([0xfffe, 0xffff, 1, 2, 3, 4]);
  });

  it("limits frame rate per speaker and the number of speakers", () => {
    const streams = createSpeakerStreams({ maxFramesPerSecond: 50, burstFrames: 10, maxSpeakers: 1 }, () => undefined);
    const results = Array.from({ length: 20 }, (_unused, index) => streams.push(A, header(index), opusPacket(1), 0));
    expect(results.filter((result) => result === "accepted")).toHaveLength(10);
    expect(results.filter((result) => result === "dropped_rate")).toHaveLength(10);
    // 200 ms later 10 tokens are back.
    expect(streams.push(A, header(20), opusPacket(1), 200)).toBe("accepted");
    expect(streams.push(B, header(0), opusPacket(1), 200)).toBe("dropped_speakers");
    expect(streams.heldFrames).toBeLessThanOrEqual(5);
  });
});

describe("voice-activity segmentation from dBov", () => {
  const frame = (speaker: string, seq: number, dBov: number, at: number, dtx = false): SpeakerFrame => ({
    speakerPubkey: speaker,
    seq,
    ts: seq * 960,
    dBov,
    dtx,
    payload: opusPacket(seq & 0xff),
    receivedAt: at,
  });

  it("cuts utterances with onset, hangover and pre-roll, per speaker", () => {
    const utterances: Utterance[] = [];
    const vad = createVadSegmenter({ thresholdDbov: -50, onsetFrames: 2, hangoverMs: 200, preRollFrames: 3, minSpeechMs: 100 }, (utterance) => utterances.push(utterance));
    let seq = 0;
    let at = 1000;
    const feed = (speaker: string, count: number, dBov: number, dtx = false) => {
      for (let index = 0; index < count; index += 1) {
        vad.push(frame(speaker, seq++, dBov, at, dtx));
        at += 20;
      }
    };
    feed(A, 10, -90); // silence
    feed(A, 25, -25); // 500 ms speech
    feed(A, 10, -127, true); // DTX silence: hangover is 10 frames → closes
    expect(utterances).toHaveLength(1);
    // 3 pre-roll frames + 25 speech frames + 10 hangover frames.
    expect(utterances[0]!.speakerPubkey).toBe(A);
    expect(utterances[0]!.packets.length).toBe(3 + 25 + 10);
    expect(utterances[0]!.startedAt).toBe(1000 + 7 * 20);
    expect(utterances[0]!.seconds).toBeCloseTo(0.76, 5);
    // A short blip is dropped; another speaker is separate.
    feed(B, 3, -20);
    feed(B, 12, -100);
    expect(utterances).toHaveLength(1);
    expect(vad.stats.droppedShort).toBe(1);
  });

  it("closes on wall-clock silence (no frames) and cuts at the maximum length", () => {
    const utterances: Utterance[] = [];
    const vad = createVadSegmenter({ onsetFrames: 1, hangoverMs: 100, minSpeechMs: 20, maxUtteranceMs: 200 }, (utterance) => utterances.push(utterance));
    for (let index = 0; index < 25; index += 1) vad.push(frame(A, index, -10, index * 20));
    expect(utterances).toHaveLength(2); // cut at 10 frames twice
    expect(utterances.every((utterance) => utterance.packets.length === 10)).toBe(true);
    vad.tick(24 * 20 + 99);
    expect(utterances).toHaveLength(2);
    vad.tick(24 * 20 + 100);
    expect(utterances).toHaveLength(3);
    expect(vad.bufferedBytes).toBe(0);
  });
});

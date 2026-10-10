import { type FrameHeader, HUDDLE_FLAG_DTX, seqDelta } from "./frame.js";

/** One received frame, in sequence order for its speaker. The payload is an in-memory Opus packet only. */
export type SpeakerFrame = {
  speakerPubkey: string;
  seq: number;
  ts: number;
  dBov: number;
  dtx: boolean;
  payload: Uint8Array;
  /** Local milliseconds clock when the frame arrived. */
  receivedAt: number;
};

export type SpeakerStreamOptions = {
  /** Frames held to restore order before a gap is skipped (default 5 = 100 ms; at most 50). */
  window?: number;
  /** A held frame is released (gap skipped) after this long (default 100 ms): jitter tolerance. */
  maxDelayMs?: number;
  /** Sustained frames per second per speaker (default 75; nominal is 50 at 20 ms). */
  maxFramesPerSecond?: number;
  /** Burst allowance per speaker (default 100 frames). */
  burstFrames?: number;
  /** Most concurrent speaker streams (default 25, the relay's MAX_PEERS_PER_ROOM). */
  maxSpeakers?: number;
};

export type PushResult = "accepted" | "dropped_rate" | "dropped_late" | "dropped_duplicate" | "dropped_speakers";

type Stream = {
  expected: number | null;
  held: Map<number, SpeakerFrame>;
  tokens: number;
  refilledAt: number;
};

/** A jump this far from the expected sequence means the sender restarted (rejoin): the stream resynchronises. */
const RESYNC_DISTANCE = 500;

/**
 * Per-speaker reordering (keyed by Nostr pubkey): frames are released strictly in sequence order; a missing frame
 * is waited for up to `window` frames or `maxDelayMs`, then skipped. Late and duplicate frames are dropped.
 * Each speaker has a token-bucket frame-rate limit. Memory is bounded: at most `window` frames per speaker and
 * `maxSpeakers` speakers.
 */
export function createSpeakerStreams(options: SpeakerStreamOptions, emit: (frame: SpeakerFrame) => void) {
  const window = Math.max(1, Math.min(50, Math.floor(options.window ?? 5)));
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 100);
  const rate = Math.max(1, options.maxFramesPerSecond ?? 75);
  const burst = Math.max(1, options.burstFrames ?? 100);
  const maxSpeakers = Math.max(1, options.maxSpeakers ?? 25);
  const streams = new Map<string, Stream>();
  const stats = { accepted: 0, released: 0, skippedGaps: 0, dropped_rate: 0, dropped_late: 0, dropped_duplicate: 0, dropped_speakers: 0 };

  const release = (frame: SpeakerFrame) => {
    stats.released += 1;
    try {
      emit(frame);
    } catch {
      // A listener error never breaks reception.
    }
  };

  const drain = (stream: Stream) => {
    while (stream.expected !== null && stream.held.has(stream.expected)) {
      const frame = stream.held.get(stream.expected)!;
      stream.held.delete(stream.expected);
      stream.expected = (stream.expected + 1) & 0xffff;
      release(frame);
    }
  };

  /** Skips to the oldest held frame (by sequence) and releases what is now in order. */
  const skipGap = (stream: Stream) => {
    if (stream.held.size === 0 || stream.expected === null) return;
    const base = stream.expected;
    let lowest: number | null = null;
    for (const seq of stream.held.keys()) {
      if (lowest === null || seqDelta(seq, base) < seqDelta(lowest, base)) lowest = seq;
    }
    if (lowest === null) return;
    stats.skippedGaps += 1;
    stream.expected = lowest;
    drain(stream);
  };

  const flushAll = (stream: Stream) => {
    while (stream.held.size > 0) skipGap(stream);
  };

  return {
    push(speakerPubkey: string, header: FrameHeader, payload: Uint8Array, receivedAt: number): PushResult {
      let stream = streams.get(speakerPubkey);
      if (!stream) {
        if (streams.size >= maxSpeakers) {
          stats.dropped_speakers += 1;
          return "dropped_speakers";
        }
        stream = { expected: null, held: new Map(), tokens: burst, refilledAt: receivedAt };
        streams.set(speakerPubkey, stream);
      }
      const elapsed = Math.max(0, receivedAt - stream.refilledAt);
      stream.tokens = Math.min(burst, stream.tokens + (elapsed * rate) / 1000);
      stream.refilledAt = receivedAt;
      if (stream.tokens < 1) {
        stats.dropped_rate += 1;
        return "dropped_rate";
      }
      stream.tokens -= 1;

      const seq = header.seq & 0xffff;
      if (stream.expected === null) stream.expected = seq;
      const delta = seqDelta(seq, stream.expected);
      if (delta < -RESYNC_DISTANCE || delta > RESYNC_DISTANCE) {
        flushAll(stream);
        stream.expected = seq;
      } else if (delta < 0) {
        stats.dropped_late += 1;
        return "dropped_late";
      }
      if (stream.held.has(seq)) {
        stats.dropped_duplicate += 1;
        return "dropped_duplicate";
      }
      stats.accepted += 1;
      stream.held.set(seq, {
        speakerPubkey,
        seq,
        ts: header.ts >>> 0,
        dBov: header.dBov,
        dtx: (header.flags & HUDDLE_FLAG_DTX) !== 0,
        payload,
        receivedAt,
      });
      drain(stream);
      while (stream.held.size > window) skipGap(stream);
      return "accepted";
    },
    /** Releases frames held longer than `maxDelayMs` (call on a timer). */
    tick(now: number): void {
      for (const stream of streams.values()) {
        for (;;) {
          let oldest = Infinity;
          for (const frame of stream.held.values()) oldest = Math.min(oldest, frame.receivedAt);
          if (stream.held.size === 0 || oldest > now - maxDelayMs) break;
          skipGap(stream);
        }
      }
    },
    /** A speaker left: releases what it still holds in order, then forgets it. */
    remove(speakerPubkey: string): void {
      const stream = streams.get(speakerPubkey);
      if (!stream) return;
      flushAll(stream);
      streams.delete(speakerPubkey);
    },
    /** Drops every held frame without releasing it (session end). */
    clear(): void {
      for (const stream of streams.values()) stream.held.clear();
      streams.clear();
    },
    get speakers(): number {
      return streams.size;
    },
    get heldFrames(): number {
      let total = 0;
      for (const stream of streams.values()) total += stream.held.size;
      return total;
    },
    stats,
  };
}

export type SpeakerStreams = ReturnType<typeof createSpeakerStreams>;

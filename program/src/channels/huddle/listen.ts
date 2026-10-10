import { opusPacketSamples, writeOggOpus } from "../providers/ogg-opus.js";

import { HUDDLE_FRAME_MS, HUDDLE_FRAME_SAMPLES, HUDDLE_SAMPLE_RATE } from "./frame.js";
import type { SpeakerFrame } from "./jitter.js";
import type { SpeechProvider, TranscriptionSegment } from "./speech.js";

// Listen pipeline: per-speaker voice-activity segmentation from the frame header's dBov level (sender-authored
// telemetry: Buzz clients compute it as RMS dBFS of the encoded 20 ms frame, -127 = silence, DTX frames flagged),
// each utterance's Opus packets wrapped into an in-memory Ogg/Opus file, transcribed with bounded concurrency.
// The header level is untrusted: a sender can only make its OWN audio be transcribed or not, never someone else's.
// Raw audio never leaves memory: packet arrays and Ogg buffers are zeroed after use.

export type VadOptions = {
  /** A frame is speech above this level (default -50 dBov; the Desktop's speech indicator uses -55). */
  thresholdDbov?: number;
  /** Consecutive speech frames that open an utterance (default 2 = 40 ms). */
  onsetFrames?: number;
  /** Silence that closes an utterance (default 400 ms). */
  hangoverMs?: number;
  /** Frames kept from before the onset (default 5 = 100 ms). */
  preRollFrames?: number;
  /** Utterances with less speech than this are dropped (default 200 ms). */
  minSpeechMs?: number;
  /** An utterance is cut at this length (default 30 s, the Desktop's MAX_SPEECH_SAMPLES). */
  maxUtteranceMs?: number;
  /** An utterance is cut at this many Opus bytes (default 512 KiB): the memory bound per speaker. */
  maxUtteranceBytes?: number;
};

export type Utterance = { speakerPubkey: string; startedAt: number; endedAt: number; seconds: number; packets: Uint8Array[] };

type SpeakerVad = {
  preRoll: SpeakerFrame[];
  onset: number;
  active: { packets: Uint8Array[]; startedAt: number; samples: number; bytes: number; speechFrames: number; silentRun: number; lastFrameAt: number } | null;
};

const wipe = (packets: Uint8Array[]) => {
  for (const packet of packets) packet.fill(0);
  packets.length = 0;
};

export function createVadSegmenter(options: VadOptions, onUtterance: (utterance: Utterance) => void) {
  const threshold = options.thresholdDbov ?? -50;
  const onsetFrames = Math.max(1, options.onsetFrames ?? 2);
  const hangoverFrames = Math.max(1, Math.round((options.hangoverMs ?? 400) / HUDDLE_FRAME_MS));
  const hangoverMs = hangoverFrames * HUDDLE_FRAME_MS;
  const preRollFrames = Math.max(0, Math.min(50, options.preRollFrames ?? 5));
  const minSpeechFrames = Math.max(1, Math.round((options.minSpeechMs ?? 200) / HUDDLE_FRAME_MS));
  const maxSamples = Math.round(((options.maxUtteranceMs ?? 30_000) / 1000) * HUDDLE_SAMPLE_RATE);
  const maxBytes = options.maxUtteranceBytes ?? 512 * 1024;
  const speakers = new Map<string, SpeakerVad>();
  const stats = { utterances: 0, droppedShort: 0, cut: 0 };

  const close = (speakerPubkey: string, vad: SpeakerVad) => {
    const active = vad.active;
    vad.active = null;
    vad.onset = 0;
    if (!active) return;
    if (active.speechFrames < minSpeechFrames) {
      stats.droppedShort += 1;
      wipe(active.packets);
      return;
    }
    stats.utterances += 1;
    const seconds = active.samples / HUDDLE_SAMPLE_RATE;
    try {
      onUtterance({ speakerPubkey, startedAt: active.startedAt, endedAt: active.startedAt + Math.round(seconds * 1000), seconds, packets: active.packets });
    } catch {
      wipe(active.packets);
    }
  };

  const append = (vad: SpeakerVad, frame: SpeakerFrame) => {
    const active = vad.active!;
    active.packets.push(frame.payload);
    active.samples += opusPacketSamples(frame.payload) || HUDDLE_FRAME_SAMPLES;
    active.bytes += frame.payload.length;
    active.lastFrameAt = frame.receivedAt;
  };

  return {
    push(frame: SpeakerFrame): void {
      let vad = speakers.get(frame.speakerPubkey);
      if (!vad) {
        vad = { preRoll: [], onset: 0, active: null };
        speakers.set(frame.speakerPubkey, vad);
      }
      const speech = !frame.dtx && frame.dBov > threshold;
      if (vad.active) {
        if (vad.active.bytes + frame.payload.length > maxBytes || vad.active.samples >= maxSamples) {
          stats.cut += 1;
          close(frame.speakerPubkey, vad);
          if (!speech) return;
          vad.active = { packets: [], startedAt: frame.receivedAt, samples: 0, bytes: 0, speechFrames: 0, silentRun: 0, lastFrameAt: frame.receivedAt };
        }
        const active = vad.active!;
        append(vad, frame);
        if (speech) {
          active.speechFrames += 1;
          active.silentRun = 0;
        } else {
          active.silentRun += 1;
          if (active.silentRun >= hangoverFrames) close(frame.speakerPubkey, vad);
        }
        return;
      }
      vad.onset = speech ? vad.onset + 1 : 0;
      vad.preRoll.push(frame);
      if (vad.onset >= onsetFrames) {
        const opening = vad.preRoll;
        vad.preRoll = [];
        vad.active = { packets: [], startedAt: opening[0]!.receivedAt, samples: 0, bytes: 0, speechFrames: vad.onset, silentRun: 0, lastFrameAt: frame.receivedAt };
        for (const held of opening) append(vad, held);
        return;
      }
      // Keep `preRollFrames` before the first onset frame: the next push may complete the onset.
      while (vad.preRoll.length > preRollFrames + onsetFrames - 1) vad.preRoll.shift()!.payload.fill(0);
    },
    /** Closes utterances whose speaker sent nothing for the hangover time (DTX may stop frames altogether). */
    tick(now: number): void {
      for (const [speakerPubkey, vad] of speakers) {
        if (vad.active && now - vad.active.lastFrameAt >= hangoverMs) close(speakerPubkey, vad);
      }
    },
    /** A speaker left: its open utterance is closed (transcribed if long enough). */
    endSpeaker(speakerPubkey: string): void {
      const vad = speakers.get(speakerPubkey);
      if (!vad) return;
      close(speakerPubkey, vad);
      wipe(vad.preRoll.map((frame) => frame.payload));
      speakers.delete(speakerPubkey);
    },
    /** Drops every buffer without transcribing (hard stop). */
    clear(): void {
      for (const vad of speakers.values()) {
        if (vad.active) wipe(vad.active.packets);
        for (const frame of vad.preRoll) frame.payload.fill(0);
      }
      speakers.clear();
    },
    get bufferedBytes(): number {
      let total = 0;
      for (const vad of speakers.values()) total += (vad.active?.bytes ?? 0) + vad.preRoll.reduce((sum, frame) => sum + frame.payload.length, 0);
      return total;
    },
    stats,
  };
}

export type TranscriptSegment = { speakerPubkey: string; startedAt: number; endedAt: number; text: string; segments?: TranscriptionSegment[] };

/** Cost/usage hooks for the later live-session grant caps (minutes per day, cost cap). */
export type UsageHooks = {
  /** Return false to refuse spending this many seconds (the utterance is dropped, never sent). */
  canSpend?: (kind: "listen" | "speak", seconds: number) => boolean;
  onUsage?: (usage: { kind: "listen" | "speak"; seconds: number; totalSeconds: number }) => void;
};

export type ListenPipelineOptions = {
  speech: SpeechProvider;
  language?: string;
  vad?: VadOptions;
  /** Parallel transcriptions (default 2). */
  concurrency?: number;
  /** Utterances waiting for a free slot (default 8); more are dropped. */
  maxQueue?: number;
  usage?: UsageHooks;
  onTranscript: (segment: TranscriptSegment) => void;
  onError?: (code: string) => void;
};

const MAX_TRANSCRIPT_CHARS = 8000;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;

export function createListenPipeline(options: ListenPipelineOptions) {
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? 2));
  const maxQueue = Math.max(0, options.maxQueue ?? 8);
  const queue: Utterance[] = [];
  const controllers = new Set<AbortController>();
  const idleWaiters: Array<() => void> = [];
  let running = 0;
  let stopped = false;
  let listenedSeconds = 0;
  const stats = { dispatched: 0, transcripts: 0, droppedQueue: 0, refusedByCap: 0, failed: 0 };

  const settleIdle = () => {
    if (running === 0 && queue.length === 0) for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const pump = () => {
    while (!stopped && running < concurrency && queue.length > 0) {
      const utterance = queue.shift()!;
      running += 1;
      void transcribe(utterance).finally(() => {
        running -= 1;
        pump();
        settleIdle();
      });
    }
    settleIdle();
  };

  const transcribe = async (utterance: Utterance) => {
    const controller = new AbortController();
    controllers.add(controller);
    let ogg: Uint8Array | null = null;
    try {
      ogg = writeOggOpus(utterance.packets, { channels: 1 });
      wipe(utterance.packets);
      stats.dispatched += 1;
      listenedSeconds += utterance.seconds;
      options.usage?.onUsage?.({ kind: "listen", seconds: utterance.seconds, totalSeconds: listenedSeconds });
      const result = await options.speech.transcribe(ogg, { ...(options.language ? { language: options.language } : {}), signal: controller.signal });
      if (stopped || controller.signal.aborted) return;
      const text = typeof result?.text === "string" ? result.text.replace(CONTROL, "").trim().slice(0, MAX_TRANSCRIPT_CHARS) : "";
      if (!text) return;
      stats.transcripts += 1;
      const segment: TranscriptSegment = { speakerPubkey: utterance.speakerPubkey, startedAt: utterance.startedAt, endedAt: utterance.endedAt, text };
      if (Array.isArray(result.segments)) {
        segment.segments = result.segments
          .filter((part) => part && typeof part.text === "string" && Number.isFinite(part.startSecs) && Number.isFinite(part.endSecs))
          .slice(0, 1000)
          .map((part) => ({ startSecs: part.startSecs, endSecs: part.endSecs, text: part.text.replace(CONTROL, "").slice(0, MAX_TRANSCRIPT_CHARS) }));
      }
      options.onTranscript(segment);
    } catch (error) {
      if (stopped) return;
      stats.failed += 1;
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "transcription_failed";
      options.onError?.(code);
    } finally {
      wipe(utterance.packets);
      ogg?.fill(0);
      controllers.delete(controller);
    }
  };

  const vad = createVadSegmenter(options.vad ?? {}, (utterance) => {
    if (stopped) {
      wipe(utterance.packets);
      return;
    }
    if (options.usage?.canSpend && !options.usage.canSpend("listen", utterance.seconds)) {
      stats.refusedByCap += 1;
      wipe(utterance.packets);
      return;
    }
    if (running >= concurrency && queue.length >= maxQueue) {
      stats.droppedQueue += 1;
      wipe(utterance.packets);
      return;
    }
    queue.push(utterance);
    pump();
  });

  return {
    onFrame(frame: SpeakerFrame): void {
      if (!stopped) vad.push(frame);
    },
    tick(now: number): void {
      if (!stopped) vad.tick(now);
    },
    endSpeaker(speakerPubkey: string): void {
      if (!stopped) vad.endSpeaker(speakerPubkey);
    },
    /** Hard stop: aborts in-flight transcriptions and drops every buffered utterance. */
    stop(): void {
      stopped = true;
      vad.clear();
      for (const utterance of queue.splice(0)) wipe(utterance.packets);
      for (const controller of controllers) controller.abort();
      for (const resolve of idleWaiters.splice(0)) resolve();
    },
    /** Resolves when nothing is queued or in flight (tests, graceful end). */
    idle(): Promise<void> {
      if (running === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    get minutesListened(): number {
      return listenedSeconds / 60;
    },
    get bufferedBytes(): number {
      return vad.bufferedBytes + queue.reduce((sum, utterance) => sum + utterance.packets.reduce((inner, packet) => inner + packet.length, 0), 0);
    },
    stats,
    vadStats: vad.stats,
  };
}

export type ListenPipeline = ReturnType<typeof createListenPipeline>;

import { createHash } from "node:crypto";

import type { Timers } from "../discord-gateway.js";
import { opusPacketSamples, readOggOpusPackets } from "../providers/ogg-opus.js";

import { HuddleError } from "./client.js";
import { HUDDLE_FRAME_MS, HUDDLE_FRAME_SAMPLES, HUDDLE_MAX_PACKET_BYTES } from "./frame.js";
import type { UsageHooks } from "./listen.js";
import type { SpeechProvider } from "./speech.js";

// Speak pipeline: an Ogg/Opus clip is split into its packets (reader) and sent one per 20 ms, drift-corrected
// against the clock, with consecutive seq/ts from the client. `speak-approved` plays an owner-approved clip (its
// SHA-256 is returned for the receipt); `speak-live` is speakText = synthesize + speak. Both refuse unless joined.
//
// dBov APPROXIMATION (documented): the Buzz header carries the frame's RMS level, which needs decoded PCM. There is
// no Opus decoder here, so a packet of at most 2 bytes is sent as DTX at -127 dBov (what the Desktop does for DTX)
// and every other packet at a nominal speech level (default -20 dBov). Receivers use the level only for speaking
// indicators; it is untrusted telemetry and never drops audio.

export type SpeakSender = {
  readonly state: string;
  sendPacket(packet: Uint8Array, meta: { dBov?: number; dtx?: boolean }): void;
};

export type SpeakerOptions = {
  client: SpeakSender;
  speech?: SpeechProvider;
  timers: Timers;
  now: () => number;
  /** Longest clip (default 30 s, the Desktop's TTS_BROADCAST_MAX_FRAMES). */
  maxClipSeconds?: number;
  /** Nominal level of non-DTX packets (default -20 dBov). */
  speechDbov?: number;
  usage?: UsageHooks;
};

export type SpeakResult = { packets: number; seconds: number; aborted: boolean; sha256: string };

export const SPEAK_TEXT_MAX_CHARS = 4096;

export function createSpeaker(options: SpeakerOptions) {
  const maxClipSeconds = options.maxClipSeconds ?? 30;
  const speechDbov = options.speechDbov ?? -20;
  let spokenSeconds = 0;
  let current: { abort: () => void } | null = null;

  const requireJoined = () => {
    if (options.client.state !== "joined") throw new HuddleError("huddle_not_joined");
  };

  async function speak(oggOpus: Uint8Array): Promise<SpeakResult> {
    requireJoined();
    if (current) throw new HuddleError("huddle_speak_busy");
    const parsed = readOggOpusPackets(oggOpus);
    if (!parsed.ok) throw new HuddleError("speak_audio_invalid");
    const packets = parsed.packets;
    // Huddle audio is mono (the Desktop sends mono VOIP Opus); downmixing needs a decoder and is out of scope.
    if (parsed.info.channels !== 1) throw new HuddleError("huddle_audio_not_mono");
    for (const packet of packets) {
      if (packet.length > HUDDLE_MAX_PACKET_BYTES) throw new HuddleError("speak_packet_too_large");
      if (opusPacketSamples(packet) !== HUDDLE_FRAME_SAMPLES) throw new HuddleError("speak_packet_duration_unsupported");
    }
    const seconds = (packets.length * HUDDLE_FRAME_MS) / 1000;
    if (seconds > maxClipSeconds) throw new HuddleError("speak_clip_too_long");
    if (options.usage?.canSpend && !options.usage.canSpend("speak", seconds)) throw new HuddleError("speak_cap_reached");
    const sha256 = createHash("sha256").update(oggOpus).digest("hex");

    return new Promise<SpeakResult>((resolve) => {
      const start = options.now();
      let index = 0;
      let handle: unknown = null;
      let finished = false;
      const end = (aborted: boolean) => {
        if (finished) return;
        finished = true;
        if (handle !== null) options.timers.clearTimeout(handle);
        current = null;
        const sent = (index * HUDDLE_FRAME_MS) / 1000;
        spokenSeconds += sent;
        if (index > 0) options.usage?.onUsage?.({ kind: "speak", seconds: sent, totalSeconds: spokenSeconds });
        for (const packet of packets) packet.fill(0);
        resolve({ packets: index, seconds: sent, aborted, sha256 });
      };
      const sendNext = () => {
        handle = null;
        if (finished) return;
        if (options.client.state !== "joined") {
          end(true);
          return;
        }
        const packet = packets[index]!;
        try {
          options.client.sendPacket(packet, packet.length <= 2 ? { dtx: true } : { dBov: speechDbov, dtx: false });
        } catch {
          end(true);
          return;
        }
        index += 1;
        if (index >= packets.length) {
          end(false);
          return;
        }
        // Drift-corrected: packet i is due at start + i × 20 ms.
        handle = options.timers.setTimeout(sendNext, Math.max(0, start + index * HUDDLE_FRAME_MS - options.now()));
      };
      current = { abort: () => end(true) };
      sendNext();
    });
  }

  async function speakText(text: string, input: { voice?: string; signal?: AbortSignal } = {}): Promise<SpeakResult & { text: string }> {
    requireJoined();
    if (!options.speech) throw new HuddleError("speech_unavailable");
    if (typeof text !== "string" || !text.trim() || text.length > SPEAK_TEXT_MAX_CHARS) throw new HuddleError("speak_text_invalid");
    if (current) throw new HuddleError("huddle_speak_busy");
    const ogg = await options.speech.synthesize(text, { ...(input.voice ? { voice: input.voice } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    try {
      const result = await speak(ogg);
      return { ...result, text };
    } finally {
      ogg.fill(0);
    }
  }

  return {
    speak,
    speakText,
    /** Stops the clip being played (stop/revoke). */
    abort(): void {
      current?.abort();
    },
    get speaking(): boolean {
      return current !== null;
    },
    get minutesSpoken(): number {
      return spokenSeconds / 60;
    },
  };
}

export type HuddleSpeaker = ReturnType<typeof createSpeaker>;

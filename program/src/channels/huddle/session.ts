import type { BinarySocketFactory } from "../buzz-relay-guard.js";
import type { Timers } from "../discord-gateway.js";

import { createHuddleAudioClient, HUDDLE_STOP_DEADLINE_MS, HuddleError, type HuddleClientState } from "./client.js";
import type { HuddleProtocolVersion } from "./frame.js";
import type { SpeakerStreamOptions } from "./jitter.js";
import { createListenPipeline, type TranscriptSegment, type UsageHooks, type VadOptions } from "./listen.js";
import { createSpeaker, type SpeakResult } from "./speak.js";
import type { SpeechProvider } from "./speech.js";

/**
 * One agent in one Buzz huddle: audio client + listen pipeline + speak pipeline + usage accounting + receipt.
 *
 * GATED (Channels P2 §2.3): nothing outside tests constructs this. No agent operation, route or capability uses
 * it; `live` stays out of AGENT_WIRED_FEATURES. The live-session grant (contract alpha.8) will own the modes,
 * limits, consent block and revoke, and call `stop()` (which leaves within 5 s).
 *
 * The receipt holds only what the scope allows: join/leave times and the transcript of what the agent heard and
 * said (with times, and the SHA-256 of each approved clip). Raw audio is never kept: frames live in bounded memory
 * buffers only and are zeroed after transcription or sending.
 */

export type HuddleModes = {
  /** `listen`: speech-to-text of other participants. */
  listen?: boolean;
  /** `speak-approved`: play owner-approved Ogg/Opus clips. */
  speakApproved?: boolean;
  /** `speak-live`: text-to-speech from the agent's live text. */
  speakLive?: boolean;
};

export type HuddleSessionOptions = {
  credential: string;
  pinnedOwner?: () => string | null;
  channelId: string;
  parentChannelId?: string | null;
  protocolVersion?: HuddleProtocolVersion;
  speech: SpeechProvider;
  /** Every mode is off unless set. */
  modes: HuddleModes;
  language?: string;
  vad?: VadOptions;
  concurrency?: number;
  maxQueue?: number;
  /** Session limit (≤ 2 h). */
  maxSessionMs?: number;
  usage?: UsageHooks;
  onTranscript?: (segment: TranscriptSegment) => void;
  onEnded?: (reason: string) => void;
  socketFactory?: BinarySocketFactory;
  env?: Record<string, string | undefined>;
  timers?: Timers;
  now?: () => number;
  joinTimeoutMs?: number;
  closeGraceMs?: number;
  streams?: SpeakerStreamOptions;
  maxClipSeconds?: number;
};

export type SaidEntry = { kind: "clip" | "text"; startedAt: number; endedAt: number; sha256: string; text?: string; aborted: boolean };

export type HuddleReceipt = {
  channelId: string;
  agentPubkey: string | null;
  joinedAt: number | null;
  leftAt: number | null;
  endReason: string | null;
  heard: TranscriptSegment[];
  said: SaidEntry[];
  minutesListened: number;
  minutesSpoken: number;
  truncated: boolean;
};

const MAX_RECEIPT_ENTRIES = 20_000;
const VAD_TICK_MS = 100;

const realTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createHuddleSession(options: HuddleSessionOptions) {
  const timers = options.timers ?? realTimers;
  const now = options.now ?? (() => Date.now());
  const modes = { listen: options.modes.listen === true, speakApproved: options.modes.speakApproved === true, speakLive: options.modes.speakLive === true };
  const heard: TranscriptSegment[] = [];
  const said: SaidEntry[] = [];
  let truncated = false;
  let endReason: string | null = null;
  let vadTimer: unknown = null;

  const listen = createListenPipeline({
    speech: options.speech,
    ...(options.language ? { language: options.language } : {}),
    ...(options.vad ? { vad: options.vad } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    onTranscript: (segment) => {
      if (heard.length < MAX_RECEIPT_ENTRIES) heard.push(segment);
      else truncated = true;
      try {
        options.onTranscript?.(segment);
      } catch {
        // Listener errors are ignored.
      }
    },
  });

  const vadTick = () => {
    vadTimer = timers.setTimeout(() => {
      vadTimer = null;
      if (client.state !== "joined") return;
      listen.tick(now());
      vadTick();
    }, VAD_TICK_MS);
  };

  const client = createHuddleAudioClient({
    credential: options.credential,
    channelId: options.channelId,
    ...(options.pinnedOwner ? { pinnedOwner: options.pinnedOwner } : {}),
    ...(options.parentChannelId !== undefined ? { parentChannelId: options.parentChannelId } : {}),
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.maxSessionMs !== undefined ? { maxSessionMs: options.maxSessionMs } : {}),
    ...(options.joinTimeoutMs !== undefined ? { joinTimeoutMs: options.joinTimeoutMs } : {}),
    ...(options.closeGraceMs !== undefined ? { closeGraceMs: options.closeGraceMs } : {}),
    ...(options.streams ? { streams: options.streams } : {}),
    timers,
    now,
    onFrame: (frame) => {
      if (modes.listen) listen.onFrame(frame);
    },
    onPeer: (change) => {
      if (change.type === "left") listen.endSpeaker(change.pubkey);
    },
    onClosed: (reason) => {
      endReason = endReason ?? reason;
      if (vadTimer !== null) timers.clearTimeout(vadTimer);
      vadTimer = null;
      speaker.abort();
      listen.stop();
      try {
        options.onEnded?.(reason);
      } catch {
        // Listener errors are ignored.
      }
    },
  });

  const speaker = createSpeaker({
    client,
    speech: options.speech,
    timers,
    now,
    ...(options.maxClipSeconds !== undefined ? { maxClipSeconds: options.maxClipSeconds } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
  });

  const recordSaid = (entry: SaidEntry) => {
    if (said.length < MAX_RECEIPT_ENTRIES) said.push(entry);
    else truncated = true;
  };

  return {
    async join(): Promise<{ peers: string[] }> {
      const joined = await client.join();
      vadTick();
      return { peers: joined.peers };
    },
    /** `speak-approved`: plays an owner-approved Ogg/Opus clip. */
    async speak(oggOpus: Uint8Array): Promise<SpeakResult> {
      if (!modes.speakApproved) throw new HuddleError("huddle_mode_not_permitted");
      const startedAt = now();
      const result = await speaker.speak(oggOpus);
      recordSaid({ kind: "clip", startedAt, endedAt: now(), sha256: result.sha256, aborted: result.aborted });
      return result;
    },
    /** `speak-live`: synthesises the agent's text and speaks it. */
    async speakText(text: string, input: { voice?: string } = {}): Promise<SpeakResult & { text: string }> {
      if (!modes.speakLive) throw new HuddleError("huddle_mode_not_permitted");
      const startedAt = now();
      const result = await speaker.speakText(text, input);
      recordSaid({ kind: "text", startedAt, endedAt: now(), sha256: result.sha256, text: result.text, aborted: result.aborted });
      return result;
    },
    /** Owner stop, pause or revoke: aborts speaking and transcription, leaves the huddle; resolves within 5 s. */
    async stop(reason = "stopped"): Promise<void> {
      endReason = endReason ?? reason;
      speaker.abort();
      listen.stop();
      let deadline: unknown = null;
      await Promise.race([
        client.stop(reason),
        new Promise<void>((resolve) => {
          deadline = timers.setTimeout(resolve, HUDDLE_STOP_DEADLINE_MS - 250);
        }),
      ]);
      if (deadline !== null) timers.clearTimeout(deadline);
    },
    /** Waits until queued transcriptions are done (tests, graceful end). */
    idle: () => listen.idle(),
    receipt(): HuddleReceipt {
      return {
        channelId: options.channelId,
        agentPubkey: client.selfPubkey,
        joinedAt: client.joinedAt,
        leftAt: client.leftAt,
        endReason,
        heard: [...heard],
        said: [...said],
        minutesListened: listen.minutesListened,
        minutesSpoken: speaker.minutesSpoken,
        truncated,
      };
    },
    get state(): HuddleClientState {
      return client.state;
    },
    get minutesListened(): number {
      return listen.minutesListened;
    },
    get minutesSpoken(): number {
      return speaker.minutesSpoken;
    },
    /** Audio bytes currently held in memory (reorder window + open utterances + queue). */
    get bufferedAudioBytes(): number {
      return listen.bufferedBytes;
    },
    get peers(): string[] {
      return client.peers;
    },
    clientStats: client.stats,
    listenStats: listen.stats,
  };
}

export type HuddleSession = ReturnType<typeof createHuddleSession>;

import { randomInt } from "node:crypto";

import { type BinarySocket, type BinarySocketFactory, buzzPrivateRelayAllowed, guardedHuddleSocketFactory } from "../buzz-relay-guard.js";
import type { Timers } from "../discord-gateway.js";
import { checkBuzzCredential } from "../providers/buzz.js";
import { authEvent } from "../providers/nostr.js";
import { opusPacketSamples } from "../providers/ogg-opus.js";

import {
  decodeRelayFrame,
  encodeFrame,
  HUDDLE_FLAG_DTX,
  HUDDLE_FRAME_MS,
  HUDDLE_FRAME_SAMPLES,
  HUDDLE_MAX_PACKET_BYTES,
  HUDDLE_MAX_TEXT_BYTES,
  HUDDLE_SILENCE_DBOV,
  type HuddleProtocolVersion,
} from "./frame.js";
import { createSpeakerStreams, type SpeakerFrame, type SpeakerStreamOptions } from "./jitter.js";

/**
 * Buzz huddle audio client (Channels P2 §3 "Huddles", gated: no agent operation or route uses it before the
 * live-session grant, contract alpha.8). Protocol facts, buzz-src paths:
 *
 * - Socket: `{relay}/huddle/{channel_id}/audio` (crates/buzz-relay/src/router.rs, audio/handler.rs). The relay is
 *   ONLY the owner-configured relay inside the Buzz credential; the socket is the guarded, address-pinned connect
 *   (buzz-relay-guard), like every other relay connection.
 * - NIP-42 per participant: the relay sends `{"type":"challenge","challenge"}` (5 s AUTH_TIMEOUT); the client
 *   answers `{"type":"auth","event":<kind 22242: relay, challenge, owner NIP-OA tag>,"parent_channel_id",
 *   "protocol_version"}` (desktop huddle/relay_api.rs). An ephemeral huddle channel needs `parent_channel_id`
 *   (the relay checks the creator-signed 48100 link and auto-adds parent members).
 * - Admission: `{"type":"joined","revision","pubkey","peer_index","epoch","peers":[…]}` broadcast to the room;
 *   later `joined` / `left` / `roster` control frames keep the peer_index → pubkey map; `{"type":"error",
 *   "code"?,"message"}` refuses (room_full at 25 peers, upgrade_required, auth failed, not a member …).
 * - Lifecycle events 48101 joined / 48102 left / 48103 ended (auto) are signed and published BY THE RELAY on
 *   socket admission and disconnect; 48104 liveness is relay-synthesized per REQ. A participant publishes none of
 *   them, so this client signs only the kind-22242 AUTH event.
 * - Leave: `{"type":"leave"}` then a normal close (the relay accepts either; it then emits 48102).
 * - Keepalive: the relay pings every 30 s; the WebSocket runtime answers pongs.
 *
 * Audio is only ever in bounded in-memory buffers (the reorder window); nothing is written to disk or a database.
 */

export const HUDDLE_MAX_SESSION_MS = 2 * 60 * 60 * 1000;
/** stop() resolves within this bound (scope §2.3: the agent leaves within 5 s). */
export const HUDDLE_STOP_DEADLINE_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

export type HuddleClientState = "idle" | "connecting" | "authenticating" | "joined" | "leaving" | "closed";

export type HuddleClientOptions = {
  /** The connection's Buzz credential (agent key, owner relay URL, owner NIP-OA tag). */
  credential: string;
  /** The pinned owner Buzz key; the tag must name it. */
  pinnedOwner?: () => string | null;
  /** The huddle's (ephemeral) channel UUID. */
  channelId: string;
  /** The parent channel UUID (required by the relay for an ephemeral huddle channel). */
  parentChannelId?: string | null;
  /** 2 (default, what the Desktop pins; a room is pinned to its first peer's version) or 3. */
  protocolVersion?: HuddleProtocolVersion;
  socketFactory?: BinarySocketFactory;
  env?: Record<string, string | undefined>;
  timers?: Timers;
  now?: () => number;
  /** Challenge → joined deadline (default 10 s). */
  joinTimeoutMs?: number;
  /** Hard session limit (default and maximum 2 h, scope §2.3). */
  maxSessionMs?: number;
  /** How long stop() waits for the relay's close before it detaches (default 2 s, at most 4 s). */
  closeGraceMs?: number;
  streams?: SpeakerStreamOptions;
  onFrame?: (frame: SpeakerFrame) => void;
  onPeer?: (change: { type: "joined" | "left"; pubkey: string }) => void;
  onClosed?: (reason: string) => void;
};

export class HuddleError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function relayErrorCode(value: Record<string, unknown>): string {
  if (typeof value.code === "string" && /^[a-z_]{1,64}$/u.test(value.code)) return value.code;
  const message = typeof value.message === "string" ? value.message : "";
  if (message === "auth failed") return "auth_failed";
  if (message.startsWith("restricted")) return "not_relay_member";
  if (message === "not a member") return "not_member";
  if (message === "huddle has ended") return "room_ended";
  return "relay_error";
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function createHuddleAudioClient(options: HuddleClientOptions) {
  const timers = options.timers ?? realTimers;
  const now = options.now ?? (() => Date.now());
  const nowSeconds = () => Math.floor(now() / 1000);
  const version: HuddleProtocolVersion = options.protocolVersion ?? 2;
  const joinTimeoutMs = options.joinTimeoutMs ?? 10_000;
  const maxSessionMs = Math.min(HUDDLE_MAX_SESSION_MS, Math.max(1, options.maxSessionMs ?? HUDDLE_MAX_SESSION_MS));
  const closeGraceMs = Math.min(4000, Math.max(0, options.closeGraceMs ?? 2000));
  const factory =
    options.socketFactory ?? guardedHuddleSocketFactory({ allowPrivate: buzzPrivateRelayAllowed(options.env ?? (process.env as Record<string, string | undefined>)) });

  let state: HuddleClientState = "idle";
  let socket: BinarySocket | null = null;
  let selfPubkey: string | null = null;
  let selfIndex: number | null = null;
  let joinedAt: number | null = null;
  let leftAt: number | null = null;
  let closeReason: string | null = null;
  let sendSeq = randomInt(0, 0x1_0000);
  let sendTs = randomInt(0, 0x1_0000_0000);
  const peers = new Map<number, { pubkey: string; epoch: number }>();
  const stats = { framesSent: 0, framesReceived: 0, framesDropped: 0, unknownPeer: 0, controlFrames: 0 };
  const timerHandles = new Set<unknown>();
  let socketClosed: (() => void) | null = null;
  let pendingJoin: { resolve: (value: { peerIndex: number; peers: string[] }) => void; reject: (error: HuddleError) => void } | null = null;
  let stopPromise: Promise<void> | null = null;

  const streams = createSpeakerStreams(options.streams ?? {}, (frame) => options.onFrame?.(frame));

  const later = (callback: () => void, ms: number) => {
    const handle = timers.setTimeout(() => {
      timerHandles.delete(handle);
      callback();
    }, ms);
    timerHandles.add(handle);
    return handle;
  };
  const clearTimers = () => {
    for (const handle of timerHandles) timers.clearTimeout(handle);
    timerHandles.clear();
  };
  const sendText = (value: unknown) => {
    try {
      socket?.send(JSON.stringify(value));
    } catch {
      // A send on a closing socket is lost; close handling follows.
    }
  };

  const scheduleTick = () => {
    later(() => {
      if (state !== "joined") return;
      streams.tick(now());
      scheduleTick();
    }, HUDDLE_FRAME_MS);
  };

  const applyPeers = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list.slice(0, 255)) {
      const peer = entry as { pubkey?: unknown; peer_index?: unknown; epoch?: unknown };
      if (typeof peer.pubkey === "string" && HEX64.test(peer.pubkey) && Number.isInteger(peer.peer_index) && (peer.peer_index as number) >= 0 && (peer.peer_index as number) <= 254) {
        peers.set(peer.peer_index as number, { pubkey: peer.pubkey, epoch: Number.isInteger(peer.epoch) ? (peer.epoch as number) & 0xff : 0 });
      }
    }
  };

  /** Ends the session locally: detaches the socket, drops every held frame, reports once. */
  const finish = (reason: string) => {
    if (state === "closed") return;
    state = "closed";
    closeReason = reason;
    leftAt = now();
    clearTimers();
    streams.clear();
    peers.clear();
    const current = socket;
    socket = null;
    if (current) {
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      try {
        current.close(1000);
      } catch {
        // Already closed.
      }
    }
    const resolveClosed = socketClosed;
    socketClosed = null;
    resolveClosed?.();
    if (pendingJoin) {
      pendingJoin.reject(new HuddleError(reason));
      pendingJoin = null;
    }
    try {
      options.onClosed?.(reason);
    } catch {
      // Listener errors are ignored.
    }
  };

  const onControl = (value: Record<string, unknown>) => {
    stats.controlFrames += 1;
    const type = value.type;
    if (type === "challenge" && typeof value.challenge === "string" && value.challenge.length > 0 && value.challenge.length <= 512) {
      if (state !== "connecting" && state !== "authenticating") return;
      const checked = checkBuzzCredential(options.credential, nowSeconds(), options.pinnedOwner ? options.pinnedOwner() : undefined);
      if (!checked.ok) {
        finish("credential_invalid");
        return;
      }
      const { credential } = checked;
      const event = authEvent(credential.secretKey, { relayUrl: credential.endpoint.relayUrl, challenge: value.challenge, authTag: credential.auth.tag, nowSeconds: nowSeconds() });
      state = "authenticating";
      sendText({ type: "auth", event, parent_channel_id: options.parentChannelId ?? null, protocol_version: version });
      return;
    }
    if (type === "error") {
      finish(relayErrorCode(value));
      return;
    }
    if (type === "joined" && typeof value.pubkey === "string") {
      applyPeers(value.peers);
      if (Number.isInteger(value.peer_index) && HEX64.test(value.pubkey)) {
        peers.set(value.peer_index as number, { pubkey: value.pubkey, epoch: Number.isInteger(value.epoch) ? (value.epoch as number) & 0xff : 0 });
      }
      if (value.pubkey === selfPubkey && state === "authenticating") {
        state = "joined";
        selfIndex = Number.isInteger(value.peer_index) ? (value.peer_index as number) : null;
        joinedAt = now();
        later(() => void stop("max_duration"), maxSessionMs);
        scheduleTick();
        const others = [...peers.values()].map((peer) => peer.pubkey).filter((pubkey) => pubkey !== selfPubkey);
        pendingJoin?.resolve({ peerIndex: selfIndex ?? -1, peers: others });
        pendingJoin = null;
      } else if (value.pubkey !== selfPubkey) {
        options.onPeer?.({ type: "joined", pubkey: value.pubkey });
      }
      return;
    }
    if (type === "left" && typeof value.pubkey === "string") {
      if (Number.isInteger(value.peer_index)) {
        const known = peers.get(value.peer_index as number);
        if (known && known.pubkey === value.pubkey) peers.delete(value.peer_index as number);
      }
      streams.remove(value.pubkey);
      if (value.pubkey !== selfPubkey) options.onPeer?.({ type: "left", pubkey: value.pubkey });
      return;
    }
    if (type === "roster") {
      peers.clear();
      applyPeers(value.peers);
    }
  };

  const onBinary = (bytes: Uint8Array) => {
    if (state !== "joined") return;
    stats.framesReceived += 1;
    const frame = decodeRelayFrame(bytes, version);
    if (!frame) {
      stats.framesDropped += 1;
      return;
    }
    const peer = peers.get(frame.peerIndex);
    if (!peer || (frame.epoch !== null && frame.epoch !== peer.epoch)) {
      stats.unknownPeer += 1;
      return;
    }
    if (peer.pubkey === selfPubkey || frame.peerIndex === selfIndex) return;
    // A copy: the frame must not keep the socket's message buffer alive.
    const result = streams.push(peer.pubkey, frame.header, Uint8Array.from(frame.payload), now());
    if (result !== "accepted") stats.framesDropped += 1;
  };

  async function join(): Promise<{ peerIndex: number; peers: string[] }> {
    if (state !== "idle") throw new HuddleError("huddle_already_started");
    if (!UUID.test(options.channelId)) throw new HuddleError("huddle_channel_invalid");
    if (options.parentChannelId != null && !UUID.test(options.parentChannelId)) throw new HuddleError("huddle_parent_invalid");
    const checked = checkBuzzCredential(options.credential, nowSeconds(), options.pinnedOwner ? options.pinnedOwner() : undefined);
    if (!checked.ok) throw new HuddleError("credential_invalid");
    selfPubkey = checked.credential.pubkey;
    state = "connecting";
    const url = `${checked.credential.endpoint.relayUrl}/huddle/${options.channelId}/audio`;
    const result = new Promise<{ peerIndex: number; peers: string[] }>((resolve, reject) => {
      pendingJoin = { resolve, reject };
    });
    let next: BinarySocket;
    try {
      next = factory(url);
    } catch {
      finish("connect_failed");
      return result;
    }
    socket = next;
    if ("binaryType" in next) next.binaryType = "arraybuffer";
    later(() => {
      if (state === "connecting" || state === "authenticating") finish("join_timeout");
    }, joinTimeoutMs);
    // Never outlive the owner's authorisation (NIP-OA end date).
    const untilExpiry = Math.max(0, checked.credential.auth.expiresAt * 1000 - now());
    if (untilExpiry <= maxSessionMs + joinTimeoutMs) later(() => void stop("auth_tag_expired"), untilExpiry);
    next.onmessage = (event) => {
      if (socket !== next) return;
      if (typeof event.data === "string") {
        if (event.data.length > HUDDLE_MAX_TEXT_BYTES) return;
        let value: unknown;
        try {
          value = JSON.parse(event.data);
        } catch {
          return;
        }
        if (value && typeof value === "object" && !Array.isArray(value)) onControl(value as Record<string, unknown>);
        return;
      }
      const bytes = toBytes(event.data);
      if (bytes) onBinary(bytes);
      else stats.framesDropped += 1;
    };
    next.onerror = () => undefined;
    next.onclose = () => {
      if (socket !== next) return;
      finish(state === "leaving" ? (closeReason ?? "left") : state === "joined" ? "connection_lost" : "connect_failed");
    };
    return result;
  }

  /** Sends one Opus packet (normally 20 ms) with the next seq/ts. Refused unless joined. */
  function sendPacket(packet: Uint8Array, meta: { dBov?: number; dtx?: boolean } = {}): void {
    if (state !== "joined" || !socket) throw new HuddleError("huddle_not_joined");
    if (packet.length === 0 || packet.length > HUDDLE_MAX_PACKET_BYTES) throw new HuddleError("huddle_packet_size_invalid");
    const samples = opusPacketSamples(packet) || HUDDLE_FRAME_SAMPLES;
    const dtx = meta.dtx ?? packet.length <= 2;
    const frame = encodeFrame({ seq: sendSeq, ts: sendTs, dBov: dtx ? HUDDLE_SILENCE_DBOV : (meta.dBov ?? HUDDLE_SILENCE_DBOV), flags: dtx ? HUDDLE_FLAG_DTX : 0 }, packet);
    sendSeq = (sendSeq + 1) & 0xffff;
    sendTs = (sendTs + samples) >>> 0;
    socket.send(frame);
    stats.framesSent += 1;
  }

  /**
   * Leaves at once and resolves within 5 s whatever the relay does: sends `leave`, closes, waits up to
   * `closeGraceMs` for the close, then detaches. Every held audio frame is dropped. Idempotent.
   */
  function stop(reason = "stopped"): Promise<void> {
    if (stopPromise) return stopPromise;
    if (state === "closed" || state === "idle") {
      if (state === "idle") finish(reason);
      stopPromise = Promise.resolve();
      return stopPromise;
    }
    const wasJoined = state === "joined";
    state = "leaving";
    closeReason = reason;
    clearTimers();
    streams.clear();
    if (pendingJoin) {
      pendingJoin.reject(new HuddleError(reason));
      pendingJoin = null;
    }
    stopPromise = new Promise<void>((resolve) => {
      const done = () => {
        finish(reason);
        resolve();
      };
      socketClosed = done;
      if (wasJoined) sendText({ type: "leave" });
      try {
        socket?.close(1000);
      } catch {
        // Already closing.
      }
      timers.setTimeout(done, closeGraceMs);
    });
    return stopPromise;
  }

  return {
    join,
    sendPacket,
    stop,
    /** Graceful leave (same as stop). */
    leave: () => stop("left"),
    get state(): HuddleClientState {
      return state;
    },
    get selfPubkey(): string | null {
      return selfPubkey;
    },
    get joinedAt(): number | null {
      return joinedAt;
    },
    get leftAt(): number | null {
      return leftAt;
    },
    get closeReason(): string | null {
      return closeReason;
    },
    /** Other participants currently known (pubkeys). */
    get peers(): string[] {
      return [...new Set([...peers.values()].map((peer) => peer.pubkey))].filter((pubkey) => pubkey !== selfPubkey);
    },
    get heldFrames(): number {
      return streams.heldFrames;
    },
    stats,
    streamStats: streams.stats,
  };
}

export type HuddleAudioClient = ReturnType<typeof createHuddleAudioClient>;

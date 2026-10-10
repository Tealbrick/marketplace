// Buzz huddle audio wire format (buzz-src: crates/buzz-relay/src/audio/wire.rs, desktop/src-tauri/src/huddle/wire.rs).
//
// Client → relay (protocol v2/v3): [header 8 bytes][Opus packet]
// Relay → client: v2 [peer_index u8][header][Opus]; v3 [peer_index u8][epoch u8][header][Opus] (room.rs broadcast_frame).
// Header, network byte order: seq u16 (+1 per packet, wraps), ts_48k u32 (48 kHz samples, +960 per 20 ms frame,
// wraps), level_dbov i8 in [-127, 0] (-127 = silence; out of range reads as -127, the frame is kept), flags u8
// (bit 0 = DTX; other bits reserved and ignored).

export const HUDDLE_HEADER_LEN = 8;
export const HUDDLE_FLAG_DTX = 0x01;
/** Relay drops binary frames larger than this (handler.rs MAX_AUDIO_FRAME_BYTES); it is header + Opus. */
export const HUDDLE_MAX_FRAME_BYTES = 4096;
/** Largest Opus packet that fits a frame. */
export const HUDDLE_MAX_PACKET_BYTES = HUDDLE_MAX_FRAME_BYTES - HUDDLE_HEADER_LEN;
/** Relay text frame cap (handler.rs MAX_TEXT_FRAME_BYTES). */
export const HUDDLE_MAX_TEXT_BYTES = 8192;
export const HUDDLE_SAMPLE_RATE = 48_000;
export const HUDDLE_FRAME_MS = 20;
/** 20 ms at 48 kHz (desktop jitter.rs FRAME_TIMESTAMP_DELTA). */
export const HUDDLE_FRAME_SAMPLES = 960;
/** Silence floor in dBov. */
export const HUDDLE_SILENCE_DBOV = -127;
/** Protocol versions the relay accepts (handler.rs CURRENT_PROTOCOL_VERSION = 3); the Desktop pins v2 (wire.rs). */
export type HuddleProtocolVersion = 2 | 3;

export type FrameHeader = { seq: number; ts: number; dBov: number; flags: number };

/** Canonical dBov: an integer in [-127, 0]; anything else (NaN, positive, below the floor) is the silence floor. */
export function clampDbov(value: number): number {
  if (!Number.isFinite(value)) return HUDDLE_SILENCE_DBOV;
  const rounded = Math.round(value);
  return rounded > 0 || rounded < HUDDLE_SILENCE_DBOV ? HUDDLE_SILENCE_DBOV : rounded;
}

/** One client → relay frame: header (seq and ts wrap) followed by the Opus packet. */
export function encodeFrame(header: FrameHeader, packet: Uint8Array): Uint8Array {
  if (packet.length === 0 || packet.length > HUDDLE_MAX_PACKET_BYTES) throw new Error("huddle_packet_size_invalid");
  const frame = new Uint8Array(HUDDLE_HEADER_LEN + packet.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, header.seq & 0xffff, false);
  view.setUint32(2, header.ts >>> 0, false);
  view.setInt8(6, clampDbov(header.dBov));
  view.setUint8(7, header.flags & 0xff);
  frame.set(packet, HUDDLE_HEADER_LEN);
  return frame;
}

/** Header + payload of a frame without the relay's peer prefix; null when malformed (no header or empty payload). */
export function decodeFrame(bytes: Uint8Array): { header: FrameHeader; payload: Uint8Array } | null {
  if (bytes.length <= HUDDLE_HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = view.getInt8(6);
  return {
    header: {
      seq: view.getUint16(0, false),
      ts: view.getUint32(2, false),
      dBov: raw > 0 || raw < HUDDLE_SILENCE_DBOV ? HUDDLE_SILENCE_DBOV : raw,
      flags: view.getUint8(7),
    },
    payload: bytes.subarray(HUDDLE_HEADER_LEN),
  };
}

export type RelayFrame = { peerIndex: number; epoch: number | null; header: FrameHeader; payload: Uint8Array };

/** A relay → client frame for the room's protocol version; null when malformed or over the size limit. */
export function decodeRelayFrame(bytes: Uint8Array, version: HuddleProtocolVersion): RelayFrame | null {
  const prefix = version >= 3 ? 2 : 1;
  if (bytes.length > HUDDLE_MAX_FRAME_BYTES + prefix || bytes.length <= prefix) return null;
  const decoded = decodeFrame(bytes.subarray(prefix));
  if (!decoded) return null;
  return { peerIndex: bytes[0] as number, epoch: version >= 3 ? (bytes[1] as number) : null, ...decoded };
}

/** Test and fake-relay helper: the relay's prefixed form of a client frame. */
export function prefixRelayFrame(frame: Uint8Array, peerIndex: number, version: HuddleProtocolVersion, epoch = 0): Uint8Array {
  const prefix = version >= 3 ? [peerIndex & 0xff, epoch & 0xff] : [peerIndex & 0xff];
  const out = new Uint8Array(prefix.length + frame.length);
  out.set(prefix, 0);
  out.set(frame, prefix.length);
  return out;
}

/** Signed distance a - b on the u16 sequence circle (-32768..32767). */
export function seqDelta(a: number, b: number): number {
  return ((((a - b) & 0xffff) + 0x8000) & 0xffff) - 0x8000;
}

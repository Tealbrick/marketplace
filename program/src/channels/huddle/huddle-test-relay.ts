import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { signTestEvent, TEST_RELAY_SECRET } from "../providers/buzz-test-relay.js";
import { publicKeyOf, verifyAuthTag, verifyEvent, type NostrEvent } from "../providers/nostr.js";

import { decodeFrame, type FrameHeader, HUDDLE_MAX_FRAME_BYTES, prefixRelayFrame, type HuddleProtocolVersion } from "./frame.js";

// Test-only: an in-process Buzz huddle audio endpoint on 127.0.0.1 (node:http + a manual RFC 6455 upgrade), modelled
// on crates/buzz-relay/src/audio/handler.rs and room.rs: challenge, NIP-42 auth message with the NIP-OA tag
// (owner must be a relay member), ephemeral parent linkage, membership (or parent-member auto-add), version pin,
// peer_index allocation, `joined`/`left` control broadcasts, prefixed fan-out, `leave`, 25-peer cap, and the
// RELAY-signed 48101/48102 lifecycle events. Never imported by runtime code.

export const HUDDLE_TEST_RELAY_PUBKEY = publicKeyOf(TEST_RELAY_SECRET)!;

type Channel = { parentId: string | null; members: Set<string>; parentMembers: Set<string> };

type Peer = {
  pubkey: string;
  index: number;
  epoch: number;
  conn: Conn | null;
};

type Room = { version: number | null; peers: Map<number, Peer>; revision: number; epochs: Map<number, number> };

export type ReceivedFrame = { header: FrameHeader; payload: Uint8Array; at: number };

type Conn = {
  socket: Socket;
  channelId: string;
  challenge: string;
  peer: Peer | null;
  framesIn: ReceivedFrame[];
  textIn: unknown[];
  textOut: unknown[];
  closed: boolean;
  buffer: Buffer;
  authEvent: NostrEvent | null;
};

function encodeWsFrame(opcode: number, payload: Uint8Array): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export function createFakeHuddleRelay(options: { host?: string; members?: string[]; ignoreClose?: boolean; ignoreLeave?: boolean; now?: () => number } = {}) {
  const host = options.host ?? "relay.buzz.test";
  const relayUrl = `wss://${host}`;
  const now = options.now ?? (() => Date.now());
  const members = new Set(options.members ?? []);
  const channels = new Map<string, Channel>();
  const rooms = new Map<string, Room>();
  const conns: Conn[] = [];
  const events: NostrEvent[] = [];
  const upgrades: string[] = [];
  let port = 0;

  const room = (channelId: string) => {
    let existing = rooms.get(channelId);
    if (!existing) {
      existing = { version: null, peers: new Map(), revision: 0, epochs: new Map() };
      rooms.set(channelId, existing);
    }
    return existing;
  };

  const sendText = (conn: Conn, value: unknown) => {
    if (conn.closed) return;
    conn.textOut.push(value);
    conn.socket.write(encodeWsFrame(0x1, Buffer.from(JSON.stringify(value), "utf8")));
  };
  const sendBinary = (conn: Conn, bytes: Uint8Array) => {
    if (!conn.closed) conn.socket.write(encodeWsFrame(0x2, bytes));
  };
  const closeConn = (conn: Conn, code = 1000) => {
    if (conn.closed) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    conn.socket.write(encodeWsFrame(0x8, body));
    conn.closed = true;
    conn.socket.end();
  };

  const lifecycle = (kind: number, channelId: string, pubkey: string, extra: Record<string, unknown>) => {
    const channel = channels.get(channelId);
    const parent = channel?.parentId ?? channelId;
    events.push(
      signTestEvent(TEST_RELAY_SECRET, {
        kind,
        created_at: Math.floor(now() / 1000),
        tags: [
          ["h", parent],
          ["p", pubkey],
        ],
        content: JSON.stringify({ ephemeral_channel_id: channelId, ...extra, generation: "test-generation" }),
      }),
    );
  };

  const roster = (target: Room) => [...target.peers.values()].map((peer) => ({ pubkey: peer.pubkey, peer_index: peer.index, epoch: peer.epoch }));

  const broadcastControl = (channelId: string, value: unknown) => {
    for (const peer of room(channelId).peers.values()) if (peer.conn) sendText(peer.conn, value);
  };

  const admit = (channelId: string, pubkey: string, conn: Conn | null): Peer | "room_full" => {
    const target = room(channelId);
    if (target.peers.size >= 25) return "room_full";
    let index = 0;
    while (target.peers.has(index)) index += 1;
    const epoch = target.epochs.get(index) ?? 0;
    target.epochs.set(index, (epoch + 1) & 0xff);
    const peer: Peer = { pubkey, index, epoch, conn };
    target.peers.set(index, peer);
    target.revision += 1;
    broadcastControl(channelId, { type: "joined", revision: target.revision, pubkey, peer_index: index, epoch, peers: roster(target) });
    lifecycle(48101, channelId, pubkey, { roster_revision: target.revision, admission_id: randomBytes(8).toString("hex") });
    return peer;
  };

  const removePeer = (channelId: string, peer: Peer) => {
    const target = room(channelId);
    if (target.peers.get(peer.index) !== peer) return;
    target.peers.delete(peer.index);
    target.revision += 1;
    broadcastControl(channelId, { type: "left", revision: target.revision, pubkey: peer.pubkey, peer_index: peer.index, epoch: peer.epoch });
    lifecycle(48102, channelId, peer.pubkey, { roster_revision: target.revision });
    if (target.peers.size === 0) target.version = null;
  };

  const fanOut = (channelId: string, from: Peer, frame: Uint8Array) => {
    const target = room(channelId);
    const prefixed = prefixRelayFrame(frame, from.index, (target.version ?? 2) >= 3 ? 3 : 2, from.epoch);
    for (const peer of target.peers.values()) if (peer !== from && peer.conn) sendBinary(peer.conn, prefixed);
  };

  const onAuth = (conn: Conn, message: Record<string, unknown>) => {
    const event = message.event;
    const error = (value: Record<string, unknown>) => {
      sendText(conn, { type: "error", ...value });
      closeConn(conn);
    };
    if (!verifyEvent(event) || event.kind !== 22242) return error({ message: "auth failed" });
    const tag = (name: string) => event.tags.find((entry) => entry[0] === name);
    if (tag("relay")?.[1] !== relayUrl || tag("challenge")?.[1] !== conn.challenge || Math.abs(event.created_at - now() / 1000) > 600) return error({ message: "auth failed" });
    conn.authEvent = event;
    const authTag = tag("auth");
    const checked = authTag ? verifyAuthTag({ tag: authTag, agentPubkey: event.pubkey, nowSeconds: Math.floor(now() / 1000) }) : null;
    if (!checked?.ok || !members.has(checked.value.ownerPubkey)) return error({ message: "restricted: not a relay member" });
    const channel = channels.get(conn.channelId);
    if (!channel) return error({ message: "not a member" });
    if (channel.parentId !== null && message.parent_channel_id !== channel.parentId) return error({ message: "not a member" });
    if (!channel.members.has(event.pubkey)) {
      if (channel.parentId !== null && channel.parentMembers.has(event.pubkey)) channel.members.add(event.pubkey);
      else return error({ message: "not a member" });
    }
    const version = typeof message.protocol_version === "number" ? message.protocol_version : 1;
    if (!Number.isInteger(version) || version < 1 || version > 3) return error({ code: "unsupported_version", message: "unsupported", current_version: 3 });
    const target = room(conn.channelId);
    if (target.version !== null && target.version !== version) return error({ code: "upgrade_required", message: "version mismatch" });
    target.version = version;
    const admitted = admit(conn.channelId, event.pubkey, conn);
    if (admitted === "room_full") return error({ code: "room_full", message: "room participant capacity reached" });
    conn.peer = admitted;
  };

  const onMessage = (conn: Conn, opcode: number, payload: Buffer) => {
    if (opcode === 0x1) {
      let value: unknown;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        return;
      }
      conn.textIn.push(value);
      const message = (value ?? {}) as Record<string, unknown>;
      if (message.type === "auth" && !conn.peer) onAuth(conn, message);
      else if (message.type === "leave" && conn.peer && !options.ignoreLeave) {
        removePeer(conn.channelId, conn.peer);
        conn.peer = null;
        closeConn(conn);
      }
      return;
    }
    if (opcode === 0x2) {
      if (!conn.peer || payload.length > HUDDLE_MAX_FRAME_BYTES) return;
      const decoded = decodeFrame(payload);
      if (!decoded) return;
      conn.framesIn.push({ header: decoded.header, payload: Uint8Array.from(decoded.payload), at: now() });
      fanOut(conn.channelId, conn.peer, Uint8Array.from(payload));
      return;
    }
    if (opcode === 0x8) {
      if (options.ignoreClose) return;
      if (conn.peer) {
        removePeer(conn.channelId, conn.peer);
        conn.peer = null;
      }
      closeConn(conn);
      return;
    }
    if (opcode === 0x9) conn.socket.write(encodeWsFrame(0xa, payload));
  };

  const onData = (conn: Conn, chunk: Buffer) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    for (;;) {
      const buffer = conn.buffer;
      if (buffer.length < 2) return;
      const opcode = buffer[0]! & 0x0f;
      const masked = (buffer[1]! & 0x80) !== 0;
      let length = buffer[1]! & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let index = 0; index < payload.length; index += 1) payload[index]! ^= buffer[maskOffset + (index % 4)]!;
      conn.buffer = buffer.subarray(offset + length);
      onMessage(conn, opcode, payload);
    }
  };

  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    upgrades.push(request.url ?? "");
    const match = /^\/huddle\/([0-9a-f-]{36})\/audio$/u.exec(request.url ?? "");
    const key = request.headers["sec-websocket-key"];
    if (!match || typeof key !== "string") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn: Conn = { socket, channelId: match[1]!, challenge: randomBytes(16).toString("hex"), peer: null, framesIn: [], textIn: [], textOut: [], closed: false, buffer: Buffer.alloc(0), authEvent: null };
    conns.push(conn);
    socket.on("data", (chunk: Buffer) => onData(conn, chunk));
    socket.on("close", () => {
      conn.closed = true;
      if (conn.peer) {
        removePeer(conn.channelId, conn.peer);
        conn.peer = null;
      }
    });
    socket.on("error", () => undefined);
    sendText(conn, { type: "challenge", challenge: conn.challenge });
  });

  return {
    relayUrl,
    host,
    events,
    upgrades,
    conns,
    rooms,
    relayPubkey: HUDDLE_TEST_RELAY_PUBKEY,
    async start(): Promise<number> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
      return port;
    },
    get port(): number {
      return port;
    },
    async close(): Promise<void> {
      for (const conn of conns) conn.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    addMember(ownerPubkey: string): void {
      members.add(ownerPubkey);
    },
    /** A channel; `parentId` makes it an ephemeral huddle channel linked to that parent. */
    addChannel(channelId: string, input: { parentId?: string | null; members?: string[]; parentMembers?: string[] } = {}): void {
      channels.set(channelId, { parentId: input.parentId ?? null, members: new Set(input.members ?? []), parentMembers: new Set(input.parentMembers ?? []) });
    },
    /** A participant that is not a socket (a Desktop user simulated by the relay). */
    addVirtualPeer(channelId: string, pubkey: string, version: HuddleProtocolVersion = 2) {
      const target = room(channelId);
      target.version = target.version ?? version;
      const peer = admit(channelId, pubkey, null);
      if (peer === "room_full") throw new Error("room_full");
      return {
        peer,
        send(frame: Uint8Array): void {
          fanOut(channelId, peer, frame);
        },
        /** Raw prefixed bytes (to test the client's checks). */
        sendRaw(bytes: Uint8Array): void {
          for (const other of room(channelId).peers.values()) if (other !== peer && other.conn) sendBinary(other.conn, bytes);
        },
        leave(): void {
          removePeer(channelId, peer);
        },
      };
    },
    /** Raw control frame to every socket peer of a channel (malformed-input tests). */
    sendControl(channelId: string, value: unknown): void {
      broadcastControl(channelId, value);
    },
    /** Server-side error then close for every socket in a channel (e.g. huddle ended). */
    endRoom(channelId: string): void {
      for (const conn of conns) {
        if (conn.channelId !== channelId || conn.closed) continue;
        sendText(conn, { type: "error", code: "room_ended", message: "huddle has ended" });
        closeConn(conn);
      }
    },
  };
}

export type FakeHuddleRelay = ReturnType<typeof createFakeHuddleRelay>;

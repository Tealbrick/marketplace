import { parseDiscordMessageCreate } from "./providers/discord.js";
import type { InboundMessage } from "./providers/types.js";

/**
 * In-process Discord gateway client for the inbound worker (Channels P2 scope 2.2, inbound `socket`). No new
 * dependency: the WebSocket client built into Node ≥ 22 (`globalThis.WebSocket`), behind an injectable socket
 * factory (tests drive a fake socket). Gateway v10, JSON encoding, no compression.
 *
 * - IDENTIFY with intents GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES, plus the privileged MESSAGE_CONTENT only
 *   when the owner turns it on (it must also be enabled for the bot in the Discord developer portal; without it
 *   Discord sends empty content except in DMs and messages that mention the bot).
 * - Heartbeat at the HELLO interval (first beat jittered); a missing ACK is a zombie connection: reconnect and
 *   RESUME, after a backoff delay (at least 1 s, growing with each attempt). RECONNECT (op 7) resumes the same
 *   way; INVALID SESSION (op 9) resumes when Discord says it can, else identifies again after 1–5 s. RESUME goes
 *   only to a `*.discord.gg` resume URL; any other host means the fixed gateway URL and a fresh IDENTIFY.
 * - Close codes 4004 (authentication failed) and 4010–4014 (shard, version, intents) stop the client with a
 *   fixed reason: retrying cannot help. Other closes reconnect with capped exponential backoff and jitter.
 * - One connection per bot token: the client holds a consumer lease (Phase 1 spec §8) and renews it; when the
 *   lease is held by another Marketplace instance it waits (`waiting_lease`) and retries, and when it loses
 *   the lease it disconnects.
 *
 * The token is only ever sent in IDENTIFY / RESUME frames; it is never logged or part of a status.
 */

export const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** A READY `resume_gateway_url` is used only on a Discord gateway host (review M2/F5); else the fixed URL + IDENTIFY. */
const DISCORD_RESUME_URL = /^wss:\/\/([a-z0-9-]+\.)*discord\.gg(:443)?\/?$/u;
/** Every reconnect waits at least this long (no tight loop on repeated RECONNECT or zombie connections). */
export const DISCORD_MIN_RECONNECT_MS = 1000;

export const DISCORD_INTENTS = Object.freeze({
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
});

export function discordIntents(messageContent: boolean): number {
  return DISCORD_INTENTS.GUILDS | DISCORD_INTENTS.GUILD_MESSAGES | DISCORD_INTENTS.DIRECT_MESSAGES | (messageContent ? DISCORD_INTENTS.MESSAGE_CONTENT : 0);
}

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE: Readonly<Record<number, string>> = {
  4004: "authentication_failed",
  4010: "invalid_shard",
  4011: "sharding_required",
  4012: "invalid_api_version",
  4013: "invalid_intents",
  4014: "disallowed_intents",
};
/** Close codes after which the session cannot be resumed. */
const NO_RESUME_CLOSE = new Set([4007, 4009]);

/** The subset of the WHATWG WebSocket the client uses. */
export type GatewaySocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type GatewaySocketFactory = (url: string) => GatewaySocket;

/** The built-in WebSocket of Node ≥ 22. Throws `websocket_unavailable` on a runtime without it. */
export const defaultGatewaySocketFactory: GatewaySocketFactory = (url) => {
  const Constructor = (globalThis as { WebSocket?: new (url: string) => GatewaySocket & { onopen: unknown } }).WebSocket;
  if (typeof Constructor !== "function") throw new Error("websocket_unavailable");
  return new Constructor(url);
};

export type DiscordGatewayStatus = "stopped" | "waiting_lease" | "connecting" | "resuming" | "ready" | "backoff" | "failed";

export type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type DiscordGatewayDeps = {
  token: string;
  messageContent: boolean;
  /** Take or renew the consumer lease for this token; true while this instance holds it. */
  lease: { acquire: () => boolean; release: () => void };
  onMessage: (message: InboundMessage) => void;
  onStatus?: (status: DiscordGatewayStatus, detail?: string) => void;
  socketFactory?: GatewaySocketFactory;
  timers?: Timers;
  random?: () => number;
  leaseRenewMs?: number;
  maxBackoffMs?: number;
};

export type DiscordGateway = ReturnType<typeof createDiscordGateway>;

type GatewayPayload = { op?: unknown; d?: unknown; s?: unknown; t?: unknown };

export function createDiscordGateway(deps: DiscordGatewayDeps) {
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const leaseRenewMs = deps.leaseRenewMs ?? 20_000;
  const maxBackoffMs = deps.maxBackoffMs ?? 60_000;
  const factory = deps.socketFactory ?? defaultGatewaySocketFactory;

  let running = false;
  let socket: GatewaySocket | null = null;
  let status: DiscordGatewayStatus = "stopped";
  let detail: string | undefined;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let seq: number | null = null;
  let botUserId: string | null = null;
  let acked = true;
  let attempts = 0;
  let heartbeatTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let leaseTimer: unknown = null;
  let holdingLease = false;

  const setStatus = (next: DiscordGatewayStatus, why?: string) => {
    status = next;
    detail = why;
    deps.onStatus?.(next, why);
  };

  const clear = (handle: unknown) => {
    if (handle !== null) timers.clearTimeout(handle);
  };

  const send = (payload: Record<string, unknown>) => {
    try {
      socket?.send(JSON.stringify(payload));
    } catch {
      // A send on a closing socket is lost; the close handler reconnects.
    }
  };

  const detach = () => {
    clear(heartbeatTimer);
    heartbeatTimer = null;
    const current = socket;
    socket = null;
    if (current) {
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
    }
    return current;
  };

  const dropSocket = (code: number) => {
    const current = detach();
    try {
      current?.close(code);
    } catch {
      // Already closed.
    }
  };

  const scheduleReconnect = (delayMs?: number) => {
    if (!running || !holdingLease) return;
    clear(reconnectTimer);
    const backoff = Math.max(DISCORD_MIN_RECONNECT_MS, delayMs ?? Math.min(maxBackoffMs, 1000 * 2 ** attempts) * (0.5 + random() * 0.5));
    attempts += 1;
    setStatus("backoff");
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, Math.round(backoff));
  };

  /** Reconnect (zombie connection, op 7) and resume the session, after the backoff delay (attempts count up). */
  const resumeNow = () => {
    dropSocket(4000);
    scheduleReconnect();
  };

  const heartbeat = (intervalMs: number) => {
    if (!acked) {
      // No ACK since the last beat: a zombie connection.
      resumeNow();
      return;
    }
    acked = false;
    send({ op: 1, d: seq });
    heartbeatTimer = timers.setTimeout(() => heartbeat(intervalMs), intervalMs);
  };

  const onPayload = (payload: GatewayPayload) => {
    if (typeof payload.s === "number" && Number.isSafeInteger(payload.s)) seq = payload.s;
    switch (payload.op) {
      case 10: {
        const interval = Number((payload.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval);
        const intervalMs = Number.isFinite(interval) && interval >= 1000 ? interval : 41_250;
        acked = true;
        clear(heartbeatTimer);
        heartbeatTimer = timers.setTimeout(() => heartbeat(intervalMs), Math.round(intervalMs * random()));
        if (sessionId && resumeUrl && seq !== null) {
          send({ op: 6, d: { token: deps.token, session_id: sessionId, seq } });
        } else {
          send({
            op: 2,
            d: {
              token: deps.token,
              intents: discordIntents(deps.messageContent),
              properties: { os: "linux", browser: "tealbrick-marketplace", device: "tealbrick-marketplace" },
            },
          });
        }
        return;
      }
      case 11:
        acked = true;
        return;
      case 1:
        send({ op: 1, d: seq });
        return;
      case 7:
        resumeNow();
        return;
      case 9: {
        const resumable = payload.d === true;
        if (!resumable) {
          sessionId = null;
          seq = null;
          resumeUrl = null;
        }
        dropSocket(4000);
        scheduleReconnect(1000 + Math.round(random() * 4000));
        return;
      }
      case 0:
        onDispatch(payload);
        return;
      default:
        return;
    }
  };

  const onDispatch = (payload: GatewayPayload) => {
    const data = payload.d as Record<string, unknown> | null;
    if (payload.t === "READY" && data) {
      sessionId = typeof data.session_id === "string" ? data.session_id : null;
      resumeUrl = typeof data.resume_gateway_url === "string" && DISCORD_RESUME_URL.test(data.resume_gateway_url.toLowerCase()) ? data.resume_gateway_url.toLowerCase() : null;
      const user = data.user as { id?: unknown } | undefined;
      botUserId = typeof user?.id === "string" ? user.id : botUserId;
      attempts = 0;
      setStatus("ready");
      return;
    }
    if (payload.t === "RESUMED") {
      attempts = 0;
      setStatus("ready");
      return;
    }
    if (payload.t === "MESSAGE_CREATE") {
      const parsed = parseDiscordMessageCreate({ t: payload.t, d: data }, botUserId ? { botUserId } : {});
      if (parsed.kind === "message") {
        try {
          deps.onMessage(parsed.message);
        } catch {
          // The pipeline never breaks the gateway loop.
        }
      }
    }
  };

  const connect = () => {
    if (!running || !holdingLease) return;
    detach();
    const resuming = Boolean(sessionId && resumeUrl && seq !== null);
    const url = resuming ? `${resumeUrl!.replace(/\/$/u, "")}/?v=10&encoding=json` : DISCORD_GATEWAY_URL;
    let next: GatewaySocket;
    try {
      next = factory(url);
    } catch (error) {
      setStatus("failed", error instanceof Error && error.message === "websocket_unavailable" ? "websocket_unavailable" : "connect_failed");
      if (!(error instanceof Error && error.message === "websocket_unavailable")) scheduleReconnect();
      return;
    }
    socket = next;
    setStatus(resuming ? "resuming" : "connecting");
    next.onmessage = (event) => {
      if (socket !== next) return;
      const raw = typeof event.data === "string" ? event.data : event.data instanceof Uint8Array ? Buffer.from(event.data).toString("utf8") : null;
      if (raw === null) return;
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(raw) as GatewayPayload;
      } catch {
        return;
      }
      if (payload && typeof payload === "object") onPayload(payload);
    };
    next.onerror = () => undefined;
    next.onclose = (event) => {
      if (socket !== next) return;
      detach();
      const fatal = FATAL_CLOSE[event.code];
      if (fatal) {
        running = false;
        releaseLease();
        setStatus("failed", fatal);
        return;
      }
      if (NO_RESUME_CLOSE.has(event.code)) {
        sessionId = null;
        seq = null;
        resumeUrl = null;
      }
      scheduleReconnect();
    };
  };

  const releaseLease = () => {
    clear(leaseTimer);
    leaseTimer = null;
    if (holdingLease) deps.lease.release();
    holdingLease = false;
  };

  const leaseTick = () => {
    leaseTimer = null;
    if (!running) return;
    const held = deps.lease.acquire();
    if (held && !holdingLease) {
      holdingLease = true;
      attempts = 0;
      connect();
    } else if (!held && holdingLease) {
      // Another instance took the lease (ours expired): disconnect and wait.
      holdingLease = false;
      clear(reconnectTimer);
      reconnectTimer = null;
      dropSocket(1000);
      sessionId = null;
      seq = null;
      resumeUrl = null;
      setStatus("waiting_lease", "consumer_conflict");
    } else if (!held) {
      setStatus("waiting_lease", "consumer_conflict");
    }
    leaseTimer = timers.setTimeout(leaseTick, leaseRenewMs);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      attempts = 0;
      leaseTick();
    },
    stop(): void {
      running = false;
      clear(reconnectTimer);
      reconnectTimer = null;
      dropSocket(1000);
      releaseLease();
      sessionId = null;
      seq = null;
      resumeUrl = null;
      setStatus("stopped");
    },
    get status(): DiscordGatewayStatus {
      return status;
    },
    get detail(): string | undefined {
      return detail;
    },
    get botUserId(): string | null {
      return botUserId;
    },
    get messageContent(): boolean {
      return deps.messageContent;
    },
  };
}

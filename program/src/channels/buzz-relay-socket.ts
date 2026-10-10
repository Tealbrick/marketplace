import { defaultGatewaySocketFactory, type GatewaySocket, type GatewaySocketFactory, type Timers } from "./discord-gateway.js";
import { buzzSubscriptionFilters, checkBuzzCredential, parseBuzzEvent } from "./providers/buzz.js";
import { authEvent } from "./providers/nostr.js";
import type { InboundMessage } from "./providers/types.js";

/**
 * In-process Buzz relay subscription for the inbound worker (Channels P2 scope 2.2, inbound `socket`). Same
 * shape as the Discord gateway client: Node's built-in WebSocket behind an injectable socket factory, a
 * consumer lease per agent key, capped exponential backoff with jitter.
 *
 * - Connects only to the relay URL inside the credential (the owner's configured value).
 * - NIP-42: on the relay's `["AUTH", challenge]` (at connect and mid-session) it answers a kind-22242 event signed
 *   by the agent key with the `relay`, `challenge` and the owner's NIP-OA `auth` tag (NIP-AA admission).
 * - After `OK true` for that AUTH it sends the REQs (Buzz rules): kind 9 with `#h` = the routed channel ids, and
 *   membership notifications (44100/44101) with `#p` = the agent's own key. `since` is "now" on the first
 *   connection and the last event time minus 30 s after a reconnect (the pipeline de-duplicates).
 * - Each event is verified (id + BIP-340) and parsed before it reaches the pipeline; own events are ignored.
 * - `OK false` for AUTH (e.g. the owner is not a relay member, or the tag expired) stops with a fixed reason when
 *   the tag itself no longer verifies, else backs off and retries.
 *
 * The secret key is used only to sign AUTH events; it is never logged or part of a status.
 */

export type BuzzSocketStatus = "stopped" | "waiting_lease" | "connecting" | "authenticating" | "ready" | "backoff" | "failed";

export type BuzzRelaySocketDeps = {
  credential: string;
  /** Platform channel ids (Buzz channel UUIDs) whose messages are wanted. */
  channelIds: readonly string[];
  lease: { acquire: () => boolean; release: () => void };
  onMessage: (message: InboundMessage) => void;
  onStatus?: (status: BuzzSocketStatus, detail?: string) => void;
  /** Membership changes of the agent key (a channel or DM added or removed). */
  onMembership?: (change: { added: boolean; channelId: string }) => void;
  socketFactory?: GatewaySocketFactory;
  timers?: Timers;
  random?: () => number;
  /** Milliseconds clock (event `created_at`, `since`). */
  now?: () => number;
  leaseRenewMs?: number;
  maxBackoffMs?: number;
};

export type BuzzRelaySocket = ReturnType<typeof createBuzzRelaySocket>;

const SINCE_SKEW_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const realTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createBuzzRelaySocket(deps: BuzzRelaySocketDeps) {
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => Date.now());
  const factory = deps.socketFactory ?? defaultGatewaySocketFactory;
  const leaseRenewMs = deps.leaseRenewMs ?? 20_000;
  const maxBackoffMs = deps.maxBackoffMs ?? 60_000;
  const nowSeconds = () => Math.floor(now() / 1000);

  let channelIds = [...new Set(deps.channelIds.filter((id) => UUID.test(id)))];
  let running = false;
  let socket: GatewaySocket | null = null;
  let status: BuzzSocketStatus = "stopped";
  let detail: string | undefined;
  let authEventId: string | null = null;
  let authenticated = false;
  let lastEventAt: number | null = null;
  let attempts = 0;
  let reconnectTimer: unknown = null;
  let leaseTimer: unknown = null;
  let holdingLease = false;

  const setStatus = (next: BuzzSocketStatus, why?: string) => {
    status = next;
    detail = why;
    deps.onStatus?.(next, why);
  };
  const clear = (handle: unknown) => {
    if (handle !== null) timers.clearTimeout(handle);
  };
  const send = (frame: unknown[]) => {
    try {
      socket?.send(JSON.stringify(frame));
    } catch {
      // A send on a closing socket is lost; the close handler reconnects.
    }
  };
  const parsedCredential = () => checkBuzzCredential(deps.credential, nowSeconds());

  const detach = () => {
    const current = socket;
    socket = null;
    authenticated = false;
    authEventId = null;
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

  const scheduleReconnect = () => {
    if (!running || !holdingLease) return;
    clear(reconnectTimer);
    const backoff = Math.min(maxBackoffMs, 1000 * 2 ** attempts) * (0.5 + random() * 0.5);
    attempts += 1;
    setStatus("backoff", detail);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, Math.round(backoff));
  };

  const fail = (why: string) => {
    running = false;
    clear(reconnectTimer);
    reconnectTimer = null;
    dropSocket(1000);
    releaseLease();
    setStatus("failed", why);
  };

  const subscribe = () => {
    const checked = parsedCredential();
    if (!checked.ok) return;
    const since = lastEventAt === null ? nowSeconds() : Math.max(0, lastEventAt - SINCE_SKEW_SECONDS);
    const filters = buzzSubscriptionFilters({ channelIds, selfPubkey: checked.credential.pubkey, since });
    if (!filters["tb-channels"]) send(["CLOSE", "tb-channels"]);
    for (const [id, filter] of Object.entries(filters)) send(["REQ", id, filter]);
  };

  const answerChallenge = (challenge: string) => {
    const checked = parsedCredential();
    if (!checked.ok) {
      fail(checked.reason === "credential_missing" ? "credential_missing" : "auth_tag_invalid");
      return;
    }
    const { credential } = checked;
    const event = authEvent(credential.secretKey, {
      relayUrl: credential.endpoint.relayUrl,
      challenge,
      authTag: credential.auth.tag,
      nowSeconds: nowSeconds(),
    });
    authEventId = event.id;
    if (!authenticated) setStatus("authenticating");
    send(["AUTH", event]);
  };

  const onFrame = (frame: unknown[]) => {
    const [type] = frame;
    if (type === "AUTH" && typeof frame[1] === "string" && frame[1].length > 0 && frame[1].length <= 512) {
      answerChallenge(frame[1]);
      return;
    }
    if (type === "OK" && frame[1] === authEventId && authEventId !== null) {
      if (frame[2] === true) {
        const first = !authenticated;
        authenticated = true;
        attempts = 0;
        setStatus("ready");
        if (first) subscribe();
      } else {
        // Relay refused the AUTH: a tag that no longer verifies cannot recover by retrying.
        const checked = parsedCredential();
        if (!checked.ok) {
          fail("auth_tag_invalid");
          return;
        }
        detail = "auth_rejected";
        dropSocket(4000);
        scheduleReconnect();
      }
      return;
    }
    if (type === "EVENT" && (frame[1] === "tb-channels" || frame[1] === "tb-membership")) {
      const checked = parsedCredential();
      const self = checked.ok ? checked.credential.pubkey : undefined;
      const raw = frame[2] as { created_at?: unknown; kind?: unknown; tags?: unknown } | undefined;
      if (frame[1] === "tb-membership") {
        if (raw && (raw.kind === 44100 || raw.kind === 44101) && Array.isArray(raw.tags)) {
          const channelId = (raw.tags as unknown[]).find((tag): tag is string[] => Array.isArray(tag) && tag[0] === "h" && typeof tag[1] === "string")?.[1];
          if (channelId && UUID.test(channelId)) {
            try {
              deps.onMembership?.({ added: raw.kind === 44100, channelId });
            } catch {
              // Never breaks the socket loop.
            }
          }
        }
        return;
      }
      const parsed = parseBuzzEvent(frame[2], self ? { selfPubkey: self } : {});
      if (parsed.kind !== "message") return;
      if (!channelIds.includes(parsed.message.channelId)) return;
      lastEventAt = Math.max(lastEventAt ?? 0, Math.min(parsed.createdAt, nowSeconds()));
      try {
        deps.onMessage(parsed.message);
      } catch {
        // The pipeline never breaks the socket loop.
      }
      return;
    }
    if (type === "CLOSED" && typeof frame[2] === "string" && frame[2].startsWith("auth-required")) {
      // The relay asks for AUTH first; the challenge arrives as its own frame and re-subscribes after OK.
      authenticated = false;
    }
  };

  const connect = () => {
    if (!running || !holdingLease) return;
    detach();
    const checked = parsedCredential();
    if (!checked.ok) {
      fail(checked.reason === "credential_missing" ? "credential_missing" : "auth_tag_invalid");
      return;
    }
    let next: GatewaySocket;
    try {
      next = factory(checked.credential.endpoint.relayUrl);
    } catch (error) {
      const unavailable = error instanceof Error && error.message === "websocket_unavailable";
      setStatus("failed", unavailable ? "websocket_unavailable" : "connect_failed");
      if (!unavailable) scheduleReconnect();
      return;
    }
    socket = next;
    setStatus("connecting");
    next.onmessage = (event) => {
      if (socket !== next) return;
      const raw = typeof event.data === "string" ? event.data : event.data instanceof Uint8Array ? Buffer.from(event.data).toString("utf8") : null;
      if (raw === null || raw.length > 1_000_000) return;
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (Array.isArray(frame)) onFrame(frame);
    };
    next.onerror = () => undefined;
    next.onclose = () => {
      if (socket !== next) return;
      detach();
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
      holdingLease = false;
      clear(reconnectTimer);
      reconnectTimer = null;
      dropSocket(1000);
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
      setStatus("stopped");
    },
    /** Replaces the channel set; re-sends the channel REQ on a live connection. */
    setChannels(next: readonly string[]): void {
      const ids = [...new Set(next.filter((id) => UUID.test(id)))].sort();
      if (ids.join(",") === [...channelIds].sort().join(",")) return;
      channelIds = ids;
      if (authenticated) subscribe();
    },
    get channelIds(): readonly string[] {
      return channelIds;
    },
    get status(): BuzzSocketStatus {
      return status;
    },
    get detail(): string | undefined {
      return detail;
    },
  };
}

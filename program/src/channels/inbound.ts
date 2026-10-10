import type { ChannelProviderId, InboundMessage } from "./providers/types.js";
import type { InboundBridgeStatus, InboundEventRecord, InboundRouteRecord, InboundStore } from "./inbound-store.js";
import type { ChannelRecord, ChannelStore } from "./store.js";

/**
 * The inbound pipeline (Channels P2 scope 2.2, 2.2a, 13 item 4). Every receiver (Slack Events API, Telegram
 * webhook, Discord gateway, Teams messaging endpoint) hands its normalized `InboundMessage` to `ingest`:
 *
 *   own bot message? → ignore (nothing stored)
 *   route: the Marketplace channel for (platform, channel id[, thread]) with an ENABLED owner route?
 *          no → ignore (nothing stored: unrouted channels are never recorded)
 *   dedupe: insert keyed by (platform, channel id, message id); a duplicate stops here
 *   loop breaker: ≤ 4 agent-bound events per thread and ≤ 8 per peer (sender) in 15 minutes, plus a short
 *          per-sender token bucket → `loop-limited` / `rate-limited` (kept for the owner, not delivered)
 *   consent: the routed agent still holds an active consent for the channel → else `consent-inactive`
 *   deliver: `InboundSink.deliver(event, route)`; the default `NullSink` only records (`pending-bridge`);
 *          the Buzz bridge sink plugs in here later.
 *
 * All received text is untrusted data, never instructions: it is stored and shown as data, and every view of it
 * carries the `untrusted` framing. The synchronous part (dedupe, limits, routing) runs before the receiver
 * answers; delivery runs after it, so a slow sink never delays the provider's acknowledgement.
 */

export type InboundSinkResult = { status: Extract<InboundBridgeStatus, "pending-bridge" | "bridged" | "bridge-failed">; detail?: string };

/** Where routed events go. The Buzz bridge (private channel per route, provenance header) implements this later. */
export interface InboundSink {
  readonly id: string;
  deliver(event: InboundEventRecord, route: InboundRouteRecord): Promise<InboundSinkResult>;
}

/** Records only: the event waits as `pending-bridge` (agents without Buzz read it with `marketplace.channels.inbound`). */
export const NULL_INBOUND_SINK: InboundSink = Object.freeze({
  id: "null",
  async deliver(): Promise<InboundSinkResult> {
    return { status: "pending-bridge" };
  },
});

/** The kit's loop-breaker numbers (P2 scope 2.2 item 3) and the per-sender burst bucket. */
export const INBOUND_LIMITS = Object.freeze({
  windowMs: 15 * 60_000,
  perThread: 4,
  perPeer: 8,
  senderBurst: 5,
  senderRefillPerSecond: 1 / 12,
});

export type InboundLimits = { windowMs: number; perThread: number; perPeer: number; senderBurst: number; senderRefillPerSecond: number };

export type IngestOutcome =
  | { outcome: "own" | "unrouted" | "duplicate"; eventId?: string }
  | { outcome: "loop-limited" | "rate-limited" | "consent-inactive" | "delivered"; eventId: string };

export type InboundPipelineDeps = {
  store: InboundStore;
  channels: ChannelStore;
  organizationId: string;
  now: () => Date;
  sink?: InboundSink;
  /** The bot's own user id on this platform (from the verified connection), or null when unknown. */
  botIdFor: (platform: ChannelProviderId) => string | null;
  /** True when the agent holds an active class consent (read or outward) for this channel. */
  agentConsented: (agentId: string, channel: ChannelRecord) => boolean;
  /** Metadata only: never text, never the sender display name. */
  audit: (eventType: string, metadata: Record<string, unknown>) => void;
  limits?: InboundLimits;
  /** Milliseconds clock for the sender buckets. */
  clock?: () => number;
};

/** The provider-native reply target of an event: the thread root where threads are roots (Slack, Teams), else the message. */
export function replyTargetFor(event: Pick<InboundEventRecord, "platform" | "threadId" | "messageId">): string {
  return event.platform === "slack" || event.platform === "teams" ? event.threadId ?? event.messageId : event.messageId;
}

/** Providers whose destination `parentId` is a thread or topic inside the chat (else it is a guild or team id). */
const THREAD_SCOPED: ReadonlySet<string> = new Set(["telegram", "slack"]);

/**
 * The Marketplace channel a message belongs to: same provider and platform channel id, status active. In Telegram
 * and Slack a topic or thread destination (parentId = thread id) wins over the plain chat destination.
 */
export function channelForMessage(channels: readonly ChannelRecord[], message: Pick<InboundMessage, "platform" | "channelId" | "threadId">): ChannelRecord | null {
  const candidates = channels.filter(
    (channel) => channel.provider === message.platform && channel.destination.externalId === message.channelId && channel.status === "active",
  );
  if (!THREAD_SCOPED.has(message.platform)) return candidates[0] ?? null;
  if (message.threadId) {
    const scoped = candidates.find((channel) => channel.destination.parentId === message.threadId);
    if (scoped) return scoped;
  }
  return candidates.find((channel) => !channel.destination.parentId) ?? null;
}

export type InboundPipeline = ReturnType<typeof createInboundPipeline>;

export function createInboundPipeline(deps: InboundPipelineDeps) {
  const org = deps.organizationId;
  const limits = deps.limits ?? INBOUND_LIMITS;
  const clock = deps.clock ?? (() => Date.now());
  let sink: InboundSink = deps.sink ?? NULL_INBOUND_SINK;
  const buckets = new Map<string, { tokens: number; at: number }>();
  const inFlight = new Set<Promise<void>>();

  const takeSender = (key: string): boolean => {
    const now = clock();
    if (buckets.size > 10_000) {
      for (const [entry, bucket] of buckets) if (now - bucket.at > limits.windowMs) buckets.delete(entry);
      if (buckets.size > 10_000) buckets.clear();
    }
    const bucket = buckets.get(key) ?? { tokens: limits.senderBurst, at: now };
    bucket.tokens = Math.min(limits.senderBurst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * limits.senderRefillPerSecond);
    bucket.at = now;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const audit = (event: InboundEventRecord, outcome: string, extra: Record<string, unknown> = {}) => {
    try {
      deps.audit("marketplace.channels.inbound.received", {
        eventId: event.id,
        platform: event.platform,
        channelId: event.routeChannelId,
        outcome,
        ...extra,
      });
    } catch {
      // Audit is best effort here; the event row is already stored.
    }
  };

  const deliver = (event: InboundEventRecord, route: InboundRouteRecord) => {
    const run = (async () => {
      let result: InboundSinkResult;
      try {
        result = await sink.deliver(event, route);
      } catch {
        result = { status: "bridge-failed", detail: "sink_error" };
      }
      deps.store.setEventStatus(org, event.id, { status: result.status, detail: result.detail ?? null, now: deps.now() });
    })();
    inFlight.add(run);
    void run.finally(() => inFlight.delete(run));
  };

  const ingest = (message: InboundMessage): IngestOutcome => {
    const botId = deps.botIdFor(message.platform);
    if (botId && message.senderUserId === botId) return { outcome: "own" };
    const channel = channelForMessage(deps.channels.listChannels(org), message);
    const route = channel ? deps.store.getRoute(org, channel.id) : null;
    if (!channel || !route || !route.enabled) return { outcome: "unrouted" };

    const now = deps.now();
    const inserted = deps.store.insertEvent({ workspaceSlug: org, message, routeChannelId: channel.id, now });
    if (!inserted.created) return { outcome: "duplicate", eventId: inserted.event.id };
    const event = inserted.event;
    const since = new Date(now.getTime() - limits.windowMs);
    const thread = deps.store.countAgentBoundInThread({
      workspaceSlug: org,
      platform: message.platform,
      channelId: message.channelId,
      threadId: message.threadId ?? null,
      since,
      excludeId: event.id,
    });
    const peer = deps.store.countAgentBoundFromSender({ workspaceSlug: org, platform: message.platform, senderUserId: message.senderUserId, since, excludeId: event.id });
    if (thread >= limits.perThread || peer >= limits.perPeer) {
      const detail = thread >= limits.perThread ? "thread_limit" : "peer_limit";
      deps.store.setEventStatus(org, event.id, { status: "loop-limited", detail, now });
      audit(event, "loop-limited", { detail });
      return { outcome: "loop-limited", eventId: event.id };
    }
    if (!takeSender(`${message.platform}:${message.senderUserId}`)) {
      deps.store.setEventStatus(org, event.id, { status: "rate-limited", detail: "sender_rate", now });
      audit(event, "rate-limited");
      return { outcome: "rate-limited", eventId: event.id };
    }
    if (!deps.agentConsented(route.agentId, channel)) {
      deps.store.setEventStatus(org, event.id, { status: "consent-inactive", now });
      audit(event, "consent-inactive", { agentId: route.agentId });
      return { outcome: "consent-inactive", eventId: event.id };
    }
    deps.store.setEventStatus(org, event.id, { status: "queued", routedTo: route.agentId, now });
    audit(event, "delivered", { routedTo: route.agentId, sink: sink.id });
    deliver({ ...event, routedTo: route.agentId }, route);
    return { outcome: "delivered", eventId: event.id };
  };

  return {
    ingest,
    /** Resolves when every delivery started so far has finished (tests, shutdown). */
    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    /** Replaces the sink (the Buzz bridge plugs in here). */
    setSink(next: InboundSink): void {
      sink = next;
    },
    get sinkId(): string {
      return sink.id;
    },
  };
}

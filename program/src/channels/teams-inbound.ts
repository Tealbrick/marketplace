import type { FastifyInstance, FastifyRequest } from "fastify";

import { asRecord } from "./providers/common.js";
import { isAllowedServiceUrl, type BotFrameworkVerifier } from "./providers/teams-auth.js";
import { parseTeamsActivity } from "./providers/teams.js";
import type { TeamsConversationStore } from "./teams-store.js";

/**
 * The Teams messaging endpoint (the Azure Bot registration points here). It is a public route at the
 * Marketplace level: no operator session, no Portal grant, not a manifest operation (agents never call it).
 * Every request is authenticated by its Bot Framework JWT (RS256 against the Bot Framework OpenID keys,
 * issuer, audience = app id, validity, `serviceUrl` claim = activity `serviceUrl`, `msteams` endorsement).
 *
 * What it does: installationUpdate / conversationUpdate store or remove the conversation reference that
 * proactive sends need. Message activities are parsed into the normalized inbound shape and nothing is
 * stored yet (the Buzz bridge comes later). It answers 200 quickly; activity text is untrusted data.
 */
export const TEAMS_MESSAGES_PATH = "/api/marketplace/channels/teams/messages";

const MAX_BODY_BYTES = 128 * 1024;
/** A Bot Framework bearer: three base64url JWT segments, bounded length. Checked before the body is parsed. */
const BEARER_JWT = /^Bearer [A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,4096}$/u;

/**
 * Per-source request budget for the public route. Bot Connector traffic for one tenant arrives from a few
 * Microsoft egress addresses (and, behind the hosting proxy, the source is the proxy-appended address), so the
 * default allows normal message volume while it caps floods: a burst of 60, then 2 per second (120 per minute).
 */
export const TEAMS_INBOUND_RATE = Object.freeze({ capacity: 60, refillPerSecond: 2 });

export type TeamsInboundDeps = {
  app: FastifyInstance;
  store: TeamsConversationStore;
  organizationId: string;
  /** The Teams app id and tenant id from the configured credential, or null when Teams is not configured. */
  identity: () => { appId: string; tenantId: string } | null;
  verifier: BotFrameworkVerifier;
  ready: Promise<void>;
  now: () => Date;
  audit: (eventType: string, metadata: Record<string, unknown>) => void;
  /** Request budget per source address (tests use a small one). */
  rate?: { capacity: number; refillPerSecond: number };
  /** Milliseconds clock for the request budget. */
  clock?: () => number;
};

/** The address the one trusted proxy appended (last X-Forwarded-For entry), else the socket address. */
function sourceOf(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] : forwarded;
  const last = value?.split(",").pop()?.trim();
  return last && last.length <= 64 ? last : request.ip;
}

export function registerTeamsInboundRoute(deps: TeamsInboundDeps): void {
  const rate = deps.rate ?? TEAMS_INBOUND_RATE;
  const clock = deps.clock ?? (() => Date.now());
  const buckets = new Map<string, { tokens: number; at: number }>();
  const take = (source: string): boolean => {
    const now = clock();
    if (buckets.size > 10_000) {
      for (const [key, bucket] of buckets) if (now - bucket.at > 10 * 60_000) buckets.delete(key);
      if (buckets.size > 10_000) buckets.clear();
    }
    const bucket = buckets.get(source) ?? { tokens: rate.capacity, at: now };
    bucket.tokens = Math.min(rate.capacity, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate.refillPerSecond);
    bucket.at = now;
    buckets.set(source, bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  deps.app.post(
    TEAMS_MESSAGES_PATH,
    {
      bodyLimit: MAX_BODY_BYTES,
      // Cheap rejects before the body is read or parsed, and without waiting for Marketplace start-up.
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!take(sourceOf(request))) {
          await reply.code(429).header("retry-after", "30").send({ error: "teams_rate_limited" });
          return reply;
        }
        const header = request.headers.authorization;
        if (typeof header !== "string" || !BEARER_JWT.test(header)) {
          await reply.code(401).send({ error: "teams_auth_invalid", reason: "token_missing" });
          return reply;
        }
        return undefined;
      },
    },
    async (request, reply) => {
      await deps.ready;
      const identity = deps.identity();
      if (!identity) return reply.code(503).send({ error: "channels_teams_not_configured" });
      const activity = asRecord(request.body);
      if (!activity) return reply.code(400).send({ error: "activity_invalid" });
      const header = request.headers.authorization;
      const verified = await deps.verifier.verify({
        authorization: Array.isArray(header) ? header[0] : header,
        appId: identity.appId,
        activity: { serviceUrl: activity.serviceUrl, channelId: activity.channelId },
      });
      if (!verified.ok) {
        // The reason is a fixed code; the token is never echoed or logged.
        return reply.code(verified.status).send({ error: verified.status === 503 ? "teams_auth_unavailable" : "teams_auth_invalid", reason: verified.reason });
      }
      if (!isAllowedServiceUrl(activity.serviceUrl)) return reply.code(403).send({ error: "teams_service_url_not_allowed" });

      const event = parseTeamsActivity(activity, identity);
      const now = deps.now();
      if (event.kind === "install") {
        deps.store.upsert(deps.organizationId, event.ref, now);
        deps.audit("marketplace.channels.teams.installed", {
          conversationType: event.ref.type,
          membership: event.ref.membership,
          ...(event.ref.teamId ? { teamId: event.ref.teamId } : {}),
          conversationId: event.ref.conversationId,
        });
      } else if (event.kind === "uninstall") {
        const removed = deps.store.markRemoved(deps.organizationId, event, now);
        if (removed > 0) {
          deps.audit("marketplace.channels.teams.removed", {
            removed,
            ...(event.teamId ? { teamId: event.teamId } : {}),
            ...(event.conversationId ? { conversationId: event.conversationId } : {}),
          });
        }
      }
      // A message is parsed (normalized, untrusted) but not stored or forwarded in this version.
      return reply.code(200).send({});
    },
  );
}

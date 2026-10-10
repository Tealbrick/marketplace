import type { FastifyInstance } from "fastify";

import { createSourceBudget, headerValue, matchesDigest, sourceOf, type SourceRate } from "./inbound-http.js";
import type { InboundStore } from "./inbound-store.js";
import { SLACK_SIGNATURE_MAX_SKEW_SECONDS, parseSlackEvent, verifySlackSignature } from "./providers/slack.js";
import { parseTelegramUpdate, telegramChatsFromUpdate } from "./providers/telegram.js";
import type { ChannelProviderId, InboundMessage } from "./providers/types.js";

/**
 * Public inbound receivers at the Marketplace level (Channels P2 scope 2.2), with the protections of the Teams
 * messaging endpoint: exact paths, a per-source budget and a cheap header check in `onRequest` (before the body
 * is read or parsed, and without waiting for start-up), a small body limit, then full verification. They are
 * not manifest operations (agents never call them) and need no operator session or Portal grant: each request
 * is authenticated by the provider's own proof. Received text is untrusted data.
 *
 * - Slack Events API: `X-Slack-Signature` v0 over the raw body (±5 minutes); `url_verification` answers the
 *   challenge; retries (`X-Slack-Retry-Num`) are de-duplicated by the pipeline (same channel + message ts).
 * - Telegram webhook: a random path segment and `X-Telegram-Bot-Api-Secret-Token`, both compared with the
 *   SHA-256 digests Marketplace stored when it called setWebhook. Every update feeds the chats-seen table
 *   (discovery while a webhook is set); messages go to the pipeline (edits are not delivered again).
 */
export const SLACK_EVENTS_PATH = "/api/marketplace/channels/slack/events";
export const TELEGRAM_WEBHOOK_PREFIX = "/api/marketplace/channels/telegram/webhook/";
/** The random path segment: 32 random bytes, base64url (43 characters). */
export const TELEGRAM_WEBHOOK_SEGMENT = /^[A-Za-z0-9_-]{43}$/u;
const TELEGRAM_SECRET_HEADER_SHAPE = /^[A-Za-z0-9_-]{1,256}$/u;
const SLACK_SIGNATURE_SHAPE = /^v0=[0-9a-f]{64}$/u;
const SLACK_TIMESTAMP_SHAPE = /^[0-9]{1,12}$/u;

export function isInboundPublicPath(pathname: string): boolean {
  return pathname === SLACK_EVENTS_PATH || (pathname.startsWith(TELEGRAM_WEBHOOK_PREFIX) && TELEGRAM_WEBHOOK_SEGMENT.test(pathname.slice(TELEGRAM_WEBHOOK_PREFIX.length)));
}

const MAX_BODY_BYTES = 128 * 1024;

/** Slack and Telegram send from a few provider addresses: a burst of 120, then 4 per second, per source. */
export const INBOUND_ROUTE_RATE: SourceRate = Object.freeze({ capacity: 120, refillPerSecond: 4 });

export type InboundRoutesDeps = {
  app: FastifyInstance;
  organizationId: string;
  /** False in inert mode (no channel credential): the routes refuse after the cheap checks and do no work. */
  configured: boolean;
  ready: Promise<void>;
  now: () => Date;
  inbound: InboundStore;
  slackSigningSecret: () => string | null;
  botIdFor: (provider: ChannelProviderId) => string | null;
  ingest: (message: InboundMessage) => void;
  rate?: SourceRate;
  clock?: () => number;
};

export function registerInboundRoutes(deps: InboundRoutesDeps): void {
  const budget = createSourceBudget(deps.rate ?? INBOUND_ROUTE_RATE, deps.clock);
  const nowMs = () => (deps.clock ?? (() => deps.now().getTime()))();
  const hand = (message: InboundMessage) => {
    try {
      deps.ingest(message);
    } catch {
      // The pipeline never blocks the acknowledgement; the provider would only retry the same event.
    }
  };

  // Raw body for the Slack signature, in its own encapsulated scope (only this route reads bytes).
  deps.app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_BODY_BYTES }, (_request, body, done) => done(null, body));
    scope.post(
      SLACK_EVENTS_PATH,
      {
        bodyLimit: MAX_BODY_BYTES,
        onRequest: async (request, reply) => {
          reply.header("cache-control", "no-store");
          if (!budget.take(sourceOf(request))) {
            await reply.code(429).header("retry-after", "30").send({ error: "slack_rate_limited" });
            return reply;
          }
          const signature = headerValue(request, "x-slack-signature");
          const timestamp = headerValue(request, "x-slack-request-timestamp");
          if (!signature || !timestamp || !SLACK_SIGNATURE_SHAPE.test(signature) || !SLACK_TIMESTAMP_SHAPE.test(timestamp)) {
            await reply.code(401).send({ error: "slack_signature_invalid", reason: "header_missing" });
            return reply;
          }
          if (Math.abs(Math.floor(nowMs() / 1000) - Number(timestamp)) > SLACK_SIGNATURE_MAX_SKEW_SECONDS) {
            await reply.code(401).send({ error: "slack_signature_invalid", reason: "stale" });
            return reply;
          }
          return undefined;
        },
      },
      async (request, reply) => {
        if (!deps.configured) return reply.code(503).send({ error: "channels_slack_inbound_not_configured" });
        await deps.ready;
        const secret = deps.slackSigningSecret();
        if (!secret) return reply.code(503).send({ error: "channels_slack_inbound_not_configured" });
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const verified = verifySlackSignature({
          signingSecret: secret,
          timestamp: headerValue(request, "x-slack-request-timestamp"),
          signature: headerValue(request, "x-slack-signature"),
          rawBody: raw,
          nowMs: nowMs(),
        });
        // The reason is a fixed code; the signature and the secret are never echoed or logged.
        if (!verified.ok) return reply.code(401).send({ error: "slack_signature_invalid", reason: verified.reason });
        const botUserId = deps.botIdFor("slack");
        const parsed = parseSlackEvent(raw.toString("utf8"), botUserId ? { botUserId } : {});
        if (parsed.kind === "url_verification") return reply.code(200).send({ challenge: parsed.challenge });
        if (parsed.kind === "message") hand(parsed.message);
        return reply.code(200).send({});
      },
    );
  });

  deps.app.post(
    `${TELEGRAM_WEBHOOK_PREFIX}:segment`,
    {
      bodyLimit: MAX_BODY_BYTES,
      onRequest: async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!budget.take(sourceOf(request))) {
          await reply.code(429).header("retry-after", "30").send({ error: "telegram_rate_limited" });
          return reply;
        }
        const pathname = request.url.split("?", 1)[0] ?? "";
        if (!TELEGRAM_WEBHOOK_SEGMENT.test(pathname.slice(TELEGRAM_WEBHOOK_PREFIX.length))) {
          await reply.code(404).send({ error: "not_found" });
          return reply;
        }
        const header = headerValue(request, "x-telegram-bot-api-secret-token");
        if (!header || !TELEGRAM_SECRET_HEADER_SHAPE.test(header)) {
          await reply.code(401).send({ error: "telegram_secret_invalid", reason: "header_missing" });
          return reply;
        }
        return undefined;
      },
    },
    async (request, reply) => {
      if (!deps.configured) return reply.code(404).send({ error: "not_found" });
      await deps.ready;
      const webhook = deps.inbound.activeWebhook(deps.organizationId, "telegram");
      const { segment } = request.params as { segment: string };
      // An unknown or old path looks like no route at all.
      if (!webhook || !matchesDigest(segment, webhook.pathSha256)) return reply.code(404).send({ error: "not_found" });
      if (!matchesDigest(headerValue(request, "x-telegram-bot-api-secret-token") ?? "", webhook.headerSha256)) {
        return reply.code(401).send({ error: "telegram_secret_invalid", reason: "mismatch" });
      }
      const update = request.body;
      const now = deps.now();
      const seen = telegramChatsFromUpdate(update);
      if (seen.leftChatId) deps.inbound.markTelegramChatLeft(deps.organizationId, seen.leftChatId, now);
      if (seen.destinations.length > 0) deps.inbound.recordTelegramDestinations(deps.organizationId, seen.destinations, now);
      const botId = deps.botIdFor("telegram");
      const parsed = parseTelegramUpdate(update, botId ? { botId } : {});
      if (parsed.kind === "message" && !parsed.edited) hand(parsed.message);
      return reply.code(200).send({});
    },
  );
}

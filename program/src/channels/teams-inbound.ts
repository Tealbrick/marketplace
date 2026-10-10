import type { FastifyInstance } from "fastify";

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

const MAX_BODY_BYTES = 256 * 1024;

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
};

export function registerTeamsInboundRoute(deps: TeamsInboundDeps): void {
  deps.app.post(TEAMS_MESSAGES_PATH, { bodyLimit: MAX_BODY_BYTES }, async (request, reply) => {
    reply.header("cache-control", "no-store");
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
  });
}

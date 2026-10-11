import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  DEFAULT_AGENT_CONNECTOR_DAILY_CAP,
  DEFAULT_AGENT_DAILY_CAP,
  MAX_AGENT_DAILY_CAP,
  HOLD_FAMILIES,
  SENSITIVE_ACTION_FAMILIES,
  getHoldFamilies,
  isHoldFamilyId,
  utcDay,
} from "./agent-approval-mode.js";
import type { AgentApprovalSetting } from "./agent-mode-store.js";
import { createOwnerWriterGate } from "./channels/owner-key-routes.js";
import type { OwnerPinSource } from "./channels/owner-pin.js";
import type { GovernanceMode } from "./governance.js";
import type { MarketplacePrincipal } from "./operator-auth.js";
import type { SqliteMarketplaceStore } from "./store.js";

/**
 * Owner routes for agent approval modes (owner audience in tealbrick.app.json):
 *
 * - `GET   /api/marketplace/agents` (`marketplace.agents.list`): every known agent with its mode, pause, today's
 *   counts against its limits (UTC day), the global pause and the sensitive families. Any owner operator session.
 * - `PATCH /api/marketplace/agents/{agentId}` (`marketplace.agents.update`) `{mode?, dailyCap?, connectorDailyCap?}`
 * - `POST  /api/marketplace/agents/{agentId}/pause|resume` (`marketplace.agents.pause|resume`)
 * - `POST  /api/marketplace/agents/pause-all|resume-all` (`marketplace.agents.pause-all|resume-all`)
 * - `GET   /api/marketplace/agents/receipts` (`marketplace.agent-receipts.list`): Assistant-mode receipts.
 * - `PATCH /api/marketplace/agents/hold-families/{familyId}` (`marketplace.hold-families.update`) `{on}`: which hold
 *   families keep an Assistant agent's outward action waiting in this workspace (absent = default ON; destructive and
 *   money are locked ON).
 *
 * TEMPORARY FALLBACK until Portal ships the agentPolicy claim (@tealbrick/contract/approval-mode): with a claim
 * present the local setting can only tighten it. Remove these local settings in the next release; add nothing.
 *
 * Writes need the owner's own Portal launch session with its CSRF token and the pinned owner (createOwnerWriterGate).
 * Refused: agent grants (owner operations), runtime leases, the service bearer, the operator access-token session.
 * Every change is audited. Agents have no route that writes, edits or deletes settings or receipts.
 */
const AGENT_ID = /^[A-Za-z0-9._:@-]{1,128}$/u;
const Cap = z.number().int().min(1).max(MAX_AGENT_DAILY_CAP).nullable();
const UpdateBody = z.strictObject({
  mode: z.enum(["assistant", "system"]).optional(),
  dailyCap: Cap.optional(),
  connectorDailyCap: Cap.optional(),
  // Bound by the server from the session, never trusted from the client.
  workspaceSlug: z.string().optional(),
  actorId: z.string().optional(),
});
const EmptyBody = z.strictObject({ workspaceSlug: z.string().optional(), actorId: z.string().optional() }).optional();

export type AgentModeRouteDeps = {
  app: FastifyInstance;
  store: SqliteMarketplaceStore;
  organizationId: string;
  governanceMode: GovernanceMode;
  pinSource: OwnerPinSource;
  requireOperator: (request: FastifyRequest, reply: FastifyReply) => MarketplacePrincipal | null;
  ownerLaunchSession: (request: FastifyRequest) => MarketplacePrincipal | null;
  clock: () => Date;
};

export function registerAgentModeRoutes(deps: AgentModeRouteDeps): void {
  const { app, store, organizationId: org } = deps;
  const modes = store.agentModes;
  const ownerWriter = createOwnerWriterGate(deps);
  const refuse = (reply: FastifyReply, status: number, error: string) => {
    reply.code(status);
    return { ok: false, error };
  };
  const reader = (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    const principal = deps.requireOperator(request, reply);
    if (!principal) return null;
    if (principal.organizationId !== org) {
      reply.code(403);
      return null;
    }
    return principal;
  };
  const writer = async (request: FastifyRequest, reply: FastifyReply) => {
    const gate = await ownerWriter(request, reply);
    if (!gate.ok) return { refusal: { ok: false, error: gate.error } };
    return { actor: gate.actor };
  };
  const agentParam = (request: FastifyRequest) => {
    const { agentId } = request.params as { agentId: string };
    // Path words of the collection routes are never agent ids.
    return AGENT_ID.test(agentId) && !["receipts", "pause-all", "resume-all", "hold-families"].includes(agentId) ? agentId : null;
  };

  const agentView = (setting: AgentApprovalSetting, day: string) => {
    const used = modes.usedToday(org, setting.agentId, day);
    return {
      agentId: setting.agentId,
      mode: setting.mode,
      paused: setting.paused,
      dailyCap: setting.dailyCap,
      connectorDailyCap: setting.connectorDailyCap,
      today: { day, executed: used.total, byConnector: used.byConnector },
      updatedAt: setting.updatedAt,
      updatedBy: setting.updatedBy,
    };
  };
  const knownAgents = () => {
    const ids = new Set<string>();
    for (const grant of store.listAgentConnectorGrants({ workspaceSlug: org, state: "active", limit: 500 })) ids.add(grant.agentId);
    for (const consent of store.listMarketplaceAgentConsents({ productTenantId: org, state: "active" })) ids.add(consent.agentId);
    for (const setting of modes.listSettings(org)) ids.add(setting.agentId);
    return [...ids].sort();
  };
  const overview = () => {
    const day = utcDay(deps.clock());
    return {
      ok: true,
      workspaceSlug: org,
      governanceMode: deps.governanceMode,
      pausedAll: modes.isPausedAll(org),
      day,
      limitsReset: "00:00 UTC",
      defaults: { dailyCap: DEFAULT_AGENT_DAILY_CAP, connectorDailyCap: DEFAULT_AGENT_CONNECTOR_DAILY_CAP },
      sensitiveFamilies: SENSITIVE_ACTION_FAMILIES,
      holdFamilies: getHoldFamilies(store, org),
      agents: knownAgents().map((agentId) => agentView(modes.getSetting(org, agentId), day)),
    };
  };

  app.get("/api/marketplace/agents", async (request, reply) => {
    if (!reader(request, reply)) return { ok: false, error: "marketplace_operator_required" };
    return overview();
  });

  app.get("/api/marketplace/agents/receipts", async (request, reply) => {
    if (!reader(request, reply)) return { ok: false, error: "marketplace_operator_required" };
    const query = z
      .object({ agentId: z.string().regex(AGENT_ID).optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
      .safeParse(request.query);
    if (!query.success) return refuse(reply, 400, "validation_failed");
    return { ok: true, receipts: modes.listReceipts({ workspaceSlug: org, agentId: query.data.agentId, limit: query.data.limit }) };
  });

  app.patch("/api/marketplace/agents/:agentId", { bodyLimit: 2_048 }, async (request, reply) => {
    const gate = await writer(request, reply);
    if ("refusal" in gate) return gate.refusal;
    const agentId = agentParam(request);
    const body = UpdateBody.safeParse(request.body ?? {});
    if (!agentId || !body.success) return refuse(reply, 400, "validation_failed");
    const now = deps.clock();
    const { previous, next } = modes.updateSetting({
      workspaceSlug: org,
      agentId,
      ...(body.data.mode ? { mode: body.data.mode } : {}),
      ...(body.data.dailyCap !== undefined ? { dailyCap: body.data.dailyCap } : {}),
      ...(body.data.connectorDailyCap !== undefined ? { connectorDailyCap: body.data.connectorDailyCap } : {}),
      actor: gate.actor,
      now,
    });
    store.recordAudit({
      workspaceSlug: org,
      eventType: "marketplace.agent.mode.changed",
      actorId: gate.actor,
      metadata: {
        agentId,
        from: { mode: previous.mode, dailyCap: previous.dailyCap, connectorDailyCap: previous.connectorDailyCap },
        to: { mode: next.mode, dailyCap: next.dailyCap, connectorDailyCap: next.connectorDailyCap },
        at: now.toISOString(),
      },
    });
    return { ok: true, agent: agentView(next, utcDay(now)) };
  });

  app.patch("/api/marketplace/agents/hold-families/:familyId", { bodyLimit: 1_024 }, async (request, reply) => {
    const gate = await writer(request, reply);
    if ("refusal" in gate) return gate.refusal;
    const { familyId } = request.params as { familyId: string };
    const body = z.strictObject({ on: z.boolean(), workspaceSlug: z.string().optional(), actorId: z.string().optional() }).safeParse(request.body ?? {});
    if (!isHoldFamilyId(familyId) || !body.success) return refuse(reply, 400, "validation_failed");
    // Destructive and money actions always wait in Assistant mode.
    if (HOLD_FAMILIES.find((family) => family.id === familyId)?.locked) return refuse(reply, 400, "hold_family_locked");
    const now = deps.clock();
    const result = modes.setFamily({ workspaceSlug: org, familyId, enabled: body.data.on, actor: gate.actor, now });
    store.recordAudit({
      workspaceSlug: org,
      eventType: "marketplace.agent.hold_family.changed",
      actorId: gate.actor,
      metadata: { familyId, from: result.previous, to: result.enabled, at: now.toISOString() },
    });
    return overview();
  });

  for (const [suffix, paused] of [["pause", true], ["resume", false]] as const) {
    app.post(`/api/marketplace/agents/:agentId/${suffix}`, { bodyLimit: 1_024 }, async (request, reply) => {
      const gate = await writer(request, reply);
      if ("refusal" in gate) return gate.refusal;
      const agentId = agentParam(request);
      if (!agentId || !EmptyBody.safeParse(request.body ?? undefined).success) return refuse(reply, 400, "validation_failed");
      const now = deps.clock();
      const { previous, next } = modes.updateSetting({ workspaceSlug: org, agentId, paused, actor: gate.actor, now });
      store.recordAudit({
        workspaceSlug: org,
        eventType: paused ? "marketplace.agent.paused" : "marketplace.agent.resumed",
        actorId: gate.actor,
        metadata: { agentId, wasPaused: previous.paused, paused: next.paused, at: now.toISOString() },
      });
      return { ok: true, agent: agentView(next, utcDay(now)) };
    });
    app.post(`/api/marketplace/agents/${suffix}-all`, { bodyLimit: 1_024 }, async (request, reply) => {
      const gate = await writer(request, reply);
      if ("refusal" in gate) return gate.refusal;
      if (!EmptyBody.safeParse(request.body ?? undefined).success) return refuse(reply, 400, "validation_failed");
      const now = deps.clock();
      const result = modes.setPausedAll({ workspaceSlug: org, paused, actor: gate.actor, now });
      store.recordAudit({
        workspaceSlug: org,
        eventType: paused ? "marketplace.agents.paused_all" : "marketplace.agents.resumed_all",
        actorId: gate.actor,
        metadata: { wasPaused: result.previous, paused: result.paused, at: now.toISOString() },
      });
      return overview();
    });
  }
}

import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { SqliteMarketplaceStore } from "../store.js";
import type { MarketplaceAgentConsent } from "../types.js";
import { GrantProposalSchema, GrantTermsSchema, grantView } from "./grants.js";
import { CHANNEL_KINDS, GRANT_PHASES, validatePolicy } from "./policy.js";
import type { ChannelProviderId } from "./providers/types.js";
import {
  CHANNEL_PROVIDER_IDS,
  channelClassSelection,
  channelPluginId,
  checkUploadType,
  classSelectionOfConsent,
  effectiveCapabilities,
  isChannelProviderId,
  largestAcceptedBytes,
  policyCapabilities,
  type ChannelPostBody,
  type ClassSelection,
} from "./runtime.js";
import {
  CHANNEL_ATTACHMENT_QUOTA_BYTES,
  CHANNEL_ATTACHMENT_UPLOADS_PER_DAY,
  CHANNEL_SCHEDULE_MAX_LEAD_MS,
  CHANNEL_SCHEDULE_MIN_LEAD_MS,
  receiptView,
  type ChannelCallPlan,
  type ChannelCallScope,
  type ChannelService,
  type ConsentedDispatch,
} from "./service.js";
import { ChannelStoreError, writeAttachmentBytes, type ChannelPostRecord, type ChannelPostStatus, type ChannelRecord } from "./store.js";

/** Manifest operation ids (contract alpha.3 ids are `<app>.<resource>.<verb>`, so sub-resources use a hyphen). */
export const CHANNEL_AGENT_OPERATION = Object.freeze({
  list: "marketplace.channels.list",
  get: "marketplace.channels.get",
  upload: "marketplace.channel-attachments.upload",
  post: "marketplace.channels.post",
  schedule: "marketplace.channels.schedule",
  cancel: "marketplace.channel-scheduled.cancel",
  receipts: "marketplace.channel-receipts.list",
  grantsList: "marketplace.channel-grants.list",
  grantsPropose: "marketplace.channel-grants.propose",
  grantsNarrow: "marketplace.channel-grants.narrow",
  grantsWithdraw: "marketplace.channel-grants.withdraw",
} as const);

export const AGENT_IDEMPOTENCY = /^[A-Za-z0-9_-]{8,100}$/u;
const AGENT_PREFIX = "/api/marketplace/v1/agent/channels";
/** Channel kinds each provider serves (spec §3). */
const PROVIDER_KINDS: Readonly<Record<ChannelProviderId, readonly (typeof CHANNEL_KINDS)[number][]>> = {
  telegram: ["chat"],
  discord: ["chat"],
  slack: ["chat"],
};
const POST_STATUSES: readonly ChannelPostStatus[] = ["held", "scheduled", "sending", "sent", "failed", "uncertain", "skipped", "cancelled", "expired"];
const OWNER_PREFIX = "/api/marketplace/channels";
const DAY_MS = 86_400_000;
/** Largest upload accepted at all (Telegram bot file cap); each channel's own limit applies at post time. */
export const CHANNEL_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const MIME = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u;
const PLAIN_LABEL = /^[^\p{Cc}​-‏‪-‮⁦-⁩﻿]{1,80}$/u;

const CampaignSchema = z.strictObject({
  ref: z.string().min(1).max(500).optional(),
  phase: z.enum(GRANT_PHASES).optional(),
});

const PostBodySchema = z.strictObject({
  text: z.string().max(10_000),
  attachments: z
    .array(
      z.strictObject({
        attachmentId: z.string().min(1).max(100),
        kind: z.string().min(1).max(20),
        transcript: z.string().max(4000).optional(),
      }),
    )
    .max(10)
    .optional(),
  campaign: CampaignSchema.optional(),
});

const ScheduleBodySchema = PostBodySchema.extend({ sendAt: z.string().max(40) });

const DestinationPickSchema = z.strictObject({
  externalId: z.string().min(1).max(64),
  parentId: z.string().min(1).max(64).optional(),
});

const ChannelTextSchema = z.string().max(500);
const CreateChannelSchema = z.strictObject({
  provider: z.enum(CHANNEL_PROVIDER_IDS as unknown as [ChannelProviderId, ...ChannelProviderId[]]),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/u),
  label: z.string().regex(PLAIN_LABEL),
  kind: z.enum(CHANNEL_KINDS).optional(),
  destination: DestinationPickSchema,
  audience: ChannelTextSchema.optional(),
  language: z.string().max(40).optional(),
  purpose: ChannelTextSchema.optional(),
  policy: z.record(z.unknown()).optional(),
  status: z.enum(["draft", "active"]).optional(),
  workspaceSlug: z.string().optional(),
});

const UpdateChannelSchema = z.strictObject({
  label: z.string().regex(PLAIN_LABEL).optional(),
  destination: DestinationPickSchema.optional(),
  audience: ChannelTextSchema.optional(),
  language: z.string().max(40).optional(),
  purpose: ChannelTextSchema.optional(),
  policy: z.record(z.unknown()).optional(),
  expectRevision: z.number().int().min(1).optional(),
  workspaceSlug: z.string().optional(),
});

export type ChannelRouteDeps = {
  app: FastifyInstance;
  store: SqliteMarketplaceStore;
  service: ChannelService;
  organizationId: string;
  /** False in inert mode: every channel op except the owner browse answers 409 channels_not_configured. */
  configured: boolean;
  now: () => Date;
  ready: Promise<void>;
  portal: { issuer: string; deploymentId: string | null };
  requireOperator: (request: FastifyRequest, reply: FastifyReply) => { id: string; organizationId: string } | null;
  agentGrant: (
    request: FastifyRequest,
    reply: FastifyReply,
    operationId: string,
  ) => { grant: { principalId: string; workspaceId: string | null }; agentId: string } | null;
  executeConsentedCall: (call: {
    reply: FastifyReply;
    traceId: string;
    scope: ChannelCallScope;
    input: { consentId: string; selection: null; input: Record<string, unknown>; idempotencyKey: string };
    via: "app-grant";
    channel: ChannelCallPlan;
  }) => Promise<Record<string, unknown>>;
  dispatch: ConsentedDispatch;
  traceIdFrom: (request: FastifyRequest) => string;
};

type Caller = NonNullable<ReturnType<ChannelRouteDeps["agentGrant"]>>;

export function registerChannelRoutes(deps: ChannelRouteDeps) {
  const { app, store, service } = deps;
  const channels = store.channels;
  const org = deps.organizationId;

  const header = (request: FastifyRequest, name: string) => {
    const value = request.headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" && first.trim() ? first.trim() : null;
  };

  const fail = (reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) => {
    reply.code(status);
    return { ok: false, schema: 1, error, ...extra };
  };

  /**
   * Idempotent app-state write: the same key with the same request replays the
   * stored answer; a different request is a conflict. Uses the existing
   * `marketplace_runtime_operation` table under a route-specific scope.
   */
  const idempotent = async (
    reply: FastifyReply,
    input: { scope: string; key: string; request: unknown },
    run: () => Promise<{ status: number; body: Record<string, unknown> }> | { status: number; body: Record<string, unknown> },
  ) => {
    const fingerprint = createHash("sha256").update(JSON.stringify(input.request ?? null)).digest("hex");
    let operation;
    try {
      operation = store.beginMarketplaceRuntimeOperation({ consentId: input.scope, idempotencyKey: input.key, fingerprint });
    } catch {
      return fail(reply, 409, "idempotency_conflict");
    }
    if (!operation.created) {
      const stored = operation.operation.response as { status?: number; body?: Record<string, unknown> } | null;
      if (operation.operation.status === "succeeded" && stored?.body) {
        reply.code(stored.status ?? 200);
        return { ...stored.body, replayed: true };
      }
      return fail(reply, 409, "operation_in_progress");
    }
    let result: { status: number; body: Record<string, unknown> };
    try {
      result = await run();
    } catch (error) {
      store.finishMarketplaceRuntimeOperation({
        id: operation.operation.id,
        status: "reconciliation-required",
        response: { status: 500, body: { ok: false, error: "channel_program_error" } },
      });
      throw error;
    }
    store.finishMarketplaceRuntimeOperation({ id: operation.operation.id, status: "succeeded", response: result });
    reply.code(result.status);
    return result.body;
  };

  // ----- agent consent resolution (§6 step 2) --------------------------------

  const agentConsents = (caller: Caller): Array<{ consent: MarketplaceAgentConsent; selection: ClassSelection }> =>
    store
      .listMarketplaceAgentConsents({ productTenantId: org, agentId: caller.agentId, state: "active" })
      .filter(
        (consent) =>
          consent.deploymentId === deps.portal.deploymentId &&
          consent.portalIssuer === deps.portal.issuer &&
          consent.workspaceId === caller.grant.workspaceId,
      )
      .flatMap((consent) => {
        const selection = classSelectionOfConsent(consent);
        return selection && selection.pluginId.startsWith("channels-") ? [{ consent, selection }] : [];
      });

  /**
   * The caller's consent for this channel: a class consent whose selection is
   * exactly the channel's (connection, `channel:<slug>`). Outward wins over
   * read. Null means 404 (the same as an unknown channel).
   */
  const consentForChannel = (caller: Caller, channel: ChannelRecord) => {
    const matches = agentConsents(caller).filter(({ selection }) => {
      const expected = channelClassSelection(channel, selection.grantClass === "outward" ? "outward" : "read");
      return (
        selection.pluginId === expected.pluginId &&
        selection.accountId === expected.accountId &&
        selection.resourceKind === expected.resourceKind &&
        selection.resourceRef === expected.resourceRef &&
        selection.actionGroup === expected.actionGroup &&
        (selection.grantClass === "outward" || selection.grantClass === "read")
      );
    });
    return matches.find((entry) => entry.selection.grantClass === "outward") ?? matches[0] ?? null;
  };

  const consentedChannel = (caller: Caller, channelId: string) => {
    const channel = channels.getChannel(org, channelId);
    if (!channel || channel.status === "draft") return null;
    const consent = consentForChannel(caller, channel);
    return consent ? { channel, ...consent } : null;
  };

  const scopeFor = (caller: Caller, consent: MarketplaceAgentConsent): ChannelCallScope => ({
    productTenantId: org,
    portalOrgId: consent.portalOrgId,
    workspaceId: caller.grant.workspaceId ?? consent.workspaceId,
    deploymentId: consent.deploymentId,
    agentId: caller.agentId,
    consentId: consent.consentId,
    leaseId: `app-grant:${createHash("sha256").update(`${caller.grant.principalId}|${consent.consentId}`).digest("hex").slice(0, 16)}`,
  });

  const agentChannelView = (channel: ChannelRecord, caller: Caller, grantClass: string) => {
    const caps = service.capabilitiesFor(channel.provider);
    const since = new Date(deps.now().getTime() - DAY_MS);
    const ownGrants = channels.listStandingGrants(org, { channelId: channel.id, agentId: caller.agentId }).map(grantView);
    return {
      id: channel.id,
      slug: channel.slug,
      label: channel.label,
      kind: channel.kind,
      provider: channel.provider,
      destination: { type: channel.destination.type, title: channel.destination.title, ...(channel.destination.url ? { url: channel.destination.url } : {}) },
      audience: channel.audience,
      language: channel.language,
      purpose: channel.purpose,
      status: channel.status,
      revision: channel.revision,
      grantClass,
      capabilities: caps ? effectiveCapabilities(caps, channel.policy) : null,
      caps: channel.policy.caps,
      standingGrants: channel.policy.standingGrants,
      content: {
        requireConfirmedEvent: channel.policy.content.requireConfirmedEvent,
        listingHosts: channel.policy.content.listingHosts,
        ...(channel.policy.schedule.window ? { window: channel.policy.schedule.window } : {}),
      },
      usageToday: { counted: channels.countCountedPosts(org, channel.id, since), perDay: channel.policy.caps.perDay },
      grants: ownGrants,
    };
  };

  const notConfigured = new WeakSet<FastifyRequest>();
  const NOT_CONFIGURED = { ok: false, schema: 1, error: "channels_not_configured" } as const;
  const agentPreamble = async (request: FastifyRequest, reply: FastifyReply, operationId: string) => {
    reply.header("cache-control", "no-store");
    const caller = deps.agentGrant(request, reply, operationId);
    if (!caller) return null;
    if (!deps.configured) {
      notConfigured.add(request);
      reply.code(409);
      return null;
    }
    await deps.ready;
    return caller;
  };
  const agentDenied = (request: FastifyRequest) =>
    notConfigured.has(request) ? NOT_CONFIGURED : { ok: false, error: "agent_grant_required" };
  const ownerDenied = (request: FastifyRequest) =>
    notConfigured.has(request) ? NOT_CONFIGURED : { ok: false, error: "marketplace_operator_required" };

  const postBody = (data: z.infer<typeof PostBodySchema>, sendAt: string | null): ChannelPostBody => ({
    text: data.text,
    attachments: (data.attachments ?? []).map((attachment) => ({
      id: attachment.attachmentId,
      kind: attachment.kind,
      ...(attachment.transcript !== undefined ? { transcript: attachment.transcript } : {}),
    })),
    campaign: { ...(data.campaign?.ref ? { ref: data.campaign.ref } : {}), ...(data.campaign?.phase ? { phase: data.campaign.phase } : {}) },
    sendAt,
  });

  // ----- agent routes (§5.1) ----------------------------------------------------

  app.get(AGENT_PREFIX, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.list);
    if (!caller) return agentDenied(request);
    const seen = new Set<string>();
    const items = [];
    for (const channel of channels.listChannels(org)) {
      if (channel.status === "draft" || seen.has(channel.id)) continue;
      const consent = consentForChannel(caller, channel);
      if (!consent) continue;
      seen.add(channel.id);
      items.push(agentChannelView(channel, caller, consent.selection.grantClass));
    }
    return { ok: true, schema: 1, channels: items };
  });

  app.get(`${AGENT_PREFIX}/receipts`, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.receipts);
    if (!caller) return agentDenied(request);
    const query = z
      .object({ channelId: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(request.query);
    return {
      ok: true,
      schema: 1,
      receipts: channels.listReceipts(org, { agentId: caller.agentId, channelId: query.channelId, limit: query.limit }).map(receiptView),
    };
  });

  app.get(`${AGENT_PREFIX}/grants`, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.grantsList);
    if (!caller) return agentDenied(request);
    return { ok: true, schema: 1, grants: channels.listStandingGrants(org, { agentId: caller.agentId }).map(grantView) };
  });

  app.get(`${AGENT_PREFIX}/:channelId`, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.get);
    if (!caller) return agentDenied(request);
    const { channelId } = request.params as { channelId: string };
    const found = consentedChannel(caller, channelId);
    if (!found) return fail(reply, 404, "channel_not_found");
    return { ok: true, schema: 1, channel: agentChannelView(found.channel, caller, found.selection.grantClass) };
  });

  // Raw-bytes upload in its own encapsulated scope (any content type is read as a Buffer here only).
  app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: CHANNEL_UPLOAD_MAX_BYTES }, (_request, body, done) => done(null, body));
    scope.post(`${AGENT_PREFIX}/attachments`, { bodyLimit: CHANNEL_UPLOAD_MAX_BYTES }, async (request, reply) => {
      const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.upload);
      if (!caller) return agentDenied(request);
      const key = header(request, "idempotency-key");
      if (!key || !AGENT_IDEMPOTENCY.test(key)) return fail(reply, 400, "idempotency_key_required");
      const contentType = (header(request, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!MIME.test(contentType) || contentType === "application/json") return fail(reply, 415, "channel_attachment_type_invalid");
      const rawName = (request.query as { name?: unknown } | undefined)?.name;
      const name = typeof rawName === "string" ? rawName.replace(/[\p{Cc}\\/]/gu, "_").trim().slice(0, 100) : "";
      if (!name) return fail(reply, 400, "channel_attachment_name_required");
      const bytes = Buffer.isBuffer(request.body) ? request.body : null;
      if (!bytes || bytes.byteLength === 0) return fail(reply, 400, "channel_attachment_empty");
      // Only an agent that may post somewhere may upload; the limit is the largest any of its channels accepts.
      const outward = channels
        .listChannels(org)
        .filter((channel) => channel.status === "active" && consentForChannel(caller, channel)?.selection.grantClass === "outward");
      if (outward.length === 0) return fail(reply, 403, "channel_outward_consent_required");
      const limit = Math.min(
        CHANNEL_UPLOAD_MAX_BYTES,
        largestAcceptedBytes(outward.flatMap((channel) => {
          const caps = service.capabilitiesFor(channel.provider);
          return caps ? [{ caps, policy: channel.policy }] : [];
        })),
      );
      if (bytes.byteLength > limit) return fail(reply, 413, "channel_attachment_too_large", { maxBytes: limit });
      const typeCheck = checkUploadType({
        bytes,
        contentType,
        name,
        octetStreamDeclared: outward.some((channel) => {
          const caps = service.capabilitiesFor(channel.provider);
          return Boolean(caps && caps.file && caps.file.types.includes("application/octet-stream"));
        }),
      });
      if (!typeCheck.ok) return fail(reply, typeCheck.status, typeCheck.error);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      // Idempotent on the key; a quota refusal records nothing, so the same key may be retried later.
      const scope = `channel-upload:${caller.agentId}`;
      const fingerprint = createHash("sha256").update(JSON.stringify({ sha256, contentType, name })).digest("hex");
      const previous = store.getMarketplaceRuntimeOperation({ consentId: scope, idempotencyKey: key });
      if (previous) {
        const stored = previous.response as { status?: number; body?: Record<string, unknown> } | null;
        if (previous.fingerprint !== fingerprint) return fail(reply, 409, "idempotency_conflict");
        if (previous.status === "succeeded" && stored?.body) {
          reply.code(stored.status ?? 200);
          return { ...stored.body, replayed: true };
        }
        return fail(reply, 409, "operation_in_progress");
      }
      const inserted = channels.insertAttachmentWithinQuota({
        workspaceSlug: org,
        sha256,
        contentType,
        bytes: bytes.byteLength,
        name,
        createdBy: caller.agentId,
        now: deps.now(),
        maxBytes: CHANNEL_ATTACHMENT_QUOTA_BYTES,
        maxPerDay: CHANNEL_ATTACHMENT_UPLOADS_PER_DAY,
        write: () => {
          writeAttachmentBytes(service.attachmentsDir, bytes, sha256);
        },
      });
      if (!inserted.ok) {
        return fail(reply, 429, inserted.error, {
          limit: inserted.limit,
          maxBytes: CHANNEL_ATTACHMENT_QUOTA_BYTES,
          maxUploadsPerDay: CHANNEL_ATTACHMENT_UPLOADS_PER_DAY,
        });
      }
      const record = inserted.record;
      store.recordAudit({
        workspaceSlug: org,
        pluginId: null,
        eventType: "marketplace.channels.attachment.uploaded",
        actorId: `agent:${caller.agentId}`,
        metadata: { attachmentId: record.id, sha256, contentType, bytes: bytes.byteLength },
      });
      const result = { status: 201, body: { ok: true, schema: 1, attachmentId: record.id, sha256, bytes: bytes.byteLength, contentType } };
      try {
        const operation = store.beginMarketplaceRuntimeOperation({ consentId: scope, idempotencyKey: key, fingerprint });
        if (operation.created) {
          store.finishMarketplaceRuntimeOperation({ id: operation.operation.id, status: "succeeded", response: result });
        }
      } catch {
        // A concurrent upload with the same key won; this row is unreferenced and the cleanup removes it.
      }
      reply.code(result.status);
      return result.body;
    });
  });

  const channelCall = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operationId: string,
    mode: "post" | "schedule",
  ) => {
    const traceId = deps.traceIdFrom(request);
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    const caller = await agentPreamble(request, reply, operationId);
    if (!caller) return agentDenied(request);
    const key = header(request, "idempotency-key");
    if (!key || !AGENT_IDEMPOTENCY.test(key)) return fail(reply, 400, "idempotency_key_required");
    const parsed = (mode === "schedule" ? ScheduleBodySchema : PostBodySchema).safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { channelId } = request.params as { channelId: string };
    const found = consentedChannel(caller, channelId);
    if (!found) return fail(reply, 404, "channel_not_found");
    let sendAt: string | null = null;
    if (mode === "schedule") {
      const at = Date.parse((parsed.data as z.infer<typeof ScheduleBodySchema>).sendAt);
      const now = deps.now().getTime();
      if (!Number.isFinite(at) || at < now + CHANNEL_SCHEDULE_MIN_LEAD_MS || at > now + CHANNEL_SCHEDULE_MAX_LEAD_MS) {
        return fail(reply, 422, "channel_send_at_invalid", { minLeadSeconds: 60, maxLeadDays: 30 });
      }
      sendAt = new Date(at).toISOString();
    }
    return deps.executeConsentedCall({
      reply,
      traceId,
      scope: scopeFor(caller, found.consent),
      input: { consentId: found.consent.consentId, selection: null, input: {}, idempotencyKey: key },
      via: "app-grant",
      channel: {
        selection: channelClassSelection(found.channel, found.selection.grantClass === "outward" ? "outward" : "read"),
        channelId: found.channel.id,
        mode,
        body: postBody(parsed.data, sendAt),
      },
    });
  };

  app.post(`${AGENT_PREFIX}/:channelId/posts`, { bodyLimit: 64 * 1024 }, (request, reply) =>
    channelCall(request, reply, CHANNEL_AGENT_OPERATION.post, "post"),
  );
  app.post(`${AGENT_PREFIX}/:channelId/scheduled`, { bodyLimit: 64 * 1024 }, (request, reply) =>
    channelCall(request, reply, CHANNEL_AGENT_OPERATION.schedule, "schedule"),
  );

  app.post(`${AGENT_PREFIX}/:channelId/scheduled/:postId/cancel`, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.cancel);
    if (!caller) return agentDenied(request);
    const { channelId, postId } = request.params as { channelId: string; postId: string };
    const found = consentedChannel(caller, channelId);
    const post = found ? channels.getPost(org, postId) : null;
    if (!found || !post || post.channelId !== found.channel.id || post.agentId !== caller.agentId || post.mode !== "scheduled") {
      return fail(reply, 404, "channel_post_not_found");
    }
    return cancelScheduled(reply, post, found.channel, `agent:${caller.agentId}`);
  });

  app.post(`${AGENT_PREFIX}/:channelId/grants`, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.grantsPropose);
    if (!caller) return agentDenied(request);
    const key = header(request, "idempotency-key");
    if (!key || !AGENT_IDEMPOTENCY.test(key)) return fail(reply, 400, "idempotency_key_required");
    const parsed = GrantProposalSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { channelId } = request.params as { channelId: string };
    const found = consentedChannel(caller, channelId);
    if (!found) return fail(reply, 404, "channel_not_found");
    if (found.selection.grantClass !== "outward") return fail(reply, 403, "channel_outward_consent_required");
    return idempotent(reply, { scope: `channel-grant-propose:${caller.agentId}`, key, request: { channelId, proposal: parsed.data } }, () => {
      const outcome = service.grants.propose({ channel: found.channel, agentId: caller.agentId, consentRowId: found.consent.id, proposal: parsed.data });
      return outcome.ok
        ? { status: 201, body: { ok: true, schema: 1, grant: grantView(outcome.grant) } }
        : { status: outcome.status, body: { ok: false, schema: 1, error: outcome.error, ...(outcome.fields ? { fields: outcome.fields } : {}) } };
    });
  });

  /**
   * Cancels a scheduled post (agent: own posts; owner: any). Cancelling only narrows, so it never needs
   * approval; a waiting approval is denied with it and an approved (executing) one is failed (L4, U3).
   */
  const cancelScheduled = (reply: FastifyReply, post: ChannelPostRecord, channel: ChannelRecord, actor: string) => {
    if (post.status === "cancelled") {
      const receipt = channels.getReceiptByPost(org, post.id);
      return { ok: true, schema: 1, replayed: true, ...(receipt ? { receipt: receiptView(receipt) } : {}) };
    }
    if (post.status !== "scheduled" && post.status !== "held") return fail(reply, 409, "channel_post_not_cancellable", { status: post.status });
    const reason = actor.startsWith("agent:") ? "cancelled_by_agent" : "cancelled_by_owner";
    // A held post and its approval end in one transaction (refused once a send took the post).
    const ended = post.status === "held" ? service.cancelHeld(post, channel, actor, reason) : service.endPost(post, channel, "cancelled", reason);
    if (!ended) return fail(reply, 409, "channel_post_not_cancellable");
    const receipt = channels.getReceiptByPost(org, post.id);
    return { ok: true, schema: 1, ...(receipt ? { receipt: receiptView(receipt) } : {}) };
  };

  const ownGrant = (caller: Caller, grantId: string) => {
    const grant = channels.getStandingGrant(org, grantId);
    return grant && grant.agentId === caller.agentId ? grant : null;
  };

  app.post(`${AGENT_PREFIX}/grants/:grantId/narrow`, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.grantsNarrow);
    if (!caller) return agentDenied(request);
    const key = header(request, "idempotency-key");
    if (!key || !AGENT_IDEMPOTENCY.test(key)) return fail(reply, 400, "idempotency_key_required");
    const parsed = GrantTermsSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { grantId } = request.params as { grantId: string };
    const grant = ownGrant(caller, grantId);
    const channel = grant ? channels.getChannel(org, grant.channelId) : null;
    if (!grant || !channel) return fail(reply, 404, "grant_not_found");
    return idempotent(reply, { scope: `channel-grant-narrow:${caller.agentId}`, key, request: { grantId, terms: parsed.data } }, () => {
      const outcome = service.grants.narrow({ grant, channel, terms: parsed.data });
      return outcome.ok
        ? { status: 200, body: { ok: true, schema: 1, grant: grantView(outcome.grant) } }
        : { status: outcome.status, body: { ok: false, schema: 1, error: outcome.error, ...(outcome.fields ? { fields: outcome.fields } : {}) } };
    });
  });

  app.post(`${AGENT_PREFIX}/grants/:grantId/withdraw`, async (request, reply) => {
    const caller = await agentPreamble(request, reply, CHANNEL_AGENT_OPERATION.grantsWithdraw);
    if (!caller) return agentDenied(request);
    const { grantId } = request.params as { grantId: string };
    const grant = ownGrant(caller, grantId);
    if (!grant) return fail(reply, 404, "grant_not_found");
    if (grant.status === "withdrawn") return { ok: true, schema: 1, replayed: true, grant: grantView(grant) };
    const outcome = service.grants.withdraw(grant);
    return outcome.ok ? { ok: true, schema: 1, grant: grantView(outcome.grant) } : fail(reply, outcome.status, outcome.error);
  });

  // ----- owner routes (§5.2, audience owner) --------------------------------------

  const owner = async (request: FastifyRequest, reply: FastifyReply, allowUnconfigured = false) => {
    reply.header("cache-control", "no-store");
    const principal = deps.requireOperator(request, reply);
    if (!principal) return null;
    if (!deps.configured && !allowUnconfigured) {
      notConfigured.add(request);
      reply.code(409);
      return null;
    }
    const supplied = [request.query, request.body]
      .map((value) => (value && typeof value === "object" && !Buffer.isBuffer(value) ? (value as Record<string, unknown>).workspaceSlug : undefined))
      .find((value) => value !== undefined);
    if (principal.organizationId !== org || (supplied !== undefined && supplied !== principal.organizationId)) {
      reply.code(403);
      return null;
    }
    // An operator session binds `actorId` into every mutation body; the principal is the actor here.
    if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
      delete (request.body as Record<string, unknown>).actorId;
    }
    await deps.ready;
    return principal;
  };

  const ownerChannelView = (channel: ChannelRecord) => {
    const caps = service.capabilitiesFor(channel.provider);
    return {
      ...channel,
      capabilities: caps ? effectiveCapabilities(caps, channel.policy) : null,
      usageToday: channels.countCountedPosts(org, channel.id, new Date(deps.now().getTime() - DAY_MS)),
      grants: channels.listStandingGrants(org, { channelId: channel.id }).map(grantView),
      // "Grant to agent": the class selection to pass to marketplace.consents.request.
      grantSelection: {
        ...channelClassSelection(channel, "outward"),
        actionGroupLabel: channel.label,
      },
    };
  };

  app.get(OWNER_PREFIX, async (request, reply) => {
    const principal = await owner(request, reply, true);
    if (!principal) return ownerDenied(request);
    const readiness = service.readinessView();
    if (!deps.configured) {
      return { ok: true, schema: 1, configured: false, providers: Object.entries(readiness).map(([id, state]) => ({ id, readiness: state })) };
    }
    // U2: each configured provider's static capability declaration (§3.1), so the create form offers only declared kinds.
    const providers = Object.entries(readiness).map(([id, state]) => ({
      id,
      readiness: state,
      ...(state !== "credential_missing" && isChannelProviderId(id)
        ? { capabilities: service.capabilitiesFor(id), kinds: PROVIDER_KINDS[id] }
        : {}),
    }));
    const connections = Object.fromEntries(
      CHANNEL_PROVIDER_IDS.map((provider) => {
        const connection = store.getConnection(org, channelPluginId(provider));
        return [
          provider,
          connection
            ? {
                connectionId: connection.id,
                state: connection.state,
                botUsername: typeof connection.metadata.botUsername === "string" ? connection.metadata.botUsername : null,
                verifiedAt: typeof connection.metadata.verifiedAt === "string" ? connection.metadata.verifiedAt : null,
                credentialRef: typeof connection.metadata.credentialRef === "string" ? connection.metadata.credentialRef : null,
              }
            : null,
        ];
      }),
    );
    return {
      ok: true,
      schema: 1,
      configured: true,
      providers,
      readiness: service.readinessView(),
      connections,
      channels: channels.listChannels(org).map(ownerChannelView),
      pendingGrants: channels.listStandingGrants(org, { status: "proposed" }).map(grantView),
      uncertainPosts: channels.listPosts(org, { status: "uncertain", limit: 100 }).map((post) => ({
        id: post.id,
        channelId: post.channelId,
        agentId: post.agentId,
        digest: post.digest,
        reason: post.reason,
        updatedAt: post.updatedAt,
      })),
    };
  });

  app.get(`${OWNER_PREFIX}/discover`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const provider = (request.query as { provider?: unknown }).provider;
    if (!isChannelProviderId(provider)) return fail(reply, 400, "channel_provider_unknown");
    const result = await service.discover(provider);
    if (!result.ok) return fail(reply, result.reason === "credential_missing" ? 409 : 503, `channel_${result.reason}`);
    return { ok: true, schema: 1, provider, destinations: result.destinations };
  });

  const policyFor = (provider: string, input: Record<string, unknown> | undefined) => {
    const caps = service.capabilitiesFor(provider);
    return validatePolicy(input as never, caps ? policyCapabilities(caps) : undefined);
  };

  app.post(OWNER_PREFIX, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const parsed = CreateChannelSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const input = parsed.data;
    const key = header(request, "idempotency-key");
    if (!key || !AGENT_IDEMPOTENCY.test(key)) return fail(reply, 400, "idempotency_key_required");
    return idempotent(reply, { scope: `channel-create:${principal.id}`, key, request: input }, () => {
      // U4: the kind must be one the provider serves (Telegram, Discord and Slack are chat providers).
      const kind = input.kind ?? "chat";
      if (!PROVIDER_KINDS[input.provider].includes(kind)) {
        return { status: 422, body: { ok: false, schema: 1, error: "channel_kind_unsupported", supported: PROVIDER_KINDS[input.provider] } };
      }
      const connection = store.getConnection(org, channelPluginId(input.provider));
      if (!connection || connection.state !== "connected" || service.readinessView()[input.provider] !== "available") {
        return { status: 409, body: { ok: false, schema: 1, error: "channel_connection_unavailable" } };
      }
      // Destinations are picked from discovery, never typed (spec §4.2).
      const destination = service.discoveredDestination(input.provider, input.destination.externalId, input.destination.parentId);
      if (!destination) return { status: 409, body: { ok: false, schema: 1, error: "channel_destination_not_discovered" } };
      const policy = policyFor(input.provider, input.policy);
      if (!policy.ok) return { status: 422, body: { ok: false, schema: 1, error: policy.error, errors: policy.errors } };
      try {
        const channel = channels.createChannel({
          workspaceSlug: org,
          slug: input.slug,
          label: input.label.trim(),
          kind,
          provider: input.provider,
          connectionId: connection.id,
          destination: {
            type: destination.type,
            externalId: destination.externalId,
            title: destination.title,
            ...(destination.url ? { url: destination.url } : {}),
            ...(destination.parentId ? { parentId: destination.parentId } : {}),
          },
          audience: input.audience,
          language: input.language,
          purpose: input.purpose,
          policy: policy.policy,
          status: input.status ?? "active",
          now: deps.now(),
        });
        store.recordAudit({
          workspaceSlug: org,
          pluginId: channelPluginId(channel.provider),
          eventType: "marketplace.channels.created",
          actorId: principal.id,
          metadata: { channelId: channel.id, slug: channel.slug, provider: channel.provider, revision: channel.revision },
        });
        return { status: 201, body: { ok: true, schema: 1, channel: ownerChannelView(channel) } };
      } catch (error) {
        if (error instanceof ChannelStoreError) return { status: 409, body: { ok: false, schema: 1, error: error.code } };
        throw error;
      }
    });
  });

  const ownedChannel = (request: FastifyRequest) => {
    const { channelId } = request.params as { channelId: string };
    return channels.getChannel(org, channelId);
  };

  app.patch(`${OWNER_PREFIX}/:channelId`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const channel = ownedChannel(request);
    if (!channel) return fail(reply, 404, "channel_not_found");
    const parsed = UpdateChannelSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const input = parsed.data;
    let destination = channel.destination;
    if (input.destination) {
      const picked = isChannelProviderId(channel.provider)
        ? service.discoveredDestination(channel.provider, input.destination.externalId, input.destination.parentId)
        : null;
      if (!picked) return fail(reply, 409, "channel_destination_not_discovered");
      destination = {
        type: picked.type,
        externalId: picked.externalId,
        title: picked.title,
        ...(picked.url ? { url: picked.url } : {}),
        ...(picked.parentId ? { parentId: picked.parentId } : {}),
      };
    }
    let policy = channel.policy;
    if (input.policy) {
      const validated = policyFor(channel.provider, input.policy);
      if (!validated.ok) return fail(reply, 422, validated.error, { errors: validated.errors });
      policy = validated.policy;
    }
    try {
      const updated = channels.updateChannel(
        org,
        channel.id,
        {
          ...(input.label ? { label: input.label.trim() } : {}),
          destination,
          ...(input.audience !== undefined ? { audience: input.audience } : {}),
          ...(input.language !== undefined ? { language: input.language } : {}),
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          policy,
          now: deps.now(),
        },
        input.expectRevision !== undefined ? { expectRevision: input.expectRevision } : {},
      );
      // §4.4 rule 5: a lowered ceiling suspends the grants it no longer contains. L6: a new destination
      // suspends every active grant and ends the channel's holds (their digests no longer match).
      const destinationChanged =
        updated.destination.externalId !== channel.destination.externalId ||
        (updated.destination.parentId ?? null) !== (channel.destination.parentId ?? null);
      const suspended = [
        ...(destinationChanged ? service.suspendForDestinationChange(updated) : []),
        ...service.grants.recheckChannel(updated),
      ];
      store.recordAudit({
        workspaceSlug: org,
        pluginId: channelPluginId(updated.provider),
        eventType: "marketplace.channels.updated",
        actorId: principal.id,
        metadata: { channelId: updated.id, revision: updated.revision, suspendedGrants: suspended.map((grant) => grant.id) },
      });
      return { ok: true, schema: 1, channel: ownerChannelView(updated), suspendedGrants: suspended.map(grantView) };
    } catch (error) {
      if (error instanceof ChannelStoreError) return fail(reply, error.code === "channel_not_found" ? 404 : 409, error.code);
      throw error;
    }
  });

  for (const [verb, status] of [["pause", "paused"], ["resume", "active"], ["archive", "archived"]] as const) {
    app.post(`${OWNER_PREFIX}/:channelId/${verb}`, async (request, reply) => {
      const principal = await owner(request, reply);
      if (!principal) return ownerDenied(request);
      const channel = ownedChannel(request);
      if (!channel) return fail(reply, 404, "channel_not_found");
      if (channel.status === "archived") return fail(reply, 409, "channel_archived");
      if (verb === "resume" && channel.status === "active") return { ok: true, schema: 1, channel: ownerChannelView(channel) };
      const updated = channels.setChannelStatus(org, channel.id, status, deps.now());
      // Pause/archive suspend every active grant; resume does not revive them (a new approval does).
      const suspended = service.grants.recheckChannel(updated);
      store.recordAudit({
        workspaceSlug: org,
        pluginId: channelPluginId(updated.provider),
        eventType: `marketplace.channels.${verb}d`,
        actorId: principal.id,
        metadata: { channelId: updated.id, status: updated.status, suspendedGrants: suspended.map((grant) => grant.id) },
      });
      return { ok: true, schema: 1, channel: ownerChannelView(updated), suspendedGrants: suspended.map(grantView) };
    });
  }

  app.post(`${OWNER_PREFIX}/:channelId/test`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const channel = ownedChannel(request);
    if (!channel) return fail(reply, 404, "channel_not_found");
    const key = header(request, "idempotency-key");
    if (!key || !AGENT_IDEMPOTENCY.test(key)) return fail(reply, 400, "idempotency_key_required");
    return service.ownerTest({ channel, operatorId: principal.id, idempotencyKey: key, reply, traceId: deps.traceIdFrom(request), dispatch: deps.dispatch });
  });

  const OwnerApproveSchema = z.strictObject({ final: GrantTermsSchema.optional(), workspaceSlug: z.string().optional() });

  app.post(`${OWNER_PREFIX}/grants/:grantId/approve`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const parsed = OwnerApproveSchema.safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { grantId } = request.params as { grantId: string };
    const grant = channels.getStandingGrant(org, grantId);
    const channel = grant ? channels.getChannel(org, grant.channelId) : null;
    if (!grant || !channel) return fail(reply, 404, "grant_not_found");
    const outcome = service.grants.approve({ grant, channel, final: parsed.data.final, approvedBy: principal.id });
    return outcome.ok
      ? { ok: true, schema: 1, grant: grantView(outcome.grant) }
      : fail(reply, outcome.status, outcome.error, outcome.fields ? { fields: outcome.fields } : {});
  });

  for (const verb of ["decline", "revoke"] as const) {
    app.post(`${OWNER_PREFIX}/grants/:grantId/${verb}`, async (request, reply) => {
      const principal = await owner(request, reply);
      if (!principal) return ownerDenied(request);
      const { grantId } = request.params as { grantId: string };
      const grant = channels.getStandingGrant(org, grantId);
      if (!grant) return fail(reply, 404, "grant_not_found");
      const outcome = verb === "decline" ? service.grants.decline(grant, principal.id) : service.grants.revoke(grant, principal.id);
      return outcome.ok ? { ok: true, schema: 1, grant: grantView(outcome.grant) } : fail(reply, outcome.status, outcome.error);
    });
  }

  app.get(`${OWNER_PREFIX}/posts`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const query = z
      .object({
        status: z.string().max(200).optional(),
        channelId: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        workspaceSlug: z.string().optional(),
        actorId: z.string().optional(),
      })
      .safeParse(request.query);
    if (!query.success) return fail(reply, 400, "validation_failed");
    const statuses = (query.data.status ?? "held,scheduled,uncertain").split(",").map((value) => value.trim()).filter(Boolean);
    if (statuses.some((value) => !(POST_STATUSES as readonly string[]).includes(value))) return fail(reply, 400, "validation_failed");
    const labels = new Map(channels.listChannels(org).map((channel) => [channel.id, channel]));
    const posts = statuses
      .flatMap((status) => channels.listPosts(org, { status: status as ChannelPostStatus, channelId: query.data.channelId, limit: query.data.limit }))
      .sort((a, b) => (a.sendAt ?? a.createdAt).localeCompare(b.sendAt ?? b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, query.data.limit)
      .map((post) => {
        const channel = labels.get(post.channelId);
        const approval = post.status === "held" ? service.approvalForPost(post) : null;
        return {
          id: post.id,
          channelId: post.channelId,
          channel: channel ? { slug: channel.slug, label: channel.label, provider: channel.provider } : null,
          agentId: post.agentId,
          mode: post.mode,
          status: post.status,
          sendAt: post.sendAt,
          digestPrefix: post.digest.slice(0, 12),
          authority: post.authority,
          reason: post.reason,
          attachments: post.attachments.length,
          ...(approval ? { approval: { id: approval.id, state: approval.state, expiresAt: approval.expiresAt } } : {}),
          createdAt: post.createdAt,
        };
      });
    return { ok: true, schema: 1, posts };
  });

  app.post(`${OWNER_PREFIX}/posts/:postId/cancel`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const { postId } = request.params as { postId: string };
    const post = channels.getPost(org, postId);
    const channel = post ? channels.getChannel(org, post.channelId) : null;
    // Scheduled posts, and held posts (immediate or scheduled) waiting for an approval.
    if (!post || !channel || (post.mode !== "scheduled" && post.status !== "held" && post.status !== "cancelled")) {
      return fail(reply, 404, "channel_post_not_found");
    }
    const result = cancelScheduled(reply, post, channel, principal.id);
    if (result.ok && !("replayed" in result)) {
      store.recordAudit({
        workspaceSlug: org,
        pluginId: channelPluginId(channel.provider),
        eventType: "marketplace.channels.post.cancelled_by_owner",
        actorId: principal.id,
        metadata: { channelId: channel.id, postId: post.id, digest: post.digest },
      });
    }
    return result;
  });

  app.post(`${OWNER_PREFIX}/posts/:postId/resolve`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const parsed = z.strictObject({ status: z.enum(["sent", "failed"]), workspaceSlug: z.string().optional() }).safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const { postId } = request.params as { postId: string };
    const outcome = service.resolveUncertain(postId, parsed.data.status, principal.id);
    if (!outcome.ok) return fail(reply, outcome.status, outcome.error);
    const receipt = channels.getReceiptByPost(org, postId);
    return { ok: true, schema: 1, post: { id: outcome.post.id, status: outcome.post.status }, ...(receipt ? { receipt: receiptView(receipt) } : {}) };
  });

  app.get(`${OWNER_PREFIX}/receipts/export`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const query = z
      .object({
        channelId: z.string().max(100).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(1000),
        workspaceSlug: z.string().optional(),
      })
      .parse(request.query);
    // The domain record with the posted text (owner only); never the audit trail.
    return {
      ok: true,
      schema: 1,
      receipts: channels.listReceipts(org, { channelId: query.channelId, limit: query.limit }).map((receipt) => ({
        ...receiptView(receipt),
        agentId: receipt.agentId,
        text: receipt.text,
        createdAt: receipt.createdAt,
      })),
    };
  });

  app.post(`${OWNER_PREFIX}/receipts/purge`, async (request, reply) => {
    const principal = await owner(request, reply);
    if (!principal) return ownerDenied(request);
    const parsed = z
      .strictObject({ olderThanDays: z.number().int().min(0).max(3650).default(90), workspaceSlug: z.string().optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) return fail(reply, 400, "validation_failed");
    const before = new Date(deps.now().getTime() - parsed.data.olderThanDays * DAY_MS);
    const { purged, skipped } = channels.purgeReceipts(org, before);
    // Q1: attachments of finished posts go with their receipts (bounded; the tick continues).
    service.cleanupAttachments(deps.now());
    store.recordAudit({
      workspaceSlug: org,
      pluginId: null,
      eventType: "marketplace.channels.receipts.purged",
      actorId: principal.id,
      metadata: { before: before.toISOString(), purged, skipped },
    });
    return { ok: true, schema: 1, purged, skipped, before: before.toISOString() };
  });
}

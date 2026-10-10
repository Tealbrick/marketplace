// Test-only: a Marketplace app with Channels wired to fake providers and a fake Portal. Never imported by runtime code.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildMarketplaceApp, channelRuntimeOf, type BuildMarketplaceAppOptions } from "../app.js";
import { AGENT_OPERATION, MARKETPLACE_MANIFEST } from "../contract.js";
import { MarketplaceOperatorSessionManager } from "../operator-auth.js";
import { SqliteMarketplaceStore } from "../store.js";
import type { ConnectorCapability } from "../types.js";
import { seededPin } from "./approval-test-support.js";
import type { OwnerApprovalVerifier } from "./approvals.js";
import { createBuzzProvider } from "./providers/buzz.js";
import { createDiscordProvider } from "./providers/discord.js";
import { createSlackProvider } from "./providers/slack.js";
import { createTeamsProvider } from "./providers/teams.js";
import { createTelegramProvider } from "./providers/telegram.js";
import type { ActionResult, ChannelDestination, ChannelProvider, ChannelProviderId, OutboundMessage, PersonQuery, SendResult } from "./providers/types.js";
import { CHANNEL_AGENT_OPERATION } from "./routes.js";

export const PORTAL = "https://portal.test";
export const TENANT = "tenant-community";
export const PROOF = "p".repeat(43);
export const SERVICE = "marketplace-service-secret";
/** Sentinel credentials: they must never appear in any response, row, receipt, log or audit (§8). */
export const TELEGRAM_TOKEN = "987654321:AAHsentinelTELEGRAMtoken_0123456789abcdef";
export const DISCORD_TOKEN = "MTSentinelDISCORDtoken.Gx1234.abcdefghijklmnopqrstuvwxyz0123";
export const GRANT_A = `tbag_${"a".repeat(43)}`;
export const GRANT_B = `tbag_${"b".repeat(43)}`;
export const GRANT_ALL = `tbag_${"d".repeat(43)}`;

const AGENT_OPS = [...Object.values(CHANNEL_AGENT_OPERATION), AGENT_OPERATION.approvalsResolve, AGENT_OPERATION.consentsList, AGENT_OPERATION.toolsCall];

export type FakeSend = { credential: string | null | undefined; destination: ChannelDestination; message: OutboundMessage };
/** A recorded routes v2 adapter call (reaction, edit, delete, person lookup, DM open). */
export type FakeAction =
  | { kind: "react"; destination: ChannelDestination; messageId: string; emoji: string; remove: boolean }
  | { kind: "edit"; destination: ChannelDestination; messageId: string; text: string }
  | { kind: "remove"; destination: ChannelDestination; messageId: string }
  | { kind: "findPerson"; query: PersonQuery }
  | { kind: "openDirect"; userId: string };

/**
 * A provider with the real capability declaration whose send/discover/verify are recorded fakes. The routes v2
 * methods (react, edit, remove, findPerson, openDirect) are recorded fakes too, present only where the real
 * adapter has them. `people` is the fake directory (`email` or `handle` → one person).
 */
export function fakeProvider(id: ChannelProviderId, token: string) {
  const real: ChannelProvider =
    id === "telegram"
      ? createTelegramProvider()
      : id === "slack"
        ? createSlackProvider()
        : id === "teams"
          ? createTeamsProvider({ graphEnabled: true })
          : id === "buzz"
            ? createBuzzProvider()
            : createDiscordProvider();
  const sends: FakeSend[] = [];
  const actions: FakeAction[] = [];
  const actionReplies: ActionResult[] = [];
  const people = new Map<string, { userId: string; displayName: string; emailVerified?: boolean } | "ambiguous">();
  const replies: Array<SendResult | (() => Promise<SendResult>)> = [];
  const ids =
    id === "telegram"
      ? ["-1001234", "-1005678"]
      : id === "slack"
        ? ["C0ANNOUNCE", "C0SECOND0"]
        : id === "teams"
          ? ["19:announce@thread.tacv2", "19:second@thread.tacv2"]
          : id === "buzz"
            ? ["8f9c2a3e-0000-4000-8000-000000000001", "8f9c2a3e-0000-4000-8000-000000000002"]
            : ["5550001", "5550002"];
  let destinations: ChannelDestination[] = [
    { type: "channel", externalId: ids[0]!, title: `${id} test chat`, ...(id === "discord" ? { parentId: "777" } : {}) },
    { type: "channel", externalId: ids[1]!, title: `${id} second chat`, ...(id === "discord" ? { parentId: "777" } : {}) },
  ];
  const provider: ChannelProvider = {
    id,
    capabilities: real.capabilities,
    async verify(credential) {
      if (!credential) return { ok: false, reason: "credential_missing" };
      return credential === token
        ? { ok: true, botId: "4242", botUsername: `${id}_test_bot`, ...(id === "slack" ? { teamId: "T0TEAM001" } : {}) }
        : { ok: false, reason: "credential_invalid" };
    },
    async discover(credential) {
      return credential === token ? { ok: true, destinations } : { ok: false, reason: "credential_invalid" };
    },
    async send(credential, destination, message) {
      sends.push({ credential, destination, message });
      const next = replies.shift();
      if (typeof next === "function") return next();
      return next ?? { status: "sent", resultIds: [`m${sends.length}`], resultUrls: [`https://t.me/c/1234/${sends.length}`] };
    },
  };
  if (real.react) {
    provider.react = async (_credential, destination, messageId, emoji, options) => {
      actions.push({ kind: "react", destination, messageId, emoji, remove: options?.remove === true });
      return actionReplies.shift() ?? { status: "sent" };
    };
  }
  if (real.edit) {
    provider.edit = async (_credential, destination, messageId, message) => {
      actions.push({ kind: "edit", destination, messageId, text: message.text });
      const reply = actionReplies.shift();
      return reply ? { ...reply, resultIds: reply.status === "sent" ? [messageId] : [], resultUrls: [] } : { status: "sent", resultIds: [messageId], resultUrls: [] };
    };
  }
  if (real.remove) {
    provider.remove = async (_credential, destination, messageId) => {
      actions.push({ kind: "remove", destination, messageId });
      return actionReplies.shift() ?? { status: "sent" };
    };
  }
  if (real.findPerson) {
    provider.findPerson = async (_credential, query) => {
      actions.push({ kind: "findPerson", query });
      const found = people.get((query.email ?? query.handle ?? "").toLowerCase());
      if (found === "ambiguous") return { ok: false, reason: "ambiguous", errorCode: "person_ambiguous", detail: "more than one person matches" };
      return found
        ? { ok: true, userId: found.userId, displayName: found.displayName, emailVerified: found.emailVerified ?? query.email !== undefined }
        : { ok: false, reason: "not_found", errorCode: "person_not_found", detail: "no person matches" };
    };
  }
  if (real.openDirect) {
    provider.openDirect = async (_credential, userId) => {
      actions.push({ kind: "openDirect", userId });
      return { ok: true, destination: { type: "person", externalId: `dm-${userId}`, title: "Direct message", personId: userId } };
    };
  }
  return {
    provider,
    sends,
    actions,
    /** Queues the next reaction, edit or delete answers (default `sent`). */
    actionReply: (...more: ActionResult[]) => void actionReplies.push(...more),
    /** Adds a person to the fake directory under an email or handle (or marks the key ambiguous). */
    addPerson: (key: string, person: { userId: string; displayName: string; emailVerified?: boolean } | "ambiguous") => void people.set(key.toLowerCase(), person),
    reply: (...more: Array<SendResult | (() => Promise<SendResult>)>) => void replies.push(...more),
    setDestinations: (next: ChannelDestination[]) => {
      destinations = next;
    },
  };
}

export type ChannelFixture = Awaited<ReturnType<typeof channelFixture>>;

export async function channelFixture(input: {
  environment?: Record<string, string | undefined>;
  options?: Partial<BuildMarketplaceAppOptions>;
  verifier?: OwnerApprovalVerifier;
  /** Portal's K1 `approvalTrusted` flag on every introspection answer (absent by default). */
  approvalTrusted?: boolean;
  /** Pin the deployment owner (owner-1), so `ownerWrite` passes the strict owner gate. */
  ownerPin?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-channels-app-"));
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"), { handoffEncryptionKey: "a".repeat(64) });
  const telegram = fakeProvider("telegram", TELEGRAM_TOKEN);
  const discord = fakeProvider("discord", DISCORD_TOKEN);
  let clock = Date.now();
  const grants: Record<string, { agentId: string; operations: string[]; actions: string[] }> = {
    [GRANT_A]: { agentId: "agent-1", operations: AGENT_OPS, actions: ["create", "read", "update", "delete"] },
    [GRANT_B]: { agentId: "agent-2", operations: AGENT_OPS, actions: ["create", "read", "update", "delete"] },
    [GRANT_ALL]: { agentId: "agent-1", operations: MARKETPLACE_MANIFEST.operations.map((operation) => operation.id), actions: ["create", "read", "update", "delete"] },
  };
  const portalRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const portalReplies = new Map<string, () => Response>();
  const portalFetch: typeof fetch = async (url, init) => {
    const target = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    portalRequests.push({ url: target, body });
    if (target.endsWith("/api/runtime/app-grant/introspect")) {
      const grant = grants[String(body.token)];
      if (!grant) return new Response(JSON.stringify({ error: "app_grant_denied" }), { status: 403 });
      return new Response(
        JSON.stringify({
          authorized: true,
          principalId: `tealbrick-agent:${grant.agentId}`,
          agentId: grant.agentId,
          orgId: "portal-org-1",
          workspaceId: TENANT,
          deploymentId: "deployment-1",
          product: "marketplace",
          productTenantId: TENANT,
          actions: grant.actions,
          operations: grant.operations,
          capabilityRevision: 1,
          expiresAt: Date.now() + 600_000,
          ...(input.approvalTrusted !== undefined ? { approvalTrusted: input.approvalTrusted } : {}),
        }),
        { status: 200 },
      );
    }
    for (const [suffix, reply] of portalReplies) {
      if (target.endsWith(suffix)) return reply();
    }
    return new Response("{}", { status: 404 });
  };
  const logs: string[] = [];
  const operatorSessions =
    input.options?.operatorSessionManager ?? new MarketplaceOperatorSessionManager({ allowUnauthenticated: true, organizationId: TENANT, operatorId: "operator-1" });
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: TENANT,
    allowUnauthenticatedOperator: true,
    operatorSessionManager: operatorSessions,
    environment: {
      NODE_ENV: "test",
      MARKETPLACE_ORGANIZATION_ID: TENANT,
      MARKETPLACE_PORTAL_URL: `${PORTAL}/`,
      MARKETPLACE_PORTAL_INSTANCE_TOKEN: PROOF,
      MARKETPLACE_PORTAL_DEPLOYMENT_ID: "deployment-1",
      MARKETPLACE_PORTAL_ORG_ID: "portal-org-1",
      MARKETPLACE_PORTAL_WORKSPACE_ID: TENANT,
      MARKETPLACE_PUBLIC_ORIGIN: "https://marketplace.fixture.invalid",
      MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: TELEGRAM_TOKEN,
      MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: DISCORD_TOKEN,
      ...input.environment,
    },
    portalFetch,
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    channelProviders: { telegram: telegram.provider, discord: discord.provider },
    channelScheduler: false,
    channelClock: () => new Date(clock),
    ...(input.verifier ? { ownerApprovalVerifier: input.verifier } : {}),
    ...(input.ownerPin ? { ownerPinSource: seededPin({ portalIssuer: PORTAL }) } : {}),
    ...input.options,
  });
  const runtime = channelRuntimeOf(app);
  await runtime.ready;

  const owner = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers });
  let ownerKey = 0;
  const createChannel = async (create: {
    provider?: ChannelProviderId;
    slug: string;
    externalId?: string;
    policy?: Record<string, unknown>;
  }) => {
    const provider = create.provider ?? "telegram";
    const discovered = await owner("GET", `/api/marketplace/channels/discover?provider=${provider}`);
    if (discovered.statusCode !== 200) throw new Error(discovered.body);
    const destination = (discovered.json().destinations as ChannelDestination[])[create.externalId ? discovered.json().destinations.findIndex((entry: ChannelDestination) => entry.externalId === create.externalId) : 0]!;
    ownerKey += 1;
    const created = await owner(
      "POST",
      "/api/marketplace/channels",
      {
        provider,
        slug: create.slug,
        label: `Label ${create.slug}`,
        destination: { externalId: destination.externalId, ...(destination.parentId ? { parentId: destination.parentId } : {}) },
        purpose: "Community announcements",
        policy: create.policy ?? {
          standingGrants: "allowed",
          caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true },
          content: { files: { types: ["png", "audio/ogg", "audio/mpeg"] }, denyPatterns: ["forbidden-term"] },
        },
      },
      { "idempotency-key": `owner-create-${String(ownerKey).padStart(4, "0")}` },
    );
    if (created.statusCode !== 201) throw new Error(created.body);
    return created.json().channel as { id: string; slug: string; connectionId: string; provider: string; revision: number };
  };

  /** Strict owner writes: the pinned owner's own Portal launch session (cookie + CSRF), as the owner UI sends them. */
  let ownerSessionCache: { cookie: string; csrf: string } | null = null;
  let launchCounter = 0;
  const ownerWrite = async (method: "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
    if (!ownerSessionCache) {
      portalReplies.set("/api/deployment-browser/redeem", () =>
        new Response(
          JSON.stringify({
            schema: 1,
            authorized: true,
            product: "marketplace",
            deploymentId: "deployment-1",
            workspaceId: TENANT,
            orgId: "portal-org-1",
            productTenantId: TENANT,
            userId: "owner-1",
            endpoint: "https://marketplace.fixture.invalid",
            session: "s".repeat(43),
            expiresAt: Date.now() + 3_600_000,
          }),
          { status: 200 },
        ),
      );
      const launched = await app.inject({
        method: "POST",
        url: "/auth/launch",
        headers: { origin: PORTAL, "content-type": "application/x-www-form-urlencoded" },
        payload: `ticket=${String(++launchCounter).padStart(6, "0")}${"w".repeat(37)}`,
      });
      if (launched.statusCode !== 303) throw new Error(launched.body);
      const cookie = String(launched.headers["set-cookie"]).split(";", 1)[0]!;
      const current = await app.inject({ method: "GET", url: "/api/marketplace/auth/session", headers: { cookie } });
      ownerSessionCache = { cookie, csrf: current.json().session.csrfToken as string };
    }
    return app.inject({
      method,
      url,
      headers: { origin: "http://localhost:5173", cookie: ownerSessionCache.cookie, "x-csrf-token": ownerSessionCache.csrf },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  };

  let consentCounter = 0;
  const consentFor = (agentId: string, channel: { slug: string; connectionId: string; provider: string }, grantClass: "outward" | "read" = "outward") => {
    consentCounter += 1;
    return store.createMarketplaceAgentConsent({
      portalIssuer: PORTAL,
      portalOrgId: "portal-org-1",
      productTenantId: TENANT,
      workspaceId: TENANT,
      deploymentId: "deployment-1",
      userId: "owner-1",
      agentId,
      consentId: `consent-${agentId}-${consentCounter}`,
      consentRevision: 1,
      pluginId: `channels-${channel.provider}`,
      actionKey: `class:${grantClass}`,
      capability: (grantClass === "outward" ? "connector.dispatch" : "connector.observe") as ConnectorCapability,
      connectionId: channel.connectionId,
      accountId: channel.connectionId,
      resourceKind: `${channel.provider}.connected-account`,
      resourceRef: `account:${channel.connectionId}`,
      capabilities: [`connector.class.${grantClass}`] as unknown as ConnectorCapability[],
      requiredActions: grantClass === "outward" ? ["read", "create"] : ["read"],
      metadata: { selectionKind: "class", grantClass, actionGroup: `channel:${channel.slug}` },
    }).consent;
  };

  const agent = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    input: { payload?: unknown; key?: string | null; token?: string; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${input.token ?? GRANT_A}`,
        ...(input.key ? { "idempotency-key": input.key } : {}),
        ...(input.headers ?? {}),
      },
      ...(input.payload !== undefined ? { payload: input.payload as Record<string, unknown> } : {}),
    });

  const post = (channelId: string, body: Record<string, unknown>, key: string, token = GRANT_A) =>
    agent("POST", `/api/marketplace/v1/agent/channels/${channelId}/posts`, { payload: body, key, token });

  const proposeAndApprove = async (channelId: string, terms: Record<string, unknown> = {}, token = GRANT_A) => {
    const proposed = await agent("POST", `/api/marketplace/v1/agent/channels/${channelId}/grants`, {
      key: `grant-${Math.random().toString(36).slice(2, 12)}`,
      token,
      payload: {
        purpose: "weekly meetup announce, reminder and recap",
        caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true },
        scope: { files: {}, immediate: true, scheduled: true },
        expires: new Date(clock + 30 * 86_400_000).toISOString(),
        ...terms,
      },
    });
    if (proposed.statusCode !== 201) throw new Error(proposed.body);
    const grantId = proposed.json().grant.id as string;
    const approved = await owner("POST", `/api/marketplace/channels/grants/${grantId}/approve`, {});
    if (approved.statusCode !== 200) throw new Error(approved.body);
    return approved.json().grant as { id: string; status: string; digest: string };
  };

  return {
    root,
    app,
    store,
    telegram,
    discord,
    runtime,
    logs,
    /** The operator session manager (test bypass for plain owner calls; real Portal launch sessions for owner-only state). */
    operatorSessions,
    portalRequests,
    portalReplies,
    owner,
    ownerWrite,
    agent,
    post,
    createChannel,
    consentFor,
    proposeAndApprove,
    get now() {
      return clock;
    },
    advance(ms: number) {
      clock += ms;
    },
    setClock(ms: number) {
      clock = ms;
    },
    async close() {
      await app.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

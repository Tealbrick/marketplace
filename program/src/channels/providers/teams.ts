import { applyFallbacks } from "./capabilities.js";
import {
  asRecord,
  classifyFailure,
  guard,
  httpRequest,
  isSuccess,
  refuse,
  resolveRuntime,
  sanitizeText,
  scrubSecrets,
  validateOutbound,
  type HttpResult,
} from "./common.js";
import { MAX_RETRY_AFTER_SECONDS, createRateLimiter, retryAfterSeconds, type RateRule } from "./rate.js";
import {
  BOT_FRAMEWORK_SCOPE,
  GRAPH_SCOPE,
  GUID,
  createTokenCache,
  isAllowedServiceUrl,
  serviceBase,
  type TeamsCredential,
  type TokenCache,
} from "./teams-auth.js";
import {
  CHANNEL_CAPABILITIES_VERSION,
  type ChannelCapabilities,
  type ChannelDestination,
  type ChannelProvider,
  type ChannelProviderOptions,
  type ActionResult,
  type DiscoverResult,
  type FindPersonResult,
  type InboundMessage,
  type OpenDirectResult,
  type PersonQuery,
  type OutboundMention,
  type OutboundMessage,
  type SendResult,
  type VerifyResult,
} from "./types.js";

// Microsoft Teams adapter: Bot Framework REST (the transport under the Teams SDK), single-tenant Azure Bot.
// Not Graph chatMessage send (application send through Graph is for migration only).
// Proactive messages need a stored conversation reference (serviceUrl, conversation id, tenant id) that the
// messaging endpoint captures when the app is installed; the adapter reads it from `conversations`.
// Docs: https://learn.microsoft.com/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages

/** Teams caps one bot message at about 100 KB; text is refused above this many characters (never cut). */
export const TEAMS_MAX_TEXT_CHARS = 28_000;
/** Activity JSON bytes Marketplace sends at most (Teams limit: about 100 KB per message). */
export const TEAMS_MAX_ACTIVITY_BYTES = 100_000;
export const TEAMS_MAX_MENTIONS = 20;

/**
 * Per bot per conversation ("thread"): 7 per 1 s, 8 per 2 s, 60 per 30 s, 1800 per hour; 50 requests per second
 * per app per tenant. Docs: https://learn.microsoft.com/microsoftteams/platform/bots/how-to/rate-limit
 */
export const TEAMS_THREAD_RULES: readonly RateRule[] = [
  { name: "1s", capacity: 7, refillPerSecond: 7 },
  { name: "2s", capacity: 8, refillPerSecond: 4 },
  { name: "30s", capacity: 60, refillPerSecond: 2 },
  { name: "3600s", capacity: 1800, refillPerSecond: 0.5 },
];
export const TEAMS_TENANT_RULE: RateRule = { name: "tenant-1s", capacity: 50, refillPerSecond: 50 };

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// Conversation ids: `19:…@thread.tacv2`, `19:…@thread.v2`, `a:…` (personal). A `;messageid=` suffix is refused:
// thread replies are addressed with `replyTo`.
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9:@._=+-]{2,255}$/u;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9:@._=-]{0,199}$/u;
// A mention target: a Teams user id (`29:…`) or a Microsoft Entra object id. Never a conversation, team or tag.
const TEAMS_USER_ID = /^29:[A-Za-z0-9_-]{1,200}$/u;
const MENTION_NAME = /^[^<>&\p{Cc}​-‏‪-‮⁦-⁩﻿]{1,80}$/u;
// Case-insensitive: Teams treats `<AT>` like `<at>`, so an undeclared tag in any case is refused.
const AT_TAG = /<at\b[^>]*>([\s\S]*?)<\/at\s*>/giu;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/u;
const SECRET_SHAPE = /^[\x21-\x7e]{8,512}$/u;

// ---------------------------------------------------------------- Credential

/** The three hosted values as one opaque credential string (the runtime composes it; it never leaves the server). */
export function encodeTeamsCredential(credential: TeamsCredential): string {
  return JSON.stringify({ appId: credential.appId, appSecret: credential.appSecret, tenantId: credential.tenantId });
}

export function parseTeamsCredential(
  value: string | null | undefined,
): { ok: true; credential: TeamsCredential } | { ok: false; reason: "credential_missing" | "credential_invalid" } {
  if (!value?.trim()) return { ok: false, reason: "credential_missing" };
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(value));
  } catch {
    return { ok: false, reason: "credential_invalid" };
  }
  const appId = typeof parsed?.appId === "string" ? parsed.appId.trim() : "";
  const appSecret = typeof parsed?.appSecret === "string" ? parsed.appSecret.trim() : "";
  const tenantId = typeof parsed?.tenantId === "string" ? parsed.tenantId.trim() : "";
  if (!appId || !appSecret || !tenantId) return { ok: false, reason: "credential_missing" };
  if (!GUID.test(appId) || !GUID.test(tenantId) || !SECRET_SHAPE.test(appSecret)) return { ok: false, reason: "credential_invalid" };
  return { ok: true, credential: { appId: appId.toLowerCase(), appSecret, tenantId: tenantId.toLowerCase() } };
}

// ---------------------------------------------------------------- Conversation references

export type TeamsConversationType = "channel" | "groupChat" | "personal";
export type TeamsMembership = "standard" | "private" | "shared";

/** A stored conversation reference (captured by the messaging endpoint). Titles are untrusted and cleaned. */
export type TeamsConversationRef = {
  conversationId: string;
  type: TeamsConversationType;
  teamId?: string;
  channelId?: string;
  teamName: string;
  title: string;
  membership: TeamsMembership;
  serviceUrl: string;
  tenantId: string;
};

/** Read and write access to the stored references of this workspace (`channel_teams_conversation`). */
export type TeamsConversationSource = {
  /** Active references (installed, not removed). */
  list(): TeamsConversationRef[];
  get(conversationId: string): TeamsConversationRef | null;
  /** Any active reference in this team (for its serviceUrl and tenant). */
  forTeam(teamId: string): TeamsConversationRef | null;
  /** Any active reference in this tenant (a serviceUrl to open a 1:1 chat with). */
  forTenant(tenantId: string): TeamsConversationRef | null;
  upsert(ref: TeamsConversationRef): void;
};

const EMPTY_SOURCE: TeamsConversationSource = {
  list: () => [],
  get: () => null,
  forTeam: () => null,
  forTenant: () => null,
  upsert: () => undefined,
};

export type TeamsProviderOptions = ChannelProviderOptions & {
  conversations?: TeamsConversationSource;
  /** Graph user lookup (User.Read.All, application) is configured: declares `dm.open`, enables findPerson/openDirect. */
  graphEnabled?: boolean;
  /** Jitter source for retry backoff, in [0, 1). */
  random?: () => number;
};

// ---------------------------------------------------------------- Capabilities

export function teamsCapabilities(graphEnabled: boolean): ChannelCapabilities {
  return {
    channelCapabilities: CHANNEL_CAPABILITIES_VERSION,
    text: { maxChars: TEAMS_MAX_TEXT_CHARS },
    markup: "teams-markdown",
    // Named users through `<at>Name</at>` plus a mention entity; no @team, @channel or tag mention is ever sent.
    mentions: { users: true, broadcast: "suppressed" },
    dm: { open: graphEnabled, maxMembers: graphEnabled ? 1 : 0 },
    // Channel files need SharePoint and Graph; personal files need the consent card flow. Neither is in this PR.
    image: false,
    file: false,
    audio: false,
    voice: false,
    video: false,
    thread: { replies: true, topics: false, forum: false },
    // Bot-added reactions are not documented for Teams.
    reactions: { add: false, remove: false, custom: false },
    buttons: { url: false, callback: false },
    poll: false,
    edit: { own: true },
    delete: { own: true },
    canvas: false,
    presence: { typing: false, status: false },
    ephemeral: false,
    live: false,
    schedule: { native: false },
    events: { create: false },
    discover: "list",
    // The messaging endpoint stores conversation references; received messages reach no agent yet.
    inbound: { mode: "none", dedupe: false },
    audience: { count: false },
    limits: { perChatPerSecond: 7, perChatPerMinute: 120, retryAfter: "honoured" },
  };
}

// ---------------------------------------------------------------- Pure helpers

/** `Group chat: <name>` (or the bare kind), never a double prefix. */
function kindTitle(kind: "Group chat" | "Direct chat", title: string): string {
  const name = title.startsWith(`${kind}: `) ? title.slice(kind.length + 2) : title === kind ? "" : title;
  return sanitizeText(name ? `${kind}: ${name}` : kind);
}

function teamsMessage(json: unknown): unknown {
  const record = asRecord(json);
  if (!record) return undefined;
  const error = asRecord(record.error);
  const code = typeof error?.code === "string" ? error.code : typeof record.errorCode === "string" ? record.errorCode : "";
  const message = typeof error?.message === "string" ? error.message : typeof record.message === "string" ? record.message : "";
  return `${code}${code && message ? ": " : ""}${message}`.trim() || undefined;
}

/** Deep link to a channel message (the root post, or a reply under `parentId`). */
export function teamsMessageUrl(input: { channelId: string; messageId: string; tenantId: string; parentId?: string }): string {
  const parent = input.parentId ?? input.messageId;
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(input.channelId)}/${encodeURIComponent(input.messageId)}?tenantId=${encodeURIComponent(input.tenantId)}&parentMessageId=${encodeURIComponent(parent)}`;
}

/**
 * Pure: the mention entities for a post, or a refusal. Each mention needs `<at>name</at>` in the text, exactly
 * once or more; every `<at>…</at>` in the text must be a declared mention. Only Teams user ids (`29:…`) and
 * Entra object ids are accepted, so a team, channel or tag can never be mentioned.
 */
export function teamsMentionEntities(
  text: string,
  mentions: readonly OutboundMention[] | undefined,
): { ok: true; entities: Array<Record<string, unknown>> } | { ok: false; errorCode: string; detail: string } {
  const list = mentions ?? [];
  if (list.length > TEAMS_MAX_MENTIONS) return { ok: false, errorCode: "channel_mention_invalid", detail: `at most ${TEAMS_MAX_MENTIONS} mentions per message` };
  const names = new Set<string>();
  const entities: Array<Record<string, unknown>> = [];
  for (const mention of list) {
    const userId = typeof mention?.userId === "string" ? mention.userId : "";
    // Teams renders a mention from its text: the display name is required here (optional in the shared type).
    const name = typeof mention?.name === "string" ? mention.name : "";
    if (!(TEAMS_USER_ID.test(userId) || GUID.test(userId))) {
      return { ok: false, errorCode: "channel_mention_invalid", detail: "a mention needs a Teams user id (29:…) or a Microsoft Entra object id" };
    }
    if (!MENTION_NAME.test(name) || name.trim() !== name) {
      return { ok: false, errorCode: "channel_mention_invalid", detail: "a mention name must be 1-80 characters of plain text without < > &" };
    }
    const tag = `<at>${name}</at>`;
    if (!text.includes(tag)) return { ok: false, errorCode: "channel_mention_invalid", detail: "each mention must appear in the text as <at>name</at>" };
    if (names.has(name)) return { ok: false, errorCode: "channel_mention_invalid", detail: "two mentions have the same name" };
    names.add(name);
    entities.push({ type: "mention", text: tag, mentioned: { id: userId, name } });
  }
  for (const match of text.matchAll(AT_TAG)) {
    // Only the exact lowercase form of a declared mention may appear; any other <at …> tag is refused.
    if (!names.has(match[1] ?? "") || match[0] !== `<at>${match[1]}</at>`) {
      return { ok: false, errorCode: "channel_mention_invalid", detail: "the text has an <at> tag without a declared mention; broadcast mentions are never sent" };
    }
  }
  return { ok: true, entities };
}

// Control characters other than newline and tab, bidi overrides and zero-width marks.
const UNSAFE_BODY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩؜﻿]/gu;

function cleanBody(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const points = Array.from(value.replace(UNSAFE_BODY, " "));
  return (points.length > max ? points.slice(0, max).join("") : points.join("")).trim();
}

function str(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function membershipOf(channel: Record<string, unknown> | undefined): TeamsMembership {
  const value = String(channel?.membershipType ?? channel?.type ?? "").toLowerCase();
  return value === "private" ? "private" : value === "shared" ? "shared" : "standard";
}

export type TeamsActivityEvent =
  | { kind: "install"; ref: TeamsConversationRef }
  | { kind: "uninstall"; conversationId?: string; teamId?: string }
  | { kind: "message"; message: InboundMessage }
  | { kind: "ignored"; reason: string };

/**
 * Pure: a verified Bot Framework activity as an install, an uninstall, a normalized inbound message or
 * nothing. Activities for another tenant, another bot, another channel or a service URL off the allowlist are
 * ignored. All text is untrusted data, cleaned and capped; nothing here is an instruction.
 */
export function parseTeamsActivity(activity: unknown, input: { appId: string; tenantId: string }): TeamsActivityEvent {
  const record = asRecord(activity);
  if (!record) return { kind: "ignored", reason: "not_an_activity" };
  if (record.channelId !== "msteams") return { kind: "ignored", reason: "not_teams" };
  if (!isAllowedServiceUrl(record.serviceUrl)) return { kind: "ignored", reason: "service_url" };
  const serviceUrl = record.serviceUrl;
  const recipient = asRecord(record.recipient);
  const botId = `28:${input.appId}`;
  if (typeof recipient?.id !== "string" || recipient.id.toLowerCase() !== botId.toLowerCase()) return { kind: "ignored", reason: "recipient" };
  const conversation = asRecord(record.conversation);
  const channelData = asRecord(record.channelData);
  const tenantId = String(conversation?.tenantId ?? asRecord(channelData?.tenant)?.id ?? "").toLowerCase();
  if (tenantId !== input.tenantId.toLowerCase()) return { kind: "ignored", reason: "tenant" };
  const rawConversationId = str(conversation?.id, /^[A-Za-z0-9][A-Za-z0-9:@._=+;-]{2,300}$/u);
  if (!rawConversationId) return { kind: "ignored", reason: "conversation" };
  const [conversationId, threadSuffix] = rawConversationId.split(";messageid=") as [string, string | undefined];
  if (!CONVERSATION_ID.test(conversationId)) return { kind: "ignored", reason: "conversation" };
  const conversationType: TeamsConversationType | undefined =
    conversation?.conversationType === "channel" ? "channel" : conversation?.conversationType === "groupChat" ? "groupChat" : conversation?.conversationType === "personal" ? "personal" : undefined;
  if (!conversationType) return { kind: "ignored", reason: "conversation_type" };
  const team = asRecord(channelData?.team);
  const channel = asRecord(channelData?.channel);
  const teamId = str(team?.id, CONVERSATION_ID);

  const refFor = (): TeamsConversationRef => {
    const teamName = sanitizeText(team?.name, 60);
    const from = asRecord(record.from);
    const conversationName = sanitizeText(conversation?.name ?? channel?.name, 80);
    const title =
      conversationType === "channel"
        ? sanitizeText(`${teamName || "Team"} / #${conversationName || (conversationId === teamId ? "General" : conversationId)}`)
        : conversationType === "groupChat"
          ? conversationName || "Group chat"
          : sanitizeText(`Direct chat: ${sanitizeText(from?.name, 80) || "person"}`);
    return {
      conversationId,
      type: conversationType,
      ...(conversationType === "channel" && teamId ? { teamId, channelId: conversationId } : {}),
      teamName,
      title,
      membership: conversationType === "channel" ? membershipOf(channel) : "standard",
      serviceUrl,
      tenantId,
    };
  };

  const membersHaveBot = (value: unknown) =>
    Array.isArray(value) && value.some((member) => typeof asRecord(member)?.id === "string" && String(asRecord(member)!.id).toLowerCase() === botId.toLowerCase());

  if (record.type === "installationUpdate") {
    const action = record.action;
    if (action === "add" || action === "add-upgrade") return { kind: "install", ref: refFor() };
    if (action === "remove" || action === "remove-upgrade") {
      return conversationType === "channel" && teamId ? { kind: "uninstall", teamId } : { kind: "uninstall", conversationId };
    }
    return { kind: "ignored", reason: "installation_action" };
  }
  if (record.type === "conversationUpdate") {
    const eventType = channelData?.eventType;
    if (membersHaveBot(record.membersRemoved) || eventType === "teamDeleted") {
      return conversationType === "channel" && teamId ? { kind: "uninstall", teamId } : { kind: "uninstall", conversationId };
    }
    if (eventType === "channelDeleted") {
      const deleted = str(channel?.id, CONVERSATION_ID);
      return deleted ? { kind: "uninstall", conversationId: deleted } : { kind: "ignored", reason: "channel" };
    }
    if (membersHaveBot(record.membersAdded)) return { kind: "install", ref: refFor() };
    return { kind: "ignored", reason: "conversation_update" };
  }
  if (record.type === "message") {
    const from = asRecord(record.from);
    const senderUserId = str(from?.id, /^[A-Za-z0-9][A-Za-z0-9:._-]{1,200}$/u);
    const messageId = str(record.id, MESSAGE_ID);
    if (!senderUserId || !messageId) return { kind: "ignored", reason: "message_shape" };
    if (senderUserId.toLowerCase() === botId.toLowerCase()) return { kind: "ignored", reason: "own_message" };
    // Other bots (role "bot", or a Bot Framework `28:` id) never reach a bridge: no bot-to-bot loops or relays.
    if (from?.role === "bot" || senderUserId.startsWith("28:")) return { kind: "ignored", reason: "bot_message" };
    const threadId = str(threadSuffix, MESSAGE_ID) ?? str(record.replyToId, MESSAGE_ID);
    const attachments = (Array.isArray(record.attachments) ? record.attachments : [])
      .map((raw) => asRecord(raw))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined && typeof entry.contentType === "string" && entry.contentType !== "text/html")
      .slice(0, 10)
      // Metadata only (the shared shape): Teams gives no attachment id or size, so the id is positional and
      // `bytes` is 0 (unknown). Content URLs are not kept; bytes are never fetched by the parser.
      .map((entry, index) => ({
        id: `${messageId}:${index}`,
        name: sanitizeText(entry.name, 100) || "attachment",
        contentType: sanitizeText(entry.contentType, 100),
        bytes: 0,
      }));
    return {
      kind: "message",
      message: {
        platform: "teams",
        channelId: conversationId,
        ...(threadId ? { threadId } : {}),
        messageId,
        senderUserId,
        senderDisplay: sanitizeText(from?.name, 80),
        text: cleanBody(record.text, TEAMS_MAX_TEXT_CHARS),
        attachments,
      },
    };
  }
  return { kind: "ignored", reason: "activity_type" };
}

// ---------------------------------------------------------------- Adapter

type Checked = { ok: true; credential: TeamsCredential } | { ok: false; reason: "credential_missing" | "credential_invalid" };

export function createTeamsProvider(options: TeamsProviderOptions = {}): ChannelProvider {
  const runtime = resolveRuntime(options);
  const limiter = createRateLimiter({ now: runtime.now, sleep: runtime.sleep });
  const tokens: TokenCache = createTokenCache(runtime);
  const conversations = options.conversations ?? EMPTY_SOURCE;
  const graphEnabled = options.graphEnabled === true;
  const random = options.random ?? Math.random;
  const capabilities = teamsCapabilities(graphEnabled);

  const backoffMs = () => 1000 + Math.floor(Math.max(0, Math.min(0.999, random())) * 1000);

  /**
   * One request with the Teams retry rules: 429 waits for Retry-After (at most 30 s; a jittered second when
   * absent) and runs once more; 412 runs once more after a jittered backoff (the request was refused, nothing
   * was posted); 502/504 run once more only for idempotent calls (PUT, DELETE, create-conversation). A 401
   * renews the access token once (the request was refused).
   */
  async function call(
    credential: TeamsCredential,
    scope: string,
    url: string,
    init: { method: string; body?: unknown; idempotent: boolean },
  ): Promise<HttpResult | { kind: "token"; reason: "credential_invalid" | "provider_unavailable" }> {
    let renewed = false;
    let retried = false;
    for (;;) {
      const token = await tokens.get(credential, scope);
      if (!token.ok) return { kind: "token", reason: token.reason };
      const result = await httpRequest(runtime, url, {
        method: init.method,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        headers: {
          authorization: `Bearer ${token.token}`,
          ...(init.body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
      });
      if (result.kind !== "response") return result;
      if (result.status === 401 && !renewed) {
        renewed = true;
        tokens.invalidate(credential, scope);
        continue;
      }
      if (retried) return result;
      if (result.status === 429) {
        const seconds = retryAfterSeconds(result);
        if (seconds !== undefined && seconds > MAX_RETRY_AFTER_SECONDS) return result;
        retried = true;
        await runtime.sleep(seconds !== undefined ? Math.ceil(seconds * 1000) : backoffMs());
        continue;
      }
      if (result.status === 412 || (init.idempotent && (result.status === 502 || result.status === 504))) {
        retried = true;
        await runtime.sleep(backoffMs());
        continue;
      }
      return result;
    }
  }

  const checkCredential = (credential: string | null | undefined): Checked => parseTeamsCredential(credential);
  const secretsOf = (credential: TeamsCredential) => [credential.appSecret];
  const tokenFailure = (reason: "credential_invalid" | "provider_unavailable") =>
    reason === "credential_invalid"
      ? { status: "failed" as const, errorCode: "credential_invalid", detail: "Microsoft Entra rejected the Teams app credential" }
      : { status: "failed" as const, errorCode: "provider_unavailable", detail: "Microsoft Entra did not issue a token; nothing was sent" };

  function failureOf(result: HttpResult | { kind: "token"; reason: "credential_invalid" | "provider_unavailable" }, credential: TeamsCredential) {
    if (result.kind === "token") return tokenFailure(result.reason);
    const failure = classifyFailure(result, { secrets: secretsOf(credential), message: teamsMessage, notFound: "provider_not_found" });
    return { status: failure.status, errorCode: failure.errorCode, detail: scrubSecrets(failure.detail, secretsOf(credential)) };
  }

  async function reserve(conversationId: string, tenantId: string): Promise<{ ok: true } | { ok: false; waitMs: number }> {
    const thread = await limiter.acquire(`teams:${conversationId}`, TEAMS_THREAD_RULES);
    if (!thread.ok) return thread;
    return limiter.acquire(`teams-tenant:${tenantId}`, [TEAMS_TENANT_RULE]);
  }

  /** The stored reference a destination is sent through, or a refusal. Private and shared channels are refused. */
  function resolveRef(destination: ChannelDestination, credential: TeamsCredential): { ref: TeamsConversationRef } | { refusal: SendResult } {
    if (!CONVERSATION_ID.test(destination.externalId) || (destination.parentId !== undefined && !CONVERSATION_ID.test(destination.parentId))) {
      return { refusal: refuse("channel_destination_invalid", "the Teams conversation or team id is invalid") };
    }
    let ref = conversations.get(destination.externalId);
    if (!ref && destination.type === "channel" && destination.parentId) {
      const teamRef = conversations.forTeam(destination.parentId);
      if (teamRef) {
        ref = { ...teamRef, conversationId: destination.externalId, channelId: destination.externalId, title: destination.title, membership: "standard" };
      }
    }
    if (!ref) {
      return { refusal: refuse("channel_destination_unknown", "the Teams app is not installed in this conversation; install it, then discover again") };
    }
    if (ref.membership !== "standard") {
      return { refusal: refuse("channel_capability_unavailable", "bots cannot post in Teams private or shared channels") };
    }
    if (ref.tenantId !== credential.tenantId || !isAllowedServiceUrl(ref.serviceUrl)) {
      return { refusal: refuse("channel_destination_invalid", "the stored Teams conversation reference does not belong to this bot") };
    }
    return { ref };
  }

  async function verify(credential: string | null | undefined): Promise<VerifyResult> {
    const checked = checkCredential(credential);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const token = await tokens.get(checked.credential, BOT_FRAMEWORK_SCOPE);
    if (!token.ok) return { ok: false, reason: token.reason };
    return { ok: true, botId: `28:${checked.credential.appId}`, botUsername: "" };
  }

  async function discover(credential: string | null | undefined): Promise<DiscoverResult> {
    const checked = checkCredential(credential);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const refs = conversations.list().filter((ref) => ref.tenantId === checked.credential.tenantId && isAllowedServiceUrl(ref.serviceUrl));
    const destinations: ChannelDestination[] = [];
    const seen = new Set<string>();
    let excluded = 0;
    const add = (destination: ChannelDestination) => {
      if (seen.has(destination.externalId)) return;
      seen.add(destination.externalId);
      destinations.push(destination);
    };

    const teams = new Map<string, TeamsConversationRef[]>();
    for (const ref of refs) {
      if (ref.type === "channel" && ref.teamId) teams.set(ref.teamId, [...(teams.get(ref.teamId) ?? []), ref]);
    }
    for (const [teamId, teamRefs] of teams) {
      const base = teamRefs[0]!;
      const teamName = base.teamName || "Team";
      const result = await call(checked.credential, BOT_FRAMEWORK_SCOPE, `${serviceBase(base.serviceUrl)}/v3/teams/${encodeURIComponent(teamId)}/conversations`, {
        method: "GET",
        idempotent: true,
      });
      if (result.kind === "token") return { ok: false, reason: result.reason };
      if (result.kind === "response" && result.status === 401) return { ok: false, reason: "credential_invalid" };
      if (result.kind === "response" && (result.status === 403 || result.status === 404)) continue; // the bot left this team
      const listed = result.kind === "response" && isSuccess(result) ? asRecord(result.json)?.conversations : undefined;
      if (!Array.isArray(listed)) {
        // The live channel list is unavailable: offer only the channels the install events stored.
        for (const ref of teamRefs) {
          if (ref.membership !== "standard") {
            excluded += 1;
            continue;
          }
          add({ type: "channel", externalId: ref.conversationId, title: ref.title, parentId: teamId });
        }
        continue;
      }
      for (const raw of listed.slice(0, 500)) {
        const channel = asRecord(raw);
        const channelId = str(channel?.id, CONVERSATION_ID);
        if (!channel || !channelId) continue;
        const stored = teamRefs.find((ref) => ref.conversationId === channelId);
        if (membershipOf(channel) !== "standard" || (stored && stored.membership !== "standard")) {
          excluded += 1;
          continue;
        }
        // The General channel's name is null (localised by the client); its id is the team id.
        const name = sanitizeText(channel.name, 80) || (channelId === teamId ? "General" : channelId);
        add({ type: "channel", externalId: channelId, title: sanitizeText(`${teamName} / #${name}`), parentId: teamId });
      }
    }
    // A chat's name is free text that can imitate "Team / #channel": the title always starts with its kind.
    for (const ref of refs) {
      if (ref.type === "groupChat") add({ type: "group", externalId: ref.conversationId, title: kindTitle("Group chat", ref.title) });
      if (ref.type === "personal") add({ type: "person", externalId: ref.conversationId, title: kindTitle("Direct chat", ref.title) });
    }
    return {
      ok: true,
      destinations,
      ...(excluded > 0 ? { notes: [`${excluded} private or shared channel(s) not listed: Teams bots cannot post there.`] } : {}),
    };
  }

  async function send(credential: string | null | undefined, destination: ChannelDestination, message: OutboundMessage): Promise<SendResult> {
    const checked = checkCredential(credential);
    if (!checked.ok) {
      return refuse(checked.reason, checked.reason === "credential_missing" ? "no Microsoft Teams app credential is configured" : "the Microsoft Teams app credential has an invalid shape");
    }
    const resolved = resolveRef(destination, checked.credential);
    if ("refusal" in resolved) return resolved.refusal;
    const { ref } = resolved;
    const post = applyFallbacks(capabilities, { text: message.text, attachments: message.attachments ?? [] });
    if ("error" in post) return refuse(post.error.errorCode, post.error.detail);
    const refusal = validateOutbound({ text: post.text, attachments: post.attachments, caps: capabilities });
    if (refusal) return refusal;
    if (post.text.trim().length === 0) return refuse("channel_message_empty", "a Teams message needs text");
    const mentions = teamsMentionEntities(post.text, message.mentions);
    if (!mentions.ok) return refuse(mentions.errorCode, mentions.detail);
    const replyTo = message.replyTo;
    if (replyTo !== undefined) {
      if (typeof replyTo !== "string" || !MESSAGE_ID.test(replyTo)) return refuse("channel_reply_invalid", "the message id to reply to is invalid");
      if (ref.type !== "channel") return refuse("channel_capability_unavailable", "Teams thread replies exist only in channels");
    }
    const activity = {
      type: "message",
      text: post.text,
      textFormat: "markdown",
      ...(mentions.entities.length > 0 ? { entities: mentions.entities } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(activity), "utf8") > TEAMS_MAX_ACTIVITY_BYTES) {
      return refuse("channel_text_too_long", `the Teams message is larger than ${TEAMS_MAX_ACTIVITY_BYTES} bytes`);
    }
    const slot = await reserve(ref.conversationId, ref.tenantId);
    if (!slot.ok) {
      return refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`);
    }
    const path = `${serviceBase(ref.serviceUrl)}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities${replyTo ? `/${encodeURIComponent(replyTo)}` : ""}`;
    const result = await call(checked.credential, BOT_FRAMEWORK_SCOPE, path, { method: "POST", body: activity, idempotent: false });
    if (result.kind === "token" || !isSuccess(result)) {
      const failure = failureOf(result, checked.credential);
      return { status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail };
    }
    const id = str(asRecord(result.json)?.id, MESSAGE_ID);
    if (!id) {
      return {
        status: "uncertain",
        resultIds: [],
        resultUrls: [],
        errorCode: "provider_bad_response",
        detail: "the provider answered success but the reply was not understood; delivery is unknown",
      };
    }
    return {
      status: "sent",
      resultIds: [id],
      resultUrls:
        ref.type === "channel"
          ? [teamsMessageUrl({ channelId: ref.conversationId, messageId: id, tenantId: ref.tenantId, ...(replyTo ? { parentId: replyTo } : {}) })]
          : [],
    };
  }

  type ActionOutcome = { status: ActionResult["status"]; errorCode?: string; detail?: string };

  // TODO(channels-p2 wiring): callers of edit/remove MUST check `messageId` against the post ledger
  // (a `resultIds` entry of a sent receipt on this channel) before calling. Teams itself refuses another
  // sender's activity, but the adapter cannot tell which of the bot's own messages an agent may change.
  async function messageAction(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    method: "PUT" | "DELETE",
    edit?: { text: string; mentions?: readonly OutboundMention[] },
  ): Promise<ActionOutcome> {
    const checked = checkCredential(credential);
    if (!checked.ok) return { status: "failed", errorCode: checked.reason, detail: "the Microsoft Teams app credential is missing or invalid" };
    if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return { status: "failed", errorCode: "channel_message_invalid", detail: "the message id is invalid" };
    const resolved = resolveRef(destination, checked.credential);
    if ("refusal" in resolved) return { status: "failed", errorCode: resolved.refusal.errorCode!, detail: resolved.refusal.detail! };
    const { ref } = resolved;
    let body: Record<string, unknown> | undefined;
    if (method === "PUT") {
      const value = typeof edit?.text === "string" ? edit.text : "";
      if (value.trim().length === 0) return { status: "failed", errorCode: "channel_message_empty", detail: "an edit needs text" };
      if (value.length > TEAMS_MAX_TEXT_CHARS) {
        return { status: "failed", errorCode: "channel_text_too_long", detail: `text is ${value.length} characters; this provider allows ${TEAMS_MAX_TEXT_CHARS}` };
      }
      // The same mention rules as a post: named users only, every <at> tag declared.
      const mentions = teamsMentionEntities(value, edit?.mentions);
      if (!mentions.ok) return { status: "failed", errorCode: mentions.errorCode, detail: mentions.detail };
      body = { type: "message", id: messageId, text: value, textFormat: "markdown", ...(mentions.entities.length > 0 ? { entities: mentions.entities } : {}) };
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > TEAMS_MAX_ACTIVITY_BYTES) {
        return { status: "failed", errorCode: "channel_text_too_long", detail: `the Teams message is larger than ${TEAMS_MAX_ACTIVITY_BYTES} bytes` };
      }
    }
    const slot = await reserve(ref.conversationId, ref.tenantId);
    if (!slot.ok) return { status: "failed", errorCode: "provider_rate_limited", detail: `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s` };
    const result = await call(
      checked.credential,
      BOT_FRAMEWORK_SCOPE,
      `${serviceBase(ref.serviceUrl)}/v3/conversations/${encodeURIComponent(ref.conversationId)}/activities/${encodeURIComponent(messageId)}`,
      { method, ...(body ? { body } : {}), idempotent: true },
    );
    if (result.kind !== "token" && isSuccess(result)) return { status: "sent" };
    return failureOf(result, checked.credential);
  }

  async function edit(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    message: { text: string; mentions?: readonly OutboundMention[] },
  ): Promise<SendResult> {
    const outcome = await messageAction(credential, destination, messageId, "PUT", message);
    return outcome.status === "sent"
      ? { status: "sent", resultIds: [messageId], resultUrls: [] }
      : { status: outcome.status, resultIds: [], resultUrls: [], ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}), ...(outcome.detail ? { detail: outcome.detail } : {}) };
  }

  const personFailed = (errorCode: string, detail: string): FindPersonResult => ({ ok: false, reason: "failed", errorCode, detail });

  async function findPerson(credential: string | null | undefined, query: PersonQuery): Promise<FindPersonResult> {
    if (!graphEnabled) return personFailed("channel_capability_unavailable", "Microsoft Graph user lookup is not configured");
    const checked = checkCredential(credential);
    if (!checked.ok) return personFailed(checked.reason, "the Microsoft Teams app credential is missing or invalid");
    if ((query?.email === undefined) === (query?.handle === undefined)) return personFailed("person_query_invalid", "ask by exactly one of email or handle");
    // Teams has no handles; a handle is accepted only as a user principal name (an email-shaped sign-in name).
    const value = (query.email ?? query.handle ?? "").trim();
    if (!EMAIL.test(value)) return personFailed("person_query_invalid", "Teams finds a person only by an exact email or user principal name");
    const filter = `mail eq '${value}' or userPrincipalName eq '${value}'`;
    const url = `${GRAPH_BASE}/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName&$top=2`;
    const result = await call(checked.credential, GRAPH_SCOPE, url, { method: "GET", idempotent: true });
    if (result.kind === "token") return personFailed(tokenFailure(result.reason).errorCode, tokenFailure(result.reason).detail.replace("; nothing was sent", ""));
    if (result.kind === "response" && result.status === 403) {
      return personFailed("provider_forbidden", "the app needs the Microsoft Graph application permission User.Read.All with admin consent");
    }
    if (!isSuccess(result)) {
      const failure = failureOf(result, checked.credential);
      return personFailed(failure.errorCode, failure.detail.replace(/; delivery is unknown$/u, ""));
    }
    const users = asRecord(result.json)?.value;
    if (!Array.isArray(users)) return personFailed("provider_bad_response", "the provider answered success but the reply was not understood");
    if (users.length === 0) return { ok: false, reason: "not_found", errorCode: "person_not_found", detail: "no person matches in this tenant" };
    // Never a list: two matches (a mail and another person's UPN) are ambiguous.
    if (users.length > 1) return { ok: false, reason: "ambiguous", errorCode: "person_ambiguous", detail: "more than one person matches; ask by user principal name" };
    const user = asRecord(users[0]);
    const userId = str(user?.id, GUID);
    if (!userId) return personFailed("provider_bad_response", "the provider answered success but the reply was not understood");
    return { ok: true, userId: userId.toLowerCase(), displayName: sanitizeText(user?.displayName, 80) };
  }

  async function openDirect(credential: string | null | undefined, userId: string): Promise<OpenDirectResult> {
    if (!graphEnabled) return { ok: false, errorCode: "channel_capability_unavailable", detail: "Teams direct messages need Microsoft Graph user lookup" };
    const checked = checkCredential(credential);
    if (!checked.ok) return { ok: false, errorCode: checked.reason, detail: "the Microsoft Teams app credential is missing or invalid" };
    if (typeof userId !== "string" || !(TEAMS_USER_ID.test(userId) || GUID.test(userId))) {
      return { ok: false, errorCode: "channel_person_invalid", detail: "a Teams user id (29:…) or a Microsoft Entra object id is required" };
    }
    const anchor = conversations.forTenant(checked.credential.tenantId);
    if (!anchor || !isAllowedServiceUrl(anchor.serviceUrl)) {
      return { ok: false, errorCode: "channel_destination_unknown", detail: "install the Teams app in a team or chat first, so Marketplace knows the service address" };
    }
    const slot = await limiter.acquire(`teams-create:${checked.credential.tenantId}`, TEAMS_THREAD_RULES);
    if (!slot.ok) return { ok: false, errorCode: "provider_rate_limited", detail: `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s` };
    // createConversation returns the existing 1:1 conversation when there is one, so a retry posts nothing.
    const result = await call(checked.credential, BOT_FRAMEWORK_SCOPE, `${serviceBase(anchor.serviceUrl)}/v3/conversations`, {
      method: "POST",
      body: {
        bot: { id: `28:${checked.credential.appId}` },
        members: [{ id: userId }],
        isGroup: false,
        tenantId: checked.credential.tenantId,
        channelData: { tenant: { id: checked.credential.tenantId } },
      },
      idempotent: true,
    });
    if (result.kind === "response" && result.status === 403) {
      return {
        ok: false,
        errorCode: "channel_person_unreachable",
        detail: "the Teams app is not installed for this person (an admin installs it for the user; proactive install through Graph is a later step)",
      };
    }
    if (result.kind === "token" || !isSuccess(result)) {
      const failure = failureOf(result, checked.credential);
      return { ok: false, errorCode: failure.errorCode, detail: failure.detail.replace(/; delivery is unknown$/u, "") };
    }
    const conversationId = str(asRecord(result.json)?.id, CONVERSATION_ID);
    if (!conversationId) return { ok: false, errorCode: "provider_bad_response", detail: "the provider answered success but the reply was not understood" };
    const known = conversations.get(conversationId);
    if (known) return { ok: true, destination: { type: "person", externalId: conversationId, title: known.title || "Direct chat", personId: userId } };
    const ref: TeamsConversationRef = {
      conversationId,
      type: "personal",
      teamName: "",
      title: "Direct chat",
      membership: "standard",
      serviceUrl: anchor.serviceUrl,
      tenantId: checked.credential.tenantId,
    };
    conversations.upsert(ref);
    return { ok: true, destination: { type: "person", externalId: conversationId, title: ref.title, personId: userId } };
  }

  const actionFallback: ActionResult = { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error; the outcome is unknown" };

  return {
    id: "teams",
    capabilities: structuredClone(capabilities),
    verify: (credential) => guard(() => verify(credential), { ok: false, reason: "provider_unavailable" }),
    discover: (credential) => guard(() => discover(credential), { ok: false, reason: "provider_unavailable" }),
    send: (credential, destination, message) =>
      guard(() => send(credential, destination, message), {
        status: "uncertain",
        resultIds: [],
        resultUrls: [],
        errorCode: "provider_internal_error",
        detail: "unexpected adapter error; delivery is unknown",
      }),
    edit: (credential, destination, messageId, message) =>
      guard(() => edit(credential, destination, messageId, message), { ...actionFallback, resultIds: [], resultUrls: [] }),
    remove: (credential, destination, messageId) => guard(() => messageAction(credential, destination, messageId, "DELETE"), actionFallback),
    findPerson: (credential, query) => guard(() => findPerson(credential, query), personFailed("provider_internal_error", "unexpected adapter error")),
    openDirect: (credential, userId) => guard(() => openDirect(credential, userId), { ok: false, errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
  };
}

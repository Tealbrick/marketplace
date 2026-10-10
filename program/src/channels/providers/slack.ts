import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { applyFallbacks, type SendError } from "./capabilities.js";
import {
  asRecord,
  classifyFailure,
  createReplayGuard,
  guard,
  httpRequest,
  isSuccess,
  normalizeContentType,
  refuse,
  resolveRuntime,
  sanitizeFilename,
  sanitizeText,
  toBlob,
  validateOutbound,
  type Failure,
  type HttpResult,
  type ReplayGuard,
} from "./common.js";
import { SLACK_CHANNEL_RULE, SLACK_SCHEDULE_RULE, createRateLimiter, requestWithRetry } from "./rate.js";
import {
  CHANNEL_CAPABILITIES_VERSION,
  type ActionResult,
  type ChannelCapabilities,
  type ChannelDestination,
  type ChannelProvider,
  type ChannelProviderOptions,
  type DiscoverFailureReason,
  type DiscoverResult,
  type FindPersonResult,
  type InboundMessage,
  type OpenDirectResult,
  type OutboundMention,
  type OutboundMessage,
  type PersonQuery,
  type ScheduleNativeInput,
  type ScheduleNativeResult,
  type SendResult,
  type VerifyFailureReason,
  type VerifyResult,
} from "./types.js";

// Slack Web API adapter (https://docs.slack.dev/reference/methods). Bot token `xoxb-` only, sent as a Bearer
// header and never in a URL. Every method is called with POST and an `application/x-www-form-urlencoded` body
// (accepted by every method used here). Slack answers most errors with HTTP 200 and `{ok: false, error}`.

const API_BASE = "https://slack.com/api";
const MiB = 1024 * 1024;

/** Slack truncates `text` over 40,000 characters; Marketplace refuses longer text instead (never cuts). */
export const SLACK_MAX_TEXT_CHARS = 40_000;
/** Most named mentions in one message. */
export const SLACK_MAX_MENTIONS = 20;
/** Most destinations one discovery returns. */
export const SLACK_DISCOVER_MAX_DESTINATIONS = 1000;
const DISCOVER_PAGE_SIZE = 200;
const DISCOVER_MAX_PAGES = 25;
/** The handle directory (users.list) is cached at most this long and is never returned to callers. */
export const SLACK_DIRECTORY_TTL_MS = 10 * 60_000;
const DIRECTORY_PAGE_SIZE = 200;
const DIRECTORY_MAX_PAGES = 100;
/** chat.scheduleMessage accepts post_at up to 120 days ahead. */
export const SLACK_SCHEDULE_MAX_LEAD_MS = 120 * 86_400_000;
export const SLACK_SCHEDULE_MIN_LEAD_MS = 60_000;
/** Slack's signature check window (X-Slack-Request-Timestamp): five minutes either way. */
export const SLACK_SIGNATURE_MAX_SKEW_SECONDS = 300;
/**
 * How long an `event_id` is remembered: Slack retries a delivery up to three times within about five minutes,
 * and each signed request stays valid for ±300 s, so 15 minutes covers every retry and every replay window.
 */
export const SLACK_EVENT_DEDUPE_TTL_MS = 15 * 60_000;
export const SLACK_EVENT_DEDUPE_MAX_ENTRIES = 10_000;
const INBOUND_MAX_TEXT_CHARS = SLACK_MAX_TEXT_CHARS;
const INBOUND_MAX_FILES = 10;

/**
 * Declared only for what this adapter does today. Files go through the upload v2 flow (one message with the
 * text as `initial_comment`); Slack has no bot voice message, so voice is an audio file plus its transcript.
 * Inbound is `webhook` (Events API, de-duplicated): the route in `channels/inbound-routes.ts` uses the pure
 * signature and event helpers below.
 */
const CAPABILITIES: ChannelCapabilities = {
  channelCapabilities: CHANNEL_CAPABILITIES_VERSION,
  text: { maxChars: SLACK_MAX_TEXT_CHARS },
  markup: "mrkdwn",
  mentions: { users: true, broadcast: "suppressed" },
  dm: { open: true, maxMembers: 1 },
  image: { types: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 50 * MiB, albumMax: 4 },
  file: { types: ["application/pdf", "text/plain", "application/zip", "application/octet-stream"], maxBytes: 50 * MiB },
  audio: { types: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 50 * MiB },
  voice: { fallback: "audio+transcript", types: ["audio/ogg"], maxBytes: 50 * MiB },
  video: { types: ["video/mp4"], maxBytes: 50 * MiB },
  thread: { replies: true, topics: false, forum: false },
  reactions: { add: true, remove: true, custom: true },
  buttons: { url: false, callback: false },
  poll: false,
  edit: { own: true },
  delete: { own: true },
  canvas: false,
  presence: { typing: false, status: false },
  ephemeral: false,
  live: false,
  schedule: { native: true },
  events: { create: false },
  discover: "list",
  inbound: { mode: "webhook", dedupe: true },
  audience: { count: false },
  limits: { perChatPerSecond: 1, retryAfter: "honoured" },
};

const TOKEN_SHAPE = /^xoxb-[A-Za-z0-9-]{10,250}$/u;
const CONVERSATION_ID = /^[CGD][A-Z0-9]{2,30}$/u;
const USER_ID = /^[UW][A-Z0-9]{2,30}$/u;
const TS_SHAPE = /^[0-9]{1,12}\.[0-9]{1,8}$/u;
const FILE_ID = /^F[A-Z0-9]{2,30}$/u;
const SCHEDULED_ID = /^Q[A-Z0-9]{2,40}$/u;
const EVENT_ID = /^Ev[A-Za-z0-9]{2,40}$/u;
const TEAM_ID = /^T[A-Z0-9]{2,30}$/u;
const SLACK_ERROR = /^[a-z0-9_.-]{1,64}$/u;
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/u;
const HANDLE = /^[\p{L}\p{N}._'-]{1,80}$/u;
const EMOJI = /^:?([a-z0-9_+'-]{1,100}(?:::skin-tone-[2-6])?):?$/u;
const TEAM_URL = /^https:\/\/[a-z0-9-]{1,63}(?:\.enterprise)?\.slack\.com\/$/u;
const ARCHIVES_URL = /^https:\/\/[a-z0-9-]{1,63}(?:\.enterprise)?\.slack\.com\/archives\/[CGD][A-Z0-9]{2,30}$/u;
const CURSOR = /^[A-Za-z0-9=+/_-]{1,512}$/u;
const MENTION_TOKEN = /<@([UW][A-Z0-9]{2,30})>/gu;
// Control characters other than newline and tab, bidirectional overrides and zero-width marks.
const UNSAFE_INBOUND = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩؜﻿]/gu;

const CREDENTIAL_ERRORS = new Set(["not_authed", "invalid_auth", "account_inactive", "token_revoked", "token_expired", "not_allowed_token_type"]);
const FORBIDDEN_ERRORS = new Set([
  "missing_scope",
  "no_permission",
  "access_denied",
  "ekm_access_denied",
  "team_access_not_granted",
  "restricted_action",
  "restricted_action_read_only_channel",
  "restricted_action_thread_only_channel",
  "restricted_action_non_threadable_channel",
  "not_in_channel",
  "is_archived",
  "cant_update_message",
  "cant_delete_message",
  "edit_window_closed",
  "cannot_dm_bot",
  "user_disabled",
]);
const NOT_FOUND_ERRORS = new Set(["channel_not_found", "message_not_found", "thread_not_found", "user_not_found", "users_not_found", "file_not_found"]);
const RATE_ERRORS = new Set(["ratelimited", "rate_limited", "restricted_too_many", "message_limit_exceeded"]);
const TEXT_ERRORS = new Set(["msg_too_long", "msg_blocks_too_long"]);
// Slack says the operation may have partly succeeded before these errors.
const UNCERTAIN_ERRORS = new Set(["internal_error", "fatal_error"]);
const UNAVAILABLE_ERRORS = new Set(["service_unavailable", "team_added_to_org"]);

function slackErrorOf(json: unknown): string | undefined {
  const error = asRecord(json)?.error;
  return typeof error === "string" ? (SLACK_ERROR.test(error) ? error : "unknown_error") : undefined;
}

/** Maps a Slack `{ok: false, error}` answer to a result. The Slack error code is a closed snake_case word. */
export function slackFailure(error: string): Failure {
  const detail = `slack: ${SLACK_ERROR.test(error) ? error : "unknown_error"}`;
  if (CREDENTIAL_ERRORS.has(error)) return { status: "failed", errorCode: "credential_invalid", detail };
  if (FORBIDDEN_ERRORS.has(error)) return { status: "failed", errorCode: "provider_forbidden", detail };
  if (NOT_FOUND_ERRORS.has(error)) return { status: "failed", errorCode: "provider_not_found", detail };
  if (RATE_ERRORS.has(error)) return { status: "failed", errorCode: "provider_rate_limited", detail };
  if (TEXT_ERRORS.has(error)) return { status: "failed", errorCode: "channel_text_too_long", detail };
  if (UNCERTAIN_ERRORS.has(error)) return { status: "uncertain", errorCode: "provider_unexpected_status", detail: `${detail}; delivery is unknown` };
  if (UNAVAILABLE_ERRORS.has(error)) return { status: "failed", errorCode: "provider_unavailable", detail };
  return { status: "failed", errorCode: "provider_rejected", detail };
}

type SlackOutcome = { ok: true; body: Record<string, unknown> } | { ok: false; failure: Failure; slackError?: string };

function interpret(result: HttpResult, secrets: readonly string[]): SlackOutcome {
  const httpError = result.kind === "response" ? slackErrorOf(result.json) : undefined;
  if (!isSuccess(result)) {
    const slackError = httpError;
    const failure = classifyFailure(result, { secrets, message: (json) => (slackErrorOf(json) ? `slack: ${slackErrorOf(json)}` : undefined), notFound: "provider_not_found" });
    return { ok: false, failure, ...(slackError ? { slackError } : {}) };
  }
  const body = asRecord(result.json);
  if (!body || typeof body.ok !== "boolean") {
    return {
      ok: false,
      failure: { status: "uncertain", errorCode: "provider_bad_response", detail: "the provider answered success but the reply was not understood; delivery is unknown" },
    };
  }
  if (body.ok) return { ok: true, body };
  const slackError = slackErrorOf(body) ?? "unknown_error";
  return { ok: false, failure: slackFailure(slackError), slackError };
}

/** For reads (verify, discover): which readiness reason a failed call means. */
function readReason(failure: Failure): VerifyFailureReason {
  return failure.errorCode === "credential_invalid" || failure.errorCode === "provider_forbidden" ? "credential_invalid" : "provider_unavailable";
}

// ---------------------------------------------------------------- Formatting

/** Slack mrkdwn control characters. Escaping them stops `<!channel>`, `<!here>`, `<@U…>`, `<#C…>` and link markup. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * Pure: the text exactly as Slack receives it. User text is escaped, so it cannot ping anyone or form links.
 * A `<@USERID>` in the text stays a live mention only when that id is in `mentions`; listed mentions that are
 * not in the text are put first, in list order. Broadcast mentions never survive. Refuses an invalid mention
 * list and a rendered text over 40,000 characters.
 */
export function renderSlackText(
  text: string,
  mentions: readonly OutboundMention[] = [],
): { ok: true; text: string } | { ok: false; error: SendError } {
  if (!Array.isArray(mentions) || mentions.length > SLACK_MAX_MENTIONS) {
    return { ok: false, error: { errorCode: "channel_mention_invalid", detail: `at most ${SLACK_MAX_MENTIONS} named mentions are allowed` } };
  }
  const allowed: string[] = [];
  for (const mention of mentions) {
    const userId = asRecord(mention)?.userId;
    if (typeof userId !== "string" || !USER_ID.test(userId)) {
      return { ok: false, error: { errorCode: "channel_mention_invalid", detail: "a mention needs a Slack user id (U… or W…)" } };
    }
    if (!allowed.includes(userId)) allowed.push(userId);
  }
  const used = new Set<string>();
  let out = "";
  let last = 0;
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const index = match.index ?? 0;
    out += escapeSlackText(text.slice(last, index));
    const userId = match[1] as string;
    if (allowed.includes(userId)) {
      out += `<@${userId}>`;
      used.add(userId);
    } else {
      out += escapeSlackText(match[0]);
    }
    last = index + match[0].length;
  }
  out += escapeSlackText(text.slice(last));
  const lead = allowed.filter((userId) => !used.has(userId)).map((userId) => `<@${userId}>`).join(" ");
  const rendered = lead ? (out.trim().length > 0 ? `${lead} ${out}` : lead) : out;
  if (rendered.length > SLACK_MAX_TEXT_CHARS) {
    return {
      ok: false,
      error: { errorCode: "channel_text_too_long", detail: `the text as sent to Slack is ${rendered.length} characters; Slack allows ${SLACK_MAX_TEXT_CHARS}` },
    };
  }
  return { ok: true, text: rendered };
}

/** Permalink of one message, from the destination's archives URL (set by discovery). */
export function slackMessageUrl(archivesUrl: string | undefined, ts: string, threadTs?: string): string | undefined {
  if (!archivesUrl || !ARCHIVES_URL.test(archivesUrl) || !TS_SHAPE.test(ts)) return undefined;
  const channelId = archivesUrl.slice(archivesUrl.lastIndexOf("/") + 1);
  const base = `${archivesUrl}/p${ts.replace(".", "")}`;
  return threadTs && TS_SHAPE.test(threadTs) && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channelId}` : base;
}

function isSlackUploadUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Provider

type Person = { userId: string; displayName: string; keys: string[]; emailConfirmed: boolean };

function personOf(raw: unknown): Person | undefined {
  const user = asRecord(raw);
  if (!user || typeof user.id !== "string" || !USER_ID.test(user.id) || user.deleted === true || user.is_bot === true || user.id === "USLACKBOT") {
    return undefined;
  }
  const profile = asRecord(user.profile) ?? {};
  const displayName =
    sanitizeText(profile.display_name, 80) || sanitizeText(profile.real_name, 80) || sanitizeText(user.real_name, 80) || sanitizeText(user.name, 80) || user.id;
  const keys = [user.name, profile.display_name, profile.display_name_normalized]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  return { userId: user.id, displayName, keys: [...new Set(keys)], emailConfirmed: user.is_email_confirmed === true };
}

export function createSlackProvider(options: ChannelProviderOptions = {}): ChannelProvider {
  const runtime = resolveRuntime(options);
  const limiter = createRateLimiter({ now: runtime.now, sleep: runtime.sleep });
  // Keyed by a hash of the token, so the map never holds a second copy of it.
  const directories = new Map<string, { at: number; people: Person[] }>();

  function call(token: string, method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<HttpResult> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.append(key, String(value));
    }
    return requestWithRetry(
      () =>
        httpRequest(runtime, `${API_BASE}/${method}`, {
          method: "POST",
          body: form.toString(),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        }),
      runtime.sleep,
    );
  }

  async function api(token: string, method: string, params?: Record<string, string | number | boolean | undefined>): Promise<SlackOutcome> {
    return interpret(await call(token, method, params), [token]);
  }

  function checkToken(credential: string | null | undefined): { token: string } | { reason: "credential_missing" | "credential_invalid" } {
    const token = credential?.trim();
    if (!token) return { reason: "credential_missing" };
    return TOKEN_SHAPE.test(token) ? { token } : { reason: "credential_invalid" };
  }

  function tokenRefusal(reason: "credential_missing" | "credential_invalid"): Failure {
    return {
      status: "failed",
      errorCode: reason,
      detail: reason === "credential_missing" ? "no Slack bot token is configured" : "the Slack bot token has an invalid shape (xoxb- expected)",
    };
  }

  const fromFailure = (failure: Failure): SendResult => ({ status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail });

  function threadOf(destination: ChannelDestination, replyTo: unknown): { ok: true; threadTs?: string } | { ok: false; result: SendResult } {
    const threadTs = replyTo ?? (destination.type === "thread" ? destination.parentId : undefined);
    if (threadTs === undefined) return { ok: true };
    if (typeof threadTs !== "string" || !TS_SHAPE.test(threadTs)) {
      return { ok: false, result: refuse("channel_reply_invalid", "replyTo must be a Slack message ts (for example 1700000000.000100)") };
    }
    return { ok: true, threadTs };
  }

  function destinationProblem(destination: ChannelDestination): SendResult | undefined {
    return typeof destination?.externalId === "string" && CONVERSATION_ID.test(destination.externalId)
      ? undefined
      : refuse("channel_destination_invalid", "the Slack conversation id is invalid");
  }

  async function verify(credential: string | null | undefined): Promise<VerifyResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return { ok: false, reason: checked.reason };
    const outcome = await api(checked.token, "auth.test");
    if (!outcome.ok) return { ok: false, reason: readReason(outcome.failure) };
    const userId = outcome.body.user_id;
    const teamId = outcome.body.team_id;
    if (typeof userId !== "string" || !USER_ID.test(userId)) return { ok: false, reason: "provider_unavailable" };
    // The installed workspace is required: inbound events are matched against it (signature alone does not bind a team).
    if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) return { ok: false, reason: "provider_unavailable" };
    // botId is the bot USER id (U…): the id that mentions use and that inbound parsing ignores as "own".
    return { ok: true, botId: userId, botUsername: sanitizeText(outcome.body.user, 64), teamId };
  }

  async function discover(credential: string | null | undefined): Promise<DiscoverResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return { ok: false, reason: checked.reason };
    const fail = (failure: Failure): DiscoverResult => ({ ok: false, reason: readReason(failure) as DiscoverFailureReason });
    // auth.test gives the workspace URL for destination links (https://<team>.slack.com/).
    const auth = await api(checked.token, "auth.test");
    if (!auth.ok) return fail(auth.failure);
    const teamUrl = typeof auth.body.url === "string" && TEAM_URL.test(auth.body.url) ? auth.body.url : undefined;

    const destinations: ChannelDestination[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < DISCOVER_MAX_PAGES && destinations.length < SLACK_DISCOVER_MAX_DESTINATIONS; page += 1) {
      const outcome = await api(checked.token, "conversations.list", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: DISCOVER_PAGE_SIZE,
        cursor,
      });
      if (!outcome.ok) return fail(outcome.failure);
      const channels = outcome.body.channels;
      if (!Array.isArray(channels)) return { ok: false, reason: "provider_unavailable" };
      for (const raw of channels) {
        const channel = asRecord(raw);
        // Only conversations the bot is a member of: chat:write without chat:write.public posts only there.
        if (!channel || typeof channel.id !== "string" || !/^[CG]/u.test(channel.id) || !CONVERSATION_ID.test(channel.id)) continue;
        if (channel.is_member !== true || channel.is_archived === true || channel.is_im === true || channel.is_mpim === true) continue;
        const name = sanitizeText(channel.name, 80) || channel.id;
        destinations.push({
          type: channel.is_private === true ? "group" : "channel",
          externalId: channel.id,
          title: sanitizeText(`#${name}`),
          ...(teamUrl ? { url: `${teamUrl}archives/${channel.id}` } : {}),
        });
        if (destinations.length >= SLACK_DISCOVER_MAX_DESTINATIONS) break;
      }
      const next = asRecord(outcome.body.response_metadata)?.next_cursor;
      if (typeof next !== "string" || !CURSOR.test(next)) break;
      cursor = next;
    }
    return { ok: true, destinations };
  }

  async function send(credential: string | null | undefined, destination: ChannelDestination, message: OutboundMessage): Promise<SendResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return fromFailure(tokenRefusal(checked.reason));
    const invalid = destinationProblem(destination);
    if (invalid) return invalid;
    const thread = threadOf(destination, message.replyTo);
    if (!thread.ok) return thread.result;
    // The same pure function the caller uses before the digest: voice becomes audio plus a transcript line.
    const post = applyFallbacks(CAPABILITIES, { text: message.text, attachments: message.attachments ?? [] });
    if ("error" in post) return refuse(post.error.errorCode, post.error.detail);
    const { attachments } = post;
    const refusal = validateOutbound({ text: post.text, attachments, caps: CAPABILITIES });
    if (refusal) return refusal;
    const rendered = renderSlackText(post.text, message.mentions ?? []);
    if (!rendered.ok) return refuse(rendered.error.errorCode, rendered.error.detail);
    const fallback = post.fallbacks.length > 0 ? { fallback: post.fallbacks.join(",") } : {};

    // One message per post, text-only or files: reserve one slot before the first request.
    const slot = await limiter.acquire(`slack:${destination.externalId}`, [SLACK_CHANNEL_RULE]);
    if (!slot.ok) {
      return refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`);
    }

    if (attachments.length === 0) {
      const outcome = await api(checked.token, "chat.postMessage", {
        channel: destination.externalId,
        text: rendered.text,
        mrkdwn: true,
        parse: "none",
        link_names: false,
        thread_ts: thread.threadTs,
      });
      if (!outcome.ok) return fromFailure(outcome.failure);
      const ts = outcome.body.ts;
      if (typeof ts !== "string" || !TS_SHAPE.test(ts)) {
        return fromFailure({ status: "uncertain", errorCode: "provider_bad_response", detail: "the provider answered success but the reply was not understood; delivery is unknown" });
      }
      const url = slackMessageUrl(destination.url, ts, thread.threadTs);
      return { status: "sent", resultIds: [ts], resultUrls: url ? [url] : [], ...fallback };
    }

    // Upload v2: get an upload URL per file, upload the bytes (no token is sent to the upload URL), then one
    // files.completeUploadExternal shares every file in one message with the text as initial_comment.
    // Until that share step nothing is visible in the conversation, so an earlier failure is `failed`.
    const beforeShare = (failure: Failure): SendResult => ({
      status: "failed",
      resultIds: [],
      resultUrls: [],
      errorCode: failure.errorCode,
      detail: `upload failed before the share step; nothing was posted (${failure.detail.replace(/; delivery is unknown$/u, "")})`,
    });
    const files: Array<{ id: string; title: string }> = [];
    for (const attachment of attachments) {
      const filename = sanitizeFilename(attachment.name);
      const ticket = await api(checked.token, "files.getUploadURLExternal", { filename, length: attachment.bytes.byteLength });
      if (!ticket.ok) return beforeShare(ticket.failure);
      const uploadUrl = ticket.body.upload_url;
      const fileId = ticket.body.file_id;
      if (!isSlackUploadUrl(uploadUrl) || typeof fileId !== "string" || !FILE_ID.test(fileId)) {
        return beforeShare({ status: "failed", errorCode: "provider_bad_response", detail: "the upload ticket was not understood" });
      }
      const uploaded = await requestWithRetry(
        () => httpRequest(runtime, uploadUrl, { method: "POST", body: toBlob(attachment.bytes, attachment.contentType), headers: { "content-type": normalizeContentType(attachment.contentType) || "application/octet-stream" } }),
        runtime.sleep,
      );
      if (!isSuccess(uploaded)) {
        return beforeShare(classifyFailure(uploaded, { secrets: [checked.token], message: () => undefined, notFound: "provider_not_found" }));
      }
      files.push({ id: fileId, title: filename });
    }
    const shared = await api(checked.token, "files.completeUploadExternal", {
      files: JSON.stringify(files),
      channel_id: destination.externalId,
      thread_ts: thread.threadTs,
      initial_comment: rendered.text.trim().length > 0 ? rendered.text : undefined,
    });
    if (!shared.ok) return fromFailure(shared.failure);
    const expected = new Set(files.map((file) => file.id));
    const confirmed = Array.isArray(shared.body.files)
      ? [...new Set(shared.body.files.map((raw) => asRecord(raw)?.id).filter((id): id is string => typeof id === "string" && expected.has(id)))]
      : [];
    if (confirmed.length === 0) {
      return fromFailure({ status: "uncertain", errorCode: "provider_bad_response", detail: "the share step answered success but named no file; delivery is unknown" });
    }
    if (confirmed.length < files.length) {
      return {
        status: "uncertain",
        resultIds: confirmed,
        resultUrls: [],
        errorCode: "provider_bad_response",
        detail: `partial delivery: Slack confirmed ${confirmed.length} of ${files.length} file(s); delivery of the rest is unknown`,
        partial: true,
        ...fallback,
      };
    }
    // Slack returns file ids, not a message ts, for a file post: the result ids are the F… file ids.
    return { status: "sent", resultIds: confirmed, resultUrls: [], ...fallback };
  }

  async function react(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    emoji: string,
    reactOptions: { remove?: boolean } = {},
  ): Promise<ActionResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return actionOf(tokenRefusal(checked.reason));
    const invalid = destinationProblem(destination);
    if (invalid) return actionOf(invalid);
    if (typeof messageId !== "string" || !TS_SHAPE.test(messageId)) return actionOf(invalidMessageId());
    const name = typeof emoji === "string" ? EMOJI.exec(emoji)?.[1] : undefined;
    if (!name) return actionOf({ status: "failed", errorCode: "channel_reaction_invalid", detail: "a reaction is a Slack emoji name, for example thumbsup or :tada:" });
    const remove = reactOptions.remove === true;
    const outcome = await api(checked.token, remove ? "reactions.remove" : "reactions.add", { channel: destination.externalId, timestamp: messageId, name });
    if (outcome.ok) return { status: "sent" };
    // Already in the asked state: the same end result, so it is not an error.
    if ((!remove && outcome.slackError === "already_reacted") || (remove && outcome.slackError === "no_reaction")) {
      return { status: "sent", detail: remove ? "the reaction was not there" : "the reaction was already there" };
    }
    return actionOf(outcome.failure);
  }

  async function edit(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    input: { text: string; mentions?: readonly OutboundMention[] },
  ): Promise<SendResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return fromFailure(tokenRefusal(checked.reason));
    const invalid = destinationProblem(destination);
    if (invalid) return invalid;
    if (typeof messageId !== "string" || !TS_SHAPE.test(messageId)) return fromFailure(invalidMessageId());
    const text = typeof input?.text === "string" ? input.text : "";
    if (text.trim().length === 0) return refuse("channel_message_empty", "an edit needs text");
    if (text.length > SLACK_MAX_TEXT_CHARS) return refuse("channel_text_too_long", `text is ${text.length} characters; this provider allows ${SLACK_MAX_TEXT_CHARS}`);
    const rendered = renderSlackText(text, input.mentions ?? []);
    if (!rendered.ok) return refuse(rendered.error.errorCode, rendered.error.detail);
    const slot = await limiter.acquire(`slack:${destination.externalId}`, [SLACK_CHANNEL_RULE]);
    if (!slot.ok) return refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`);
    const outcome = await api(checked.token, "chat.update", { channel: destination.externalId, ts: messageId, text: rendered.text, parse: "none", link_names: false });
    if (!outcome.ok) return fromFailure(outcome.failure);
    const url = slackMessageUrl(destination.url, messageId);
    return { status: "sent", resultIds: [messageId], resultUrls: url ? [url] : [] };
  }

  async function remove(credential: string | null | undefined, destination: ChannelDestination, messageId: string): Promise<ActionResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return actionOf(tokenRefusal(checked.reason));
    const invalid = destinationProblem(destination);
    if (invalid) return actionOf(invalid);
    if (typeof messageId !== "string" || !TS_SHAPE.test(messageId)) return actionOf(invalidMessageId());
    const outcome = await api(checked.token, "chat.delete", { channel: destination.externalId, ts: messageId });
    return outcome.ok ? { status: "sent" } : actionOf(outcome.failure);
  }

  async function directory(token: string): Promise<{ ok: true; people: Person[] } | { ok: false; failure: Failure }> {
    const key = createHash("sha256").update(token).digest("hex");
    const cached = directories.get(key);
    if (cached && runtime.now() - cached.at < SLACK_DIRECTORY_TTL_MS) return { ok: true, people: cached.people };
    const people: Person[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < DIRECTORY_MAX_PAGES; page += 1) {
      const outcome = await api(token, "users.list", { limit: DIRECTORY_PAGE_SIZE, cursor });
      if (!outcome.ok) return { ok: false, failure: outcome.failure };
      if (!Array.isArray(outcome.body.members)) {
        return { ok: false, failure: { status: "failed", errorCode: "provider_bad_response", detail: "the member list was not understood" } };
      }
      for (const raw of outcome.body.members) {
        const person = personOf(raw);
        if (person) people.push(person);
      }
      const next = asRecord(outcome.body.response_metadata)?.next_cursor;
      if (typeof next !== "string" || !CURSOR.test(next)) break;
      cursor = next;
    }
    directories.set(key, { at: runtime.now(), people });
    return { ok: true, people };
  }

  async function findPerson(credential: string | null | undefined, query: PersonQuery): Promise<FindPersonResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return personFailure(tokenRefusal(checked.reason));
    const email = typeof query?.email === "string" ? query.email.trim() : undefined;
    const handle = typeof query?.handle === "string" ? query.handle.trim().replace(/^@/u, "").toLowerCase() : undefined;
    if ((email === undefined) === (handle === undefined)) {
      return { ok: false, reason: "failed", errorCode: "person_query_invalid", detail: "ask by exactly one of email or handle" };
    }
    if (email !== undefined) {
      if (email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: "failed", errorCode: "person_query_invalid", detail: "the email address is invalid" };
      // users.lookupByEmail needs the users:read.email scope. The email travels in the form body, never in a URL.
      const outcome = await api(checked.token, "users.lookupByEmail", { email });
      if (!outcome.ok) {
        return outcome.slackError === "users_not_found" ? notFound() : personFailure(outcome.failure);
      }
      const person = personOf(outcome.body.user);
      // Slack's own flag: the email on the profile is confirmed by its owner (allowlists rely on it).
      return person ? { ok: true, userId: person.userId, displayName: person.displayName, emailVerified: person.emailConfirmed } : notFound();
    }
    if (!handle || !HANDLE.test(handle)) return { ok: false, reason: "failed", errorCode: "person_query_invalid", detail: "the handle is invalid" };
    const listed = await directory(checked.token);
    if (!listed.ok) return personFailure(listed.failure);
    const matches = listed.people.filter((person) => person.keys.includes(handle));
    if (matches.length === 0) return notFound();
    if (matches.length > 1) {
      return { ok: false, reason: "ambiguous", errorCode: "person_ambiguous", detail: "more than one person has this handle; ask by email" };
    }
    const person = matches[0] as Person;
    return { ok: true, userId: person.userId, displayName: person.displayName };
  }

  async function openDirect(credential: string | null | undefined, userId: string): Promise<OpenDirectResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) {
      const failure = tokenRefusal(checked.reason);
      return { ok: false, errorCode: failure.errorCode, detail: failure.detail };
    }
    if (typeof userId !== "string" || !USER_ID.test(userId)) return { ok: false, errorCode: "person_query_invalid", detail: "a Slack user id (U… or W…) is required" };
    // conversations.open needs im:write. It returns the existing DM when there is one; it posts nothing.
    const outcome = await api(checked.token, "conversations.open", { users: userId, return_im: true });
    if (!outcome.ok) return { ok: false, errorCode: outcome.failure.errorCode, detail: outcome.failure.detail.replace(/; delivery is unknown$/u, "") };
    const channelId = asRecord(outcome.body.channel)?.id;
    if (typeof channelId !== "string" || !/^D[A-Z0-9]{2,30}$/u.test(channelId)) {
      return { ok: false, errorCode: "provider_bad_response", detail: "the direct message id was not understood" };
    }
    const known = [...directories.values()].flatMap((entry) => entry.people).find((person) => person.userId === userId);
    return {
      ok: true,
      destination: { type: "person", externalId: channelId, title: sanitizeText(`Direct message: ${known?.displayName ?? userId}`), personId: userId },
    };
  }

  async function scheduleNative(credential: string | null | undefined, destination: ChannelDestination, input: ScheduleNativeInput): Promise<ScheduleNativeResult> {
    const checked = checkToken(credential);
    if ("reason" in checked) return scheduleFailure(tokenRefusal(checked.reason));
    const invalid = destinationProblem(destination);
    if (invalid) return scheduleFailure(invalid);
    const thread = threadOf(destination, input?.replyTo);
    if (!thread.ok) return scheduleFailure(thread.result);
    const text = typeof input?.text === "string" ? input.text : "";
    if (text.trim().length === 0) return scheduleFailure({ status: "failed", errorCode: "channel_message_empty", detail: "a scheduled message needs text (files cannot be scheduled)" });
    if (text.length > SLACK_MAX_TEXT_CHARS) {
      return scheduleFailure({ status: "failed", errorCode: "channel_text_too_long", detail: `text is ${text.length} characters; this provider allows ${SLACK_MAX_TEXT_CHARS}` });
    }
    const postAtMs = input.postAt instanceof Date ? input.postAt.getTime() : Number.NaN;
    const now = runtime.now();
    if (!Number.isFinite(postAtMs) || postAtMs < now + SLACK_SCHEDULE_MIN_LEAD_MS || postAtMs > now + SLACK_SCHEDULE_MAX_LEAD_MS) {
      return scheduleFailure({ status: "failed", errorCode: "channel_schedule_window", detail: "postAt must be between 1 minute and 120 days from now" });
    }
    const rendered = renderSlackText(text, input.mentions ?? []);
    if (!rendered.ok) return scheduleFailure({ status: "failed", ...rendered.error });
    const slot = await limiter.acquire(`slack-schedule:${destination.externalId}`, [SLACK_SCHEDULE_RULE]);
    if (!slot.ok) return scheduleFailure({ status: "failed", errorCode: "provider_rate_limited", detail: `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s` });
    const outcome = await api(checked.token, "chat.scheduleMessage", {
      channel: destination.externalId,
      post_at: Math.floor(postAtMs / 1000),
      text: rendered.text,
      parse: "none",
      link_names: false,
      thread_ts: thread.threadTs,
    });
    if (!outcome.ok) return scheduleFailure(outcome.failure);
    const id = outcome.body.scheduled_message_id;
    const postAt = outcome.body.post_at;
    if (typeof id !== "string" || !SCHEDULED_ID.test(id)) {
      return scheduleFailure({ status: "uncertain", errorCode: "provider_bad_response", detail: "the provider answered success but the reply was not understood; scheduling is unknown" });
    }
    const seconds = typeof postAt === "number" && Number.isFinite(postAt) ? postAt : Number(postAt);
    return { status: "scheduled", scheduledMessageId: id, postAt: new Date((Number.isFinite(seconds) ? seconds * 1000 : postAtMs)).toISOString() };
  }

  const uncertainSend: SendResult = { status: "uncertain", resultIds: [], resultUrls: [], errorCode: "provider_internal_error", detail: "unexpected adapter error; delivery is unknown" };
  const uncertainAction: ActionResult = { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error; the result is unknown" };

  return {
    id: "slack",
    capabilities: structuredClone(CAPABILITIES),
    verify: (credential) => guard(() => verify(credential), { ok: false, reason: "provider_unavailable" }),
    discover: (credential) => guard(() => discover(credential), { ok: false, reason: "provider_unavailable" }),
    send: (credential, destination, message) => guard(() => send(credential, destination, message), uncertainSend),
    react: (credential, destination, messageId, emoji, reactOptions) => guard(() => react(credential, destination, messageId, emoji, reactOptions), uncertainAction),
    edit: (credential, destination, messageId, input) => guard(() => edit(credential, destination, messageId, input), uncertainSend),
    remove: (credential, destination, messageId) => guard(() => remove(credential, destination, messageId), uncertainAction),
    findPerson: (credential, query) =>
      guard(() => findPerson(credential, query), { ok: false, reason: "failed", errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
    openDirect: (credential, userId) => guard(() => openDirect(credential, userId), { ok: false, errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
    scheduleNative: (credential, destination, input) =>
      guard(() => scheduleNative(credential, destination, input), { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error; scheduling is unknown" }),
  };
}

function actionOf(failure: Pick<Failure, "status" | "errorCode" | "detail"> | SendResult): ActionResult {
  return { status: failure.status, ...(failure.errorCode ? { errorCode: failure.errorCode } : {}), ...(failure.detail ? { detail: failure.detail } : {}) };
}

function invalidMessageId(): Failure {
  return { status: "failed", errorCode: "channel_message_id_invalid", detail: "a Slack message id is its ts (for example 1700000000.000100)" };
}

function notFound(): FindPersonResult {
  return { ok: false, reason: "not_found", errorCode: "person_not_found", detail: "no person matches in this workspace" };
}

function personFailure(failure: Failure): FindPersonResult {
  return { ok: false, reason: "failed", errorCode: failure.errorCode, detail: failure.detail.replace(/; delivery is unknown$/u, "") };
}

function scheduleFailure(failure: Pick<Failure, "status" | "errorCode" | "detail"> | SendResult): ScheduleNativeResult {
  return {
    status: failure.status === "uncertain" ? "uncertain" : "failed",
    errorCode: failure.errorCode ?? "provider_rejected",
    detail: failure.detail ?? "refused",
  };
}

// ---------------------------------------------------------------- Inbound helpers (pure; used by the Events API route)

export type SlackSignatureCheck = { ok: true } | { ok: false; reason: "secret_missing" | "header_missing" | "malformed" | "stale" | "mismatch" };

/**
 * Verifies an Events API request (https://docs.slack.dev/authentication/verifying-requests-from-slack):
 * `X-Slack-Signature` = `v0=` + hex HMAC-SHA256(signing secret, `v0:{X-Slack-Request-Timestamp}:{raw body}`),
 * and the timestamp within five minutes of now. Use the raw body bytes, before JSON parsing. Constant-time compare.
 */
export function verifySlackSignature(input: {
  signingSecret: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string | Uint8Array;
  nowMs?: number;
}): SlackSignatureCheck {
  const secret = input.signingSecret?.trim();
  if (!secret) return { ok: false, reason: "secret_missing" };
  if (!input.timestamp || !input.signature) return { ok: false, reason: "header_missing" };
  const timestamp = input.timestamp.trim();
  const signature = input.signature.trim();
  if (!/^[0-9]{1,12}$/u.test(timestamp) || !/^v0=[0-9a-f]{64}$/u.test(signature)) return { ok: false, reason: "malformed" };
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_SIGNATURE_MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };
  const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : Buffer.from(input.rawBody);
  const expected = createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), body])).digest("hex");
  const left = Buffer.from(`v0=${expected}`, "utf8");
  const right = Buffer.from(signature, "utf8");
  return left.length === right.length && timingSafeEqual(left, right) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export type SlackEventParse =
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; eventId: string; teamId: string; message: InboundMessage }
  | { kind: "ignored"; reason: string };

/** The installed workspace and bot, from `verify` (stored on the connection row). `teamId` is required. */
export type SlackInboundSelf = { teamId: string; botUserId?: string; botId?: string };

function inboundText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_INBOUND, "").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
  const points = Array.from(text);
  return points.length > INBOUND_MAX_TEXT_CHARS ? points.slice(0, INBOUND_MAX_TEXT_CHARS).join("") : text;
}

/**
 * Parses a verified Events API body into the normalised inbound shape. Call it only after
 * `verifySlackSignature` passed. The envelope `team_id` must equal the installed workspace (`self.teamId`, from
 * `auth.test` at verify): an event of any other team, or with no team, is ignored (`team_mismatch`), and so is
 * every event when the installed team is unknown (`team_unknown`). Ignores bot messages, the bot's own messages (`self.botUserId` from verify),
 * edits, deletes and other subtypes. `messageId` is the message `ts`, so `channelId:messageId` de-duplicates
 * the `message` and `app_mention` events of one mention; `eventId` de-duplicates Slack's retries.
 * The text is untrusted data: entities are decoded, control characters removed, at most 40,000 characters.
 */
export function parseSlackEvent(body: unknown, self: SlackInboundSelf): SlackEventParse {
  let envelope = body;
  if (typeof body === "string") {
    try {
      envelope = JSON.parse(body);
    } catch {
      return { kind: "ignored", reason: "malformed" };
    }
  }
  const record = asRecord(envelope);
  if (!record) return { kind: "ignored", reason: "malformed" };
  if (record.type === "url_verification") {
    const challenge = record.challenge;
    return typeof challenge === "string" && /^[\x21-\x7e]{1,200}$/u.test(challenge)
      ? { kind: "url_verification", challenge }
      : { kind: "ignored", reason: "malformed" };
  }
  if (record.type !== "event_callback") return { kind: "ignored", reason: "not_an_event" };
  if (typeof self?.teamId !== "string" || !TEAM_ID.test(self.teamId)) return { kind: "ignored", reason: "team_unknown" };
  if (record.team_id !== self.teamId) return { kind: "ignored", reason: "team_mismatch" };
  const teamId = self.teamId;
  const eventId = record.event_id;
  const event = asRecord(record.event);
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId) || !event) return { kind: "ignored", reason: "malformed" };
  if (event.type !== "message" && event.type !== "app_mention") return { kind: "ignored", reason: "unsupported_event" };
  const subtype = event.subtype;
  if (subtype === "bot_message" || (typeof event.bot_id === "string" && event.bot_id.length > 0)) return { kind: "ignored", reason: "bot_message" };
  if (subtype !== undefined && subtype !== "thread_broadcast" && subtype !== "file_share") return { kind: "ignored", reason: "unsupported_subtype" };
  const { channel, ts, user } = event;
  if (typeof channel !== "string" || !CONVERSATION_ID.test(channel) || typeof ts !== "string" || !TS_SHAPE.test(ts) || typeof user !== "string" || !USER_ID.test(user)) {
    return { kind: "ignored", reason: "malformed" };
  }
  if ((self.botUserId && user === self.botUserId) || (self.botId && event.bot_id === self.botId)) return { kind: "ignored", reason: "own_message" };
  const threadTs = typeof event.thread_ts === "string" && TS_SHAPE.test(event.thread_ts) && event.thread_ts !== ts ? event.thread_ts : undefined;
  const profile = asRecord(event.user_profile) ?? {};
  const senderDisplay = sanitizeText(profile.display_name, 80) || sanitizeText(profile.real_name, 80) || sanitizeText(profile.name, 80) || user;
  const attachments = (Array.isArray(event.files) ? event.files : [])
    .slice(0, INBOUND_MAX_FILES)
    .map((raw) => asRecord(raw))
    .filter((file): file is Record<string, unknown> => file !== undefined && typeof file.id === "string" && FILE_ID.test(file.id))
    .map((file) => ({
      id: file.id as string,
      name: sanitizeFilename(typeof file.name === "string" ? file.name : "file"),
      contentType: normalizeContentType(typeof file.mimetype === "string" ? file.mimetype : "") || "application/octet-stream",
      bytes: typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0,
    }));
  return {
    kind: "message",
    eventId,
    teamId,
    message: {
      platform: "slack",
      channelId: channel,
      ...(threadTs ? { threadId: threadTs } : {}),
      messageId: ts,
      senderUserId: user,
      senderDisplay,
      text: inboundText(event.text),
      attachments,
    },
  };
}

/** A replay store for Slack `event_id`s (15 minutes, at most 10,000 ids). One per process, shared by all requests. */
export function createSlackEventDedupe(now?: () => number): ReplayGuard {
  return createReplayGuard({ ttlMs: SLACK_EVENT_DEDUPE_TTL_MS, maxEntries: SLACK_EVENT_DEDUPE_MAX_ENTRIES, now });
}

export type SlackInboundDecision =
  | { kind: "rejected"; reason: Exclude<SlackSignatureCheck, { ok: true }>["reason"] }
  | Exclude<SlackEventParse, { kind: "ignored" }>
  | { kind: "ignored"; reason: string };

/**
 * The whole inbound check for one Events API request, in order: signature over the raw body (`rejected` →
 * answer 401 and do nothing), parse with the team match, then `event_id` de-duplication (`ignored` with reason
 * `duplicate` for a Slack retry or a replay inside the window). Only a `message` decision may reach the worker.
 * Pure apart from recording the event id in `dedupe`.
 */
export function acceptSlackEvent(input: {
  signingSecret: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string | Uint8Array;
  self: SlackInboundSelf;
  dedupe: ReplayGuard;
  nowMs?: number;
}): SlackInboundDecision {
  const signed = verifySlackSignature(input);
  if (!signed.ok) return { kind: "rejected", reason: signed.reason };
  const raw = typeof input.rawBody === "string" ? input.rawBody : Buffer.from(input.rawBody).toString("utf8");
  const parsed = parseSlackEvent(raw, input.self);
  if (parsed.kind !== "message") return parsed;
  return input.dedupe.firstSeen(parsed.eventId) ? parsed : { kind: "ignored", reason: "duplicate" };
}

import { createHash, timingSafeEqual } from "node:crypto";
import { applyFallbacks, markupSupported, pollProblem } from "./capabilities.js";
import {
  asRecord,
  classifyFailure,
  httpRequest,
  isSuccess,
  guard,
  normalizeContentType,
  refuse,
  resolveRuntime,
  sanitizeFilename,
  sanitizeText,
  toBlob,
  validateOutbound,
  type Failure,
  type HttpResult,
  type RequestBody,
} from "./common.js";
import {
  TELEGRAM_CHAT_RULE,
  TELEGRAM_GROUP_RULE,
  createRateLimiter,
  requestWithRetry,
} from "./rate.js";
import {
  CHANNEL_CAPABILITIES_VERSION,
  type ActionResult,
  type AttachmentKind,
  type ChannelCapabilities,
  type ChannelDestination,
  type ChannelMarkup,
  type ChannelProvider,
  type ChannelProviderOptions,
  type DiscoverResult,
  type InboundMessage,
  type OutboundAttachment,
  type OutboundMention,
  type OutboundMessage,
  type OutboundPoll,
  type SendResult,
  type VerifyResult,
  type WebhookInfoResult,
  type WebhookRegistration,
} from "./types.js";

// Telegram Bot API adapter: https://api.telegram.org/bot<token>/<method>

const API_BASE = "https://api.telegram.org";
const MiB = 1024 * 1024;

export const TELEGRAM_MAX_TEXT_CHARS = 4096;
export const TELEGRAM_MAX_CAPTION_CHARS = 1024;
/** deleteMessage: "A message can only be deleted if it was sent less than 48 hours ago." */
export const TELEGRAM_DELETE_WINDOW_SECONDS = 48 * 3600;
const INBOUND_MAX_FILES = 10;

/**
 * Emoji a bot can set with setMessageReaction (ReactionTypeEmoji, Bot API 10.3). The variation selector U+FE0F
 * is removed from the caller's emoji before the lookup, so "❤️" and "❤" are the same reaction.
 */
export const TELEGRAM_REACTION_EMOJI: readonly string[] = [
  "❤", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊",
  "🤡", "🥱", "🥴", "😍", "🐳", "❤\u200d🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾",
  "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨\u200d💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅",
  "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷\u200d♂", "🤷", "🤷\u200d♀", "😡",
];

// The explicit document allow-list. Anything else is refused (never sniffed, never converted).
const FILE_TYPES = ["application/pdf", "text/plain", "application/zip", "application/octet-stream"];

/**
 * Voice goes out with sendVoice (OGG/Opus voice note). Telegram plays only small files as a voice message,
 * so the cap is 1 MiB. A bigger OGG is NOT automatically sent as an audio file: it is refused with
 * channel_file_too_large. Sending it as audio would change what the owner approved.
 */
const CAPABILITIES: ChannelCapabilities = {
  channelCapabilities: CHANNEL_CAPABILITIES_VERSION,
  text: { maxChars: TELEGRAM_MAX_TEXT_CHARS, captionMaxChars: TELEGRAM_MAX_CAPTION_CHARS },
  markup: "plain",
  markupOptions: ["markdown-v2"],
  mentions: { users: false, broadcast: "suppressed" },
  dm: { open: false, maxMembers: 0 },
  image: { types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 10 * MiB, albumMax: 4 },
  file: { types: FILE_TYPES, maxBytes: 50 * MiB },
  audio: { types: ["audio/mpeg", "audio/mp4"], maxBytes: 50 * MiB },
  voice: { native: true, types: ["audio/ogg"], maxBytes: 1 * MiB },
  video: { types: ["video/mp4"], maxBytes: 50 * MiB },
  thread: { replies: true, topics: true, forum: false },
  reactions: { add: true, remove: true, custom: false },
  buttons: { url: false, callback: false },
  poll: { questionMaxChars: 300, minOptions: 2, maxOptions: 12, optionMaxChars: 100, multiple: true },
  edit: { own: true },
  delete: { own: true, windowSeconds: TELEGRAM_DELETE_WINDOW_SECONDS },
  canvas: false,
  presence: { typing: false, status: false },
  ephemeral: false,
  live: false,
  schedule: { native: false },
  events: { create: false },
  discover: "updates",
  inbound: { mode: "webhook", dedupe: true },
  audience: { count: false },
  limits: { perChatPerSecond: 1, perChatPerMinute: 20, retryAfter: "honoured" },
};

const TOKEN_SHAPE = /^[0-9]+:[A-Za-z0-9_-]+$/u;
const CHAT_ID_SHAPE = /^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/u;
const THREAD_ID_SHAPE = /^[0-9]{1,12}$/u;
const USERNAME_SHAPE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;
const MESSAGE_ID_SHAPE = /^[0-9]{1,12}$/u;
const FILE_ID_SHAPE = /^[A-Za-z0-9_-]{1,200}$/u;
const SECRET_TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,256}$/u;
// Control characters other than newline and tab, bidirectional overrides and zero-width marks.
const UNSAFE_INBOUND = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/gu;

// ---------------------------------------------------------------- MarkdownV2

/** Every character MarkdownV2 reserves outside entities (core.telegram.org/bots/api#markdownv2-style), plus `\`. */
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/gu;

/** Escapes text so Telegram shows it literally under parse_mode MarkdownV2: no entity can come from it. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL, (char) => `\\${char}`);
}

/**
 * The safe subset an agent may use with `markup: "markdown-v2"`, scanned left to right, one line each, never nested:
 * `code`, [label](https://url), *bold*, _italic_. Bold and italic markers must touch a non-space character and must
 * not be inside a word (so snake_case and 2 * 3 stay literal). Everything else, including the inside of each entity,
 * is escaped: user mentions (tg:// links), spoilers, quotes, underline and custom emoji can never be formed.
 */
const MARKDOWN_V2_SUBSET =
  /`([^`\n]+)`|\[([^[\]\n]{1,256})\]\((https?:\/\/[^\s()<>\\]{1,2048})\)|(?<![\p{L}\p{N}_*])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![\p{L}\p{N}_*])|(?<![\p{L}\p{N}_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\p{L}\p{N}_])/gu;

/** Pure: agent text to MarkdownV2 with only the safe subset live (see `MARKDOWN_V2_SUBSET`). */
export function renderTelegramMarkdownV2(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(MARKDOWN_V2_SUBSET)) {
    const index = match.index ?? 0;
    out += escapeMarkdownV2(text.slice(last, index));
    const [, code, label, url, bold, italic] = match;
    if (code !== undefined) {
      out += `\`${code.replace(/[`\\]/gu, (char) => `\\${char}`)}\``;
    } else if (label !== undefined && url !== undefined) {
      out += `[${escapeMarkdownV2(label)}](${url.replace(/[)\\]/gu, (char) => `\\${char}`)})`;
    } else if (bold !== undefined) {
      out += `*${escapeMarkdownV2(bold)}*`;
    } else if (italic !== undefined) {
      out += `_${escapeMarkdownV2(italic)}_`;
    }
    last = index + match[0].length;
  }
  return out + escapeMarkdownV2(text.slice(last));
}

type Rendered = { text: string; parse_mode?: "MarkdownV2" };

function renderer(markup: ChannelMarkup | undefined): (text: string) => Rendered {
  return markup === "markdown-v2" ? (text) => ({ text: renderTelegramMarkdownV2(text), parse_mode: "MarkdownV2" }) : (text) => ({ text });
}

type TelegramChat = {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  username?: unknown;
  is_forum?: unknown;
};

function tokenOf(credential: string | null | undefined): string | undefined {
  const token = credential?.trim();
  return token ? token : undefined;
}

function telegramMessage(json: unknown): unknown {
  return asRecord(json)?.description;
}

function usernameFromUrl(url: string | undefined): string | undefined {
  const match = url ? /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/u.exec(url) : null;
  return match?.[1];
}

/**
 * Receipt URL for one sent message.
 * Public chat or channel (username known): https://t.me/<username>/<message_id>.
 * Private supergroup or channel (id -100XXXXXXXXXX): https://t.me/c/XXXXXXXXXX/<message_id>.
 * Forum topics add the topic id before the message id. Basic groups have no URL.
 */
export function telegramMessageUrl(input: {
  chatId: string;
  username?: string;
  topicId?: string;
  messageId: string;
}): string | undefined {
  const topic = input.topicId && THREAD_ID_SHAPE.test(input.topicId) ? `/${input.topicId}` : "";
  if (input.username && USERNAME_SHAPE.test(input.username)) {
    return `https://t.me/${input.username}${topic}/${input.messageId}`;
  }
  const privateId = /^-100([0-9]+)$/u.exec(input.chatId);
  if (privateId) {
    return `https://t.me/c/${privateId[1]}${topic}/${input.messageId}`;
  }
  return undefined;
}

type Step = {
  method: string;
  /** Messages this call creates; used by the rate limiter. */
  cost: number;
  build: () => RequestBody;
};

function jsonBody(value: Record<string, unknown>): RequestBody {
  return { body: JSON.stringify(value), headers: { "content-type": "application/json" } };
}

function formBody(
  fields: Record<string, string | undefined>,
  files: Array<{ field: string; attachment: OutboundAttachment }>,
): RequestBody {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      form.append(key, value);
    }
  }
  for (const { field, attachment } of files) {
    form.append(field, toBlob(attachment.bytes, attachment.contentType), sanitizeFilename(attachment.name));
  }
  return { body: form };
}

const SINGLE_METHOD: Record<AttachmentKind, { method: string; field: string }> = {
  image: { method: "sendPhoto", field: "photo" },
  file: { method: "sendDocument", field: "document" },
  audio: { method: "sendAudio", field: "audio" },
  video: { method: "sendVideo", field: "video" },
  voice: { method: "sendVoice", field: "voice" },
};

// Only images and documents can be albums here. Telegram refuses an album that mixes photos and documents,
// so each kind is its own batch. Audio, video and voice go one request each.
const ALBUM_TYPE: Partial<Record<AttachmentKind, "photo" | "document">> = { image: "photo", file: "document" };

type PlanOptions = {
  render: (text: string) => Rendered;
  /** Message id the FIRST step replies to (reply_parameters, allow_sending_without_reply false). */
  replyTo?: string;
  poll?: OutboundPoll;
};

function replyParameters(replyTo: string | undefined): { message_id: number; allow_sending_without_reply: false } | undefined {
  return replyTo === undefined ? undefined : { message_id: Number(replyTo), allow_sending_without_reply: false };
}

/**
 * Plan: batches in the order image, file, audio, video, voice (attachment order inside a kind).
 * The caption (text of at most 1024 characters) rides on the first media step; longer text is sent after the media.
 * A poll post is the text (when there is one) as sendMessage, then sendPoll. The reply goes on the first step only.
 */
function planSteps(destination: ChannelDestination, text: string, attachments: readonly OutboundAttachment[], options: PlanOptions): Step[] {
  const chatId = destination.externalId;
  const thread = destination.parentId;
  const firstReply = replyParameters(options.replyTo);
  const replyFor = (index: number) => (index === 0 ? firstReply : undefined);
  const threadField = thread ? { message_thread_id: Number(thread) } : {};
  const base = (index: number): Record<string, string | undefined> => {
    const reply = replyFor(index);
    return { chat_id: chatId, message_thread_id: thread, ...(reply ? { reply_parameters: JSON.stringify(reply) } : {}) };
  };
  const textStep = (index: number, value: string): Step => ({
    method: "sendMessage",
    cost: 1,
    build: () => {
      const reply = replyFor(index);
      return jsonBody({ chat_id: chatId, ...threadField, ...options.render(value), ...(reply ? { reply_parameters: reply } : {}) });
    },
  });

  if (options.poll) {
    const poll = options.poll;
    const steps: Step[] = text.trim().length > 0 ? [textStep(0, text)] : [];
    const index = steps.length;
    steps.push({
      method: "sendPoll",
      cost: 1,
      build: () => {
        const reply = replyFor(index);
        // Anonymous by default (Telegram's default too): voters are not shown, and channels accept it.
        return jsonBody({
          chat_id: chatId,
          ...threadField,
          question: poll.question,
          options: poll.options.map((option) => ({ text: option })),
          is_anonymous: true,
          allows_multiple_answers: poll.allowsMultiple === true,
          ...(reply ? { reply_parameters: reply } : {}),
        });
      },
    });
    return steps;
  }

  if (attachments.length === 0) {
    return [textStep(0, text)];
  }

  // A caption is at most 1024 characters. A longer text is never cut or split:
  // the media goes without a caption and the full text follows as its own message.
  const caption = text.trim().length > 0 && text.length <= TELEGRAM_MAX_CAPTION_CHARS ? text : undefined;
  const trailingText = text.trim().length > 0 && caption === undefined ? text : undefined;

  const batches: Array<{ kind: AttachmentKind; items: OutboundAttachment[] }> = [];
  for (const kind of ["image", "file", "audio", "video", "voice"] as const) {
    const items = attachments.filter((attachment) => attachment.kind === kind);
    if (ALBUM_TYPE[kind]) {
      if (items.length > 0) {
        batches.push({ kind, items });
      }
    } else {
      for (const item of items) {
        batches.push({ kind, items: [item] });
      }
    }
  }

  const steps: Step[] = batches.map(({ kind, items }, index) => {
    const rendered = index === 0 && caption !== undefined ? options.render(caption) : undefined;
    const single = SINGLE_METHOD[kind];
    if (items.length === 1) {
      const attachment = items[0] as OutboundAttachment;
      return {
        method: single.method,
        cost: 1,
        build: () =>
          formBody({ ...base(index), caption: rendered?.text, parse_mode: rendered?.parse_mode }, [{ field: single.field, attachment }]),
      };
    }
    return {
      method: "sendMediaGroup",
      cost: items.length,
      build: () =>
        formBody(
          {
            ...base(index),
            media: JSON.stringify(
              items.map((_, i) => ({
                type: ALBUM_TYPE[kind],
                media: `attach://file${i}`,
                ...(i === 0 && rendered ? { caption: rendered.text, ...(rendered.parse_mode ? { parse_mode: rendered.parse_mode } : {}) } : {}),
              })),
            ),
          },
          items.map((attachment, i) => ({ field: `file${i}`, attachment })),
        ),
    };
  });

  if (trailingText !== undefined) {
    steps.push(textStep(steps.length, trailingText));
  }
  return steps;
}

type SentMessage = { id: string; chat?: TelegramChat };

function parseSentMessages(json: unknown): SentMessage[] | undefined {
  const record = asRecord(json);
  if (!record || record.ok !== true) {
    return undefined;
  }
  const items = Array.isArray(record.result) ? record.result : [record.result];
  const messages: SentMessage[] = [];
  for (const item of items) {
    const message = asRecord(item);
    const id = message?.message_id;
    if (!message || typeof id !== "number" || !Number.isSafeInteger(id)) {
      return undefined;
    }
    messages.push({ id: String(id), chat: asRecord(message.chat) });
  }
  return messages.length > 0 ? messages : undefined;
}

const TELEGRAM_STEP_SPACING_MS = 1000;

/**
 * Refuses what this adapter does not declare, before any request: named mentions, an undeclared markup,
 * a malformed reply-to id, and a poll outside Telegram's limits.
 */
function sendOptionsProblem(message: {
  replyTo?: unknown;
  mentions?: readonly OutboundMention[];
  markup?: unknown;
  poll?: OutboundPoll;
}): { render: (text: string) => Rendered } | { refusal: SendResult } {
  if (message.mentions !== undefined && (!Array.isArray(message.mentions) || message.mentions.length > 0)) {
    return { refusal: refuse("channel_capability_unavailable", 'this provider does not declare "mentions.users"') };
  }
  if (message.markup !== undefined && (typeof message.markup !== "string" || !markupSupported(CAPABILITIES, message.markup))) {
    return { refusal: refuse("channel_capability_unavailable", `this provider does not declare the markup "${String(message.markup)}"`) };
  }
  if (message.replyTo !== undefined && (typeof message.replyTo !== "string" || !MESSAGE_ID_SHAPE.test(message.replyTo))) {
    return { refusal: refuse("channel_reply_invalid", "replyTo must be a Telegram message id (digits)") };
  }
  const poll = pollProblem(CAPABILITIES, message.poll);
  if (poll) {
    return { refusal: refuse(poll.errorCode, poll.detail) };
  }
  return { render: renderer(message.markup as ChannelMarkup | undefined) };
}

function reactionEmoji(emoji: unknown): string | undefined {
  if (typeof emoji !== "string") {
    return undefined;
  }
  const normalized = emoji.trim().replace(/\ufe0f/gu, "");
  return TELEGRAM_REACTION_EMOJI.includes(normalized) ? normalized : undefined;
}

function actionOf(failure: Pick<Failure, "status" | "errorCode" | "detail"> | SendResult): ActionResult {
  return { status: failure.status, ...(failure.errorCode ? { errorCode: failure.errorCode } : {}), ...(failure.detail ? { detail: failure.detail } : {}) };
}

function descriptionOf(result: HttpResult): string {
  const description = result.kind === "response" ? telegramMessage(result.json) : undefined;
  return typeof description === "string" ? description.toLowerCase() : "";
}

export function createTelegramProvider(options: ChannelProviderOptions = {}): ChannelProvider {
  const runtime = resolveRuntime(options);
  const limiter = createRateLimiter({ now: runtime.now, sleep: runtime.sleep });

  function call(token: string, method: string, build: () => RequestBody): Promise<HttpResult> {
    return requestWithRetry(
      () => httpRequest(runtime, `${API_BASE}/bot${token}/${method}`, { method: "POST", ...build() }),
      runtime.sleep,
    );
  }

  function secretsFor(token: string): string[] {
    return [token, `bot${token}`];
  }

  async function verify(credential: string | null | undefined): Promise<VerifyResult> {
    const token = tokenOf(credential);
    if (!token) {
      return { ok: false, reason: "credential_missing" };
    }
    if (!TOKEN_SHAPE.test(token)) {
      return { ok: false, reason: "credential_invalid" };
    }
    const result = await call(token, "getMe", () => jsonBody({}));
    if (result.kind !== "response") {
      return { ok: false, reason: "provider_unavailable" };
    }
    if (result.status === 401 || result.status === 403 || result.status === 404) {
      return { ok: false, reason: "credential_invalid" };
    }
    const me = asRecord(asRecord(result.json)?.result);
    if (!isSuccess(result) || !me || typeof me.id !== "number") {
      return { ok: false, reason: "provider_unavailable" };
    }
    return {
      ok: true,
      botId: String(me.id),
      botUsername: typeof me.username === "string" ? sanitizeText(me.username, 64) : "",
    };
  }

  async function discover(credential: string | null | undefined): Promise<DiscoverResult> {
    const token = tokenOf(credential);
    if (!token) {
      return { ok: false, reason: "credential_missing" };
    }
    if (!TOKEN_SHAPE.test(token)) {
      return { ok: false, reason: "credential_invalid" };
    }
    // No offset is passed, so no update is confirmed: another consumer of the bot keeps its updates.
    const result = await call(token, "getUpdates", () => jsonBody({ limit: 100, timeout: 0 }));
    if (result.kind !== "response") {
      return { ok: false, reason: "provider_unavailable" };
    }
    if (result.status === 409) {
      // A webhook is set or another getUpdates consumer is active.
      return { ok: false, reason: "consumer_conflict" };
    }
    if (result.status === 401 || result.status === 403 || result.status === 404) {
      return { ok: false, reason: "credential_invalid" };
    }
    const updates = asRecord(result.json)?.result;
    if (!isSuccess(result) || !Array.isArray(updates)) {
      return { ok: false, reason: "provider_unavailable" };
    }
    return { ok: true, destinations: destinationsFromUpdates(updates) };
  }

  async function send(
    credential: string | null | undefined,
    destination: ChannelDestination,
    message: OutboundMessage,
  ): Promise<SendResult> {
    const token = tokenOf(credential);
    if (!token) {
      return refuse("credential_missing", "no Telegram bot token is configured");
    }
    if (!TOKEN_SHAPE.test(token)) {
      return refuse("credential_invalid", "the Telegram bot token has an invalid shape");
    }
    if (!CHAT_ID_SHAPE.test(destination.externalId) || (destination.parentId !== undefined && !THREAD_ID_SHAPE.test(destination.parentId))) {
      return refuse("channel_destination_invalid", "the Telegram chat or topic id is invalid");
    }
    const options = sendOptionsProblem(message);
    if ("refusal" in options) {
      return options.refusal;
    }
    if (message.poll !== undefined) {
      if ((message.attachments ?? []).length > 0) {
        return refuse("channel_poll_invalid", "a poll post carries no attachments");
      }
      if (message.text.length > TELEGRAM_MAX_TEXT_CHARS) {
        return refuse("channel_text_too_long", `text is ${message.text.length} characters; this provider allows ${TELEGRAM_MAX_TEXT_CHARS}`);
      }
    }
    // Telegram declares native voice, so no fallback changes the post; the call also checks kinds and transcripts.
    const post = applyFallbacks(CAPABILITIES, { text: message.text, attachments: message.attachments ?? [] });
    if ("error" in post) {
      return refuse(post.error.errorCode, post.error.detail);
    }
    const { attachments } = post;
    const refusal = message.poll === undefined ? validateOutbound({ text: post.text, attachments, caps: CAPABILITIES }) : undefined;
    if (refusal) {
      return refusal;
    }

    const secrets = secretsFor(token);
    const steps = planSteps(destination, post.text, attachments, { render: options.render, replyTo: message.replyTo, poll: message.poll });
    const rules = destination.type === "chat" ? [TELEGRAM_CHAT_RULE] : [TELEGRAM_CHAT_RULE, TELEGRAM_GROUP_RULE];
    const resultIds: string[] = [];
    const resultUrls: string[] = [];
    const publicUsername = usernameFromUrl(destination.url) ?? (destination.externalId.startsWith("@") ? destination.externalId.slice(1) : undefined);

    // After a partial delivery the result is always uncertain, never failed, so
    // no retry can post the first parts again.
    const stop = (failure: Failure): SendResult => {
      const partial = resultIds.length > 0;
      return {
        status: partial ? "uncertain" : failure.status,
        resultIds,
        resultUrls,
        errorCode: failure.errorCode,
        detail: partial ? `partial delivery: ${resultIds.length} message(s) were sent before this failure; ${failure.detail}` : failure.detail,
        ...(partial ? { partial: true as const } : {}),
      };
    };

    // Reserve the whole plan before the first request.
    const totalCost = steps.reduce((sum, step) => sum + step.cost, 0);
    const slot = await limiter.acquire(`telegram:${destination.externalId}`, rules, totalCost);
    if (!slot.ok) {
      return stop({
        status: "failed",
        errorCode: "provider_rate_limited",
        detail: `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`,
      });
    }
    for (const [index, step] of steps.entries()) {
      if (index > 0) {
        // Keep Telegram's one message per second per chat inside the reserved plan.
        await runtime.sleep(TELEGRAM_STEP_SPACING_MS);
      }
      const result = await call(token, step.method, step.build);
      if (!isSuccess(result)) {
        return stop(classifyFailure(result, { secrets, message: telegramMessage, notFound: "credential_invalid" }));
      }
      const sent = parseSentMessages(result.json);
      if (!sent) {
        return stop({
          status: "uncertain",
          errorCode: "provider_bad_response",
          detail: "the provider answered success but the reply was not understood; delivery is unknown",
        });
      }
      for (const item of sent) {
        resultIds.push(item.id);
        const chatId = item.chat?.id !== undefined ? String(item.chat.id) : destination.externalId;
        const responseUsername = typeof item.chat?.username === "string" ? item.chat.username : undefined;
        const url = telegramMessageUrl({
          chatId,
          username: responseUsername ?? publicUsername,
          topicId: destination.parentId,
          messageId: item.id,
        });
        if (url) {
          resultUrls.push(url);
        }
      }
    }
    return { status: "sent", resultIds, resultUrls };
  }

  /** Token and chat checks shared by react, edit and remove. */
  function target(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: unknown,
  ): { token: string } | { refusal: SendResult } {
    const token = tokenOf(credential);
    if (!token) {
      return { refusal: refuse("credential_missing", "no Telegram bot token is configured") };
    }
    if (!TOKEN_SHAPE.test(token)) {
      return { refusal: refuse("credential_invalid", "the Telegram bot token has an invalid shape") };
    }
    if (!CHAT_ID_SHAPE.test(destination?.externalId ?? "")) {
      return { refusal: refuse("channel_destination_invalid", "the Telegram chat id is invalid") };
    }
    if (typeof messageId !== "string" || !MESSAGE_ID_SHAPE.test(messageId)) {
      return { refusal: refuse("channel_message_id_invalid", "a Telegram message id is digits") };
    }
    return { token };
  }

  function messageUrl(destination: ChannelDestination, messageId: string): string[] {
    const username = usernameFromUrl(destination.url) ?? (destination.externalId.startsWith("@") ? destination.externalId.slice(1) : undefined);
    const url = telegramMessageUrl({ chatId: destination.externalId, username, topicId: destination.parentId, messageId });
    return url ? [url] : [];
  }

  /**
   * setMessageReaction: the bot's one reaction (bots set at most one per message) from Telegram's fixed emoji list.
   * Remove sends an empty list, which clears the bot's reaction whatever it was.
   */
  async function react(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    emoji: string,
    reactOptions: { remove?: boolean } = {},
  ): Promise<ActionResult> {
    const checked = target(credential, destination, messageId);
    if ("refusal" in checked) {
      return actionOf(checked.refusal);
    }
    const name = reactionEmoji(emoji);
    if (!name) {
      return actionOf(refuse("channel_reaction_invalid", "a Telegram reaction is one emoji from Telegram's reaction list"));
    }
    const remove = reactOptions?.remove === true;
    const result = await call(checked.token, "setMessageReaction", () =>
      jsonBody({ chat_id: destination.externalId, message_id: Number(messageId), reaction: remove ? [] : [{ type: "emoji", emoji: name }] }),
    );
    if (isSuccess(result) && asRecord(result.json)?.ok === true) {
      return { status: "sent" };
    }
    if (isSuccess(result)) {
      return { status: "uncertain", errorCode: "provider_bad_response", detail: "the provider answered success but the reply was not understood" };
    }
    return actionOf(classifyFailure(result, { secrets: secretsFor(checked.token), message: telegramMessage, notFound: "credential_invalid" }));
  }

  /**
   * editMessageText; a media message has a caption instead of text, so Telegram's "there is no text in the message
   * to edit" (a rejection, nothing changed) is followed by editMessageCaption (at most 1024 characters).
   * "message is not modified" is the asked end state, so it counts as sent.
   */
  async function edit(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    input: { text: string; mentions?: readonly OutboundMention[]; markup?: ChannelMarkup },
  ): Promise<SendResult> {
    const checked = target(credential, destination, messageId);
    if ("refusal" in checked) {
      return checked.refusal;
    }
    const text = typeof input?.text === "string" ? input.text : "";
    if (text.trim().length === 0) {
      return refuse("channel_message_empty", "an edit needs text");
    }
    if (text.length > TELEGRAM_MAX_TEXT_CHARS) {
      return refuse("channel_text_too_long", `text is ${text.length} characters; this provider allows ${TELEGRAM_MAX_TEXT_CHARS}`);
    }
    const options = sendOptionsProblem({ mentions: input.mentions, markup: input.markup });
    if ("refusal" in options) {
      return options.refusal;
    }
    const slot = await limiter.acquire(`telegram:${destination.externalId}`, [TELEGRAM_CHAT_RULE]);
    if (!slot.ok) {
      return refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`);
    }
    const secrets = secretsFor(checked.token);
    const rendered = options.render(text);
    const base = { chat_id: destination.externalId, message_id: Number(messageId) };
    let result = await call(checked.token, "editMessageText", () => jsonBody({ ...base, ...rendered }));
    if (result.kind === "response" && result.status === 400 && descriptionOf(result).includes("there is no text in the message to edit")) {
      if (text.length > TELEGRAM_MAX_CAPTION_CHARS) {
        return refuse("channel_text_too_long", `the message is a media caption, which allows ${TELEGRAM_MAX_CAPTION_CHARS} characters`);
      }
      result = await call(checked.token, "editMessageCaption", () =>
        jsonBody({ ...base, caption: rendered.text, ...(rendered.parse_mode ? { parse_mode: rendered.parse_mode } : {}) }),
      );
    }
    if (result.kind === "response" && result.status === 400 && descriptionOf(result).includes("message is not modified")) {
      return { status: "sent", resultIds: [messageId], resultUrls: messageUrl(destination, messageId), detail: "the message already had this text" };
    }
    if (!isSuccess(result)) {
      const failure = classifyFailure(result, { secrets, message: telegramMessage, notFound: "credential_invalid" });
      return { status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail };
    }
    if (asRecord(result.json)?.ok !== true) {
      return {
        status: "uncertain",
        resultIds: [],
        resultUrls: [],
        errorCode: "provider_bad_response",
        detail: "the provider answered success but the reply was not understood; the edit is unknown",
      };
    }
    return { status: "sent", resultIds: [messageId], resultUrls: messageUrl(destination, messageId) };
  }

  /** deleteMessage: the bot's own message, within 48 hours of sending (Telegram refuses older ones). */
  async function remove(credential: string | null | undefined, destination: ChannelDestination, messageId: string): Promise<ActionResult> {
    const checked = target(credential, destination, messageId);
    if ("refusal" in checked) {
      return actionOf(checked.refusal);
    }
    const result = await call(checked.token, "deleteMessage", () => jsonBody({ chat_id: destination.externalId, message_id: Number(messageId) }));
    if (isSuccess(result) && asRecord(result.json)?.ok === true) {
      return { status: "sent" };
    }
    if (isSuccess(result)) {
      return { status: "uncertain", errorCode: "provider_bad_response", detail: "the provider answered success but the reply was not understood" };
    }
    return actionOf(classifyFailure(result, { secrets: secretsFor(checked.token), message: telegramMessage, notFound: "credential_invalid" }));
  }

  const actionFallback: ActionResult = { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error; the outcome is unknown" };

  return {
    id: "telegram",
    capabilities: structuredClone(CAPABILITIES),
    verify: (credential) => guard(() => verify(credential), { ok: false, reason: "provider_unavailable" }),
    discover: (credential) => guard(() => discover(credential), { ok: false, reason: "provider_unavailable" }),
    send: (credential, destination, message) =>
      guard(
        () => send(credential, destination, message),
        {
          status: "uncertain",
          resultIds: [],
          resultUrls: [],
          errorCode: "provider_internal_error",
          detail: "unexpected adapter error; delivery is unknown",
        },
      ),
    react: (credential, destination, messageId, emoji, reactOptions) =>
      guard(() => react(credential, destination, messageId, emoji, reactOptions), actionFallback),
    edit: (credential, destination, messageId, input) =>
      guard(() => edit(credential, destination, messageId, input), {
        status: "uncertain",
        resultIds: [],
        resultUrls: [],
        errorCode: "provider_internal_error",
        detail: "unexpected adapter error; the edit is unknown",
      }),
    remove: (credential, destination, messageId) => guard(() => remove(credential, destination, messageId), actionFallback),
    setWebhook: (credential, registration) => guard(() => setWebhook(credential, registration), actionFallback),
    webhookInfo: (credential) => guard(() => webhookInfo(credential), { ok: false, errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
    deleteWebhook: (credential) => guard(() => deleteWebhook(credential), actionFallback),
  };

  // ----- inbound webhook (P2 scope 2.2) ---------------------------------------
  // The URL (it carries the random path segment) and the secret token are never part of a result or a detail.

  async function webhookCall(credential: string | null | undefined, method: string, body: Record<string, unknown>): Promise<ActionResult> {
    const token = tokenOf(credential);
    if (!token) return { status: "failed", errorCode: "credential_missing", detail: "no Telegram bot token is configured" };
    if (!TOKEN_SHAPE.test(token)) return { status: "failed", errorCode: "credential_invalid", detail: "the Telegram bot token has an invalid shape" };
    const result = await call(token, method, () => jsonBody(body));
    if (result.kind !== "response") return { status: "uncertain", errorCode: "provider_unavailable", detail: `${method} did not answer` };
    if (result.status === 401 || result.status === 403 || result.status === 404) return { status: "failed", errorCode: "credential_invalid", detail: `${method} refused the token` };
    if (!isSuccess(result) || asRecord(result.json)?.ok !== true) {
      return { status: "failed", errorCode: "provider_rejected", detail: `${method} refused (${result.status})` };
    }
    return { status: "sent" };
  }

  async function setWebhook(credential: string | null | undefined, registration: WebhookRegistration): Promise<ActionResult> {
    if (!/^https:\/\/[^\s]{1,2000}$/u.test(registration.url) || !SECRET_TOKEN_SHAPE.test(registration.secretToken)) {
      return { status: "failed", errorCode: "channel_webhook_invalid", detail: "the webhook URL must be https and the secret token 1-256 of A-Z a-z 0-9 _ -" };
    }
    return webhookCall(credential, "setWebhook", {
      url: registration.url,
      secret_token: registration.secretToken,
      allowed_updates: [...registration.allowedUpdates],
      drop_pending_updates: false,
    });
  }

  async function deleteWebhook(credential: string | null | undefined): Promise<ActionResult> {
    return webhookCall(credential, "deleteWebhook", { drop_pending_updates: false });
  }

  async function webhookInfo(credential: string | null | undefined): Promise<WebhookInfoResult> {
    const token = tokenOf(credential);
    if (!token || !TOKEN_SHAPE.test(token)) return { ok: false, errorCode: token ? "credential_invalid" : "credential_missing", detail: "no usable Telegram bot token" };
    const result = await call(token, "getWebhookInfo", () => jsonBody({}));
    if (result.kind !== "response") return { ok: false, errorCode: "provider_unavailable", detail: "getWebhookInfo did not answer" };
    const info = asRecord(asRecord(result.json)?.result);
    if (!isSuccess(result) || !info) return { ok: false, errorCode: result.status === 401 || result.status === 404 ? "credential_invalid" : "provider_rejected", detail: `getWebhookInfo refused (${result.status})` };
    return { ok: true, url: typeof info.url === "string" ? info.url : "" };
  }
}

/** Updates the inbound webhook asks Telegram for (P2 scope 2.2): messages, channel posts, edits, membership changes. */
export const TELEGRAM_WEBHOOK_UPDATES: readonly string[] = ["message", "channel_post", "edited_message", "my_chat_member"];

/**
 * Discovery input from one webhook update (chats seen while a webhook is set, when getUpdates answers 409): the
 * group, supergroup, channel and forum-topic destinations it shows, and the chat id the bot left or was removed
 * from. Titles are untrusted text, cleaned like discovery.
 */
export function telegramChatsFromUpdate(update: unknown): { destinations: ChannelDestination[]; leftChatId?: string } {
  const record = asRecord(update);
  const member = asRecord(record?.my_chat_member);
  const status = asRecord(member?.new_chat_member)?.status;
  const chat = asRecord(member?.chat);
  if (member && (status === "left" || status === "kicked") && typeof chat?.id === "number" && Number.isSafeInteger(chat.id)) {
    return { destinations: [], leftChatId: String(chat.id) };
  }
  return { destinations: record ? destinationsFromUpdates([record]) : [] };
}

// ---------------------------------------------------------------- Discovery mapping

function destinationsFromUpdates(updates: unknown[]): ChannelDestination[] {
  type Entry = { destination: ChannelDestination; order: number };
  const entries = new Map<string, Entry>();
  let order = 0;

  const ordered = updates
    .map((update) => asRecord(update))
    .filter((update): update is Record<string, unknown> => update !== undefined)
    .sort((a, b) => Number(a.update_id ?? 0) - Number(b.update_id ?? 0));

  for (const update of ordered) {
    const memberChange = asRecord(update.my_chat_member);
    const message = asRecord(update.message) ?? asRecord(update.edited_message) ?? asRecord(update.channel_post);
    const chat = asRecord(message?.chat) ?? asRecord(memberChange?.chat);
    if (!chat) {
      continue;
    }
    const chatId = typeof chat.id === "number" && Number.isSafeInteger(chat.id) ? String(chat.id) : undefined;
    if (!chatId) {
      continue;
    }

    if (memberChange) {
      const status = asRecord(memberChange.new_chat_member)?.status;
      if (status === "left" || status === "kicked") {
        for (const key of [...entries.keys()]) {
          if (key === chatId || key.startsWith(`${chatId}:`)) {
            entries.delete(key);
          }
        }
        continue;
      }
    }

    const type = chat.type;
    if (type !== "group" && type !== "supergroup" && type !== "channel") {
      // private chats (and anything unknown) are never destinations
      continue;
    }
    const username = typeof chat.username === "string" && USERNAME_SHAPE.test(chat.username) ? chat.username : undefined;
    const chatTitle = sanitizeText(chat.title) || `chat ${chatId}`;
    const chatKey = chatId;
    if (!entries.has(chatKey)) {
      entries.set(chatKey, {
        order: order++,
        destination: {
          type: type === "channel" ? "channel" : "group",
          externalId: chatId,
          title: chatTitle,
          ...(username ? { url: `https://t.me/${username}` } : {}),
        },
      });
    }

    const threadId = message?.message_thread_id;
    if (chat.is_forum === true && typeof threadId === "number" && Number.isSafeInteger(threadId) && threadId > 0) {
      const topicKey = `${chatId}:${threadId}`;
      if (!entries.has(topicKey)) {
        const topicName =
          sanitizeText(asRecord(message?.forum_topic_created)?.name) ||
          sanitizeText(asRecord(asRecord(message?.reply_to_message)?.forum_topic_created)?.name) ||
          `topic ${threadId}`;
        entries.set(topicKey, {
          order: order++,
          destination: {
            type: "topic",
            externalId: chatId,
            title: sanitizeText(`${chatTitle} / ${topicName}`),
            parentId: String(threadId),
            ...(username ? { url: `https://t.me/${username}/${threadId}` } : {}),
          },
        });
      }
    }
  }
  return [...entries.values()].sort((a, b) => a.order - b.order).map((entry) => entry.destination);
}

// ---------------------------------------------------------------- Inbound helpers (pure; used by the webhook route)

export type TelegramSecretCheck = { ok: true } | { ok: false; reason: "secret_missing" | "header_missing" | "malformed" | "mismatch" };

/**
 * Verifies a webhook request: the `X-Telegram-Bot-Api-Secret-Token` header must equal the `secret_token` given to
 * setWebhook (1-256 characters of A-Z, a-z, 0-9, `_`, `-`). Both sides are hashed first, so the compare is
 * constant-time whatever the lengths.
 */
export function verifyTelegramSecretToken(input: { expected: string | null | undefined; header: string | null | undefined }): TelegramSecretCheck {
  const expected = input.expected?.trim();
  if (!expected) return { ok: false, reason: "secret_missing" };
  if (!SECRET_TOKEN_SHAPE.test(expected)) return { ok: false, reason: "malformed" };
  if (typeof input.header !== "string" || input.header.length === 0) return { ok: false, reason: "header_missing" };
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(input.header, "utf8").digest();
  return timingSafeEqual(left, right) ? { ok: true } : { ok: false, reason: "mismatch" };
}

export type TelegramUpdateParse =
  | { kind: "message"; updateId: number; edited: boolean; message: InboundMessage }
  | { kind: "ignored"; reason: string };

function inboundText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_INBOUND, "");
  const points = Array.from(text);
  return points.length > TELEGRAM_MAX_TEXT_CHARS ? points.slice(0, TELEGRAM_MAX_TEXT_CHARS).join("") : text;
}

function inboundFile(raw: unknown, fallbackName: string, fallbackType: string): InboundMessage["attachments"][number] | undefined {
  const file = asRecord(raw);
  if (!file || typeof file.file_id !== "string" || !FILE_ID_SHAPE.test(file.file_id)) return undefined;
  return {
    id: file.file_id,
    name: sanitizeFilename(typeof file.file_name === "string" ? file.file_name : fallbackName),
    contentType: normalizeContentType(typeof file.mime_type === "string" ? file.mime_type : "") || fallbackType,
    bytes: typeof file.file_size === "number" && Number.isSafeInteger(file.file_size) && file.file_size >= 0 ? file.file_size : 0,
  };
}

/**
 * Parses a verified webhook update (`message`, `edited_message`, `channel_post`, `edited_channel_post`) into the
 * normalised inbound shape. Call it only after `verifyTelegramSecretToken` passed. Ignores other update types,
 * private-chat-less shapes, bots (the bot's own messages included: `self.botId` from verify) and service messages
 * without text or files. `threadId` is the forum topic id. `edited` marks an edit of an earlier message (same
 * `messageId`); `updateId` de-duplicates Telegram's retries. Files are metadata only (file_id, never bytes).
 * The text (or caption) is untrusted data: control characters removed, at most 4096 characters.
 */
export function parseTelegramUpdate(body: unknown, self: { botId?: string } = {}): TelegramUpdateParse {
  let update = body;
  if (typeof body === "string") {
    try {
      update = JSON.parse(body);
    } catch {
      return { kind: "ignored", reason: "malformed" };
    }
  }
  const record = asRecord(update);
  const updateId = record?.update_id;
  if (!record || typeof updateId !== "number" || !Number.isSafeInteger(updateId)) return { kind: "ignored", reason: "malformed" };
  const key = (["message", "edited_message", "channel_post", "edited_channel_post"] as const).find((name) => asRecord(record[name]) !== undefined);
  if (!key) return { kind: "ignored", reason: "unsupported_update" };
  const message = asRecord(record[key]) as Record<string, unknown>;
  const chat = asRecord(message.chat);
  const messageId = message.message_id;
  if (!chat || typeof chat.id !== "number" || !Number.isSafeInteger(chat.id) || typeof messageId !== "number" || !Number.isSafeInteger(messageId)) {
    return { kind: "ignored", reason: "malformed" };
  }
  const from = asRecord(message.from);
  const senderChat = asRecord(message.sender_chat);
  if (from?.is_bot === true) {
    const own = self.botId !== undefined && String(from.id) === self.botId;
    return { kind: "ignored", reason: own ? "own_message" : "bot_message" };
  }
  // Channel posts and anonymous admins are sent on behalf of a chat; that chat is the sender.
  const sender = from && typeof from.id === "number" ? from : senderChat;
  if (!sender || typeof sender.id !== "number" || !Number.isSafeInteger(sender.id)) return { kind: "ignored", reason: "malformed" };
  const senderDisplay =
    sanitizeText([from === sender ? from.first_name : sender.title, from === sender ? from.last_name : undefined].filter((part) => typeof part === "string").join(" "), 80) ||
    sanitizeText(sender.username, 80) ||
    String(sender.id);
  const photos = Array.isArray(message.photo) ? message.photo : [];
  // A photo arrives in several sizes; the last one is the largest.
  const files = [
    inboundFile(photos[photos.length - 1], "photo.jpg", "image/jpeg"),
    inboundFile(message.document, "file", "application/octet-stream"),
    inboundFile(message.audio, "audio", "audio/mpeg"),
    inboundFile(message.voice, "voice.ogg", "audio/ogg"),
    inboundFile(message.video, "video.mp4", "video/mp4"),
  ].filter((file): file is InboundMessage["attachments"][number] => file !== undefined).slice(0, INBOUND_MAX_FILES);
  const text = inboundText(typeof message.text === "string" ? message.text : message.caption);
  if (text.length === 0 && files.length === 0) return { kind: "ignored", reason: "no_content" };
  const threadId = message.is_topic_message === true && typeof message.message_thread_id === "number" && Number.isSafeInteger(message.message_thread_id)
    ? String(message.message_thread_id)
    : undefined;
  return {
    kind: "message",
    updateId,
    edited: key.startsWith("edited_"),
    message: {
      platform: "telegram",
      channelId: String(chat.id),
      ...(threadId ? { threadId } : {}),
      messageId: String(messageId),
      senderUserId: String(sender.id),
      senderDisplay,
      text,
      attachments: files,
    },
  };
}

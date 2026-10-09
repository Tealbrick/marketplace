import {
  asRecord,
  classifyFailure,
  httpRequest,
  isSuccess,
  normalizeContentType,
  guard,
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
import type {
  ChannelCapabilities,
  ChannelDestination,
  ChannelProvider,
  ChannelProviderOptions,
  DiscoverResult,
  OutboundAttachment,
  OutboundMessage,
  SendResult,
  VerifyResult,
} from "./types.js";

// Telegram Bot API adapter: https://api.telegram.org/bot<token>/<method>

const API_BASE = "https://api.telegram.org";
const MiB = 1024 * 1024;

export const TELEGRAM_MAX_TEXT_CHARS = 4096;
export const TELEGRAM_MAX_CAPTION_CHARS = 1024;
const PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const CAPABILITIES: ChannelCapabilities = {
  send: {
    text: true,
    maxChars: TELEGRAM_MAX_TEXT_CHARS,
    files: {
      types: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
      maxBytes: 10 * MiB,
      maxCount: 4,
    },
    markup: "plain",
    mentions: "suppressed",
  },
  edit: false,
  delete: false,
  schedule: { native: false },
  events: { create: false },
  discover: "updates",
  inbound: "none",
  audience: { count: false },
  limits: { perChatPerSecond: 1, perChatPerMinute: 20, retryAfter: "honoured" },
};

const TOKEN_SHAPE = /^[0-9]+:[A-Za-z0-9_-]+$/u;
const CHAT_ID_SHAPE = /^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/u;
const THREAD_ID_SHAPE = /^[0-9]{1,12}$/u;
const USERNAME_SHAPE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/u;

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

function isPhoto(attachment: OutboundAttachment): boolean {
  return PHOTO_TYPES.has(normalizeContentType(attachment.contentType));
}

function planSteps(destination: ChannelDestination, text: string, attachments: readonly OutboundAttachment[]): Step[] {
  const chatId = destination.externalId;
  const thread = destination.parentId;
  const base = (): Record<string, string | undefined> => ({ chat_id: chatId, message_thread_id: thread });

  if (attachments.length === 0) {
    return [
      {
        method: "sendMessage",
        cost: 1,
        build: () => jsonBody({ chat_id: chatId, ...(thread ? { message_thread_id: Number(thread) } : {}), text }),
      },
    ];
  }

  // A caption is at most 1024 characters. A longer text is never cut or split:
  // the media goes without a caption and the full text follows as its own message.
  const caption = text.trim().length > 0 && text.length <= TELEGRAM_MAX_CAPTION_CHARS ? text : undefined;
  const trailingText = text.trim().length > 0 && caption === undefined ? text : undefined;

  // Telegram refuses an album that mixes photos and documents, so a mixed set goes as two batches.
  const photos = attachments.filter(isPhoto);
  const documents = attachments.filter((attachment) => !isPhoto(attachment));
  const batches = [photos, documents].filter((batch) => batch.length > 0);

  const steps: Step[] = batches.map((batch, index) => {
    const batchCaption = index === 0 ? caption : undefined;
    const kind = batch === photos ? "photo" : "document";
    if (batch.length === 1) {
      const attachment = batch[0] as OutboundAttachment;
      return {
        method: kind === "photo" ? "sendPhoto" : "sendDocument",
        cost: 1,
        build: () => formBody({ ...base(), caption: batchCaption }, [{ field: kind, attachment }]),
      };
    }
    return {
      method: "sendMediaGroup",
      cost: batch.length,
      build: () =>
        formBody(
          {
            ...base(),
            media: JSON.stringify(
              batch.map((_, i) => ({
                type: kind,
                media: `attach://file${i}`,
                ...(i === 0 && batchCaption ? { caption: batchCaption } : {}),
              })),
            ),
          },
          batch.map((attachment, i) => ({ field: `file${i}`, attachment })),
        ),
    };
  });

  if (trailingText !== undefined) {
    steps.push({
      method: "sendMessage",
      cost: 1,
      build: () => jsonBody({ chat_id: chatId, ...(thread ? { message_thread_id: Number(thread) } : {}), text: trailingText }),
    });
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
    const attachments = message.attachments ?? [];
    const refusal = validateOutbound({
      text: message.text,
      attachments,
      maxChars: CAPABILITIES.send.maxChars,
      files: CAPABILITIES.send.files,
    });
    if (refusal) {
      return refusal;
    }

    const secrets = secretsFor(token);
    const steps = planSteps(destination, message.text, attachments);
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
  };
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

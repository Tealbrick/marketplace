import { TRANSCRIPT_PREFIX, applyFallbacks, markupSupported, pollProblem, type SendError } from "./capabilities.js";
import {
  asRecord,
  classifyFailure,
  guard,
  httpRequest,
  isSuccess,
  normalizeContentType,
  refuse,
  resolveRuntime,
  sanitizeFilename,
  sanitizeText,
  sha256Hex,
  toBlob,
  validateOutbound,
  type Failure,
  type HttpResult,
  type RequestBody,
} from "./common.js";
import { opusWaveform, readOggOpus } from "./ogg-opus.js";
import { DISCORD_CHANNEL_RULE, createRateLimiter, requestWithRetry } from "./rate.js";
import {
  CHANNEL_CAPABILITIES_VERSION,
  type ActionResult,
  type ChannelCapabilities,
  type ChannelDestination,
  type ChannelMarkup,
  type ChannelProvider,
  type ChannelProviderOptions,
  type DiscoverResult,
  type FindPersonResult,
  type InboundMessage,
  type OpenDirectResult,
  type OutboundAttachment,
  type OutboundMention,
  type OutboundMessage,
  type PersonQuery,
  type SendResult,
  type VerifyResult,
} from "./types.js";

// Discord REST v10 adapter. REST only here; the inbound gateway client is `channels/discord-gateway.ts`
// (inbound `socket`), which uses `parseDiscordMessageCreate` below. No privileged intent unless the owner enables it.

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://tealbrick.com, 1)";
const MiB = 1024 * 1024;

export const DISCORD_MAX_TEXT_CHARS = 2000;
/** Message flag IS_VOICE_MESSAGE (1 << 13). */
export const DISCORD_VOICE_MESSAGE_FLAG = 1 << 13;
/** Most named mentions in one message. */
export const DISCORD_MAX_MENTIONS = 20;
/** Guild member search: at most this many members per guild, and this many guilds per lookup. */
const MEMBER_SEARCH_LIMIT = 5;
const MEMBER_SEARCH_MAX_GUILDS = 10;
const VOICE_FILENAME = "voice-message.ogg";
const INBOUND_MAX_FILES = 10;

/**
 * Voice is a native voice message (flag IS_VOICE_MESSAGE, one OGG/Opus attachment with `duration_secs` and
 * `waveform`, no content); its transcript, with the post text, follows as a second message replying to it.
 * Images, files, audio and video are attachments of one message, with a shared cap of 4 attachments per message.
 * Threads are destinations of their own (active threads are discovered). Direct messages open by user id.
 */
const CAPABILITIES: ChannelCapabilities = {
  channelCapabilities: CHANNEL_CAPABILITIES_VERSION,
  text: { maxChars: DISCORD_MAX_TEXT_CHARS },
  markup: "discord-markdown",
  mentions: { users: true, broadcast: "suppressed" },
  dm: { open: true, maxMembers: 1 },
  image: { types: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 10 * MiB, albumMax: 4 },
  file: { types: ["application/pdf", "text/plain", "application/zip", "application/octet-stream"], maxBytes: 10 * MiB },
  audio: { types: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 10 * MiB },
  voice: { native: true, types: ["audio/ogg"], maxBytes: 10 * MiB },
  video: { types: ["video/mp4"], maxBytes: 10 * MiB },
  thread: { replies: true, topics: false, forum: false },
  reactions: { add: true, remove: true, custom: true },
  buttons: { url: false, callback: false },
  poll: { questionMaxChars: 300, minOptions: 1, maxOptions: 10, optionMaxChars: 55, multiple: true, durationHours: { min: 1, max: 768, default: 24 } },
  edit: { own: true },
  delete: { own: true },
  canvas: false,
  presence: { typing: false, status: false },
  ephemeral: false,
  live: false,
  schedule: { native: false },
  events: { create: false },
  discover: "list",
  inbound: { mode: "socket", dedupe: true },
  audience: { count: false },
  limits: { perChatPerSecond: 1, perChatPerMinute: 60, retryAfter: "honoured" },
};

const SNOWFLAKE = /^[0-9]{1,25}$/u;
// A Discord token is printable ASCII without whitespace. This also blocks header injection.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/u;
const MENTION_TOKEN = /<@!?([0-9]{1,25})>/gu;
const CUSTOM_EMOJI = /^(?:<a?:([A-Za-z0-9_]{2,32}):([0-9]{1,25})>|([A-Za-z0-9_]{2,32}):([0-9]{1,25}))$/u;
// A Unicode emoji: a keycap, or 1-16 code points with no ASCII, whitespace or control character.
const UNICODE_EMOJI = /^(?:[0-9#*]\ufe0f?\u20e3|[^\x00-\x7f\s\p{Cc}]{1,16})$/u;
const HANDLE = /^[\p{L}\p{N}._ '-]{1,32}$/u;
// Control characters other than newline and tab, bidirectional overrides and zero-width marks.
const UNSAFE_INBOUND = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/gu;
const THREAD_TYPES = new Set([10, 11, 12]);

function discordMessage(json: unknown): unknown {
  const record = asRecord(json);
  if (!record) {
    return undefined;
  }
  const message = typeof record.message === "string" ? record.message : "";
  const code = typeof record.code === "number" ? ` (code ${record.code})` : "";
  return `${message}${code}`.trim() || undefined;
}

/** Jump link of one message; `@me` for a direct message. */
export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

type AllowedMentions = { parse: string[]; users?: string[]; replied_user?: false };

/**
 * Pure: the content exactly as Discord receives it, and its allowed_mentions. `allowed_mentions.parse` is always
 * empty, so @everyone, @here and roles never ping. A `<@id>` pings only when that id is listed in `mentions`
 * (`allowed_mentions.users`); listed ids that are not in the text are put first, in list order. Another `<@id>`
 * in the text shows as a mention but pings nobody. A reply adds `replied_user: false` (the caller sets it).
 */
export function renderDiscordContent(
  text: string,
  mentions: readonly OutboundMention[] = [],
): { ok: true; content: string; allowedMentions: AllowedMentions } | { ok: false; error: SendError } {
  if (!Array.isArray(mentions) || mentions.length > DISCORD_MAX_MENTIONS) {
    return { ok: false, error: { errorCode: "channel_mention_invalid", detail: `at most ${DISCORD_MAX_MENTIONS} named mentions are allowed` } };
  }
  const users: string[] = [];
  for (const mention of mentions) {
    const userId = asRecord(mention)?.userId;
    if (typeof userId !== "string" || !SNOWFLAKE.test(userId)) {
      return { ok: false, error: { errorCode: "channel_mention_invalid", detail: "a mention needs a Discord user id (digits)" } };
    }
    if (!users.includes(userId)) users.push(userId);
  }
  const present = new Set([...text.matchAll(MENTION_TOKEN)].map((match) => match[1] as string));
  const lead = users.filter((userId) => !present.has(userId)).map((userId) => `<@${userId}>`).join(" ");
  const content = lead ? (text.trim().length > 0 ? `${lead} ${text}` : lead) : text;
  if (content.length > DISCORD_MAX_TEXT_CHARS) {
    return {
      ok: false,
      error: { errorCode: "channel_text_too_long", detail: `the text as sent to Discord is ${content.length} characters; Discord allows ${DISCORD_MAX_TEXT_CHARS}` },
    };
  }
  return { ok: true, content, allowedMentions: { parse: [], ...(users.length > 0 ? { users } : {}) } };
}

export type DiscordVoicePayload = {
  /** The voice message (multipart `payload_json`): flag IS_VOICE_MESSAGE, one attachment, no content. */
  voice: {
    flags: number;
    attachments: [{ id: 0; filename: string; duration_secs: number; waveform: string }];
    allowed_mentions: AllowedMentions;
    message_reference?: { message_id: string; fail_if_not_exists: true };
  };
  file: { name: string; contentType: "audio/ogg"; bytes: Uint8Array; sha256: string };
  /** The second message, replying to the voice message: the post text and the `Transcript:` line. */
  followUp?: { content: string; allowed_mentions: AllowedMentions };
  durationSecs: number;
  /** Base64 of at most 256 bytes (0-255). */
  waveform: string;
};

/**
 * Pure: the native voice message exactly as it will be sent, for the digest before approval and for `send`.
 * The duration comes from the last Ogg granule position minus the Opus pre-skip; the waveform from the Opus packet
 * sizes (see `opusWaveform`: a documented approximation, no decoder). The post text, the transcript (as one
 * `Transcript: …` line) and any named mentions go in a second message that replies to the voice message
 * (`message_reference`, fail_if_not_exists true); with none of them there is no second message.
 * Refuses: a non-voice or non-OGG attachment, a digest mismatch, an unreadable Ogg/Opus file, a bad transcript
 * line, a bad reply id, bad mentions and a second message over 2000 characters. Never cuts text.
 */
export function buildDiscordVoicePayload(input: {
  attachment: OutboundAttachment;
  text?: string;
  replyTo?: string;
  mentions?: readonly OutboundMention[];
}): { ok: true; payload: DiscordVoicePayload } | { ok: false; error: SendError } {
  const { attachment } = input;
  if (!attachment || attachment.kind !== "voice" || normalizeContentType(attachment.contentType) !== "audio/ogg") {
    return { ok: false, error: { errorCode: "channel_file_type_not_allowed", detail: "a Discord voice message is one OGG/Opus file" } };
  }
  const maxBytes = CAPABILITIES.voice ? CAPABILITIES.voice.maxBytes : 0;
  if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.byteLength > maxBytes) {
    return { ok: false, error: { errorCode: "channel_file_too_large", detail: `the voice file is larger than ${maxBytes} bytes` } };
  }
  if (sha256Hex(attachment.bytes) !== String(attachment.sha256).toLowerCase()) {
    return { ok: false, error: { errorCode: "channel_file_digest_mismatch", detail: "a file does not match its approved SHA-256" } };
  }
  if (input.replyTo !== undefined && (typeof input.replyTo !== "string" || !SNOWFLAKE.test(input.replyTo))) {
    return { ok: false, error: { errorCode: "channel_reply_invalid", detail: "replyTo must be a Discord message id (digits)" } };
  }
  const read = readOggOpus(attachment.bytes);
  if (!read.ok) {
    return { ok: false, error: { errorCode: "channel_voice_invalid", detail: `the voice file is not a usable Ogg/Opus stream: ${read.reason}` } };
  }
  const durationSecs = Math.max(0.01, Math.round(read.info.durationSecs * 100) / 100);
  const waveform = Buffer.from(opusWaveform(read.info)).toString("base64");
  const text = typeof input.text === "string" ? input.text : "";
  const lines = [
    ...(text.trim().length > 0 ? [text] : []),
    ...(attachment.transcript !== undefined ? [`${TRANSCRIPT_PREFIX}${attachment.transcript}`] : []),
  ];
  let followUp: DiscordVoicePayload["followUp"];
  if (lines.length > 0 || (input.mentions?.length ?? 0) > 0) {
    const rendered = renderDiscordContent(lines.join("\n"), input.mentions ?? []);
    if (!rendered.ok) return { ok: false, error: rendered.error };
    followUp = { content: rendered.content, allowed_mentions: { ...rendered.allowedMentions, replied_user: false } };
  }
  return {
    ok: true,
    payload: {
      voice: {
        flags: DISCORD_VOICE_MESSAGE_FLAG,
        attachments: [{ id: 0, filename: VOICE_FILENAME, duration_secs: durationSecs, waveform }],
        allowed_mentions: { parse: [] },
        ...(input.replyTo !== undefined ? { message_reference: { message_id: input.replyTo, fail_if_not_exists: true as const } } : {}),
      },
      file: { name: VOICE_FILENAME, contentType: "audio/ogg", bytes: attachment.bytes, sha256: attachment.sha256.toLowerCase() },
      ...(followUp ? { followUp } : {}),
      durationSecs,
      waveform,
    },
  };
}

/** URL path segment of a reaction emoji: a Unicode emoji, or a custom emoji as `name:id` (from `<:name:id>` too). */
export function discordReactionPath(emoji: string): string | undefined {
  if (typeof emoji !== "string") return undefined;
  const trimmed = emoji.trim();
  const custom = CUSTOM_EMOJI.exec(trimmed);
  if (custom) return encodeURIComponent(`${custom[1] ?? custom[3]}:${custom[2] ?? custom[4]}`);
  return UNICODE_EMOJI.test(trimmed) ? encodeURIComponent(trimmed) : undefined;
}

export function createDiscordProvider(options: ChannelProviderOptions = {}): ChannelProvider {
  const runtime = resolveRuntime(options);
  const limiter = createRateLimiter({ now: runtime.now, sleep: runtime.sleep });

  function call(token: string, path: string, init: { method: string; body?: RequestBody["body"]; headers?: Record<string, string> }): Promise<HttpResult> {
    return requestWithRetry(
      () =>
        httpRequest(runtime, `${API_BASE}${path}`, {
          method: init.method,
          body: init.body,
          headers: { authorization: `Bot ${token}`, "user-agent": USER_AGENT, ...init.headers },
        }),
      runtime.sleep,
    );
  }

  function credentialProblem(credential: string | null | undefined): { token: string } | { reason: "credential_missing" | "credential_invalid" } {
    const token = credential?.trim();
    if (!token) {
      return { reason: "credential_missing" };
    }
    return TOKEN_SHAPE.test(token) ? { token } : { reason: "credential_invalid" };
  }

  function credentialRefusal(reason: "credential_missing" | "credential_invalid"): SendResult {
    return refuse(reason, reason === "credential_missing" ? "no Discord bot token is configured" : "the Discord bot token has an invalid shape");
  }

  function failureOf(token: string, result: HttpResult): Failure {
    return classifyFailure(result, { secrets: [token], message: discordMessage, notFound: "provider_not_found" });
  }

  async function verify(credential: string | null | undefined): Promise<VerifyResult> {
    const checked = credentialProblem(credential);
    if ("reason" in checked) {
      return { ok: false, reason: checked.reason };
    }
    const result = await call(checked.token, "/users/@me", { method: "GET" });
    if (result.kind !== "response") {
      return { ok: false, reason: "provider_unavailable" };
    }
    if (result.status === 401 || result.status === 403) {
      return { ok: false, reason: "credential_invalid" };
    }
    const me = asRecord(result.json);
    if (!isSuccess(result) || !me || typeof me.id !== "string") {
      return { ok: false, reason: "provider_unavailable" };
    }
    return {
      ok: true,
      botId: me.id,
      botUsername: typeof me.username === "string" ? sanitizeText(me.username, 64) : "",
    };
  }

  async function guildList(token: string): Promise<{ ok: true; guilds: Array<Record<string, unknown>> } | { ok: false; result: HttpResult }> {
    // The guild list is one page (up to 200 guilds, the API default), which is enough for a bot owned by one workspace.
    const result = await call(token, "/users/@me/guilds", { method: "GET" });
    if (!isSuccess(result) || !Array.isArray(result.json)) {
      return { ok: false, result };
    }
    const guilds = result.json
      .map((raw) => asRecord(raw))
      .filter((guild): guild is Record<string, unknown> => guild !== undefined && typeof guild.id === "string" && SNOWFLAKE.test(guild.id));
    return { ok: true, guilds };
  }

  async function discover(credential: string | null | undefined): Promise<DiscoverResult> {
    const checked = credentialProblem(credential);
    if ("reason" in checked) {
      return { ok: false, reason: checked.reason };
    }
    const listed = await guildList(checked.token);
    if (!listed.ok) {
      const result = listed.result;
      if (result.kind === "response" && (result.status === 401 || result.status === 403)) {
        return { ok: false, reason: "credential_invalid" };
      }
      return { ok: false, reason: "provider_unavailable" };
    }
    const destinations: ChannelDestination[] = [];
    const notes: string[] = [];
    for (const guild of listed.guilds) {
      const guildId = guild.id as string;
      const channelsResult = await call(checked.token, `/guilds/${guildId}/channels`, { method: "GET" });
      if (channelsResult.kind === "response" && (channelsResult.status === 403 || channelsResult.status === 404)) {
        // The bot cannot see this guild any more; the other guilds are still listed.
        continue;
      }
      if (channelsResult.kind === "response" && channelsResult.status === 401) {
        return { ok: false, reason: "credential_invalid" };
      }
      if (!isSuccess(channelsResult) || !Array.isArray(channelsResult.json)) {
        return { ok: false, reason: "provider_unavailable" };
      }
      const guildName = sanitizeText(guild.name, 60);
      const channels = channelsResult.json
        .map((raw) => asRecord(raw))
        .filter((channel): channel is Record<string, unknown> => channel !== undefined)
        .filter((channel) => (channel.type === 0 || channel.type === 5) && typeof channel.id === "string" && SNOWFLAKE.test(channel.id))
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
      const channelNames = new Map<string, string>();
      for (const channel of channels) {
        const channelId = channel.id as string;
        const channelName = sanitizeText(channel.name, 80) || channelId;
        channelNames.set(channelId, channelName);
        destinations.push({
          type: "channel",
          externalId: channelId,
          title: sanitizeText(guildName ? `${guildName} / #${channelName}` : `#${channelName}`),
          url: `https://discord.com/channels/${guildId}/${channelId}`,
          parentId: guildId,
        });
      }
      // Active threads under a listed channel are destinations of their own. A failure here never hides the channels.
      const threadsResult = await call(checked.token, `/guilds/${guildId}/threads/active`, { method: "GET" });
      const threads = isSuccess(threadsResult) ? asRecord(threadsResult.json)?.threads : undefined;
      if (!Array.isArray(threads)) {
        notes.push(`Active threads of ${guildName || "a server"} could not be listed.`);
        continue;
      }
      for (const raw of threads) {
        const thread = asRecord(raw);
        const threadId = thread?.id;
        const parent = typeof thread?.parent_id === "string" ? channelNames.get(thread.parent_id) : undefined;
        if (!thread || typeof threadId !== "string" || !SNOWFLAKE.test(threadId) || !THREAD_TYPES.has(Number(thread.type)) || parent === undefined) {
          continue;
        }
        if (asRecord(thread.thread_metadata)?.locked === true) {
          continue;
        }
        const threadName = sanitizeText(thread.name, 80) || threadId;
        destinations.push({
          type: "thread",
          externalId: threadId,
          title: sanitizeText(`${guildName ? `${guildName} / ` : ""}#${parent} / ${threadName}`),
          url: `https://discord.com/channels/${guildId}/${threadId}`,
          parentId: guildId,
        });
      }
    }
    return { ok: true, destinations, ...(notes.length > 0 ? { notes } : {}) };
  }

  function destinationProblem(destination: ChannelDestination): SendResult | undefined {
    if (!SNOWFLAKE.test(destination?.externalId ?? "") || (destination.parentId !== undefined && !SNOWFLAKE.test(destination.parentId))) {
      return refuse("channel_destination_invalid", "the Discord channel or guild id is invalid");
    }
    return undefined;
  }

  function urlFor(destination: ChannelDestination, messageId: string, guildFromReply?: unknown): string[] {
    const guildId = destination.parentId ?? (typeof guildFromReply === "string" && SNOWFLAKE.test(guildFromReply) ? guildFromReply : undefined);
    if (guildId) return [discordMessageUrl(guildId, destination.externalId, messageId)];
    return destination.type === "person" ? [discordMessageUrl("@me", destination.externalId, messageId)] : [];
  }

  function sentId(result: Extract<HttpResult, { kind: "response" }>): { id: string; guildId?: unknown } | undefined {
    const sent = asRecord(result.json);
    return sent && typeof sent.id === "string" && SNOWFLAKE.test(sent.id) ? { id: sent.id, guildId: sent.guild_id } : undefined;
  }

  const badResponse = (resultIds: string[], resultUrls: string[]): SendResult => ({
    status: "uncertain",
    resultIds,
    resultUrls,
    errorCode: "provider_bad_response",
    detail: "the provider answered success but the reply was not understood; delivery is unknown",
    ...(resultIds.length > 0 ? { partial: true as const } : {}),
  });

  async function send(
    credential: string | null | undefined,
    destination: ChannelDestination,
    message: OutboundMessage,
  ): Promise<SendResult> {
    const checked = credentialProblem(credential);
    if ("reason" in checked) {
      return credentialRefusal(checked.reason);
    }
    const invalid = destinationProblem(destination);
    if (invalid) {
      return invalid;
    }
    if (message.replyTo !== undefined && (typeof message.replyTo !== "string" || !SNOWFLAKE.test(message.replyTo))) {
      return refuse("channel_reply_invalid", "replyTo must be a Discord message id (digits)");
    }
    if (message.markup !== undefined && (typeof message.markup !== "string" || !markupSupported(CAPABILITIES, message.markup))) {
      return refuse("channel_capability_unavailable", `this provider does not declare the markup "${String(message.markup)}"`);
    }
    const poll = pollProblem(CAPABILITIES, message.poll);
    if (poll) {
      return refuse(poll.errorCode, poll.detail);
    }
    // The same pure function the caller uses before the digest (no fallback applies: voice is native here).
    const post = applyFallbacks(CAPABILITIES, { text: message.text, attachments: message.attachments ?? [] });
    if ("error" in post) {
      return refuse(post.error.errorCode, post.error.detail);
    }
    const { attachments } = post;
    if (message.poll !== undefined) {
      if (attachments.length > 0) {
        return refuse("channel_poll_invalid", "a poll post carries no attachments");
      }
      if (post.text.length > DISCORD_MAX_TEXT_CHARS) {
        return refuse("channel_text_too_long", `text is ${post.text.length} characters; this provider allows ${DISCORD_MAX_TEXT_CHARS}`);
      }
    } else {
      const refusal = validateOutbound({ text: post.text, attachments, caps: CAPABILITIES });
      if (refusal) {
        return refusal;
      }
    }
    const voice = attachments.find((attachment) => attachment.kind === "voice");
    if (voice) {
      if (attachments.length > 1) {
        return refuse("channel_voice_alone", "a Discord voice message carries one voice file and no other attachment");
      }
      return sendVoice(checked.token, destination, voice, message);
    }
    const rendered = renderDiscordContent(post.text, message.mentions ?? []);
    if (!rendered.ok) {
      return refuse(rendered.error.errorCode, rendered.error.detail);
    }

    const slot = await limiter.acquire(`discord:${destination.externalId}`, [DISCORD_CHANNEL_RULE]);
    if (!slot.ok) {
      return refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`);
    }

    // allowed_mentions.parse is always empty: @everyone, @here and roles ping nobody; only listed users ping.
    const payload = {
      ...(rendered.content.trim().length > 0 ? { content: rendered.content } : {}),
      allowed_mentions: message.replyTo !== undefined ? { ...rendered.allowedMentions, replied_user: false as const } : rendered.allowedMentions,
      ...(message.replyTo !== undefined ? { message_reference: { message_id: message.replyTo, fail_if_not_exists: true } } : {}),
      ...(message.poll !== undefined
        ? {
            poll: {
              question: { text: message.poll.question },
              answers: message.poll.options.map((option) => ({ poll_media: { text: option } })),
              duration: message.poll.durationHours ?? 24,
              allow_multiselect: message.poll.allowsMultiple === true,
              layout_type: 1,
            },
          }
        : {}),
    };
    const build = (): RequestBody => {
      if (attachments.length === 0) {
        return { body: JSON.stringify(payload), headers: { "content-type": "application/json" } };
      }
      const form = new FormData();
      form.append(
        "payload_json",
        JSON.stringify({
          ...payload,
          attachments: attachments.map((attachment, id) => ({ id, filename: sanitizeFilename(attachment.name) })),
        }),
      );
      attachments.forEach((attachment, index) => {
        form.append(`files[${index}]`, toBlob(attachment.bytes, attachment.contentType), sanitizeFilename(attachment.name));
      });
      return { body: form };
    };

    const result = await call(checked.token, `/channels/${destination.externalId}/messages`, { method: "POST", ...build() });
    if (!isSuccess(result)) {
      const failure = failureOf(checked.token, result);
      return { status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail };
    }
    const sent = sentId(result);
    if (!sent) {
      return badResponse([], []);
    }
    return { status: "sent", resultIds: [sent.id], resultUrls: urlFor(destination, sent.id, sent.guildId) };
  }

  /**
   * Native voice message, then (when there is text, a transcript or a mention) the second message replying to it.
   * The whole plan is reserved first. A failure after the voice message was posted is `uncertain` + `partial`.
   */
  async function sendVoice(token: string, destination: ChannelDestination, attachment: OutboundAttachment, message: OutboundMessage): Promise<SendResult> {
    const built = buildDiscordVoicePayload({ attachment, text: message.text, replyTo: message.replyTo, mentions: message.mentions });
    if (!built.ok) {
      return refuse(built.error.errorCode, built.error.detail);
    }
    const { payload } = built;
    const slot = await limiter.acquire(`discord:${destination.externalId}`, [DISCORD_CHANNEL_RULE], payload.followUp ? 2 : 1);
    if (!slot.ok) {
      return refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`);
    }
    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload.voice));
    form.append("files[0]", toBlob(payload.file.bytes, payload.file.contentType), payload.file.name);
    const first = await call(token, `/channels/${destination.externalId}/messages`, { method: "POST", body: form });
    if (!isSuccess(first)) {
      const failure = failureOf(token, first);
      return { status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail };
    }
    const voiceMessage = sentId(first);
    if (!voiceMessage) {
      return badResponse([], []);
    }
    const resultIds = [voiceMessage.id];
    const resultUrls = urlFor(destination, voiceMessage.id, voiceMessage.guildId);
    if (!payload.followUp) {
      return { status: "sent", resultIds, resultUrls };
    }
    const second = await call(token, `/channels/${destination.externalId}/messages`, {
      method: "POST",
      body: JSON.stringify({ ...payload.followUp, message_reference: { message_id: voiceMessage.id, fail_if_not_exists: true } }),
      headers: { "content-type": "application/json" },
    });
    if (!isSuccess(second)) {
      const failure = failureOf(token, second);
      return {
        status: "uncertain",
        resultIds,
        resultUrls,
        errorCode: failure.errorCode,
        detail: `partial delivery: the voice message was sent before this failure of its transcript message; ${failure.detail}`,
        partial: true,
      };
    }
    const follow = sentId(second);
    if (!follow) {
      return badResponse(resultIds, resultUrls);
    }
    return { status: "sent", resultIds: [...resultIds, follow.id], resultUrls: [...resultUrls, ...urlFor(destination, follow.id, follow.guildId)] };
  }

  function messageTarget(credential: string | null | undefined, destination: ChannelDestination, messageId: unknown): { token: string } | { refusal: SendResult } {
    const checked = credentialProblem(credential);
    if ("reason" in checked) return { refusal: credentialRefusal(checked.reason) };
    const invalid = destinationProblem(destination);
    if (invalid) return { refusal: invalid };
    if (typeof messageId !== "string" || !SNOWFLAKE.test(messageId)) {
      return { refusal: refuse("channel_message_id_invalid", "a Discord message id is digits") };
    }
    return checked;
  }

  /** PUT (add) or DELETE (remove) the bot's own reaction: /channels/{id}/messages/{id}/reactions/{emoji}/@me. */
  async function react(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    emoji: string,
    reactOptions: { remove?: boolean } = {},
  ): Promise<ActionResult> {
    const checked = messageTarget(credential, destination, messageId);
    if ("refusal" in checked) return actionOf(checked.refusal);
    const path = discordReactionPath(emoji);
    if (!path) return actionOf(refuse("channel_reaction_invalid", "a Discord reaction is a Unicode emoji or a custom emoji as name:id"));
    const result = await call(checked.token, `/channels/${destination.externalId}/messages/${messageId}/reactions/${path}/@me`, {
      method: reactOptions?.remove === true ? "DELETE" : "PUT",
    });
    return isSuccess(result) ? { status: "sent" } : actionOf(failureOf(checked.token, result));
  }

  /** PATCH the bot's own message content. allowed_mentions.parse stays empty; only listed users ping. */
  async function edit(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    input: { text: string; mentions?: readonly OutboundMention[]; markup?: ChannelMarkup },
  ): Promise<SendResult> {
    const checked = messageTarget(credential, destination, messageId);
    if ("refusal" in checked) return checked.refusal;
    const text = typeof input?.text === "string" ? input.text : "";
    if (text.trim().length === 0) return refuse("channel_message_empty", "an edit needs text");
    if (input.markup !== undefined && !markupSupported(CAPABILITIES, input.markup)) {
      return refuse("channel_capability_unavailable", `this provider does not declare the markup "${String(input.markup)}"`);
    }
    const rendered = renderDiscordContent(text, input.mentions ?? []);
    if (!rendered.ok) return refuse(rendered.error.errorCode, rendered.error.detail);
    const slot = await limiter.acquire(`discord:${destination.externalId}`, [DISCORD_CHANNEL_RULE]);
    if (!slot.ok) return refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`);
    const result = await call(checked.token, `/channels/${destination.externalId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content: rendered.content, allowed_mentions: { parse: [], ...(rendered.allowedMentions.users ? { users: rendered.allowedMentions.users } : {}) } }),
      headers: { "content-type": "application/json" },
    });
    if (!isSuccess(result)) {
      const failure = failureOf(checked.token, result);
      return { status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail };
    }
    const edited = sentId(result);
    if (!edited || edited.id !== messageId) {
      return { ...badResponse([], []), detail: "the provider answered success but the reply was not understood; the edit is unknown" };
    }
    return { status: "sent", resultIds: [messageId], resultUrls: urlFor(destination, messageId, edited.guildId) };
  }

  /** DELETE the bot's own message. */
  async function remove(credential: string | null | undefined, destination: ChannelDestination, messageId: string): Promise<ActionResult> {
    const checked = messageTarget(credential, destination, messageId);
    if ("refusal" in checked) return actionOf(checked.refusal);
    const result = await call(checked.token, `/channels/${destination.externalId}/messages/${messageId}`, { method: "DELETE" });
    return isSuccess(result) ? { status: "sent" } : actionOf(failureOf(checked.token, result));
  }

  /**
   * One member by handle: Search Guild Members (prefix match on username and server nickname, at most 5 per guild,
   * at most 10 guilds), then an exact, case-insensitive match on username, global name or nickname. Bots are left
   * out. Email is refused: Discord exposes no email lookup to bots. Never returns a list.
   */
  async function findPerson(credential: string | null | undefined, query: PersonQuery): Promise<FindPersonResult> {
    const checked = credentialProblem(credential);
    if ("reason" in checked) return personFailed(credentialRefusal(checked.reason));
    if (query?.email !== undefined) {
      return { ok: false, reason: "failed", errorCode: "person_query_invalid", detail: "Discord finds a person only by handle (username, display name or server nickname)" };
    }
    const handle = typeof query?.handle === "string" ? query.handle.trim().replace(/^@/u, "") : "";
    if (!HANDLE.test(handle)) return { ok: false, reason: "failed", errorCode: "person_query_invalid", detail: "the handle is invalid" };
    const wanted = handle.toLowerCase();
    const listed = await guildList(checked.token);
    if (!listed.ok) return personFailed(failureOf(checked.token, listed.result));
    const matches = new Map<string, string>();
    for (const guild of listed.guilds.slice(0, MEMBER_SEARCH_MAX_GUILDS)) {
      const params = new URLSearchParams({ query: handle, limit: String(MEMBER_SEARCH_LIMIT) });
      const result = await call(checked.token, `/guilds/${guild.id as string}/members/search?${params.toString()}`, { method: "GET" });
      if (result.kind === "response" && (result.status === 403 || result.status === 404)) continue;
      if (!isSuccess(result) || !Array.isArray(result.json)) return personFailed(failureOf(checked.token, result));
      for (const raw of result.json) {
        const member = asRecord(raw);
        const user = asRecord(member?.user);
        if (!member || !user || typeof user.id !== "string" || !SNOWFLAKE.test(user.id) || user.bot === true) continue;
        const names = [user.username, user.global_name, member.nick].filter((name): name is string => typeof name === "string");
        if (!matches.has(user.id) && names.some((name) => name.toLowerCase() === wanted)) {
          matches.set(user.id, sanitizeText(member.nick ?? user.global_name ?? user.username, 80) || user.id);
        }
      }
    }
    if (matches.size === 0) return { ok: false, reason: "not_found", errorCode: "person_not_found", detail: "no member of the bot's servers has this handle" };
    if (matches.size > 1) return { ok: false, reason: "ambiguous", errorCode: "person_ambiguous", detail: "more than one member has this handle; ask by the exact username" };
    const [userId, displayName] = [...matches.entries()][0] as [string, string];
    return { ok: true, userId, displayName };
  }

  /** POST /users/@me/channels: the DM channel with one user (Discord returns the existing one). Posts nothing. */
  async function openDirect(credential: string | null | undefined, userId: string): Promise<OpenDirectResult> {
    const checked = credentialProblem(credential);
    if ("reason" in checked) {
      const failure = credentialRefusal(checked.reason);
      return { ok: false, errorCode: failure.errorCode as string, detail: failure.detail as string };
    }
    if (typeof userId !== "string" || !SNOWFLAKE.test(userId)) return { ok: false, errorCode: "channel_person_invalid", detail: "a Discord user id (digits) is required" };
    const result = await call(checked.token, "/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: userId }),
      headers: { "content-type": "application/json" },
    });
    if (!isSuccess(result)) {
      const failure = failureOf(checked.token, result);
      return { ok: false, errorCode: failure.errorCode, detail: failure.detail.replace(/; delivery is unknown$/u, "") };
    }
    const channel = asRecord(result.json);
    if (!channel || typeof channel.id !== "string" || !SNOWFLAKE.test(channel.id) || channel.type !== 1) {
      return { ok: false, errorCode: "provider_bad_response", detail: "the direct message channel was not understood" };
    }
    const recipient = Array.isArray(channel.recipients) ? asRecord(channel.recipients.find((entry) => asRecord(entry)?.id === userId)) : undefined;
    const name = sanitizeText(recipient?.global_name ?? recipient?.username, 80) || userId;
    return { ok: true, destination: { type: "person", externalId: channel.id, title: sanitizeText(`Direct message: ${name}`), personId: userId } };
  }

  const sendFallback = (detail: string): SendResult => ({ status: "uncertain", resultIds: [], resultUrls: [], errorCode: "provider_internal_error", detail });
  const actionFallback: ActionResult = { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error; the outcome is unknown" };

  return {
    id: "discord",
    capabilities: structuredClone(CAPABILITIES),
    verify: (credential) => guard(() => verify(credential), { ok: false, reason: "provider_unavailable" }),
    discover: (credential) => guard(() => discover(credential), { ok: false, reason: "provider_unavailable" }),
    send: (credential, destination, message) =>
      guard(() => send(credential, destination, message), sendFallback("unexpected adapter error; delivery is unknown")),
    react: (credential, destination, messageId, emoji, reactOptions) =>
      guard(() => react(credential, destination, messageId, emoji, reactOptions), actionFallback),
    edit: (credential, destination, messageId, input) =>
      guard(() => edit(credential, destination, messageId, input), sendFallback("unexpected adapter error; the edit is unknown")),
    remove: (credential, destination, messageId) => guard(() => remove(credential, destination, messageId), actionFallback),
    findPerson: (credential, query) =>
      guard(() => findPerson(credential, query), { ok: false, reason: "failed", errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
    openDirect: (credential, userId) =>
      guard(() => openDirect(credential, userId), { ok: false, errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
  };
}

function actionOf(failure: Pick<Failure, "status" | "errorCode" | "detail"> | SendResult): ActionResult {
  return { status: failure.status, ...(failure.errorCode ? { errorCode: failure.errorCode } : {}), ...(failure.detail ? { detail: failure.detail } : {}) };
}

function personFailed(failure: Pick<Failure, "errorCode" | "detail"> | SendResult): FindPersonResult {
  return {
    ok: false,
    reason: "failed",
    errorCode: failure.errorCode ?? "provider_rejected",
    detail: (failure.detail ?? "refused").replace(/; delivery is unknown$/u, ""),
  };
}

// ---------------------------------------------------------------- Inbound helpers (pure; used by the gateway client)

export type DiscordMessageParse = { kind: "message"; guildId?: string; message: InboundMessage } | { kind: "ignored"; reason: string };

function inboundText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(UNSAFE_INBOUND, "");
  const points = Array.from(text);
  return points.length > DISCORD_MAX_TEXT_CHARS * 2 ? points.slice(0, DISCORD_MAX_TEXT_CHARS * 2).join("") : text;
}

/**
 * Parses a gateway MESSAGE_CREATE (the dispatch `{t, d}` or its `d`) into the normalised inbound shape.
 * Ignores bots and webhooks (the bot's own messages included: `self.botUserId` from verify), system message
 * types other than DEFAULT (0) and REPLY (19), and messages without text or files. In a thread (channel types
 * 10, 11, 12) `threadId` is the thread's channel id. Without the privileged Message Content intent Discord sends
 * empty content except for DMs and messages that mention the bot. All fields are untrusted data; files are
 * metadata only.
 */
export function parseDiscordMessageCreate(body: unknown, self: { botUserId?: string } = {}): DiscordMessageParse {
  let envelope = body;
  if (typeof body === "string") {
    try {
      envelope = JSON.parse(body);
    } catch {
      return { kind: "ignored", reason: "malformed" };
    }
  }
  const outer = asRecord(envelope);
  if (!outer) return { kind: "ignored", reason: "malformed" };
  if (outer.t !== undefined && outer.t !== "MESSAGE_CREATE") return { kind: "ignored", reason: "unsupported_event" };
  const data = outer.t === "MESSAGE_CREATE" ? asRecord(outer.d) : outer;
  if (!data) return { kind: "ignored", reason: "malformed" };
  const { id, channel_id: channelId } = data;
  const author = asRecord(data.author);
  if (typeof id !== "string" || !SNOWFLAKE.test(id) || typeof channelId !== "string" || !SNOWFLAKE.test(channelId) || !author || typeof author.id !== "string" || !SNOWFLAKE.test(author.id)) {
    return { kind: "ignored", reason: "malformed" };
  }
  if (self.botUserId && author.id === self.botUserId) return { kind: "ignored", reason: "own_message" };
  if (author.bot === true || (typeof data.webhook_id === "string" && data.webhook_id.length > 0)) return { kind: "ignored", reason: "bot_message" };
  if (data.type !== undefined && data.type !== 0 && data.type !== 19) return { kind: "ignored", reason: "unsupported_type" };
  const member = asRecord(data.member);
  const senderDisplay = sanitizeText(member?.nick, 80) || sanitizeText(author.global_name, 80) || sanitizeText(author.username, 80) || author.id;
  const attachments = (Array.isArray(data.attachments) ? data.attachments : [])
    .slice(0, INBOUND_MAX_FILES)
    .map((raw) => asRecord(raw))
    .filter((file): file is Record<string, unknown> => file !== undefined && typeof file.id === "string" && SNOWFLAKE.test(file.id))
    .map((file) => ({
      id: file.id as string,
      name: sanitizeFilename(typeof file.filename === "string" ? file.filename : "file"),
      contentType: normalizeContentType(typeof file.content_type === "string" ? file.content_type : "") || "application/octet-stream",
      bytes: typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0,
    }));
  const text = inboundText(data.content);
  if (text.length === 0 && attachments.length === 0) return { kind: "ignored", reason: "no_content" };
  const guildId = typeof data.guild_id === "string" && SNOWFLAKE.test(data.guild_id) ? data.guild_id : undefined;
  const inThread = typeof data.channel_type === "number" && THREAD_TYPES.has(data.channel_type);
  return {
    kind: "message",
    ...(guildId ? { guildId } : {}),
    message: {
      platform: "discord",
      channelId,
      ...(inThread ? { threadId: channelId } : {}),
      messageId: id,
      senderUserId: author.id,
      senderDisplay,
      text,
      attachments,
    },
  };
}

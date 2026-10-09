import { applyFallbacks } from "./capabilities.js";
import {
  asRecord,
  classifyFailure,
  guard,
  httpRequest,
  isSuccess,
  refuse,
  resolveRuntime,
  sanitizeFilename,
  sanitizeText,
  toBlob,
  validateOutbound,
  type HttpResult,
  type RequestBody,
} from "./common.js";
import { DISCORD_CHANNEL_RULE, createRateLimiter, requestWithRetry } from "./rate.js";
import {
  CHANNEL_CAPABILITIES_VERSION,
  type ChannelCapabilities,
  type ChannelDestination,
  type ChannelProvider,
  type ChannelProviderOptions,
  type DiscoverResult,
  type OutboundMessage,
  type SendResult,
  type VerifyResult,
} from "./types.js";

// Discord REST v10 adapter. REST only, no gateway, no privileged intents.

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://tealbrick.com, 1)";
const MiB = 1024 * 1024;

export const DISCORD_MAX_TEXT_CHARS = 2000;

// Voice has no native P1 path (voice messages with waveform are P2): it is sent as an audio file plus its
// transcript text in the same message. Images, files, audio and video are attachments of the one message,
// with a shared cap of 4 attachments per message.
const CAPABILITIES: ChannelCapabilities = {
  channelCapabilities: CHANNEL_CAPABILITIES_VERSION,
  text: { maxChars: DISCORD_MAX_TEXT_CHARS },
  markup: "discord-markdown",
  mentions: "suppressed",
  image: { types: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 10 * MiB, albumMax: 4 },
  file: { types: ["application/pdf", "text/plain", "application/zip", "application/octet-stream"], maxBytes: 10 * MiB },
  audio: { types: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 10 * MiB },
  voice: { fallback: "audio+transcript", types: ["audio/ogg"], maxBytes: 10 * MiB },
  video: { types: ["video/mp4"], maxBytes: 10 * MiB },
  thread: false,
  reactions: false,
  buttons: { url: false, callback: false },
  poll: false,
  edit: false,
  delete: false,
  schedule: { native: false },
  events: { create: false },
  discover: "list",
  inbound: "none",
  audience: { count: false },
  limits: { perChatPerSecond: 1, perChatPerMinute: 60, retryAfter: "honoured" },
};

const SNOWFLAKE = /^[0-9]{1,25}$/u;
// A Discord token is printable ASCII without whitespace. This also blocks header injection.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/u;

function discordMessage(json: unknown): unknown {
  const record = asRecord(json);
  if (!record) {
    return undefined;
  }
  const message = typeof record.message === "string" ? record.message : "";
  const code = typeof record.code === "number" ? ` (code ${record.code})` : "";
  return `${message}${code}`.trim() || undefined;
}

export function discordMessageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
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

  async function discover(credential: string | null | undefined): Promise<DiscoverResult> {
    const checked = credentialProblem(credential);
    if ("reason" in checked) {
      return { ok: false, reason: checked.reason };
    }
    // The guild list is one page (up to 200 guilds, the API default), which is enough for a bot owned by one workspace.
    const guildsResult = await call(checked.token, "/users/@me/guilds", { method: "GET" });
    if (guildsResult.kind !== "response") {
      return { ok: false, reason: "provider_unavailable" };
    }
    if (guildsResult.status === 401 || guildsResult.status === 403) {
      return { ok: false, reason: "credential_invalid" };
    }
    if (!isSuccess(guildsResult) || !Array.isArray(guildsResult.json)) {
      return { ok: false, reason: "provider_unavailable" };
    }
    const destinations: ChannelDestination[] = [];
    for (const rawGuild of guildsResult.json) {
      const guild = asRecord(rawGuild);
      if (!guild || typeof guild.id !== "string" || !SNOWFLAKE.test(guild.id)) {
        continue;
      }
      const channelsResult = await call(checked.token, `/guilds/${guild.id}/channels`, { method: "GET" });
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
      for (const channel of channels) {
        const channelId = channel.id as string;
        const channelName = sanitizeText(channel.name, 80) || channelId;
        destinations.push({
          type: "channel",
          externalId: channelId,
          title: sanitizeText(guildName ? `${guildName} / #${channelName}` : `#${channelName}`),
          url: `https://discord.com/channels/${guild.id}/${channelId}`,
          parentId: guild.id,
        });
      }
    }
    return { ok: true, destinations };
  }

  async function send(
    credential: string | null | undefined,
    destination: ChannelDestination,
    message: OutboundMessage,
  ): Promise<SendResult> {
    const checked = credentialProblem(credential);
    if ("reason" in checked) {
      return refuse(checked.reason, checked.reason === "credential_missing" ? "no Discord bot token is configured" : "the Discord bot token has an invalid shape");
    }
    if (!SNOWFLAKE.test(destination.externalId) || (destination.parentId !== undefined && !SNOWFLAKE.test(destination.parentId))) {
      return refuse("channel_destination_invalid", "the Discord channel or guild id is invalid");
    }
    // The same pure function the caller uses before the digest: voice becomes audio plus a transcript line.
    const post = applyFallbacks(CAPABILITIES, { text: message.text, attachments: message.attachments ?? [] });
    if ("error" in post) {
      return refuse(post.error.errorCode, post.error.detail);
    }
    const { attachments } = post;
    const refusal = validateOutbound({ text: post.text, attachments, caps: CAPABILITIES });
    if (refusal) {
      return refusal;
    }

    const slot = await limiter.acquire(`discord:${destination.externalId}`, [DISCORD_CHANNEL_RULE]);
    if (!slot.ok) {
      return {
        status: "failed",
        resultIds: [],
        resultUrls: [],
        errorCode: "provider_rate_limited",
        detail: `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s`,
      };
    }

    // allowed_mentions.parse is always empty: @everyone, @here, roles and users ping nobody.
    const payload = {
      ...(post.text.trim().length > 0 ? { content: post.text } : {}),
      allowed_mentions: { parse: [] as string[] },
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
      const failure = classifyFailure(result, { secrets: [checked.token], message: discordMessage, notFound: "provider_not_found" });
      return { status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail };
    }
    const sent = asRecord(result.json);
    if (!sent || typeof sent.id !== "string" || !SNOWFLAKE.test(sent.id)) {
      return {
        status: "uncertain",
        resultIds: [],
        resultUrls: [],
        errorCode: "provider_bad_response",
        detail: "the provider answered success but the reply was not understood; delivery is unknown",
      };
    }
    const guildId = destination.parentId ?? (typeof sent.guild_id === "string" && SNOWFLAKE.test(sent.guild_id) ? sent.guild_id : undefined);
    return {
      status: "sent",
      resultIds: [sent.id],
      resultUrls: guildId ? [discordMessageUrl(guildId, destination.externalId, sent.id)] : [],
      ...(post.fallbacks.length > 0 ? { fallback: post.fallbacks.join(",") } : {}),
    };
  }

  return {
    id: "discord",
    capabilities: structuredClone(CAPABILITIES),
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
  };
}

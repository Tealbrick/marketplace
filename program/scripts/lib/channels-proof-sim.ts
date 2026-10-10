// Offline stand-in for the Telegram Bot API and the Discord REST API, used by the Channels live proof in dry-run mode
// and by its unit test. The REAL provider adapters run against this fetch, so the dry run exercises the real request
// shapes (sendVoice multipart, allowed_mentions, discovery) without any network. It rejects every other host.

export const SIM_TELEGRAM_CHAT_ID = "-1002000000001";
export const SIM_DISCORD_GUILD_ID = "700000000000000000";
export const SIM_DISCORD_CHANNEL_ID = "700000000000000001";

export type SimOptions = {
  telegramToken: string;
  discordToken: string;
  /** Give the Telegram test chat a public username (the proof must refuse it). */
  telegramPublicUsername?: string;
  /** Let @everyone view the Discord test channel (the proof must refuse it unless CHANNELS_LIVE_ALLOW_VISIBLE=1). */
  discordEveryoneCanView?: boolean;
  /** Make the Discord role and channel permission reads fail, so the visibility check cannot be computed. */
  discordPermissionsUnavailable?: boolean;
};

export type SimRequest = { host: string; method: string; path: string };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function readBody(body: unknown): Promise<{ json?: Record<string, unknown>; form?: FormData }> {
  if (typeof body === "string") {
    try {
      return { json: JSON.parse(body) as Record<string, unknown> };
    } catch {
      return {};
    }
  }
  if (body instanceof FormData) return { form: body };
  return {};
}

async function fileOf(form: FormData, field: string): Promise<{ name: string; type: string; bytes: Uint8Array } | null> {
  const value = form.get(field);
  if (!value || typeof value === "string") return null;
  return { name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) };
}

export function createSimulatedApi(options: SimOptions) {
  const requests: SimRequest[] = [];
  let telegramMessageId = 100;
  let discordMessageId = 800_000_000_000_000_000n;
  const telegramChat = {
    id: Number(SIM_TELEGRAM_CHAT_ID),
    type: "supergroup",
    title: "simulated test group",
    ...(options.telegramPublicUsername ? { username: options.telegramPublicUsername } : {}),
  };

  async function telegram(token: string, method: string, init: RequestInit): Promise<Response> {
    if (token !== options.telegramToken) return json(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const body = await readBody(init.body);
    const chatId = String(body.json?.chat_id ?? body.form?.get("chat_id") ?? "");
    switch (method) {
      case "getMe":
        return json(200, { ok: true, result: { id: 4242, is_bot: true, username: "sim_proof_bot" } });
      case "getUpdates":
        return json(200, { ok: true, result: [{ update_id: 1, message: { message_id: 1, chat: telegramChat, text: "hello" } }] });
      case "getChat":
        return chatId === SIM_TELEGRAM_CHAT_ID ? json(200, { ok: true, result: telegramChat }) : json(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
      case "sendMessage":
      case "sendPhoto":
      case "sendVoice":
      case "sendDocument":
      case "sendAudio": {
        if (chatId !== SIM_TELEGRAM_CHAT_ID) return json(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" });
        telegramMessageId += 1;
        const message: Record<string, unknown> = { message_id: telegramMessageId, chat: telegramChat, date: 0 };
        if (method === "sendMessage") message.text = String(body.json?.text ?? "");
        if (body.form) {
          const caption = body.form.get("caption");
          if (typeof caption === "string") message.caption = caption;
          if (method === "sendPhoto") {
            const photo = await fileOf(body.form, "photo");
            if (!photo || photo.bytes[0] !== 0x89) return json(400, { ok: false, error_code: 400, description: "Bad Request: wrong file" });
            message.photo = [{ file_id: "sim", width: 64, height: 64 }];
          }
          if (method === "sendVoice") {
            const voice = await fileOf(body.form, "voice");
            const magic = voice ? Buffer.from(voice.bytes.slice(0, 4)).toString("latin1") : "";
            if (magic !== "OggS") return json(400, { ok: false, error_code: 400, description: "Bad Request: voice must be OGG/Opus" });
            message.voice = { duration: 1, mime_type: "audio/ogg", file_id: "sim", file_size: voice?.bytes.length ?? 0 };
          }
        }
        return json(200, { ok: true, result: message });
      }
      default:
        return json(404, { ok: false, error_code: 404, description: "Not Found" });
    }
  }

  const everyoneOverwrite = options.discordEveryoneCanView ? [] : [{ id: SIM_DISCORD_GUILD_ID, type: 0, allow: "0", deny: "1024" }];

  async function discord(method: string, path: string, init: RequestInit): Promise<Response> {
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization !== `Bot ${options.discordToken}`) return json(401, { message: "401: Unauthorized", code: 0 });
    if (method === "GET" && path === "/users/@me") return json(200, { id: "999000000000000001", username: "sim-proof-bot", bot: true });
    if (method === "GET" && path === "/users/@me/guilds") return json(200, [{ id: SIM_DISCORD_GUILD_ID, name: "simulated test server" }]);
    const guildPath = /^\/guilds\/(\d+)\/(channels|roles)$/u.exec(path);
    if (method === "GET" && guildPath) {
      if (guildPath[1] !== SIM_DISCORD_GUILD_ID) return json(404, { message: "Unknown Guild", code: 10004 });
      if (guildPath[2] === "channels") {
        return json(200, [{ id: SIM_DISCORD_CHANNEL_ID, type: 0, name: "simulated-test", position: 0, permission_overwrites: everyoneOverwrite }]);
      }
      if (options.discordPermissionsUnavailable) return json(403, { message: "Missing Permissions", code: 50013 });
      return json(200, [{ id: SIM_DISCORD_GUILD_ID, name: "@everyone", permissions: "1024" }]);
    }
    const messagePath = /^\/channels\/(\d+)\/messages$/u.exec(path);
    if (method === "POST" && messagePath) {
      if (messagePath[1] !== SIM_DISCORD_CHANNEL_ID) return json(404, { message: "Unknown Channel", code: 10003 });
      const body = await readBody(init.body);
      let payload = body.json;
      const attachments: Array<{ id: string; filename: string; content_type: string; size: number }> = [];
      if (body.form) {
        const raw = body.form.get("payload_json");
        payload = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        for (let index = 0; ; index += 1) {
          const file = await fileOf(body.form, `files[${index}]`);
          if (!file) break;
          attachments.push({ id: String(index), filename: file.name, content_type: file.type, size: file.bytes.length });
        }
      }
      const content = typeof payload?.content === "string" ? payload.content : "";
      // Voice messages (IS_VOICE_MESSAGE): one audio attachment with duration_secs and waveform, and no content.
      if (typeof payload?.flags === "number" && (payload.flags & (1 << 13)) !== 0) {
        const meta = Array.isArray(payload.attachments) ? (payload.attachments[0] as Record<string, unknown> | undefined) : undefined;
        if (content || attachments.length !== 1 || typeof meta?.duration_secs !== "number" || typeof meta?.waveform !== "string" || !attachments[0]!.content_type.startsWith("audio/")) {
          return json(400, { message: "Invalid Form Body", code: 50035 });
        }
      }
      const parse = (payload?.allowed_mentions as { parse?: unknown } | undefined)?.parse;
      // Discord pings @everyone only when the message text has it and allowed_mentions does not suppress it.
      const pings = content.includes("@everyone") && !(Array.isArray(parse) && !parse.includes("everyone"));
      discordMessageId += 1n;
      return json(200, {
        id: String(discordMessageId),
        channel_id: SIM_DISCORD_CHANNEL_ID,
        guild_id: SIM_DISCORD_GUILD_ID,
        content,
        attachments,
        mention_everyone: pings,
        mentions: [],
      });
    }
    return json(404, { message: "404: Not Found", code: 0 });
  }

  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    requests.push({ host: url.host, method, path: url.pathname.replace(/\/bot[^/]+\//u, "/bot<token>/") });
    if (url.host === "api.telegram.org") {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(url.pathname);
      return match ? telegram(match[1]!, match[2]!, init) : json(404, { ok: false, error_code: 404, description: "Not Found" });
    }
    if (url.host === "discord.com" && url.pathname.startsWith("/api/v10/")) {
      return discord(method, url.pathname.slice("/api/v10".length), init);
    }
    throw new Error(`simulated_api_blocked_host:${url.host}`);
  }) as typeof fetch;

  return { fetchImpl, requests };
}

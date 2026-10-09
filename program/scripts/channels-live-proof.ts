// Marketplace Channels P1 "1j" live proof (spec section 10 acceptance, items 1 to 8).
//
//   pnpm -C program exec tsx scripts/channels-live-proof.ts
//
// Default is a DRY RUN: the same flow against a simulated Telegram/Discord API, no network, no tokens.
// A LIVE run posts a few tagged messages to TEST chats. It starts only when every interlock below holds:
//   CHANNELS_LIVE_PROOF=I_UNDERSTAND_THIS_POSTS_TO_TEST_CHATS
//   MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN / MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN (env only, never printed)
//   CHANNELS_LIVE_TELEGRAM_CHAT_IDS / CHANNELS_LIVE_DISCORD_CHANNEL_IDS (comma separated allowlists)
//   destinations that are not public (no Telegram username; Discord @everyone cannot view, or CHANNELS_LIVE_ALLOW_VISIBLE=1)
// Optional: CHANNELS_LIVE_PROVIDERS=telegram,discord (subset), CHANNELS_LIVE_OUT=<evidence directory>.
// See docs/channels-live-proof.md.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import type { InjectOptions } from "fastify";

import { CHANNEL_TOKEN_ENV, defaultChannelProviders } from "../src/channels/runtime.js";
import {
  DISCORD_TOKEN,
  GRANT_A,
  SERVICE,
  TELEGRAM_TOKEN,
  TENANT,
  channelFixture,
  type ChannelFixture,
} from "../src/channels/app-fixture.js";
import { createSimulatedApi, SIM_DISCORD_CHANNEL_ID, SIM_TELEGRAM_CHAT_ID, type SimOptions } from "./lib/channels-proof-sim.js";

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

export type ProviderId = "telegram" | "discord";
export type ProofMode = "dry-run" | "live";
export type StepStatus = "PASS" | "FAIL" | "SKIP";

export const LIVE_PHRASE = "I_UNDERSTAND_THIS_POSTS_TO_TEST_CHATS";
export const MAX_POSTS_PER_PROVIDER = 12;
export const ALLOWLIST_ENV: Readonly<Record<ProviderId, string>> = {
  telegram: "CHANNELS_LIVE_TELEGRAM_CHAT_IDS",
  discord: "CHANNELS_LIVE_DISCORD_CHANNEL_IDS",
};
const ALL_PROVIDERS: readonly ProviderId[] = ["telegram", "discord"];

export type RunConfig = {
  mode: ProofMode;
  providers: ProviderId[];
  tokens: Partial<Record<ProviderId, string>>;
  allowlist: Record<ProviderId, string[]>;
  allowVisible: boolean;
  /** Provider HTTP. Live: the real fetch. Dry run and tests: the simulated API. */
  fetchImpl: typeof fetch;
  /** True only when `fetchImpl` reaches the real services. Otherwise global fetch is blocked during the run. */
  realNetwork: boolean;
  clock: Clock;
  out: (line: string) => void;
  runId?: string;
};

export type Interlocks =
  | { mode: "dry-run" }
  | { mode: "live"; providers: ProviderId[]; tokens: Partial<Record<ProviderId, string>>; allowlist: Record<ProviderId, string[]>; allowVisible: boolean }
  | { mode: "refused"; missing: string[] };

export type Clock = { now(): number; sleep(ms: number): Promise<void>; virtual: boolean };

export type StepRecord = {
  n: number;
  provider: ProviderId | "all";
  spec: string;
  title: string;
  status: StepStatus;
  evidence: Record<string, unknown>;
  failures: string[];
  note?: string;
};

export type PostRecord = {
  provider: ProviderId;
  tag: string;
  channelRole: string;
  http: number | null;
  receiptStatus: string | null;
  resultIds: string[];
  resultUrls: string[];
};

export type ProofReport = {
  runId: string;
  mode: ProofMode;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  aborted: string | null;
  providers: ProviderId[];
  liveSettings: Record<string, unknown>;
  steps: StepRecord[];
  posts: PostRecord[];
  providerPosts: Record<string, { attempted: number; delivered: number; limit: number }>;
  requestSummary: Record<string, number>;
  hygiene: { checked: string[]; leaks: string[] };
  cleanup: string[];
};

class ProofAbort extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Interlocks
// ---------------------------------------------------------------------------------------------------------------

const TELEGRAM_TOKEN_SHAPE = /^[0-9]+:[A-Za-z0-9_-]+$/u;
const DISCORD_TOKEN_SHAPE = /^[\x21-\x7e]+$/u;
const TELEGRAM_ID_SHAPE = /^-?[0-9]{1,20}$/u;
const SNOWFLAKE_SHAPE = /^[0-9]{1,25}$/u;

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Decides dry run, live or refused from the environment. It never returns or prints a token value. */
export function evaluateInterlocks(env: Record<string, string | undefined>, argv: readonly string[] = []): Interlocks {
  const missing: string[] = [];
  if (argv.length > 0) {
    missing.push("no command-line arguments are accepted (tokens and ids come from the environment only)");
  }
  const flag = env.CHANNELS_LIVE_PROOF?.trim();
  if (!flag) {
    return missing.length > 0 ? { mode: "refused", missing } : { mode: "dry-run" };
  }
  if (flag !== LIVE_PHRASE) {
    missing.push(`CHANNELS_LIVE_PROOF must equal ${LIVE_PHRASE}`);
  }
  const requested = parseList(env.CHANNELS_LIVE_PROVIDERS);
  const providers = (requested.length > 0 ? requested : [...ALL_PROVIDERS]) as string[];
  const unknown = providers.filter((provider) => !(ALL_PROVIDERS as readonly string[]).includes(provider));
  if (unknown.length > 0) missing.push("CHANNELS_LIVE_PROVIDERS may only list telegram and discord");
  const selected = providers.filter((provider): provider is ProviderId => (ALL_PROVIDERS as readonly string[]).includes(provider));
  const tokens: Partial<Record<ProviderId, string>> = {};
  const allowlist: Record<ProviderId, string[]> = { telegram: [], discord: [] };
  for (const provider of selected) {
    const tokenEnv = CHANNEL_TOKEN_ENV[provider];
    const token = env[tokenEnv]?.trim();
    if (!token) missing.push(`${tokenEnv} (bot token of the ${provider} TEST bot)`);
    else if (!(provider === "telegram" ? TELEGRAM_TOKEN_SHAPE : DISCORD_TOKEN_SHAPE).test(token)) missing.push(`${tokenEnv} is set but malformed`);
    else tokens[provider] = token;
    const listEnv = ALLOWLIST_ENV[provider];
    const ids = parseList(env[listEnv]);
    if (ids.length === 0) missing.push(`${listEnv} (comma separated ${provider} TEST destination ids)`);
    else if (!ids.every((id) => (provider === "telegram" ? TELEGRAM_ID_SHAPE : SNOWFLAKE_SHAPE).test(id))) missing.push(`${listEnv} has an entry that is not a numeric id`);
    else allowlist[provider] = ids;
  }
  if (selected.length === 0) missing.push("no provider selected");
  if (missing.length > 0) return { mode: "refused", missing };
  return { mode: "live", providers: selected, tokens, allowlist, allowVisible: env.CHANNELS_LIVE_ALLOW_VISIBLE?.trim() === "1" };
}

// ---------------------------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------------------------

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  virtual: false,
};

/** Sleeping advances the virtual time instantly: the dry run covers minutes of waiting in milliseconds. */
export function virtualClock(start = Date.now()): Clock {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    virtual: true,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Request log and the transport guard (the only way the providers reach the network)
// ---------------------------------------------------------------------------------------------------------------

type RequestHints = {
  messageId?: string;
  hasPhoto?: boolean;
  voiceDuration?: number;
  hasCaption?: boolean;
  mentionEveryone?: boolean;
  mentions?: number;
  attachmentTypes?: string[];
  hasTranscript?: boolean;
};

export type ProofRequest = {
  seq: number;
  provider: ProviderId;
  op: string;
  isSend: boolean;
  destination?: string;
  http: number | null;
  delivered: boolean;
  /** Discord only: `allowed_mentions.parse` of the request, null when absent. */
  allowedMentionsParse?: string[] | null;
  hints: RequestHints;
};

const TELEGRAM_READ_METHODS = new Set(["getMe", "getUpdates", "getChat"]);
const TELEGRAM_SEND_METHODS = new Set(["sendMessage", "sendPhoto", "sendVoice", "sendDocument", "sendAudio", "sendVideo", "sendMediaGroup"]);

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : undefined;
}

function bodyFields(body: unknown): { json?: Record<string, any>; form?: FormData } {
  if (typeof body === "string") {
    try {
      return { json: asRecord(JSON.parse(body)) };
    } catch {
      return {};
    }
  }
  if (body instanceof FormData) return { form: body };
  return {};
}

/** The only transport the providers get: allowed hosts and methods only, destinations on the allowlist only, a hard send budget. */
export function createGuardedFetch(input: {
  base: typeof fetch;
  allowlist: Record<ProviderId, Set<string>>;
  log: ProofRequest[];
  maxSends?: number;
}): typeof fetch {
  const sendAttempts: Record<ProviderId, number> = { telegram: 0, discord: 0 };
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url));
    const method = (init?.method ?? "GET").toUpperCase();
    const fields = bodyFields(init?.body);
    let provider: ProviderId;
    let op: string;
    let isSend = false;
    let destination: string | undefined;

    if (target.host === "api.telegram.org") {
      const match = /^\/bot[^/]+\/([A-Za-z]+)$/u.exec(target.pathname);
      const telegramMethod = match?.[1];
      if (method !== "POST" || !telegramMethod || (!TELEGRAM_READ_METHODS.has(telegramMethod) && !TELEGRAM_SEND_METHODS.has(telegramMethod))) {
        throw new Error("proof_transport_blocked: unexpected Telegram request");
      }
      provider = "telegram";
      op = telegramMethod;
      isSend = TELEGRAM_SEND_METHODS.has(telegramMethod);
      const chat = fields.json?.chat_id ?? fields.form?.get("chat_id");
      destination = chat === undefined || chat === null ? undefined : String(chat);
      if ((isSend || op === "getChat") && (!destination || !input.allowlist.telegram.has(destination))) {
        throw new Error("proof_transport_blocked: Telegram destination is not on the allowlist");
      }
    } else if (target.host === "discord.com" && target.pathname.startsWith("/api/v10/")) {
      const apiPath = target.pathname.slice("/api/v10".length);
      provider = "discord";
      if (method === "GET" && apiPath === "/users/@me") op = "me";
      else if (method === "GET" && apiPath === "/users/@me/guilds") op = "guilds";
      else if (method === "GET" && /^\/guilds\/\d+\/channels$/u.test(apiPath)) op = "guildChannels";
      else if (method === "GET" && /^\/guilds\/\d+\/roles$/u.test(apiPath)) op = "guildRoles";
      else if (method === "POST" && /^\/channels\/\d+\/messages$/u.test(apiPath)) {
        op = "createMessage";
        isSend = true;
        destination = apiPath.split("/")[2];
        if (!destination || !input.allowlist.discord.has(destination)) {
          throw new Error("proof_transport_blocked: Discord destination is not on the allowlist");
        }
      } else throw new Error("proof_transport_blocked: unexpected Discord request");
    } else {
      throw new Error("proof_transport_blocked: host is not api.telegram.org or discord.com");
    }

    if (isSend) {
      sendAttempts[provider] += 1;
      if (sendAttempts[provider] > (input.maxSends ?? MAX_POSTS_PER_PROVIDER)) {
        throw new Error("proof_transport_blocked: send budget exceeded");
      }
    }
    let allowedMentionsParse: string[] | null | undefined;
    if (provider === "discord" && isSend) {
      let payload = fields.json;
      if (fields.form) {
        const raw = fields.form.get("payload_json");
        payload = typeof raw === "string" ? asRecord(JSON.parse(raw)) : undefined;
      }
      const parse = asRecord(payload?.allowed_mentions)?.parse;
      allowedMentionsParse = Array.isArray(parse) ? parse.map(String) : null;
    }

    const entry: ProofRequest = {
      seq: input.log.length + 1,
      provider,
      op,
      isSend,
      ...(destination ? { destination } : {}),
      http: null,
      delivered: false,
      ...(allowedMentionsParse !== undefined ? { allowedMentionsParse } : {}),
      hints: {},
    };
    input.log.push(entry);
    const response = await input.base(url, init);
    entry.http = response.status;
    if (isSend && response.ok) {
      entry.delivered = true;
      try {
        const reply = asRecord(await response.clone().json());
        if (provider === "telegram") {
          const result = asRecord(reply?.result);
          entry.hints = {
            messageId: result?.message_id === undefined ? undefined : String(result.message_id),
            hasPhoto: Array.isArray(result?.photo),
            voiceDuration: typeof asRecord(result?.voice)?.duration === "number" ? asRecord(result?.voice)!.duration : undefined,
            hasCaption: typeof result?.caption === "string",
          };
        } else {
          const attachments = Array.isArray(reply?.attachments) ? reply.attachments : [];
          entry.hints = {
            messageId: typeof reply?.id === "string" ? reply.id : undefined,
            mentionEveryone: typeof reply?.mention_everyone === "boolean" ? reply.mention_everyone : undefined,
            mentions: Array.isArray(reply?.mentions) ? reply.mentions.length : undefined,
            attachmentTypes: attachments.map((attachment: unknown) => String(asRecord(attachment)?.content_type ?? "")),
            hasTranscript: typeof reply?.content === "string" && reply.content.includes("Transcript:"),
          };
        }
      } catch {
        // The adapter judges the reply; the hints are only extra evidence.
      }
    }
    return response;
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------------
// Test payloads
// ---------------------------------------------------------------------------------------------------------------

/** A 64x64 PNG of teal bricks on burgundy mortar. Deterministic. */
export function buildBrickPng(): Buffer {
  const size = 64;
  const teal = [0x0f, 0x76, 0x6e];
  const burgundy = [0x6b, 0x1e, 0x2e];
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    const course = Math.floor(y / 8);
    const mortarRow = y % 8 === 7;
    for (let x = 0; x < size; x += 1) {
      const shifted = (x + (course % 2 === 0 ? 0 : 8)) % 16;
      const colour = mortarRow || shifted === 15 ? burgundy : teal;
      row.set(colour, 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const SILENCE_OGG_PATH = fileURLToPath(new URL("./fixtures/silence-1s.ogg", import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

type Json = Record<string, any>;
type Res = { statusCode: number; body: string };
type Channel = { id: string; slug: string; connectionId: string; provider: string };
type Role = "caps" | "features" | "approval" | "revoke" | "ungranted";

const jsonOf = (res: Res): Json => {
  try {
    return JSON.parse(res.body) as Json;
  } catch {
    return {};
  }
};

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Ids only. A Telegram id without a leading minus is a personal chat: it is hashed. */
export function idRef(provider: ProviderId, id: string): string {
  return provider === "telegram" && !id.startsWith("-") ? `personal:${sha(id).slice(0, 12)}` : id;
}

function compact(evidence: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${text}`);
  }
  const line = parts.join(" ");
  return line.length > 400 ? `${line.slice(0, 397)}...` : line;
}

class StepScope {
  evidence: Record<string, unknown> = {};
  failures: string[] = [];
  skipReason: string | null = null;
  ev(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) if (value !== undefined) this.evidence[key] = value;
  }
  expect(condition: unknown, label: string) {
    if (!condition) this.failures.push(label);
  }
  skip(reason: string) {
    this.skipReason = reason;
  }
}

type Ctx = ReturnType<typeof createContext>;

function createContext(config: RunConfig, runId: string, f: ChannelFixture, requestLog: ProofRequest[], secrets: string[]) {
  const steps: StepRecord[] = [];
  const posts: PostRecord[] = [];
  const bodies: string[] = [];
  const rawOutput: string[] = [];
  let keySequence = 0;
  let tagSequence = 0;
  const scrub = (text: string): string => secrets.reduce((value, secret) => (secret ? value.split(secret).join("[redacted-token]") : value), text);
  const say = (line: string) => {
    rawOutput.push(line);
    config.out(scrub(line));
  };
  const inject = async (request: InjectOptions): Promise<Res> => {
    const res = await f.app.inject(request);
    bodies.push(res.body);
    return res;
  };
  const owner = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers });
  const agent = (method: "GET" | "POST", url: string, input: { payload?: unknown; key?: string | null; token?: string } = {}) =>
    inject({
      method,
      url,
      headers: { authorization: `Bearer ${input.token ?? GRANT_A}`, ...(input.key ? { "idempotency-key": input.key } : {}) },
      ...(input.payload !== undefined ? { payload: input.payload as Record<string, unknown> } : {}),
    });
  const nextKey = (prefix: string) => `proof-${runId}-${prefix}-${String(++keySequence).padStart(3, "0")}`;
  const nextTag = () => `[tealbrick channels proof ${runId} step ${++tagSequence}]`;
  const sends = (provider: ProviderId) => requestLog.filter((entry) => entry.provider === provider && entry.isSend);
  const deliveredCount = (provider: ProviderId) => sends(provider).filter((entry) => entry.delivered).length;

  async function step(
    provider: ProviderId | "all",
    spec: string,
    title: string,
    body: (scope: StepScope) => Promise<void>,
  ): Promise<StepStatus> {
    const scope = new StepScope();
    try {
      await body(scope);
    } catch (error) {
      if (error instanceof ProofAbort) {
        scope.failures.push(error.message);
        steps.push({ n: steps.length + 1, provider, spec, title, status: "FAIL", evidence: scope.evidence, failures: scope.failures });
        say(`[FAIL] ${provider} ${spec} ${title} :: ${scrub(error.message)}`);
        throw error;
      }
      scope.failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`);
    }
    const status: StepStatus = scope.failures.length > 0 ? "FAIL" : scope.skipReason ? "SKIP" : "PASS";
    const record: StepRecord = {
      n: steps.length + 1,
      provider,
      spec,
      title,
      status,
      evidence: JSON.parse(scrub(JSON.stringify(scope.evidence))) as Record<string, unknown>,
      failures: scope.failures.map(scrub),
      ...(scope.skipReason ? { note: scope.skipReason } : {}),
    };
    steps.push(record);
    const detail = status === "FAIL" ? `FAILED CHECKS: ${record.failures.join("; ")} | ${compact(record.evidence)}` : status === "SKIP" ? scope.skipReason : compact(record.evidence);
    say(`[${status}] ${provider} ${spec} ${title} :: ${detail}`);
    return status;
  }

  const receiptEvidence = (res: Res) => {
    const body = jsonOf(res);
    const receipt = asRecord(body.receipt);
    return {
      http: res.statusCode,
      error: typeof body.error === "string" ? body.error : undefined,
      receiptStatus: receipt?.status,
      resultIds: receipt?.resultIds,
      resultUrls: receipt?.resultUrls,
      retryAfterSeconds: body.retryAfterSeconds,
      authorityKind: typeof receipt?.authority === "string" ? String(receipt.authority).split(":")[0] : undefined,
      fallback: receipt?.fallback,
    };
  };

  const recordPost = (provider: ProviderId, tag: string, channelRole: Role, res: Res) => {
    const body = jsonOf(res);
    const receipt = asRecord(body.receipt);
    posts.push({
      provider,
      tag,
      channelRole,
      http: res.statusCode,
      receiptStatus: typeof receipt?.status === "string" ? receipt.status : typeof body.error === "string" ? body.error : null,
      resultIds: Array.isArray(receipt?.resultIds) ? receipt.resultIds.map(String) : [],
      resultUrls: Array.isArray(receipt?.resultUrls) ? receipt.resultUrls.map(String) : [],
    });
  };

  return {
    config,
    runId,
    f,
    steps,
    posts,
    bodies,
    rawOutput,
    requestLog,
    secrets,
    say,
    scrub,
    owner,
    agent,
    inject,
    nextKey,
    nextTag,
    sends,
    deliveredCount,
    step,
    receiptEvidence,
    recordPost,
    clock: config.clock,
  };
}

const AGENT = "/api/marketplace/v1/agent/channels";
const OWNER = "/api/marketplace/channels";
const URL_SHAPE: Record<ProviderId, RegExp> = {
  telegram: /^https:\/\/t\.me\/(c\/[0-9]+|[A-Za-z][A-Za-z0-9_]{3,31})(\/[0-9]+)?\/[0-9]+$/u,
  discord: /^https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/[0-9]+$/u,
};
const PROOF_CAMPAIGN_REF = (runId: string) => `https://example.com/tealbrick-channels-proof/${runId}`;

type Destination = { type: string; externalId: string; title: string; url?: string; parentId?: string };

// ---------------------------------------------------------------------------------------------------------------
// Phase A: read-only checks (credentials, discovery, destination safety)
// ---------------------------------------------------------------------------------------------------------------

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;

async function destinationSafety(ctx: Ctx, provider: ProviderId, destination: Destination, guarded: typeof fetch, token: string): Promise<{ safe: boolean; detail: Record<string, unknown>; unknown?: string }> {
  if (provider === "telegram") {
    const publicByDiscovery = Boolean(destination.url);
    let publicUsername = publicByDiscovery;
    let chatType: string | undefined;
    try {
      const response = await guarded(`https://api.telegram.org/bot${token}/getChat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: destination.externalId }),
      });
      const chat = asRecord(asRecord(await response.json())?.result);
      chatType = typeof chat?.type === "string" ? chat.type : undefined;
      if (typeof chat?.username === "string" && chat.username.length > 0) publicUsername = true;
    } catch {
      // getChat is a second opinion; discovery already says whether the chat has a public username.
    }
    return { safe: !publicUsername, detail: { publicUsername, chatType } };
  }
  const guildId = destination.parentId;
  if (!guildId) return { safe: true, detail: {}, unknown: "the discovered Discord channel has no guild id" };
  const get = async (suffix: string) => {
    const response = await guarded(`https://discord.com/api/v10/guilds/${guildId}/${suffix}`, {
      method: "GET",
      headers: { authorization: `Bot ${token}`, "user-agent": "DiscordBot (https://tealbrick.com, 1)" },
    });
    return response.ok ? ((await response.json()) as unknown) : null;
  };
  try {
    const roles = await get("roles");
    const channels = await get("channels");
    const everyone = Array.isArray(roles) ? roles.map(asRecord).find((role) => role?.id === guildId) : undefined;
    const channel = Array.isArray(channels) ? channels.map(asRecord).find((entry) => entry?.id === destination.externalId) : undefined;
    if (!everyone || !channel || typeof everyone.permissions !== "string") {
      return { safe: true, detail: {}, unknown: "the Discord API data does not allow computing @everyone access (roles or channel overwrites unreadable)" };
    }
    let permissions = BigInt(everyone.permissions);
    const overwrite = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.map(asRecord).find((entry) => entry?.id === guildId) : undefined;
    if (overwrite) {
      permissions = (permissions & ~BigInt(String(overwrite.deny ?? "0"))) | BigInt(String(overwrite.allow ?? "0"));
    }
    const everyoneCanView = (permissions & VIEW_CHANNEL) !== 0n || (permissions & ADMINISTRATOR) !== 0n;
    return { safe: !everyoneCanView, detail: { everyoneCanView } };
  } catch {
    return { safe: true, detail: {}, unknown: "the Discord permission reads failed" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Phase B: one provider
// ---------------------------------------------------------------------------------------------------------------

type Prepared = { provider: ProviderId; destination: Destination; token: string };

async function proveProvider(ctx: Ctx, prepared: Prepared) {
  const { provider, destination } = prepared;
  const { f, clock } = ctx;
  const runId = ctx.runId;
  const channels = {} as Record<Role, Channel>;
  const consents = {} as Record<Role, { id: string }>;
  const grants = {} as Record<"caps" | "features" | "revoke", { id: string; status: string; digest: string }>;
  const ref = PROOF_CAMPAIGN_REF(runId);
  const expires = () => new Date(clock.now() + 7 * 86_400_000).toISOString();
  const sendsBefore = () => ctx.sends(provider).length;
  const deliveredBefore = () => ctx.deliveredCount(provider);

  const post = async (role: Role, body: Record<string, unknown>, key = ctx.nextKey("post")) => {
    const res = await ctx.agent("POST", `${AGENT}/${channels[role].id}/posts`, { payload: body, key });
    return res;
  };
  const sleepUntil = async (atMs: number, why: string) => {
    const wait = Math.max(0, atMs - clock.now()) + 1_000;
    ctx.say(`... ${provider}: waiting ${Math.ceil(wait / 1000)} s (${why})${clock.virtual ? " [virtual time]" : ""}`);
    await clock.sleep(wait);
  };

  // B1 Create channels. The live "caps" channel uses perDay 3 / minInterval 60 s (production default: 6 / 600 s).
  await ctx.step(provider, "§4.2", "discover again and create 5 channels on the allowlisted test destination", async (s) => {
    const discovered = await ctx.owner("GET", `${OWNER}/discover?provider=${provider}`);
    const list = (jsonOf(discovered).destinations ?? []) as Destination[];
    s.expect(discovered.statusCode === 200 && list.some((entry) => entry.externalId === destination.externalId), "the destination is still discoverable");
    const policies: Record<Role, Record<string, unknown>> = {
      caps: { standingGrants: "allowed", caps: { perDay: 3, minIntervalSeconds: 60, onePerPhase: true } },
      features: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, content: { files: { types: ["png", "audio/ogg"] } } },
      approval: { standingGrants: "disabled", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
      revoke: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
      ungranted: { standingGrants: "disabled", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
    };
    const slugBase = `proof-${runId}-${provider.slice(0, 2)}`;
    for (const role of Object.keys(policies) as Role[]) {
      const res = await ctx.owner(
        "POST",
        OWNER,
        {
          provider,
          slug: `${slugBase}-${role}`,
          label: `proof ${role}`,
          destination: { externalId: destination.externalId, ...(destination.parentId ? { parentId: destination.parentId } : {}) },
          purpose: "Tealbrick Channels live proof. Test posts only.",
          policy: policies[role],
        },
        { "idempotency-key": ctx.nextKey("create") },
      );
      s.expect(res.statusCode === 201, `channel ${role} created (http ${res.statusCode})`);
      channels[role] = jsonOf(res).channel as Channel;
    }
    s.ev({
      destination: idRef(provider, destination.externalId),
      channels: Object.keys(channels).length,
      liveCapsChannel: { perDay: 3, minIntervalSeconds: 60, onePerPhase: true },
      note: "caps channel is lowered from the production default (6 per day, 600 s) to keep the live run short; other channels use perDay 6, interval 0",
    });
  });
  if (Object.keys(channels).length < 5 || Object.values(channels).some((channel) => !channel?.id)) return;

  // B2 Consent (fake Portal consent, as in the fixture) for every channel except "ungranted".
  await ctx.step(provider, "§5.3", "grant 4 channels to the test agent (fake Portal consent); the 5th stays ungranted", async (s) => {
    for (const role of ["caps", "features", "approval", "revoke"] as const) {
      consents[role] = f.consentFor("agent-1", channels[role]);
    }
    const list = await ctx.agent("GET", AGENT);
    const ids = ((jsonOf(list).channels ?? []) as Array<{ id: string }>).map((entry) => entry.id);
    const ours = Object.values(channels).map((channel) => channel.id);
    s.ev({ http: list.statusCode, visibleToAgent: ids.filter((id) => ours.includes(id)).length });
    s.expect(["caps", "features", "approval", "revoke"].every((role) => ids.includes(channels[role as Role].id)), "the agent sees its 4 consented channels");
    s.expect(!ids.includes(channels.ungranted.id), "the ungranted channel is invisible to the agent");
  });

  // B3 Standing grants: propose -> owner approve; and §10.4 widening rules on the features channel.
  await ctx.step(provider, "§4.4 §10.1", "standing grant: agent proposes, owner approves (caps, revoke channels)", async (s) => {
    for (const role of ["caps", "revoke"] as const) {
      const caps = role === "caps" ? { perDay: 3, minIntervalSeconds: 60, onePerPhase: true } : { perDay: 6, minIntervalSeconds: 0, onePerPhase: true };
      const proposed = await ctx.agent("POST", `${AGENT}/${channels[role].id}/grants`, {
        key: ctx.nextKey("grant"),
        payload: { purpose: "tealbrick channels live proof", caps, scope: { files: false, immediate: true, scheduled: true }, expires: expires() },
      });
      s.expect(proposed.statusCode === 201 && jsonOf(proposed).grant?.status === "proposed", `${role}: proposal is proposed (http ${proposed.statusCode})`);
      const grantId = jsonOf(proposed).grant?.id as string;
      const sendsNow = sendsBefore();
      const before = await post(role, { text: ctx.nextTag() });
      s.expect(before.statusCode === 202, `${role}: a proposal alone authorises nothing (post is held, http ${before.statusCode})`);
      s.expect(sendsBefore() === sendsNow, "no send while the proposal is open");
      const approved = await ctx.owner("POST", `${OWNER}/grants/${grantId}/approve`, {});
      grants[role] = jsonOf(approved).grant;
      s.expect(approved.statusCode === 200 && grants[role]?.status === "active", `${role}: owner approval makes the grant active (http ${approved.statusCode})`);
      // The held per-payload approval of the check above is closed so that nothing waits in the queue.
      const held = jsonOf(before).approvalId as string | undefined;
      if (held) await ctx.owner("POST", `/api/marketplace/company-box/approvals/${held}/deny`, {});
    }
    s.ev({ grants: { caps: grants.caps?.status, revoke: grants.revoke?.status }, digestPrefixes: [grants.caps?.digest?.slice(0, 12), grants.revoke?.digest?.slice(0, 12)] });
  });

  await ctx.step(provider, "§10.4", "grant widening refused; owner narrows and approves; agent widening refused", async (s) => {
    const base = { purpose: "tealbrick channels live proof (features)", scope: { files: {}, immediate: true, scheduled: true }, expires: expires() };
    const wide = await ctx.agent("POST", `${AGENT}/${channels.features.id}/grants`, {
      key: ctx.nextKey("grant"),
      payload: { ...base, caps: { perDay: 10, minIntervalSeconds: 0, onePerPhase: true } },
    });
    s.ev({ wideProposalHttp: wide.statusCode, wideProposalError: jsonOf(wide).error, wideFields: jsonOf(wide).fields });
    s.expect(wide.statusCode === 422 && jsonOf(wide).error === "grant_exceeds_ceiling", "a proposal wider than the ceiling is refused with grant_exceeds_ceiling");
    const proposed = await ctx.agent("POST", `${AGENT}/${channels.features.id}/grants`, {
      key: ctx.nextKey("grant"),
      payload: { ...base, caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
    });
    s.expect(proposed.statusCode === 201, `a ceiling-sized proposal is accepted (http ${proposed.statusCode})`);
    const proposal = jsonOf(proposed).grant as { id: string; digest: string };
    const approved = await ctx.owner("POST", `${OWNER}/grants/${proposal?.id}/approve`, {
      final: { caps: { perDay: 5, minIntervalSeconds: 0, onePerPhase: true }, scope: base.scope, expires: base.expires },
    });
    grants.features = jsonOf(approved).grant;
    s.expect(approved.statusCode === 200 && grants.features?.status === "active", `the owner approves a narrower grant (http ${approved.statusCode})`);
    s.expect(jsonOf(approved).grant?.caps?.perDay === 5, "the approved grant carries the narrowed perDay 5");
    s.expect(grants.features?.digest !== proposal?.digest, "the approval binds the digest of the narrowed grant");
    const widen = await ctx.agent("POST", `${AGENT}/grants/${grants.features?.id}/narrow`, {
      key: ctx.nextKey("narrow"),
      payload: { caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, scope: base.scope, expires: base.expires },
    });
    s.ev({ narrowedPerDay: jsonOf(approved).grant?.caps?.perDay, agentWidenHttp: widen.statusCode, agentWidenError: jsonOf(widen).error, agentWidenFields: jsonOf(widen).fields });
    s.expect(widen.statusCode === 422 && jsonOf(widen).error === "grant_widening_refused", "an agent narrow that widens is refused with grant_widening_refused");
  });
  if (!grants.caps?.id || !grants.features?.id || !grants.revoke?.id) return;

  // B4 §10.1
  let firstCapsSentAt = clock.now();
  await ctx.step(provider, "§10.1", "post text under the standing grant (caps channel, announce)", async (s) => {
    const tag = ctx.nextTag();
    const res = await post("caps", { text: tag, campaign: { ref, phase: "announce" } });
    ctx.recordPost(provider, tag, "caps", res);
    const receipt = asRecord(jsonOf(res).receipt);
    s.ev({ ...ctx.receiptEvidence(res), tag });
    s.expect(res.statusCode === 200 && receipt?.status === "sent", `receipt is sent (http ${res.statusCode})`);
    s.expect(receipt?.authority === `grant:${grants.caps.id}`, "authority is the standing grant");
    s.expect(Array.isArray(receipt?.resultIds) && receipt.resultIds.length > 0, "the provider returned a message id");
    const urls = (receipt?.resultUrls ?? []) as string[];
    s.expect(
      urls.length > 0 && urls.every((url) => URL_SHAPE[provider].test(url)),
      provider === "telegram"
        ? "the receipt URL has the t.me message-link shape (a basic group has no message links: use a private supergroup)"
        : "the receipt URL has the discord.com message-link shape",
    );
    if (typeof receipt?.sentAt === "string") firstCapsSentAt = Date.parse(receipt.sentAt);
  });

  // B5 §10.2 refusals that need no waiting
  await ctx.step(provider, "§10.2", "fast post refused (min_interval), duplicate announce refused (phase), ungranted channel 404", async (s) => {
    const delivered = deliveredBefore();
    const fastTag = ctx.nextTag();
    const fast = await post("caps", { text: fastTag });
    ctx.recordPost(provider, fastTag, "caps", fast);
    s.ev({ fast: ctx.receiptEvidence(fast) });
    s.expect(fast.statusCode === 429 && jsonOf(fast).error === "channel_min_interval", "a post right after the last one is refused with channel_min_interval");
    s.expect(typeof jsonOf(fast).retryAfterSeconds === "number", "the refusal names retryAfterSeconds");
    const dupTag = ctx.nextTag();
    const duplicate = await post("caps", { text: dupTag, campaign: { ref, phase: "announce" } });
    ctx.recordPost(provider, dupTag, "caps", duplicate);
    s.ev({ duplicate: ctx.receiptEvidence(duplicate) });
    s.expect(duplicate.statusCode === 429 && jsonOf(duplicate).error === "channel_phase_duplicate", "a second announce for the same campaign ref is refused with channel_phase_duplicate");
    const unTag = ctx.nextTag();
    const ungranted = await post("ungranted", { text: unTag });
    ctx.recordPost(provider, unTag, "ungranted", ungranted);
    s.ev({ ungranted: ctx.receiptEvidence(ungranted) });
    s.expect(ungranted.statusCode === 404, "a post to a channel without consent returns 404");
    s.expect(deliveredBefore() === delivered, "none of the refused posts reached the provider");
  });

  // B6 §10.5 schedule two posts 70 s ahead and revoke one grant.
  const sendAt = clock.now() + 70_000;
  const scheduled: { sent?: { postId: string; tag: string }; revoked?: { postId: string; tag: string } } = {};
  await ctx.step(provider, "§10.5", "schedule two posts 70 s ahead; owner revokes one grant before sendAt", async (s) => {
    for (const [slot, role] of [["sent", "features"], ["revoked", "revoke"]] as const) {
      const tag = ctx.nextTag();
      const res = await ctx.agent("POST", `${AGENT}/${channels[role].id}/scheduled`, {
        key: ctx.nextKey("sched"),
        payload: { text: tag, sendAt: new Date(sendAt).toISOString() },
      });
      ctx.recordPost(provider, tag, role, res);
      const receipt = asRecord(jsonOf(res).receipt);
      s.ev({ [slot]: ctx.receiptEvidence(res) });
      s.expect(res.statusCode === 200 && receipt?.status === "pending", `${slot}: scheduled receipt is pending (http ${res.statusCode})`);
      scheduled[slot] = { postId: String(receipt?.postId ?? ""), tag };
    }
    const revoked = await ctx.owner("POST", `${OWNER}/grants/${grants.revoke.id}/revoke`, {});
    s.ev({ revokeHttp: revoked.statusCode });
    s.expect(revoked.statusCode === 200, "the owner revokes the grant of the second scheduled post");
  });

  // B7 §10.3 per-payload approval
  await ctx.step(provider, "§10.3", "no grant: 202 approval_pending, owner approves, sent once, changed text needs a new approval", async (s) => {
    const key = ctx.nextKey("hold");
    const tag = ctx.nextTag();
    const delivered = deliveredBefore();
    const sendsNow = sendsBefore();
    const held = await post("approval", { text: tag }, key);
    const pending = jsonOf(held);
    s.ev({ held: { http: held.statusCode, error: pending.error, digestPrefix: pending.digestPrefix } });
    s.expect(held.statusCode === 202 && pending.error === "approval_pending" && typeof pending.approvalId === "string", "the post returns 202 approval_pending");
    s.expect(sendsBefore() === sendsNow, "no provider call while the post is held");
    const approved = await ctx.owner("POST", `/api/marketplace/company-box/approvals/${pending.approvalId}/approve`, {});
    const approvedBody = jsonOf(approved);
    const receipt = asRecord(approvedBody.channel?.receipt);
    s.ev({ approvedHttp: approved.statusCode, approvalState: approvedBody.approval?.state, receiptStatus: receipt?.status, resultIds: receipt?.resultIds, resultUrls: receipt?.resultUrls });
    s.expect(approved.statusCode === 200 && receipt?.status === "sent", "the owner approval sends the post");
    s.expect(receipt?.digest === pending.digest, "the sent digest is the approved digest");
    s.expect(deliveredBefore() === delivered + 1, "exactly one message was delivered");
    ctx.posts.push({
      provider,
      tag,
      channelRole: "approval",
      http: approved.statusCode,
      receiptStatus: typeof receipt?.status === "string" ? receipt.status : null,
      resultIds: Array.isArray(receipt?.resultIds) ? receipt.resultIds.map(String) : [],
      resultUrls: Array.isArray(receipt?.resultUrls) ? receipt.resultUrls.map(String) : [],
    });
    const retry = await post("approval", { text: tag }, key);
    s.ev({ retry: { http: retry.statusCode, replayed: jsonOf(retry).replayed } });
    s.expect(retry.statusCode === 200 && jsonOf(retry).replayed === true, "the retry with the same key replays the receipt");
    s.expect(deliveredBefore() === delivered + 1, "the retry did not post again");
    const changed = await post("approval", { text: `${tag} edited` });
    const changedBody = jsonOf(changed);
    s.ev({ changed: { http: changed.statusCode, error: changedBody.error, newDigest: changedBody.digest !== pending.digest } });
    s.expect(changed.statusCode === 202 && changedBody.approvalId !== pending.approvalId && changedBody.digest !== pending.digest, "changed text needs a new approval with a new digest");
    if (typeof changedBody.approvalId === "string") await ctx.owner("POST", `/api/marketplace/company-box/approvals/${changedBody.approvalId}/deny`, {});
    s.expect(deliveredBefore() === delivered + 1, "the changed post was never sent");
  });

  // B8 §10.6 media and mentions on the features channel
  const png = buildBrickPng();
  const ogg = await readFile(SILENCE_OGG_PATH);
  const upload = async (name: string, contentType: string, bytes: Uint8Array) => {
    const res = await ctx.inject({
      method: "POST",
      url: `${AGENT}/attachments?name=${name}`,
      headers: { authorization: `Bearer ${GRANT_A}`, "idempotency-key": ctx.nextKey("upload"), "content-type": contentType },
      payload: Buffer.from(bytes),
    });
    return { res, id: String(jsonOf(res).attachmentId ?? "") };
  };
  let pngId = "";
  let oggId = "";
  await ctx.step(provider, "§10.6", "upload the test image and the 1 s silent OGG/Opus voice file", async (s) => {
    const image = await upload("proof-bricks.png", "image/png", png);
    const voice = await upload("proof-silence.ogg", "audio/ogg", ogg);
    pngId = image.id;
    oggId = voice.id;
    s.ev({ imageHttp: image.res.statusCode, voiceHttp: voice.res.statusCode, imageBytes: png.length, voiceBytes: ogg.length });
    s.expect(image.res.statusCode === 201 && pngId !== "", "image upload accepted");
    s.expect(voice.res.statusCode === 201 && oggId !== "", "voice upload accepted");
  });
  if (!pngId || !oggId) return;

  if (provider === "discord") {
    await ctx.step(provider, "§10.6", "text with @everyone and @here pings nobody (allowed_mentions.parse is empty)", async (s) => {
      const tag = ctx.nextTag();
      const from = ctx.requestLog.length;
      const res = await post("features", { text: `${tag} @everyone @here` });
      ctx.recordPost(provider, tag, "features", res);
      const sent = ctx.requestLog.slice(from).filter((entry) => entry.isSend && entry.delivered);
      const request = sent[0];
      s.ev({ ...ctx.receiptEvidence(res), allowedMentionsParse: request?.allowedMentionsParse, mentionEveryoneFlag: request?.hints.mentionEveryone, mentions: request?.hints.mentions });
      s.expect(res.statusCode === 200 && jsonOf(res).receipt?.status === "sent", "the post is sent");
      s.expect(sent.length === 1, "exactly one Discord message request");
      s.expect(Array.isArray(request?.allowedMentionsParse) && request?.allowedMentionsParse.length === 0, "the request carried allowed_mentions.parse = []");
      s.expect(request?.hints.mentionEveryone !== true, "the message object does not report mention_everyone");
    });
  }

  await ctx.step(provider, "§10.6", "photo with text (image attachment)", async (s) => {
    const tag = ctx.nextTag();
    const from = ctx.requestLog.length;
    const res = await post("features", { text: tag, attachments: [{ attachmentId: pngId, kind: "image" }] });
    ctx.recordPost(provider, tag, "features", res);
    const request = ctx.requestLog.slice(from).find((entry) => entry.isSend && entry.delivered);
    s.ev({ ...ctx.receiptEvidence(res), op: request?.op, hints: request?.hints });
    s.expect(res.statusCode === 200 && jsonOf(res).receipt?.status === "sent", "the post is sent");
    if (provider === "telegram") {
      s.expect(request?.op === "sendPhoto" && request.hints.hasPhoto === true, "sent with sendPhoto and the reply holds a photo");
      s.expect(request?.hints.hasCaption === true, "the text rides as the caption");
    } else {
      s.expect(request?.hints.attachmentTypes?.includes("image/png") === true, "the Discord message has the PNG attachment");
    }
  });

  await ctx.step(provider, "§10.6", provider === "telegram" ? "voice note via sendVoice (OGG/Opus, native voice message)" : "voice delivered as audio file + transcript (declared fallback)", async (s) => {
    const tag = ctx.nextTag();
    const from = ctx.requestLog.length;
    const res = await post("features", {
      text: tag,
      attachments: [{ attachmentId: oggId, kind: "voice", ...(provider === "discord" ? { transcript: "tealbrick channels proof, one second of silence" } : {}) }],
    });
    ctx.recordPost(provider, tag, "features", res);
    const request = ctx.requestLog.slice(from).find((entry) => entry.isSend && entry.delivered);
    s.ev({ ...ctx.receiptEvidence(res), op: request?.op, hints: request?.hints });
    s.expect(res.statusCode === 200 && jsonOf(res).receipt?.status === "sent", "the post is sent");
    if (provider === "telegram") {
      s.expect(request?.op === "sendVoice", "the adapter used sendVoice");
      s.expect(typeof request?.hints.voiceDuration === "number" && request.hints.voiceDuration > 0, "Telegram returned a voice message with a duration (plays as a voice note)");
      s.expect(jsonOf(res).receipt?.fallback === undefined, "no fallback was applied");
    } else {
      s.expect(jsonOf(res).receipt?.fallback === "voice→audio+transcript", "the receipt names the voice fallback");
      s.expect(request?.hints.attachmentTypes?.some((type) => type.startsWith("audio/")) === true, "the message has an audio file attachment");
      s.expect(request?.hints.hasTranscript === true, "the message text carries the transcript");
    }
  });

  await ctx.step(provider, "§10.6", "an undeclared kind (poll) is refused with channel_capability_unavailable", async (s) => {
    const delivered = deliveredBefore();
    const tag = ctx.nextTag();
    const res = await post("features", { text: tag, attachments: [{ attachmentId: oggId, kind: "poll" }] });
    ctx.recordPost(provider, tag, "features", res);
    s.ev(ctx.receiptEvidence(res));
    s.expect(res.statusCode === 422 && jsonOf(res).error === "channel_capability_unavailable", "the poll is refused with channel_capability_unavailable");
    s.expect(deliveredBefore() === delivered, "nothing was sent");
  });

  // B9 §10.5 scheduler
  await ctx.step(provider, "§10.5", "scheduler tick sends the due post under its grant; the revoked-grant post is skipped", async (s) => {
    await sleepUntil(sendAt, "until sendAt");
    const deadline = sendAt + 150_000;
    const final = new Set(["sent", "skipped", "failed", "expired", "cancelled", "uncertain"]);
    const statusOf = async (postId: string, role: Role) => {
      const res = await ctx.agent("GET", `${AGENT}/receipts?channelId=${channels[role].id}`);
      const receipt = ((jsonOf(res).receipts ?? []) as Json[]).find((entry) => entry.postId === postId);
      return receipt;
    };
    let ticks = 0;
    let sentReceipt: Json | undefined;
    let skippedReceipt: Json | undefined;
    while (clock.now() < deadline) {
      await f.runtime.tick(new Date(clock.now()));
      ticks += 1;
      sentReceipt = await statusOf(scheduled.sent?.postId ?? "", "features");
      skippedReceipt = await statusOf(scheduled.revoked?.postId ?? "", "revoke");
      if (final.has(String(sentReceipt?.status)) && final.has(String(skippedReceipt?.status))) break;
      await clock.sleep(5_000);
    }
    const skippedPost = f.store.channels.getPost(TENANT, scheduled.revoked?.postId ?? "");
    s.ev({
      ticks,
      sent: { status: sentReceipt?.status, resultIds: sentReceipt?.resultIds, resultUrls: sentReceipt?.resultUrls, authorityKind: String(sentReceipt?.authority ?? "").split(":")[0] },
      skipped: { status: skippedReceipt?.status, reason: skippedPost?.reason },
    });
    s.expect(sentReceipt?.status === "sent", "the scheduled post under the active grant was sent");
    s.expect(((sentReceipt?.resultUrls ?? []) as string[]).every((url) => URL_SHAPE[provider].test(url)) && (sentReceipt?.resultUrls ?? []).length > 0, "the sent receipt has a message link");
    s.expect(skippedReceipt?.status === "skipped", "the post whose grant was revoked before sendAt ended skipped");
    for (const [slot, role] of [["sent", "features"], ["revoked", "revoke"]] as const) {
      const entry = postsOf(ctx, provider).find((candidate) => candidate.tag === scheduled[slot]?.tag);
      const receipt = slot === "sent" ? sentReceipt : skippedReceipt;
      if (entry && receipt) {
        entry.receiptStatus = String(receipt.status);
        entry.resultIds = Array.isArray(receipt.resultIds) ? receipt.resultIds.map(String) : [];
        entry.resultUrls = Array.isArray(receipt.resultUrls) ? receipt.resultUrls.map(String) : [];
      }
      void role;
    }
  });

  // B10 §10.2 daily cap on the caps channel
  await ctx.step(provider, "§10.2", "caps channel: posts 2 and 3 are sent, the 4th is refused with channel_cap_per_day", async (s) => {
    let last = firstCapsSentAt;
    for (const phase of ["reminder", "recap"] as const) {
      await sleepUntil(last + 60_000, `minimum interval before the ${phase} post`);
      const tag = ctx.nextTag();
      const res = await post("caps", { text: tag, campaign: { ref, phase } });
      ctx.recordPost(provider, tag, "caps", res);
      const receipt = asRecord(jsonOf(res).receipt);
      s.ev({ [phase]: ctx.receiptEvidence(res) });
      s.expect(res.statusCode === 200 && receipt?.status === "sent", `${phase}: sent (http ${res.statusCode})`);
      last = typeof receipt?.sentAt === "string" ? Date.parse(receipt.sentAt) : clock.now();
    }
    const delivered = deliveredBefore();
    const tag = ctx.nextTag();
    const fourth = await post("caps", { text: tag, campaign: { ref, phase: "update" } });
    ctx.recordPost(provider, tag, "caps", fourth);
    s.ev({ fourth: ctx.receiptEvidence(fourth) });
    s.expect(fourth.statusCode === 429 && jsonOf(fourth).error === "channel_cap_per_day", "the 4th post of the day (live ceiling perDay 3) is refused with channel_cap_per_day");
    s.expect(deliveredBefore() === delivered, "the refused post never reached the provider");
  });

  // B11 §10.7 consent revoke
  await ctx.step(provider, "§10.7", "Portal consent revoked: the grant is suspended and the next post is refused", async (s) => {
    const delivered = deliveredBefore();
    const revoked = await ctx.inject({
      method: "POST",
      url: `/api/marketplace/agent/grants/${consents.features.id}/revoke`,
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: {},
    });
    const grant = f.store.channels.getStandingGrant(TENANT, grants.features.id);
    const tag = ctx.nextTag();
    const after = await post("features", { text: tag });
    ctx.recordPost(provider, tag, "features", after);
    s.ev({ revokeHttp: revoked.statusCode, grantStatus: grant?.status, grantReason: grant?.decidedReason, next: ctx.receiptEvidence(after) });
    s.expect(revoked.statusCode === 200, "the consent revoke call succeeded");
    s.expect(grant?.status === "suspended", "the standing grant is suspended");
    s.expect(after.statusCode === 404, "the next post is refused (the channel is gone for this agent)");
    s.expect(deliveredBefore() === delivered, "nothing was sent after the revoke");
  });

  if (provider === "discord") {
    await ctx.step(provider, "§10.6", "a Discord 429 is retried once", async (s) => {
      s.skip("cannot be forced against the live API without abusing the rate limit; covered by program/src/channels/providers/discord.test.ts");
    });
  }
}

const postsOf = (ctx: Ctx, provider: ProviderId) => ctx.posts.filter((entry) => entry.provider === provider);

// ---------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------

function newRunId(): string {
  return `p${Date.now().toString(36).slice(-6)}${randomBytes(2).toString("hex")}`;
}

export function dryRunConfig(overrides: Partial<RunConfig> & { sim?: Partial<SimOptions> } = {}): RunConfig {
  const { sim, ...rest } = overrides;
  const simulated = createSimulatedApi({ telegramToken: TELEGRAM_TOKEN, discordToken: DISCORD_TOKEN, ...sim });
  return {
    mode: "dry-run",
    providers: ["telegram", "discord"],
    tokens: { telegram: TELEGRAM_TOKEN, discord: DISCORD_TOKEN },
    allowlist: { telegram: [SIM_TELEGRAM_CHAT_ID], discord: [SIM_DISCORD_CHANNEL_ID] },
    allowVisible: false,
    fetchImpl: simulated.fetchImpl,
    realNetwork: false,
    clock: virtualClock(),
    out: (line) => void process.stdout.write(`${line}\n`),
    ...rest,
  };
}

export function liveConfig(interlocks: Extract<Interlocks, { mode: "live" }>, overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    mode: "live",
    providers: interlocks.providers,
    tokens: interlocks.tokens,
    allowlist: interlocks.allowlist,
    allowVisible: interlocks.allowVisible,
    fetchImpl: globalThis.fetch.bind(globalThis),
    realNetwork: true,
    clock: realClock,
    out: (line) => void process.stdout.write(`${line}\n`),
    ...overrides,
  };
}

const PLAN: string[] = [
  "A. read-only, every provider:  credentials (§8) / discover + allowlist (§4.2) / destination safety (interlock)",
  "B. posting, every provider:    5 channels on one test destination (caps channel: perDay 3, minInterval 60 s for the live run)",
  "                               fake Portal consent / standing grant propose + owner approve / grant widening (§10.4)",
  "                               §10.1 post under grant / §10.2 min_interval, duplicate phase, 404 / schedule 70 s ahead + revoke (§10.5)",
  "                               §10.3 per-payload approval / §10.6 photo, voice, @everyone (Discord), undeclared kind",
  "                               scheduler tick (§10.5) / §10.2 daily cap (4th post) / §10.7 consent revoke",
  "C. hygiene (§10.8):            tokens absent from DB files, responses, logs and the evidence report",
];

export async function runChannelsProof(config: RunConfig): Promise<ProofReport> {
  const runId = config.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  const secrets = Object.values(config.tokens).flatMap((token) => {
    if (!token) return [];
    const secretPart = token.includes(":") ? token.split(":")[1] : undefined;
    return [token, `bot${token}`, ...(secretPart && secretPart.length >= 16 ? [secretPart] : [])];
  });
  const requestLog: ProofRequest[] = [];
  const guarded = createGuardedFetch({
    base: config.fetchImpl,
    allowlist: { telegram: new Set(config.allowlist.telegram), discord: new Set(config.allowlist.discord) },
    log: requestLog,
  });
  const environment: Record<string, string | undefined> = {
    MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: config.providers.includes("telegram") ? config.tokens.telegram : undefined,
    MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: config.providers.includes("discord") ? config.tokens.discord : undefined,
  };

  const capturedLogs: string[] = [];
  const consoleOriginal = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const fetchOriginal = globalThis.fetch;
  const capture = (...args: unknown[]) => void capturedLogs.push(args.map(String).join(" "));
  console.log = console.info = console.warn = console.error = console.debug = capture;
  if (!config.realNetwork) {
    globalThis.fetch = (async () => {
      throw new Error("channels_live_proof_network_blocked");
    }) as typeof fetch;
  }

  const f = await channelFixture({
    environment,
    options: {
      channelProviders: defaultChannelProviders({ fetchImpl: guarded, sleep: (ms) => config.clock.sleep(ms), now: () => config.clock.now() }),
      channelClock: () => new Date(config.clock.now()),
    },
  });
  const ctx = createContext(config, runId, f, requestLog, secrets);
  let aborted: string | null = null;
  let hygiene: ProofReport["hygiene"] = { checked: [], leaks: [] };

  try {
    ctx.say(`Marketplace Channels live proof (spec §10) run ${runId}`);
    ctx.say(
      config.mode === "dry-run"
        ? "MODE: DRY RUN. Real provider adapters against a SIMULATED Telegram/Discord API, fake Portal consent. No network, no tokens, nothing is posted."
        : "MODE: LIVE. This run posts tagged messages to the allowlisted TEST destinations (real Telegram / Discord).",
    );
    ctx.say(`Providers: ${config.providers.join(", ")} | posting budget per provider: ${MAX_POSTS_PER_PROVIDER} | tag: "[tealbrick channels proof ${runId} step N]"`);
    for (const provider of config.providers) {
      ctx.say(`Allowlist ${provider}: ${config.allowlist[provider].map((id) => idRef(provider, id)).join(", ")}${provider === "discord" && config.allowVisible ? " (CHANNELS_LIVE_ALLOW_VISIBLE=1: @everyone visibility check is waived)" : ""}`);
    }
    ctx.say("Plan:");
    for (const line of PLAN) ctx.say(`  ${line}`);

    // Phase A
    const prepared: Prepared[] = [];
    try {
      for (const provider of config.providers) {
        const token = config.tokens[provider]!;
        const ready = await ctx.step(provider, "§8", "verify credentials (readiness and bot identity)", async (s) => {
          const res = await ctx.owner("GET", OWNER);
          const body = jsonOf(res);
          s.ev({ http: res.statusCode, readiness: body.readiness?.[provider], connection: body.connections?.[provider]?.state, credentialRef: body.connections?.[provider]?.credentialRef });
          s.expect(body.readiness?.[provider] === "available", "provider readiness is available");
          s.expect(body.connections?.[provider]?.state === "connected", "the connection is connected");
        });
        if (ready !== "PASS") throw new ProofAbort(`${provider}: credentials are not usable; nothing was posted`);
        let destination: Destination | undefined;
        const discovered = await ctx.step(provider, "§4.2", "discover and match the allowlist (other destinations are ignored)", async (s) => {
          const res = await ctx.owner("GET", `${OWNER}/discover?provider=${provider}`);
          const list = (jsonOf(res).destinations ?? []) as Destination[];
          destination = config.allowlist[provider].map((id) => list.find((entry) => entry.externalId === id)).find((entry) => entry !== undefined);
          s.ev({
            http: res.statusCode,
            discovered: list.length,
            ignoredNotAllowlisted: list.filter((entry) => !config.allowlist[provider].includes(entry.externalId)).length,
            matched: destination ? idRef(provider, destination.externalId) : null,
          });
          s.expect(res.statusCode === 200, "discovery succeeded");
          s.expect(
            Boolean(destination),
            provider === "telegram"
              ? "an allowlisted chat was discovered (add the bot to the test group and write one message there, then rerun)"
              : "an allowlisted channel was discovered (invite the bot with View Channels permission on that channel)",
          );
        });
        if (discovered !== "PASS" || !destination) throw new ProofAbort(`${provider}: no allowlisted destination was discovered; nothing was posted`);
        const found = destination;
        const safety = await ctx.step(provider, "interlock", "destination is not public", async (s) => {
          const result = await destinationSafety(ctx, provider, found, guarded, token);
          s.ev({ ...result.detail, destination: idRef(provider, found.externalId) });
          if (result.unknown) {
            s.ev({ visibilityCheck: `skipped: ${result.unknown}` });
            ctx.say(`NOTE ${provider}: the public-visibility check could not be computed (${result.unknown}). Verify by hand that the destination is private.`);
          }
          const waived = provider === "discord" && config.allowVisible;
          s.expect(result.safe || waived, provider === "telegram" ? "the Telegram chat has a public username: refused" : "@everyone can view the Discord channel: refused (set CHANNELS_LIVE_ALLOW_VISIBLE=1 to waive)");
          if (!result.safe && waived) s.ev({ waivedBy: "CHANNELS_LIVE_ALLOW_VISIBLE=1" });
        });
        if (safety !== "PASS") throw new ProofAbort(`${provider}: the destination is public; nothing was posted`);
        prepared.push({ provider, destination: found, token });
      }
    } catch (error) {
      if (error instanceof ProofAbort) aborted = error.message;
      else throw error;
    }

    // Phase B
    if (!aborted) {
      for (const entry of prepared) {
        ctx.say(`--- ${entry.provider}: posting phase (destination ${idRef(entry.provider, entry.destination.externalId)}) ---`);
        try {
          await proveProvider(ctx, entry);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.steps.push({ n: ctx.steps.length + 1, provider: entry.provider, spec: "run", title: "unexpected error in the proof script", status: "FAIL", evidence: {}, failures: [ctx.scrub(message)] });
          ctx.say(`[FAIL] ${entry.provider} run unexpected error: ${ctx.scrub(message)}`);
        }
        ctx.say(`${entry.provider}: ${ctx.deliveredCount(entry.provider)} message(s) delivered of ${MAX_POSTS_PER_PROVIDER} allowed (${ctx.sends(entry.provider).length} send request(s))`);
      }
    }

    // Phase C hygiene (§10.8)
    await ctx.step("all", "§10.8", "tokens appear nowhere: DB files, responses, logs, request log", async (s) => {
      await f.app.close();
      const corpora: Record<string, string[]> = {
        "database and data directory": [],
        "http responses": ctx.bodies,
        "captured logs and console": [...capturedLogs, ...ctx.rawOutput],
        "provider request log": [JSON.stringify(requestLog)],
      };
      const files: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else files.push(full);
        }
      };
      await walk(f.root);
      for (const file of files) corpora["database and data directory"]!.push((await readFile(file)).toString("latin1"));
      const leaks: string[] = [];
      for (const [name, texts] of Object.entries(corpora)) {
        for (const secret of secrets) if (secret && texts.some((text) => text.includes(secret))) leaks.push(name);
      }
      hygiene = { checked: Object.keys(corpora), leaks: [...new Set(leaks)] };
      s.ev({ files: files.length, responses: ctx.bodies.length, logLines: capturedLogs.length + ctx.rawOutput.length, requests: requestLog.length, leaks: hygiene.leaks.length });
      s.expect(hygiene.leaks.length === 0, `a token was found in: ${hygiene.leaks.join(", ")}`);
    });
  } finally {
    Object.assign(console, consoleOriginal);
    globalThis.fetch = fetchOriginal;
    await f.close().catch(() => undefined);
  }

  const providerPosts: ProofReport["providerPosts"] = {};
  for (const provider of config.providers) {
    providerPosts[provider] = { attempted: ctx.sends(provider).length, delivered: ctx.deliveredCount(provider), limit: MAX_POSTS_PER_PROVIDER };
  }
  const requestSummary: Record<string, number> = {};
  for (const entry of requestLog) {
    const key = `${entry.provider}.${entry.op}.${entry.http ?? "blocked"}`;
    requestSummary[key] = (requestSummary[key] ?? 0) + 1;
  }
  const failed = ctx.steps.some((entry) => entry.status === "FAIL");
  const report: ProofReport = {
    runId,
    mode: config.mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !failed && !aborted,
    aborted,
    providers: config.providers,
    liveSettings: {
      capsChannel: { perDay: 3, minIntervalSeconds: 60, onePerPhase: true, note: "lowered from the production default (perDay 6, 600 s) to keep the live run short" },
      otherChannels: { perDay: 6, minIntervalSeconds: 0 },
      scheduledLeadSeconds: 70,
      allowVisible: config.allowVisible,
    },
    steps: ctx.steps,
    posts: ctx.posts,
    providerPosts,
    requestSummary,
    hygiene,
    cleanup: config.providers.map((provider) => `${provider}: delete every message that starts with "[tealbrick channels proof ${runId}"`),
  };
  ctx.say("");
  ctx.say(`RESULT: ${report.ok ? "ALL STEPS PASSED" : aborted ? `ABORTED (${aborted})` : "FAILED"} | PASS ${ctx.steps.filter((e) => e.status === "PASS").length} FAIL ${ctx.steps.filter((e) => e.status === "FAIL").length} SKIP ${ctx.steps.filter((e) => e.status === "SKIP").length}`);
  for (const provider of config.providers) {
    ctx.say(`${config.mode === "live" ? "Real posts" : "Simulated posts (nothing was posted)"} ${provider}: ${providerPosts[provider]!.delivered} delivered / ${providerPosts[provider]!.attempted} attempted (limit ${MAX_POSTS_PER_PROVIDER})`);
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------------------------

export function renderMarkdown(report: ProofReport): string {
  const cell = (value: unknown) => String(value ?? "").replace(/\|/gu, "/").replace(/\s+/gu, " ").slice(0, 300);
  const lines = [
    `# Marketplace Channels live proof, run ${report.runId}`,
    "",
    `- Mode: ${report.mode}${report.mode === "dry-run" ? " (simulated API, nothing was posted)" : ""}`,
    `- Result: ${report.ok ? "ALL STEPS PASSED" : report.aborted ? `ABORTED: ${report.aborted}` : "FAILED"}`,
    `- Started: ${report.startedAt}, finished: ${report.finishedAt}`,
    `- Providers: ${report.providers.join(", ")}`,
    `- Caps channel in this run: perDay 3, minInterval 60 s (production default: perDay 6, 600 s). Other channels: perDay 6, interval 0.`,
    ...report.providers.map((provider) => `- ${report.mode === "live" ? "Real posts" : "Simulated posts"} ${provider}: ${report.providerPosts[provider]?.delivered} delivered, ${report.providerPosts[provider]?.attempted} attempted (limit ${report.providerPosts[provider]?.limit})`),
    "",
    "## Steps",
    "",
    "| # | Provider | Spec | Step | Result | Evidence |",
    "|---|---|---|---|---|---|",
    ...report.steps.map((step) => `| ${step.n} | ${step.provider} | ${cell(step.spec)} | ${cell(step.title)} | ${step.status} | ${cell(step.status === "FAIL" ? `${step.failures.join("; ")} | ${compact(step.evidence)}` : step.note ?? compact(step.evidence))} |`),
    "",
    "## Posts (tags to find and delete)",
    "",
    "| Provider | Channel | Tag | HTTP | Receipt | Message ids | Links |",
    "|---|---|---|---|---|---|---|",
    ...report.posts.map((post) => `| ${post.provider} | ${post.channelRole} | ${cell(post.tag)} | ${post.http ?? ""} | ${cell(post.receiptStatus)} | ${cell(post.resultIds.join(", "))} | ${cell(post.resultUrls.join(", "))} |`),
    "",
    "## Hygiene (§10.8)",
    "",
    `Checked: ${report.hygiene.checked.join(", ")}. ${report.hygiene.leaks.length === 0 ? "No token found." : `LEAKS: ${report.hygiene.leaks.join("; ")}`}`,
    "",
    "## Cleanup",
    "",
    ...report.cleanup.map((line) => `- ${line}`),
    "",
    "Not covered here: §10.6 \"429 retried once\" (cannot be forced live; unit-tested) and §10.9 (upgrade rehearsal 0.1.19 to 0.2.0 and back).",
    "",
  ];
  return lines.join("\n");
}

export async function writeEvidence(report: ProofReport, outDir: string, secrets: readonly string[]): Promise<{ json: string; markdown: string }> {
  const jsonText = `${JSON.stringify(report, null, 2)}\n`;
  const markdownText = renderMarkdown(report);
  for (const secret of secrets) {
    if (secret && (jsonText.includes(secret) || markdownText.includes(secret))) {
      throw new Error("evidence report refused: it would contain a token");
    }
  }
  await mkdir(outDir, { recursive: true });
  const json = path.join(outDir, "evidence.json");
  const markdown = path.join(outDir, "evidence.md");
  await writeFile(json, jsonText, { mode: 0o644 });
  await writeFile(markdown, markdownText, { mode: 0o644 });
  return { json, markdown };
}

export function defaultOutDir(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  return path.join("/Users/puma/work/artifacts/marketplace-channels-0.2.0", stamp);
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

export async function main(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv.slice(2), out: (line: string) => void = (line) => void process.stdout.write(`${line}\n`)): Promise<number> {
  const interlocks = evaluateInterlocks(env, argv);
  if (interlocks.mode === "refused") {
    out("REFUSED: the live proof does not start. Missing or invalid:");
    for (const item of interlocks.missing) out(`  - ${item}`);
    out("Nothing was contacted. Run without CHANNELS_LIVE_PROOF for the dry run. See docs/channels-live-proof.md.");
    return 2;
  }
  if (interlocks.mode === "dry-run" && ALL_PROVIDERS.some((provider) => env[CHANNEL_TOKEN_ENV[provider]]?.trim())) {
    out("Note: dry run ignores the bot token variables in the environment. Nothing is sent to Telegram or Discord.");
  }
  const config = interlocks.mode === "live" ? liveConfig(interlocks, { out }) : dryRunConfig({ out });
  const report = await runChannelsProof(config);
  const outEnv = env.CHANNELS_LIVE_OUT?.trim();
  if (interlocks.mode === "live" || outEnv) {
    const outDir = outEnv || defaultOutDir();
    const secrets = Object.values(config.tokens).flatMap((token) => (token ? [token, `bot${token}`] : []));
    try {
      const written = await writeEvidence(report, outDir, secrets);
      out(`Evidence written: ${written.json} and ${written.markdown}`);
    } catch (error) {
      out(`Evidence NOT written: ${error instanceof Error ? error.message : "unknown error"}`);
      return 1;
    }
  } else {
    out("Dry run: evidence not written (set CHANNELS_LIVE_OUT to write it).");
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`channels-live-proof crashed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}\n`);
      process.exitCode = 1;
    },
  );
}


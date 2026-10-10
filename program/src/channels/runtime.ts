import {
  channelPayloadCanonical,
  channelPayloadDigest,
  evaluateContent,
  type ChannelPolicy,
  type ChannelProviderCapabilities,
  type PostCampaign,
} from "./policy.js";
import {
  ATTACHMENT_KINDS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  applyFallbacks,
  capabilitySupports,
  kindLimits,
  wiredCapabilities,
} from "./providers/capabilities.js";
import { scrubSecrets, validateOutbound } from "./providers/common.js";
import { createDiscordProvider } from "./providers/discord.js";
import { createSlackProvider } from "./providers/slack.js";
import { createTeamsProvider, encodeTeamsCredential, type TeamsConversationSource } from "./providers/teams.js";
import { createTelegramProvider } from "./providers/telegram.js";
import type {
  AttachmentKind,
  ChannelCapabilities,
  ChannelDestination as ProviderDestination,
  ChannelProvider,
  ChannelProviderId,
  ChannelProviderOptions,
  MediaCapability,
  OutboundAttachment,
} from "./providers/types.js";
import {
  ChannelStoreError,
  readAttachmentBytes,
  type ChannelAttachmentRecord,
  type ChannelPostAttachmentSpec,
  type ChannelRecord,
  type ChannelStore,
} from "./store.js";

/**
 * Channel runtime helpers (Channels spec §3.1, §4.1, §4.6, §6, §8): provider
 * registry, credentials, the post payload as it will really be sent (after
 * fallbacks) and its digest, content checks and secret redaction. No routes,
 * no HTTP; the app wires these into `executeConsentedCall`.
 */

export const CHANNEL_PROVIDER_IDS: readonly ChannelProviderId[] = ["telegram", "discord", "slack", "teams"];

/** Providers whose credential is one bot token. */
export type ChannelTokenProviderId = Exclude<ChannelProviderId, "teams">;

/** Hosted credentials: Account Connections deliver these as provider env (spec §8). */
export const CHANNEL_TOKEN_ENV: Readonly<Record<ChannelTokenProviderId, string>> = {
  telegram: "MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN",
  discord: "MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN",
  slack: "MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN",
};

/**
 * Slack signing secret for inbound request verification (P2 scope 2.2; used by the inbound worker, not by
 * sending, so it never affects readiness). Hosted: provider env. Self-hosted: connector secret
 * `signingSecret` under `channels-slack`.
 */
export const CHANNEL_SLACK_SIGNING_SECRET_ENV = "MARKETPLACE_CHANNELS_SLACK_SIGNING_SECRET";
export const CHANNEL_SLACK_SIGNING_SECRET_NAME = "signingSecret";

/**
 * Microsoft Teams (single-tenant Azure Bot): three values from Account Connections, composed into one opaque
 * credential at start. `graphEnabled` ("true") turns on Graph user lookup (User.Read.All, application) for DMs.
 */
export const TEAMS_CREDENTIAL_ENV = Object.freeze({
  appId: "MARKETPLACE_CHANNELS_TEAMS_APP_ID",
  appSecret: "MARKETPLACE_CHANNELS_TEAMS_APP_SECRET",
  tenantId: "MARKETPLACE_CHANNELS_TEAMS_TENANT_ID",
  graphEnabled: "MARKETPLACE_CHANNELS_TEAMS_GRAPH_ENABLED",
} as const);

/** Every hosted credential env name of a provider (for presence reports; values are never read here). */
export function channelCredentialEnvNames(provider: ChannelProviderId): string[] {
  return provider === "teams"
    ? [TEAMS_CREDENTIAL_ENV.appId, TEAMS_CREDENTIAL_ENV.appSecret, TEAMS_CREDENTIAL_ENV.tenantId]
    : [CHANNEL_TOKEN_ENV[provider]];
}

/** Self-hosted credentials: the existing encrypted `connector_secret`, this name under `channels-<provider>`. */
export const CHANNEL_SECRET_NAME = "botToken";
/** Self-hosted Teams: these names under `channels-teams`. */
export const TEAMS_SECRET_NAMES = Object.freeze({ appId: "appId", appSecret: "appSecret", tenantId: "tenantId" } as const);

export type ChannelReadiness = "available" | "credential_missing" | "credential_invalid" | "unavailable";

export type ChannelProviderRegistry = Readonly<Partial<Record<ChannelProviderId, ChannelProvider>>>;

export function teamsGraphEnabled(environment: Record<string, string | undefined>): boolean {
  return /^(true|1|yes)$/iu.test(environment[TEAMS_CREDENTIAL_ENV.graphEnabled]?.trim() ?? "");
}

export function defaultChannelProviders(
  options: ChannelProviderOptions = {},
  teams: { conversations?: TeamsConversationSource; graphEnabled?: boolean } = {},
): ChannelProviderRegistry {
  return {
    telegram: createTelegramProvider(options),
    discord: createDiscordProvider(options),
    slack: createSlackProvider(options),
    teams: createTeamsProvider({ ...options, ...teams }),
  };
}

export function isChannelProviderId(value: unknown): value is ChannelProviderId {
  return typeof value === "string" && (CHANNEL_PROVIDER_IDS as readonly string[]).includes(value);
}

export const channelPluginId = (provider: string) => `channels-${provider}`;
export const channelResourceKind = (provider: string) => `${provider}.connected-account`;
export const channelActionGroup = (slug: string) => `channel:${slug}`;

export function providerFromPluginId(pluginId: string): ChannelProviderId | null {
  const provider = pluginId.startsWith("channels-") ? pluginId.slice("channels-".length) : "";
  return isChannelProviderId(provider) ? provider : null;
}

/** `secrets`: the sensitive parts of a composed credential (redacted on their own, not only as part of `value`). */
export type ChannelCredential = { value: string; ref: string; secrets?: string[] };

/**
 * Hosted: the provider env read at start (never persisted). Self-hosted: the
 * encrypted connector secret. The value never leaves server-side code.
 * Teams needs all three values from one source; a partial set counts as missing.
 */
export function resolveChannelCredential(input: {
  provider: ChannelProviderId;
  environment: Record<string, string | undefined>;
  readSecret: (pluginId: string, name: string) => { value: string; id: string } | null;
}): ChannelCredential | null {
  if (input.provider === "teams") {
    const env = (name: string) => input.environment[name]?.trim() ?? "";
    const hosted = { appId: env(TEAMS_CREDENTIAL_ENV.appId), appSecret: env(TEAMS_CREDENTIAL_ENV.appSecret), tenantId: env(TEAMS_CREDENTIAL_ENV.tenantId) };
    if (hosted.appId && hosted.appSecret && hosted.tenantId) {
      return { value: encodeTeamsCredential(hosted), ref: `provider-env:${TEAMS_CREDENTIAL_ENV.appSecret}`, secrets: [hosted.appSecret] };
    }
    const pluginId = channelPluginId("teams");
    const appId = input.readSecret(pluginId, TEAMS_SECRET_NAMES.appId)?.value?.trim();
    const secret = input.readSecret(pluginId, TEAMS_SECRET_NAMES.appSecret);
    const tenantId = input.readSecret(pluginId, TEAMS_SECRET_NAMES.tenantId)?.value?.trim();
    const appSecret = secret?.value?.trim();
    if (!appId || !appSecret || !tenantId || !secret) return null;
    return { value: encodeTeamsCredential({ appId, appSecret, tenantId }), ref: `marketplace-secret:${secret.id}`, secrets: [appSecret] };
  }
  const envName = CHANNEL_TOKEN_ENV[input.provider];
  const hosted = input.environment[envName]?.trim();
  if (hosted) return { value: hosted, ref: `provider-env:${envName}` };
  const secret = input.readSecret(channelPluginId(input.provider), CHANNEL_SECRET_NAME);
  return secret?.value ? { value: secret.value, ref: `marketplace-secret:${secret.id}` } : null;
}

/** The Slack signing secret (env first, then the self-hosted connector secret), or null. Never logged or answered. */
export function resolveSlackSigningSecret(input: {
  environment: Record<string, string | undefined>;
  readSecretValue: (pluginId: string, name: string) => string | null;
}): string | null {
  const hosted = input.environment[CHANNEL_SLACK_SIGNING_SECRET_ENV]?.trim();
  if (hosted) return hosted;
  return input.readSecretValue(channelPluginId("slack"), CHANNEL_SLACK_SIGNING_SECRET_NAME)?.trim() || null;
}

/** Redacts every provider credential (and generic token shapes) from text bound for a row, response or log. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return scrubSecrets(text, secrets.filter((secret) => secret.length > 0));
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const MEDIA_KINDS: readonly Exclude<AttachmentKind, "voice">[] = ["image", "file", "audio", "video"];

/** The subset of the provider declaration the policy engine reads (`send.*` vocabulary). */
export function policyCapabilities(caps: ChannelCapabilities): ChannelProviderCapabilities {
  const declared = [caps.image, caps.file, caps.audio, caps.video, caps.voice].filter(
    (entry): entry is NonNullable<typeof entry> & MediaCapability => entry !== false,
  );
  const types = [...new Set(declared.flatMap((entry) => entry.types))];
  return {
    "send.text": true,
    "send.maxChars": caps.text.maxChars,
    "send.files":
      declared.length === 0
        ? false
        : {
            types,
            maxBytes: Math.max(...declared.map((entry) => entry.maxBytes)),
            maxCount: MAX_ATTACHMENTS_PER_MESSAGE,
          },
    "send.mentions": "suppressed",
    "schedule.native": caps.schedule.native,
  };
}

/**
 * What an agent may use on this channel: the provider declaration narrowed to
 * the wired features (AGENT_WIRED_FEATURES) and by the channel policy (C2).
 * A media kind the policy leaves no type for is false.
 */
export function effectiveCapabilities(declared: ChannelCapabilities, policy: ChannelPolicy) {
  // Only features an agent operation can use today (idempotent when the caller already narrowed it).
  const caps = wiredCapabilities(declared);
  const files = policy.content.files;
  const narrow = (spec: MediaCapability | false) => {
    if (spec === false || !files.allowed) return false;
    const types = spec.types.filter((type) => files.types.includes(type));
    if (types.length === 0) return false;
    return { types, maxBytes: Math.min(spec.maxBytes, files.maxBytes) };
  };
  const media = Object.fromEntries(MEDIA_KINDS.map((kind) => [kind, narrow(caps[kind])]));
  const voiceLimits = narrow(caps.voice);
  const voice =
    caps.voice === false || voiceLimits === false
      ? false
      : "native" in caps.voice
        ? { native: true as const, ...voiceLimits, ...(caps.voice.maxSeconds ? { maxSeconds: caps.voice.maxSeconds } : {}) }
        : { fallback: caps.voice.fallback, ...voiceLimits };
  return {
    channelCapabilities: caps.channelCapabilities,
    text: {
      maxChars: Math.min(caps.text.maxChars, policy.content.maxChars ?? caps.text.maxChars),
      ...(caps.text.captionMaxChars ? { captionMaxChars: caps.text.captionMaxChars } : {}),
    },
    markup: caps.markup,
    mentions: caps.mentions,
    dm: caps.dm,
    ...media,
    voice,
    maxAttachments: files.allowed ? Math.min(files.maxCount, MAX_ATTACHMENTS_PER_MESSAGE) : 0,
    thread: caps.thread,
    reactions: caps.reactions,
    edit: caps.edit,
    delete: caps.delete,
    canvas: caps.canvas,
    presence: caps.presence,
    ephemeral: caps.ephemeral,
    live: caps.live,
    inbound: caps.inbound,
    schedule: caps.schedule,
    limits: caps.limits,
  };
}

/** The largest attachment any of these channels could accept (upload limit). */
export function largestAcceptedBytes(entries: Array<{ caps: ChannelCapabilities; policy: ChannelPolicy }>): number {
  let largest = 0;
  for (const { caps, policy } of entries) {
    if (!policy.content.files.allowed) continue;
    for (const kind of ATTACHMENT_KINDS) {
      const limits = kindLimits(caps, kind);
      if (limits) largest = Math.max(largest, Math.min(limits.maxBytes, policy.content.files.maxBytes));
    }
  }
  return largest;
}

export function toProviderDestination(channel: ChannelRecord): ProviderDestination {
  return {
    type: channel.destination.type as ProviderDestination["type"],
    externalId: channel.destination.externalId,
    title: channel.destination.title,
    ...(channel.destination.url ? { url: channel.destination.url } : {}),
    ...(channel.destination.parentId ? { parentId: channel.destination.parentId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Payload (§4.6, §6 3a/3b)
// ---------------------------------------------------------------------------

export type ChannelPostBody = {
  text: string;
  attachments: ChannelPostAttachmentSpec[];
  campaign: PostCampaign;
  sendAt: string | null;
};

export type ChannelPayload = {
  /** The text as it will be sent (after fallbacks). */
  text: string;
  attachments: OutboundAttachment[];
  records: ChannelAttachmentRecord[];
  fallbacks: string[];
  campaign: PostCampaign;
  sendAt: string | null;
  digest: string;
  canonical: string;
  files: Array<{ name: string; sha256: string; contentType: string; kind: string; bytes: number }>;
};

export type ChannelRefusal = {
  status: number;
  error: string;
  detail?: string;
  errors?: string[];
  retryAfterSeconds?: number;
};

const REFUSAL_STATUS: Record<string, number> = {
  channel_attachment_not_found: 404,
  channel_capability_unavailable: 422,
  channel_voice_transcript_required: 422,
  channel_transcript_invalid: 422,
  channel_transcript_too_long: 422,
  channel_transcript_unsupported: 422,
  channel_text_too_long: 422,
  channel_message_empty: 422,
  channel_too_many_files: 422,
  channel_file_type_not_allowed: 422,
  channel_file_too_large: 422,
  channel_file_digest_mismatch: 409,
};

export function refusal(error: string, detail?: string): ChannelRefusal {
  return { status: REFUSAL_STATUS[error] ?? 422, error, ...(detail ? { detail } : {}) };
}

/**
 * The post as the provider will really send it, and its digest (spec 3.1,
 * §4.6). Attachments must be the caller's own uploads in this workspace
 * (unknown or foreign ids are refused, never dropped); their bytes are read
 * from disk and checked against their content address. Declared fallbacks
 * are applied BEFORE the digest, so the digest (and the owner's approval)
 * covers exactly what is sent, transcripts included.
 */
export function buildChannelPayload(input: {
  store: ChannelStore;
  attachmentsDir: string;
  channel: ChannelRecord;
  caps: ChannelCapabilities;
  agentId: string;
  op: "post" | "schedule" | "test";
  body: ChannelPostBody;
}): { ok: true; payload: ChannelPayload } | { ok: false; refusal: ChannelRefusal } {
  const { channel, caps, body } = input;
  if (body.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, refusal: refusal("channel_too_many_files") };
  }
  const outbound: OutboundAttachment[] = [];
  const records: ChannelAttachmentRecord[] = [];
  for (const spec of body.attachments) {
    const record = input.store.getAttachment(channel.workspaceSlug, spec.id);
    if (!record || record.createdBy !== input.agentId) {
      return { ok: false, refusal: refusal("channel_attachment_not_found", `attachment ${spec.id} is unknown`) };
    }
    if (!(ATTACHMENT_KINDS as readonly string[]).includes(spec.kind) || !capabilitySupports(caps, spec.kind)) {
      return { ok: false, refusal: refusal("channel_capability_unavailable", `this channel's provider does not declare "${spec.kind}"`) };
    }
    let bytes: Buffer;
    try {
      bytes = readAttachmentBytes(input.attachmentsDir, record.sha256);
    } catch (error) {
      if (error instanceof ChannelStoreError && error.code === "channel_attachment_digest_mismatch") {
        return { ok: false, refusal: refusal("channel_file_digest_mismatch") };
      }
      return { ok: false, refusal: refusal("channel_attachment_not_found", `attachment ${spec.id} has no stored bytes`) };
    }
    records.push(record);
    outbound.push({
      kind: spec.kind as AttachmentKind,
      ...(spec.transcript !== undefined ? { transcript: spec.transcript } : {}),
      bytes,
      contentType: record.contentType,
      name: record.name,
      sha256: record.sha256,
    });
  }
  const applied = applyFallbacks(caps, { text: body.text, attachments: outbound });
  if ("error" in applied) {
    return { ok: false, refusal: refusal(applied.error.errorCode, applied.error.detail) };
  }
  const files = applied.attachments.map((attachment) => ({
    name: attachment.name,
    sha256: attachment.sha256,
    contentType: attachment.contentType,
    kind: attachment.kind,
    bytes: attachment.bytes.byteLength,
  }));
  const digestInput = {
    workspace: channel.workspaceSlug,
    channelId: channel.id,
    provider: channel.provider,
    destination: channel.destination.externalId,
    ...(channel.destination.parentId ? { destinationParentId: channel.destination.parentId } : {}),
    op: input.op,
    text: applied.text,
    attachments: applied.attachments.map((attachment) => ({
      sha256: attachment.sha256,
      contentType: attachment.contentType,
      name: attachment.name,
      kind: attachment.kind,
      ...(attachment.transcript !== undefined ? { transcript: attachment.transcript } : {}),
    })),
    campaign: body.campaign,
    sendAt: body.sendAt,
  };
  return {
    ok: true,
    payload: {
      text: applied.text,
      attachments: applied.attachments,
      records,
      fallbacks: applied.fallbacks,
      campaign: body.campaign,
      sendAt: body.sendAt,
      digest: channelPayloadDigest(digestInput),
      canonical: channelPayloadCanonical(digestInput),
      files,
    },
  };
}

/**
 * §6 3b on the post after fallbacks: channel policy content rules (length,
 * files, deny patterns, static confirmed-event host, schedule window) and the
 * provider's own per-kind limits. Returns every failing code; never a fixed post.
 */
export function checkChannelContent(input: {
  payload: ChannelPayload;
  policy: ChannelPolicy;
  caps: ChannelCapabilities;
  mode: "immediate" | "scheduled";
  now: Date;
}): ChannelRefusal | null {
  const { payload } = input;
  const content = evaluateContent(
    {
      mode: input.mode,
      sendAt: payload.sendAt,
      text: payload.text,
      attachments: payload.attachments.map((attachment) => ({
        sha256: attachment.sha256,
        contentType: attachment.contentType,
        bytes: attachment.bytes.byteLength,
        name: attachment.name,
      })),
      campaign: payload.campaign,
    },
    input.policy,
    policyCapabilities(input.caps),
    { now: input.now },
  );
  if (!content.ok) {
    return { status: 422, error: content.errors[0]!, errors: content.errors };
  }
  // A transcript that stays on a native voice note is not posted, but it is
  // part of the approved payload, so it passes the same deny patterns.
  const lowered = payload.attachments.map((attachment) => attachment.transcript?.toLowerCase() ?? "");
  if (input.policy.content.denyPatterns.some((pattern) => lowered.some((text) => text.includes(pattern.toLowerCase())))) {
    return { status: 422, error: "channel_content_denied", errors: ["channel_content_denied"] };
  }
  const provider = validateOutbound({ text: payload.text, attachments: payload.attachments, caps: input.caps });
  if (provider) return refusal(provider.errorCode ?? "channel_capability_unavailable", provider.detail);
  return null;
}

// ---------------------------------------------------------------------------
// Class consents (handoff v1.4, spec §5.3)
// ---------------------------------------------------------------------------

export const MARKETPLACE_PORTAL_CLASS_CONTRACT_VERSION = "tealbrick.marketplace.operator-handoff.v1.4" as const;

export type ChannelGrantClass = "read" | "outward";

/** A v1.4 class selection as Portal stores it (label-free: `actionGroupLabel` is display-only and never stored). */
export type ClassSelection = {
  pluginId: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  grantClass: string;
  actionGroup?: string;
};

/** The class selection of a stored consent, or null for a per-action consent. */
export function classSelectionOfConsent(consent: {
  pluginId: string;
  accountId: string;
  resourceKind: string;
  resourceRef: string;
  metadata: Record<string, unknown>;
}): ClassSelection | null {
  const metadata = consent.metadata ?? {};
  if (metadata.selectionKind !== "class" || typeof metadata.grantClass !== "string") return null;
  return {
    pluginId: consent.pluginId,
    accountId: consent.accountId,
    resourceKind: consent.resourceKind,
    resourceRef: consent.resourceRef,
    grantClass: metadata.grantClass,
    ...(typeof metadata.actionGroup === "string" ? { actionGroup: metadata.actionGroup } : {}),
  };
}

export function classSelectionsEqual(left: ClassSelection, right: ClassSelection): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.accountId === right.accountId &&
    left.resourceKind === right.resourceKind &&
    left.resourceRef === right.resourceRef &&
    left.grantClass === right.grantClass &&
    (left.actionGroup ?? null) === (right.actionGroup ?? null)
  );
}

/** The class selection a consent for this channel must carry (always group-narrowed to `channel:<slug>`). */
export function channelClassSelection(channel: Pick<ChannelRecord, "provider" | "connectionId" | "slug">, grantClass: ChannelGrantClass): ClassSelection {
  return {
    pluginId: channelPluginId(channel.provider),
    accountId: channel.connectionId,
    resourceKind: channelResourceKind(channel.provider),
    resourceRef: `account:${channel.connectionId}`,
    grantClass,
    actionGroup: channelActionGroup(channel.slug),
  };
}

/** Plain text, at most 80 characters (Portal sanitises the same way and never stores it). */
export function sanitizeActionGroupLabel(value: string): string {
  return value.replace(/[\p{Cc}​-‏‪-‮⁦-⁩﻿]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80);
}

// ---------------------------------------------------------------------------
// Upload content checks (review L8)
// ---------------------------------------------------------------------------

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.byteLength >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const hasFtyp = (bytes: Uint8Array) => startsWith(bytes, ascii("ftyp"), 4);

/**
 * Declared content type → magic-byte check and the file name extensions that
 * may carry it. A type not listed here cannot be verified and is refused;
 * `application/octet-stream` is handled by the caller (never inferred).
 */
export const UPLOAD_TYPE_RULES: Readonly<Record<string, { extensions: readonly string[]; matches: (bytes: Uint8Array) => boolean }>> = {
  "image/png": { extensions: ["png"], matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  "image/jpeg": { extensions: ["jpg", "jpeg"], matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  "image/webp": { extensions: ["webp"], matches: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8) },
  "image/gif": { extensions: ["gif"], matches: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")) },
  "application/pdf": { extensions: ["pdf"], matches: (b) => startsWith(b, ascii("%PDF-")) },
  "audio/ogg": { extensions: ["ogg", "oga", "opus"], matches: (b) => startsWith(b, ascii("OggS")) },
  "audio/mpeg": {
    extensions: ["mp3"],
    matches: (b) => startsWith(b, ascii("ID3")) || (b.byteLength >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0),
  },
  "audio/mp4": { extensions: ["m4a", "mp4"], matches: hasFtyp },
  "video/mp4": { extensions: ["mp4", "m4v"], matches: hasFtyp },
  "application/zip": { extensions: ["zip"], matches: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) },
  "text/plain": {
    extensions: ["txt"],
    matches: (b) => {
      if (b.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(b);
        return true;
      } catch {
        return false;
      }
    },
  },
};

export type UploadTypeCheck = { ok: true } | { ok: false; status: number; error: string };

/** The bytes must be what the declared type says, and the name's extension must belong to that type. */
export function checkUploadType(input: { bytes: Uint8Array; contentType: string; name: string; octetStreamDeclared: boolean }): UploadTypeCheck {
  if (input.contentType === "application/octet-stream") {
    // Opaque bytes are never inferred to be anything else; allowed only where a provider declares them.
    return input.octetStreamDeclared ? { ok: true } : { ok: false, status: 422, error: "channel_attachment_type_mismatch" };
  }
  const rule = UPLOAD_TYPE_RULES[input.contentType];
  if (!rule) return { ok: false, status: 415, error: "channel_attachment_type_invalid" };
  const dot = input.name.lastIndexOf(".");
  const extension = dot > 0 ? input.name.slice(dot + 1).toLowerCase() : "";
  if (!rule.extensions.includes(extension) || !rule.matches(input.bytes)) {
    return { ok: false, status: 422, error: "channel_attachment_type_mismatch" };
  }
  return { ok: true };
}

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
  capabilityForKind,
  kindLimits,
} from "./providers/capabilities.js";
import { scrubSecrets, validateOutbound } from "./providers/common.js";
import { createDiscordProvider } from "./providers/discord.js";
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

export const CHANNEL_PROVIDER_IDS: readonly ChannelProviderId[] = ["telegram", "discord"];

/** Hosted credentials: Account Connections deliver these as provider env (spec §8). */
export const CHANNEL_TOKEN_ENV: Readonly<Record<ChannelProviderId, string>> = {
  telegram: "MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN",
  discord: "MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN",
};

/** Self-hosted credentials: the existing encrypted `connector_secret`, this name under `channels-<provider>`. */
export const CHANNEL_SECRET_NAME = "botToken";

export type ChannelReadiness = "available" | "credential_missing" | "credential_invalid" | "unavailable";

export type ChannelProviderRegistry = Readonly<Partial<Record<ChannelProviderId, ChannelProvider>>>;

export function defaultChannelProviders(options: ChannelProviderOptions = {}): ChannelProviderRegistry {
  return { telegram: createTelegramProvider(options), discord: createDiscordProvider(options) };
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

export type ChannelCredential = { value: string; ref: string };

/**
 * Hosted: the provider env read at start (never persisted). Self-hosted: the
 * encrypted connector secret. The value never leaves server-side code.
 */
export function resolveChannelCredential(input: {
  provider: ChannelProviderId;
  environment: Record<string, string | undefined>;
  readSecret: (pluginId: string) => { value: string; id: string } | null;
}): ChannelCredential | null {
  const envName = CHANNEL_TOKEN_ENV[input.provider];
  const hosted = input.environment[envName]?.trim();
  if (hosted) return { value: hosted, ref: `provider-env:${envName}` };
  const secret = input.readSecret(channelPluginId(input.provider));
  return secret?.value ? { value: secret.value, ref: `marketplace-secret:${secret.id}` } : null;
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
 * What an agent may use on this channel: the provider declaration narrowed by
 * the channel policy (C2). A media kind the policy leaves no type for is false.
 */
export function effectiveCapabilities(caps: ChannelCapabilities, policy: ChannelPolicy) {
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
    ...media,
    voice,
    maxAttachments: files.allowed ? Math.min(files.maxCount, MAX_ATTACHMENTS_PER_MESSAGE) : 0,
    thread: caps.thread,
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
    if (!(ATTACHMENT_KINDS as readonly string[]).includes(spec.kind) || capabilityForKind(caps, spec.kind as AttachmentKind) === null) {
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

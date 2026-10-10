import type {
  ChannelEffectiveCapabilities,
  ChannelPolicy,
  ChannelPolicyInput,
  ChannelProviderCapabilities,
  ChannelProviderEntry,
  ChannelProviderId,
  ChannelReceiptStatus,
  GrantPhase,
  GrantTerms,
  StandingGrantView,
} from "./types";

// Pure helpers for the Channels owner UI. The server validates everything
// again; these only keep the forms honest and explain refusals early.

export const CHANNEL_PROVIDERS: readonly ChannelProviderId[] = ["telegram", "discord", "slack", "teams"];
export const PROVIDER_LABEL: Record<ChannelProviderId, string> = { telegram: "Telegram", discord: "Discord", slack: "Slack", teams: "Microsoft Teams" };
export const GRANT_PHASES: readonly GrantPhase[] = ["announce", "reminder", "recap", "update"];
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const MIB = 1024 * 1024;

export function isChannelProvider(value: string): value is ChannelProviderId {
  return (CHANNEL_PROVIDERS as readonly string[]).includes(value);
}

export function providerLabel(provider: string) {
  return isChannelProvider(provider) ? PROVIDER_LABEL[provider] : provider;
}

/** Most attachments in one post for every P1 provider (server `MAX_ATTACHMENTS_PER_MESSAGE`). */
export const MAX_ATTACHMENTS_PER_POST = 4;

type ProviderDeclaration = ChannelProviderCapabilities;

/** The provider's static declaration from the owner browse answer (null before a credential exists). */
export function declarationFor(providers: readonly ChannelProviderEntry[] | undefined, provider: string): ChannelProviderCapabilities | null {
  return providers?.find((entry) => entry.id === provider)?.capabilities ?? null;
}

/** Channel kinds the provider serves, from the browse answer. */
export function kindsFor(providers: readonly ChannelProviderEntry[] | undefined, provider: string): string[] {
  return providers?.find((entry) => entry.id === provider)?.kinds ?? [];
}

export const KIND_LABEL: Record<string, string> = {
  chat: "Chat (group, channel or topic)",
  newsletter: "Newsletter (one list)",
  email: "Email (one sending identity)",
  social: "Social (one account or Page)",
  community: "Community (one forum category)",
};

// ----- labels and slugs --------------------------------------------------------

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
// Same rule as the server: 1–80 characters, no control or bidi override characters.
const PLAIN_LABEL = /^[^\p{Cc}​-‏‪-‮⁦-⁩﻿]{1,80}$/u;

/** A slug suggestion from the label: lower-case ASCII words joined with dashes. */
export function slugFromLabel(label: string) {
  const slug = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return slug.length >= 2 ? slug : "";
}

export function labelProblem(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return "Enter a label.";
  if (!PLAIN_LABEL.test(trimmed)) return "Use 1–80 characters of plain text.";
  return null;
}

export function slugProblem(slug: string, taken: readonly string[] = []): string | null {
  if (!slug) return "Enter a slug.";
  if (!SLUG_PATTERN.test(slug)) return "Use 2–48 lower-case letters, digits and dashes, starting with a letter or digit.";
  if (taken.includes(slug)) return "Another channel already uses this slug.";
  return null;
}

// ----- provider file policy ---------------------------------------------------

/** Every file type, the largest size and the attachment cap the provider declares (the ceiling for the files policy). */
export function providerFileLimits(declaration: ProviderDeclaration) {
  const media = [declaration.image, declaration.file, declaration.audio, declaration.voice, declaration.video].filter((entry): entry is Exclude<typeof entry, false> => entry !== false);
  return {
    types: [...new Set(media.flatMap((entry) => [...entry.types]))],
    maxBytes: media.length ? Math.max(...media.map((entry) => entry.maxBytes)) : 0,
    maxCount: media.length ? MAX_ATTACHMENTS_PER_POST : 0,
  };
}

const TYPE_NAMES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "application/pdf": "PDF",
  "text/plain": "Plain text",
  "application/zip": "ZIP",
  "application/octet-stream": "Other files",
  "audio/mpeg": "MP3",
  "audio/mp4": "M4A",
  "audio/ogg": "OGG/Opus",
  "video/mp4": "MP4",
};

export function typeName(type: string) {
  return TYPE_NAMES[type] ?? type;
}

export function formatBytes(bytes: number) {
  if (bytes >= MIB) return `${Number((bytes / MIB).toFixed(1))} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

// ----- policy form --------------------------------------------------------------

export type PolicyForm = {
  standingGrants: "disabled" | "allowed";
  perDay: string;
  perHour: string;
  minIntervalSeconds: string;
  onePerPhase: boolean;
  maxChars: string;
  filesAllowed: boolean;
  fileTypes: string[];
  fileMaxMiB: string;
  fileMaxCount: string;
  denyPatterns: string;
  requireConfirmedEvent: boolean;
  listingHosts: string;
  windowEnabled: boolean;
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  windowDays: number[];
};

const DEFAULT_FILE_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The form for an existing policy, or for the §4.3 defaults narrowed to the provider. */
export function policyToForm(policy: ChannelPolicy | null, declaration: ProviderDeclaration | null): PolicyForm {
  const limits = declaration ? providerFileLimits(declaration) : null;
  const files = policy?.content.files ?? {
    allowed: limits ? limits.types.length > 0 : true,
    types: DEFAULT_FILE_TYPES.filter((type) => !limits || limits.types.includes(type)),
    maxBytes: Math.min(10 * MIB, limits?.maxBytes || 10 * MIB),
    maxCount: Math.min(4, limits?.maxCount ?? 4),
  };
  const window = policy?.schedule.window;
  const declaredMax = declaration?.text.maxChars;
  return {
    standingGrants: policy?.standingGrants ?? "disabled",
    perDay: String(policy?.caps.perDay ?? 6),
    perHour: policy?.caps.perHour !== undefined ? String(policy.caps.perHour) : "",
    minIntervalSeconds: String(policy?.caps.minIntervalSeconds ?? 600),
    onePerPhase: policy?.caps.onePerPhase ?? true,
    // The server stores the provider maximum when the owner sets none; show that as "provider limit".
    maxChars: policy?.content.maxChars !== undefined && policy.content.maxChars !== declaredMax ? String(policy.content.maxChars) : "",
    filesAllowed: files.allowed,
    fileTypes: [...files.types],
    fileMaxMiB: String(Number((files.maxBytes / MIB).toFixed(2))),
    fileMaxCount: String(files.maxCount),
    denyPatterns: (policy?.content.denyPatterns ?? []).join("\n"),
    requireConfirmedEvent: policy?.content.requireConfirmedEvent ?? false,
    listingHosts: (policy?.content.listingHosts ?? []).join("\n"),
    windowEnabled: Boolean(window),
    timeZone: window?.timeZone ?? localTimeZone(),
    windowStart: window?.start ?? "09:00",
    windowEnd: window?.end ?? "21:00",
    windowDays: window?.days ? [...window.days] : [],
  };
}

const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/u;

function lines(value: string) {
  return [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
}

function intIn(value: string, min: number, max: number) {
  if (!/^\d+$/u.test(value.trim())) return null;
  const number = Number(value.trim());
  return number >= min && number <= max ? number : null;
}

function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export type PolicyFormResult = { policy: ChannelPolicyInput | null; errors: Partial<Record<keyof PolicyForm, string>> };

/** Converts the form to a complete policy input (PATCH replaces the whole policy), or field errors. */
export function formToPolicy(form: PolicyForm, declaration: ProviderDeclaration | null): PolicyFormResult {
  const errors: PolicyFormResult["errors"] = {};
  const limits = declaration ? providerFileLimits(declaration) : null;
  const perDay = intIn(form.perDay, 1, 10_000);
  if (perDay === null) errors.perDay = "Enter a whole number from 1 to 10000.";
  let perHour: number | undefined;
  if (form.perHour.trim()) {
    const parsed = intIn(form.perHour, 1, 10_000);
    if (parsed === null) errors.perHour = "Enter a whole number from 1 to 10000, or leave it empty.";
    else if (perDay !== null && parsed > perDay) errors.perHour = "Must not be more than the posts per day.";
    else perHour = parsed;
  }
  const minIntervalSeconds = intIn(form.minIntervalSeconds, 0, 604_800);
  if (minIntervalSeconds === null) errors.minIntervalSeconds = "Enter seconds from 0 to 604800 (7 days).";
  let maxChars: number | undefined;
  if (form.maxChars.trim()) {
    const parsed = intIn(form.maxChars, 1, declaration?.text.maxChars ?? 1_000_000);
    if (parsed === null) errors.maxChars = `Enter a whole number from 1 to ${declaration?.text.maxChars ?? 1_000_000}, or leave it empty.`;
    else maxChars = parsed;
  }
  const fileTypes = form.fileTypes.filter((type) => !limits || limits.types.includes(type));
  const maxMiB = Number(form.fileMaxMiB);
  const maxBytes = Math.round(maxMiB * MIB);
  if (form.filesAllowed) {
    if (!fileTypes.length) errors.fileTypes = "Choose at least one file type, or turn files off.";
    if (!Number.isFinite(maxMiB) || maxBytes < 1 || (limits && maxBytes > limits.maxBytes)) {
      errors.fileMaxMiB = `Enter a size up to ${limits ? formatBytes(limits.maxBytes) : "100 MiB"}.`;
    }
  }
  const maxCount = intIn(form.fileMaxCount, 0, limits?.maxCount ?? 20);
  if (form.filesAllowed && maxCount === null) errors.fileMaxCount = `Enter a number from 0 to ${limits?.maxCount ?? 20}.`;
  const denyPatterns = lines(form.denyPatterns);
  if (denyPatterns.some((pattern) => pattern.length > 200)) errors.denyPatterns = "Each pattern can have at most 200 characters.";
  if (denyPatterns.length > 200) errors.denyPatterns = "Use at most 200 patterns.";
  const listingHosts = lines(form.listingHosts.toLowerCase()).map((host) => host.replace(/\.$/u, ""));
  const badHost = listingHosts.find((host) => !HOST_PATTERN.test(host));
  if (badHost) errors.listingHosts = `Not a host name: ${badHost}`;
  else if (form.requireConfirmedEvent && !listingHosts.length) errors.listingHosts = "Add at least one listing host, for example lu.ma.";
  if (form.windowEnabled) {
    if (!validTimeZone(form.timeZone.trim())) errors.timeZone = "Use an IANA time zone, for example Asia/Taipei.";
    if (!HHMM.test(form.windowStart) || !HHMM.test(form.windowEnd)) errors.windowStart = "Use HH:MM times.";
    else if (form.windowStart === form.windowEnd) errors.windowStart = "Start and end must differ.";
  }
  if (Object.keys(errors).length) return { policy: null, errors };
  const filesAllowed = form.filesAllowed && (limits ? limits.types.length > 0 : true);
  return {
    errors,
    policy: {
      standingGrants: form.standingGrants,
      caps: { perDay: perDay!, ...(perHour !== undefined ? { perHour } : {}), minIntervalSeconds: minIntervalSeconds!, onePerPhase: form.onePerPhase },
      content: {
        ...(maxChars !== undefined ? { maxChars } : {}),
        files: filesAllowed
          ? { allowed: true, types: fileTypes, maxBytes, maxCount: maxCount! }
          : { allowed: false, types: fileTypes },
        requireConfirmedEvent: form.requireConfirmedEvent,
        listingHosts,
        denyPatterns,
      },
      schedule: form.windowEnabled
        ? { window: { timeZone: form.timeZone.trim(), start: form.windowStart, end: form.windowEnd, ...(form.windowDays.length ? { days: [...form.windowDays].sort() } : {}) } }
        : {},
    },
  };
}

/**
 * Active or proposed grants that a new ceiling no longer contains (§4.4 rule
 * 5): the server suspends active ones when the policy is saved.
 */
export function grantsAboveCeiling(grants: readonly StandingGrantView[], policy: ChannelPolicyInput): StandingGrantView[] {
  const caps = policy.caps;
  const content = policy.content;
  return grants.filter((grant) => {
    if (grant.status !== "active") return false;
    if (policy.standingGrants !== "allowed") return true;
    if (caps?.perDay !== undefined && grant.caps.perDay > caps.perDay) return true;
    if (caps?.perHour !== undefined && grant.caps.perHour !== undefined && grant.caps.perHour > caps.perHour) return true;
    if (caps?.minIntervalSeconds !== undefined && grant.caps.minIntervalSeconds < caps.minIntervalSeconds) return true;
    if (caps?.onePerPhase && !grant.caps.onePerPhase) return true;
    if (content?.maxChars !== undefined && grant.scope.maxChars !== undefined && grant.scope.maxChars > content.maxChars) return true;
    const files = content?.files;
    if (grant.scope.files !== false && files) {
      if (!files.allowed) return true;
      if (grant.scope.files.types && files.types && grant.scope.files.types.some((type) => !files.types!.includes(type))) return true;
      if (grant.scope.files.maxBytes !== undefined && files.maxBytes !== undefined && grant.scope.files.maxBytes > files.maxBytes) return true;
      if (grant.scope.files.maxCount !== undefined && files.maxCount !== undefined && grant.scope.files.maxCount > files.maxCount) return true;
    }
    return false;
  });
}

// ----- standing grants: narrowing only -------------------------------------------

export const GRANT_FIELD_LABEL: Record<string, string> = {
  "caps.perDay": "Posts per day",
  "caps.perHour": "Posts per hour",
  "caps.minIntervalSeconds": "Minimum gap",
  "caps.onePerPhase": "One post per phase",
  "scope.phases": "Phases",
  "scope.campaignRefs": "Campaign links",
  "scope.files": "Files",
  "scope.files.types": "File types",
  "scope.files.maxBytes": "File size",
  "scope.files.maxCount": "Files per post",
  "scope.maxChars": "Text length",
  "scope.immediate": "Immediate posts",
  "scope.scheduled": "Scheduled posts",
  "scope.mode": "Post modes",
  expires: "Expiry",
  notBefore: "Start",
  standingGrants: "Standing grants",
};

export function grantFieldLabel(field: string) {
  return GRANT_FIELD_LABEL[field] ?? field;
}

function subset<T>(items: readonly T[], of: readonly T[]) {
  return items.every((item) => of.includes(item));
}

function time(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fields where `proposed` would authorise more than `current` (mirror of the
 * server `isNarrowing`, §4.4 rule 2: the owner can only tighten), plus shape
 * problems the server would refuse. Empty means the edit only narrows.
 */
export function wideningFields(current: GrantTerms, proposed: GrantTerms): string[] {
  const fields: string[] = [];
  const a = current.caps;
  const b = proposed.caps;
  if (!Number.isInteger(b.perDay) || b.perDay < 1 || b.perDay > a.perDay) fields.push("caps.perDay");
  if (b.perHour !== undefined && (!Number.isInteger(b.perHour) || b.perHour < 1)) fields.push("caps.perHour");
  else if (a.perHour !== undefined && (b.perHour === undefined || b.perHour > a.perHour)) fields.push("caps.perHour");
  if (!Number.isInteger(b.minIntervalSeconds) || b.minIntervalSeconds < a.minIntervalSeconds) fields.push("caps.minIntervalSeconds");
  if (a.onePerPhase && !b.onePerPhase) fields.push("caps.onePerPhase");
  const s = current.scope;
  const t = proposed.scope;
  if (t.phases !== undefined && t.phases.length === 0) fields.push("scope.phases");
  else if (s.phases !== undefined && (t.phases === undefined || !subset(t.phases, s.phases))) fields.push("scope.phases");
  if (t.campaignRefs !== undefined && t.campaignRefs.length === 0) fields.push("scope.campaignRefs");
  else if (s.campaignRefs !== undefined && (t.campaignRefs === undefined || !subset(t.campaignRefs, s.campaignRefs))) fields.push("scope.campaignRefs");
  const badCount = (value: number | undefined, min: number) => value !== undefined && (!Number.isInteger(value) || value < min);
  if (badCount(t.maxChars, 1)) fields.push("scope.maxChars");
  else if (s.maxChars !== undefined && (t.maxChars === undefined || t.maxChars > s.maxChars)) fields.push("scope.maxChars");
  if (t.files !== false && badCount(t.files.maxBytes, 1)) fields.push("scope.files.maxBytes");
  if (t.files !== false && badCount(t.files.maxCount, 0)) fields.push("scope.files.maxCount");
  if (t.files !== false) {
    if (s.files === false) fields.push("scope.files");
    else {
      if (s.files.types !== undefined && (t.files.types === undefined || !subset(t.files.types, s.files.types))) fields.push("scope.files.types");
      if (s.files.maxBytes !== undefined && (t.files.maxBytes === undefined || t.files.maxBytes > s.files.maxBytes)) fields.push("scope.files.maxBytes");
      if (s.files.maxCount !== undefined && (t.files.maxCount === undefined || t.files.maxCount > s.files.maxCount)) fields.push("scope.files.maxCount");
    }
  }
  if (t.immediate && !s.immediate) fields.push("scope.immediate");
  if (t.scheduled && !s.scheduled) fields.push("scope.scheduled");
  if (!t.immediate && !t.scheduled) fields.push("scope.mode");
  const currentExpires = time(current.expires);
  const proposedExpires = time(proposed.expires);
  if (proposedExpires === null || currentExpires === null || proposedExpires > currentExpires) fields.push("expires");
  const currentNotBefore = time(current.notBefore);
  const proposedNotBefore = time(proposed.notBefore);
  if (proposed.notBefore && proposedNotBefore === null) fields.push("notBefore");
  else if (currentNotBefore !== null && (proposedNotBefore === null || proposedNotBefore < currentNotBefore)) fields.push("notBefore");
  else if (proposedNotBefore !== null && proposedExpires !== null && proposedNotBefore >= proposedExpires) fields.push("notBefore");
  return [...new Set(fields)];
}

export function grantTerms(grant: StandingGrantView): GrantTerms {
  return { caps: grant.caps, scope: grant.scope, notBefore: grant.notBefore, expires: grant.expires };
}

/** Exactly the keys the server's strict grant terms schema accepts. */
export function cleanTerms(terms: GrantTerms): GrantTerms {
  const { caps, scope } = terms;
  return {
    caps: { perDay: caps.perDay, ...(caps.perHour !== undefined ? { perHour: caps.perHour } : {}), minIntervalSeconds: caps.minIntervalSeconds, onePerPhase: caps.onePerPhase },
    scope: {
      ...(scope.phases !== undefined ? { phases: scope.phases } : {}),
      ...(scope.campaignRefs !== undefined ? { campaignRefs: scope.campaignRefs } : {}),
      files: scope.files === false
        ? false
        : {
            ...(scope.files.types !== undefined ? { types: scope.files.types } : {}),
            ...(scope.files.maxBytes !== undefined ? { maxBytes: scope.files.maxBytes } : {}),
            ...(scope.files.maxCount !== undefined ? { maxCount: scope.files.maxCount } : {}),
          },
      ...(scope.maxChars !== undefined ? { maxChars: scope.maxChars } : {}),
      immediate: scope.immediate,
      scheduled: scope.scheduled,
    },
    notBefore: terms.notBefore ?? null,
    expires: terms.expires,
  };
}

// ----- capabilities ---------------------------------------------------------------

export type CapabilityRow = { key: string; label: string; value: string; available: boolean };

function mediaValue(media: { types: readonly string[]; maxBytes: number } | false) {
  return media === false ? "Not available" : `${media.types.map(typeName).join(", ")} · up to ${formatBytes(media.maxBytes)}`;
}

function mentionsUsers(caps: ChannelEffectiveCapabilities): boolean {
  return typeof caps.mentions === "object" && caps.mentions.users;
}

function listOf(parts: Array<[boolean | undefined, string]>): string | null {
  const names = parts.filter(([on]) => on).map(([, name]) => name);
  return names.length === 0 ? null : names.join(", ");
}

/** Capability model v2 rows (P2 scope 2.1). The server answer is already declaration ∩ wired features, so a row is available only when an agent operation can use it; a missing key (a v1 answer) is not available. */
function v2Rows(caps: ChannelEffectiveCapabilities): CapabilityRow[] {
  const thread = caps.thread === false ? null : listOf([[caps.thread.replies, "replies"], [caps.thread.topics, "forum topics"], [caps.thread.forum, "forum posts"]]);
  const reactions = typeof caps.reactions === "object" ? listOf([[caps.reactions.add, "add"], [caps.reactions.remove, "remove"], [caps.reactions.custom, "custom emoji"]]) : null;
  const edit = typeof caps.edit === "object" && caps.edit.own ? caps.edit : null;
  const remove = typeof caps.delete === "object" && caps.delete.own;
  const removeWindow = typeof caps.delete === "object" ? caps.delete.windowSeconds : undefined;
  const poll = typeof caps.poll === "object" && caps.poll !== null ? caps.poll : null;
  const presence = caps.presence ? listOf([[caps.presence.typing, "typing"], [caps.presence.status, "status"]]) : null;
  const live = caps.live ? listOf([[caps.live.join, "join"], [caps.live.listen, "listen"], [caps.live.speak, "speak"], [caps.live.transcript, "transcript"]]) : null;
  const inbound = typeof caps.inbound === "object" && caps.inbound.mode !== "none" ? caps.inbound : null;
  const dm = caps.dm?.open ? caps.dm : null;
  const sentence = (text: string | null) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : "Not available");
  return [
    { key: "dm", label: "Direct messages", value: dm ? `Up to ${dm.maxMembers} ${dm.maxMembers === 1 ? "person" : "people"}` : "Not available", available: dm !== null },
    { key: "thread", label: "Threads", value: sentence(thread), available: thread !== null },
    { key: "reactions", label: "Reactions", value: sentence(reactions), available: reactions !== null },
    { key: "edit", label: "Edit own messages", value: edit ? (edit.windowSeconds ? `Within ${formatSeconds(edit.windowSeconds)}` : "Yes") : "Not available", available: edit !== null },
    { key: "delete", label: "Delete own messages", value: remove ? (removeWindow ? `Within ${formatSeconds(removeWindow)}` : "Yes") : "Not available", available: remove },
    {
      key: "poll",
      label: "Polls",
      value: poll ? `${poll.minOptions}-${poll.maxOptions} options${poll.multiple ? " · multiple answers allowed" : ""}${poll.durationHours ? ` · open up to ${poll.durationHours.max} hours` : ""}` : "Not available",
      available: poll !== null,
    },
    { key: "canvas", label: "Canvas", value: caps.canvas === true ? "Shared document per channel" : "Not available", available: caps.canvas === true },
    { key: "presence", label: "Typing and status", value: sentence(presence), available: presence !== null },
    { key: "ephemeral", label: "Private or expiring messages", value: caps.ephemeral === true ? "Yes" : "Not available", available: caps.ephemeral === true },
    { key: "live", label: "Live voice", value: caps.live && live ? `${sentence(live)} · up to ${caps.live.maxSessionMinutes} minutes` : "Not available", available: Boolean(caps.live && live) },
    { key: "inbound", label: "Receiving messages", value: inbound ? `${inbound.mode}${inbound.dedupe ? " · duplicates removed" : ""}` : "Not available", available: inbound !== null },
  ];
}

/** What agents can send on a channel, from its effective capabilities. */
export function capabilityRows(caps: ChannelEffectiveCapabilities): CapabilityRow[] {
  const voice = caps.voice;
  return [
    { key: "text", label: "Text", value: `Up to ${caps.text.maxChars.toLocaleString()} characters${caps.text.captionMaxChars ? ` (${caps.text.captionMaxChars.toLocaleString()} as a caption with media)` : ""} · ${caps.markup === "plain" ? "plain text" : caps.markup}${caps.markupOptions?.length ? ` (${caps.markupOptions.join(", ")} on request)` : ""}`, available: true },
    { key: "mentions", label: "Mentions", value: mentionsUsers(caps) ? "Named people can be mentioned · broadcast mentions never ping anyone" : "Broadcast mentions never ping anyone", available: true },
    { key: "image", label: "Images", value: mediaValue(caps.image), available: caps.image !== false },
    { key: "file", label: "Files", value: mediaValue(caps.file), available: caps.file !== false },
    { key: "audio", label: "Audio", value: mediaValue(caps.audio), available: caps.audio !== false },
    {
      key: "voice",
      label: "Voice",
      value: voice === false
        ? "Not available"
        : "native" in voice
          ? `Native voice message · ${voice.types.map(typeName).join(", ")} up to ${formatBytes(voice.maxBytes)}`
          : `Sent as an audio file plus its transcript (fallback) · ${voice.types.map(typeName).join(", ")} up to ${formatBytes(voice.maxBytes)}`,
      available: voice !== false,
    },
    { key: "video", label: "Video", value: mediaValue(caps.video), available: caps.video !== false },
    { key: "attachments", label: "Attachments per post", value: caps.maxAttachments ? String(caps.maxAttachments) : "None", available: caps.maxAttachments > 0 },
    ...v2Rows(caps),
  ];
}

// ----- receipts and payloads --------------------------------------------------------

export const RECEIPT_STATUS_LABEL: Record<ChannelReceiptStatus, string> = {
  sent: "Sent",
  failed: "Failed",
  uncertain: "Uncertain",
  skipped: "Skipped",
  cancelled: "Cancelled",
  expired: "Expired",
  pending: "Scheduled",
};

export function receiptTone(status: string): "success" | "danger" | "warning" | "accent" | "default" {
  if (status === "sent") return "success";
  if (status === "failed") return "danger";
  if (status === "uncertain") return "warning";
  if (status === "pending") return "accent";
  return "default";
}

export const GRANT_STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed",
  active: "Active",
  suspended: "Suspended",
  withdrawn: "Withdrawn",
  revoked: "Revoked",
  expired: "Expired",
  declined: "Declined",
};

export function grantTone(status: string): "success" | "danger" | "warning" | "accent" | "default" {
  if (status === "active") return "success";
  if (status === "suspended" || status === "proposed") return "warning";
  if (status === "revoked" || status === "declined") return "danger";
  return "default";
}

/** Only `https:` links are rendered as links; anything else stays text. */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function digestPrefix(digest: string | null | undefined, length = 12) {
  return digest ? digest.slice(0, length) : "";
}

/** Transcripts of native voice attachments, read from the canonical payload the digest covers. */
export function transcriptsFromCanonical(canonical: string): Array<{ name: string; transcript: string }> {
  try {
    const parsed = JSON.parse(canonical) as { attachments?: Array<{ name?: unknown; transcript?: unknown }> };
    return (parsed.attachments ?? []).flatMap((attachment) =>
      typeof attachment.transcript === "string" ? [{ name: typeof attachment.name === "string" ? attachment.name : "", transcript: attachment.transcript }] : [],
    );
  } catch {
    return [];
  }
}

export function formatSeconds(seconds: number) {
  if (seconds === 0) return "No minimum";
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

// ----- datetime-local helpers ------------------------------------------------------

export function toLocalInput(iso: string | null | undefined) {
  const parsed = iso ? new Date(iso) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

export function fromLocalInput(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

const DESTINATION_TYPE_LABEL: Readonly<Record<string, string>> = {
  channel: "Channel",
  group: "Group chat",
  person: "Direct chat",
  chat: "Chat",
  topic: "Forum topic",
  thread: "Thread",
};

/** The destination kind shown next to the untrusted title in the picker (a chat name cannot pass for a channel). */
export function destinationTypeLabel(type: string): string {
  return DESTINATION_TYPE_LABEL[type] ?? "Destination";
}

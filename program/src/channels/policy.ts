import { canonicalJson, sha256Hex } from "./canonical-json.js";

/**
 * Channels policy engine (spec §4.3, §4.4, §4.6, §6 steps 3a–3d, §9).
 *
 * Everything here is pure: no database, no clock (callers pass `now`), no
 * network except `confirmEventLive`, which takes an injected `fetch`. The
 * store (`channels/store.ts`) owns counting and reservation; this module owns
 * the rules that decide what a channel, a standing grant and a post may be.
 *
 * Invariant C2: every layer only narrows. Ceiling ∩ grant ∩ provider limits.
 */

export const MIB = 1024 * 1024;
export const GRANT_MAX_LIFETIME_DAYS = 90;
const DAY_MS = 86_400_000;

export const CHANNEL_KINDS = [
  "chat",
  "newsletter",
  "email",
  "social",
  "community",
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const GRANT_PHASES = ["announce", "reminder", "recap", "update"] as const;
export type GrantPhase = (typeof GRANT_PHASES)[number];

/** Short names accepted in policy input, stored as MIME types. */
const FILE_TYPE_ALIASES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};
const MIME_PATTERN = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u;
const HOST_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/u;

export type ChannelFilePolicy = {
  allowed: boolean;
  /** MIME types. */
  types: string[];
  maxBytes: number;
  maxCount: number;
};

export type ChannelCaps = {
  /** Shared by every agent on the channel. */
  perDay: number;
  perHour?: number;
  minIntervalSeconds: number;
  onePerPhase: boolean;
};

export type ChannelScheduleWindow = {
  /** IANA time zone, e.g. `Asia/Taipei`. */
  timeZone: string;
  /** Local `HH:MM`, inclusive. */
  start: string;
  /** Local `HH:MM`, exclusive. `end < start` is an overnight window. */
  end: string;
  /** Local weekdays, 0 = Sunday. Unset = every day. */
  days?: number[];
};

/** Owner-set ceiling (§4.3). */
export type ChannelPolicy = {
  standingGrants: "disabled" | "allowed";
  caps: ChannelCaps;
  content: {
    /** Unset = provider `send.maxChars`. */
    maxChars?: number;
    files: ChannelFilePolicy;
    requireConfirmedEvent: boolean;
    listingHosts: string[];
    denyPatterns: string[];
  };
  schedule: { window?: ChannelScheduleWindow };
  /** Email channels only: exact addresses and `@domain` entries. */
  recipients?: string[];
};

export type ChannelPolicyInput = {
  standingGrants?: ChannelPolicy["standingGrants"];
  caps?: Partial<ChannelCaps>;
  content?: Partial<Omit<ChannelPolicy["content"], "files">> & {
    files?: Partial<ChannelFilePolicy>;
  };
  schedule?: { window?: ChannelScheduleWindow };
  recipients?: string[];
};

/** Subset of the closed provider capability vocabulary (§3.1) the engine reads. */
export type ChannelProviderCapabilities = {
  "send.text": boolean;
  "send.maxChars": number;
  "send.files": false | { types: string[]; maxBytes: number; maxCount: number };
  "send.markup"?: "plain" | "markdown" | "html";
  "send.mentions"?: "suppressed";
  "schedule.native"?: boolean;
};

export type GrantCaps = {
  perDay: number;
  perHour?: number;
  minIntervalSeconds: number;
  onePerPhase: boolean;
};

export type GrantFileScope =
  | false
  | { types?: string[]; maxBytes?: number; maxCount?: number };

export type GrantScope = {
  /** Unset = any phase. */
  phases?: GrantPhase[];
  /** `*` globs on `campaign.ref`, anchored, case-insensitive. Unset = any. */
  campaignRefs?: string[];
  files: GrantFileScope;
  maxChars?: number;
  immediate: boolean;
  scheduled: boolean;
};

/** The parts of a standing grant that define what it authorises. */
export type StandingGrantTerms = {
  caps: GrantCaps;
  scope: GrantScope;
  notBefore?: string | null;
  expires: string;
};

export type PolicyFieldError = { field: string; message: string };

export type PostCampaign = { ref?: string; phase?: string };

export type PostAttachmentFacts = {
  sha256?: string;
  contentType: string;
  bytes: number;
  name?: string;
};

/** What the engine needs to know about a post. */
export type PostFacts = {
  mode: "immediate" | "scheduled";
  sendAt?: string | null;
  text: string;
  attachments: PostAttachmentFacts[];
  campaign?: PostCampaign | null;
};

export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = Object.freeze({
  standingGrants: "disabled",
  caps: { perDay: 6, minIntervalSeconds: 600, onePerPhase: true },
  content: {
    files: {
      allowed: true,
      types: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
      maxBytes: 10 * MIB,
      maxCount: 4,
    },
    requireConfirmedEvent: false,
    listingHosts: [],
    denyPatterns: [],
  },
  schedule: {},
}) as ChannelPolicy;

function cloneDefaultPolicy(): ChannelPolicy {
  return JSON.parse(JSON.stringify(DEFAULT_CHANNEL_POLICY)) as ChannelPolicy;
}

function isPositiveInt(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;
}

function isNonNegativeInt(value: unknown, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}

function normalizeFileType(value: string): string | null {
  const lowered = value.trim().toLowerCase();
  const mapped = FILE_TYPE_ALIASES[lowered] ?? lowered;
  return MIME_PATTERN.test(mapped) ? mapped : null;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/u, "");
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates an owner policy, fills §4.3 defaults and, when the provider
 * capabilities are known, intersects with them. Defaults are silently
 * intersected with the provider; an explicit owner value wider than the
 * provider is an error (C2: no layer widens another, and the owner sees why).
 */
export function validatePolicy(
  input: ChannelPolicyInput | null | undefined,
  provider?: ChannelProviderCapabilities,
):
  | { ok: true; policy: ChannelPolicy }
  | { ok: false; error: "channel_policy_invalid"; errors: PolicyFieldError[] } {
  const errors: PolicyFieldError[] = [];
  const policy = cloneDefaultPolicy();
  const source = input ?? {};

  if (source.standingGrants !== undefined) {
    if (source.standingGrants !== "disabled" && source.standingGrants !== "allowed") {
      errors.push({ field: "standingGrants", message: "Must be disabled or allowed." });
    } else {
      policy.standingGrants = source.standingGrants;
    }
  }

  const caps = source.caps ?? {};
  if (caps.perDay !== undefined) {
    if (!isPositiveInt(caps.perDay, 10_000)) {
      errors.push({ field: "caps.perDay", message: "Must be an integer from 1 to 10000." });
    } else policy.caps.perDay = caps.perDay;
  }
  if (caps.perHour !== undefined) {
    if (!isPositiveInt(caps.perHour, 10_000)) {
      errors.push({ field: "caps.perHour", message: "Must be an integer from 1 to 10000." });
    } else policy.caps.perHour = caps.perHour;
  }
  if (caps.minIntervalSeconds !== undefined) {
    if (!isNonNegativeInt(caps.minIntervalSeconds, 7 * 86_400)) {
      errors.push({ field: "caps.minIntervalSeconds", message: "Must be an integer from 0 to 604800." });
    } else policy.caps.minIntervalSeconds = caps.minIntervalSeconds;
  }
  if (caps.onePerPhase !== undefined) {
    if (typeof caps.onePerPhase !== "boolean") {
      errors.push({ field: "caps.onePerPhase", message: "Must be a boolean." });
    } else policy.caps.onePerPhase = caps.onePerPhase;
  }
  if (policy.caps.perHour !== undefined && policy.caps.perHour > policy.caps.perDay) {
    errors.push({ field: "caps.perHour", message: "Must not exceed caps.perDay." });
  }

  const content = source.content ?? {};
  const providerMaxChars = provider?.["send.maxChars"];
  if (content.maxChars !== undefined) {
    if (!isPositiveInt(content.maxChars, 1_000_000)) {
      errors.push({ field: "content.maxChars", message: "Must be a positive integer." });
    } else if (providerMaxChars !== undefined && content.maxChars > providerMaxChars) {
      errors.push({ field: "content.maxChars", message: `Exceeds the provider limit of ${providerMaxChars}.` });
    } else policy.content.maxChars = content.maxChars;
  } else if (providerMaxChars !== undefined) {
    policy.content.maxChars = providerMaxChars;
  }

  const files = content.files ?? {};
  const providerFiles = provider ? provider["send.files"] : undefined;
  if (files.allowed !== undefined) {
    if (typeof files.allowed !== "boolean") {
      errors.push({ field: "content.files.allowed", message: "Must be a boolean." });
    } else policy.content.files.allowed = files.allowed;
  }
  if (files.types !== undefined) {
    if (!Array.isArray(files.types) || files.types.length > 32) {
      errors.push({ field: "content.files.types", message: "Must be a list of at most 32 file types." });
    } else {
      const normalized: string[] = [];
      for (const type of files.types) {
        const mime = typeof type === "string" ? normalizeFileType(type) : null;
        if (!mime) {
          errors.push({ field: "content.files.types", message: `Unknown file type ${String(type)}.` });
        } else if (providerFiles && !providerFiles.types.includes(mime)) {
          errors.push({ field: "content.files.types", message: `The provider does not accept ${mime}.` });
        } else if (!normalized.includes(mime)) {
          normalized.push(mime);
        }
      }
      policy.content.files.types = normalized;
    }
  } else if (providerFiles) {
    policy.content.files.types = policy.content.files.types.filter((type) =>
      providerFiles.types.includes(type),
    );
  }
  for (const key of ["maxBytes", "maxCount"] as const) {
    const value = files[key];
    const limit = providerFiles ? providerFiles[key] : undefined;
    if (value !== undefined) {
      const valid = key === "maxBytes" ? isPositiveInt(value, 100 * MIB) : isNonNegativeInt(value, 20);
      if (!valid) {
        errors.push({ field: `content.files.${key}`, message: "Out of range." });
      } else if (limit !== undefined && value > limit) {
        errors.push({ field: `content.files.${key}`, message: `Exceeds the provider limit of ${limit}.` });
      } else policy.content.files[key] = value;
    } else if (limit !== undefined) {
      policy.content.files[key] = Math.min(policy.content.files[key], limit);
    }
  }
  if (provider && providerFiles === false) {
    if (files.allowed === true) {
      errors.push({ field: "content.files.allowed", message: "The provider cannot send files." });
    }
    policy.content.files.allowed = false;
  }

  if (content.requireConfirmedEvent !== undefined) {
    if (typeof content.requireConfirmedEvent !== "boolean") {
      errors.push({ field: "content.requireConfirmedEvent", message: "Must be a boolean." });
    } else policy.content.requireConfirmedEvent = content.requireConfirmedEvent;
  }
  if (content.listingHosts !== undefined) {
    if (!Array.isArray(content.listingHosts) || content.listingHosts.length > 50) {
      errors.push({ field: "content.listingHosts", message: "Must be a list of at most 50 hosts." });
    } else {
      const hosts: string[] = [];
      for (const host of content.listingHosts) {
        const normalized = typeof host === "string" ? normalizeHost(host) : "";
        if (!HOST_PATTERN.test(normalized)) {
          errors.push({ field: "content.listingHosts", message: `Invalid host ${String(host)}.` });
        } else if (!hosts.includes(normalized)) hosts.push(normalized);
      }
      policy.content.listingHosts = hosts;
    }
  }
  if (policy.content.requireConfirmedEvent && policy.content.listingHosts.length === 0) {
    errors.push({ field: "content.listingHosts", message: "requireConfirmedEvent needs at least one listing host." });
  }
  if (content.denyPatterns !== undefined) {
    if (!Array.isArray(content.denyPatterns) || content.denyPatterns.length > 200) {
      errors.push({ field: "content.denyPatterns", message: "Must be a list of at most 200 patterns." });
    } else {
      const patterns: string[] = [];
      for (const pattern of content.denyPatterns) {
        if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 200) {
          errors.push({ field: "content.denyPatterns", message: "Each pattern must be 1–200 characters." });
        } else if (!patterns.includes(pattern)) patterns.push(pattern);
      }
      policy.content.denyPatterns = patterns;
    }
  }

  const window = source.schedule?.window;
  if (window !== undefined) {
    const windowErrors: string[] = [];
    if (typeof window.timeZone !== "string" || !isValidTimeZone(window.timeZone)) {
      windowErrors.push("timeZone must be an IANA time zone.");
    }
    if (!HHMM_PATTERN.test(String(window.start)) || !HHMM_PATTERN.test(String(window.end))) {
      windowErrors.push("start and end must be HH:MM.");
    } else if (window.start === window.end) {
      windowErrors.push("start and end must differ.");
    }
    if (
      window.days !== undefined &&
      (!Array.isArray(window.days) ||
        window.days.length === 0 ||
        window.days.some((day) => !isNonNegativeInt(day, 6)))
    ) {
      windowErrors.push("days must be weekday numbers 0–6.");
    }
    for (const message of windowErrors) {
      errors.push({ field: "schedule.window", message });
    }
    if (windowErrors.length === 0) {
      policy.schedule.window = {
        timeZone: window.timeZone,
        start: window.start,
        end: window.end,
        ...(window.days ? { days: [...new Set(window.days)].sort() } : {}),
      };
    }
  }

  if (source.recipients !== undefined) {
    if (!Array.isArray(source.recipients) || source.recipients.length > 500) {
      errors.push({ field: "recipients", message: "Must be a list of at most 500 entries." });
    } else {
      const recipients: string[] = [];
      for (const entry of source.recipients) {
        const value = typeof entry === "string" ? entry.trim().toLowerCase() : "";
        const domain = value.startsWith("@") ? value.slice(1) : null;
        const valid = domain !== null
          ? HOST_PATTERN.test(domain)
          : /^[^\s@]+@[^\s@]+$/u.test(value) && HOST_PATTERN.test(value.split("@")[1] ?? "");
        if (!valid) {
          errors.push({ field: "recipients", message: `Invalid recipient ${String(entry)}.` });
        } else if (!recipients.includes(value)) recipients.push(value);
      }
      policy.recipients = recipients;
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: "channel_policy_invalid", errors };
  }
  return { ok: true, policy };
}

// ---------------------------------------------------------------------------
// Standing grants (§4.4)
// ---------------------------------------------------------------------------

function parseTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function isSubset<T>(subset: readonly T[], superset: readonly T[]) {
  return subset.every((item) => superset.includes(item));
}

function fileTypes(types: readonly string[] | undefined) {
  return (types ?? []).map((type) => normalizeFileType(type) ?? type);
}

/**
 * Checks a proposed or approved grant against the current channel ceiling.
 * Lower-is-tighter for counts and sizes; higher-is-tighter for
 * `minIntervalSeconds`; `true` is tighter for `onePerPhase`. An unset grant
 * `perHour` or `maxChars` inherits the ceiling (effective = min), so it is not
 * a violation here. `expires` must be after `notBefore` and at most 90 days
 * after `approvedAt` (or `now` for a proposal).
 */
export function grantWithinCeiling(
  grant: StandingGrantTerms,
  ceiling: ChannelPolicy,
  options: { now: Date | string; approvedAt?: Date | string | null } = { now: new Date() },
):
  | { ok: true }
  | { ok: false; error: "grant_exceeds_ceiling" | "standing_grants_disabled"; fields: string[] } {
  if (ceiling.standingGrants !== "allowed") {
    return { ok: false, error: "standing_grants_disabled", fields: ["standingGrants"] };
  }
  const fields: string[] = [];
  const { caps, scope } = grant;
  const ceilingCaps = ceiling.caps;

  if (!isPositiveInt(caps.perDay) || caps.perDay > ceilingCaps.perDay) fields.push("caps.perDay");
  if (caps.perHour !== undefined) {
    if (!isPositiveInt(caps.perHour) || (ceilingCaps.perHour !== undefined && caps.perHour > ceilingCaps.perHour)) {
      fields.push("caps.perHour");
    }
  }
  if (!isNonNegativeInt(caps.minIntervalSeconds) || caps.minIntervalSeconds < ceilingCaps.minIntervalSeconds) {
    fields.push("caps.minIntervalSeconds");
  }
  if (ceilingCaps.onePerPhase && caps.onePerPhase !== true) fields.push("caps.onePerPhase");

  if (scope.maxChars !== undefined) {
    if (!isPositiveInt(scope.maxChars) || (ceiling.content.maxChars !== undefined && scope.maxChars > ceiling.content.maxChars)) {
      fields.push("scope.maxChars");
    }
  }
  if (scope.files !== false) {
    const ceilingFiles = ceiling.content.files;
    if (!ceilingFiles.allowed) {
      fields.push("scope.files");
    } else {
      if (scope.files.types !== undefined && !isSubset(fileTypes(scope.files.types), ceilingFiles.types)) {
        fields.push("scope.files.types");
      }
      if (scope.files.maxBytes !== undefined && scope.files.maxBytes > ceilingFiles.maxBytes) {
        fields.push("scope.files.maxBytes");
      }
      if (scope.files.maxCount !== undefined && scope.files.maxCount > ceilingFiles.maxCount) {
        fields.push("scope.files.maxCount");
      }
    }
  }
  if (scope.phases !== undefined && !isSubset(scope.phases, GRANT_PHASES)) fields.push("scope.phases");
  if (!scope.immediate && !scope.scheduled) fields.push("scope.mode");

  const expires = parseTime(grant.expires);
  const notBefore = parseTime(grant.notBefore);
  const anchor = parseTime(
    options.approvedAt instanceof Date ? options.approvedAt.toISOString() : options.approvedAt ?? null,
  ) ?? Date.parse(options.now instanceof Date ? options.now.toISOString() : options.now);
  if (expires === null || expires > anchor + GRANT_MAX_LIFETIME_DAYS * DAY_MS || expires <= anchor) {
    fields.push("expires");
  } else if (notBefore !== null && notBefore >= expires) {
    fields.push("notBefore");
  }
  if (grant.notBefore && notBefore === null) fields.push("notBefore");

  return fields.length === 0 ? { ok: true } : { ok: false, error: "grant_exceeds_ceiling", fields };
}

/**
 * True when `proposed` authorises nothing that `current` does not (§4.4 rule
 * 3). Unset `phases`/`campaignRefs` mean "any", so going from a set to unset
 * is widening. Glob containment is not decided: `campaignRefs` must be an
 * exact subset of the current globs.
 */
export function isNarrowing(
  current: StandingGrantTerms,
  proposed: StandingGrantTerms,
):
  | { ok: true }
  | { ok: false; error: "grant_widening_refused"; fields: string[] } {
  const fields: string[] = [];
  const a = current.caps;
  const b = proposed.caps;
  if (b.perDay > a.perDay) fields.push("caps.perDay");
  if (a.perHour !== undefined && (b.perHour === undefined || b.perHour > a.perHour)) fields.push("caps.perHour");
  if (b.minIntervalSeconds < a.minIntervalSeconds) fields.push("caps.minIntervalSeconds");
  if (a.onePerPhase && !b.onePerPhase) fields.push("caps.onePerPhase");

  const s = current.scope;
  const t = proposed.scope;
  if (s.phases !== undefined && (t.phases === undefined || !isSubset(t.phases, s.phases))) fields.push("scope.phases");
  if (s.campaignRefs !== undefined && (t.campaignRefs === undefined || !isSubset(t.campaignRefs, s.campaignRefs))) {
    fields.push("scope.campaignRefs");
  }
  if (s.maxChars !== undefined && (t.maxChars === undefined || t.maxChars > s.maxChars)) fields.push("scope.maxChars");
  if (t.files !== false) {
    if (s.files === false) {
      fields.push("scope.files");
    } else {
      if (s.files.types !== undefined && (t.files.types === undefined || !isSubset(fileTypes(t.files.types), fileTypes(s.files.types)))) {
        fields.push("scope.files.types");
      }
      if (s.files.maxBytes !== undefined && (t.files.maxBytes === undefined || t.files.maxBytes > s.files.maxBytes)) {
        fields.push("scope.files.maxBytes");
      }
      if (s.files.maxCount !== undefined && (t.files.maxCount === undefined || t.files.maxCount > s.files.maxCount)) {
        fields.push("scope.files.maxCount");
      }
    }
  }
  if (t.immediate && !s.immediate) fields.push("scope.immediate");
  if (t.scheduled && !s.scheduled) fields.push("scope.scheduled");

  const currentExpires = parseTime(current.expires);
  const proposedExpires = parseTime(proposed.expires);
  if (proposedExpires === null || currentExpires === null || proposedExpires > currentExpires) fields.push("expires");
  const currentNotBefore = parseTime(current.notBefore);
  const proposedNotBefore = parseTime(proposed.notBefore);
  if (proposed.notBefore && proposedNotBefore === null) {
    fields.push("notBefore");
  } else if (currentNotBefore !== null && (proposedNotBefore === null || proposedNotBefore < currentNotBefore)) {
    fields.push("notBefore");
  }

  return fields.length === 0 ? { ok: true } : { ok: false, error: "grant_widening_refused", fields };
}

/**
 * Effective caps = the tighter of grant and current ceiling, field by field
 * (§4.4 rule 5): smaller counts, longer interval, `onePerPhase` if either.
 * Without a grant the ceiling applies as is.
 */
export function effectiveCaps(grant: GrantCaps | null | undefined, ceiling: ChannelCaps): ChannelCaps {
  if (!grant) return { ...ceiling };
  const perHour =
    grant.perHour === undefined
      ? ceiling.perHour
      : ceiling.perHour === undefined
        ? grant.perHour
        : Math.min(grant.perHour, ceiling.perHour);
  return {
    perDay: Math.min(grant.perDay, ceiling.perDay),
    ...(perHour === undefined ? {} : { perHour }),
    minIntervalSeconds: Math.max(grant.minIntervalSeconds, ceiling.minIntervalSeconds),
    onePerPhase: grant.onePerPhase || ceiling.onePerPhase,
  };
}

/** Simple `*` glob: anchored, case-insensitive, every other character literal. */
export function globMatches(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\/-]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "iu").test(value);
}

export type GrantForCoverage = StandingGrantTerms & { status: string };

/**
 * Whether an active standing grant covers this exact post (§6 step 3c). For a
 * scheduled post the send time must also fall inside the grant window, since
 * the grant is re-checked at send time.
 */
export function grantCoversPost(
  grant: GrantForCoverage,
  post: PostFacts,
  now: Date | string,
): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const nowMs = Date.parse(now instanceof Date ? now.toISOString() : now);
  if (grant.status !== "active") reasons.push("grant_not_active");

  const notBefore = parseTime(grant.notBefore);
  const expires = parseTime(grant.expires);
  const effectiveAt = post.mode === "scheduled" ? parseTime(post.sendAt) : nowMs;
  if (notBefore !== null && nowMs < notBefore) reasons.push("grant_not_yet_valid");
  if (expires === null || nowMs >= expires) reasons.push("grant_expired");
  if (effectiveAt === null) {
    reasons.push("send_at_missing");
  } else if (post.mode === "scheduled") {
    if (notBefore !== null && effectiveAt < notBefore) reasons.push("send_at_before_grant");
    if (expires !== null && effectiveAt >= expires) reasons.push("send_at_after_grant");
  }

  const scope = grant.scope;
  if (post.mode === "immediate" && !scope.immediate) reasons.push("mode_immediate_not_covered");
  if (post.mode === "scheduled" && !scope.scheduled) reasons.push("mode_scheduled_not_covered");

  const phase = post.campaign?.phase;
  if (scope.phases !== undefined && (!phase || !(scope.phases as readonly string[]).includes(phase))) {
    reasons.push("phase_not_covered");
  }
  const ref = post.campaign?.ref;
  if (scope.campaignRefs !== undefined && (!ref || !scope.campaignRefs.some((glob) => globMatches(glob, ref)))) {
    reasons.push("campaign_ref_not_covered");
  }
  if (scope.maxChars !== undefined && textLength(post.text) > scope.maxChars) reasons.push("text_too_long_for_grant");

  if (post.attachments.length > 0) {
    if (scope.files === false) {
      reasons.push("files_not_covered");
    } else {
      const files = scope.files;
      if (files.maxCount !== undefined && post.attachments.length > files.maxCount) reasons.push("too_many_files_for_grant");
      const types = files.types === undefined ? undefined : fileTypes(files.types);
      for (const attachment of post.attachments) {
        const type = normalizeFileType(attachment.contentType) ?? attachment.contentType;
        if (types !== undefined && !types.includes(type)) {
          reasons.push("file_type_not_covered");
          break;
        }
      }
      if (files.maxBytes !== undefined && post.attachments.some((file) => file.bytes > files.maxBytes!)) {
        reasons.push("file_too_large_for_grant");
      }
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Content rules (§6 step 3b)
// ---------------------------------------------------------------------------

export type ChannelContentError =
  | "channel_text_too_long"
  | "channel_files_not_allowed"
  | "channel_file_type_not_allowed"
  | "channel_file_too_large"
  | "channel_too_many_files"
  | "channel_content_denied"
  | "channel_event_unconfirmed"
  | "channel_outside_window";

/**
 * Text length in UTF-16 code units (`String#length`). This is never smaller
 * than the code-point count, so a text that passes here never needs a cut at
 * the provider (Telegram counts UTF-16 units).
 */
export function textLength(text: string): number {
  return text.length;
}

/**
 * Static part of the confirmed-event rule: `https`, no userinfo, and the host
 * equals a listing host or is a subdomain of one (`lu.ma` admits
 * `www.lu.ma`, never `lu.ma.evil.io` or `evillu.ma`).
 */
export function eventHostAllowed(ref: string | null | undefined, listingHosts: readonly string[]): boolean {
  if (!ref) return false;
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = normalizeHost(url.hostname);
  return listingHosts.some((entry) => {
    const allowed = normalizeHost(entry);
    return allowed.length > 0 && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

function localClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  return { minutes: Number(part("hour")) * 60 + Number(part("minute")), weekday };
}

/** True when `at` is inside the local-time window (or there is no window). */
export function insideScheduleWindow(window: ChannelScheduleWindow | undefined, at: Date): boolean {
  if (!window) return true;
  const { minutes, weekday } = localClock(at, window.timeZone);
  const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const inside = start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  if (!inside) return false;
  return window.days === undefined || window.days.includes(weekday);
}

/**
 * Content rules for one post. Returns every failing code, never a corrected
 * post: long texts are refused, not cut. The live event check is separate
 * (`confirmEventLive`) and runs at send time.
 */
export function evaluateContent(
  post: Omit<PostFacts, "mode"> & { mode?: PostFacts["mode"] },
  policy: ChannelPolicy,
  provider?: ChannelProviderCapabilities,
  options: { now?: Date | string } = {},
): { ok: true } | { ok: false; errors: ChannelContentError[] } {
  const errors: ChannelContentError[] = [];

  const limits = [policy.content.maxChars, provider?.["send.maxChars"]].filter(
    (value): value is number => typeof value === "number",
  );
  if (limits.length > 0 && textLength(post.text) > Math.min(...limits)) {
    errors.push("channel_text_too_long");
  }

  if (post.attachments.length > 0) {
    const files = policy.content.files;
    const providerFiles = provider ? provider["send.files"] : undefined;
    if (!files.allowed || providerFiles === false) {
      errors.push("channel_files_not_allowed");
    } else {
      const types = providerFiles ? files.types.filter((type) => providerFiles.types.includes(type)) : files.types;
      const maxBytes = providerFiles ? Math.min(files.maxBytes, providerFiles.maxBytes) : files.maxBytes;
      const maxCount = providerFiles ? Math.min(files.maxCount, providerFiles.maxCount) : files.maxCount;
      if (post.attachments.some((file) => !types.includes(normalizeFileType(file.contentType) ?? file.contentType))) {
        errors.push("channel_file_type_not_allowed");
      }
      if (post.attachments.some((file) => file.bytes > maxBytes)) errors.push("channel_file_too_large");
      if (post.attachments.length > maxCount) errors.push("channel_too_many_files");
    }
  }

  const lowered = post.text.toLowerCase();
  if (policy.content.denyPatterns.some((pattern) => lowered.includes(pattern.toLowerCase()))) {
    errors.push("channel_content_denied");
  }

  if (policy.content.requireConfirmedEvent && !eventHostAllowed(post.campaign?.ref, policy.content.listingHosts)) {
    errors.push("channel_event_unconfirmed");
  }

  if (policy.schedule.window) {
    const at = post.sendAt ? new Date(post.sendAt) : options.now ? new Date(options.now) : new Date();
    if (Number.isNaN(at.getTime()) || !insideScheduleWindow(policy.schedule.window, at)) {
      errors.push("channel_outside_window");
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Live half of `requireConfirmedEvent`: the listing answers HTTP 2xx after
 * redirects. Any error, timeout or non-https URL is `false`. Callers check
 * `eventHostAllowed` first; this function only fetches `https` URLs.
 */
export async function confirmEventLive(
  url: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    if (new URL(url).protocol !== "https:") return false;
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Digests (§4.4, §4.6)
// ---------------------------------------------------------------------------

export type ChannelPayloadDigestInput = {
  workspace: string;
  channelId: string;
  provider: string;
  /** Destination `externalId`. */
  destination: string;
  /** Operation, e.g. `post`, `schedule`, `test`. */
  op: string;
  text: string;
  attachments: Array<{ sha256: string; contentType: string; name: string }>;
  campaign?: PostCampaign | null;
  sendAt?: string | null;
};

/**
 * §4.6 payload digest. Attachments keep their order and carry only
 * `{sha256, contentType, name}`. A missing campaign digests as `{}`, so
 * "no campaign" and "empty campaign" are the same payload. `sendAt` is
 * normalised to an ISO instant and omitted for immediate posts.
 */
export function channelPayloadDigest(input: ChannelPayloadDigestInput): string {
  const campaign: PostCampaign = {};
  if (input.campaign?.ref !== undefined && input.campaign.ref !== null) campaign.ref = input.campaign.ref;
  if (input.campaign?.phase !== undefined && input.campaign.phase !== null) campaign.phase = input.campaign.phase;
  return sha256Hex(
    canonicalJson({
      v: 1,
      workspace: input.workspace,
      channelId: input.channelId,
      provider: input.provider,
      destination: input.destination,
      op: input.op,
      text: input.text,
      attachments: input.attachments.map((file) => ({
        sha256: file.sha256,
        contentType: file.contentType,
        name: file.name,
      })),
      campaign,
      sendAt: input.sendAt ? new Date(input.sendAt).toISOString() : undefined,
    }),
  );
}

/** §4.4 grant digest: SHA-256 of the canonical final grant terms. */
export function standingGrantDigest(input: {
  workspace: string;
  channelId: string;
  agentId: string;
  consentId: string;
  purpose: string;
  terms: StandingGrantTerms;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      workspace: input.workspace,
      channelId: input.channelId,
      agentId: input.agentId,
      consentId: input.consentId,
      purpose: input.purpose,
      caps: input.terms.caps,
      scope: input.terms.scope,
      notBefore: input.terms.notBefore ? new Date(input.terms.notBefore).toISOString() : undefined,
      expires: new Date(input.terms.expires).toISOString(),
    }),
  );
}

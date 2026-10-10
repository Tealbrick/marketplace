import {
  type AttachmentKind,
  type ChannelCapabilities,
  type ChannelMarkup,
  type OutboundPoll,
  type ImageCapability,
  type MediaCapability,
  type OutboundAttachment,
  type VoiceNativeCapability,
} from "./types.js";

// Pure helpers over the capability declaration (spec 3.1). No I/O, no provider state.

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ["image", "file", "audio", "voice", "video"];

/** Most attachments in one post, whatever their kind (P1 policy; equals `image.albumMax` for both providers). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_TRANSCRIPT_CHARS = 1000;
export const VOICE_FALLBACK_MARKER = "voice→audio+transcript";
export const TRANSCRIPT_PREFIX = "Transcript: ";

export type DeclaredKindSpec = ImageCapability | MediaCapability | VoiceNativeCapability;

/**
 * What the provider declares for one attachment kind:
 * the spec object, "fallback" (voice only, when the provider declares `{fallback: ...}`), or null (not declared).
 */
export function capabilityForKind(caps: ChannelCapabilities, kind: AttachmentKind): DeclaredKindSpec | "fallback" | null {
  switch (kind) {
    case "image":
      return caps.image || null;
    case "file":
      return caps.file || null;
    case "audio":
      return caps.audio || null;
    case "video":
      return caps.video || null;
    case "voice":
      if (!caps.voice) {
        return null;
      }
      return "native" in caps.voice ? caps.voice : "fallback";
    default:
      return null;
  }
}

/** Types and size cap of a declared kind, including a fallback voice (whose limits describe the OGG source). */
export function kindLimits(caps: ChannelCapabilities, kind: AttachmentKind): MediaCapability | null {
  if (kind === "voice") {
    return caps.voice || null;
  }
  const spec = capabilityForKind(caps, kind);
  return spec === null || spec === "fallback" ? null : spec;
}

export type SendError = { errorCode: string; detail: string };

export type FallbackOutcome =
  | { text: string; attachments: OutboundAttachment[]; fallbacks: string[] }
  | { error: SendError };

// Control characters other than newline and tab (and bidi overrides) are not plain text.
const UNSAFE_TRANSCRIPT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩؜﻿]/u;

function transcriptProblem(attachment: OutboundAttachment): SendError | undefined {
  const transcript = attachment.transcript;
  if (transcript === undefined) {
    return undefined;
  }
  if (attachment.kind !== "voice") {
    return { errorCode: "channel_transcript_unsupported", detail: "a transcript belongs only on a voice attachment" };
  }
  if (typeof transcript !== "string" || transcript.trim().length === 0 || UNSAFE_TRANSCRIPT.test(transcript)) {
    return { errorCode: "channel_transcript_invalid", detail: "a transcript must be non-empty plain text" };
  }
  if (Array.from(transcript).length > MAX_TRANSCRIPT_CHARS) {
    return { errorCode: "channel_transcript_too_long", detail: `a transcript is longer than ${MAX_TRANSCRIPT_CHARS} characters` };
  }
  return undefined;
}

/**
 * Pure: the post as the provider will really send it, before the digest is computed (spec 3.1).
 * A voice attachment on a provider with a voice fallback becomes an `audio` attachment, and its transcript is
 * appended to the text as one `Transcript: <transcript>` line per voice attachment. The fallback is named.
 * Refuses (an `error`, no side effect): an undeclared kind (channel_capability_unavailable), a bad transcript,
 * a fallback voice without transcript (channel_voice_transcript_required), a fallback whose audio target is
 * not declared, and a resulting text over `text.maxChars` (channel_text_too_long). Never cuts text.
 */
export function applyFallbacks(
  caps: ChannelCapabilities,
  input: { text: string; attachments: readonly OutboundAttachment[] },
): FallbackOutcome {
  const lines: string[] = [];
  const fallbacks: string[] = [];
  const attachments: OutboundAttachment[] = [];

  for (const attachment of input.attachments) {
    const declared = ATTACHMENT_KINDS.includes(attachment.kind) ? capabilityForKind(caps, attachment.kind) : null;
    if (declared === null) {
      return { error: { errorCode: "channel_capability_unavailable", detail: `this provider does not declare "${String(attachment.kind)}"` } };
    }
    const problem = transcriptProblem(attachment);
    if (problem) {
      return { error: problem };
    }
    if (declared !== "fallback") {
      attachments.push(attachment);
      continue;
    }
    if (attachment.transcript === undefined) {
      return { error: { errorCode: "channel_voice_transcript_required", detail: "this provider sends voice as audio plus a transcript; a transcript is required" } };
    }
    if (!caps.audio) {
      return { error: { errorCode: "channel_capability_unavailable", detail: "the voice fallback needs audio, which this provider does not declare" } };
    }
    const { transcript, ...rest } = attachment;
    attachments.push({ ...rest, kind: "audio" });
    lines.push(`${TRANSCRIPT_PREFIX}${transcript}`);
    if (!fallbacks.includes(VOICE_FALLBACK_MARKER)) {
      fallbacks.push(VOICE_FALLBACK_MARKER);
    }
  }

  const text =
    lines.length === 0 ? input.text : input.text.trim().length > 0 ? `${input.text}\n${lines.join("\n")}` : lines.join("\n");
  if (text.length > caps.text.maxChars) {
    return {
      error: { errorCode: "channel_text_too_long", detail: `text is ${text.length} characters; this provider allows ${caps.text.maxChars}` },
    };
  }
  return { text, attachments, fallbacks };
}

/** Closed list of features a caller can ask a provider about (v2 vocabulary, P2 scope 2.1). */
export const CHANNEL_FEATURES = [
  "image",
  "file",
  "audio",
  "voice",
  "video",
  "dm",
  "thread.replies",
  "thread.topics",
  "thread.forum",
  "mentions.users",
  "reactions.add",
  "reactions.remove",
  "reactions.custom",
  "edit",
  "delete",
  "canvas",
  "presence.typing",
  "presence.status",
  "ephemeral",
  "live.join",
  "live.listen",
  "live.speak",
  "live.transcript",
  "poll",
  "markup.markdown-v2",
  "buttons.url",
  "buttons.callback",
  "events.create",
  "schedule.native",
  "inbound",
] as const;

export type ChannelFeature = (typeof CHANNEL_FEATURES)[number];

/**
 * Pure: does the provider DECLARE this feature (spec 3.1)? A routes-side gate: an undeclared feature is refused
 * with `channel_capability_unavailable`. A voice fallback counts as declared (it is named in the receipt).
 * `edit` and `delete` mean the agent's own message. `inbound` means a mode other than `none`.
 * An unknown feature name is never supported.
 */
export function capabilitySupports(caps: ChannelCapabilities, feature: ChannelFeature | (string & {})): boolean {
  switch (feature) {
    case "image":
    case "file":
    case "audio":
    case "voice":
    case "video":
      return capabilityForKind(caps, feature as AttachmentKind) !== null;
    case "dm":
      return caps.dm.open;
    case "thread.replies":
      return caps.thread.replies;
    case "thread.topics":
      return caps.thread.topics;
    case "thread.forum":
      return caps.thread.forum;
    case "mentions.users":
      return caps.mentions.users;
    case "reactions.add":
      return caps.reactions.add;
    case "reactions.remove":
      return caps.reactions.remove;
    case "reactions.custom":
      return caps.reactions.custom;
    case "edit":
      return caps.edit.own;
    case "delete":
      return caps.delete.own;
    case "canvas":
      return caps.canvas;
    case "presence.typing":
      return caps.presence.typing;
    case "presence.status":
      return caps.presence.status;
    case "ephemeral":
      return caps.ephemeral;
    case "live.join":
    case "live.listen":
    case "live.speak":
    case "live.transcript":
      return caps.live !== false && caps.live[feature.slice("live.".length) as "join" | "listen" | "speak" | "transcript"];
    case "poll":
      return caps.poll !== false;
    case "markup.markdown-v2":
      return markupSupported(caps, "markdown-v2");
    case "buttons.url":
      return caps.buttons.url;
    case "buttons.callback":
      return caps.buttons.callback;
    case "events.create":
      return caps.events.create;
    case "schedule.native":
      return caps.schedule.native;
    case "inbound":
      return caps.inbound.mode !== "none";
    default:
      return false;
  }
}

/** Refusal for an undeclared feature, or `null` when it is declared. Callers add no side effect before this check. */
export function featureRefusal(caps: ChannelCapabilities, feature: ChannelFeature | (string & {})): SendError | null {
  return capabilitySupports(caps, feature)
    ? null
    : { errorCode: "channel_capability_unavailable", detail: `this provider does not declare "${feature}"` };
}

/**
 * Closed set of features an agent operation can really use TODAY (review of PR #43). The P1 post and schedule
 * routes send text plus the declared attachment kinds (a fallback voice included) to a discovered destination,
 * and a Telegram forum topic is such a destination (`thread.topics`). Nothing else has a route yet: no reply in a
 * thread, mention of a person, DM, reaction, edit, delete, poll, button, event, native schedule (P1 scheduling is
 * Marketplace-side), presence, canvas, live voice or inbound delivery.
 * Adapters keep declaring what they CAN do; a later change adds a feature here in the same change that ships its
 * operation. Agents and the owner UI only ever see `declaration ∩ wired` (see `wiredCapabilities`).
 */
export const AGENT_WIRED_FEATURES: ReadonlySet<ChannelFeature> = new Set<ChannelFeature>([
  "image",
  "file",
  "audio",
  "voice",
  "video",
  "thread.topics",
  // Channels P2 inbound worker: `marketplace.channels.inbound` delivers routed messages, and
  // `marketplace.channels.reply` replies natively in the source thread (the only operation that sets `replyTo`).
  "inbound",
  "thread.replies",
]);

/**
 * Pure: the effective capability answer, the provider declaration narrowed to the wired features. Every feature
 * outside `wired` reads as not available (`false`, `none`, zero members); everything that is not a feature
 * (text limits, markup, discover, limits, broadcast suppression) is kept. For every feature,
 * `capabilitySupports(wiredCapabilities(caps), f) === capabilitySupports(caps, f) && wired.has(f)`.
 */
export function wiredCapabilities(
  caps: ChannelCapabilities,
  wired: ReadonlySet<ChannelFeature> = AGENT_WIRED_FEATURES,
): ChannelCapabilities {
  const on = (feature: ChannelFeature) => wired.has(feature) && capabilitySupports(caps, feature);
  const live = caps.live;
  const liveOn = live !== false && (["live.join", "live.listen", "live.speak", "live.transcript"] as const).some(on);
  const dmOn = on("dm");
  const editOn = on("edit");
  // No route lets a post choose another markup yet, so `markupOptions` is not part of the effective answer.
  const { markupOptions: _unwiredMarkup, ...declared } = caps;
  return {
    ...declared,
    mentions: { ...caps.mentions, users: on("mentions.users") },
    dm: { open: dmOn, maxMembers: dmOn ? caps.dm.maxMembers : 0 },
    image: on("image") ? caps.image : false,
    file: on("file") ? caps.file : false,
    audio: on("audio") ? caps.audio : false,
    voice: on("voice") ? caps.voice : false,
    video: on("video") ? caps.video : false,
    thread: { replies: on("thread.replies"), topics: on("thread.topics"), forum: on("thread.forum") },
    reactions: { add: on("reactions.add"), remove: on("reactions.remove"), custom: on("reactions.custom") },
    buttons: { url: on("buttons.url"), callback: on("buttons.callback") },
    poll: on("poll") ? caps.poll : false,
    edit: editOn ? caps.edit : { own: false },
    delete: on("delete") ? caps.delete : { own: false },
    canvas: on("canvas"),
    presence: { typing: on("presence.typing"), status: on("presence.status") },
    ephemeral: on("ephemeral"),
    live:
      live !== false && liveOn
        ? {
            join: on("live.join"),
            listen: on("live.listen"),
            speak: on("live.speak"),
            transcript: on("live.transcript"),
            maxSessionMinutes: live.maxSessionMinutes,
          }
        : false,
    schedule: { native: on("schedule.native") },
    events: { create: on("events.create") },
    inbound: on("inbound") ? caps.inbound : { mode: "none", dedupe: false },
  };
}

/** Pure: may a post ask for this markup? The default markup always; another one only when listed in `markupOptions`. */
export function markupSupported(caps: ChannelCapabilities, markup: ChannelMarkup | (string & {})): boolean {
  return markup === caps.markup || (caps.markupOptions ?? []).includes(markup as ChannelMarkup);
}

// Control characters (newline included: a poll question and option are one line), bidi overrides, zero-width marks.
const UNSAFE_POLL_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/u;

/**
 * Pure: refuses a poll the provider would not send exactly as given (never cuts or drops an option).
 * Checks: `poll` declared, question and options are one line of plain text within the provider's limits,
 * the option count, no duplicate option, `allowsMultiple` only where declared, and `durationHours` only where
 * declared and inside its range. Lengths are in code points.
 */
export function pollProblem(caps: ChannelCapabilities, poll: OutboundPoll | undefined): SendError | undefined {
  if (poll === undefined) {
    return undefined;
  }
  const limits = caps.poll;
  if (!limits) {
    return { errorCode: "channel_capability_unavailable", detail: 'this provider does not declare "poll"' };
  }
  const invalid = (detail: string): SendError => ({ errorCode: "channel_poll_invalid", detail });
  if (!poll || typeof poll !== "object") {
    return invalid("a poll needs a question and options");
  }
  const lineProblem = (value: unknown, max: number, what: string): string | undefined => {
    if (typeof value !== "string" || value.trim().length === 0 || UNSAFE_POLL_TEXT.test(value)) {
      return `the ${what} must be one non-empty line of plain text`;
    }
    return Array.from(value).length > max ? `the ${what} is longer than ${max} characters` : undefined;
  };
  const question = lineProblem(poll.question, limits.questionMaxChars, "poll question");
  if (question) {
    return invalid(question);
  }
  if (!Array.isArray(poll.options) || poll.options.length < limits.minOptions || poll.options.length > limits.maxOptions) {
    return invalid(`a poll needs ${limits.minOptions}-${limits.maxOptions} options`);
  }
  for (const option of poll.options) {
    const problem = lineProblem(option, limits.optionMaxChars, "poll option");
    if (problem) {
      return invalid(problem);
    }
  }
  if (new Set(poll.options.map((option) => option.trim().toLowerCase())).size !== poll.options.length) {
    return invalid("two poll options are the same");
  }
  if (poll.allowsMultiple !== undefined && typeof poll.allowsMultiple !== "boolean") {
    return invalid("allowsMultiple must be true or false");
  }
  if (poll.allowsMultiple === true && !limits.multiple) {
    return invalid("this provider does not allow multiple answers");
  }
  if (poll.durationHours !== undefined) {
    const range = limits.durationHours;
    if (!range) {
      return invalid("this provider does not take a poll duration");
    }
    if (!Number.isInteger(poll.durationHours) || poll.durationHours < range.min || poll.durationHours > range.max) {
      return invalid(`the poll duration must be ${range.min}-${range.max} whole hours`);
    }
  }
  return undefined;
}

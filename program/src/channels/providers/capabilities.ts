import {
  type AttachmentKind,
  type ChannelCapabilities,
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
      return caps.poll;
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

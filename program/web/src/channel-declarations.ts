/**
 * Static P1 provider capability declarations (Channels spec §3.1), mirrored
 * for the owner UI. The owner browse answer carries each channel's effective
 * capabilities, but not the provider declaration itself, which the create
 * form needs before a channel exists (to offer only declared file types and
 * limits). `src/channels/web-declarations.test.ts` fails when this copy drifts
 * from the adapters. The server validates every policy again; this copy only
 * limits what the form offers.
 *
 * No imports: the backend test suite imports this file directly.
 */

export type DeclaredMedia = { types: readonly string[]; maxBytes: number };

export type ProviderDeclaration = {
  text: { maxChars: number; captionMaxChars?: number };
  markup: string;
  mentions: "suppressed";
  image: (DeclaredMedia & { albumMax: number }) | false;
  file: DeclaredMedia | false;
  audio: DeclaredMedia | false;
  voice: (DeclaredMedia & { native: true; maxSeconds?: number }) | (DeclaredMedia & { fallback: "audio+transcript" }) | false;
  video: DeclaredMedia | false;
  thread: { topics: boolean; replies: boolean } | false;
  discover: "updates" | "list" | "manual";
  limits: { perChatPerSecond?: number; perChatPerMinute?: number; retryAfter: "honoured" };
};

const MIB = 1024 * 1024;
const DOCUMENT_TYPES = ["application/pdf", "text/plain", "application/zip", "application/octet-stream"];

export const PROVIDER_DECLARATIONS = {
  telegram: {
    text: { maxChars: 4096, captionMaxChars: 1024 },
    markup: "plain",
    mentions: "suppressed",
    image: { types: ["image/png", "image/jpeg", "image/webp"], maxBytes: 10 * MIB, albumMax: 4 },
    file: { types: DOCUMENT_TYPES, maxBytes: 50 * MIB },
    audio: { types: ["audio/mpeg", "audio/mp4"], maxBytes: 50 * MIB },
    voice: { native: true, types: ["audio/ogg"], maxBytes: 1 * MIB },
    video: { types: ["video/mp4"], maxBytes: 50 * MIB },
    thread: { topics: true, replies: false },
    discover: "updates",
    limits: { perChatPerSecond: 1, perChatPerMinute: 20, retryAfter: "honoured" },
  },
  discord: {
    text: { maxChars: 2000 },
    markup: "discord-markdown",
    mentions: "suppressed",
    image: { types: ["image/png", "image/jpeg", "image/webp", "image/gif"], maxBytes: 10 * MIB, albumMax: 4 },
    file: { types: DOCUMENT_TYPES, maxBytes: 10 * MIB },
    audio: { types: ["audio/mpeg", "audio/mp4", "audio/ogg"], maxBytes: 10 * MIB },
    voice: { fallback: "audio+transcript", types: ["audio/ogg"], maxBytes: 10 * MIB },
    video: { types: ["video/mp4"], maxBytes: 10 * MIB },
    thread: false,
    discover: "list",
    limits: { perChatPerSecond: 1, perChatPerMinute: 60, retryAfter: "honoured" },
  },
} as const satisfies Record<string, ProviderDeclaration>;

/** Most attachments in one post for every P1 provider (server `MAX_ATTACHMENTS_PER_MESSAGE`). */
export const MAX_ATTACHMENTS_PER_POST = 4;

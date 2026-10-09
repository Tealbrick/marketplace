// Channel provider adapter contract (Marketplace Channels spec v0.2, sections 3.1, 7, 9).
// Adapters never throw for provider or network problems. They return a typed result.
// A credential (bot token) is never part of any returned value.

export type ChannelProviderId = "telegram" | "discord";

/** Version of the closed capability vocabulary (spec 3.1). New keys need a contract minor bump. */
export const CHANNEL_CAPABILITIES_VERSION = 1;

export type AttachmentKind = "image" | "file" | "audio" | "voice" | "video";

/** Media kind limits: allowed content types (lowercase, no parameters) and the per-file byte cap. */
export type MediaCapability = {
  types: readonly string[];
  maxBytes: number;
};

export type ImageCapability = MediaCapability & {
  /** Most images in one album (and, in P1, the cap for all attachments of one message). */
  albumMax: number;
};

export type VoiceNativeCapability = MediaCapability & {
  native: true;
  maxSeconds?: number;
};

/** The provider has no voice message of its own: a voice post is sent as an audio file plus its transcript text. */
export type VoiceFallbackCapability = MediaCapability & {
  fallback: "audio+transcript";
};

export type ChannelCapabilities = {
  channelCapabilities: typeof CHANNEL_CAPABILITIES_VERSION;
  text: { maxChars: number; captionMaxChars?: number };
  markup: "plain" | "markdown-v2" | "discord-markdown" | "mrkdwn" | "html";
  mentions: "suppressed";
  image: ImageCapability | false;
  file: MediaCapability | false;
  audio: MediaCapability | false;
  voice: VoiceNativeCapability | VoiceFallbackCapability | false;
  video: MediaCapability | false;
  thread: { topics: boolean; replies: boolean } | false;
  reactions: boolean;
  buttons: { url: boolean; callback: boolean };
  poll: boolean;
  edit: boolean;
  delete: boolean;
  schedule: { native: boolean };
  events: { create: boolean };
  discover: "updates" | "list" | "manual";
  inbound: "webhook" | "poll" | "gateway" | "none";
  audience: { count: boolean };
  limits: {
    perChatPerSecond?: number;
    perChatPerMinute?: number;
    retryAfter: "honoured";
  };
};

export type ChannelDestinationType = "chat" | "group" | "channel" | "topic" | "thread";

export type ChannelDestination = {
  type: ChannelDestinationType;
  externalId: string;
  /** Untrusted provider text: capped at 128 characters, control characters removed. */
  title: string;
  url?: string;
  /** Discord guild id, or Telegram forum topic thread id. */
  parentId?: string;
};

export type OutboundAttachment = {
  /** Must be declared by the provider (spec 3.1); the content type must match that kind. */
  kind: AttachmentKind;
  /**
   * Plain text, at most 1000 characters. Only for `voice`. REQUIRED when the provider's voice is a fallback
   * (it is posted as text). A provider with native voice does not post it.
   */
  transcript?: string;
  bytes: Uint8Array;
  contentType: string;
  name: string;
  /** Lowercase hex SHA-256 of `bytes`. The adapter refuses to send when it does not match. */
  sha256: string;
};

export type OutboundMessage = {
  text: string;
  attachments?: readonly OutboundAttachment[];
};

export type SendStatus = "sent" | "failed" | "uncertain";

export type SendResult = {
  status: SendStatus;
  resultIds: string[];
  resultUrls: string[];
  detail?: string;
  errorCode?: string;
  /**
   * True when status is not "sent" but at least one message was already delivered
   * (resultIds is not empty). A blind retry would duplicate the delivered messages.
   */
  partial?: true;
  /** Named fallback the adapter applied, for the receipt (spec 3.1), e.g. "voice→audio+transcript". */
  fallback?: string;
};

export type VerifyFailureReason = "credential_missing" | "credential_invalid" | "provider_unavailable";

export type VerifyResult =
  | { ok: true; botId: string; botUsername: string }
  | { ok: false; reason: VerifyFailureReason };

export type DiscoverFailureReason = VerifyFailureReason | "consumer_conflict";

export type DiscoverResult =
  | { ok: true; destinations: ChannelDestination[] }
  | { ok: false; reason: DiscoverFailureReason };

export type ChannelProvider = {
  readonly id: ChannelProviderId;
  readonly capabilities: ChannelCapabilities;
  verify(credential: string | null | undefined): Promise<VerifyResult>;
  discover(credential: string | null | undefined): Promise<DiscoverResult>;
  send(
    credential: string | null | undefined,
    destination: ChannelDestination,
    message: OutboundMessage,
  ): Promise<SendResult>;
};

/** Options injected at construction. Every field is optional; tests inject fakes. */
export type ChannelProviderOptions = {
  fetchImpl?: typeof fetch;
  /** Used for rate-limit waits and retry_after waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds clock for the token buckets. */
  now?: () => number;
  /** Per-request timeout, covers headers and body. Default 15000. */
  timeoutMs?: number;
};

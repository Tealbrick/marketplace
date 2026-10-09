// Channel provider adapter contract (Marketplace Channels spec v0.2, sections 3.1, 7, 9).
// Adapters never throw for provider or network problems. They return a typed result.
// A credential (bot token) is never part of any returned value.

export type ChannelProviderId = "telegram" | "discord";

export type ChannelFileCapability = {
  types: string[];
  maxBytes: number;
  maxCount: number;
};

/** Closed vocabulary `channelCapabilities: 1` (spec 3.1). Keys are nested: `send.text` is `send: { text }`. */
export type ChannelCapabilities = {
  send: {
    text: boolean;
    maxChars: number;
    files: ChannelFileCapability | false;
    markup: "plain" | "markdown" | "html";
    mentions: "suppressed";
  };
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

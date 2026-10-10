// Channel provider adapter contract (Marketplace Channels spec v0.2, sections 3.1, 7, 9).
// Adapters never throw for provider or network problems. They return a typed result.
// A credential (bot token) is never part of any returned value.

export type ChannelProviderId = "telegram" | "discord" | "slack";

/**
 * Version of the closed capability vocabulary (spec 3.1; P2 scope 2.1). New keys need a contract minor bump.
 * v2 refines v1's `thread`, `reactions`, `edit`, `delete`, `mentions` and `inbound`, and adds `dm`, `canvas`,
 * `presence`, `ephemeral` and `live`. A feature is offered only when its adapter really does it today.
 */
export const CHANNEL_CAPABILITIES_VERSION = 2;

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

/** Live voice sessions (huddles, voice channels). `false` when the provider has none. */
export type LiveCapability = {
  join: boolean;
  listen: boolean;
  speak: boolean;
  transcript: boolean;
  maxSessionMinutes: number;
};

export type InboundMode = "socket" | "webhook" | "poll" | "none";

export type ChannelCapabilities = {
  channelCapabilities: typeof CHANNEL_CAPABILITIES_VERSION;
  text: { maxChars: number; captionMaxChars?: number };
  markup: "plain" | "markdown-v2" | "discord-markdown" | "mrkdwn" | "html";
  /** Mention named users; broadcast mentions never ping (`suppressed`) in every version. */
  mentions: { users: boolean; broadcast: "suppressed" };
  /** Direct messages to named people: `open` when the adapter can start one, up to `maxMembers` people. */
  dm: { open: boolean; maxMembers: number };
  image: ImageCapability | false;
  file: MediaCapability | false;
  audio: MediaCapability | false;
  voice: VoiceNativeCapability | VoiceFallbackCapability | false;
  video: MediaCapability | false;
  /** `replies` reply in a thread, `topics` forum topics as destinations, `forum` post a new forum thread. */
  thread: { replies: boolean; topics: boolean; forum: boolean };
  reactions: { add: boolean; remove: boolean; custom: boolean };
  buttons: { url: boolean; callback: boolean };
  poll: boolean;
  /** Edit or delete the agent's own message. `windowSeconds` is the provider's edit window, when it has one. */
  edit: { own: boolean; windowSeconds?: number };
  delete: { own: boolean };
  /** Shared document per channel. */
  canvas: boolean;
  presence: { typing: boolean; status: boolean };
  /** Messages that only one user sees, or that expire. */
  ephemeral: boolean;
  live: LiveCapability | false;
  schedule: { native: boolean };
  events: { create: boolean };
  discover: "updates" | "list" | "manual";
  /** How the provider delivers messages to agents (`none` today for every adapter) and whether events are de-duplicated. */
  inbound: { mode: InboundMode; dedupe: boolean };
  audience: { count: boolean };
  limits: {
    perChatPerSecond?: number;
    perChatPerMinute?: number;
    retryAfter: "honoured";
  };
};

/** `person`: a direct message with one named person (P2 scope 2.2a item 4), from `openDirect`. */
export type ChannelDestinationType = "chat" | "group" | "channel" | "topic" | "thread" | "person";

export type ChannelDestination = {
  type: ChannelDestinationType;
  externalId: string;
  /** Untrusted provider text: capped at 128 characters, control characters removed. */
  title: string;
  url?: string;
  /** Discord guild id, Telegram forum topic thread id, or the Slack thread root `ts` of a `thread` destination. */
  parentId?: string;
  /** Platform user id of the other person, only on a `person` destination. */
  personId?: string;
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

/** A named person to mention, by platform user id. Broadcast mentions (channel, here, everyone) never ping. */
export type OutboundMention = { userId: string };

export type OutboundMessage = {
  text: string;
  attachments?: readonly OutboundAttachment[];
  /** Provider message id to reply to (Slack: the thread root `ts`). Only where `thread.replies` is declared. */
  replyTo?: string;
  /** Named people to mention. Only where `mentions.users` is declared; otherwise refused. */
  mentions?: readonly OutboundMention[];
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

/** Outcome of a reaction or a delete: no new message, so no result ids. Same status rules as `SendResult`. */
export type ActionResult = {
  status: SendStatus;
  detail?: string;
  errorCode?: string;
};

export type PersonQuery = { email?: string; handle?: string };

/**
 * One person, or a refusal. Never a list: agents never get a bulk list of members (P2 scope 2.2a item 5).
 * `ambiguous`: more than one person has this handle; the caller must ask by email.
 */
export type FindPersonResult =
  | { ok: true; userId: string; displayName: string }
  | { ok: false; reason: "not_found" | "ambiguous" | "failed"; errorCode: string; detail: string };

export type OpenDirectResult =
  | { ok: true; destination: ChannelDestination }
  | { ok: false; errorCode: string; detail: string };

export type ScheduleNativeInput = {
  text: string;
  /** When the provider posts the message. */
  postAt: Date;
  replyTo?: string;
  mentions?: readonly OutboundMention[];
};

export type ScheduleNativeResult =
  | { status: "scheduled"; scheduledMessageId: string; postAt: string }
  | { status: "failed" | "uncertain"; errorCode: string; detail: string };

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
  // P2 optional operations. A provider that does not declare the feature leaves the method undefined.
  // Each one never throws, never returns the credential, validates before any request and classifies like `send`.
  /** Add (or, with `remove`, remove) the bot's reaction on a message. Needs `reactions.add` / `reactions.remove`. */
  react?(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    emoji: string,
    options?: { remove?: boolean },
  ): Promise<ActionResult>;
  /** Replace the text of the bot's own message. Needs `edit.own`. */
  edit?(
    credential: string | null | undefined,
    destination: ChannelDestination,
    messageId: string,
    message: { text: string; mentions?: readonly OutboundMention[] },
  ): Promise<SendResult>;
  /** Delete the bot's own message. Needs `delete.own`. */
  remove?(credential: string | null | undefined, destination: ChannelDestination, messageId: string): Promise<ActionResult>;
  /** Find one person by email or handle. Needs `dm.open`. */
  findPerson?(credential: string | null | undefined, query: PersonQuery): Promise<FindPersonResult>;
  /** Open (or reuse) the direct message with one person: a `person` destination. Needs `dm.open`. */
  openDirect?(credential: string | null | undefined, userId: string): Promise<OpenDirectResult>;
  /**
   * The provider's own scheduler. Needs `schedule.native`. Marketplace's scheduler stays the default
   * (it re-checks authority and caps at send time); this is an explicit opt-in.
   */
  scheduleNative?(
    credential: string | null | undefined,
    destination: ChannelDestination,
    input: ScheduleNativeInput,
  ): Promise<ScheduleNativeResult>;
};

/**
 * One received message, normalised for the inbound worker (P2 scope 2.2). Every field is untrusted data.
 * Attachments are metadata only; bytes are never fetched by the parser.
 */
export type InboundMessage = {
  platform: ChannelProviderId;
  channelId: string;
  /** Thread root id when the message is a reply in a thread. */
  threadId?: string;
  messageId: string;
  senderUserId: string;
  senderDisplay: string;
  text: string;
  attachments: Array<{ id: string; name: string; contentType: string; bytes: number }>;
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

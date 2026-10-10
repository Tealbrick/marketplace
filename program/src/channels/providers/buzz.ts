import { createHash, randomUUID } from "node:crypto";

import { applyFallbacks, type SendError } from "./capabilities.js";
import {
  asRecord,
  classifyFailure,
  guard,
  httpRequest,
  isSuccess,
  normalizeContentType,
  refuse,
  resolveRuntime,
  safeDetail,
  sanitizeFilename,
  sanitizeText,
  toBlob,
  validateOutbound,
  type Failure,
  type HttpResult,
} from "./common.js";
import {
  HEX64,
  authTagAllows,
  blossomUploadAuthorization,
  nip98Authorization,
  npubEncode,
  parsePubkey,
  publicKeyOf,
  shortNpub,
  signEvent,
  verifyAuthTag,
  verifyEvent,
  type NostrEvent,
  type VerifiedAuthTag,
} from "./nostr.js";
import { guardedRelayFetch } from "../buzz-relay-guard.js";
import { createRateLimiter, requestWithRetry, type RateRule } from "./rate.js";
import {
  CHANNEL_CAPABILITIES_VERSION,
  type ActionResult,
  type ChannelCapabilities,
  type ChannelDestination,
  type ChannelProvider,
  type ChannelProviderOptions,
  type DiscoverResult,
  type FindPersonResult,
  type InboundMessage,
  type OpenDirectResult,
  type OutboundAttachment,
  type OutboundMention,
  type OutboundMessage,
  type PersonQuery,
  type SendResult,
  type VerifyFailureReason,
  type VerifyResult,
} from "./types.js";

// Buzz (block/buzz) adapter over the relay's Nostr HTTP bridge (crates/buzz-relay/src/router.rs):
// `POST /events` (submit a signed event), `POST /query` (NIP-01 filters), `PUT /media/upload` (Blossom BUD-02),
// every call authenticated with NIP-98 (kind 27235) and carrying the owner's NIP-OA tag in `x-auth-tag`
// (relay membership through the owner, NIP-AA). Every published event is signed by the connection's agent key
// and carries the NIP-OA `auth` tag. The relay URL is always the owner's configured value inside the credential;
// this adapter has no default relay. No redirects are followed (common.httpRequest).

const MiB = 1024 * 1024;

/** Buzz content limit is 64 KiB of UTF-8 (buzz-sdk build_message). Characters are capped so any text fits. */
export const BUZZ_MAX_TEXT_CHARS = 20_000;
export const BUZZ_MAX_CONTENT_BYTES = 64 * 1024;
/** Named mentions in one message (buzz-sdk MENTION_CAP is 50; Marketplace allows fewer). */
export const BUZZ_MAX_MENTIONS = 20;
/** GIFs have their own relay cap (BUZZ_MAX_GIF_BYTES default 10 MiB); other images 50 MiB. */
export const BUZZ_MAX_GIF_BYTES = 10 * MiB;
export const BUZZ_DISCOVER_MAX = 500;
/** Private channels Marketplace creates for the inbound bridge (left out of discovery). */
export const BUZZ_BRIDGE_CHANNEL_PREFIX = "tb-inbound-";
/** Below the relay's default agent limit (120 messages a minute, buzz-auth rate_limit.rs). */
export const BUZZ_IDENTITY_RULE: RateRule = { name: "buzz-per-minute", capacity: 10, refillPerSecond: 100 / 60 };
const BUZZ_TYPING_RULE: RateRule = { name: "buzz-typing", capacity: 1, refillPerSecond: 1 / 5 };
const INBOUND_MAX_TEXT_CHARS = 20_000;
const INBOUND_MAX_FILES = 10;

/**
 * Kinds Marketplace publishes with the owner's tag. NIP-OA `kind=` clauses are conjunctive, so a tag with any
 * `kind=` clause cannot cover them: the owner's tag must carry no `kind=` clause (checked at paste).
 */
export const BUZZ_PUBLISHED_KINDS = Object.freeze([9, 9007, 9000, 9001, 9008, 5, 7, 40003, 41010, 20002] as const);

export const BUZZ_KIND = Object.freeze({
  message: 9,
  reaction: 7,
  deletion: 5,
  edit: 40003,
  typing: 20002,
  dmOpen: 41010,
  createGroup: 9007,
  putUser: 9000,
  removeUser: 9001,
  deleteGroup: 9008,
  groupMetadata: 39000,
  groupMembers: 39002,
  profile: 0,
  memberAdded: 44100,
  memberRemoved: 44101,
});

/**
 * Declared only for what this adapter does today, against the relay source read (desktop 0.5.25):
 * images (JPEG, PNG, GIF, WebP) and MP4 through Blossom; PDF, text and other files are not declared until the
 * deployed relay is verified; audio uploads are refused by the relay (buzz-media validation.rs), so neither
 * `audio` nor a voice fallback is declared. Canvas (read and propose edits) is left for a later PR.
 */
const CAPABILITIES: ChannelCapabilities = {
  channelCapabilities: CHANNEL_CAPABILITIES_VERSION,
  text: { maxChars: BUZZ_MAX_TEXT_CHARS },
  markup: "buzz-markdown",
  mentions: { users: true, broadcast: "suppressed" },
  dm: { open: true, maxMembers: 1 },
  image: { types: ["image/jpeg", "image/png", "image/gif", "image/webp"], maxBytes: 50 * MiB, albumMax: 4 },
  file: false,
  audio: false,
  voice: false,
  video: { types: ["video/mp4"], maxBytes: 50 * MiB },
  thread: { replies: true, topics: false, forum: false },
  reactions: { add: true, remove: true, custom: false },
  buttons: { url: false, callback: false },
  poll: false,
  edit: { own: true },
  delete: { own: true },
  canvas: false,
  presence: { typing: true, status: false },
  ephemeral: false,
  live: false,
  schedule: { native: false },
  events: { create: false },
  discover: "list",
  inbound: { mode: "socket", dedupe: true },
  audience: { count: false },
  limits: { perChatPerMinute: 100, retryAfter: "honoured" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// Control characters other than newline and tab, bidirectional overrides and zero-width marks.
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩؜﻿]/gu;
const UNSAFE_CHAR = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩؜﻿]/u;
const NOSTR_URI = /nostr:((?:npub1|nprofile1)[02-9ac-hj-np-z]{6,400})/giu;
const BROADCAST = /(^|[\s(>[{"'])@(everyone|here|channel|all|room)(?![\p{L}\p{N}_-])/giu;

// ---------------------------------------------------------------- Credential

export const BUZZ_CREDENTIAL_PREFIX = "buzz1.";

export type BuzzCredentialParts = {
  /** The connection's agent secret key (64 hex). Only ever inside the encrypted connector secret and this value. */
  secretKey: string;
  /** The owner-entered relay URL (wss://). */
  relayUrl: string;
  /** The owner's NIP-OA tag `["auth", owner, conditions, sig]`, or null before the owner pasted one. */
  authTag: readonly string[] | null;
};

/** One opaque credential value for the runtime (redacted as a whole and by its secret key). */
export function encodeBuzzCredential(parts: BuzzCredentialParts): string {
  return `${BUZZ_CREDENTIAL_PREFIX}${Buffer.from(JSON.stringify({ k: parts.secretKey, r: parts.relayUrl, t: parts.authTag }), "utf8").toString("base64url")}`;
}

export type RelayEndpoint = { relayUrl: string; httpBase: string; host: string };

/**
 * The owner's relay URL: `wss://host[:port]` with an optional trailing slash and nothing else (no user info,
 * path, query or fragment). The HTTP bridge base is `https://host[:port]` (buzz-relay nip98_expected_url).
 */
export function normalizeRelayUrl(input: unknown): RelayEndpoint | null {
  if (typeof input !== "string" || input.length > 300) return null;
  const trimmed = input.trim();
  if (!/^wss:\/\//iu.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  // A DNS name, or an IP literal (IPv6 in brackets). Address rules are checked after resolution (buzz-relay-guard).
  const dnsName = /^[a-z0-9.-]{1,253}$/u.test(url.hostname) && !url.hostname.startsWith(".") && !url.hostname.endsWith(".");
  const ipv6 = /^\[[0-9a-f:.]{2,45}\]$/u.test(url.hostname);
  if (!dnsName && !ipv6) return null;
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return { relayUrl: `wss://${host}`, httpBase: `https://${host}`, host };
}

type ParsedCredential = {
  secretKey: string;
  pubkey: string;
  endpoint: RelayEndpoint;
  auth: VerifiedAuthTag;
};

export type BuzzCredentialCheck =
  | { ok: true; credential: ParsedCredential }
  | { ok: false; reason: "credential_missing" | "credential_invalid"; detail: string };

/**
 * Decodes and checks a credential: key shape, relay URL, and the NIP-OA tag (signature, end date ≤ 90 days, not
 * expired, and, when given, signed by the pinned owner Buzz key).
 */
export function checkBuzzCredential(value: string | null | undefined, nowSeconds: number, pinnedOwner?: string | null): BuzzCredentialCheck {
  const raw = value?.trim();
  if (!raw) return { ok: false, reason: "credential_missing", detail: "no Buzz identity is configured" };
  if (!raw.startsWith(BUZZ_CREDENTIAL_PREFIX)) return { ok: false, reason: "credential_invalid", detail: "the Buzz credential is not understood" };
  let decoded: Record<string, unknown> | undefined;
  try {
    decoded = asRecord(JSON.parse(Buffer.from(raw.slice(BUZZ_CREDENTIAL_PREFIX.length), "base64url").toString("utf8")));
  } catch {
    decoded = undefined;
  }
  if (!decoded) return { ok: false, reason: "credential_invalid", detail: "the Buzz credential is not understood" };
  const secretKey = typeof decoded.k === "string" ? decoded.k : "";
  const pubkey = publicKeyOf(secretKey);
  if (!pubkey) return { ok: false, reason: "credential_invalid", detail: "the Buzz agent key is not usable" };
  const endpoint = normalizeRelayUrl(decoded.r);
  if (!endpoint) return { ok: false, reason: "credential_missing", detail: "no Buzz relay URL is configured" };
  if (decoded.t === null || decoded.t === undefined) return { ok: false, reason: "credential_missing", detail: "the owner has not added a NIP-OA tag for the agent key" };
  const checked = verifyAuthTag({ tag: decoded.t, agentPubkey: pubkey, nowSeconds, ...(pinnedOwner !== undefined ? { pinnedOwner } : {}) });
  if (checked.ok && pinnedOwner === null) return { ok: false, reason: "credential_invalid", detail: "no owner Buzz key is pinned" };
  if (!checked.ok) return { ok: false, reason: "credential_invalid", detail: `the owner's NIP-OA tag is not valid (${checked.reason})` };
  return { ok: true, credential: { secretKey, pubkey, endpoint, auth: checked.value } };
}

// ---------------------------------------------------------------- Formatting (pure)

/**
 * Pure: the content exactly as published. Control characters are removed; a `nostr:npub…` reference stays only
 * for a listed mention (others lose the `nostr:` scheme and are plain text); `nostr:nprofile…` always loses it;
 * broadcast words (`@everyone`, `@here`, `@channel`, `@all`, `@room`) get a full-width at sign so no client reads
 * them as a mention. Listed mentions not referenced in the text are put first as `nostr:npub…`. Mentions notify
 * only through `p` tags, which the adapter adds for the listed people only.
 */
export function renderBuzzText(
  text: string,
  mentions: readonly OutboundMention[] = [],
  self?: string,
): { ok: true; text: string; pubkeys: string[] } | { ok: false; error: SendError } {
  if (!Array.isArray(mentions) || mentions.length > BUZZ_MAX_MENTIONS) {
    return { ok: false, error: { errorCode: "channel_mention_invalid", detail: `at most ${BUZZ_MAX_MENTIONS} named mentions are allowed` } };
  }
  const pubkeys: string[] = [];
  for (const mention of mentions) {
    const pubkey = parsePubkey(asRecord(mention)?.userId);
    if (!pubkey) return { ok: false, error: { errorCode: "channel_mention_invalid", detail: "a mention needs a Buzz member key (npub1… or 64 hex)" } };
    if (pubkey === self) return { ok: false, error: { errorCode: "channel_mention_invalid", detail: "the agent cannot mention itself" } };
    if (!pubkeys.includes(pubkey)) pubkeys.push(pubkey);
  }
  const used = new Set<string>();
  let out = (typeof text === "string" ? text : "").replace(UNSAFE_TEXT, "");
  out = out.replace(NOSTR_URI, (whole, reference: string) => {
    if (reference.toLowerCase().startsWith("npub1")) {
      const pubkey = parsePubkey(reference.toLowerCase());
      if (pubkey && pubkeys.includes(pubkey)) {
        used.add(pubkey);
        return `nostr:${npubEncode(pubkey)}`;
      }
    }
    return reference;
  });
  out = out.replace(BROADCAST, (_whole, lead: string, word: string) => `${lead}＠${word}`);
  const lead = pubkeys.filter((pubkey) => !used.has(pubkey)).map((pubkey) => `nostr:${npubEncode(pubkey)}`).join(" ");
  const rendered = lead ? (out.trim().length > 0 ? `${lead} ${out}` : lead) : out;
  if (rendered.length > BUZZ_MAX_TEXT_CHARS + 2000 || Buffer.byteLength(rendered, "utf8") > BUZZ_MAX_CONTENT_BYTES) {
    return { ok: false, error: { errorCode: "channel_text_too_long", detail: `the text as sent to Buzz is longer than ${BUZZ_MAX_CONTENT_BYTES} bytes` } };
  }
  return { ok: true, text: rendered, pubkeys };
}

/** NIP-10 tags for a reply to `parent` (direct reply to a root, or nested under the parent's root). */
export function replyTags(parent: Pick<NostrEvent, "id" | "tags">): string[][] {
  const etags = parent.tags.filter((tag) => tag[0] === "e" && typeof tag[1] === "string" && HEX64.test(tag[1]));
  const root = etags.find((tag) => tag[3] === "root")?.[1] ?? etags.find((tag) => tag[3] === "reply")?.[1];
  return root && root !== parent.id ? [["e", root, "", "root"], ["e", parent.id, "", "reply"]] : [["e", parent.id, "", "reply"]];
}

function tagValue(event: Pick<NostrEvent, "tags">, name: string): string | undefined {
  const tag = event.tags.find((entry) => entry[0] === name);
  return typeof tag?.[1] === "string" ? tag[1] : undefined;
}

function hasFlag(event: Pick<NostrEvent, "tags">, name: string): boolean {
  return event.tags.some((entry) => entry[0] === name && (entry.length === 1 || entry[1] === "" || entry[1] === "true"));
}

// ---------------------------------------------------------------- Provider

export type BuzzBridgeResult = { status: "sent" | "failed" | "uncertain"; eventId?: string; groupId?: string; errorCode?: string; detail?: string };

/** The extra calls the inbound bridge uses (Marketplace-authored events only, to the configured relay). */
export type BuzzBridgeApi = {
  /** Creates the private channel with the given (deterministic) id; an existing id answers `exists`. */
  createPrivateChannel(credential: string | null | undefined, input: { groupId: string; name: string; about: string }): Promise<BuzzBridgeResult>;
  /** Whether a channel with this id exists on the relay and the identity is in its member list. */
  channelState(credential: string | null | undefined, groupId: string): Promise<{ ok: true; exists: boolean; members: string[] } | { ok: false; errorCode: string }>;
  addMember(credential: string | null | undefined, groupId: string, pubkey: string): Promise<BuzzBridgeResult>;
  /** Removes a member (kind 9001), e.g. the previous agent after a re-bind. */
  removeMember(credential: string | null | undefined, groupId: string, pubkey: string): Promise<BuzzBridgeResult>;
  /** Deletes the identity's own channel (kind 9008), before a key rotation. */
  deleteChannel(credential: string | null | undefined, groupId: string): Promise<BuzzBridgeResult>;
  /** A kind-9 message with exactly the given `p` tags (the routed agent); content as given (the bridge frames it). */
  post(credential: string | null | undefined, groupId: string, input: { content: string; notify: readonly string[] }): Promise<BuzzBridgeResult>;
  /** Deletes one of the identity's own events (kind 5). */
  deleteOwn(credential: string | null | undefined, groupId: string, eventId: string): Promise<BuzzBridgeResult>;
};

export type BuzzProvider = ChannelProvider & {
  typing(credential: string | null | undefined, destination: ChannelDestination, options?: { replyTo?: string }): Promise<ActionResult>;
  readonly bridge: BuzzBridgeApi;
};

type Outcome = { ok: true; json: unknown } | { ok: false; failure: Failure };

function readReason(failure: Failure): VerifyFailureReason {
  return failure.errorCode === "credential_invalid" || failure.errorCode === "provider_forbidden" ? "credential_invalid" : "provider_unavailable";
}

function relayMessage(json: unknown): string | undefined {
  const record = asRecord(json);
  const value = record?.error ?? record?.message;
  return typeof value === "string" ? `relay: ${value}` : undefined;
}

export function createBuzzProvider(options: ChannelProviderOptions & { allowPrivateRelay?: boolean } = {}): BuzzProvider {
  // Without an injected fetch (tests), every relay request goes through the egress guard (re-resolved and
  // checked at each connect, pinned to the checked address).
  const runtime = resolveRuntime({ ...options, fetchImpl: options.fetchImpl ?? guardedRelayFetch({ allowPrivate: options.allowPrivateRelay ?? false }) });
  const limiter = createRateLimiter({ now: runtime.now, sleep: runtime.sleep });
  // Typing signals are never queued: one that would wait is simply skipped.
  const typingLimiter = createRateLimiter({ now: runtime.now, sleep: runtime.sleep, maxWaitMs: 0 });
  const nowSeconds = () => Math.floor(runtime.now() / 1000);

  const check = (credential: string | null | undefined): { ok: true; cred: ParsedCredential } | { ok: false; failure: Failure } => {
    const checked = checkBuzzCredential(credential, nowSeconds());
    return checked.ok ? { ok: true, cred: checked.credential } : { ok: false, failure: { status: "failed", errorCode: checked.reason, detail: checked.detail } };
  };
  const secretsOf = (credential: string | null | undefined, cred?: ParsedCredential) => [credential ?? "", cred?.secretKey ?? ""].filter(Boolean);

  async function bridgePost(cred: ParsedCredential, path: "/events" | "/query", payload: unknown, secrets: string[]): Promise<Outcome> {
    const body = JSON.stringify(payload);
    const url = `${cred.endpoint.httpBase}${path}`;
    const result: HttpResult = await requestWithRetry(
      () =>
        httpRequest(runtime, url, {
          method: "POST",
          body,
          headers: {
            authorization: nip98Authorization(cred.secretKey, { url, method: "POST", body, nowSeconds: nowSeconds() }),
            "content-type": "application/json",
            "x-auth-tag": cred.auth.json,
          },
        }),
      runtime.sleep,
    );
    if (!isSuccess(result)) return { ok: false, failure: classifyFailure(result, { secrets, message: relayMessage, notFound: "provider_not_found" }) };
    return { ok: true, json: result.json };
  }

  async function query(cred: ParsedCredential, filters: Record<string, unknown>[], secrets: string[]): Promise<{ ok: true; events: NostrEvent[] } | { ok: false; failure: Failure }> {
    const outcome = await bridgePost(cred, "/query", filters, secrets);
    if (!outcome.ok) return outcome;
    if (!Array.isArray(outcome.json)) return { ok: false, failure: { status: "failed", errorCode: "provider_bad_response", detail: "the relay query answer was not understood" } };
    const events = outcome.json.filter((raw): raw is NostrEvent => {
      const event = asRecord(raw);
      return (
        !!event &&
        typeof event.id === "string" &&
        HEX64.test(event.id) &&
        typeof event.pubkey === "string" &&
        HEX64.test(event.pubkey) &&
        typeof event.kind === "number" &&
        typeof event.content === "string" &&
        Array.isArray(event.tags) &&
        event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
      );
    });
    return { ok: true, events };
  }

  /** Signs (with the NIP-OA tag) and submits one event. `accepted: false` from the relay is `failed` with its reason. */
  async function publish(
    cred: ParsedCredential,
    input: { kind: number; tags: string[][]; content: string },
    secrets: string[],
  ): Promise<{ ok: true; event: NostrEvent; json: Record<string, unknown> } | { ok: false; failure: Failure; event?: NostrEvent }> {
    const createdAt = nowSeconds();
    if (!authTagAllows(cred.auth.parsed, input.kind, createdAt)) {
      return {
        ok: false,
        failure: {
          status: "failed",
          errorCode: cred.auth.parsed.before !== undefined && createdAt >= cred.auth.parsed.before ? "credential_invalid" : "buzz_auth_kind_not_allowed",
          detail: `the owner's NIP-OA tag does not authorise a kind ${input.kind} event now`,
        },
      };
    }
    const event = signEvent(cred.secretKey, { kind: input.kind, created_at: createdAt, tags: [...input.tags, [...cred.auth.tag]], content: input.content });
    const outcome = await bridgePost(cred, "/events", event, secrets);
    // The signed event id is known even when delivery is uncertain (callers record it for a later delete).
    if (!outcome.ok) return { ...outcome, event };
    const body = asRecord(outcome.json);
    if (!body || typeof body.accepted !== "boolean") {
      return { ok: false, event, failure: { status: "uncertain", errorCode: "provider_bad_response", detail: "the relay answered success but the reply was not understood; delivery is unknown" } };
    }
    if (!body.accepted) {
      return { ok: false, failure: { status: "failed", errorCode: "provider_rejected", detail: safeDetail(relayMessage(body) ?? "relay: not accepted", secrets) ?? "relay: not accepted" } };
    }
    return { ok: true, event, json: body };
  }

  const fromFailure = (failure: Failure): SendResult => ({ status: failure.status, resultIds: [], resultUrls: [], errorCode: failure.errorCode, detail: failure.detail });
  const actionOf = (failure: Pick<Failure, "status" | "errorCode" | "detail"> | SendResult): ActionResult => ({
    status: failure.status,
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
    ...(failure.detail ? { detail: failure.detail } : {}),
  });
  const destinationProblem = (destination: ChannelDestination): SendResult | undefined =>
    typeof destination?.externalId === "string" && UUID.test(destination.externalId) ? undefined : refuse("channel_destination_invalid", "the Buzz channel id must be a UUID");
  const rateRefusal = (waitMs: number) => refuse("provider_rate_limited", `local rate limit; next free slot in ${Math.ceil(waitMs / 1000)}s`);

  /** One event of the channel by id (own-message and parent checks). */
  async function fetchEvent(cred: ParsedCredential, id: string, secrets: string[]) {
    const found = await query(cred, [{ ids: [id], limit: 1 }], secrets);
    if (!found.ok) return found;
    return { ok: true as const, event: found.events.find((event) => event.id === id) ?? null };
  }

  async function ownMessage(cred: ParsedCredential, destination: ChannelDestination, messageId: string, secrets: string[]): Promise<Failure | null> {
    const found = await fetchEvent(cred, messageId, secrets);
    if (!found.ok) return { ...found.failure, detail: found.failure.detail.replace(/; delivery is unknown$/u, "") };
    if (!found.event || tagValue(found.event, "h") !== destination.externalId) return { status: "failed", errorCode: "provider_not_found", detail: "no such message in this Buzz channel" };
    if (found.event.pubkey !== cred.pubkey) return { status: "failed", errorCode: "provider_forbidden", detail: "only the agent's own messages can be changed" };
    return null;
  }

  async function verify(credential: string | null | undefined): Promise<VerifyResult> {
    const checked = check(credential);
    if (!checked.ok) return { ok: false, reason: checked.failure.errorCode as VerifyFailureReason };
    const { cred } = checked;
    const secrets = secretsOf(credential, cred);
    // NIP-11 relay information document at the relay root.
    const info = await httpRequest(runtime, `${cred.endpoint.httpBase}/`, { method: "GET", headers: { accept: "application/nostr+json" } });
    if (!isSuccess(info) || !asRecord(info.json)) return { ok: false, reason: "provider_unavailable" };
    // Authenticated no-op: the agent's own profile through POST /query (NIP-98 + x-auth-tag).
    const probe = await query(cred, [{ kinds: [BUZZ_KIND.profile], authors: [cred.pubkey], limit: 1 }], secrets);
    if (!probe.ok) return { ok: false, reason: readReason(probe.failure) };
    return { ok: true, botId: cred.pubkey, botUsername: shortNpub(cred.pubkey) };
  }

  async function discover(credential: string | null | undefined): Promise<DiscoverResult> {
    const checked = check(credential);
    if (!checked.ok) return { ok: false, reason: checked.failure.errorCode as VerifyFailureReason };
    const { cred } = checked;
    const secrets = secretsOf(credential, cred);
    // Channels the agent key is a member of (kind 39002 with #p = self), then their metadata (kind 39000).
    const members = await query(cred, [{ kinds: [BUZZ_KIND.groupMembers], "#p": [cred.pubkey], limit: BUZZ_DISCOVER_MAX }], secrets);
    if (!members.ok) return { ok: false, reason: readReason(members.failure) };
    const ids = [...new Set(members.events.map((event) => tagValue(event, "d")).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
    const notes: string[] = [];
    if (members.events.length >= BUZZ_DISCOVER_MAX) notes.push(`Only the first ${BUZZ_DISCOVER_MAX} Buzz channels of the agent key are listed.`);
    if (ids.length === 0) return { ok: true, destinations: [], notes: ["The Marketplace agent key is not a member of any Buzz channel yet. Add its npub to a channel, then press Discover."] };
    const metadata = await query(cred, [{ kinds: [BUZZ_KIND.groupMetadata], "#d": ids, limit: BUZZ_DISCOVER_MAX }], secrets);
    if (!metadata.ok) return { ok: false, reason: readReason(metadata.failure) };
    const destinations: ChannelDestination[] = [];
    let bridged = 0;
    const seen = new Set<string>();
    for (const event of metadata.events) {
      const id = tagValue(event, "d");
      if (!id || !ids.includes(id) || seen.has(id) || hasFlag(event, "archived") || tagValue(event, "archived") === "true") continue;
      seen.add(id);
      const name = sanitizeText(tagValue(event, "name"), 80);
      if (name.startsWith(BUZZ_BRIDGE_CHANNEL_PREFIX)) {
        bridged += 1;
        continue;
      }
      const dm = hasFlag(event, "hidden");
      destinations.push({
        type: dm ? "person" : hasFlag(event, "private") ? "group" : "channel",
        externalId: id,
        title: sanitizeText(dm ? `Direct message${name ? `: ${name}` : ""}` : `#${name || id}`),
      });
    }
    if (bridged > 0) notes.push(`${bridged} private inbound bridge channel(s) created by Marketplace are not listed.`);
    return { ok: true, destinations, ...(notes.length ? { notes } : {}) };
  }

  async function upload(cred: ParsedCredential, attachment: OutboundAttachment, secrets: string[]) {
    const url = `${cred.endpoint.httpBase}/media/upload`;
    const contentType = normalizeContentType(attachment.contentType);
    const sha256 = attachment.sha256.toLowerCase();
    const result = await requestWithRetry(
      () =>
        httpRequest(runtime, url, {
          method: "PUT",
          body: toBlob(attachment.bytes, contentType),
          headers: {
            authorization: blossomUploadAuthorization(cred.secretKey, {
              sha256,
              server: cred.endpoint.host,
              nowSeconds: nowSeconds(),
              ttlSeconds: contentType.startsWith("video/") ? 3600 : 600,
            }),
            "content-type": contentType,
            "x-sha-256": sha256,
            "x-auth-tag": cred.auth.json,
          },
        }),
      runtime.sleep,
    );
    if (!isSuccess(result)) return { ok: false as const, failure: classifyFailure(result, { secrets, message: relayMessage, notFound: "provider_not_found" }) };
    const descriptor = asRecord(result.json);
    const blobUrl = descriptor?.url;
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = typeof blobUrl === "string" && blobUrl.length <= 2048 ? new URL(blobUrl) : null;
    } catch {
      parsedUrl = null;
    }
    if (!descriptor || descriptor.sha256 !== sha256 || !parsedUrl || parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) {
      return { ok: false as const, failure: { status: "failed" as const, errorCode: "provider_bad_response", detail: "the upload answer was not understood" } };
    }
    const tag = ["imeta", `url ${parsedUrl.toString()}`, `m ${contentType}`, `x ${sha256}`, `size ${attachment.bytes.byteLength}`];
    if (typeof descriptor.dim === "string" && /^[0-9]{1,5}x[0-9]{1,5}$/u.test(descriptor.dim)) tag.push(`dim ${descriptor.dim}`);
    return { ok: true as const, tag, url: parsedUrl.toString(), video: contentType.startsWith("video/") };
  }

  async function send(credential: string | null | undefined, destination: ChannelDestination, message: OutboundMessage): Promise<SendResult> {
    const checked = check(credential);
    if (!checked.ok) return fromFailure(checked.failure);
    const { cred } = checked;
    const secrets = secretsOf(credential, cred);
    const invalid = destinationProblem(destination);
    if (invalid) return invalid;
    if (message.replyTo !== undefined && (typeof message.replyTo !== "string" || !HEX64.test(message.replyTo))) {
      return refuse("channel_reply_invalid", "replyTo must be a Buzz event id (64 hex)");
    }
    if (message.poll !== undefined) return refuse("channel_capability_unavailable", 'this provider does not declare "poll"');
    if (message.markup !== undefined && message.markup !== CAPABILITIES.markup) return refuse("channel_capability_unavailable", "this provider does not offer that markup");
    const post = applyFallbacks(CAPABILITIES, { text: message.text, attachments: message.attachments ?? [] });
    if ("error" in post) return refuse(post.error.errorCode, post.error.detail);
    const refusal = validateOutbound({ text: post.text, attachments: post.attachments, caps: CAPABILITIES });
    if (refusal) return refusal;
    if (post.attachments.some((attachment) => normalizeContentType(attachment.contentType) === "image/gif" && attachment.bytes.byteLength > BUZZ_MAX_GIF_BYTES)) {
      return refuse("channel_file_too_large", `a GIF is larger than ${BUZZ_MAX_GIF_BYTES} bytes`);
    }
    const rendered = renderBuzzText(post.text, message.mentions ?? [], cred.pubkey);
    if (!rendered.ok) return refuse(rendered.error.errorCode, rendered.error.detail);
    if (!authTagAllows(cred.auth.parsed, BUZZ_KIND.message, nowSeconds())) {
      return refuse("buzz_auth_kind_not_allowed", "the owner's NIP-OA tag does not authorise chat messages (kind 9)");
    }
    const slot = await limiter.acquire(`buzz:${cred.pubkey}`, [BUZZ_IDENTITY_RULE]);
    if (!slot.ok) return rateRefusal(slot.waitMs);

    const tags: string[][] = [["h", destination.externalId]];
    if (message.replyTo) {
      // Unknown parents are refused here (the relay also rejects them): the parent must be in this channel.
      const parent = await fetchEvent(cred, message.replyTo, secrets);
      if (!parent.ok) return fromFailure({ ...parent.failure, status: "failed", detail: `the reply target could not be checked; nothing was posted (${parent.failure.detail.replace(/; delivery is unknown$/u, "")})` });
      if (!parent.event || tagValue(parent.event, "h") !== destination.externalId) return refuse("channel_reply_invalid", "the reply target is not a message in this Buzz channel");
      tags.push(...replyTags(parent.event));
    }
    for (const pubkey of rendered.pubkeys) tags.push(["p", pubkey]);
    // Blossom uploads first; nothing is visible in the channel until the message event is accepted.
    let media = "";
    for (const attachment of post.attachments) {
      const uploaded = await upload(cred, attachment, secrets);
      if (!uploaded.ok) {
        return fromFailure({
          status: "failed",
          errorCode: uploaded.failure.errorCode,
          detail: `upload failed before the message; nothing was posted (${uploaded.failure.detail.replace(/; delivery is unknown$/u, "")})`,
        });
      }
      tags.push(uploaded.tag);
      media += `\n![${uploaded.video ? "video" : "image"}](${uploaded.url})`;
    }
    const content = media ? `${rendered.text}${media}` : rendered.text;
    if (Buffer.byteLength(content, "utf8") > BUZZ_MAX_CONTENT_BYTES) return refuse("channel_text_too_long", `the message is longer than ${BUZZ_MAX_CONTENT_BYTES} bytes`);
    const published = await publish(cred, { kind: BUZZ_KIND.message, tags, content }, secrets);
    if (!published.ok) return fromFailure(published.failure);
    return { status: "sent", resultIds: [published.event.id], resultUrls: [], ...(post.fallbacks.length ? { fallback: post.fallbacks.join(",") } : {}) };
  }

  async function react(credential: string | null | undefined, destination: ChannelDestination, messageId: string, emoji: string, reactOptions: { remove?: boolean } = {}): Promise<ActionResult> {
    const checked = check(credential);
    if (!checked.ok) return actionOf(checked.failure);
    const { cred } = checked;
    const secrets = secretsOf(credential, cred);
    const invalid = destinationProblem(destination);
    if (invalid) return actionOf(invalid);
    if (typeof messageId !== "string" || !HEX64.test(messageId)) return actionOf(invalidMessageId());
    const points = typeof emoji === "string" ? Array.from(emoji) : [];
    if (points.length < 1 || points.length > 16 || /[\s:]/u.test(emoji) || UNSAFE_CHAR.test(emoji)) {
      return { status: "failed", errorCode: "channel_reaction_invalid", detail: "a reaction is one emoji or a short symbol such as + (custom emoji are not supported)" };
    }
    const slot = await limiter.acquire(`buzz:${cred.pubkey}`, [BUZZ_IDENTITY_RULE]);
    if (!slot.ok) return actionOf(rateRefusal(slot.waitMs));
    if (reactOptions.remove !== true) {
      const published = await publish(cred, { kind: BUZZ_KIND.reaction, tags: [["e", messageId], ["h", destination.externalId]], content: emoji }, secrets);
      return published.ok ? { status: "sent" } : actionOf(published.failure);
    }
    // Remove = kind-5 deletion of the identity's own matching reaction(s).
    const own = await query(cred, [{ kinds: [BUZZ_KIND.reaction], "#e": [messageId], authors: [cred.pubkey], limit: 50 }], secrets);
    if (!own.ok) return actionOf({ ...own.failure, detail: own.failure.detail.replace(/; delivery is unknown$/u, "") });
    const targets = own.events.filter((event) => event.pubkey === cred.pubkey && event.content === emoji).map((event) => event.id);
    if (targets.length === 0) return { status: "sent", detail: "the reaction was not there" };
    // Buzz accepts single-target deletions only: one kind 5 per reaction.
    for (const target of targets) {
      const published = await publish(cred, { kind: BUZZ_KIND.deletion, tags: [["e", target], ["h", destination.externalId]], content: "" }, secrets);
      if (!published.ok) return actionOf(published.failure);
    }
    return { status: "sent" };
  }

  async function edit(credential: string | null | undefined, destination: ChannelDestination, messageId: string, input: { text: string; mentions?: readonly OutboundMention[] }): Promise<SendResult> {
    const checked = check(credential);
    if (!checked.ok) return fromFailure(checked.failure);
    const { cred } = checked;
    const secrets = secretsOf(credential, cred);
    const invalid = destinationProblem(destination);
    if (invalid) return invalid;
    if (typeof messageId !== "string" || !HEX64.test(messageId)) return fromFailure(invalidMessageId());
    const text = typeof input?.text === "string" ? input.text : "";
    if (text.trim().length === 0) return refuse("channel_message_empty", "an edit needs text");
    if (text.length > BUZZ_MAX_TEXT_CHARS) return refuse("channel_text_too_long", `text is ${text.length} characters; this provider allows ${BUZZ_MAX_TEXT_CHARS}`);
    if ((input.mentions ?? []).length > 0) return refuse("channel_mention_invalid", "a Buzz edit cannot mention anyone (edits do not notify)");
    const rendered = renderBuzzText(text, [], cred.pubkey);
    if (!rendered.ok) return refuse(rendered.error.errorCode, rendered.error.detail);
    const slot = await limiter.acquire(`buzz:${cred.pubkey}`, [BUZZ_IDENTITY_RULE]);
    if (!slot.ok) return rateRefusal(slot.waitMs);
    const notOwn = await ownMessage(cred, destination, messageId, secrets);
    if (notOwn) return fromFailure(notOwn);
    const published = await publish(cred, { kind: BUZZ_KIND.edit, tags: [["h", destination.externalId], ["e", messageId]], content: rendered.text }, secrets);
    if (!published.ok) return fromFailure(published.failure);
    return { status: "sent", resultIds: [messageId], resultUrls: [] };
  }

  async function remove(credential: string | null | undefined, destination: ChannelDestination, messageId: string): Promise<ActionResult> {
    const checked = check(credential);
    if (!checked.ok) return actionOf(checked.failure);
    const { cred } = checked;
    const secrets = secretsOf(credential, cred);
    const invalid = destinationProblem(destination);
    if (invalid) return actionOf(invalid);
    if (typeof messageId !== "string" || !HEX64.test(messageId)) return actionOf(invalidMessageId());
    const slot = await limiter.acquire(`buzz:${cred.pubkey}`, [BUZZ_IDENTITY_RULE]);
    if (!slot.ok) return actionOf(rateRefusal(slot.waitMs));
    const notOwn = await ownMessage(cred, destination, messageId, secrets);
    if (notOwn) return actionOf(notOwn);
    const published = await publish(cred, { kind: BUZZ_KIND.deletion, tags: [["h", destination.externalId], ["e", messageId]], content: "" }, secrets);
    return published.ok ? { status: "sent" } : actionOf(published.failure);
  }

  async function typing(credential: string | null | undefined, destination: ChannelDestination, typingOptions: { replyTo?: string } = {}): Promise<ActionResult> {
    const checked = check(credential);
    if (!checked.ok) return actionOf(checked.failure);
    const { cred } = checked;
    const invalid = destinationProblem(destination);
    if (invalid) return actionOf(invalid);
    if (typingOptions.replyTo !== undefined && (typeof typingOptions.replyTo !== "string" || !HEX64.test(typingOptions.replyTo))) return actionOf(invalidMessageId());
    const slot = await typingLimiter.acquire(`buzz-typing:${cred.pubkey}:${destination.externalId}`, [BUZZ_TYPING_RULE]);
    if (!slot.ok) return { status: "sent", detail: "a typing signal was sent recently" };
    const tags: string[][] = [["h", destination.externalId]];
    if (typingOptions.replyTo) tags.push(["e", typingOptions.replyTo, "", "reply"]);
    const published = await publish(cred, { kind: BUZZ_KIND.typing, tags, content: "" }, secretsOf(credential, cred));
    return published.ok ? { status: "sent" } : actionOf(published.failure);
  }

  async function profileName(cred: ParsedCredential, pubkeys: string[], secrets: string[]) {
    const names = new Map<string, { display: string; keys: string[] }>();
    for (let start = 0; start < pubkeys.length; start += 100) {
      const chunk = pubkeys.slice(start, start + 100);
      const profiles = await query(cred, [{ kinds: [BUZZ_KIND.profile], authors: chunk, limit: chunk.length }], secrets);
      if (!profiles.ok) return profiles;
      for (const event of profiles.events) {
        if (!chunk.includes(event.pubkey) || names.has(event.pubkey)) continue;
        let content: Record<string, unknown> | undefined;
        try {
          content = asRecord(JSON.parse(event.content));
        } catch {
          content = undefined;
        }
        const displayName = sanitizeText(content?.display_name, 80);
        const name = sanitizeText(content?.name, 80);
        names.set(event.pubkey, {
          display: displayName || name || shortNpub(event.pubkey),
          keys: [displayName, name].filter((value) => value.length > 0).map((value) => value.toLowerCase()),
        });
      }
    }
    return { ok: true as const, names };
  }

  async function findPerson(credential: string | null | undefined, query_: PersonQuery): Promise<FindPersonResult> {
    const checked = check(credential);
    if (!checked.ok) return personFailure(checked.failure);
    const { cred } = checked;
    const secrets = secretsOf(credential, cred);
    if (query_?.email !== undefined) return { ok: false, reason: "failed", errorCode: "person_query_invalid", detail: "Buzz finds people by npub or exact member name, not by email" };
    const handle = typeof query_?.handle === "string" ? query_.handle.trim().replace(/^@/u, "") : "";
    if (!handle || handle.length > 80 || UNSAFE_CHAR.test(handle)) {
      return { ok: false, reason: "failed", errorCode: "person_query_invalid", detail: "ask by npub or exact member name" };
    }
    // Members of the agent's channels: the only people the agent may find (never returned as a list).
    const memberships = await query(cred, [{ kinds: [BUZZ_KIND.groupMembers], "#p": [cred.pubkey], limit: BUZZ_DISCOVER_MAX }], secrets);
    if (!memberships.ok) return personFailure(memberships.failure);
    const members = [
      ...new Set(memberships.events.flatMap((event) => event.tags.filter((tag) => tag[0] === "p" && typeof tag[1] === "string" && HEX64.test(tag[1])).map((tag) => tag[1] as string))),
    ].filter((pubkey) => pubkey !== cred.pubkey);
    const byKey = parsePubkey(handle);
    if (byKey) {
      if (!members.includes(byKey)) return notFound();
      const named = await profileName(cred, [byKey], secrets);
      if (!named.ok) return personFailure(named.failure);
      return { ok: true, userId: byKey, displayName: named.names.get(byKey)?.display ?? shortNpub(byKey) };
    }
    const named = await profileName(cred, members.slice(0, BUZZ_DISCOVER_MAX), secrets);
    if (!named.ok) return personFailure(named.failure);
    const wanted = handle.toLowerCase();
    const matches = [...named.names.entries()].filter(([, entry]) => entry.keys.includes(wanted));
    if (matches.length === 0) return notFound();
    if (matches.length > 1) return { ok: false, reason: "ambiguous", errorCode: "person_ambiguous", detail: "more than one member has this name; ask by npub" };
    const [userId, entry] = matches[0]!;
    return { ok: true, userId, displayName: entry.display };
  }

  async function openDirect(credential: string | null | undefined, userId: string): Promise<OpenDirectResult> {
    const checked = check(credential);
    if (!checked.ok) return { ok: false, errorCode: checked.failure.errorCode, detail: checked.failure.detail };
    const { cred } = checked;
    const pubkey = parsePubkey(userId);
    if (!pubkey || pubkey === cred.pubkey) return { ok: false, errorCode: "person_query_invalid", detail: "a Buzz member key (npub1… or 64 hex) other than the agent's is required" };
    const slot = await limiter.acquire(`buzz:${cred.pubkey}`, [BUZZ_IDENTITY_RULE]);
    if (!slot.ok) return { ok: false, errorCode: "provider_rate_limited", detail: `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s` };
    // Buzz DM open (kind 41010) with the one named member; the relay answers the DM channel id (or reuses one).
    const requested = randomUUID();
    const published = await publish(cred, { kind: BUZZ_KIND.dmOpen, tags: [["p", pubkey], ["d", requested]], content: "" }, secretsOf(credential, cred));
    if (!published.ok) return { ok: false, errorCode: published.failure.errorCode, detail: published.failure.detail.replace(/; delivery is unknown$/u, "") };
    let channelId: string | undefined;
    const message = published.json.message;
    if (typeof message === "string" && message.startsWith("response:")) {
      try {
        const id = asRecord(JSON.parse(message.slice("response:".length)))?.channel_id;
        channelId = typeof id === "string" && UUID.test(id) ? id : undefined;
      } catch {
        channelId = undefined;
      }
    }
    channelId ??= requested;
    return { ok: true, destination: { type: "person", externalId: channelId, title: sanitizeText(`Direct message: ${shortNpub(pubkey)}`), personId: pubkey } };
  }

  // ----- bridge calls ---------------------------------------------------------

  const bridgeResult = (failure: Failure): BuzzBridgeResult => ({ status: failure.status, errorCode: failure.errorCode, detail: failure.detail });
  const bridgeCall = async (
    credential: string | null | undefined,
    build: (cred: ParsedCredential) => { kind: number; tags: string[][]; content: string; groupId?: string } | Failure,
  ): Promise<BuzzBridgeResult> => {
    const checked = check(credential);
    if (!checked.ok) return bridgeResult(checked.failure);
    const built = build(checked.cred);
    if ("errorCode" in built) return bridgeResult(built);
    const slot = await limiter.acquire(`buzz:${checked.cred.pubkey}`, [BUZZ_IDENTITY_RULE]);
    if (!slot.ok) return { status: "failed", errorCode: "provider_rate_limited", detail: `local rate limit; next free slot in ${Math.ceil(slot.waitMs / 1000)}s` };
    const published = await publish(checked.cred, built, secretsOf(credential, checked.cred));
    return published.ok
      ? { status: "sent", eventId: published.event.id, ...(built.groupId ? { groupId: built.groupId } : {}) }
      : { ...bridgeResult(published.failure), ...(published.event ? { eventId: published.event.id } : {}) };
  };
  const badGroup: Failure = { status: "failed", errorCode: "channel_destination_invalid", detail: "the Buzz channel id must be a UUID" };

  const bridge: BuzzBridgeApi = {
    createPrivateChannel: (credential, input) =>
      guard(
        () =>
          bridgeCall(credential, () => {
            const groupId = input.groupId;
            if (!UUID.test(groupId)) return badGroup;
            return {
              kind: BUZZ_KIND.createGroup,
              groupId,
              content: "",
              tags: [
                ["h", groupId],
                ["name", sanitizeText(input.name, 64)],
                ["visibility", "private"],
                ["channel_type", "stream"],
                ["about", sanitizeText(input.about, 300)],
              ],
            };
          }),
        { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error" },
      ),
    addMember: (credential, groupId, pubkey) =>
      guard(
        () =>
          bridgeCall(credential, () =>
            !UUID.test(groupId) || !HEX64.test(pubkey) ? badGroup : { kind: BUZZ_KIND.putUser, content: "", tags: [["h", groupId], ["p", pubkey]] },
          ),
        { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error" },
      ),
    post: (credential, groupId, input) =>
      guard(
        () =>
          bridgeCall(credential, () => {
            if (!UUID.test(groupId) || !input.notify.every((pubkey) => HEX64.test(pubkey)) || input.notify.length > 4) return badGroup;
            if (Buffer.byteLength(input.content, "utf8") > BUZZ_MAX_CONTENT_BYTES) return { status: "failed", errorCode: "channel_text_too_long", detail: "the bridged message is too long" };
            return { kind: BUZZ_KIND.message, content: input.content, tags: [["h", groupId], ...input.notify.map((pubkey) => ["p", pubkey])] };
          }),
        { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error" },
      ),
    channelState: (credential, groupId) =>
      guard(
        async () => {
          const checked = check(credential);
          if (!checked.ok) return { ok: false as const, errorCode: checked.failure.errorCode };
          if (!UUID.test(groupId)) return { ok: false as const, errorCode: "channel_destination_invalid" };
          const found = await query(checked.cred, [{ kinds: [BUZZ_KIND.groupMembers], "#d": [groupId], limit: 1 }], secretsOf(credential, checked.cred));
          if (!found.ok) return { ok: false as const, errorCode: found.failure.errorCode };
          const state = found.events.find((event) => tagValue(event, "d") === groupId);
          const members = state ? state.tags.filter((tag) => tag[0] === "p" && typeof tag[1] === "string" && HEX64.test(tag[1])).map((tag) => tag[1] as string) : [];
          return { ok: true as const, exists: state !== undefined, members };
        },
        { ok: false, errorCode: "provider_internal_error" },
      ),
    removeMember: (credential, groupId, pubkey) =>
      guard(
        () =>
          bridgeCall(credential, () =>
            !UUID.test(groupId) || !HEX64.test(pubkey) ? badGroup : { kind: BUZZ_KIND.removeUser, content: "", tags: [["h", groupId], ["p", pubkey]] },
          ),
        { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error" },
      ),
    deleteChannel: (credential, groupId) =>
      guard(
        () => bridgeCall(credential, () => (!UUID.test(groupId) ? badGroup : { kind: BUZZ_KIND.deleteGroup, content: "", tags: [["h", groupId]] })),
        { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error" },
      ),
    deleteOwn: (credential, groupId, eventId) =>
      guard(
        () =>
          bridgeCall(credential, () =>
            !UUID.test(groupId) || !HEX64.test(eventId) ? badGroup : { kind: BUZZ_KIND.deletion, content: "", tags: [["h", groupId], ["e", eventId]] },
          ),
        { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error" },
      ),
  };

  const uncertainSend: SendResult = { status: "uncertain", resultIds: [], resultUrls: [], errorCode: "provider_internal_error", detail: "unexpected adapter error; delivery is unknown" };
  const uncertainAction: ActionResult = { status: "uncertain", errorCode: "provider_internal_error", detail: "unexpected adapter error; the result is unknown" };

  return {
    id: "buzz",
    capabilities: structuredClone(CAPABILITIES),
    verify: (credential) => guard(() => verify(credential), { ok: false, reason: "provider_unavailable" }),
    discover: (credential) => guard(() => discover(credential), { ok: false, reason: "provider_unavailable" }),
    send: (credential, destination, message) => guard(() => send(credential, destination, message), uncertainSend),
    react: (credential, destination, messageId, emoji, reactOptions) => guard(() => react(credential, destination, messageId, emoji, reactOptions), uncertainAction),
    edit: (credential, destination, messageId, input) => guard(() => edit(credential, destination, messageId, input), uncertainSend),
    remove: (credential, destination, messageId) => guard(() => remove(credential, destination, messageId), uncertainAction),
    findPerson: (credential, personQuery) =>
      guard(() => findPerson(credential, personQuery), { ok: false, reason: "failed", errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
    openDirect: (credential, userId) => guard(() => openDirect(credential, userId), { ok: false, errorCode: "provider_internal_error", detail: "unexpected adapter error" }),
    typing: (credential, destination, typingOptions) => guard(() => typing(credential, destination, typingOptions), uncertainAction),
    bridge,
  };
}

function invalidMessageId(): Failure {
  return { status: "failed", errorCode: "channel_message_id_invalid", detail: "a Buzz message id is its event id (64 hex)" };
}

function notFound(): FindPersonResult {
  return { ok: false, reason: "not_found", errorCode: "person_not_found", detail: "no member of the agent's Buzz channels matches" };
}

function personFailure(failure: Failure): FindPersonResult {
  return { ok: false, reason: "failed", errorCode: failure.errorCode, detail: failure.detail.replace(/; delivery is unknown$/u, "") };
}

// ---------------------------------------------------------------- Inbound helpers (pure; used by the relay socket)

/**
 * REQ filters for the inbound socket (Buzz subscription rules, buzz-relay handlers/req.rs): channel kinds only
 * with an explicit `#h` list (at most 128 channels), and the p-gated global kinds (membership notifications)
 * only with `#p` = the agent's own key.
 */
export function buzzSubscriptionFilters(input: { channelIds: readonly string[]; selfPubkey: string; since: number }): Record<string, Record<string, unknown>> {
  const channelIds = [...new Set(input.channelIds.filter((id) => UUID.test(id)))].slice(0, 128);
  return {
    ...(channelIds.length > 0 ? { "tb-channels": { kinds: [BUZZ_KIND.message], "#h": channelIds, since: input.since } } : {}),
    "tb-membership": { kinds: [BUZZ_KIND.memberAdded, BUZZ_KIND.memberRemoved], "#p": [input.selfPubkey], since: input.since },
  };
}

export type BuzzEventParse = { kind: "message"; message: InboundMessage; createdAt: number } | { kind: "ignored"; reason: string };

/**
 * Parses a relay-delivered event into the normalised inbound shape. The event id and BIP-340 signature are
 * checked (contract helpers) before anything is read. Only kind 9 with an `h` channel UUID; the agent's own
 * events are ignored. `threadId` is the NIP-10 thread root; the text is untrusted data (control characters
 * removed, at most 20,000 characters); attachments are imeta metadata only.
 */
export function parseBuzzEvent(raw: unknown, self: { selfPubkey?: string } = {}): BuzzEventParse {
  if (!verifyEvent(raw)) return { kind: "ignored", reason: "invalid_event" };
  const event = raw;
  if (event.kind !== BUZZ_KIND.message) return { kind: "ignored", reason: "unsupported_kind" };
  if (self.selfPubkey && event.pubkey === self.selfPubkey) return { kind: "ignored", reason: "own_message" };
  const channelId = tagValue(event, "h");
  if (!channelId || !UUID.test(channelId)) return { kind: "ignored", reason: "malformed" };
  const etags = event.tags.filter((tag) => tag[0] === "e" && typeof tag[1] === "string" && HEX64.test(tag[1]));
  const threadId = etags.find((tag) => tag[3] === "root")?.[1] ?? etags.find((tag) => tag[3] === "reply")?.[1];
  const text = event.content.replace(UNSAFE_TEXT, "");
  const points = Array.from(text);
  const attachments = event.tags
    .filter((tag) => tag[0] === "imeta")
    .slice(0, INBOUND_MAX_FILES)
    .flatMap((tag) => {
      const fields = new Map(tag.slice(1).map((part) => [part.slice(0, part.indexOf(" ")), part.slice(part.indexOf(" ") + 1)] as const));
      const sha = fields.get("x");
      if (!sha || !HEX64.test(sha)) return [];
      const size = Number(fields.get("size"));
      return [
        {
          id: sha,
          name: sanitizeFilename(fields.get("filename") ?? (normalizeContentType(fields.get("m") ?? "").startsWith("video/") ? "video" : "image")),
          contentType: normalizeContentType(fields.get("m") ?? "") || "application/octet-stream",
          bytes: Number.isSafeInteger(size) && size >= 0 ? size : 0,
        },
      ];
    });
  return {
    kind: "message",
    createdAt: event.created_at,
    message: {
      platform: "buzz",
      channelId,
      ...(threadId && threadId !== event.id ? { threadId } : {}),
      messageId: event.id,
      senderUserId: event.pubkey,
      senderDisplay: shortNpub(event.pubkey),
      text: points.length > INBOUND_MAX_TEXT_CHARS ? points.slice(0, INBOUND_MAX_TEXT_CHARS).join("") : text,
      attachments,
    },
  };
}

/** SHA-256 (hex) of a credential, for consumer-lease keys and change detection; never the value itself. */
export function buzzCredentialKey(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex").slice(0, 32);
}

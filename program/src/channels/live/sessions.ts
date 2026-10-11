import { createHash } from "node:crypto";

import type { BinarySocketFactory } from "../buzz-relay-guard.js";
import type { Timers } from "../discord-gateway.js";
import { HuddleError } from "../huddle/client.js";
import { parseHuddleLifecycle } from "../huddle/events.js";
import { verifyEvent, type NostrEvent } from "../providers/nostr.js";
import type { TranscriptSegment } from "../huddle/listen.js";
import { createHuddleSession, type HuddleSession } from "../huddle/session.js";
import { SPEAK_TEXT_MAX_CHARS } from "../huddle/speak.js";
import type { SpeechProvider } from "../huddle/speech.js";
import type { ChannelRecord } from "../store.js";
import { CONFUSABLE_SKELETON, HAND_FIRST_SKELETON, INVISIBLE_LETTERS } from "./confusables.js";
import { modesOf, type LiveGrant, type LiveGrantService } from "./grants.js";
import type { LiveGrantRecord, LiveModes, LiveSessionRecord, LiveStore } from "./store.js";

/**
 * Live huddle sessions under a live-session grant (Channels P2 scope §2.3 and §3 "Huddles").
 *
 * `join` needs an ACTIVE grant of the caller for this channel's huddles that covers every requested mode, the
 * caller's outward consent for the channel (checked by the route), the Buzz identity, and room under the grant's caps
 * (joins per day/hour, interval, minutes per rolling day, provider minutes). With `consent.disclosureNotice` the
 * notice is posted first (kind 9 in the huddle's parent channel, outward under the same grant); if it cannot be
 * posted nothing joins. While joined, a tick (every 250 ms) re-reads the grant record, the owner switch, the consent
 * and the channel, and stops the session (the client leaves within 5 s) on revoke, pause, expiry, narrowing, consent
 * loss, channel pause, the session limit, the day minutes or the cost cap. Revoke/pause through Marketplace also
 * push a stop at once.
 *
 * Receipts: the transcript of what the agent heard (other participants: untrusted, with the speaker key) and said
 * (speak-live text; the SHA-256 of each approved clip), with times, plus join/leave times and minutes. Raw audio is
 * never stored: frames stay in the huddle client's bounded memory buffers. Audit gets metadata and SHA-256 only.
 */

export const LIVE_TICK_MS = 250;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const HEARTBEAT_EVERY_TICKS = 8;
/** A live session row whose owner process stopped writing heartbeats this long ago is ended (crash, restart). */
export const LIVE_STALE_SESSION_MS = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export type LiveResult = { status: number; body: Record<string, unknown> };

export type LiveSessionManagerDeps = {
  live: LiveStore;
  grants: LiveGrantService;
  organizationId: string;
  instanceId: string;
  now: () => Date;
  channel: (channelId: string) => ChannelRecord | null;
  /** The Buzz connection identity: the full credential (agent key, relay, owner tag) and the pinned owner key. */
  buzz: { credential: () => string | null; pinnedOwner: () => string | null } | null;
  /** Speech-to-text / text-to-speech. Null: listen is refused (no provider wired). */
  speech: SpeechProvider | null;
  /** Text-to-speech in Ogg/Opus (needs @tealbrick/voice rc.19 `format: "opus"`). False: speak-live is refused. */
  ttsAvailable: boolean;
  /** Posts the disclosure notice (kind 9) in the huddle's parent channel; returns the event id. */
  /** Posts the disclosure notice (kind 9) in one Buzz conversation (the parent channel or the huddle itself). */
  postNotice: (channel: ChannelRecord, conversationId: string, text: string) => Promise<{ ok: true; eventId: string | null } | { ok: false; error: string }>;
  /**
   * The huddle's link events (relay query; review M3): the 48100 "started" events in the parent channel and the 9007
   * create event of the huddle channel. Untrusted; verified here: the 48100 signature, kind, `h` = parent, content
   * `ephemeral_channel_id` = the huddle, and its signer = the signer of the huddle channel's 9007 (its creator).
   */
  huddleLinkEvents: (parentChannelId: string, huddleId: string) => Promise<{ ok: true; events: unknown[] } | { ok: false; error: string }>;
  retentionDays: () => number;
  audit: (eventType: string, actorId: string, metadata: Record<string, unknown>) => void;
  socketFactory?: BinarySocketFactory;
  env?: Record<string, string | undefined>;
  huddleTimers?: Timers;
  joinTimeoutMs?: number;
  closeGraceMs?: number;
  tickMs?: number;
};

type Running = {
  record: LiveSessionRecord;
  huddle: HuddleSession;
  grantId: string;
  maxSessionMs: number;
  joinedAtMs: number | null;
  providerSeconds: number;
  ttsActive: boolean;
  stopping: Promise<void> | null;
  forbidden: string[];
  ticks: number;
};

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The comparison skeleton of a text or a forbidden term (UTS #39 style): NFKC (ligatures, full-width), lowercase
 * (casefold; Turkish `İ` becomes `i` + a combining dot), NFD and removal of combining marks (Mn), format characters
 * (Cf: zero-width, soft hyphen) and invisible letters (Hangul fillers, braille blank), folding of the vendored
 * confusables subset (`confusables.ts`: Latin extensions and small capitals, Greek, Cyrillic, Cherokee), then letters
 * and digits only (spaces and punctuation cannot split a term).
 */
export function forbiddenSkeleton(value: string, table: Readonly<Record<string, string>> = CONFUSABLE_SKELETON, lower = true): string {
  const nfkc = value.normalize("NFKC");
  const folded = (lower ? nfkc.toLowerCase() : nfkc).normalize("NFD").replace(/[\p{Mn}\p{Cf}]/gu, "").replace(INVISIBLE_LETTERS, "");
  let out = "";
  for (const char of folded) out += table[char] ?? char;
  return out.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
}

/** Every comparison skeleton of a value: both tables, as written and lowercased. */
export function forbiddenSkeletons(value: string): string[] {
  const out = new Set<string>();
  for (const table of [CONFUSABLE_SKELETON, HAND_FIRST_SKELETON]) {
    for (const lower of [false, true]) out.add(forbiddenSkeleton(value, table, lower));
  }
  // The plain spelling too: UTS #39 maps some ASCII letters to other ASCII (m -> rn, I -> l), and every text letter
  // keeps its plain lowercase reading, so the term's plain form must stay a needle.
  out.add(forbiddenSkeleton(value, {}, true));
  return [...out];
}

const finalFold = (value: string) => value.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Every reading of one character of the text (review of #53, mixed-mode bypass): both tables, as written and
 * lowercased, plus the plain lowercase letter. An empty reading means the character can be skipped (punctuation,
 * spaces, marks). A term matches when SOME choice of one reading per character spells it, so letters that need
 * different modes in one word ("ΙΝVEST") cannot slip through.
 */
function tableReadings(char: string, out: Set<string>): void {
  const lower = char.toLowerCase();
  for (const candidate of [CONFUSABLE_SKELETON[char], HAND_FIRST_SKELETON[char], CONFUSABLE_SKELETON[lower], HAND_FIRST_SKELETON[lower]]) {
    if (candidate !== undefined) out.add(finalFold(candidate));
  }
}

const MAX_READINGS = 64;

function readingsOf(char: string): string[] {
  const out = new Set<string>();
  // The character as written (before compatibility normalization: U+017F long s reads "f", U+0132 reads "lj").
  tableReadings(char, out);
  // Its normalized form, one reading per resulting letter (fullwidth, ligatures, Roman numerals expand here).
  const parts = [...char.normalize("NFKC").normalize("NFD").replace(/[\p{Mn}\p{Cf}]/gu, "").replace(INVISIBLE_LETTERS, "")];
  let combos: string[] = [""];
  for (const part of parts) {
    const options = new Set<string>([finalFold(part.toLowerCase())]);
    tableReadings(part, options);
    const next: string[] = [];
    for (const prefix of combos) for (const option of options) if (next.length < MAX_READINGS) next.push(prefix + option);
    combos = next;
  }
  for (const combo of combos) out.add(combo);
  return [...out];
}

type Needle = { term: string; length: number; words: number; masks: Map<string, Uint32Array> };

function needleOf(term: string, skeleton: string): Needle {
  const chars = [...skeleton];
  const words = Math.ceil(chars.length / 32);
  const masks = new Map<string, Uint32Array>();
  chars.forEach((ch, index) => {
    let mask = masks.get(ch);
    if (!mask) masks.set(ch, (mask = new Uint32Array(words)));
    mask[index >>> 5]! |= 1 << (index & 31);
  });
  return { term, length: chars.length, words, masks };
}

/**
 * Forbidden terms (owner-approved) that occur in `text` under any per-character choice of readings. Bit-parallel
 * shift-and over the reading lattice: one bitset of matched term prefixes per needle (each needle is one skeleton of
 * a term), so the cost is text length × readings × needle words. Over-matching is accepted.
 */
export function forbiddenTermsIn(text: string, terms: readonly string[]): string[] {
  // Per character as written; each character carries its own readings (as written and normalized).
  const letters = [...text.normalize("NFC")];
  const lattice = letters.map(readingsOf);
  const needles: Needle[] = [];
  for (const term of terms) {
    for (const skeleton of forbiddenSkeletons(term)) if (skeleton.length > 0) needles.push(needleOf(term, skeleton));
  }
  const found = new Set<string>();
  for (const needle of needles) {
    if (found.has(needle.term)) continue;
    const { words, masks, length } = needle;
    const lastWord = (length - 1) >>> 5;
    const lastBit = 1 << ((length - 1) & 31);
    let state = new Uint32Array(words);
    const step = (from: Uint32Array, ch: string, start: boolean): Uint32Array => {
      const mask = masks.get(ch);
      const next = new Uint32Array(words);
      if (!mask) return next;
      let carry = start ? 1 : 0;
      for (let word = 0; word < words; word += 1) {
        const value = from[word]!;
        next[word] = ((value << 1) | carry) & mask[word]!;
        carry = value >>> 31;
      }
      return next;
    };
    let matched = false;
    for (const readings of lattice) {
      const acc = new Uint32Array(words);
      for (const reading of readings) {
        if (reading === "") {
          for (let word = 0; word < words; word += 1) acc[word]! |= state[word]!;
          continue;
        }
        let t: Uint32Array = state;
        // A match may start and end inside a multi-character reading (ß → ss, æ → ae): inject the start bit on every
        // step and test for a full match after every step. Over-matching is accepted.
        for (const ch of reading) {
          t = step(t, ch, true);
          if ((t[lastWord]! & lastBit) !== 0) matched = true;
        }
        for (let word = 0; word < words; word += 1) acc[word]! |= t[word]!;
      }
      state = acc;
      if (matched || (state[lastWord]! & lastBit) !== 0) {
        found.add(needle.term);
        break;
      }
    }
  }
  return terms.filter((term) => found.has(term));
}

/** A fixed server template (review L2); the agent's topic follows on its own, labelled line. */
export function disclosureText(input: { agentId: string; modes: LiveModes; topic: string; retentionDays: number }): string {
  const parts: string[] = [];
  if (input.modes.listen) parts.push("transcribe what is said (speech-to-text)");
  if (input.modes.speakApproved || input.modes.speakLive) parts.push("speak");
  const topic = input.topic.replace(HIDDEN, " ").slice(0, 200);
  return [
    `Notice from Marketplace: an AI agent (${input.agentId}) is joining this huddle to ${parts.join(" and ")}. ${
      input.modes.listen ? `A text transcript is kept for ${input.retentionDays} days; audio is never recorded.` : "Audio is never recorded."
    }`,
    `Topic (from the agent): ${topic}`,
  ].join("\n");
}

export type LiveSessionManager = ReturnType<typeof createLiveSessionManager>;

export function createLiveSessionManager(deps: LiveSessionManagerDeps) {
  const { live } = deps;
  const org = deps.organizationId;
  const running = new Map<string, Running>();
  const tickMs = Math.max(20, Math.min(1000, deps.tickMs ?? LIVE_TICK_MS));
  let ticker: ReturnType<typeof setInterval> | null = null;

  const ok = (status: number, body: Record<string, unknown>): LiveResult => ({ status, body: { ok: status < 400, schema: 1, ...body } });
  const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): LiveResult => ({ status, body: { ok: false, schema: 1, error, ...extra } });

  /** Minutes of all sessions of this grant inside the rolling day (wall clock from join to leave or now). */
  const dayMinutes = (grantId: string, nowMs: number) => {
    const since = nowMs - DAY_MS;
    let ms = 0;
    for (const session of live.sessionsSince(org, grantId, new Date(since))) {
      const start = Date.parse(session.joinedAt ?? session.startedAt);
      const end = session.leftAt ? Date.parse(session.leftAt) : nowMs;
      if (!session.joinedAt && session.status !== "joining") continue;
      ms += Math.max(0, Math.min(end, nowMs) - Math.max(start, since));
    }
    return ms / 60_000;
  };

  const providerSecondsOf = (grantId: string) => live.getGrant(org, grantId)?.providerSeconds ?? 0;

  /** The usage counters the owner and the agent see. */
  const usageView = (record: LiveGrantRecord, grant: LiveGrant | null) => {
    const nowMs = deps.now().getTime();
    const current = live.listSessions(org, { grantId: record.id, live: true, limit: 1 })[0] ?? null;
    const sessionMinutes = current?.joinedAt ? (nowMs - Date.parse(current.joinedAt)) / 60_000 : 0;
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      minutesToday: round(dayMinutes(record.id, nowMs)),
      maxDayMinutes: grant?.scope.maxDayMinutes ?? null,
      minutesInSession: round(sessionMinutes),
      maxSessionMinutes: grant?.scope.maxSessionMinutes ?? null,
      providerMinutes: round(record.providerSeconds / 60),
      providerMinutesCap: grant?.scope.costCap.providerMinutes ?? null,
      activeSessionId: current?.id ?? null,
    };
  };

  const usageOf = (run: Running) => ({ listenedSeconds: run.huddle.minutesListened * 60, spokenSeconds: run.huddle.minutesSpoken * 60, providerSeconds: run.providerSeconds });

  const ensureTicker = () => {
    if (ticker || running.size === 0) return;
    ticker = setInterval(() => void tickAll(), tickMs);
    (ticker as { unref?: () => void }).unref?.();
  };
  const maybeStopTicker = () => {
    if (ticker && running.size === 0) {
      clearInterval(ticker);
      ticker = null;
    }
  };

  /** The session ended (left, stopped, failed): end the row once, write the receipt digest to the audit. */
  const finish = (run: Running, reason: string, failed = false) => {
    running.delete(run.record.id);
    maybeStopTicker();
    const ended = live.endSession(org, run.record.id, { status: failed ? "failed" : "left", reason, usage: usageOf(run), now: deps.now() });
    const lines = live.listTranscript(org, run.record.id, 5000);
    deps.audit("marketplace.channels.live_session.ended", `agent:${run.record.agentId}`, {
      sessionId: run.record.id,
      grantId: run.grantId,
      channelId: run.record.channelId,
      reason,
      joinedAt: ended?.joinedAt ?? run.record.joinedAt,
      leftAt: ended?.leftAt ?? deps.now().toISOString(),
      minutesListened: Math.round(run.huddle.minutesListened * 100) / 100,
      minutesSpoken: Math.round(run.huddle.minutesSpoken * 100) / 100,
      providerMinutes: Math.round((run.providerSeconds / 60) * 100) / 100,
      transcriptLines: lines.length,
      // Metadata and a SHA-256 only: the digest of the receipt lines, never their text.
      transcriptSha256: sha256Hex(lines.map((line) => `${line.kind}|${line.speakerPubkey ?? ""}|${line.startedAt}|${line.textSha256}|${line.clipSha256 ?? ""}`).join("\n")),
    });
  };

  const stopRun = (run: Running, reason: string): Promise<void> => {
    if (run.stopping) return run.stopping;
    run.stopping = (async () => {
      try {
        await run.huddle.stop(reason);
      } finally {
        if (running.has(run.record.id)) finish(run, reason);
      }
    })();
    return run.stopping;
  };

  /** Why this session must stop now, or null. */
  const stopReason = (run: Running): string | null => {
    const row = live.getSession(org, run.record.id);
    if (!row || (row.status !== "joining" && row.status !== "joined")) return row?.endReason ?? "session_ended";
    const record = live.getGrant(org, run.grantId);
    const usable = deps.grants.usable(record);
    if (!usable.ok) return usable.reason;
    if (usable.record.digest !== run.record.grantDigest) return "grant_changed";
    const modes = usable.grant.scope.modes;
    if ((run.record.modes.listen && !modes.listen) || (run.record.modes.speakApproved && !modes.speakApproved) || (run.record.modes.speakLive && !modes.speakLive)) return "grant_changed";
    if (!deps.buzz?.credential()) return "buzz_identity_missing";
    const nowMs = deps.now().getTime();
    if (run.joinedAtMs !== null && nowMs - run.joinedAtMs >= Math.min(run.maxSessionMs, usable.grant.scope.maxSessionMinutes * 60_000)) return "max_session_minutes";
    if (dayMinutes(run.grantId, nowMs) >= usable.grant.scope.maxDayMinutes) return "max_day_minutes";
    if (usable.record.providerSeconds >= usable.grant.scope.costCap.providerMinutes * 60) return "cost_cap_reached";
    return null;
  };

  const tickAll = async () => {
    for (const run of [...running.values()]) {
      if (run.stopping) continue;
      let reason: string | null;
      try {
        reason = stopReason(run);
      } catch {
        reason = "live_check_failed";
      }
      if (reason) {
        void stopRun(run, reason);
        continue;
      }
      run.ticks += 1;
      if (run.ticks % HEARTBEAT_EVERY_TICKS === 0) live.heartbeat(org, run.record.id, usageOf(run), deps.now());
    }
  };

  /**
   * Ends live rows no process is running any more (no heartbeat for LIVE_STALE_SESSION_MS, not ours): a crash or a
   * restart must not keep a grant "in session" or count its minutes forever.
   */
  const recoverStale = (filter: { grantId?: string } = {}) => {
    const cutoff = deps.now().getTime() - LIVE_STALE_SESSION_MS;
    for (const row of live.listSessions(org, { ...(filter.grantId ? { grantId: filter.grantId } : {}), live: true, limit: 500 })) {
      if (running.has(row.id) || Date.parse(row.updatedAt) > cutoff) continue;
      const ended = live.endSession(org, row.id, { status: "failed", reason: "stale_session", now: deps.now() });
      if (ended) deps.audit("marketplace.channels.live_session.ended", "marketplace:live", { sessionId: row.id, grantId: row.grantId, reason: "stale_session" });
    }
  };

  /** Pushed by revoke / pause / narrow / withdraw (also caught by the next tick). */
  const onGrantChanged = (grantId: string, reason: string) => {
    for (const run of running.values()) if (run.grantId === grantId) void stopRun(run, reason);
  };
  const onControlChanged = (paused: boolean) => {
    if (!paused) return;
    for (const run of running.values()) void stopRun(run, "grants_paused");
  };

  const capsRefusal = (record: LiveGrantRecord, grant: LiveGrant, nowMs: number): LiveResult | null => {
    const day = live.joinsSince(org, record.id, new Date(nowMs - DAY_MS));
    if (day.length >= grant.caps.perDay) return refuse(429, "live_cap_reached", { cap: "caps.perDay" });
    if (grant.caps.perHour !== undefined && day.filter((session) => Date.parse(session.startedAt) >= nowMs - HOUR_MS).length >= grant.caps.perHour) {
      return refuse(429, "live_cap_reached", { cap: "caps.perHour" });
    }
    const last = day[0];
    if (grant.caps.minIntervalSeconds !== undefined && last && nowMs - Date.parse(last.startedAt) < grant.caps.minIntervalSeconds * 1000) {
      return refuse(429, "live_cap_reached", { cap: "caps.minIntervalSeconds", retryAfterSeconds: Math.ceil((Date.parse(last.startedAt) + grant.caps.minIntervalSeconds * 1000 - nowMs) / 1000) });
    }
    if (dayMinutes(record.id, nowMs) >= grant.scope.maxDayMinutes) return refuse(429, "live_cap_reached", { cap: "maxDayMinutes" });
    if (record.providerSeconds >= grant.scope.costCap.providerMinutes * 60) return refuse(429, "live_cap_reached", { cap: "costCap.providerMinutes" });
    return null;
  };

  const sessionView = (record: LiveSessionRecord) => ({
    sessionId: record.id,
    grantId: record.grantId,
    channelId: record.channelId,
    agentId: record.agentId,
    huddleId: record.huddleId,
    modes: record.modes,
    status: record.status,
    startedAt: record.startedAt,
    joinedAt: record.joinedAt,
    leftAt: record.leftAt,
    endReason: record.endReason,
    minutesListened: Math.round((record.listenedSeconds / 60) * 100) / 100,
    minutesSpoken: Math.round((record.spokenSeconds / 60) * 100) / 100,
    providerMinutes: Math.round((record.providerSeconds / 60) * 100) / 100,
    disclosureEventId: record.disclosureEventId,
    peers: running.get(record.id)?.huddle.peers.length ?? null,
  });

  /** `marketplace.channel-live.join`. The route already checked the caller's outward consent for `channel`. */
  const join = async (input: { agentId: string; channel: ChannelRecord; grantId: string; huddleId: string; modes: LiveModes }): Promise<LiveResult> => {
    const { channel } = input;
    const credential = deps.buzz?.credential() ?? null;
    if (!deps.buzz || !credential) return refuse(409, "live_buzz_identity_missing");
    if (channel.provider !== "buzz" || channel.status !== "active") return refuse(409, "channel_not_active");
    const parent = channel.destination.externalId;
    if (!UUID.test(input.huddleId) || !UUID.test(parent)) return refuse(422, "live_target_invalid");
    const requested = (["listen", "speakApproved", "speakLive"] as const).filter((mode) => input.modes[mode] === true);
    if (requested.length === 0) return refuse(422, "live_modes_required");
    const record = live.getGrant(org, input.grantId);
    // Only the caller's own grant for this channel; anything else looks unknown.
    if (!record || record.agentId !== input.agentId || record.channelId !== channel.id) return refuse(404, "live_grant_not_found");
    const usable = deps.grants.usable(record);
    if (!usable.ok) return refuse(409, "live_grant_not_active", { reason: usable.reason });
    const grant = usable.grant;
    const scope = grant.scope;
    const target = scope.target;
    if (target.huddleId ? target.huddleId !== input.huddleId : target.channelId !== parent) return refuse(403, "live_grant_target_mismatch");
    const missing = requested.filter((mode) => !scope.modes[mode]);
    if (missing.length > 0) return refuse(403, "live_mode_not_granted", { modes: missing });
    if (input.modes.listen) {
      // The grant asks for a per-participant consent gate that Marketplace cannot enforce yet: no listening.
      if (scope.consent.perParticipantConsent) return refuse(409, "live_participant_consent_unavailable");
      if (!deps.speech) return refuse(409, "live_speech_unavailable");
    }
    if (input.modes.speakLive && (!deps.speech || !deps.ttsAvailable)) return refuse(409, "live_tts_unavailable", { detail: "text-to-speech in Ogg/Opus needs @tealbrick/voice rc.19 (format opus)" });
    const nowMs = deps.now().getTime();
    const caps = capsRefusal(usable.record, grant, nowMs);
    if (caps) return caps;
    // Review M3: the huddle must be an ephemeral huddle of THIS channel, proven by its creator-signed 48100 link.
    let started: Awaited<ReturnType<LiveSessionManagerDeps["huddleLinkEvents"]>>;
    try {
      started = await deps.huddleLinkEvents(parent, input.huddleId);
    } catch {
      started = { ok: false, error: "provider_internal_error" };
    }
    if (!started.ok) return refuse(502, "live_huddle_check_failed", { detail: started.error });
    // The huddle channel's creator: the signer of its verified 9007 create event (`h` = the huddle).
    const creators = new Set(
      started.events
        .filter((event): event is NostrEvent => verifyEvent(event) && event.kind === 9007 && event.tags.some((tag) => tag[0] === "h" && tag[1] === input.huddleId))
        .map((event) => event.pubkey),
    );
    const linked = started.events.some((event) => {
      const lifecycle = parseHuddleLifecycle(event, "");
      return lifecycle?.type === "started" && lifecycle.parentChannelId === parent && lifecycle.huddleChannelId === input.huddleId && creators.has(lifecycle.signer);
    });
    if (!linked) return refuse(403, "live_huddle_not_in_channel");
    const modes: LiveModes = Object.fromEntries(requested.map((mode) => [mode, true])) as LiveModes;
    recoverStale({ grantId: record.id });
    const startedRow = live.startSession({
      workspaceSlug: org,
      grantId: record.id,
      grantDigest: record.digest,
      channelId: channel.id,
      agentId: input.agentId,
      huddleId: input.huddleId,
      modes,
      instanceId: deps.instanceId,
      now: deps.now(),
    });
    if (!startedRow.ok) return refuse(409, startedRow.error);
    const session = startedRow.session;
    const remainingDayMs = (scope.maxDayMinutes - dayMinutes(record.id, nowMs)) * 60_000;
    const maxSessionMs = Math.max(1000, Math.min(scope.maxSessionMinutes * 60_000, remainingDayMs));
    deps.audit("marketplace.channels.live_session.joining", `agent:${input.agentId}`, { sessionId: session.id, grantId: record.id, digest: record.digest, channelId: channel.id, huddleId: input.huddleId, modes });

    // Disclosure first: nothing is captured before the notice is out (scope §2.3 rule 4), in the parent channel AND
    // in the huddle itself (review M3). Both must be posted, or nothing joins.
    if (scope.consent.disclosureNotice) {
      const text = disclosureText({ agentId: input.agentId, modes, topic: scope.topic, retentionDays: deps.retentionDays() });
      let firstEventId: string | null = null;
      for (const conversation of [parent, input.huddleId]) {
        let notice: Awaited<ReturnType<LiveSessionManagerDeps["postNotice"]>>;
        try {
          notice = await deps.postNotice(channel, conversation, text);
        } catch {
          notice = { ok: false, error: "provider_internal_error" };
        }
        if (!notice.ok) {
          live.endSession(org, session.id, { status: "failed", reason: "disclosure_failed", now: deps.now() });
          return refuse(502, "live_disclosure_failed", { sessionId: session.id, detail: notice.error });
        }
        firstEventId ??= notice.eventId;
      }
      live.setDisclosure(org, session.id, firstEventId);
    }

    let run: Running | null = null;
    const huddle = createHuddleSession({
      credential,
      pinnedOwner: () => deps.buzz?.pinnedOwner() ?? null,
      channelId: input.huddleId,
      parentChannelId: parent,
      speech: deps.speech ?? refusingSpeech,
      modes: { listen: modes.listen === true, speakApproved: modes.speakApproved === true, speakLive: modes.speakLive === true },
      maxSessionMs,
      ...(deps.socketFactory ? { socketFactory: deps.socketFactory } : {}),
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.huddleTimers ? { timers: deps.huddleTimers } : {}),
      ...(deps.joinTimeoutMs !== undefined ? { joinTimeoutMs: deps.joinTimeoutMs } : {}),
      ...(deps.closeGraceMs !== undefined ? { closeGraceMs: deps.closeGraceMs } : {}),
      usage: {
        canSpend: (kind, seconds) => {
          if (!run) return false;
          // Approved clips cost no provider minutes; speech-to-text and text-to-speech do.
          if (kind === "speak" && !run.ttsActive) return true;
          const left = scope.costCap.providerMinutes * 60 - providerSecondsOf(run.grantId);
          return left >= seconds;
        },
        onUsage: (usage) => {
          if (!run) return;
          if (usage.kind === "listen" || run.ttsActive) {
            run.providerSeconds += usage.seconds;
            live.addProviderSeconds(org, run.grantId, usage.seconds);
          }
        },
      },
      onTranscript: (segment) => {
        if (run) recordHeard(run, segment);
      },
      onEnded: (reason) => {
        if (run && running.has(run.record.id) && !run.stopping) finish(run, reason);
      },
    });
    run = { record: session, huddle, grantId: record.id, maxSessionMs, joinedAtMs: null, providerSeconds: 0, ttsActive: false, stopping: null, forbidden: scope.forbiddenTerms, ticks: 0 };
    running.set(session.id, run);
    ensureTicker();
    let peers: string[];
    try {
      peers = (await huddle.join()).peers;
    } catch (error) {
      const code = error instanceof HuddleError ? error.code : "huddle_join_failed";
      running.delete(session.id);
      maybeStopTicker();
      live.endSession(org, session.id, { status: "failed", reason: code, now: deps.now() });
      deps.audit("marketplace.channels.live_session.join_failed", `agent:${input.agentId}`, { sessionId: session.id, grantId: record.id, reason: code });
      return refuse(502, "live_join_failed", { sessionId: session.id, reason: code });
    }
    run.joinedAtMs = deps.now().getTime();
    live.markJoined(org, session.id, deps.now());
    run.record = live.getSession(org, session.id) ?? session;
    // The grant may have changed while joining: the first check runs now, not a tick later.
    const reason = stopReason(run);
    if (reason) {
      await stopRun(run, reason);
      return refuse(409, "live_grant_not_active", { sessionId: session.id, reason });
    }
    deps.audit("marketplace.channels.live_session.joined", `agent:${input.agentId}`, { sessionId: session.id, grantId: record.id, peers: peers.length });
    return ok(201, { session: sessionView(run.record), peers: peers.length });
  };

  const recordHeard = (run: Running, segment: TranscriptSegment) => {
    const text = segment.text.replace(HIDDEN, " ").trim().slice(0, 4000);
    if (!text) return;
    try {
      live.addTranscript({
        workspaceSlug: org,
        sessionId: run.record.id,
        grantId: run.grantId,
        agentId: run.record.agentId,
        kind: "heard",
        speakerPubkey: segment.speakerPubkey,
        text,
        textSha256: sha256Hex(text),
        // Forbidden terms in what others say are flagged only (never refused: we cannot unsay them).
        flaggedTerms: forbiddenTermsIn(text, run.forbidden),
        startedAt: new Date(segment.startedAt),
        endedAt: new Date(segment.endedAt),
        now: deps.now(),
      });
    } catch {
      // A failed receipt write never breaks the session; the audit digest covers what was stored.
    }
  };

  const ownRunning = (agentId: string, sessionId: string, channelId: string): Running | null => {
    const run = running.get(sessionId);
    return run && run.record.agentId === agentId && run.record.channelId === channelId ? run : null;
  };

  /** `marketplace.channel-live.leave` (agent: own session). */
  const leave = async (input: { agentId: string; channelId: string; sessionId: string }): Promise<LiveResult> => {
    const row = live.getSession(org, input.sessionId);
    if (!row || row.agentId !== input.agentId || row.channelId !== input.channelId) return refuse(404, "live_session_not_found");
    const run = ownRunning(input.agentId, input.sessionId, input.channelId);
    if (run) await stopRun(run, "left_by_agent");
    else live.endSession(org, row.id, { status: "left", reason: "left_by_agent", now: deps.now() });
    return ok(200, { session: sessionView(live.getSession(org, row.id) ?? row) });
  };

  /** Owner Stop: any session (in this instance at once; another instance's tick sees the ended row). */
  const stopByOwner = async (input: { sessionId: string; actorId: string }): Promise<LiveResult> => {
    const row = live.getSession(org, input.sessionId);
    if (!row) return refuse(404, "live_session_not_found");
    const run = running.get(row.id);
    deps.audit("marketplace.channels.live_session.stopped", input.actorId, { sessionId: row.id, grantId: row.grantId });
    if (run) await stopRun(run, "stopped_by_owner");
    else live.endSession(org, row.id, { status: "left", reason: "stopped_by_owner", now: deps.now() });
    return ok(200, { session: sessionView(live.getSession(org, row.id) ?? row) });
  };

  /**
   * speak-approved: plays an Ogg/Opus clip whose approval the route confirmed (digest bound to the grant digest, this
   * session and the clip bytes). Single use: the approval is claimed before the first packet (review H1).
   */
  const speakClip = async (input: { agentId: string; channelId: string; sessionId: string; clip: Uint8Array; clipSha256: string; approvalId: string; transcript: string }): Promise<LiveResult> => {
    const run = ownRunning(input.agentId, input.sessionId, input.channelId);
    if (!run || run.stopping) return refuse(409, "live_session_not_joined");
    if (!run.record.modes.speakApproved) return refuse(403, "live_mode_not_granted", { modes: ["speakApproved"] });
    const reason = stopReason(run);
    if (reason) {
      void stopRun(run, reason);
      return refuse(409, "live_grant_not_active", { reason });
    }
    if (!live.claimClipUse(org, input.approvalId, run.record.id, deps.now())) return refuse(409, "live_clip_already_played", { approvalId: input.approvalId });
    const startedAt = deps.now();
    let result;
    try {
      result = await run.huddle.speak(input.clip);
    } catch (error) {
      return refuse(error instanceof HuddleError && error.code === "huddle_speak_busy" ? 409 : 422, error instanceof HuddleError ? error.code : "speak_failed");
    }
    live.addTranscript({
      workspaceSlug: org,
      sessionId: run.record.id,
      grantId: run.grantId,
      agentId: input.agentId,
      kind: "said",
      speakerPubkey: null,
      // The agent-stated transcript of the clip the owner approved (and listened to).
      text: input.transcript,
      textSha256: sha256Hex(input.transcript),
      clipSha256: result.sha256,
      flaggedTerms: [],
      startedAt,
      endedAt: deps.now(),
      now: deps.now(),
    });
    return ok(200, { spoken: { kind: "clip", sha256: result.sha256, seconds: result.seconds, aborted: result.aborted } });
  };

  /** speak-live: text → TTS under the grant's speakLive mode; forbidden terms refuse before any provider call. */
  const speakText = async (input: { agentId: string; channelId: string; sessionId: string; text: string; voice?: string }): Promise<LiveResult> => {
    const run = ownRunning(input.agentId, input.sessionId, input.channelId);
    if (!run || run.stopping) return refuse(409, "live_session_not_joined");
    if (!run.record.modes.speakLive) return refuse(403, "live_mode_not_granted", { modes: ["speakLive"] });
    if (!deps.ttsAvailable || !deps.speech) return refuse(409, "live_tts_unavailable", { detail: "text-to-speech in Ogg/Opus needs @tealbrick/voice rc.19 (format opus)" });
    // Hidden format characters (zero-width, soft hyphen, bidi controls) are refused, never silently cleaned (M4).
    if (/\p{Cf}/u.test(input.text) || /[\u115F\u1160\u3164\uFFA0\u2800]/u.test(input.text)) return refuse(422, "live_text_hidden_characters");
    const text = input.text.replace(HIDDEN, " ").trim();
    if (!text || text.length > SPEAK_TEXT_MAX_CHARS) return refuse(422, "speak_text_invalid");
    const hits = forbiddenTermsIn(text, run.forbidden);
    if (hits.length > 0) {
      deps.audit("marketplace.channels.live_session.speak_refused", `agent:${input.agentId}`, { sessionId: run.record.id, reason: "forbidden_term", terms: hits.length, textSha256: sha256Hex(text) });
      return refuse(422, "live_forbidden_term");
    }
    const reason = stopReason(run);
    if (reason) {
      void stopRun(run, reason);
      return refuse(409, "live_grant_not_active", { reason });
    }
    const startedAt = deps.now();
    run.ttsActive = true;
    let result;
    try {
      result = await run.huddle.speakText(text, input.voice ? { voice: input.voice } : {});
    } catch (error) {
      return refuse(error instanceof HuddleError && error.code === "huddle_speak_busy" ? 409 : 502, error instanceof HuddleError ? error.code : "speech_failed");
    } finally {
      run.ttsActive = false;
    }
    live.addTranscript({
      workspaceSlug: org,
      sessionId: run.record.id,
      grantId: run.grantId,
      agentId: input.agentId,
      kind: "said",
      speakerPubkey: null,
      text,
      textSha256: sha256Hex(text),
      clipSha256: result.sha256,
      flaggedTerms: [],
      startedAt,
      endedAt: deps.now(),
      now: deps.now(),
    });
    return ok(200, { spoken: { kind: "text", sha256: result.sha256, seconds: result.seconds, aborted: result.aborted } });
  };

  /** Retention: transcript text after the inbound text retention. */
  const purge = (now: Date) => {
    // Clip play records outlive their hold (24 h) by a day at most.
    live.purgeClipPlays(org, new Date(now.getTime() - 2 * DAY_MS));
    return live.purgeTranscripts(org, new Date(now.getTime() - deps.retentionDays() * DAY_MS), now);
  };

  /** Stops every running session (app close). */
  const close = async () => {
    await Promise.all([...running.values()].map((run) => stopRun(run, "marketplace_stopping")));
    maybeStopTicker();
  };

  try {
    recoverStale();
  } catch {
    // A failed recovery is retried at the next join of each grant.
  }

  return {
    join,
    leave,
    recoverStale,
    stopByOwner,
    speakClip,
    speakText,
    onGrantChanged,
    onControlChanged,
    usageView,
    sessionView,
    purge,
    close,
    tick: tickAll,
    isRunning: (sessionId: string) => running.has(sessionId),
    runningCount: () => running.size,
    modesOf,
  };
}

/** Stand-in when no speech provider is wired: never called for listen (join refuses), refuses everything. */
const refusingSpeech: SpeechProvider = {
  async transcribe() {
    throw new Error("live_speech_unavailable");
  },
  async synthesize() {
    throw new Error("live_tts_unavailable");
  },
};

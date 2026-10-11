import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Channels P2 live-session state (scope §2.3, contract alpha.8 live-session grants). Additive only: every table is
 * `CREATE TABLE IF NOT EXISTS`, so an older Marketplace ignores them.
 *
 * - `channel_live_grant`: one live-session grant per row. `canonical` is the canonical grant JSON exactly as the
 *   contract produced it (`canonicalGrant` / `result.canonical`), `digest` its `grantDigest`. Any change writes a new
 *   canonical + digest and needs a new owner approval. `approval_ref` names the proof that approved it
 *   (`nostr:<event id>` / `portal:<jti>`, also marked used instance-wide in `marketplace_used_approval_proof`, or
 *   `ui:<actor>`). `approval_channel` is the Buzz conversation a Buzz approval must come from: the Buzz channel of the
 *   Marketplace channel record (owner-configured), copied at proposal time, never taken from a request.
 * - `channel_live_session`: one huddle session (join/leave times, modes, end reason, minutes). Never audio.
 * - `channel_live_transcript`: the receipt lines (what the agent heard and said, with times; the SHA-256 of each
 *   approved clip). Text is purged after the inbound text retention; the row keeps metadata.
 * - `channel_live_control`: the owner's global switch (`pause grants` / `resume grants`) and the owner command
 *   channel for signed Buzz commands. `changed_at` (and each grant's `state_changed_at`) is a monotonic time in ms:
 *   a signed owner command created at or before it is refused, so an older withheld command never undoes a later
 *   change.
 * - `channel_live_clip_use`: one row per approved speak-approved clip that was played (single use).
 * - `channel_live_clip_play`: the owner playback route served the EXACT stored clip (full body) to one owner launch
 *   session (`owner_session_ref` = SHA-256 of the session cookie, never the cookie) for one hold digest, and when.
 *   Approving a clip hold needs such a row of the approving session.
 */

export const LIVE_TABLES = ["channel_live_grant", "channel_live_session", "channel_live_transcript", "channel_live_control", "channel_live_clip_use", "channel_live_clip_play"] as const;

const LIVE_DDL = `
  CREATE TABLE IF NOT EXISTS channel_live_grant (
    id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    consent_id TEXT NOT NULL,
    approval_channel TEXT NOT NULL,
    canonical TEXT NOT NULL,
    digest TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    proposed_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT,
    approval_source TEXT,
    approval_ref TEXT,
    approved_digest TEXT,
    approval_expires_at TEXT,
    decided_reason TEXT,
    provider_seconds REAL NOT NULL DEFAULT 0,
    state_changed_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_live_grant_scope ON channel_live_grant(workspace_slug, channel_id, agent_id, status);
  CREATE INDEX IF NOT EXISTS idx_channel_live_grant_digest ON channel_live_grant(workspace_slug, digest);

  CREATE TABLE IF NOT EXISTS channel_live_session (
    id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    grant_digest TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    huddle_id TEXT NOT NULL,
    modes_json TEXT NOT NULL,
    status TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    joined_at TEXT,
    left_at TEXT,
    end_reason TEXT,
    listened_seconds REAL NOT NULL DEFAULT 0,
    spoken_seconds REAL NOT NULL DEFAULT 0,
    provider_seconds REAL NOT NULL DEFAULT 0,
    disclosure_event_id TEXT,
    heartbeat_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_live_session_grant ON channel_live_session(workspace_slug, grant_id, status);
  CREATE INDEX IF NOT EXISTS idx_channel_live_session_agent ON channel_live_session(workspace_slug, agent_id, started_at);

  CREATE TABLE IF NOT EXISTS channel_live_transcript (
    id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    session_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    speaker_pubkey TEXT,
    text TEXT NOT NULL,
    text_sha256 TEXT,
    clip_sha256 TEXT,
    flagged_terms_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    purged_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_live_transcript_session ON channel_live_transcript(workspace_slug, session_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_channel_live_transcript_created ON channel_live_transcript(workspace_slug, created_at);

  CREATE TABLE IF NOT EXISTS channel_live_control (
    workspace_slug TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    paused_at TEXT,
    paused_by TEXT,
    command_channel TEXT,
    command_channel_set_by TEXT,
    changed_at INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_live_clip_play (
    id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    approval_id TEXT NOT NULL,
    owner_session_ref TEXT NOT NULL,
    clip_digest TEXT NOT NULL,
    clip_sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    served_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_live_clip_play ON channel_live_clip_play(workspace_slug, approval_id, owner_session_ref);

  CREATE TABLE IF NOT EXISTS channel_live_clip_use (
    approval_id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    session_id TEXT NOT NULL,
    used_at TEXT NOT NULL
  );
`;

export function migrateLiveTables(db: DatabaseSync): void {
  db.exec(LIVE_DDL);
  // Pre-0.3.0 review L4: `text_sha256` is NULL after retention purge. A table made before that was NOT NULL: rebuild it
  // once (SQLite cannot drop a NOT NULL constraint in place).
  const column = (db.prepare("PRAGMA table_info(channel_live_transcript)").all() as Array<{ name: string; notnull: number }>).find((entry) => entry.name === "text_sha256");
  if (column && Number(column.notnull) === 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE channel_live_transcript RENAME TO channel_live_transcript_old;
        DROP INDEX IF EXISTS idx_channel_live_transcript_session;
        DROP INDEX IF EXISTS idx_channel_live_transcript_created;
      `);
      db.exec(LIVE_DDL);
      db.exec("INSERT INTO channel_live_transcript SELECT * FROM channel_live_transcript_old; DROP TABLE channel_live_transcript_old;");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export type LiveGrantStatus = "proposed" | "active" | "paused" | "revoked" | "expired" | "declined" | "withdrawn";
export type LiveApprovalSource = "marketplace-ui" | "nostr" | "portal";

export type LiveGrantRecord = {
  id: string;
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  consentId: string;
  approvalChannel: string;
  canonical: string;
  digest: string;
  status: LiveGrantStatus;
  revision: number;
  proposedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approvalSource: LiveApprovalSource | null;
  approvalRef: string | null;
  approvedDigest: string | null;
  approvalExpiresAt: string | null;
  decidedReason: string | null;
  providerSeconds: number;
  /** Monotonic time (ms) of the last state change; signed commands must be newer. */
  stateChangedAt: number;
  createdAt: string;
  updatedAt: string;
};

export type LiveSessionStatus = "joining" | "joined" | "left" | "failed";

export type LiveModes = { listen?: true; speakApproved?: true; speakLive?: true };

export type LiveSessionRecord = {
  id: string;
  workspaceSlug: string;
  grantId: string;
  grantDigest: string;
  channelId: string;
  agentId: string;
  huddleId: string;
  modes: LiveModes;
  status: LiveSessionStatus;
  instanceId: string;
  startedAt: string;
  joinedAt: string | null;
  leftAt: string | null;
  endReason: string | null;
  listenedSeconds: number;
  spokenSeconds: number;
  providerSeconds: number;
  disclosureEventId: string | null;
  heartbeatAt: string;
  updatedAt: string;
};

export type LiveTranscriptKind = "heard" | "said" | "notice";

export type LiveTranscriptRecord = {
  id: string;
  sessionId: string;
  grantId: string;
  agentId: string;
  kind: LiveTranscriptKind;
  speakerPubkey: string | null;
  text: string;
  /** The SHA-256 of the text; null once the retention purge removed the text (only metadata stays). */
  textSha256: string | null;
  clipSha256: string | null;
  flaggedTerms: string[];
  startedAt: string;
  endedAt: string;
  purgedAt: string | null;
  createdAt: string;
};

export type LiveControl = { paused: boolean; pausedAt: string | null; pausedBy: string | null; commandChannel: string | null; changedAt: number; updatedAt: string | null };

type Row = Record<string, unknown>;
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const iso = (value: Date | string) => (typeof value === "string" ? new Date(value).toISOString() : value.toISOString());

function grantFromRow(row: Row): LiveGrantRecord {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    channelId: String(row.channel_id),
    agentId: String(row.agent_id),
    consentId: String(row.consent_id),
    approvalChannel: String(row.approval_channel),
    canonical: String(row.canonical),
    digest: String(row.digest),
    status: String(row.status) as LiveGrantStatus,
    revision: Number(row.revision),
    proposedAt: String(row.proposed_at),
    approvedAt: text(row.approved_at),
    approvedBy: text(row.approved_by),
    approvalSource: text(row.approval_source) as LiveApprovalSource | null,
    approvalRef: text(row.approval_ref),
    approvedDigest: text(row.approved_digest),
    approvalExpiresAt: text(row.approval_expires_at),
    decidedReason: text(row.decided_reason),
    providerSeconds: Number(row.provider_seconds),
    stateChangedAt: Number(row.state_changed_at ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function modesFrom(value: unknown): LiveModes {
  try {
    const parsed = JSON.parse(String(value)) as Record<string, unknown>;
    return {
      ...(parsed.listen === true ? { listen: true as const } : {}),
      ...(parsed.speakApproved === true ? { speakApproved: true as const } : {}),
      ...(parsed.speakLive === true ? { speakLive: true as const } : {}),
    };
  } catch {
    return {};
  }
}

function sessionFromRow(row: Row): LiveSessionRecord {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    grantId: String(row.grant_id),
    grantDigest: String(row.grant_digest),
    channelId: String(row.channel_id),
    agentId: String(row.agent_id),
    huddleId: String(row.huddle_id),
    modes: modesFrom(row.modes_json),
    status: String(row.status) as LiveSessionStatus,
    instanceId: String(row.instance_id),
    startedAt: String(row.started_at),
    joinedAt: text(row.joined_at),
    leftAt: text(row.left_at),
    endReason: text(row.end_reason),
    listenedSeconds: Number(row.listened_seconds),
    spokenSeconds: Number(row.spoken_seconds),
    providerSeconds: Number(row.provider_seconds),
    disclosureEventId: text(row.disclosure_event_id),
    heartbeatAt: String(row.heartbeat_at),
    updatedAt: String(row.updated_at),
  };
}

function transcriptFromRow(row: Row): LiveTranscriptRecord {
  let flagged: string[] = [];
  try {
    const parsed = JSON.parse(String(row.flagged_terms_json)) as unknown;
    if (Array.isArray(parsed)) flagged = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    flagged = [];
  }
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    grantId: String(row.grant_id),
    agentId: String(row.agent_id),
    kind: String(row.kind) as LiveTranscriptKind,
    speakerPubkey: text(row.speaker_pubkey),
    text: String(row.text),
    textSha256: text(row.text_sha256),
    clipSha256: text(row.clip_sha256),
    flaggedTerms: flagged,
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    purgedAt: text(row.purged_at),
    createdAt: String(row.created_at),
  };
}

/** A fresh grant id: `live-` + 16 random hex, so every proposal has its own digest (no cross-deployment replay). */
export function newLiveGrantId(): string {
  return `live-${randomBytes(8).toString("hex")}`;
}

export class LiveStore {
  constructor(private readonly db: DatabaseSync) {}

  private immediate<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ----- grants -----------------------------------------------------------------

  createGrant(input: {
    id: string;
    workspaceSlug: string;
    channelId: string;
    agentId: string;
    consentId: string;
    approvalChannel: string;
    canonical: string;
    digest: string;
    now: Date;
  }): LiveGrantRecord {
    const at = iso(input.now);
    this.db
      .prepare(
        `INSERT INTO channel_live_grant (id, workspace_slug, channel_id, agent_id, consent_id, approval_channel, canonical, digest,
          status, revision, proposed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 1, ?, ?, ?)`,
      )
      .run(input.id, input.workspaceSlug, input.channelId, input.agentId, input.consentId, input.approvalChannel, input.canonical, input.digest, at, at, at);
    return this.getGrant(input.workspaceSlug, input.id)!;
  }

  getGrant(workspaceSlug: string, id: string): LiveGrantRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_live_grant WHERE workspace_slug = ? AND id = ?").get(workspaceSlug, id) as Row | undefined;
    return row ? grantFromRow(row) : null;
  }

  listGrants(workspaceSlug: string, filter: { channelId?: string; agentId?: string; status?: LiveGrantStatus[] } = {}): LiveGrantRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_live_grant WHERE workspace_slug = ? AND (? IS NULL OR channel_id = ?) AND (? IS NULL OR agent_id = ?)
         ORDER BY created_at DESC LIMIT 500`,
      )
      .all(workspaceSlug, filter.channelId ?? null, filter.channelId ?? null, filter.agentId ?? null, filter.agentId ?? null) as Row[];
    const grants = rows.map(grantFromRow);
    return filter.status ? grants.filter((grant) => filter.status!.includes(grant.status)) : grants;
  }

  /** Other grants of the workspace (any agent) whose digest starts with `prefix`, other than `exceptId`. */
  digestPrefixMatches(workspaceSlug: string, prefix: string, exceptId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM channel_live_grant WHERE workspace_slug = ? AND id <> ? AND substr(digest, 1, ?) = ? AND status IN ('proposed', 'active', 'paused')")
      .get(workspaceSlug, exceptId, prefix.length, prefix) as { n: number };
    return Number(row.n);
  }

  /**
   * Guarded update: applies `patch` only when the row is still at `expect.revision` (and, when given, in one of
   * `expect.status`). Returns the new row, or null when someone else changed it first (single-shot transitions).
   */
  updateGrant(
    workspaceSlug: string,
    id: string,
    expect: { revision: number; status?: LiveGrantStatus[] },
    patch: Partial<{
      canonical: string;
      digest: string;
      status: LiveGrantStatus;
      approvedAt: string | null;
      approvedBy: string | null;
      approvalSource: LiveApprovalSource | null;
      approvalRef: string | null;
      approvedDigest: string | null;
      approvalExpiresAt: string | null;
      decidedReason: string | null;
      /** The monotonic state time to record (ms); default `now`. The stored value never goes back. */
      stateChangedAt: number;
    }>,
    now: Date,
  ): LiveGrantRecord | null {
    const columns: Record<string, string> = {
      canonical: "canonical",
      digest: "digest",
      status: "status",
      approvedAt: "approved_at",
      approvedBy: "approved_by",
      approvalSource: "approval_source",
      approvalRef: "approval_ref",
      approvedDigest: "approved_digest",
      approvalExpiresAt: "approval_expires_at",
      decidedReason: "decided_reason",
    };
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === "stateChangedAt") continue;
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as string | null);
    }
    sets.push("revision = revision + 1", "updated_at = ?", "state_changed_at = MAX(state_changed_at, ?)");
    values.push(iso(now), patch.stateChangedAt ?? now.getTime());
    const statusClause = expect.status && expect.status.length > 0 ? ` AND status IN (${expect.status.map(() => "?").join(", ")})` : "";
    const result = this.db
      .prepare(`UPDATE channel_live_grant SET ${sets.join(", ")} WHERE workspace_slug = ? AND id = ? AND revision = ?${statusClause}`)
      .run(...values, workspaceSlug, id, expect.revision, ...(expect.status ?? []));
    return Number(result.changes) === 1 ? this.getGrant(workspaceSlug, id) : null;
  }

  addProviderSeconds(workspaceSlug: string, grantId: string, seconds: number): void {
    if (!(seconds > 0)) return;
    this.db.prepare("UPDATE channel_live_grant SET provider_seconds = provider_seconds + ? WHERE workspace_slug = ? AND id = ?").run(seconds, workspaceSlug, grantId);
  }

  // ----- sessions -----------------------------------------------------------------

  /** Inserts a `joining` session unless the grant already has a live one (one session per grant). */
  startSession(input: {
    workspaceSlug: string;
    grantId: string;
    grantDigest: string;
    channelId: string;
    agentId: string;
    huddleId: string;
    modes: LiveModes;
    instanceId: string;
    now: Date;
  }): { ok: true; session: LiveSessionRecord } | { ok: false; error: "live_session_active" } {
    const at = iso(input.now);
    return this.immediate(() => {
      const live = this.db
        .prepare("SELECT 1 FROM channel_live_session WHERE workspace_slug = ? AND grant_id = ? AND status IN ('joining', 'joined')")
        .get(input.workspaceSlug, input.grantId);
      if (live) return { ok: false as const, error: "live_session_active" as const };
      const id = `lvs_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO channel_live_session (id, workspace_slug, grant_id, grant_digest, channel_id, agent_id, huddle_id, modes_json, status,
            instance_id, started_at, heartbeat_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'joining', ?, ?, ?, ?)`,
        )
        .run(id, input.workspaceSlug, input.grantId, input.grantDigest, input.channelId, input.agentId, input.huddleId, JSON.stringify(input.modes), input.instanceId, at, at, at);
      return { ok: true as const, session: this.getSession(input.workspaceSlug, id)! };
    });
  }

  getSession(workspaceSlug: string, id: string): LiveSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_live_session WHERE workspace_slug = ? AND id = ?").get(workspaceSlug, id) as Row | undefined;
    return row ? sessionFromRow(row) : null;
  }

  listSessions(workspaceSlug: string, filter: { grantId?: string; agentId?: string; live?: boolean; limit?: number } = {}): LiveSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_live_session WHERE workspace_slug = ? AND (? IS NULL OR grant_id = ?) AND (? IS NULL OR agent_id = ?)
          AND (? = 0 OR status IN ('joining', 'joined')) ORDER BY started_at DESC LIMIT ?`,
      )
      .all(
        workspaceSlug,
        filter.grantId ?? null,
        filter.grantId ?? null,
        filter.agentId ?? null,
        filter.agentId ?? null,
        filter.live ? 1 : 0,
        Math.max(1, Math.min(filter.limit ?? 100, 500)),
      ) as Row[];
    return rows.map(sessionFromRow);
  }

  /** Sessions of a grant that overlap [since, ∞): for the rolling day-minutes cap. */
  sessionsSince(workspaceSlug: string, grantId: string, since: Date): LiveSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM channel_live_session WHERE workspace_slug = ? AND grant_id = ? AND (left_at IS NULL OR left_at >= ?)")
      .all(workspaceSlug, grantId, iso(since)) as Row[];
    return rows.map(sessionFromRow);
  }

  /** Joins started in [since, ∞) (any outcome): for the grant's `caps`. */
  joinsSince(workspaceSlug: string, grantId: string, since: Date): LiveSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM channel_live_session WHERE workspace_slug = ? AND grant_id = ? AND started_at >= ? ORDER BY started_at DESC")
      .all(workspaceSlug, grantId, iso(since)) as Row[];
    return rows.map(sessionFromRow);
  }

  markJoined(workspaceSlug: string, id: string, now: Date): void {
    const at = iso(now);
    this.db.prepare("UPDATE channel_live_session SET status = 'joined', joined_at = ?, heartbeat_at = ?, updated_at = ? WHERE workspace_slug = ? AND id = ? AND status = 'joining'").run(at, at, at, workspaceSlug, id);
  }

  setDisclosure(workspaceSlug: string, id: string, eventId: string | null): void {
    this.db.prepare("UPDATE channel_live_session SET disclosure_event_id = ? WHERE workspace_slug = ? AND id = ?").run(eventId, workspaceSlug, id);
  }

  heartbeat(workspaceSlug: string, id: string, usage: { listenedSeconds: number; spokenSeconds: number; providerSeconds: number }, now: Date): void {
    const at = iso(now);
    this.db
      .prepare(
        `UPDATE channel_live_session SET listened_seconds = ?, spoken_seconds = ?, provider_seconds = ?, heartbeat_at = ?, updated_at = ?
         WHERE workspace_slug = ? AND id = ? AND status IN ('joining', 'joined')`,
      )
      .run(usage.listenedSeconds, usage.spokenSeconds, usage.providerSeconds, at, at, workspaceSlug, id);
  }

  /** Ends a session once (first reason wins). Returns the ended row, or null when it had already ended. */
  endSession(
    workspaceSlug: string,
    id: string,
    input: { status: "left" | "failed"; reason: string; usage?: { listenedSeconds: number; spokenSeconds: number; providerSeconds: number }; now: Date },
  ): LiveSessionRecord | null {
    const at = iso(input.now);
    const usage = input.usage;
    const result = this.db
      .prepare(
        `UPDATE channel_live_session SET status = ?, left_at = ?, end_reason = ?, updated_at = ?,
          listened_seconds = COALESCE(?, listened_seconds), spoken_seconds = COALESCE(?, spoken_seconds), provider_seconds = COALESCE(?, provider_seconds)
         WHERE workspace_slug = ? AND id = ? AND status IN ('joining', 'joined')`,
      )
      .run(input.status, at, input.reason, at, usage?.listenedSeconds ?? null, usage?.spokenSeconds ?? null, usage?.providerSeconds ?? null, workspaceSlug, id);
    return Number(result.changes) === 1 ? this.getSession(workspaceSlug, id) : null;
  }

  // ----- transcript (receipt) -------------------------------------------------------

  addTranscript(input: {
    workspaceSlug: string;
    sessionId: string;
    grantId: string;
    agentId: string;
    kind: LiveTranscriptKind;
    speakerPubkey: string | null;
    text: string;
    textSha256: string;
    clipSha256?: string | null;
    flaggedTerms: string[];
    startedAt: Date;
    endedAt: Date;
    now: Date;
  }): LiveTranscriptRecord {
    const id = `lvt_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO channel_live_transcript (id, workspace_slug, session_id, grant_id, agent_id, kind, speaker_pubkey, text, text_sha256, clip_sha256,
          flagged_terms_json, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.sessionId,
        input.grantId,
        input.agentId,
        input.kind,
        input.speakerPubkey,
        input.text,
        input.textSha256,
        input.clipSha256 ?? null,
        JSON.stringify(input.flaggedTerms),
        iso(input.startedAt),
        iso(input.endedAt),
        iso(input.now),
      );
    const row = this.db.prepare("SELECT * FROM channel_live_transcript WHERE id = ?").get(id) as Row;
    return transcriptFromRow(row);
  }

  listTranscript(workspaceSlug: string, sessionId: string, limit = 500): LiveTranscriptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM channel_live_transcript WHERE workspace_slug = ? AND session_id = ? ORDER BY started_at ASC, created_at ASC LIMIT ?")
      .all(workspaceSlug, sessionId, Math.max(1, Math.min(limit, 5000))) as Row[];
    return rows.map(transcriptFromRow);
  }

  /** Retention: transcript text older than `before` is emptied AND its SHA-256 dropped (L4: a hash of a short line is a guessing oracle); only metadata and the clip SHA-256 stay. */
  purgeTranscripts(workspaceSlug: string, before: Date, now: Date, limit = 1000): number {
    const result = this.db
      .prepare(
        `UPDATE channel_live_transcript SET text = '', text_sha256 = NULL, purged_at = ? WHERE id IN (
          SELECT id FROM channel_live_transcript WHERE workspace_slug = ? AND purged_at IS NULL AND created_at < ? LIMIT ?)`,
      )
      .run(iso(now), workspaceSlug, iso(before), Math.max(1, limit));
    return Number(result.changes);
  }

  // ----- owner control ------------------------------------------------------------

  getControl(workspaceSlug: string): LiveControl {
    const row = this.db.prepare("SELECT * FROM channel_live_control WHERE workspace_slug = ?").get(workspaceSlug) as Row | undefined;
    if (!row) return { paused: false, pausedAt: null, pausedBy: null, commandChannel: null, changedAt: 0, updatedAt: null };
    return {
      paused: Number(row.paused) === 1,
      pausedAt: text(row.paused_at),
      pausedBy: text(row.paused_by),
      commandChannel: text(row.command_channel),
      changedAt: Number(row.changed_at ?? 0),
      updatedAt: text(row.updated_at),
    };
  }

  /** Sets the global switch; `changedAtMs` (default now) only ever moves the monotonic change time forward. */
  setPaused(workspaceSlug: string, paused: boolean, actor: string, now: Date, changedAtMs: number = now.getTime()): LiveControl {
    const at = iso(now);
    this.db
      .prepare(
        `INSERT INTO channel_live_control (workspace_slug, paused, paused_at, paused_by, changed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug) DO UPDATE SET paused = excluded.paused, paused_at = excluded.paused_at, paused_by = excluded.paused_by,
           changed_at = MAX(channel_live_control.changed_at, excluded.changed_at), updated_at = excluded.updated_at`,
      )
      .run(workspaceSlug, paused ? 1 : 0, paused ? at : null, paused ? actor : null, changedAtMs, at);
    return this.getControl(workspaceSlug);
  }

  /** Single use of an approved clip: true only for the first claim of this approval. */
  claimClipUse(workspaceSlug: string, approvalId: string, sessionId: string, now: Date): boolean {
    const result = this.db
      .prepare("INSERT INTO channel_live_clip_use (approval_id, workspace_slug, session_id, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(approval_id) DO NOTHING")
      .run(approvalId, workspaceSlug, sessionId, iso(now));
    return Number(result.changes) === 1;
  }

  recordClipPlay(input: { workspaceSlug: string; approvalId: string; ownerSessionRef: string; clipDigest: string; clipSha256: string; bytes: number; now: Date }): void {
    this.db
      .prepare(
        `INSERT INTO channel_live_clip_play (id, workspace_slug, approval_id, owner_session_ref, clip_digest, clip_sha256, bytes, served_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`lvp_${randomUUID()}`, input.workspaceSlug, input.approvalId, input.ownerSessionRef, input.clipDigest, input.clipSha256, input.bytes, iso(input.now));
  }

  /** Was this hold's exact clip served to this owner session in [notBefore, notAfter]? */
  clipPlayedTo(input: { workspaceSlug: string; approvalId: string; ownerSessionRef: string; clipDigest: string; clipSha256: string; bytes: number; notBefore: Date; notAfter: Date }): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM channel_live_clip_play WHERE workspace_slug = ? AND approval_id = ? AND owner_session_ref = ? AND clip_digest = ?
            AND clip_sha256 = ? AND bytes = ? AND served_at >= ? AND served_at <= ? LIMIT 1`,
        )
        .get(input.workspaceSlug, input.approvalId, input.ownerSessionRef, input.clipDigest, input.clipSha256, input.bytes, iso(input.notBefore), iso(input.notAfter)),
    );
  }

  /** Retention: play records older than `before` (holds live at most 24 h, so these can approve nothing). */
  purgeClipPlays(workspaceSlug: string, before: Date): number {
    const result = this.db.prepare("DELETE FROM channel_live_clip_play WHERE workspace_slug = ? AND served_at < ?").run(workspaceSlug, iso(before));
    return Number(result.changes);
  }

  clipUsed(approvalId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM channel_live_clip_use WHERE approval_id = ?").get(approvalId));
  }

  setCommandChannel(workspaceSlug: string, channel: string | null, actor: string, now: Date): LiveControl {
    const at = iso(now);
    this.db
      .prepare(
        `INSERT INTO channel_live_control (workspace_slug, paused, command_channel, command_channel_set_by, updated_at) VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(workspace_slug) DO UPDATE SET command_channel = excluded.command_channel, command_channel_set_by = excluded.command_channel_set_by, updated_at = excluded.updated_at`,
      )
      .run(workspaceSlug, channel, actor, at);
    return this.getControl(workspaceSlug);
  }
}

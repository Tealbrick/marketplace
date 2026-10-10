import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Channels P2 routes v2 state (reactions, edits, deletes, direct messages, polls, mentions, markup). Additive only:
 * every table is `CREATE TABLE IF NOT EXISTS`, so an older Marketplace ignores them.
 *
 * - `channel_post_op`: what a post row does besides plain text and files (the action, the person, mentions, markup,
 *   poll), keyed like the post itself (agent + internal idempotency key), so a held post is rebuilt with the same
 *   payload at send time and its digest still matches.
 * - `channel_sent_message`: the message ids Marketplace itself posted to one channel destination (review R3). An edit,
 *   delete or reaction is allowed only on such an id, and only while its receipt is kept. Written when the provider
 *   call returns, before the receipt (review R8).
 * - `channel_people_policy`: the owner's people policy per connection (review R5): `none` (default), `allowlist`, or
 *   `workspace`.
 * - `channel_agent_person`: people ONE agent found on a connection, by an opaque reference keyed by (connection, agent,
 *   platform user id): another agent finding the same person gets its own reference and its own first-contact hold
 *   (review of PR #51). `approvedAt` is set when the owner approved this agent's first message to that person (and it
 *   was sent); the owner can revoke it per (agent, person).
 * - `channel_person_lookup`: one row per find, for the per-agent lookup cap.
 */

export const ACTIONS_TABLES = ["channel_post_op", "channel_sent_message", "channel_people_policy", "channel_agent_person", "channel_person_lookup"] as const;

const ACTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS channel_post_op (
    workspace_slug TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    op TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, agent_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS channel_sent_message (
    workspace_slug TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    destination_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    removed_at TEXT,
    PRIMARY KEY (workspace_slug, channel_id, destination_key, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_channel_sent_message_post ON channel_sent_message(workspace_slug, post_id);

  CREATE TABLE IF NOT EXISTS channel_people_policy (
    workspace_slug TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    allow_json TEXT NOT NULL DEFAULT '{}',
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, connection_id)
  );

  CREATE TABLE IF NOT EXISTS channel_agent_person (
    id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    lookup_kind TEXT NOT NULL,
    lookup_value TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT,
    approved_post_id TEXT,
    revoked_at TEXT,
    revoked_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_slug, connection_id, agent_id, platform_user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_person_lookup (
    id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_person_lookup_scope ON channel_person_lookup(workspace_slug, agent_id, created_at);
`;

export function migrateActionsTables(db: DatabaseSync): void {
  db.exec(ACTIONS_DDL);
}

type Row = Record<string, unknown>;

/** The routes v2 part of a post (stored as JSON; the post row keeps the text, files and campaign). */
export type PostOpSpec = {
  action?:
    | { op: "react"; targetMessageId: string; emoji: string; remove?: boolean }
    | { op: "edit"; targetMessageId: string }
    | { op: "delete"; targetMessageId: string }
    | { op: "dm"; personRef: string };
  mentions?: Array<{ userId: string; name?: string }>;
  markup?: string;
  poll?: { question: string; options: string[]; allowsMultiple?: boolean; durationHours?: number };
};

export type PeoplePolicyMode = "none" | "allowlist" | "workspace";

export type PeoplePolicy = {
  connectionId: string;
  mode: PeoplePolicyMode;
  /** Allowlist entries: exact emails or handles (lowercase), and email domains (`example.com`). */
  people: string[];
  domains: string[];
  updatedBy: string | null;
  updatedAt: string | null;
};

export type PersonRecord = {
  personRef: string;
  workspaceSlug: string;
  connectionId: string;
  /** The agent that found this person: the reference and its approval belong to that agent only. */
  agentId: string;
  provider: string;
  platformUserId: string;
  displayName: string;
  lookupKind: "email" | "handle";
  lookupValue: string;
  approvedAt: string | null;
  approvedBy: string | null;
  approvedPostId: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SentMessageRecord = {
  postId: string;
  /** The agent whose post created the message (`owner:<id>` for the owner test). */
  agentId: string;
  messageId: string;
  sentAt: string;
  removedAt: string | null;
  /** The receipt text of the post that created the message (owner views only). */
  text: string | null;
};

const canonicalSpec = (spec: PostOpSpec) => JSON.stringify(sortDeep(spec));
const sameSpec = (a: PostOpSpec, b: PostOpSpec) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortDeep(entry)]),
    );
  }
  return value;
}

function personFromRow(row: Row): PersonRecord {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    personRef: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    connectionId: String(row.connection_id),
    agentId: String(row.agent_id),
    provider: String(row.provider),
    platformUserId: String(row.platform_user_id),
    displayName: String(row.display_name),
    lookupKind: String(row.lookup_kind) === "email" ? "email" : "handle",
    lookupValue: String(row.lookup_value),
    approvedAt: text(row.approved_at),
    approvedBy: text(row.approved_by),
    approvedPostId: text(row.approved_post_id),
    revokedAt: text(row.revoked_at),
    revokedBy: text(row.revoked_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class ActionsStore {
  constructor(private readonly db: DatabaseSync) {}

  // ----- post ops -------------------------------------------------------------

  /**
   * Records (or confirms) the routes v2 part of one post, keyed like the post. Once a post row exists for the key, a
   * different spec is a conflict (the post's digest is bound to the stored spec). A key that already belongs to a post
   * stored without a spec (an older post) counts as the empty spec, so nothing is written that would change that post's
   * rebuilt payload. While no post exists for the key (the earlier call was refused before anything was held or sent),
   * a corrected retry replaces the spec.
   */
  putPostOp(input: { workspaceSlug: string; agentId: string; idempotencyKey: string; spec: PostOpSpec; existingPost: boolean; now: Date }): "created" | "same" | "conflict" {
    const existing = this.getPostOp(input.workspaceSlug, input.agentId, input.idempotencyKey);
    if (existing) {
      if (sameSpec(existing, input.spec)) return "same";
      if (input.existingPost) return "conflict";
      this.db
        .prepare("UPDATE channel_post_op SET op = ?, spec_json = ?, created_at = ? WHERE workspace_slug = ? AND agent_id = ? AND idempotency_key = ?")
        .run(input.spec.action?.op ?? (input.spec.poll ? "poll" : "post"), canonicalSpec(input.spec), input.now.toISOString(), input.workspaceSlug, input.agentId, input.idempotencyKey);
      return "created";
    }
    if (input.existingPost) return sameSpec({}, input.spec) ? "same" : "conflict";
    this.db
      .prepare("INSERT OR IGNORE INTO channel_post_op (workspace_slug, agent_id, idempotency_key, op, spec_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.workspaceSlug, input.agentId, input.idempotencyKey, input.spec.action?.op ?? (input.spec.poll ? "poll" : "post"), canonicalSpec(input.spec), input.now.toISOString());
    const stored = this.getPostOp(input.workspaceSlug, input.agentId, input.idempotencyKey);
    return stored && sameSpec(stored, input.spec) ? "created" : "conflict";
  }

  getPostOp(workspaceSlug: string, agentId: string, idempotencyKey: string): PostOpSpec | null {
    const row = this.db
      .prepare("SELECT spec_json FROM channel_post_op WHERE workspace_slug = ? AND agent_id = ? AND idempotency_key = ?")
      .get(workspaceSlug, agentId, idempotencyKey) as Row | undefined;
    if (!row) return null;
    try {
      return JSON.parse(String(row.spec_json)) as PostOpSpec;
    } catch {
      return null;
    }
  }

  // ----- sent messages (R3, R8) ---------------------------------------------------

  recordSentMessages(input: { workspaceSlug: string; channelId: string; destinationKey: string; postId: string; messageIds: readonly string[]; now: Date }): void {
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO channel_sent_message (workspace_slug, channel_id, destination_key, message_id, post_id, sent_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const messageId of input.messageIds) {
      if (typeof messageId === "string" && messageId.length > 0 && messageId.length <= 256) {
        statement.run(input.workspaceSlug, input.channelId, input.destinationKey, messageId, input.postId, input.now.toISOString());
      }
    }
  }

  /**
   * A message Marketplace posted to this channel destination (review R3): a sent-message row for exactly this
   * (channel, destination, id) whose post still has a kept receipt (`sent` or `uncertain`) on this channel listing
   * the id in its result ids. Anything else (another channel, another destination, someone else's message, a purged
   * receipt) is null.
   */
  ownMessage(input: { workspaceSlug: string; channelId: string; destinationKey: string; messageId: string }): SentMessageRecord | null {
    const row = this.db
      .prepare(
        `SELECT m.post_id, m.message_id, m.sent_at, m.removed_at, r.text, r.sent_at AS receipt_sent_at, r.agent_id
         FROM channel_sent_message m
         JOIN channel_receipt r ON r.post_id = m.post_id AND r.workspace_slug = m.workspace_slug AND r.channel_id = m.channel_id
         WHERE m.workspace_slug = ? AND m.channel_id = ? AND m.destination_key = ? AND m.message_id = ?
           AND r.status IN ('sent', 'uncertain')
           AND EXISTS (SELECT 1 FROM json_each(r.result_ids_json) WHERE json_each.value = m.message_id)`,
      )
      .get(input.workspaceSlug, input.channelId, input.destinationKey, input.messageId) as Row | undefined;
    if (!row) return null;
    return {
      postId: String(row.post_id),
      agentId: String(row.agent_id),
      messageId: String(row.message_id),
      sentAt: String(row.receipt_sent_at ?? row.sent_at),
      removedAt: row.removed_at === null || row.removed_at === undefined ? null : String(row.removed_at),
      text: row.text === null || row.text === undefined ? null : String(row.text),
    };
  }

  markMessageRemoved(input: { workspaceSlug: string; channelId: string; destinationKey: string; messageId: string; now: Date }): void {
    this.db
      .prepare(
        `UPDATE channel_sent_message SET removed_at = ? WHERE workspace_slug = ? AND channel_id = ? AND destination_key = ? AND message_id = ? AND removed_at IS NULL`,
      )
      .run(input.now.toISOString(), input.workspaceSlug, input.channelId, input.destinationKey, input.messageId);
  }

  /** Message ids Marketplace posted to a destination since `since` (self-loop checks on inbound). */
  recentSentMessageIds(workspaceSlug: string, destinationKeys: readonly string[], since: Date): Set<string> {
    const ids = new Set<string>();
    const statement = this.db.prepare(
      `SELECT message_id FROM channel_sent_message WHERE workspace_slug = ? AND destination_key = ? AND sent_at >= ? ORDER BY sent_at DESC LIMIT 500`,
    );
    for (const key of destinationKeys) {
      for (const row of statement.all(workspaceSlug, key, since.toISOString()) as Row[]) ids.add(String(row.message_id));
    }
    return ids;
  }

  // ----- people policy (R5) ---------------------------------------------------------

  getPeoplePolicy(workspaceSlug: string, connectionId: string): PeoplePolicy {
    const row = this.db.prepare("SELECT * FROM channel_people_policy WHERE workspace_slug = ? AND connection_id = ?").get(workspaceSlug, connectionId) as
      | Row
      | undefined;
    if (!row) return { connectionId, mode: "none", people: [], domains: [], updatedBy: null, updatedAt: null };
    let allow: { people?: unknown; domains?: unknown } = {};
    try {
      allow = JSON.parse(String(row.allow_json)) as typeof allow;
    } catch {
      allow = {};
    }
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
    const mode = String(row.mode);
    return {
      connectionId,
      mode: mode === "allowlist" || mode === "workspace" ? mode : "none",
      people: strings(allow.people),
      domains: strings(allow.domains),
      updatedBy: String(row.updated_by),
      updatedAt: String(row.updated_at),
    };
  }

  setPeoplePolicy(input: { workspaceSlug: string; connectionId: string; mode: PeoplePolicyMode; people: string[]; domains: string[]; actor: string; now: Date }): PeoplePolicy {
    this.db
      .prepare(
        `INSERT INTO channel_people_policy (workspace_slug, connection_id, mode, allow_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug, connection_id) DO UPDATE SET mode = excluded.mode, allow_json = excluded.allow_json,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(input.workspaceSlug, input.connectionId, input.mode, JSON.stringify({ people: input.people, domains: input.domains }), input.actor, input.now.toISOString());
    return this.getPeoplePolicy(input.workspaceSlug, input.connectionId);
  }

  // ----- people (R5) -------------------------------------------------------------------

  /** Creates or refreshes the person one agent found on a connection. The reference stays the same for that agent and user. */
  upsertPerson(input: {
    workspaceSlug: string;
    connectionId: string;
    agentId: string;
    provider: string;
    platformUserId: string;
    displayName: string;
    lookupKind: "email" | "handle";
    lookupValue: string;
    now: Date;
  }): PersonRecord {
    const at = input.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_agent_person (id, workspace_slug, connection_id, agent_id, provider, platform_user_id, display_name, lookup_kind, lookup_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug, connection_id, agent_id, platform_user_id) DO UPDATE SET display_name = excluded.display_name,
           lookup_kind = excluded.lookup_kind, lookup_value = excluded.lookup_value, updated_at = excluded.updated_at`,
      )
      .run(`prs_${randomUUID()}`, input.workspaceSlug, input.connectionId, input.agentId, input.provider, input.platformUserId, input.displayName, input.lookupKind, input.lookupValue, at, at);
    return personFromRow(
      this.db
        .prepare("SELECT * FROM channel_agent_person WHERE workspace_slug = ? AND connection_id = ? AND agent_id = ? AND platform_user_id = ?")
        .get(input.workspaceSlug, input.connectionId, input.agentId, input.platformUserId) as Row,
    );
  }

  getPerson(workspaceSlug: string, personRef: string): PersonRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_agent_person WHERE workspace_slug = ? AND id = ?").get(workspaceSlug, personRef) as Row | undefined;
    return row ? personFromRow(row) : null;
  }

  listPeople(workspaceSlug: string, connectionId: string, limit = 500): PersonRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM channel_agent_person WHERE workspace_slug = ? AND connection_id = ? ORDER BY updated_at DESC, agent_id, id LIMIT ?")
        .all(workspaceSlug, connectionId, Math.min(Math.max(limit, 1), 1000)) as Row[]
    ).map(personFromRow);
  }

  /** The owner approved (and Marketplace sent) the first message to this person. Idempotent. */
  approvePerson(input: { workspaceSlug: string; personRef: string; approvedBy: string; postId: string; now: Date }): PersonRecord | null {
    const at = input.now.toISOString();
    this.db
      .prepare(
        `UPDATE channel_agent_person SET approved_at = ?, approved_by = ?, approved_post_id = ?, revoked_at = NULL, revoked_by = NULL, updated_at = ?
         WHERE workspace_slug = ? AND id = ? AND approved_at IS NULL`,
      )
      .run(at, input.approvedBy, input.postId, at, input.workspaceSlug, input.personRef);
    return this.getPerson(input.workspaceSlug, input.personRef);
  }

  /** The owner revokes an approved person: the next message needs the owner's approval again. */
  revokePerson(input: { workspaceSlug: string; personRef: string; actor: string; now: Date }): PersonRecord | null {
    const at = input.now.toISOString();
    this.db
      .prepare(
        `UPDATE channel_agent_person SET approved_at = NULL, approved_by = NULL, approved_post_id = NULL, revoked_at = ?, revoked_by = ?, updated_at = ?
         WHERE workspace_slug = ? AND id = ?`,
      )
      .run(at, input.actor, at, input.workspaceSlug, input.personRef);
    return this.getPerson(input.workspaceSlug, input.personRef);
  }

  // ----- lookups ---------------------------------------------------------------------------

  recordLookup(input: { workspaceSlug: string; agentId: string; connectionId: string; outcome: string; now: Date }): string {
    const id = `lkp_${randomUUID()}`;
    this.db
      .prepare("INSERT INTO channel_person_lookup (id, workspace_slug, agent_id, connection_id, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, input.workspaceSlug, input.agentId, input.connectionId, input.outcome, input.now.toISOString());
    return id;
  }

  /**
   * Counts and records one lookup in a single synchronous step (review of PR #51): the cap is checked and the slot
   * taken before the platform is asked, so concurrent finds cannot exceed it. Returns the lookup id, or null when capped.
   */
  reserveLookup(input: { workspaceSlug: string; agentId: string; connectionId: string; limit: number; since: Date; now: Date }): string | null {
    if (this.countLookups(input.workspaceSlug, input.agentId, input.since) >= input.limit) return null;
    return this.recordLookup({ ...input, outcome: "pending" });
  }

  finishLookup(workspaceSlug: string, id: string, outcome: string): void {
    this.db.prepare("UPDATE channel_person_lookup SET outcome = ? WHERE workspace_slug = ? AND id = ?").run(outcome, workspaceSlug, id);
  }

  /** Sent-message rows whose receipt is gone (purged) or older than `before` (review of PR #51: never kept forever). */
  purgeSentMessages(workspaceSlug: string, before: Date, limit = 1000): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM channel_sent_message WHERE rowid IN (
             SELECT m.rowid FROM channel_sent_message m
             WHERE m.workspace_slug = ? AND (m.sent_at < ? OR NOT EXISTS (
               SELECT 1 FROM channel_receipt r WHERE r.workspace_slug = m.workspace_slug AND r.post_id = m.post_id))
             LIMIT ?)`,
        )
        .run(workspaceSlug, before.toISOString(), limit).changes,
    );
  }

  countLookups(workspaceSlug: string, agentId: string, since: Date): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM channel_person_lookup WHERE workspace_slug = ? AND agent_id = ? AND created_at > ?")
      .get(workspaceSlug, agentId, since.toISOString()) as { count: number };
    return Number(row.count);
  }

  purgeLookups(workspaceSlug: string, before: Date): number {
    return Number(this.db.prepare("DELETE FROM channel_person_lookup WHERE workspace_slug = ? AND created_at < ?").run(workspaceSlug, before.toISOString()).changes);
  }
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Buzz state (Channels P2). Additive tables only (`CREATE TABLE IF NOT EXISTS`); nothing existing is altered.
 *
 * - `channel_buzz_identity`: the connection's public identity and the owner's settings: the agent PUBLIC key,
 *   the owner-entered relay URL and the owner's NIP-OA tag with its SHA-256, owner key, conditions and end date.
 *   The agent SECRET key is never here: it lives only in the encrypted `connector_secret` store.
 * - `channel_buzz_route`: per inbound route (Marketplace channel), the routed agent's Buzz key the owner entered,
 *   the relay URL confirmed with it, and the private bridge channel created on the first bridged message.
 * - `channel_buzz_retired_group`: bridge channels Marketplace stopped using (key rotation, relay change, agent
 *   re-bind), recorded so they stay delivery-only (never an inbound source) and auditable.
 * - `channel_buzz_bridged`: one row per bridged message (Marketplace's own kind-9 event), so the retention
 *   purge can delete it (kind 5) after the inbound text retention and mark the row.
 */

export const BUZZ_TABLES = ["channel_buzz_identity", "channel_buzz_route", "channel_buzz_bridged", "channel_buzz_retired_group"] as const;

export const BUZZ_DDL = `
  CREATE TABLE IF NOT EXISTS channel_buzz_identity (
    workspace_slug TEXT PRIMARY KEY,
    agent_pubkey TEXT,
    key_created_at TEXT,
    relay_url TEXT,
    auth_tag_json TEXT,
    auth_tag_sha256 TEXT,
    auth_owner_pubkey TEXT,
    auth_conditions TEXT,
    auth_expires_at INTEGER,
    auth_set_at TEXT,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_buzz_route (
    workspace_slug TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    agent_pubkey TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    group_id TEXT,
    member_added INTEGER NOT NULL DEFAULT 0,
    group_created_at TEXT,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, channel_id)
  );

  CREATE TABLE IF NOT EXISTS channel_buzz_bridged (
    workspace_slug TEXT NOT NULL,
    inbound_event_id TEXT NOT NULL,
    route_channel_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    buzz_event_id TEXT NOT NULL,
    bridged_at TEXT NOT NULL,
    deleted_at TEXT,
    delete_status TEXT,
    PRIMARY KEY (workspace_slug, inbound_event_id)
  );

  CREATE TABLE IF NOT EXISTS channel_buzz_retired_group (
    workspace_slug TEXT NOT NULL,
    group_id TEXT NOT NULL,
    relay_url TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    agent_pubkey TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    cleanup_status TEXT,
    retired_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, group_id)
  );

  CREATE INDEX IF NOT EXISTS idx_channel_buzz_bridged_due
  ON channel_buzz_bridged(workspace_slug, deleted_at, bridged_at);
`;

/** Creates the Buzz tables; adds `channel_buzz_route.agent_id` to a data directory from an earlier P2 build. */
export function migrateBuzzTables(db: DatabaseSync): void {
  db.exec(BUZZ_DDL);
  const columns = (db.prepare("PRAGMA table_info(channel_buzz_route)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("agent_id")) db.exec("ALTER TABLE channel_buzz_route ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
  const retired = (db.prepare("PRAGMA table_info(channel_buzz_retired_group)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!retired.includes("agent_pubkey")) db.exec("ALTER TABLE channel_buzz_retired_group ADD COLUMN agent_pubkey TEXT NOT NULL DEFAULT ''");
  if (!retired.includes("cleanup_status")) db.exec("ALTER TABLE channel_buzz_retired_group ADD COLUMN cleanup_status TEXT");
}

export type BuzzIdentityRecord = {
  agentPubkey: string | null;
  keyCreatedAt: string | null;
  relayUrl: string | null;
  authTagJson: string | null;
  authTagSha256: string | null;
  authOwnerPubkey: string | null;
  authConditions: string | null;
  authExpiresAt: number | null;
  authSetAt: string | null;
  updatedBy: string;
  updatedAt: string;
};

export type BuzzRouteRecord = {
  channelId: string;
  /** The Marketplace agent the owner confirmed this binding for (a re-bind removes the binding). */
  agentId: string;
  agentPubkey: string;
  relayUrl: string;
  groupId: string | null;
  memberAdded: boolean;
  groupCreatedAt: string | null;
  updatedAt: string;
};

export type RetiredGroupRecord = {
  groupId: string;
  relayUrl: string;
  channelId: string;
  agentPubkey: string;
  reason: string;
  cleanupStatus: string | null;
  retiredAt: string;
};

export type BuzzBridgedRecord = {
  inboundEventId: string;
  routeChannelId: string;
  groupId: string;
  relayUrl: string;
  buzzEventId: string;
  bridgedAt: string;
  deletedAt: string | null;
  deleteStatus: string | null;
};

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function identityFromRow(row: Row): BuzzIdentityRecord {
  return {
    agentPubkey: str(row.agent_pubkey),
    keyCreatedAt: str(row.key_created_at),
    relayUrl: str(row.relay_url),
    authTagJson: str(row.auth_tag_json),
    authTagSha256: str(row.auth_tag_sha256),
    authOwnerPubkey: str(row.auth_owner_pubkey),
    authConditions: str(row.auth_conditions),
    authExpiresAt: row.auth_expires_at === null || row.auth_expires_at === undefined ? null : Number(row.auth_expires_at),
    authSetAt: str(row.auth_set_at),
    updatedBy: String(row.updated_by),
    updatedAt: String(row.updated_at),
  };
}

function routeFromRow(row: Row): BuzzRouteRecord {
  return {
    channelId: String(row.channel_id),
    agentId: String(row.agent_id ?? ""),
    agentPubkey: String(row.agent_pubkey),
    relayUrl: String(row.relay_url),
    groupId: str(row.group_id),
    memberAdded: Number(row.member_added) === 1,
    groupCreatedAt: str(row.group_created_at),
    updatedAt: String(row.updated_at),
  };
}

function bridgedFromRow(row: Row): BuzzBridgedRecord {
  return {
    inboundEventId: String(row.inbound_event_id),
    routeChannelId: String(row.route_channel_id),
    groupId: String(row.group_id),
    relayUrl: String(row.relay_url),
    buzzEventId: String(row.buzz_event_id),
    bridgedAt: String(row.bridged_at),
    deletedAt: str(row.deleted_at),
    deleteStatus: str(row.delete_status),
  };
}

export class BuzzStore {
  constructor(private readonly db: DatabaseSync) {}

  // ----- identity -------------------------------------------------------------

  getIdentity(workspaceSlug: string): BuzzIdentityRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_buzz_identity WHERE workspace_slug = ?").get(workspaceSlug) as Row | undefined;
    return row ? identityFromRow(row) : null;
  }

  private upsert(workspaceSlug: string, fields: Partial<Record<string, string | number | null>>, actor: string, now: Date): BuzzIdentityRecord {
    const at = now.toISOString();
    this.db
      .prepare("INSERT INTO channel_buzz_identity (workspace_slug, updated_by, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_slug) DO NOTHING")
      .run(workspaceSlug, actor, at);
    const entries = Object.entries(fields);
    const sets = [...entries.map(([column]) => `${column} = ?`), "updated_by = ?", "updated_at = ?"].join(", ");
    this.db
      .prepare(`UPDATE channel_buzz_identity SET ${sets} WHERE workspace_slug = ?`)
      .run(...entries.map(([, value]) => value ?? null), actor, at, workspaceSlug);
    return this.getIdentity(workspaceSlug)!;
  }

  /** A new agent key (public part only). Clears the NIP-OA tag: it named the previous key. */
  setAgentKey(input: { workspaceSlug: string; agentPubkey: string; actor: string; now: Date }): BuzzIdentityRecord {
    return this.upsert(
      input.workspaceSlug,
      {
        agent_pubkey: input.agentPubkey,
        key_created_at: input.now.toISOString(),
        auth_tag_json: null,
        auth_tag_sha256: null,
        auth_owner_pubkey: null,
        auth_conditions: null,
        auth_expires_at: null,
        auth_set_at: null,
      },
      input.actor,
      input.now,
    );
  }

  setRelayUrl(input: { workspaceSlug: string; relayUrl: string; actor: string; now: Date }): BuzzIdentityRecord {
    return this.upsert(input.workspaceSlug, { relay_url: input.relayUrl }, input.actor, input.now);
  }

  setAuthTag(input: {
    workspaceSlug: string;
    tagJson: string;
    sha256: string;
    ownerPubkey: string;
    conditions: string;
    expiresAt: number;
    actor: string;
    now: Date;
  }): BuzzIdentityRecord {
    return this.upsert(
      input.workspaceSlug,
      {
        auth_tag_json: input.tagJson,
        auth_tag_sha256: input.sha256,
        auth_owner_pubkey: input.ownerPubkey,
        auth_conditions: input.conditions,
        auth_expires_at: input.expiresAt,
        auth_set_at: input.now.toISOString(),
      },
      input.actor,
      input.now,
    );
  }

  clearAuthTag(input: { workspaceSlug: string; actor: string; now: Date }): BuzzIdentityRecord {
    return this.upsert(
      input.workspaceSlug,
      { auth_tag_json: null, auth_tag_sha256: null, auth_owner_pubkey: null, auth_conditions: null, auth_expires_at: null, auth_set_at: null },
      input.actor,
      input.now,
    );
  }

  // ----- bridge routes ------------------------------------------------------------

  getRoute(workspaceSlug: string, channelId: string): BuzzRouteRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_buzz_route WHERE workspace_slug = ? AND channel_id = ?").get(workspaceSlug, channelId) as Row | undefined;
    return row ? routeFromRow(row) : null;
  }

  listRoutes(workspaceSlug: string): BuzzRouteRecord[] {
    return (this.db.prepare("SELECT * FROM channel_buzz_route WHERE workspace_slug = ? ORDER BY created_at, channel_id").all(workspaceSlug) as Row[]).map(routeFromRow);
  }

  /**
   * The owner's confirmation of the routed agent's Buzz key on the current relay. A different agent key or relay
   * forgets the bridge channel (a new private channel is created on the next bridged message).
   */
  setRoute(input: { workspaceSlug: string; channelId: string; agentId: string; agentPubkey: string; relayUrl: string; actor: string; now: Date }): BuzzRouteRecord {
    const at = input.now.toISOString();
    const current = this.getRoute(input.workspaceSlug, input.channelId);
    const keep = current && current.agentId === input.agentId && current.agentPubkey === input.agentPubkey && current.relayUrl === input.relayUrl;
    if (current?.groupId && !keep) this.retireGroup(input.workspaceSlug, current, "binding_changed", input.now);
    this.db
      .prepare(
        `INSERT INTO channel_buzz_route (workspace_slug, channel_id, agent_id, agent_pubkey, relay_url, group_id, member_added, group_created_at, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
         ON CONFLICT(workspace_slug, channel_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           agent_pubkey = excluded.agent_pubkey,
           relay_url = excluded.relay_url,
           group_id = CASE WHEN ? = 1 THEN channel_buzz_route.group_id ELSE excluded.group_id END,
           member_added = CASE WHEN ? = 1 THEN channel_buzz_route.member_added ELSE 0 END,
           group_created_at = CASE WHEN ? = 1 THEN channel_buzz_route.group_created_at ELSE NULL END,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      // A new binding gets its bridge channel id now (fixed before any create, so an uncertain create is retried
      // with the same id and never makes a second channel).
      .run(input.workspaceSlug, input.channelId, input.agentId, input.agentPubkey, input.relayUrl, randomUUID(), input.actor, at, at, keep ? 1 : 0, keep ? 1 : 0, keep ? 1 : 0);
    return this.getRoute(input.workspaceSlug, input.channelId)!;
  }

  /**
   * After a relay change: every route needs the owner's confirmation again (relay cleared, bridge channel
   * forgotten, since it lived on the old relay). The bridge refuses (`buzz_relay_changed`) until then.
   */
  unconfirmRoutes(workspaceSlug: string, actor: string, now: Date, reason: "relay_changed" | "key_rotated"): { routes: number; retiredGroups: string[] } {
    const routes = this.listRoutes(workspaceSlug);
    const retiredGroups = routes.filter((route) => route.groupId).map((route) => this.retireGroup(workspaceSlug, route, reason, now));
    const changed = Number(
      this.db
        .prepare("UPDATE channel_buzz_route SET relay_url = '', group_id = NULL, member_added = 0, group_created_at = NULL, updated_by = ?, updated_at = ? WHERE workspace_slug = ?")
        .run(actor, now.toISOString(), workspaceSlug).changes,
    );
    return { routes: changed, retiredGroups };
  }

  /**
   * Removes a route's binding (agent re-bind: nothing carries over to the new agent). Its bridge channel is
   * retired. Returns the removed binding, or null.
   */
  deleteRoute(workspaceSlug: string, channelId: string, now: Date): BuzzRouteRecord | null {
    const current = this.getRoute(workspaceSlug, channelId);
    if (!current) return null;
    if (current.groupId) this.retireGroup(workspaceSlug, current, "agent_rebound", now);
    this.db.prepare("DELETE FROM channel_buzz_route WHERE workspace_slug = ? AND channel_id = ?").run(workspaceSlug, channelId);
    return current;
  }

  private retireGroup(workspaceSlug: string, route: BuzzRouteRecord, reason: string, now: Date): string {
    this.db
      .prepare(
        `INSERT INTO channel_buzz_retired_group (workspace_slug, group_id, relay_url, channel_id, agent_pubkey, reason, cleanup_status, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_slug, group_id) DO NOTHING`,
      )
      // A channel that was never created needs no cleanup.
      .run(workspaceSlug, route.groupId, route.relayUrl, route.channelId, route.agentPubkey, reason, route.groupCreatedAt ? null : "never_created", now.toISOString());
    return route.groupId!;
  }

  /** Every bridge channel id, current or retired: delivery-only, never an inbound source. */
  bridgeGroupIds(workspaceSlug: string): Set<string> {
    const current = (this.db.prepare("SELECT group_id FROM channel_buzz_route WHERE workspace_slug = ? AND group_id IS NOT NULL").all(workspaceSlug) as Row[]).map((row) => String(row.group_id));
    const retired = (this.db.prepare("SELECT group_id FROM channel_buzz_retired_group WHERE workspace_slug = ?").all(workspaceSlug) as Row[]).map((row) => String(row.group_id));
    return new Set([...current, ...retired]);
  }

  listRetiredGroups(workspaceSlug: string, filter: { pendingCleanup?: boolean } = {}): RetiredGroupRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM channel_buzz_retired_group WHERE workspace_slug = ? ${filter.pendingCleanup ? "AND cleanup_status IS NULL" : ""} ORDER BY retired_at`)
        .all(workspaceSlug) as Row[]
    ).map((row) => ({
      groupId: String(row.group_id),
      relayUrl: String(row.relay_url),
      channelId: String(row.channel_id),
      agentPubkey: String(row.agent_pubkey ?? ""),
      reason: String(row.reason),
      cleanupStatus: str(row.cleanup_status),
      retiredAt: String(row.retired_at),
    }));
  }

  /** `member_removed` (kind 9001 accepted), `deleted` (kind 9008 before a key rotation), `skipped_relay_changed`, `failed`. */
  markRetiredCleanup(workspaceSlug: string, groupId: string, status: string): void {
    this.db.prepare("UPDATE channel_buzz_retired_group SET cleanup_status = ? WHERE workspace_slug = ? AND group_id = ?").run(status, workspaceSlug, groupId);
  }

  /** The bridge channel exists on the relay (created, or found after an uncertain create). */
  markGroupCreated(workspaceSlug: string, channelId: string, groupId: string, now: Date): void {
    this.db
      .prepare("UPDATE channel_buzz_route SET group_created_at = ?, updated_at = ? WHERE workspace_slug = ? AND channel_id = ? AND group_id = ?")
      .run(now.toISOString(), now.toISOString(), workspaceSlug, channelId, groupId);
  }

  markMemberAdded(workspaceSlug: string, channelId: string, now: Date): void {
    this.db.prepare("UPDATE channel_buzz_route SET member_added = 1, updated_at = ? WHERE workspace_slug = ? AND channel_id = ?").run(now.toISOString(), workspaceSlug, channelId);
  }

  // ----- bridged messages (retention) ----------------------------------------------

  recordBridged(input: { workspaceSlug: string; inboundEventId: string; routeChannelId: string; groupId: string; relayUrl: string; buzzEventId: string; now: Date }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_buzz_bridged (workspace_slug, inbound_event_id, route_channel_id, group_id, relay_url, buzz_event_id, bridged_at, deleted_at, delete_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(input.workspaceSlug, input.inboundEventId, input.routeChannelId, input.groupId, input.relayUrl, input.buzzEventId, input.now.toISOString());
  }

  getBridged(workspaceSlug: string, inboundEventId: string): BuzzBridgedRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_buzz_bridged WHERE workspace_slug = ? AND inbound_event_id = ?").get(workspaceSlug, inboundEventId) as Row | undefined;
    return row ? bridgedFromRow(row) : null;
  }

  /** Bridged messages not yet deleted, bridged before `before`: never-tried first, then oldest first. */
  listBridgedDue(workspaceSlug: string, before: Date, limit: number): BuzzBridgedRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM channel_buzz_bridged WHERE workspace_slug = ? AND deleted_at IS NULL AND bridged_at < ? ORDER BY (delete_status IS NOT NULL), bridged_at LIMIT ?")
        .all(workspaceSlug, before.toISOString(), limit) as Row[]
    ).map(bridgedFromRow);
  }

  /** `deleted` (kind 5 accepted), `skipped_relay_changed` (never sent to another relay) or `failed` (kept for a retry). */
  markBridged(workspaceSlug: string, inboundEventId: string, status: "deleted" | "skipped_relay_changed", now: Date): void {
    this.db
      .prepare("UPDATE channel_buzz_bridged SET deleted_at = ?, delete_status = ? WHERE workspace_slug = ? AND inbound_event_id = ?")
      .run(now.toISOString(), status, workspaceSlug, inboundEventId);
  }

  /** Retention of the rows themselves: rows bridged before `before` go (the inbound metadata retention, 90 days). */
  purgeBridgedRows(workspaceSlug: string, before: Date): number {
    return Number(this.db.prepare("DELETE FROM channel_buzz_bridged WHERE workspace_slug = ? AND bridged_at < ?").run(workspaceSlug, before.toISOString()).changes);
  }

  /** Bridged messages not yet deleted and not already given up before a key rotation. */
  listBridgedForRotation(workspaceSlug: string, limit: number): BuzzBridgedRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM channel_buzz_bridged WHERE workspace_slug = ? AND deleted_at IS NULL AND IFNULL(delete_status, '') <> 'failed_rotation' ORDER BY bridged_at LIMIT ?")
        .all(workspaceSlug, limit) as Row[]
    ).map(bridgedFromRow);
  }

  markBridgedStatus(workspaceSlug: string, inboundEventId: string, status: string): void {
    this.db.prepare("UPDATE channel_buzz_bridged SET delete_status = ? WHERE workspace_slug = ? AND inbound_event_id = ?").run(status, workspaceSlug, inboundEventId);
  }

  noteDeleteFailed(workspaceSlug: string, inboundEventId: string): void {
    this.db.prepare("UPDATE channel_buzz_bridged SET delete_status = 'failed' WHERE workspace_slug = ? AND inbound_event_id = ?").run(workspaceSlug, inboundEventId);
  }
}

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ChannelDestination, InboundMessage } from "./providers/types.js";

/**
 * Inbound worker state (Channels P2 scope 2.2). Additive tables only (`CREATE TABLE IF NOT EXISTS`); nothing
 * existing is altered, so 0.2.0 starts on a data directory that holds them and ignores them.
 *
 * - `channel_inbound_event`: one row per received message on a ROUTED channel (messages from channels the owner
 *   did not route are never stored). Unique on (workspace, platform, platform channel id, message id), which
 *   de-duplicates provider retries and the `message` + `app_mention` pair of one Slack mention. The text is
 *   untrusted data, bounded, and purged after the owner's retention; the metadata row goes after 90 days.
 * - `channel_inbound_route`: the owner's route per channel (channel → agent, enabled flag, default off).
 * - `channel_inbound_reply`: the reply target of a `marketplace.channels.reply` post, keyed like the post
 *   itself (agent + internal idempotency key), so a held reply is rebuilt with the same target at send time.
 * - `channel_inbound_setting`: per-workspace inbound settings (text retention, Discord Message Content intent).
 * - `channel_inbound_webhook`: the Telegram webhook Marketplace set: SHA-256 digests of the random path segment
 *   and of the header value only (the values themselves are never stored).
 * - `channel_consumer_lease`: one consumer per bot credential (Phase 1 spec §8), keyed by a credential digest.
 * - `channel_telegram_chat`: chats and topics seen by the webhook (discovery while a webhook is set).
 */

export const INBOUND_TABLES = [
  "channel_inbound_event",
  "channel_inbound_route",
  "channel_inbound_reply",
  "channel_inbound_setting",
  "channel_inbound_webhook",
  "channel_consumer_lease",
  "channel_telegram_chat",
] as const;

export const INBOUND_DDL = `
  CREATE TABLE IF NOT EXISTS channel_inbound_event (
    id TEXT PRIMARY KEY,
    workspace_slug TEXT NOT NULL,
    platform TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_id TEXT,
    message_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_display TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    text_truncated INTEGER NOT NULL DEFAULT 0,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    route_channel_id TEXT,
    received_at TEXT NOT NULL,
    routed_to TEXT,
    bridge_status TEXT NOT NULL,
    bridge_detail TEXT,
    purged_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_slug, platform, channel_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_channel_inbound_event_agent
  ON channel_inbound_event(workspace_slug, routed_to, received_at);

  CREATE INDEX IF NOT EXISTS idx_channel_inbound_event_thread
  ON channel_inbound_event(workspace_slug, platform, channel_id, thread_id, received_at);

  CREATE INDEX IF NOT EXISTS idx_channel_inbound_event_sender
  ON channel_inbound_event(workspace_slug, platform, sender_user_id, received_at);

  CREATE INDEX IF NOT EXISTS idx_channel_inbound_event_received
  ON channel_inbound_event(workspace_slug, received_at);

  CREATE TABLE IF NOT EXISTS channel_inbound_route (
    workspace_slug TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, channel_id)
  );

  CREATE TABLE IF NOT EXISTS channel_inbound_reply (
    workspace_slug TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    reply_to TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, agent_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS channel_inbound_setting (
    workspace_slug TEXT PRIMARY KEY,
    text_retention_days INTEGER NOT NULL,
    discord_message_content INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_inbound_webhook (
    workspace_slug TEXT NOT NULL,
    provider TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    consumer_key TEXT NOT NULL DEFAULT '',
    path_sha256 TEXT NOT NULL,
    header_sha256 TEXT NOT NULL,
    url_origin TEXT NOT NULL,
    status TEXT NOT NULL,
    set_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, provider)
  );

  CREATE TABLE IF NOT EXISTS channel_consumer_lease (
    consumer_key TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_telegram_chat (
    workspace_slug TEXT NOT NULL,
    chat_key TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    destination_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY (workspace_slug, chat_key)
  );
`;

/** Creates the inbound tables; adds columns a pre-release build of this PR created without (additive only). */
export function migrateInboundTables(db: DatabaseSync): void {
  db.exec(INBOUND_DDL);
  const webhookColumns = (db.prepare("PRAGMA table_info(channel_inbound_webhook)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!webhookColumns.includes("consumer_key")) db.exec("ALTER TABLE channel_inbound_webhook ADD COLUMN consumer_key TEXT NOT NULL DEFAULT ''");
}

/** Received text kept per event, in code points (the parsers already cap at the platform limit). */
export const INBOUND_TEXT_MAX_CHARS = 8000;
/** Default and bounds of the owner's text retention (days). */
export const INBOUND_TEXT_RETENTION_DAYS = 30;
export const INBOUND_TEXT_RETENTION_BOUNDS = Object.freeze({ min: 1, max: 365 });
/** Metadata rows are deleted after this (the receipt retention). */
export const INBOUND_METADATA_RETENTION_MS = 90 * 86_400_000;
/** Most chats-seen rows kept per workspace (discovery reads at most this many). */
export const TELEGRAM_CHATS_SEEN_LIMIT = 1000;

/**
 * `queued` (routed, handed to the sink), `pending-bridge` (recorded by the null sink; the Buzz bridge picks it
 * up later), `bridged`, `bridge-failed`, and the not-delivered outcomes `loop-limited`, `rate-limited` and
 * `consent-inactive` (routed channel, but the agent's consent for it is no longer active).
 */
export type InboundBridgeStatus =
  | "queued"
  | "pending-bridge"
  | "bridged"
  | "bridge-failed"
  | "loop-limited"
  | "rate-limited"
  | "consent-inactive";

export const DELIVERED_STATUSES: readonly InboundBridgeStatus[] = ["queued", "pending-bridge", "bridged", "bridge-failed"];

export type InboundEventRecord = {
  id: string;
  workspaceSlug: string;
  platform: string;
  /** Platform channel / chat / conversation id. */
  channelId: string;
  threadId: string | null;
  messageId: string;
  senderUserId: string;
  senderDisplay: string;
  text: string;
  textTruncated: boolean;
  attachments: InboundMessage["attachments"];
  /** The Marketplace channel record the route belongs to. */
  routeChannelId: string | null;
  receivedAt: string;
  routedTo: string | null;
  bridgeStatus: InboundBridgeStatus;
  bridgeDetail: string | null;
  purgedAt: string | null;
};

export type InboundRouteRecord = {
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  enabled: boolean;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type InboundSettings = { textRetentionDays: number; discordMessageContent: boolean; updatedAt: string | null };

export type InboundWebhookRecord = {
  provider: string;
  connectionId: string;
  /** `telegram:<sha256 prefix of the bot token>`: the webhook belongs to this credential only (review S1). */
  consumerKey: string;
  pathSha256: string;
  headerSha256: string;
  urlOrigin: string;
  status: "active" | "deleted";
  setAt: string;
  updatedAt: string;
};

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function eventFromRow(row: Row): InboundEventRecord {
  let attachments: InboundMessage["attachments"] = [];
  try {
    const parsed = JSON.parse(String(row.attachments_json ?? "[]")) as unknown;
    if (Array.isArray(parsed)) attachments = parsed as InboundMessage["attachments"];
  } catch {
    attachments = [];
  }
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    platform: String(row.platform),
    channelId: String(row.channel_id),
    threadId: str(row.thread_id),
    messageId: String(row.message_id),
    senderUserId: String(row.sender_user_id),
    senderDisplay: String(row.sender_display ?? ""),
    text: String(row.text ?? ""),
    textTruncated: Number(row.text_truncated) === 1,
    attachments,
    routeChannelId: str(row.route_channel_id),
    receivedAt: String(row.received_at),
    routedTo: str(row.routed_to),
    bridgeStatus: String(row.bridge_status) as InboundBridgeStatus,
    bridgeDetail: str(row.bridge_detail),
    purgedAt: str(row.purged_at),
  };
}

function routeFromRow(row: Row): InboundRouteRecord {
  return {
    workspaceSlug: String(row.workspace_slug),
    channelId: String(row.channel_id),
    agentId: String(row.agent_id),
    enabled: Number(row.enabled) === 1,
    updatedBy: String(row.updated_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function bounded(text: string): { text: string; truncated: boolean } {
  const points = Array.from(text);
  return points.length > INBOUND_TEXT_MAX_CHARS ? { text: points.slice(0, INBOUND_TEXT_MAX_CHARS).join(""), truncated: true } : { text, truncated: false };
}

export class InboundStore {
  constructor(private readonly db: DatabaseSync) {}

  // ----- settings -----------------------------------------------------------

  getSettings(workspaceSlug: string): InboundSettings {
    const row = this.db.prepare("SELECT * FROM channel_inbound_setting WHERE workspace_slug = ?").get(workspaceSlug) as Row | undefined;
    if (!row) return { textRetentionDays: INBOUND_TEXT_RETENTION_DAYS, discordMessageContent: false, updatedAt: null };
    return {
      textRetentionDays: Number(row.text_retention_days),
      discordMessageContent: Number(row.discord_message_content) === 1,
      updatedAt: String(row.updated_at),
    };
  }

  updateSettings(input: { workspaceSlug: string; textRetentionDays?: number; discordMessageContent?: boolean; actor: string; now: Date }): InboundSettings {
    const current = this.getSettings(input.workspaceSlug);
    const days = input.textRetentionDays ?? current.textRetentionDays;
    const content = input.discordMessageContent ?? current.discordMessageContent;
    this.db
      .prepare(
        `INSERT INTO channel_inbound_setting (workspace_slug, text_retention_days, discord_message_content, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug) DO UPDATE SET
           text_retention_days = excluded.text_retention_days,
           discord_message_content = excluded.discord_message_content,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.workspaceSlug, days, content ? 1 : 0, input.actor, input.now.toISOString());
    return this.getSettings(input.workspaceSlug);
  }

  // ----- routes -------------------------------------------------------------

  getRoute(workspaceSlug: string, channelId: string): InboundRouteRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_inbound_route WHERE workspace_slug = ? AND channel_id = ?").get(workspaceSlug, channelId) as Row | undefined;
    return row ? routeFromRow(row) : null;
  }

  listRoutes(workspaceSlug: string): InboundRouteRecord[] {
    return (this.db.prepare("SELECT * FROM channel_inbound_route WHERE workspace_slug = ? ORDER BY created_at, channel_id").all(workspaceSlug) as Row[]).map(routeFromRow);
  }

  /** Enabled routes whose channel belongs to this provider (joined with the channel table). */
  enabledRoutesFor(workspaceSlug: string, provider: string): InboundRouteRecord[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM channel_inbound_route r JOIN channel c ON c.id = r.channel_id AND c.workspace_slug = r.workspace_slug
           WHERE r.workspace_slug = ? AND r.enabled = 1 AND c.provider = ? AND c.status <> 'archived'`,
        )
        .all(workspaceSlug, provider) as Row[]
    ).map(routeFromRow);
  }

  setRoute(input: { workspaceSlug: string; channelId: string; agentId: string; enabled: boolean; actor: string; now: Date }): InboundRouteRecord {
    const at = input.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_inbound_route (workspace_slug, channel_id, agent_id, enabled, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_slug, channel_id) DO UPDATE SET
           agent_id = excluded.agent_id,
           enabled = excluded.enabled,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run(input.workspaceSlug, input.channelId, input.agentId, input.enabled ? 1 : 0, input.actor, at, at);
    return this.getRoute(input.workspaceSlug, input.channelId)!;
  }

  // ----- events -------------------------------------------------------------

  /** Inserts the event unless (platform, channel, message) is already recorded. `created: false` = duplicate. */
  insertEvent(input: { workspaceSlug: string; message: InboundMessage; routeChannelId: string; now: Date }): { created: boolean; event: InboundEventRecord } {
    const { message } = input;
    const at = input.now.toISOString();
    const text = bounded(message.text);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_inbound_event
           (id, workspace_slug, platform, channel_id, thread_id, message_id, sender_user_id, sender_display, text, text_truncated,
            attachments_json, route_channel_id, received_at, routed_to, bridge_status, bridge_detail, purged_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'queued', NULL, NULL, ?)`,
      )
      .run(
        `cie_${randomUUID()}`,
        input.workspaceSlug,
        message.platform,
        message.channelId,
        message.threadId ?? null,
        message.messageId,
        message.senderUserId,
        message.senderDisplay,
        text.text,
        text.truncated ? 1 : 0,
        JSON.stringify(message.attachments.slice(0, 10)),
        input.routeChannelId,
        at,
        at,
      );
    const row = this.db
      .prepare("SELECT * FROM channel_inbound_event WHERE workspace_slug = ? AND platform = ? AND channel_id = ? AND message_id = ?")
      .get(input.workspaceSlug, message.platform, message.channelId, message.messageId) as Row;
    return { created: Number(result.changes) === 1, event: eventFromRow(row) };
  }

  setEventStatus(workspaceSlug: string, id: string, input: { status: InboundBridgeStatus; routedTo?: string | null; detail?: string | null; now: Date }): void {
    this.db
      .prepare(
        `UPDATE channel_inbound_event SET bridge_status = ?, bridge_detail = ?, updated_at = ?,
           routed_to = CASE WHEN ? = 1 THEN ? ELSE routed_to END
         WHERE workspace_slug = ? AND id = ?`,
      )
      .run(input.status, input.detail ?? null, input.now.toISOString(), input.routedTo !== undefined ? 1 : 0, input.routedTo ?? null, workspaceSlug, id);
  }

  getEvent(workspaceSlug: string, id: string): InboundEventRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_inbound_event WHERE workspace_slug = ? AND id = ?").get(workspaceSlug, id) as Row | undefined;
    return row ? eventFromRow(row) : null;
  }

  /** Newest first. `routedTo` limits to events delivered to that agent. */
  listEvents(workspaceSlug: string, filter: { routedTo?: string; routeChannelId?: string; before?: string; limit: number }): InboundEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_inbound_event
         WHERE workspace_slug = ?
           AND (? IS NULL OR routed_to = ?)
           AND (? IS NULL OR route_channel_id = ?)
           AND (? IS NULL OR received_at < ?)
         ORDER BY received_at DESC, id DESC
         LIMIT ?`,
      )
      .all(
        workspaceSlug,
        filter.routedTo ?? null,
        filter.routedTo ?? null,
        filter.routeChannelId ?? null,
        filter.routeChannelId ?? null,
        filter.before ?? null,
        filter.before ?? null,
        filter.limit,
      ) as Row[];
    return rows.map(eventFromRow);
  }

  /** Agent-bound events (routed_to set) in one thread since `since`, excluding `excludeId`. */
  countAgentBoundInThread(input: { workspaceSlug: string; platform: string; channelId: string; threadId: string | null; since: Date; excludeId: string }): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM channel_inbound_event
         WHERE workspace_slug = ? AND platform = ? AND channel_id = ? AND IFNULL(thread_id, '') = ? AND routed_to IS NOT NULL
           AND received_at >= ? AND id <> ?`,
      )
      .get(input.workspaceSlug, input.platform, input.channelId, input.threadId ?? "", input.since.toISOString(), input.excludeId) as { count: number };
    return Number(row.count);
  }

  /** Agent-bound events from one sender (peer) since `since`, excluding `excludeId`. */
  countAgentBoundFromSender(input: { workspaceSlug: string; platform: string; senderUserId: string; since: Date; excludeId: string }): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM channel_inbound_event
         WHERE workspace_slug = ? AND platform = ? AND sender_user_id = ? AND routed_to IS NOT NULL AND received_at >= ? AND id <> ?`,
      )
      .get(input.workspaceSlug, input.platform, input.senderUserId, input.since.toISOString(), input.excludeId) as { count: number };
    return Number(row.count);
  }

  /**
   * Retention: text, sender display and attachment names of events received before `textBefore` are cleared
   * (the row keeps ids, times and statuses); rows received before `rowsBefore` are deleted. Bounded per call.
   */
  purge(input: { workspaceSlug: string; textBefore: Date; rowsBefore: Date; now: Date; limit?: number }): { textPurged: number; deleted: number } {
    const limit = input.limit ?? 1000;
    const deleted = Number(
      this.db
        .prepare(
          `DELETE FROM channel_inbound_event WHERE rowid IN (
             SELECT rowid FROM channel_inbound_event WHERE workspace_slug = ? AND received_at < ? LIMIT ?
           )`,
        )
        .run(input.workspaceSlug, input.rowsBefore.toISOString(), limit).changes,
    );
    const textPurged = Number(
      this.db
        .prepare(
          `UPDATE channel_inbound_event SET text = '', text_truncated = 0, sender_display = '', attachments_json = '[]', purged_at = ?, updated_at = ?
           WHERE rowid IN (
             SELECT rowid FROM channel_inbound_event WHERE workspace_slug = ? AND received_at < ? AND purged_at IS NULL LIMIT ?
           )`,
        )
        .run(input.now.toISOString(), input.now.toISOString(), input.workspaceSlug, input.textBefore.toISOString(), limit).changes,
    );
    // Reply links of events that are gone are not needed any more (a held reply then fails its digest check).
    this.db
      .prepare("DELETE FROM channel_inbound_reply WHERE workspace_slug = ? AND created_at < ?")
      .run(input.workspaceSlug, input.rowsBefore.toISOString());
    return { textPurged, deleted };
  }

  // ----- reply links ----------------------------------------------------------

  /** Records (or confirms) the reply target of one reply post. A different event or target for the key is a conflict. */
  putReplyLink(input: { workspaceSlug: string; agentId: string; idempotencyKey: string; eventId: string; replyTo: string; now: Date }): "created" | "same" | "conflict" {
    const existing = this.getReplyLink(input.workspaceSlug, input.agentId, input.idempotencyKey);
    if (existing) return existing.eventId === input.eventId && existing.replyTo === input.replyTo ? "same" : "conflict";
    this.db
      .prepare("INSERT INTO channel_inbound_reply (workspace_slug, agent_id, idempotency_key, event_id, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.workspaceSlug, input.agentId, input.idempotencyKey, input.eventId, input.replyTo, input.now.toISOString());
    return "created";
  }

  getReplyLink(workspaceSlug: string, agentId: string, idempotencyKey: string): { eventId: string; replyTo: string } | null {
    const row = this.db
      .prepare("SELECT event_id, reply_to FROM channel_inbound_reply WHERE workspace_slug = ? AND agent_id = ? AND idempotency_key = ?")
      .get(workspaceSlug, agentId, idempotencyKey) as Row | undefined;
    return row ? { eventId: String(row.event_id), replyTo: String(row.reply_to) } : null;
  }

  // ----- webhook ------------------------------------------------------------

  getWebhook(workspaceSlug: string, provider: string): InboundWebhookRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_inbound_webhook WHERE workspace_slug = ? AND provider = ?").get(workspaceSlug, provider) as Row | undefined;
    if (!row) return null;
    return {
      provider: String(row.provider),
      connectionId: String(row.connection_id),
      consumerKey: String(row.consumer_key ?? ""),
      pathSha256: String(row.path_sha256),
      headerSha256: String(row.header_sha256),
      urlOrigin: String(row.url_origin),
      status: String(row.status) === "active" ? "active" : "deleted",
      setAt: String(row.set_at),
      updatedAt: String(row.updated_at),
    };
  }

  activeWebhook(workspaceSlug: string, provider: string): InboundWebhookRecord | null {
    const webhook = this.getWebhook(workspaceSlug, provider);
    return webhook?.status === "active" ? webhook : null;
  }

  setWebhook(input: {
    workspaceSlug: string;
    provider: string;
    connectionId: string;
    consumerKey: string;
    pathSha256: string;
    headerSha256: string;
    urlOrigin: string;
    now: Date;
  }): void {
    const at = input.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_inbound_webhook (workspace_slug, provider, connection_id, consumer_key, path_sha256, header_sha256, url_origin, status, set_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(workspace_slug, provider) DO UPDATE SET
           connection_id = excluded.connection_id,
           consumer_key = excluded.consumer_key,
           path_sha256 = excluded.path_sha256,
           header_sha256 = excluded.header_sha256,
           url_origin = excluded.url_origin,
           status = 'active',
           set_at = excluded.set_at,
           updated_at = excluded.updated_at`,
      )
      .run(input.workspaceSlug, input.provider, input.connectionId, input.consumerKey, input.pathSha256, input.headerSha256, input.urlOrigin, at, at);
  }

  markWebhookDeleted(workspaceSlug: string, provider: string, now: Date): void {
    this.db
      .prepare("UPDATE channel_inbound_webhook SET status = 'deleted', updated_at = ? WHERE workspace_slug = ? AND provider = ?")
      .run(now.toISOString(), workspaceSlug, provider);
  }

  // ----- consumer lease (one consumer per bot credential) ---------------------

  /** Takes or renews the lease when it is free, expired or already ours. True when `holder` holds it after the call. */
  acquireLease(input: { consumerKey: string; holder: string; now: Date; ttlMs: number }): boolean {
    const at = input.now.toISOString();
    const until = new Date(input.now.getTime() + input.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_consumer_lease (consumer_key, holder, expires_at, acquired_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(consumer_key) DO UPDATE SET
           holder = excluded.holder,
           expires_at = excluded.expires_at,
           acquired_at = CASE WHEN channel_consumer_lease.holder = excluded.holder THEN channel_consumer_lease.acquired_at ELSE excluded.acquired_at END,
           updated_at = excluded.updated_at
         WHERE channel_consumer_lease.holder = excluded.holder OR channel_consumer_lease.expires_at <= ?`,
      )
      .run(input.consumerKey, input.holder, until, at, at, at);
    return this.leaseHolder(input.consumerKey, input.now) === input.holder;
  }

  /** The current holder, or null when there is none or it expired. */
  leaseHolder(consumerKey: string, now: Date): string | null {
    const row = this.db.prepare("SELECT holder, expires_at FROM channel_consumer_lease WHERE consumer_key = ?").get(consumerKey) as Row | undefined;
    return row && String(row.expires_at) > now.toISOString() ? String(row.holder) : null;
  }

  releaseLease(consumerKey: string, holder: string): void {
    this.db.prepare("DELETE FROM channel_consumer_lease WHERE consumer_key = ? AND holder = ?").run(consumerKey, holder);
  }

  // ----- Telegram chats seen ---------------------------------------------------

  recordTelegramDestinations(workspaceSlug: string, destinations: readonly ChannelDestination[], now: Date): void {
    const at = now.toISOString();
    const statement = this.db.prepare(
      `INSERT INTO channel_telegram_chat (workspace_slug, chat_key, chat_id, destination_json, first_seen_at, last_seen_at, left_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(workspace_slug, chat_key) DO UPDATE SET
         destination_json = excluded.destination_json,
         last_seen_at = excluded.last_seen_at,
         left_at = NULL`,
    );
    for (const destination of destinations) {
      const key = destination.parentId ? `${destination.externalId}:${destination.parentId}` : destination.externalId;
      statement.run(workspaceSlug, key, destination.externalId, JSON.stringify(destination), at, at);
    }
    // Keep the table bounded: the least recently seen rows go first.
    this.db
      .prepare(
        `DELETE FROM channel_telegram_chat WHERE rowid IN (
           SELECT rowid FROM channel_telegram_chat WHERE workspace_slug = ? ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(workspaceSlug, TELEGRAM_CHATS_SEEN_LIMIT);
  }

  markTelegramChatLeft(workspaceSlug: string, chatId: string, now: Date): void {
    this.db.prepare("UPDATE channel_telegram_chat SET left_at = ? WHERE workspace_slug = ? AND chat_id = ? AND left_at IS NULL").run(now.toISOString(), workspaceSlug, chatId);
  }

  listTelegramDestinations(workspaceSlug: string): ChannelDestination[] {
    const rows = this.db
      .prepare("SELECT destination_json FROM channel_telegram_chat WHERE workspace_slug = ? AND left_at IS NULL ORDER BY first_seen_at, chat_key LIMIT ?")
      .all(workspaceSlug, TELEGRAM_CHATS_SEEN_LIMIT) as Row[];
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(String(row.destination_json)) as ChannelDestination];
      } catch {
        return [];
      }
    });
  }
}

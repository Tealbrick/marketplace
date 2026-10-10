import type { DatabaseSync } from "node:sqlite";

import type { TeamsConversationRef, TeamsConversationSource, TeamsConversationType, TeamsMembership } from "./providers/teams.js";

/**
 * Teams conversation references (Channels P2, Teams): one row per conversation where the Teams app is
 * installed, captured by the messaging endpoint from installationUpdate / conversationUpdate activities.
 * Additive table (`CREATE TABLE IF NOT EXISTS`); a removal keeps the row with `removed_at` set. No
 * credential, no message text: the conversation address, its untrusted (cleaned) title and the times only.
 */
export const TEAMS_CONVERSATION_TABLE = "channel_teams_conversation";

export const TEAMS_CONVERSATION_DDL = `
  CREATE TABLE IF NOT EXISTS channel_teams_conversation (
    workspace_slug TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    conversation_type TEXT NOT NULL,
    team_id TEXT,
    channel_id TEXT,
    team_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    membership TEXT NOT NULL DEFAULT 'standard',
    service_url TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    removed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_slug, conversation_id)
  );

  CREATE INDEX IF NOT EXISTS idx_channel_teams_conversation_team
  ON channel_teams_conversation(workspace_slug, team_id, removed_at);
`;

type Row = {
  conversation_id: string;
  conversation_type: string;
  team_id: string | null;
  channel_id: string | null;
  team_name: string;
  title: string;
  membership: string;
  service_url: string;
  tenant_id: string;
};

const TYPES: readonly TeamsConversationType[] = ["channel", "groupChat", "personal"];
const MEMBERSHIPS: readonly TeamsMembership[] = ["standard", "private", "shared"];

function toRef(row: Row): TeamsConversationRef {
  return {
    conversationId: row.conversation_id,
    type: (TYPES as readonly string[]).includes(row.conversation_type) ? (row.conversation_type as TeamsConversationType) : "personal",
    ...(row.team_id ? { teamId: row.team_id } : {}),
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    teamName: row.team_name,
    title: row.title,
    // An unknown stored value never counts as a standard channel (bots cannot post in private ones).
    membership: (MEMBERSHIPS as readonly string[]).includes(row.membership) ? (row.membership as TeamsMembership) : "private",
    serviceUrl: row.service_url,
    tenantId: row.tenant_id,
  };
}

const COLUMNS = "conversation_id, conversation_type, team_id, channel_id, team_name, title, membership, service_url, tenant_id";

export class TeamsConversationStore {
  constructor(private readonly db: DatabaseSync) {}

  upsert(workspaceSlug: string, ref: TeamsConversationRef, now: Date): void {
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO channel_teams_conversation
           (workspace_slug, conversation_id, conversation_type, team_id, channel_id, team_name, title, membership, service_url, tenant_id, installed_at, removed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(workspace_slug, conversation_id) DO UPDATE SET
           conversation_type = excluded.conversation_type,
           team_id = excluded.team_id,
           channel_id = excluded.channel_id,
           team_name = CASE WHEN excluded.team_name <> '' THEN excluded.team_name ELSE channel_teams_conversation.team_name END,
           title = excluded.title,
           membership = excluded.membership,
           service_url = excluded.service_url,
           tenant_id = excluded.tenant_id,
           installed_at = CASE WHEN channel_teams_conversation.removed_at IS NULL THEN channel_teams_conversation.installed_at ELSE excluded.installed_at END,
           removed_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        workspaceSlug,
        ref.conversationId,
        ref.type,
        ref.teamId ?? null,
        ref.channelId ?? null,
        ref.teamName,
        ref.title,
        ref.membership,
        ref.serviceUrl,
        ref.tenantId,
        at,
        at,
      );
  }

  /** Marks one conversation, or every conversation of a team, removed. Returns the number of rows changed. */
  markRemoved(workspaceSlug: string, target: { conversationId?: string; teamId?: string }, now: Date): number {
    const at = now.toISOString();
    if (target.teamId) {
      return Number(
        this.db
          .prepare("UPDATE channel_teams_conversation SET removed_at = ?, updated_at = ? WHERE workspace_slug = ? AND team_id = ? AND removed_at IS NULL")
          .run(at, at, workspaceSlug, target.teamId).changes,
      );
    }
    if (target.conversationId) {
      return Number(
        this.db
          .prepare("UPDATE channel_teams_conversation SET removed_at = ?, updated_at = ? WHERE workspace_slug = ? AND conversation_id = ? AND removed_at IS NULL")
          .run(at, at, workspaceSlug, target.conversationId).changes,
      );
    }
    return 0;
  }

  listActive(workspaceSlug: string): TeamsConversationRef[] {
    return (
      this.db
        .prepare(`SELECT ${COLUMNS} FROM channel_teams_conversation WHERE workspace_slug = ? AND removed_at IS NULL ORDER BY installed_at, conversation_id LIMIT 1000`)
        .all(workspaceSlug) as Row[]
    ).map(toRef);
  }

  getActive(workspaceSlug: string, conversationId: string): TeamsConversationRef | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM channel_teams_conversation WHERE workspace_slug = ? AND conversation_id = ? AND removed_at IS NULL`)
      .get(workspaceSlug, conversationId) as Row | undefined;
    return row ? toRef(row) : null;
  }

  activeForTeam(workspaceSlug: string, teamId: string): TeamsConversationRef | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM channel_teams_conversation WHERE workspace_slug = ? AND team_id = ? AND removed_at IS NULL ORDER BY updated_at DESC LIMIT 1`)
      .get(workspaceSlug, teamId) as Row | undefined;
    return row ? toRef(row) : null;
  }

  activeForTenant(workspaceSlug: string, tenantId: string): TeamsConversationRef | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM channel_teams_conversation WHERE workspace_slug = ? AND tenant_id = ? AND removed_at IS NULL ORDER BY updated_at DESC LIMIT 1`)
      .get(workspaceSlug, tenantId) as Row | undefined;
    return row ? toRef(row) : null;
  }

  /** The adapter's view of one workspace's references. */
  source(workspaceSlug: string, now: () => Date): TeamsConversationSource {
    return {
      list: () => this.listActive(workspaceSlug),
      get: (conversationId) => this.getActive(workspaceSlug, conversationId),
      forTeam: (teamId) => this.activeForTeam(workspaceSlug, teamId),
      forTenant: (tenantId) => this.activeForTenant(workspaceSlug, tenantId),
      upsert: (ref) => this.upsert(workspaceSlug, ref, now()),
    };
  }
}

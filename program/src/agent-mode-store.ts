import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_AGENT_CONNECTOR_DAILY_CAP,
  DEFAULT_AGENT_DAILY_CAP,
  type AgentApprovalMode,
} from "./agent-modes.js";

/**
 * Agent approval modes, pauses and Assistant-mode receipts. Additive tables only (`CREATE TABLE IF NOT EXISTS`);
 * an older build ignores them. Settings are written only by owner routes; receipts only by the execution path.
 */
export const AGENT_MODE_TABLES = ["agent_approval_setting", "agent_pause_all", "agent_outward_receipt"] as const;

export function migrateAgentModeTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_approval_setting (
      workspace_slug TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      daily_cap INTEGER,
      connector_daily_cap INTEGER,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_slug, agent_id)
    );

    CREATE TABLE IF NOT EXISTS agent_pause_all (
      workspace_slug TEXT PRIMARY KEY,
      paused INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_outward_receipt (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      action_key TEXT NOT NULL,
      account_ref TEXT,
      destination TEXT,
      arguments_preview TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      replay_key TEXT,
      trace_id TEXT,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (workspace_slug, agent_id, plugin_id, replay_key)
    );
    CREATE INDEX IF NOT EXISTS agent_outward_receipt_day
      ON agent_outward_receipt (workspace_slug, agent_id, day);
  `);
}

export type AgentApprovalSetting = {
  workspaceSlug: string;
  agentId: string;
  mode: AgentApprovalMode;
  paused: boolean;
  dailyCap: number;
  connectorDailyCap: number;
  /** False when the agent has no stored row (defaults: System, not paused). */
  stored: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type AgentOutwardReceipt = {
  id: string;
  workspaceSlug: string;
  agentId: string;
  pluginId: string;
  provider: string;
  actionKey: string;
  accountRef: string | null;
  destination: string | null;
  argumentsPreview: string;
  mode: AgentApprovalMode;
  /** `executing` until the call returns; `not_run` when it stopped before the provider (does not count). */
  status: "executing" | "succeeded" | "failed" | "not_run";
  error: string | null;
  traceId: string | null;
  day: string;
  createdAt: string;
  finishedAt: string | null;
};

export type ReserveResult =
  | { kind: "reserved"; receipt: AgentOutwardReceipt }
  | { kind: "replay"; receipt: AgentOutwardReceipt }
  | { kind: "cap"; limit: "agent" | "connector"; cap: number; used: number };

function receiptFromRow(row: Record<string, unknown>): AgentOutwardReceipt {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    agentId: String(row.agent_id),
    pluginId: String(row.plugin_id),
    provider: String(row.provider),
    actionKey: String(row.action_key),
    accountRef: row.account_ref === null ? null : String(row.account_ref),
    destination: row.destination === null ? null : String(row.destination),
    argumentsPreview: String(row.arguments_preview),
    mode: row.mode === "assistant" ? "assistant" : "system",
    status: String(row.status) as AgentOutwardReceipt["status"],
    error: row.error === null ? null : String(row.error),
    traceId: row.trace_id === null ? null : String(row.trace_id),
    day: String(row.day),
    createdAt: String(row.created_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

export class AgentModeStore {
  constructor(private readonly db: DatabaseSync) {}

  getSetting(workspaceSlug: string, agentId: string): AgentApprovalSetting {
    const row = this.db
      .prepare("SELECT * FROM agent_approval_setting WHERE workspace_slug = ? AND agent_id = ?")
      .get(workspaceSlug, agentId) as Record<string, unknown> | undefined;
    return {
      workspaceSlug,
      agentId,
      // Anything but an explicit owner "assistant" is System (fail closed).
      mode: row?.mode === "assistant" ? "assistant" : "system",
      paused: Number(row?.paused ?? 0) === 1,
      dailyCap: typeof row?.daily_cap === "number" ? row.daily_cap : DEFAULT_AGENT_DAILY_CAP,
      connectorDailyCap: typeof row?.connector_daily_cap === "number" ? row.connector_daily_cap : DEFAULT_AGENT_CONNECTOR_DAILY_CAP,
      stored: Boolean(row),
      updatedBy: row ? String(row.updated_by) : null,
      updatedAt: row ? String(row.updated_at) : null,
    };
  }

  listSettings(workspaceSlug: string): AgentApprovalSetting[] {
    const rows = this.db
      .prepare("SELECT agent_id FROM agent_approval_setting WHERE workspace_slug = ? ORDER BY agent_id")
      .all(workspaceSlug) as Array<{ agent_id: string }>;
    return rows.map((row) => this.getSetting(workspaceSlug, row.agent_id));
  }

  /** Owner write: mode and/or limits. Returns the previous and next setting. */
  updateSetting(input: {
    workspaceSlug: string;
    agentId: string;
    mode?: AgentApprovalMode;
    paused?: boolean;
    dailyCap?: number | null;
    connectorDailyCap?: number | null;
    actor: string;
    now: Date;
  }) {
    const previous = this.getSetting(input.workspaceSlug, input.agentId);
    const next = {
      mode: input.mode ?? previous.mode,
      paused: input.paused ?? previous.paused,
      dailyCap: input.dailyCap === undefined ? (previous.stored ? previous.dailyCap : null) : input.dailyCap,
      connectorDailyCap:
        input.connectorDailyCap === undefined ? (previous.stored ? previous.connectorDailyCap : null) : input.connectorDailyCap,
    };
    this.db
      .prepare(
        `INSERT INTO agent_approval_setting (workspace_slug, agent_id, mode, paused, daily_cap, connector_daily_cap, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_slug, agent_id) DO UPDATE SET
           mode = excluded.mode, paused = excluded.paused, daily_cap = excluded.daily_cap,
           connector_daily_cap = excluded.connector_daily_cap, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(
        input.workspaceSlug,
        input.agentId,
        next.mode,
        next.paused ? 1 : 0,
        next.dailyCap,
        next.connectorDailyCap,
        input.actor,
        input.now.toISOString(),
      );
    return { previous, next: this.getSetting(input.workspaceSlug, input.agentId) };
  }

  /**
   * The agent left the workspace (its last grant or consent was revoked): its mode and limits go back to the
   * defaults, so the same agent id registered again starts in System. A pause stays (fail closed).
   */
  resetMode(workspaceSlug: string, agentId: string, now: Date): boolean {
    const setting = this.getSetting(workspaceSlug, agentId);
    if (!setting.stored) return false;
    if (setting.paused) {
      const changed = setting.mode !== "system" || setting.dailyCap !== DEFAULT_AGENT_DAILY_CAP || setting.connectorDailyCap !== DEFAULT_AGENT_CONNECTOR_DAILY_CAP;
      this.db
        .prepare(
          `UPDATE agent_approval_setting SET mode = 'system', daily_cap = NULL, connector_daily_cap = NULL, updated_by = 'agent-removed', updated_at = ?
           WHERE workspace_slug = ? AND agent_id = ?`,
        )
        .run(now.toISOString(), workspaceSlug, agentId);
      return changed;
    }
    this.db.prepare("DELETE FROM agent_approval_setting WHERE workspace_slug = ? AND agent_id = ?").run(workspaceSlug, agentId);
    return setting.mode !== "system";
  }

  isPausedAll(workspaceSlug: string) {
    const row = this.db.prepare("SELECT paused FROM agent_pause_all WHERE workspace_slug = ?").get(workspaceSlug) as
      | { paused: number }
      | undefined;
    return Number(row?.paused ?? 0) === 1;
  }

  setPausedAll(input: { workspaceSlug: string; paused: boolean; actor: string; now: Date }) {
    const previous = this.isPausedAll(input.workspaceSlug);
    this.db
      .prepare(
        `INSERT INTO agent_pause_all (workspace_slug, paused, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_slug) DO UPDATE SET paused = excluded.paused, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(input.workspaceSlug, input.paused ? 1 : 0, input.actor, input.now.toISOString());
    return { previous, paused: input.paused };
  }

  /** Paused by the owner, for this agent or for all agents. */
  pauseState(workspaceSlug: string, agentId: string): "agent" | "all" | null {
    if (this.isPausedAll(workspaceSlug)) return "all";
    return this.getSetting(workspaceSlug, agentId).paused ? "agent" : null;
  }

  findReceiptByKey(input: { workspaceSlug: string; agentId: string; pluginId: string; replayKey: string }) {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_outward_receipt WHERE workspace_slug = ? AND agent_id = ? AND plugin_id = ? AND replay_key = ?",
      )
      .get(input.workspaceSlug, input.agentId, input.pluginId, input.replayKey) as Record<string, unknown> | undefined;
    return row ? receiptFromRow(row) : null;
  }

  /** Calls that count today: every reserved call except those that stopped before the provider. */
  usedToday(workspaceSlug: string, agentId: string, day: string) {
    const rows = this.db
      .prepare(
        `SELECT plugin_id, COUNT(*) AS used FROM agent_outward_receipt
         WHERE workspace_slug = ? AND agent_id = ? AND day = ? AND status != 'not_run'
         GROUP BY plugin_id`,
      )
      .all(workspaceSlug, agentId, day) as Array<{ plugin_id: string; used: number }>;
    const byConnector = Object.fromEntries(rows.map((row) => [row.plugin_id, Number(row.used)]));
    return { total: rows.reduce((sum, row) => sum + Number(row.used), 0), byConnector };
  }

  /**
   * Atomically check both daily limits and reserve one execution (one transaction, no await inside): concurrent
   * calls can never pass the cap. A call repeated with the same replay key returns the first receipt and counts once.
   */
  reserveExecution(input: {
    workspaceSlug: string;
    agentId: string;
    pluginId: string;
    provider: string;
    actionKey: string;
    accountRef: string | null;
    destination: string | null;
    argumentsPreview: string;
    replayKey: string | null;
    traceId: string;
    now: Date;
    day: string;
    dailyCap: number;
    connectorDailyCap: number;
  }): ReserveResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A receipt that never reached the provider (`not_run`) is reused, not replayed.
      const existing = input.replayKey ? this.findReceiptByKey({ ...input, replayKey: input.replayKey }) : null;
      if (existing && existing.status !== "not_run") {
        this.db.exec("COMMIT");
        return { kind: "replay", receipt: existing };
      }
      const count = (pluginId: string | null) =>
        Number(
          (
            this.db
              .prepare(
                `SELECT COUNT(*) AS used FROM agent_outward_receipt
                 WHERE workspace_slug = ? AND agent_id = ? AND day = ? AND status != 'not_run' AND (? IS NULL OR plugin_id = ?)`,
              )
              .get(input.workspaceSlug, input.agentId, input.day, pluginId, pluginId) as { used: number }
          ).used,
        );
      const agentUsed = count(null);
      if (agentUsed >= input.dailyCap) {
        this.db.exec("COMMIT");
        return { kind: "cap", limit: "agent", cap: input.dailyCap, used: agentUsed };
      }
      const connectorUsed = count(input.pluginId);
      if (connectorUsed >= input.connectorDailyCap) {
        this.db.exec("COMMIT");
        return { kind: "cap", limit: "connector", cap: input.connectorDailyCap, used: connectorUsed };
      }
      if (existing) {
        this.db
          .prepare(
            `UPDATE agent_outward_receipt SET status = 'executing', error = NULL, finished_at = NULL, arguments_preview = ?,
               destination = ?, trace_id = ?, day = ?, created_at = ? WHERE id = ?`,
          )
          .run(input.argumentsPreview, input.destination, input.traceId, input.day, input.now.toISOString(), existing.id);
        this.db.exec("COMMIT");
        return { kind: "reserved", receipt: this.getReceipt(existing.id)! };
      }
      const id = `receipt_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO agent_outward_receipt (
             id, workspace_slug, agent_id, plugin_id, provider, action_key, account_ref, destination, arguments_preview,
             mode, status, error, replay_key, trace_id, day, created_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'assistant', 'executing', NULL, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          input.workspaceSlug,
          input.agentId,
          input.pluginId,
          input.provider,
          input.actionKey,
          input.accountRef,
          input.destination,
          input.argumentsPreview,
          input.replayKey,
          input.traceId,
          input.day,
          input.now.toISOString(),
        );
      this.db.exec("COMMIT");
      return { kind: "reserved", receipt: this.getReceipt(id)! };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finishReceipt(input: { id: string; status: "succeeded" | "failed" | "not_run"; error?: string | null; now: Date }) {
    this.db
      .prepare(
        "UPDATE agent_outward_receipt SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'executing'",
      )
      .run(input.status, input.error ?? null, input.now.toISOString(), input.id);
    return this.getReceipt(input.id);
  }

  getReceipt(id: string) {
    const row = this.db.prepare("SELECT * FROM agent_outward_receipt WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? receiptFromRow(row) : null;
  }

  listReceipts(input: { workspaceSlug: string; agentId?: string; limit?: number }) {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_outward_receipt WHERE workspace_slug = ? AND (? IS NULL OR agent_id = ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(input.workspaceSlug, input.agentId ?? null, input.agentId ?? null, Math.min(input.limit ?? 100, 500)) as Array<
      Record<string, unknown>
    >;
    return rows.map(receiptFromRow);
  }
}

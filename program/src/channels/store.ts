import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { sha256Hex } from "./canonical-json.js";
import {
  effectiveCaps,
  validatePolicy,
  type ChannelCaps,
  type ChannelKind,
  type ChannelPolicy,
  type ChannelPolicyInput,
  type GrantCaps,
  type GrantScope,
  type PostCampaign,
} from "./policy.js";

/**
 * Channels schema and store (spec §4). Additive only: every table is created
 * with `CREATE TABLE IF NOT EXISTS`, nothing existing is altered, so 0.1.19
 * starts on a data directory that already holds these tables and ignores them.
 *
 * No credentials live here. Connections keep a `credentialRef` in the
 * existing `connector_connection` table; these rows hold destinations,
 * policy, grants, posts, attachment metadata and receipts only.
 */

export const CHANNEL_TABLES = [
  "channel",
  "channel_standing_grant",
  "channel_post",
  "channel_attachment",
  "channel_receipt",
  "marketplace_used_approval_proof",
] as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const CHANNEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;

/** Relative to the Marketplace data directory (`/data` in the hosted image). */
export const CHANNEL_ATTACHMENTS_SUBDIR = path.join("channels", "attachments");

export function migrateChannelTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      destination_json TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      policy_json TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_slug, slug)
    );

    CREATE TABLE IF NOT EXISTS channel_standing_grant (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      workspace_slug TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      consent_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      caps_json TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      not_before TEXT,
      expires TEXT NOT NULL,
      status TEXT NOT NULL,
      digest TEXT,
      proposed_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      approval_source TEXT,
      decided_reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_standing_grant_scope
    ON channel_standing_grant(workspace_slug, channel_id, agent_id, status);

    CREATE TABLE IF NOT EXISTS channel_post (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      consent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      send_at TEXT,
      text TEXT NOT NULL,
      attachment_ids_json TEXT NOT NULL DEFAULT '[]',
      campaign_ref TEXT,
      campaign_phase TEXT,
      digest TEXT NOT NULL,
      authority TEXT,
      status TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      claimed_by TEXT,
      claim_expires_at TEXT,
      reason TEXT,
      reserved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_slug, agent_id, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_channel_post_caps
    ON channel_post(channel_id, status, reserved_at);

    CREATE INDEX IF NOT EXISTS idx_channel_post_due
    ON channel_post(status, send_at);

    CREATE TABLE IF NOT EXISTS channel_attachment (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      content_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_receipt (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL UNIQUE,
      workspace_slug TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      digest TEXT NOT NULL,
      authority TEXT,
      status TEXT NOT NULL,
      result_ids_json TEXT NOT NULL DEFAULT '[]',
      result_urls_json TEXT NOT NULL DEFAULT '[]',
      detail TEXT,
      text TEXT,
      approved_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_receipt_scope
    ON channel_receipt(workspace_slug, agent_id, created_at);

    CREATE TABLE IF NOT EXISTS marketplace_used_approval_proof (
      proof_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type ChannelStatus = "draft" | "active" | "paused" | "archived";

export type ChannelDestination = {
  type: string;
  externalId: string;
  title: string;
  url?: string;
};

export type ChannelRecord = {
  id: string;
  workspaceSlug: string;
  slug: string;
  label: string;
  kind: ChannelKind;
  provider: string;
  connectionId: string;
  destination: ChannelDestination;
  audience: string;
  language: string;
  purpose: string;
  policy: ChannelPolicy;
  status: ChannelStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type StandingGrantStatus =
  | "proposed"
  | "active"
  | "suspended"
  | "withdrawn"
  | "revoked"
  | "expired"
  | "declined";

export type StandingGrantRecord = {
  id: string;
  channelId: string;
  workspaceSlug: string;
  agentId: string;
  consentId: string;
  purpose: string;
  caps: GrantCaps;
  scope: GrantScope;
  notBefore: string | null;
  expires: string;
  status: StandingGrantStatus;
  digest: string | null;
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalSource: "marketplace-ui" | "buzz-signed" | null;
  decidedReason: string | null;
  updatedAt: string;
};

export type ChannelPostStatus =
  | "held"
  | "scheduled"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "skipped"
  | "cancelled"
  | "expired";

/** `grant:<id>`, `approval:<id>` or `owner-test`. */
export type ChannelPostAuthority = `grant:${string}` | `approval:${string}` | "owner-test";

export type ChannelPostRecord = {
  id: string;
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  consentId: string;
  mode: "immediate" | "scheduled";
  sendAt: string | null;
  text: string;
  attachmentIds: string[];
  campaign: PostCampaign;
  digest: string;
  authority: ChannelPostAuthority | null;
  status: ChannelPostStatus;
  idempotencyKey: string;
  claimedBy: string | null;
  claimExpiresAt: string | null;
  reason: string | null;
  /** When the post was counted against caps (entered `sending`). */
  reservedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelAttachmentRecord = {
  id: string;
  workspaceSlug: string;
  sha256: string;
  contentType: string;
  bytes: number;
  name: string;
  createdBy: string;
  createdAt: string;
};

export type ChannelReceiptStatus =
  | "sent"
  | "failed"
  | "uncertain"
  | "pending"
  | "skipped"
  | "cancelled"
  | "expired";

export type ChannelReceiptRecord = {
  id: string;
  postId: string;
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  provider: string;
  digest: string;
  authority: string | null;
  status: ChannelReceiptStatus;
  resultIds: string[];
  resultUrls: string[];
  detail: string | null;
  text: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

/** Statuses that count against caps (§4.4 rule 6, §6 step 4). */
export const COUNTED_POST_STATUSES = ["sending", "sent", "uncertain"] as const;
const COUNTED_SQL = COUNTED_POST_STATUSES.map((status) => `'${status}'`).join(", ");

export type ChannelCapError =
  | "channel_cap_per_day"
  | "channel_cap_per_hour"
  | "channel_min_interval"
  | "channel_phase_duplicate";

export class ChannelStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChannelStoreError";
  }
}

type Row = Record<string, unknown>;

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ChannelStoreError("channel_invalid_time", `Invalid time ${String(value)}`);
  }
  return date.toISOString();
}

function optionalIso(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : iso(value);
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function json<T>(value: unknown, fallback: T): T {
  return typeof value === "string" && value ? (JSON.parse(value) as T) : fallback;
}

function channelFromRow(row: Row): ChannelRecord {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    slug: String(row.slug),
    label: String(row.label),
    kind: row.kind as ChannelKind,
    provider: String(row.provider),
    connectionId: String(row.connection_id),
    destination: json<ChannelDestination>(row.destination_json, { type: "", externalId: "", title: "" }),
    audience: String(row.audience),
    language: String(row.language),
    purpose: String(row.purpose),
    policy: json<ChannelPolicy>(row.policy_json, {} as ChannelPolicy),
    status: row.status as ChannelStatus,
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function grantFromRow(row: Row): StandingGrantRecord {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    workspaceSlug: String(row.workspace_slug),
    agentId: String(row.agent_id),
    consentId: String(row.consent_id),
    purpose: String(row.purpose),
    caps: json<GrantCaps>(row.caps_json, { perDay: 0, minIntervalSeconds: 0, onePerPhase: true }),
    scope: json<GrantScope>(row.scope_json, { files: false, immediate: false, scheduled: false }),
    notBefore: text(row.not_before),
    expires: String(row.expires),
    status: row.status as StandingGrantStatus,
    digest: text(row.digest),
    proposedAt: String(row.proposed_at),
    approvedBy: text(row.approved_by),
    approvedAt: text(row.approved_at),
    approvalSource: text(row.approval_source) as StandingGrantRecord["approvalSource"],
    decidedReason: text(row.decided_reason),
    updatedAt: String(row.updated_at),
  };
}

function postFromRow(row: Row): ChannelPostRecord {
  const campaign: PostCampaign = {};
  if (row.campaign_ref !== null && row.campaign_ref !== undefined) campaign.ref = String(row.campaign_ref);
  if (row.campaign_phase !== null && row.campaign_phase !== undefined) campaign.phase = String(row.campaign_phase);
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    channelId: String(row.channel_id),
    agentId: String(row.agent_id),
    consentId: String(row.consent_id),
    mode: row.mode as ChannelPostRecord["mode"],
    sendAt: text(row.send_at),
    text: String(row.text),
    attachmentIds: json<string[]>(row.attachment_ids_json, []),
    campaign,
    digest: String(row.digest),
    authority: text(row.authority) as ChannelPostAuthority | null,
    status: row.status as ChannelPostStatus,
    idempotencyKey: String(row.idempotency_key),
    claimedBy: text(row.claimed_by),
    claimExpiresAt: text(row.claim_expires_at),
    reason: text(row.reason),
    reservedAt: text(row.reserved_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function attachmentFromRow(row: Row): ChannelAttachmentRecord {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    sha256: String(row.sha256),
    contentType: String(row.content_type),
    bytes: Number(row.bytes),
    name: String(row.name),
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
  };
}

function receiptFromRow(row: Row): ChannelReceiptRecord {
  return {
    id: String(row.id),
    postId: String(row.post_id),
    workspaceSlug: String(row.workspace_slug),
    channelId: String(row.channel_id),
    agentId: String(row.agent_id),
    provider: String(row.provider),
    digest: String(row.digest),
    authority: text(row.authority),
    status: row.status as ChannelReceiptStatus,
    resultIds: json<string[]>(row.result_ids_json, []),
    resultUrls: json<string[]>(row.result_urls_json, []),
    detail: text(row.detail),
    text: text(row.text),
    approvedAt: text(row.approved_at),
    sentAt: text(row.sent_at),
    createdAt: String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type CreateChannelInput = {
  workspaceSlug: string;
  slug: string;
  label: string;
  kind: ChannelKind;
  provider: string;
  connectionId: string;
  destination: ChannelDestination;
  audience?: string;
  language?: string;
  purpose?: string;
  policy?: ChannelPolicyInput;
  status?: ChannelStatus;
  now?: Date | string;
};

export type UpdateChannelPatch = {
  label?: string;
  destination?: ChannelDestination;
  audience?: string;
  language?: string;
  purpose?: string;
  policy?: ChannelPolicyInput;
  status?: ChannelStatus;
  now?: Date | string;
};

export type CreateStandingGrantInput = {
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  consentId: string;
  purpose: string;
  caps: GrantCaps;
  scope: GrantScope;
  notBefore?: string | null;
  expires: string;
  now?: Date | string;
};

export type UpdateStandingGrantPatch = {
  caps?: GrantCaps;
  scope?: GrantScope;
  notBefore?: string | null;
  expires?: string;
  status?: StandingGrantStatus;
  digest?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalSource?: StandingGrantRecord["approvalSource"];
  decidedReason?: string | null;
  now?: Date | string;
};

export type ChannelPostFields = {
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  consentId: string;
  mode: "immediate" | "scheduled";
  sendAt?: string | null;
  text: string;
  attachmentIds?: string[];
  campaign?: PostCampaign | null;
  digest: string;
  authority?: ChannelPostAuthority | null;
  idempotencyKey: string;
  reason?: string | null;
};

export type InsertPostInput = ChannelPostFields & {
  status: ChannelPostStatus;
  now?: Date | string;
};

export type ReservationGrant = {
  id: string;
  caps: GrantCaps;
};

export type ReservePostInput = ChannelPostFields & {
  /** The standing grant that authorises this post, if any. */
  grant?: ReservationGrant | null;
  /** The channel ceiling caps at reservation time. */
  ceiling: ChannelCaps;
  now: Date | string;
};

export type ReservePostResult =
  | { ok: true; post: ChannelPostRecord; replayed: boolean }
  | { ok: false; error: ChannelCapError; retryAfterSeconds?: number };

export type ReserveScheduledPostInput = {
  workspaceSlug: string;
  postId: string;
  /** Must hold the claim. */
  claimer: string;
  grant?: ReservationGrant | null;
  ceiling: ChannelCaps;
  now: Date | string;
};

export type ReserveScheduledPostResult =
  | { ok: true; post: ChannelPostRecord }
  | { ok: false; error: ChannelCapError | "channel_post_not_claimed"; retryAfterSeconds?: number };

export type InsertReceiptInput = {
  postId: string;
  workspaceSlug: string;
  channelId: string;
  agentId: string;
  provider: string;
  digest: string;
  authority?: string | null;
  status: ChannelReceiptStatus;
  resultIds?: string[];
  resultUrls?: string[];
  detail?: string | null;
  text?: string | null;
  approvedAt?: string | null;
  sentAt?: string | null;
  now?: Date | string;
};

// ---------------------------------------------------------------------------
// Attachment bytes on disk
// ---------------------------------------------------------------------------

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Writes attachment bytes to `<rootDir>/<sha256>` atomically (temp file in the
 * same directory, fsync, rename). When `expectedSha256` is given, a mismatch
 * throws before anything is written. Content-addressed: an existing file with
 * the same hash is kept after its bytes are verified.
 */
export function writeAttachmentBytes(
  rootDir: string,
  bytes: Uint8Array,
  expectedSha256?: string,
): { sha256: string; path: string; bytes: number } {
  const sha256 = sha256Hex(bytes);
  if (expectedSha256 !== undefined && expectedSha256.toLowerCase() !== sha256) {
    throw new ChannelStoreError("channel_attachment_digest_mismatch", "Attachment bytes do not match the expected SHA-256.");
  }
  fs.mkdirSync(rootDir, { recursive: true });
  const target = path.join(rootDir, sha256);
  if (fs.existsSync(target) && sha256Hex(fs.readFileSync(target)) === sha256) {
    return { sha256, path: target, bytes: bytes.byteLength };
  }
  const temp = path.join(rootDir, `.${sha256}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return { sha256, path: target, bytes: bytes.byteLength };
}

/** Reads attachment bytes and verifies them against their content address. */
export function readAttachmentBytes(rootDir: string, sha256: string): Buffer {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new ChannelStoreError("channel_attachment_invalid", "Invalid attachment SHA-256.");
  }
  const bytes = fs.readFileSync(path.join(rootDir, sha256));
  if (sha256Hex(bytes) !== sha256) {
    throw new ChannelStoreError("channel_attachment_digest_mismatch", "Stored attachment bytes are corrupt.");
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ChannelStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Runs `fn` inside `BEGIN IMMEDIATE`, rolling back on any throw. */
  private immediate<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ----- channel -----------------------------------------------------------

  createChannel(input: CreateChannelInput): ChannelRecord {
    if (!CHANNEL_SLUG_PATTERN.test(input.slug)) {
      throw new ChannelStoreError("channel_slug_invalid", "Channel slug must match ^[a-z0-9][a-z0-9-]{1,47}$.");
    }
    const policy = this.normalizePolicy(input.policy);
    const id = createId("chn");
    const timestamp = iso(input.now ?? new Date());
    try {
      this.db
        .prepare(
          `INSERT INTO channel (
            id, workspace_slug, slug, label, kind, provider, connection_id, destination_json,
            audience, language, purpose, policy_json, status, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.workspaceSlug,
          input.slug,
          input.label,
          input.kind,
          input.provider,
          input.connectionId,
          JSON.stringify(input.destination),
          input.audience ?? "",
          input.language ?? "",
          input.purpose ?? "",
          JSON.stringify(policy),
          input.status ?? "draft",
          timestamp,
          timestamp,
        );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new ChannelStoreError("channel_slug_taken", `Channel slug ${input.slug} already exists in this workspace.`);
      }
      throw error;
    }
    return this.getChannel(input.workspaceSlug, id)!;
  }

  getChannel(workspaceSlug: string, id: string): ChannelRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel WHERE workspace_slug = ? AND id = ?")
      .get(workspaceSlug, id) as Row | undefined;
    return row ? channelFromRow(row) : null;
  }

  getChannelBySlug(workspaceSlug: string, slug: string): ChannelRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel WHERE workspace_slug = ? AND slug = ?")
      .get(workspaceSlug, slug) as Row | undefined;
    return row ? channelFromRow(row) : null;
  }

  listChannels(workspaceSlug: string, filter: { status?: ChannelStatus } = {}): ChannelRecord[] {
    const rows = (
      filter.status
        ? this.db
            .prepare("SELECT * FROM channel WHERE workspace_slug = ? AND status = ? ORDER BY slug")
            .all(workspaceSlug, filter.status)
        : this.db.prepare("SELECT * FROM channel WHERE workspace_slug = ? ORDER BY slug").all(workspaceSlug)
    ) as Row[];
    return rows.map(channelFromRow);
  }

  /**
   * Updates a channel. A policy change bumps `revision` (§4.2); re-checking
   * grants against the new ceiling is the caller's job (grants package).
   * `expectRevision` makes the update a compare-and-set.
   */
  updateChannel(
    workspaceSlug: string,
    id: string,
    patch: UpdateChannelPatch,
    options: { expectRevision?: number } = {},
  ): ChannelRecord {
    const current = this.getChannel(workspaceSlug, id);
    if (!current) throw new ChannelStoreError("channel_not_found", "Channel not found.");
    if (options.expectRevision !== undefined && current.revision !== options.expectRevision) {
      throw new ChannelStoreError("channel_revision_conflict", "Channel changed since it was read.");
    }
    const policy = patch.policy === undefined ? current.policy : this.normalizePolicy(patch.policy);
    const policyChanged = JSON.stringify(policy) !== JSON.stringify(current.policy);
    const result = this.db
      .prepare(
        `UPDATE channel SET label = ?, destination_json = ?, audience = ?, language = ?, purpose = ?,
          policy_json = ?, status = ?, revision = revision + ?, updated_at = ?
        WHERE workspace_slug = ? AND id = ? AND revision = ?`,
      )
      .run(
        patch.label ?? current.label,
        JSON.stringify(patch.destination ?? current.destination),
        patch.audience ?? current.audience,
        patch.language ?? current.language,
        patch.purpose ?? current.purpose,
        JSON.stringify(policy),
        patch.status ?? current.status,
        policyChanged ? 1 : 0,
        iso(patch.now ?? new Date()),
        workspaceSlug,
        id,
        current.revision,
      );
    if (Number(result.changes) !== 1) {
      throw new ChannelStoreError("channel_revision_conflict", "Channel changed since it was read.");
    }
    return this.getChannel(workspaceSlug, id)!;
  }

  setChannelStatus(workspaceSlug: string, id: string, status: ChannelStatus, now?: Date | string): ChannelRecord {
    return this.updateChannel(workspaceSlug, id, { status, now });
  }

  private normalizePolicy(input: ChannelPolicyInput | undefined): ChannelPolicy {
    const result = validatePolicy(input);
    if (!result.ok) {
      throw new ChannelStoreError(
        result.error,
        `Invalid channel policy: ${result.errors.map((error) => error.field).join(", ")}`,
      );
    }
    return result.policy;
  }

  // ----- standing grant ----------------------------------------------------

  createStandingGrant(input: CreateStandingGrantInput): StandingGrantRecord {
    const purpose = input.purpose.trim();
    if (purpose.length < 1 || purpose.length > 300) {
      throw new ChannelStoreError("grant_purpose_invalid", "Grant purpose must be 1–300 characters.");
    }
    const id = createId("chg");
    const timestamp = iso(input.now ?? new Date());
    this.db
      .prepare(
        `INSERT INTO channel_standing_grant (
          id, channel_id, workspace_slug, agent_id, consent_id, purpose, caps_json, scope_json,
          not_before, expires, status, digest, proposed_at, approved_by, approved_at, approval_source,
          decided_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.channelId,
        input.workspaceSlug,
        input.agentId,
        input.consentId,
        purpose,
        JSON.stringify(input.caps),
        JSON.stringify(input.scope),
        optionalIso(input.notBefore),
        iso(input.expires),
        timestamp,
        timestamp,
      );
    return this.getStandingGrant(input.workspaceSlug, id)!;
  }

  getStandingGrant(workspaceSlug: string, id: string): StandingGrantRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_standing_grant WHERE workspace_slug = ? AND id = ?")
      .get(workspaceSlug, id) as Row | undefined;
    return row ? grantFromRow(row) : null;
  }

  listStandingGrants(
    workspaceSlug: string,
    filter: { channelId?: string; agentId?: string; status?: StandingGrantStatus } = {},
  ): StandingGrantRecord[] {
    const clauses = ["workspace_slug = ?"];
    const params: string[] = [workspaceSlug];
    if (filter.channelId) {
      clauses.push("channel_id = ?");
      params.push(filter.channelId);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const rows = this.db
      .prepare(`SELECT * FROM channel_standing_grant WHERE ${clauses.join(" AND ")} ORDER BY proposed_at, id`)
      .all(...params) as Row[];
    return rows.map(grantFromRow);
  }

  /**
   * Updates a grant. `expectStatus` makes it a compare-and-set on status, so
   * two concurrent decisions (approve vs revoke) cannot both win. Returns
   * null when the guard fails.
   */
  updateStandingGrant(
    workspaceSlug: string,
    id: string,
    patch: UpdateStandingGrantPatch,
    options: { expectStatus?: StandingGrantStatus | StandingGrantStatus[] } = {},
  ): StandingGrantRecord | null {
    const current = this.getStandingGrant(workspaceSlug, id);
    if (!current) throw new ChannelStoreError("grant_not_found", "Standing grant not found.");
    const expected = options.expectStatus === undefined
      ? [current.status]
      : Array.isArray(options.expectStatus) ? options.expectStatus : [options.expectStatus];
    if (!expected.includes(current.status)) return null;
    const pick = <K extends keyof UpdateStandingGrantPatch>(key: K, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback;
    const result = this.db
      .prepare(
        `UPDATE channel_standing_grant SET caps_json = ?, scope_json = ?, not_before = ?, expires = ?,
          status = ?, digest = ?, approved_by = ?, approved_at = ?, approval_source = ?, decided_reason = ?,
          updated_at = ?
        WHERE workspace_slug = ? AND id = ? AND status = ? AND updated_at = ?`,
      )
      .run(
        JSON.stringify(patch.caps ?? current.caps),
        JSON.stringify(patch.scope ?? current.scope),
        optionalIso(pick("notBefore", current.notBefore) as string | null),
        iso(patch.expires ?? current.expires),
        patch.status ?? current.status,
        pick("digest", current.digest) as string | null,
        pick("approvedBy", current.approvedBy) as string | null,
        optionalIso(pick("approvedAt", current.approvedAt) as string | null),
        pick("approvalSource", current.approvalSource) as string | null,
        pick("decidedReason", current.decidedReason) as string | null,
        iso(patch.now ?? new Date()),
        workspaceSlug,
        id,
        current.status,
        current.updatedAt,
      );
    return Number(result.changes) === 1 ? this.getStandingGrant(workspaceSlug, id) : null;
  }

  // ----- post --------------------------------------------------------------

  /**
   * Inserts a post (e.g. `held` or `scheduled`). Idempotent on
   * (workspace, agent, idempotency key): a repeat returns the existing row
   * with `created: false`; comparing its digest is the caller's job.
   */
  insertPost(input: InsertPostInput): { post: ChannelPostRecord; created: boolean } {
    const timestamp = iso(input.now ?? new Date());
    return this.immediate(() => {
      const existing = this.getPostByIdempotencyKey(input.workspaceSlug, input.agentId, input.idempotencyKey);
      if (existing) return { post: existing, created: false };
      const id = this.insertPostRow(input, input.status, timestamp, null);
      return { post: this.getPost(input.workspaceSlug, id)!, created: true };
    });
  }

  private insertPostRow(
    input: ChannelPostFields,
    status: ChannelPostStatus,
    timestamp: string,
    reservedAt: string | null,
  ): string {
    if (input.mode === "scheduled" && !input.sendAt) {
      throw new ChannelStoreError("channel_send_at_required", "A scheduled post needs sendAt.");
    }
    const id = createId("chp");
    this.db
      .prepare(
        `INSERT INTO channel_post (
          id, workspace_slug, channel_id, agent_id, consent_id, mode, send_at, text, attachment_ids_json,
          campaign_ref, campaign_phase, digest, authority, status, idempotency_key, claimed_by,
          claim_expires_at, reason, reserved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.channelId,
        input.agentId,
        input.consentId,
        input.mode,
        optionalIso(input.sendAt),
        input.text,
        JSON.stringify(input.attachmentIds ?? []),
        input.campaign?.ref ?? null,
        input.campaign?.phase ?? null,
        input.digest,
        input.authority ?? null,
        status,
        input.idempotencyKey,
        input.reason ?? null,
        reservedAt,
        timestamp,
        timestamp,
      );
    return id;
  }

  getPost(workspaceSlug: string, id: string): ChannelPostRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_post WHERE workspace_slug = ? AND id = ?")
      .get(workspaceSlug, id) as Row | undefined;
    return row ? postFromRow(row) : null;
  }

  getPostByIdempotencyKey(workspaceSlug: string, agentId: string, idempotencyKey: string): ChannelPostRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_post WHERE workspace_slug = ? AND agent_id = ? AND idempotency_key = ?")
      .get(workspaceSlug, agentId, idempotencyKey) as Row | undefined;
    return row ? postFromRow(row) : null;
  }

  listPosts(
    workspaceSlug: string,
    filter: { channelId?: string; agentId?: string; status?: ChannelPostStatus; limit?: number } = {},
  ): ChannelPostRecord[] {
    const clauses = ["workspace_slug = ?"];
    const params: Array<string | number> = [workspaceSlug];
    if (filter.channelId) {
      clauses.push("channel_id = ?");
      params.push(filter.channelId);
    }
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
    const rows = this.db
      .prepare(`SELECT * FROM channel_post WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT ?`)
      .all(...params) as Row[];
    return rows.map(postFromRow);
  }

  /**
   * Moves a post to a new status and clears any scheduler claim. Guards:
   * `from` (allowed current statuses) and `claimer` (must hold the claim).
   * Returns null when a guard fails, so a lost race is visible to the caller.
   */
  finishPost(
    workspaceSlug: string,
    id: string,
    update: {
      status: ChannelPostStatus;
      reason?: string | null;
      from?: ChannelPostStatus[];
      claimer?: string;
      now?: Date | string;
    },
  ): ChannelPostRecord | null {
    const clauses = ["workspace_slug = ?", "id = ?"];
    const params: string[] = [workspaceSlug, id];
    if (update.from && update.from.length > 0) {
      clauses.push(`status IN (${update.from.map(() => "?").join(", ")})`);
      params.push(...update.from);
    }
    if (update.claimer !== undefined) {
      clauses.push("claimed_by = ?");
      params.push(update.claimer);
    }
    const result = this.db
      .prepare(
        `UPDATE channel_post SET status = ?, reason = COALESCE(?, reason), claimed_by = NULL,
          claim_expires_at = NULL, updated_at = ?
        WHERE ${clauses.join(" AND ")}`,
      )
      .run(update.status, update.reason ?? null, iso(update.now ?? new Date()), ...params);
    return Number(result.changes) === 1 ? this.getPost(workspaceSlug, id) : null;
  }

  /**
   * Claims due scheduled posts for one scheduler tick, across workspaces. One
   * guarded UPDATE: a row is taken only while `status = 'scheduled'`, it is
   * due, and it is unclaimed or its lease has expired (takeover after a crash
   * or a redeploy overlap). The claim stays until `finishPost` clears it; a
   * post that has moved to `sending` is never claimable again.
   */
  claimDuePosts(input: { now: Date | string; claimer: string; leaseMs: number; limit?: number }): ChannelPostRecord[] {
    const now = iso(input.now);
    const leaseUntil = new Date(Date.parse(now) + Math.max(input.leaseMs, 1)).toISOString();
    const due = "status = 'scheduled' AND send_at <= ? AND (claimed_by IS NULL OR claim_expires_at < ?)";
    const rows = this.db
      .prepare(
        `UPDATE channel_post SET claimed_by = ?, claim_expires_at = ?, updated_at = ?
        WHERE id IN (SELECT id FROM channel_post WHERE ${due} ORDER BY send_at, id LIMIT ?)
          AND ${due}
        RETURNING *`,
      )
      .all(
        input.claimer,
        leaseUntil,
        now,
        now,
        now,
        Math.min(Math.max(input.limit ?? 25, 1), 500),
        now,
        now,
      ) as Row[];
    return rows
      .map(postFromRow)
      .sort((a, b) => (a.sendAt ?? "").localeCompare(b.sendAt ?? "") || a.id.localeCompare(b.id));
  }

  // ----- caps reservation (§4.4 rule 6, §6 step 3d, §9) ---------------------

  /**
   * Counts caps and inserts the post as `sending` in one `BEGIN IMMEDIATE`
   * transaction, so two concurrent sends cannot both pass the last slot.
   * Counted statuses: `sending`, `sent`, `uncertain`. The channel ceiling is
   * shared by every agent; grant caps apply to the grant's own posts.
   * Idempotent: a repeat of (workspace, agent, idempotency key) returns the
   * existing row with `replayed: true` and inserts nothing.
   */
  reservePost(input: ReservePostInput): ReservePostResult {
    const now = iso(input.now);
    if (input.grant && input.authority && input.authority !== `grant:${input.grant.id}`) {
      throw new ChannelStoreError("channel_authority_mismatch", "Authority does not name the reserving grant.");
    }
    return this.immediate<ReservePostResult>(() => {
      const existing = this.getPostByIdempotencyKey(input.workspaceSlug, input.agentId, input.idempotencyKey);
      if (existing) return { ok: true, post: existing, replayed: true };
      const refusal = this.checkCaps({
        channelId: input.channelId,
        grant: input.grant ?? null,
        ceiling: input.ceiling,
        campaign: input.campaign ?? null,
        now,
        excludePostId: null,
      });
      if (refusal) return refusal;
      const authority = input.authority ?? (input.grant ? (`grant:${input.grant.id}` as const) : null);
      const id = this.insertPostRow({ ...input, authority }, "sending", now, now);
      return { ok: true, post: this.getPost(input.workspaceSlug, id)!, replayed: false };
    });
  }

  /**
   * Send-time reservation for a claimed scheduled post (§6 "Scheduled
   * posts": 3d repeats at send time). Moves `scheduled` → `sending` under the
   * same transactional caps check; the claim stays until `finishPost`.
   */
  reserveScheduledPost(input: ReserveScheduledPostInput): ReserveScheduledPostResult {
    const now = iso(input.now);
    return this.immediate<ReserveScheduledPostResult>(() => {
      const post = this.getPost(input.workspaceSlug, input.postId);
      if (!post || post.status !== "scheduled" || post.claimedBy !== input.claimer) {
        return { ok: false, error: "channel_post_not_claimed" };
      }
      if (input.grant && post.authority !== `grant:${input.grant.id}`) {
        throw new ChannelStoreError("channel_authority_mismatch", "Authority does not name the reserving grant.");
      }
      const refusal = this.checkCaps({
        channelId: post.channelId,
        grant: input.grant ?? null,
        ceiling: input.ceiling,
        campaign: post.campaign,
        now,
        excludePostId: post.id,
      });
      if (refusal) return refusal;
      this.db
        .prepare(
          `UPDATE channel_post SET status = 'sending', reserved_at = ?, updated_at = ?
          WHERE workspace_slug = ? AND id = ? AND status = 'scheduled' AND claimed_by = ?`,
        )
        .run(now, now, input.workspaceSlug, input.postId, input.claimer);
      return { ok: true, post: this.getPost(input.workspaceSlug, input.postId)! };
    });
  }

  private checkCaps(input: {
    channelId: string;
    grant: ReservationGrant | null;
    ceiling: ChannelCaps;
    campaign: PostCampaign | null;
    now: string;
    excludePostId: string | null;
  }): { ok: false; error: ChannelCapError; retryAfterSeconds?: number } | null {
    const nowMs = Date.parse(input.now);
    const exclude = input.excludePostId ?? "";
    const caps = effectiveCaps(input.grant?.caps ?? null, input.ceiling);

    // (d) one post per (channel, campaign ref, phase); needs both ref and phase.
    if (caps.onePerPhase && input.campaign?.ref && input.campaign.phase) {
      const duplicate = this.db
        .prepare(
          `SELECT 1 FROM channel_post WHERE channel_id = ? AND status IN (${COUNTED_SQL})
            AND campaign_ref = ? AND campaign_phase = ? AND id <> ? LIMIT 1`,
        )
        .get(input.channelId, input.campaign.ref, input.campaign.phase, exclude);
      if (duplicate) return { ok: false, error: "channel_phase_duplicate" };
    }

    // (a)+(c) channel ceiling, shared by all agents; (b)+(c) the grant's own posts.
    const scopes: Array<{ where: string; params: string[]; caps: ChannelCaps }> = [
      { where: "channel_id = ?", params: [input.channelId], caps: input.ceiling },
    ];
    if (input.grant) {
      scopes.push({
        where: "channel_id = ? AND authority = ?",
        params: [input.channelId, `grant:${input.grant.id}`],
        caps,
      });
    }
    for (const scope of scopes) {
      const refusal =
        this.windowRefusal(scope, exclude, nowMs, DAY_MS, scope.caps.perDay, "channel_cap_per_day") ??
        (scope.caps.perHour !== undefined
          ? this.windowRefusal(scope, exclude, nowMs, HOUR_MS, scope.caps.perHour, "channel_cap_per_hour")
          : null);
      if (refusal) return refusal;
      if (scope.caps.minIntervalSeconds > 0) {
        const last = this.db
          .prepare(
            `SELECT MAX(reserved_at) AS last FROM channel_post
            WHERE ${scope.where} AND status IN (${COUNTED_SQL}) AND id <> ?`,
          )
          .get(...scope.params, exclude) as { last: string | null } | undefined;
        if (last?.last) {
          const waitMs = Date.parse(last.last) + scope.caps.minIntervalSeconds * 1000 - nowMs;
          if (waitMs > 0) {
            return { ok: false, error: "channel_min_interval", retryAfterSeconds: Math.ceil(waitMs / 1000) };
          }
        }
      }
    }
    return null;
  }

  private windowRefusal(
    scope: { where: string; params: string[] },
    exclude: string,
    nowMs: number,
    windowMs: number,
    limit: number,
    error: "channel_cap_per_day" | "channel_cap_per_hour",
  ): { ok: false; error: ChannelCapError; retryAfterSeconds: number } | null {
    const since = new Date(nowMs - windowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT reserved_at FROM channel_post
        WHERE ${scope.where} AND status IN (${COUNTED_SQL}) AND reserved_at > ? AND id <> ?
        ORDER BY reserved_at`,
      )
      .all(...scope.params, since, exclude) as Array<{ reserved_at: string }>;
    if (rows.length < limit) return null;
    // The slot frees when enough of the oldest counted posts leave the window.
    const freeing = rows[rows.length - limit]!;
    const waitMs = Date.parse(freeing.reserved_at) + windowMs - nowMs;
    return { ok: false, error, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  // ----- attachment --------------------------------------------------------

  insertAttachment(input: {
    workspaceSlug: string;
    sha256: string;
    contentType: string;
    bytes: number;
    name: string;
    createdBy: string;
    now?: Date | string;
  }): ChannelAttachmentRecord {
    if (!SHA256_PATTERN.test(input.sha256)) {
      throw new ChannelStoreError("channel_attachment_invalid", "Invalid attachment SHA-256.");
    }
    if (!Number.isInteger(input.bytes) || input.bytes < 0) {
      throw new ChannelStoreError("channel_attachment_invalid", "Invalid attachment size.");
    }
    const id = createId("cha");
    this.db
      .prepare(
        `INSERT INTO channel_attachment (id, workspace_slug, sha256, content_type, bytes, name, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceSlug,
        input.sha256,
        input.contentType,
        input.bytes,
        input.name,
        input.createdBy,
        iso(input.now ?? new Date()),
      );
    return this.getAttachment(input.workspaceSlug, id)!;
  }

  getAttachment(workspaceSlug: string, id: string): ChannelAttachmentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_attachment WHERE workspace_slug = ? AND id = ?")
      .get(workspaceSlug, id) as Row | undefined;
    return row ? attachmentFromRow(row) : null;
  }

  /** Returns attachments in the order of `ids`; unknown ids are omitted. */
  getAttachments(workspaceSlug: string, ids: string[]): ChannelAttachmentRecord[] {
    return ids
      .map((id) => this.getAttachment(workspaceSlug, id))
      .filter((record): record is ChannelAttachmentRecord => record !== null);
  }

  // ----- receipt -----------------------------------------------------------

  /** One receipt per post; a later call (e.g. pending → sent) replaces it. */
  upsertReceipt(input: InsertReceiptInput): ChannelReceiptRecord {
    const timestamp = iso(input.now ?? new Date());
    this.db
      .prepare(
        `INSERT INTO channel_receipt (
          id, post_id, workspace_slug, channel_id, agent_id, provider, digest, authority, status,
          result_ids_json, result_urls_json, detail, text, approved_at, sent_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_id) DO UPDATE SET
          status = excluded.status,
          authority = excluded.authority,
          result_ids_json = excluded.result_ids_json,
          result_urls_json = excluded.result_urls_json,
          detail = excluded.detail,
          text = excluded.text,
          approved_at = excluded.approved_at,
          sent_at = excluded.sent_at
        WHERE channel_receipt.workspace_slug = excluded.workspace_slug`,
      )
      .run(
        createId("chr"),
        input.postId,
        input.workspaceSlug,
        input.channelId,
        input.agentId,
        input.provider,
        input.digest,
        input.authority ?? null,
        input.status,
        JSON.stringify(input.resultIds ?? []),
        JSON.stringify(input.resultUrls ?? []),
        input.detail ?? null,
        input.text ?? null,
        optionalIso(input.approvedAt),
        optionalIso(input.sentAt),
        timestamp,
      );
    const receipt = this.getReceiptByPost(input.workspaceSlug, input.postId);
    if (!receipt) throw new ChannelStoreError("channel_receipt_conflict", "Receipt belongs to another workspace.");
    return receipt;
  }

  getReceiptByPost(workspaceSlug: string, postId: string): ChannelReceiptRecord | null {
    const row = this.db
      .prepare("SELECT * FROM channel_receipt WHERE workspace_slug = ? AND post_id = ?")
      .get(workspaceSlug, postId) as Row | undefined;
    return row ? receiptFromRow(row) : null;
  }

  listReceipts(
    workspaceSlug: string,
    filter: { agentId?: string; channelId?: string; limit?: number } = {},
  ): ChannelReceiptRecord[] {
    const clauses = ["workspace_slug = ?"];
    const params: Array<string | number> = [workspaceSlug];
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.channelId) {
      clauses.push("channel_id = ?");
      params.push(filter.channelId);
    }
    params.push(Math.min(Math.max(filter.limit ?? 100, 1), 1000));
    const rows = this.db
      .prepare(`SELECT * FROM channel_receipt WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id LIMIT ?`)
      .all(...params) as Row[];
    return rows.map(receiptFromRow);
  }

  /** Retention (§7): deletes receipts created before `before`. Returns the count. */
  purgeReceipts(workspaceSlug: string, before: Date | string): number {
    const result = this.db
      .prepare("DELETE FROM channel_receipt WHERE workspace_slug = ? AND created_at < ?")
      .run(workspaceSlug, iso(before));
    return Number(result.changes);
  }

  // ----- used approval proofs (instance-wide, §6.3) -------------------------

  /**
   * Records a used approval proof (Nostr event id or JWT `jti`). Instance-wide,
   * not per workspace. Prunes expired rows first, in the same transaction.
   * `expiresAt` must be at least the proof's own validity end, so a pruned
   * proof is already refused by its verifier.
   */
  markUsedApprovalProof(input: {
    proofId: string;
    kind: "nostr" | "portal";
    expiresAt: Date | string;
    now?: Date | string;
  }): { ok: true } | { ok: false; error: "approval_proof_reused" } {
    const now = iso(input.now ?? new Date());
    const expiresAt = iso(input.expiresAt);
    if (!input.proofId) throw new ChannelStoreError("approval_proof_invalid", "Proof id is required.");
    return this.immediate(() => {
      this.db.prepare("DELETE FROM marketplace_used_approval_proof WHERE expires_at < ?").run(now);
      const result = this.db
        .prepare(
          `INSERT INTO marketplace_used_approval_proof (proof_id, kind, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(proof_id) DO NOTHING`,
        )
        .run(input.proofId, input.kind, expiresAt);
      return Number(result.changes) === 1
        ? ({ ok: true } as const)
        : ({ ok: false, error: "approval_proof_reused" } as const);
    });
  }

  isApprovalProofUsed(proofId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM marketplace_used_approval_proof WHERE proof_id = ?").get(proofId),
    );
  }
}

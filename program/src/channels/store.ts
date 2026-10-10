import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { sha256Hex } from "./canonical-json.js";
import { BUZZ_TABLES, BuzzStore, migrateBuzzTables } from "./buzz-store.js";
import { INBOUND_TABLES, InboundStore, migrateInboundTables } from "./inbound-store.js";
import { TEAMS_CONVERSATION_DDL, TeamsConversationStore } from "./teams-store.js";
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
  "channel_owner_key",
  "channel_approval_owner",
  "channel_teams_conversation",
  ...INBOUND_TABLES,
  ...BUZZ_TABLES,
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

    -- Owner Buzz key v1 (§6.3): app-owned, owner-only. One row per workspace; a cleared key keeps the
    -- row (pubkey NULL) so the epoch never goes back.
    CREATE TABLE IF NOT EXISTS channel_owner_key (
      workspace_slug TEXT PRIMARY KEY,
      pubkey TEXT,
      fingerprint TEXT,
      epoch INTEGER NOT NULL,
      set_by TEXT NOT NULL,
      set_at TEXT NOT NULL
    );

    -- Per held call: the owner key pinned at creation (only that key may approve it by Buzz) and the
    -- metadata of the proof that decided it (kind, Portal amr/device; never the proof itself).
    CREATE TABLE IF NOT EXISTS channel_approval_owner (
      approval_id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      key_fingerprint TEXT,
      key_epoch INTEGER NOT NULL,
      key_status TEXT NOT NULL,
      proof_kind TEXT,
      proof_amr_json TEXT,
      proof_device TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_approval_owner_scope
    ON channel_approval_owner(workspace_slug, key_status);
  `);
  // Teams conversation references (P2): captured by the Teams messaging endpoint at install.
  db.exec(TEAMS_CONVERSATION_DDL);
  // Inbound worker (P2 scope 2.2): routed inbound events, routes, reply links, settings, webhook, leases.
  migrateInboundTables(db);
  // Buzz (P2): public identity and owner settings (never the secret key), bridge routes, bridged messages.
  migrateBuzzTables(db);
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
  /** Discord guild id, or Telegram forum topic thread id. */
  parentId?: string;
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

/** One attachment of a post as the agent sent it (before fallbacks): spec 3.1 post body. */
export type ChannelPostAttachmentSpec = {
  id: string;
  kind: string;
  transcript?: string;
};

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
  /** Same order as `attachmentIds`; `kind` and `transcript` as sent (rows written with ids only have none). */
  attachments: ChannelPostAttachmentSpec[];
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

/** Posts that are not finished: their receipts and attachments are never purged. */
export const NON_TERMINAL_POST_STATUSES = ["held", "scheduled", "sending", "uncertain"] as const;

/** Statuses that count against caps (§4.4 rule 6, §6 step 4). */
export const COUNTED_POST_STATUSES = ["sending", "sent", "uncertain"] as const;
const COUNTED_SQL = COUNTED_POST_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * Allowed `finishPost` transitions. Terminal states have no exit, and
 * nothing moves back to `scheduled` or `sending` (that would re-send).
 * `scheduled` → `sending` happens only through `reserveScheduledPost`, and
 * a new `sending` row only through `reservePost`, both under the caps check.
 * `uncertain` leaves only by owner resolve (`sent` or `failed`).
 */
export const CHANNEL_POST_TRANSITIONS: Readonly<Record<ChannelPostStatus, readonly ChannelPostStatus[]>> = {
  held: ["cancelled", "expired", "skipped"],
  scheduled: ["cancelled", "skipped", "expired"],
  sending: ["sent", "failed", "uncertain"],
  uncertain: ["sent", "failed"],
  sent: [],
  failed: [],
  skipped: [],
  cancelled: [],
  expired: [],
};

/**
 * The only ways into `sending`, each inside its own reservation method under
 * the transactional caps check (never through `finishPost`):
 * `reservePost` (new row), `reserveScheduledPost` (`scheduled` → `sending`,
 * claim held) and `reserveHeldPost` (`held` → `sending`, only with a valid
 * owner approval of this exact digest).
 */
export const CHANNEL_POST_RESERVATIONS: Readonly<Partial<Record<ChannelPostStatus, readonly ChannelPostStatus[]>>> = {
  scheduled: ["sending"],
  held: ["sending"],
};

/**
 * The `company_box_approval.idempotency_key` of a held channel post's approval.
 * Unique per (workspace, agent), so it binds one approval to one post.
 */
export function channelPostApprovalKey(postId: string): string {
  return `channel-post:${postId}`;
}

/** Default send lease for a `sending` row; after it, recovery marks it `uncertain`. */
export const DEFAULT_SEND_LEASE_MS = 300_000;

export type ChannelCapError =
  | "channel_cap_per_day"
  | "channel_cap_per_hour"
  | "channel_min_interval"
  | "channel_phase_duplicate";

/** The owner's Buzz key setting (§6.3). `pubkey` is null after a clear. */
export type OwnerKeyRecord = {
  workspaceSlug: string;
  pubkey: string | null;
  fingerprint: string | null;
  epoch: number;
  setBy: string;
  setAt: string;
};

/**
 * The key a held call was created under. `pinned`: only `fingerprint`/`epoch` may approve it by Buzz.
 * `unpinned`: no key was set at creation, so no Buzz reply can approve it. `key_changed`: the key changed
 * while it was pending; it needs a new request or the owner UI (Portal proofs and the owner queue still work).
 */
export type ApprovalOwnerPin = {
  approvalId: string;
  workspaceSlug: string;
  keyFingerprint: string | null;
  keyEpoch: number;
  keyStatus: "pinned" | "unpinned" | "key_changed";
  proofKind: "nostr" | "portal" | null;
  proofAmr: string[] | null;
  proofDevice: string | null;
};

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

function leaseUntil(now: string, leaseMs: number | undefined): string {
  return new Date(Date.parse(now) + Math.max(leaseMs ?? DEFAULT_SEND_LEASE_MS, 1)).toISOString();
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

function attachmentSpecsFromJson(value: unknown): ChannelPostAttachmentSpec[] {
  const entries = json<unknown[]>(value, []);
  return entries.flatMap((entry): ChannelPostAttachmentSpec[] => {
    if (typeof entry === "string") return [{ id: entry, kind: "" }];
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      const spec = entry as { id: string; kind?: unknown; transcript?: unknown };
      return [{
        id: spec.id,
        kind: typeof spec.kind === "string" ? spec.kind : "",
        ...(typeof spec.transcript === "string" ? { transcript: spec.transcript } : {}),
      }];
    }
    return [];
  });
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
    attachmentIds: attachmentSpecsFromJson(row.attachment_ids_json).map((spec) => spec.id),
    attachments: attachmentSpecsFromJson(row.attachment_ids_json),
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
  /** When given, stored instead of `attachmentIds` (ids, kinds and transcripts, in order). */
  attachments?: ChannelPostAttachmentSpec[];
  campaign?: PostCampaign | null;
  digest: string;
  authority?: ChannelPostAuthority | null;
  idempotencyKey: string;
  reason?: string | null;
};

export type InsertPostInput = ChannelPostFields & {
  status: ChannelPostStatus;
  now?: Date | string;
  /**
   * Backlog limit (review F1): most `scheduled` + `held` posts this agent may
   * have on this channel, counted inside the insert transaction.
   */
  maxPending?: number;
};

export type InsertPostResult =
  | { ok: true; post: ChannelPostRecord; created: boolean }
  | { ok: false; error: "channel_not_found" | "channel_idempotency_conflict" | "channel_schedule_backlog_full" };

export type ReservationGrant = {
  id: string;
  caps: GrantCaps;
};

/**
 * Authority re-checked inside the reservation transaction (review M2): the
 * channel is `active`, the consent row is `active` (when given) and the
 * standing grant row is `active` and unexpired (when given). A pause or a
 * revoke during the send-time awaits therefore stops the send.
 */
export type ReservationLiveCheck = {
  consentRowId: string | null;
  grantId: string | null;
};

export type ReservationAuthorityError = "channel_paused" | "channel_not_active" | "consent_inactive" | "grant_inactive";

export type ReservePostInput = ChannelPostFields & {
  /** The standing grant that authorises this post, if any. */
  grant?: ReservationGrant | null;
  /** The channel ceiling caps at reservation time. */
  ceiling: ChannelCaps;
  now: Date | string;
  /** Holder of the send lease (`claimed_by`), e.g. the request or process id. */
  reserver: string;
  /** Send lease length; default `DEFAULT_SEND_LEASE_MS`. */
  leaseMs?: number;
  live?: ReservationLiveCheck;
};

export type ReservePostResult =
  | { ok: true; post: ChannelPostRecord; replayed: boolean }
  | {
      ok: false;
      error: ChannelCapError | ReservationAuthorityError | "channel_not_found" | "channel_idempotency_conflict";
      retryAfterSeconds?: number;
    };

export type ReserveScheduledPostInput = {
  workspaceSlug: string;
  postId: string;
  /** Must hold the claim. */
  claimer: string;
  grant?: ReservationGrant | null;
  ceiling: ChannelCaps;
  now: Date | string;
  /** Fresh send lease from `now`; default `DEFAULT_SEND_LEASE_MS`. */
  leaseMs?: number;
  live?: ReservationLiveCheck;
};

export type ReserveScheduledPostResult =
  | { ok: true; post: ChannelPostRecord }
  | { ok: false; error: ChannelCapError | ReservationAuthorityError | "channel_post_not_claimed"; retryAfterSeconds?: number };

export type ReserveHeldPostInput = {
  workspaceSlug: string;
  postId: string;
  /** The `company_box_approval` row that holds the owner's decision on this post's digest. */
  approvalId: string;
  ceiling: ChannelCaps;
  now: Date | string;
  /** Holder of the send lease (`claimed_by`). */
  reserver: string;
  leaseMs?: number;
  live?: ReservationLiveCheck;
};

export type ReserveHeldPostResult =
  | { ok: true; post: ChannelPostRecord }
  | {
      ok: false;
      error: ChannelCapError | ReservationAuthorityError | "channel_post_not_held" | "channel_approval_invalid";
      retryAfterSeconds?: number;
    };

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

  private teamsStore: TeamsConversationStore | undefined;
  private inboundStore: InboundStore | undefined;
  private buzzStore: BuzzStore | undefined;

  /** Buzz identity, bridge routes and bridged messages (P2), on the same connection. */
  get buzz(): BuzzStore {
    this.buzzStore ??= new BuzzStore(this.db);
    return this.buzzStore;
  }

  /** Inbound worker state (P2), on the same connection. */
  get inbound(): InboundStore {
    this.inboundStore ??= new InboundStore(this.db);
    return this.inboundStore;
  }

  /** Teams conversation references (P2), on the same connection. */
  get teams(): TeamsConversationStore {
    this.teamsStore ??= new TeamsConversationStore(this.db);
    return this.teamsStore;
  }

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
    return this.immediate(() => {
      if (!this.channelInWorkspace(input.workspaceSlug, input.channelId)) {
        throw new ChannelStoreError("channel_not_found", "Channel not found.");
      }
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
    });
  }

  /** Tenant guard: the channel exists in this workspace. Call inside the write transaction. */
  private channelInWorkspace(workspaceSlug: string, channelId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM channel WHERE workspace_slug = ? AND id = ?").get(workspaceSlug, channelId),
    );
  }

  /** Same key must mean the same post: same channel and same payload digest. */
  private idempotencyConflict(existing: ChannelPostRecord, input: { channelId: string; digest: string }): boolean {
    return existing.channelId !== input.channelId || existing.digest !== input.digest;
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
   * Inserts a post (`held` or `scheduled`). Idempotent on (workspace, agent,
   * idempotency key): a repeat with the same channel and digest returns the
   * existing row with `created: false`; a different channel or digest is
   * `channel_idempotency_conflict`. The channel must belong to the workspace.
   */
  insertPost(input: InsertPostInput): InsertPostResult {
    if (input.status !== "held" && input.status !== "scheduled") {
      throw new ChannelStoreError("channel_transition_refused", "insertPost creates only held or scheduled posts.");
    }
    const timestamp = iso(input.now ?? new Date());
    return this.immediate<InsertPostResult>(() => {
      if (!this.channelInWorkspace(input.workspaceSlug, input.channelId)) {
        return { ok: false, error: "channel_not_found" };
      }
      const existing = this.getPostByIdempotencyKey(input.workspaceSlug, input.agentId, input.idempotencyKey);
      if (existing) {
        return this.idempotencyConflict(existing, input)
          ? { ok: false, error: "channel_idempotency_conflict" }
          : { ok: true, post: existing, created: false };
      }
      if (input.maxPending !== undefined) {
        const pending = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM channel_post WHERE workspace_slug = ? AND agent_id = ? AND channel_id = ?
              AND status IN ('scheduled', 'held')`,
          )
          .get(input.workspaceSlug, input.agentId, input.channelId) as { count: number };
        if (Number(pending.count) >= input.maxPending) return { ok: false, error: "channel_schedule_backlog_full" };
      }
      const id = this.insertPostRow(input, input.status, timestamp, null, null);
      return { ok: true, post: this.getPost(input.workspaceSlug, id)!, created: true };
    });
  }

  private insertPostRow(
    input: ChannelPostFields,
    status: ChannelPostStatus,
    timestamp: string,
    reservedAt: string | null,
    lease: { claimedBy: string; expiresAt: string } | null,
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(input.attachments ?? input.attachmentIds ?? []),
        input.campaign?.ref ?? null,
        input.campaign?.phase ?? null,
        input.digest,
        input.authority ?? null,
        status,
        input.idempotencyKey,
        lease?.claimedBy ?? null,
        lease?.expiresAt ?? null,
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
   * Moves a post to a new status and clears any claim. `from` is mandatory
   * and every `from` → `status` pair must be in `CHANNEL_POST_TRANSITIONS`
   * (a disallowed pair throws `channel_transition_refused`). Guards: the
   * current status is in `from`, and `claimer` (if given) holds the claim.
   * Returns null when a guard fails, so a lost race is visible to the caller.
   */
  finishPost(
    workspaceSlug: string,
    id: string,
    update: {
      status: ChannelPostStatus;
      from: readonly ChannelPostStatus[];
      reason?: string | null;
      claimer?: string;
      now?: Date | string;
    },
  ): ChannelPostRecord | null {
    if (!update.from || update.from.length === 0) {
      throw new ChannelStoreError("channel_transition_refused", "finishPost needs the allowed current statuses.");
    }
    for (const from of update.from) {
      if (!(CHANNEL_POST_TRANSITIONS[from] ?? []).includes(update.status)) {
        throw new ChannelStoreError("channel_transition_refused", `A post cannot move from ${from} to ${update.status}.`);
      }
    }
    const clauses = ["workspace_slug = ?", "id = ?", `status IN (${update.from.map(() => "?").join(", ")})`];
    const params: string[] = [workspaceSlug, id, ...update.from];
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
   * Crash recovery, instance-wide: every `sending` row whose send lease has
   * expired becomes `uncertain` (it may have reached the provider). Never
   * back to `scheduled`, so it is never re-claimed or re-sent; it still
   * counts for caps until the owner resolves it.
   */
  recoverStaleSending(input: { now: Date | string }): ChannelPostRecord[] {
    const now = iso(input.now);
    const rows = this.db
      .prepare(
        `UPDATE channel_post SET status = 'uncertain', reason = 'send_lease_expired', claimed_by = NULL,
          claim_expires_at = NULL, updated_at = ?
        WHERE status = 'sending' AND (claim_expires_at IS NULL OR claim_expires_at < ?)
        RETURNING *`,
      )
      .all(now, now) as Row[];
    return rows.map(postFromRow).sort((a, b) => a.id.localeCompare(b.id));
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
   * Idempotent: a repeat of (workspace, agent, idempotency key) with the
   * same channel and digest returns the existing row with `replayed: true`;
   * a different channel or digest is `channel_idempotency_conflict`. The
   * channel must belong to the workspace (checked inside the transaction).
   * The new `sending` row carries a send lease (`claimed_by` = reserver) so
   * `recoverStaleSending` can mark it `uncertain` after a crash.
   */
  reservePost(input: ReservePostInput): ReservePostResult {
    const now = iso(input.now);
    if (input.grant && input.authority && input.authority !== `grant:${input.grant.id}`) {
      throw new ChannelStoreError("channel_authority_mismatch", "Authority does not name the reserving grant.");
    }
    if (!input.reserver) {
      throw new ChannelStoreError("channel_reserver_required", "reservePost needs a reserver id for the send lease.");
    }
    const lease = { claimedBy: input.reserver, expiresAt: leaseUntil(now, input.leaseMs) };
    return this.immediate<ReservePostResult>(() => {
      if (!this.channelInWorkspace(input.workspaceSlug, input.channelId)) {
        return { ok: false, error: "channel_not_found" };
      }
      const existing = this.getPostByIdempotencyKey(input.workspaceSlug, input.agentId, input.idempotencyKey);
      if (existing) {
        return this.idempotencyConflict(existing, input)
          ? { ok: false, error: "channel_idempotency_conflict" }
          : { ok: true, post: existing, replayed: true };
      }
      const unauthorized = this.liveRefusal(input.workspaceSlug, input.channelId, input.live, now);
      if (unauthorized) return unauthorized;
      const refusal = this.checkCaps({
        workspaceSlug: input.workspaceSlug,
        channelId: input.channelId,
        grant: input.grant ?? null,
        ceiling: input.ceiling,
        campaign: input.campaign ?? null,
        now,
        excludePostId: null,
      });
      if (refusal) return refusal;
      const authority = input.authority ?? (input.grant ? (`grant:${input.grant.id}` as const) : null);
      const id = this.insertPostRow({ ...input, authority }, "sending", now, now, lease);
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
      const unauthorized = this.liveRefusal(post.workspaceSlug, post.channelId, input.live, now);
      if (unauthorized) return unauthorized;
      const refusal = this.checkCaps({
        workspaceSlug: post.workspaceSlug,
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
          `UPDATE channel_post SET status = 'sending', reserved_at = ?, claim_expires_at = ?, updated_at = ?
          WHERE workspace_slug = ? AND id = ? AND status = 'scheduled' AND claimed_by = ?`,
        )
        .run(now, leaseUntil(now, input.leaseMs), now, input.workspaceSlug, input.postId, input.claimer);
      return { ok: true, post: this.getPost(input.workspaceSlug, input.postId)! };
    });
  }

  /**
   * Owner-approved held post → `sending` (spec §6 3c/3d; review condition
   * 8b(iv)). One `BEGIN IMMEDIATE` transaction: the post is still `held`,
   * the approval row is approved (`executing`, decided) for exactly this
   * post's digest and still valid (an immediate post before the approval
   * expiry; a scheduled post was decided before its `sendAt`, which is the
   * approval expiry), and the channel ceiling has room. Only then is the post
   * counted, with `authority = approval:<id>` and a send lease. A refusal
   * changes nothing, so neither the approval nor a cap slot is consumed.
   */
  reserveHeldPost(input: ReserveHeldPostInput): ReserveHeldPostResult {
    const now = iso(input.now);
    if (!input.reserver) {
      throw new ChannelStoreError("channel_reserver_required", "reserveHeldPost needs a reserver id for the send lease.");
    }
    if (!(CHANNEL_POST_RESERVATIONS.held ?? []).includes("sending")) {
      throw new ChannelStoreError("channel_transition_refused", "held posts cannot be reserved.");
    }
    return this.immediate<ReserveHeldPostResult>(() => {
      const post = this.getPost(input.workspaceSlug, input.postId);
      if (!post || post.status !== "held") return { ok: false, error: "channel_post_not_held" };
      const approval = this.db
        .prepare(
          `SELECT state, fingerprint, decided_at, expires_at FROM company_box_approval
          WHERE id = ? AND workspace_slug = ? AND agent_id = ? AND idempotency_key = ?`,
        )
        // Review F2: the approval must name THIS post (its unique key is `channel-post:<postId>`), not only its digest.
        .get(input.approvalId, input.workspaceSlug, post.agentId, channelPostApprovalKey(post.id)) as
        | { state: string; fingerprint: string; decided_at: string | null; expires_at: string }
        | undefined;
      const valid =
        approval !== undefined &&
        approval.state === "executing" &&
        approval.fingerprint === post.digest &&
        approval.decided_at !== null &&
        approval.decided_at <= approval.expires_at &&
        (post.mode === "scheduled" || approval.expires_at > now);
      if (!valid) return { ok: false, error: "channel_approval_invalid" };
      const unauthorized = this.liveRefusal(post.workspaceSlug, post.channelId, input.live, now);
      if (unauthorized) return unauthorized;
      const refusal = this.checkCaps({
        workspaceSlug: post.workspaceSlug,
        channelId: post.channelId,
        grant: null,
        ceiling: input.ceiling,
        campaign: post.campaign,
        now,
        excludePostId: post.id,
      });
      if (refusal) return refusal;
      const result = this.db
        .prepare(
          `UPDATE channel_post SET status = 'sending', authority = ?, reserved_at = ?, claimed_by = ?,
            claim_expires_at = ?, updated_at = ?
          WHERE workspace_slug = ? AND id = ? AND status = 'held'`,
        )
        .run(
          `approval:${input.approvalId}`,
          now,
          input.reserver,
          leaseUntil(now, input.leaseMs),
          now,
          input.workspaceSlug,
          input.postId,
        );
      if (Number(result.changes) !== 1) return { ok: false, error: "channel_post_not_held" };
      return { ok: true, post: this.getPost(input.workspaceSlug, input.postId)! };
    });
  }

  /** Held scheduled posts whose send time has come (approved, still pending, or expired approvals). */
  listDueHeldPosts(input: { now: Date | string; limit?: number }): ChannelPostRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_post WHERE status = 'held' AND mode = 'scheduled' AND send_at <= ?
        ORDER BY send_at, id LIMIT ?`,
      )
      .all(iso(input.now), Math.min(Math.max(input.limit ?? 25, 1), 500)) as Row[];
    return rows.map(postFromRow);
  }

  /** Counted posts (`sending`, `sent`, `uncertain`) on a channel since `since` (usage today). */
  countCountedPosts(workspaceSlug: string, channelId: string, since: Date | string, authority?: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM channel_post WHERE workspace_slug = ? AND channel_id = ?
          AND status IN (${COUNTED_SQL}) AND reserved_at > ? AND (? IS NULL OR authority = ?)`,
      )
      .get(workspaceSlug, channelId, iso(since), authority ?? null, authority ?? null) as { count: number };
    return Number(row.count);
  }

  /** Review M2: call inside the reservation transaction. */
  private liveRefusal(workspaceSlug: string, channelId: string, live: ReservationLiveCheck | undefined, now: string): { ok: false; error: ReservationAuthorityError } | null {
    if (!live) return null;
    const channel = this.db.prepare("SELECT status FROM channel WHERE workspace_slug = ? AND id = ?").get(workspaceSlug, channelId) as
      | { status: string }
      | undefined;
    if (!channel || channel.status !== "active") {
      return { ok: false, error: channel?.status === "paused" ? "channel_paused" : "channel_not_active" };
    }
    if (live.consentRowId !== null) {
      const consent = this.db.prepare("SELECT state FROM marketplace_agent_consent WHERE id = ?").get(live.consentRowId) as
        | { state: string }
        | undefined;
      if (consent?.state !== "active") return { ok: false, error: "consent_inactive" };
    }
    if (live.grantId !== null) {
      const grant = this.db
        .prepare("SELECT status, expires, not_before, consent_id FROM channel_standing_grant WHERE workspace_slug = ? AND id = ? AND channel_id = ?")
        .get(workspaceSlug, live.grantId, channelId) as { status: string; expires: string; not_before: string | null; consent_id: string } | undefined;
      if (
        !grant ||
        grant.status !== "active" ||
        grant.expires <= now ||
        (grant.not_before !== null && grant.not_before > now) ||
        (live.consentRowId !== null && grant.consent_id !== live.consentRowId)
      ) {
        return { ok: false, error: "grant_inactive" };
      }
    }
    return null;
  }

  /**
   * Cancels a held post with its approval in one transaction: the post must
   * still be `held` (refused once a send started), then a `pending` approval
   * becomes `denied` and an approved (`executing`) one `failed`
   * (`channel_post_cancelled`). Returns the cancelled post, or null.
   */
  cancelHeldPost(input: { workspaceSlug: string; postId: string; reason: string; decidedBy: string; now: Date | string }): ChannelPostRecord | null {
    const now = iso(input.now);
    return this.immediate(() => {
      const result = this.db
        .prepare(
          `UPDATE channel_post SET status = 'cancelled', reason = ?, claimed_by = NULL, claim_expires_at = NULL, updated_at = ?
          WHERE workspace_slug = ? AND id = ? AND status = 'held'`,
        )
        .run(input.reason, now, input.workspaceSlug, input.postId);
      if (Number(result.changes) !== 1) return null;
      const key = channelPostApprovalKey(input.postId);
      this.db
        .prepare(
          `UPDATE company_box_approval SET state = 'denied', decided_by = ?, decided_at = ?, updated_at = ?
          WHERE workspace_slug = ? AND idempotency_key = ? AND state IN ('pending', 'resolving')`,
        )
        .run(input.decidedBy, now, now, input.workspaceSlug, key);
      this.db
        .prepare(
          `UPDATE company_box_approval SET state = 'failed', error = 'channel_post_cancelled', updated_at = ?
          WHERE workspace_slug = ? AND idempotency_key = ? AND state = 'executing'`,
        )
        .run(now, input.workspaceSlug, key);
      return this.getPost(input.workspaceSlug, input.postId);
    });
  }

  /**
   * Owner denies an approved (`executing`) approval while its post is still
   * `held` (review M1). One transaction: the post must still be held (no send
   * started), then the approval moves `executing` → `denied`. Returns false
   * when a send already took the post.
   */
  denyApprovedHold(input: { workspaceSlug: string; approvalId: string; postId: string; decidedBy: string; now: Date | string }): boolean {
    const now = iso(input.now);
    return this.immediate(() => {
      const post = this.getPost(input.workspaceSlug, input.postId);
      if (!post || post.status !== "held") return false;
      const result = this.db
        .prepare(
          `UPDATE company_box_approval SET state = 'denied', decided_by = ?, decided_at = ?, updated_at = ?
          WHERE id = ? AND workspace_slug = ? AND state = 'executing' AND fingerprint = ? AND idempotency_key = ?`,
        )
        .run(input.decidedBy, now, now, input.approvalId, input.workspaceSlug, post.digest, channelPostApprovalKey(post.id));
      return Number(result.changes) === 1;
    });
  }

  private checkCaps(input: {
    workspaceSlug: string;
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
          `SELECT 1 FROM channel_post WHERE workspace_slug = ? AND channel_id = ? AND status IN (${COUNTED_SQL})
            AND campaign_ref = ? AND campaign_phase = ? AND id <> ? LIMIT 1`,
        )
        .get(input.workspaceSlug, input.channelId, input.campaign.ref, input.campaign.phase, exclude);
      if (duplicate) return { ok: false, error: "channel_phase_duplicate" };
    }

    // (a)+(c) channel ceiling, shared by all agents; (b)+(c) the grant's own posts.
    const scopes: Array<{ where: string; params: string[]; caps: ChannelCaps }> = [
      { where: "workspace_slug = ? AND channel_id = ?", params: [input.workspaceSlug, input.channelId], caps: input.ceiling },
    ];
    if (input.grant) {
      scopes.push({
        where: "workspace_slug = ? AND channel_id = ? AND authority = ?",
        params: [input.workspaceSlug, input.channelId, `grant:${input.grant.id}`],
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

  /**
   * Upload with the per-agent quota (follow-up Q1), in one `BEGIN IMMEDIATE`
   * transaction: the agent's stored bytes plus this upload stay within
   * `maxBytes` and its uploads in the last 24 h stay below `maxPerDay`; only
   * then `write` stores the bytes and the row is inserted. A refusal writes
   * nothing. Serialised with `cleanupAttachments`, so a file is never deleted
   * between its write and its row.
   */
  insertAttachmentWithinQuota(input: {
    workspaceSlug: string;
    sha256: string;
    contentType: string;
    bytes: number;
    name: string;
    createdBy: string;
    now: Date | string;
    maxBytes: number;
    maxPerDay: number;
    write: () => void;
  }): { ok: true; record: ChannelAttachmentRecord } | { ok: false; error: "channel_attachment_quota_exceeded"; limit: "bytes" | "uploads_per_day" } {
    const now = iso(input.now);
    return this.immediate(() => {
      const usage = this.db
        .prepare(
          `SELECT COALESCE(SUM(bytes), 0) AS total,
            COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS today
          FROM channel_attachment WHERE workspace_slug = ? AND created_by = ?`,
        )
        .get(new Date(Date.parse(now) - DAY_MS).toISOString(), input.workspaceSlug, input.createdBy) as { total: number; today: number };
      if (Number(usage.today) >= input.maxPerDay) return { ok: false, error: "channel_attachment_quota_exceeded", limit: "uploads_per_day" };
      if (Number(usage.total) + input.bytes > input.maxBytes) return { ok: false, error: "channel_attachment_quota_exceeded", limit: "bytes" };
      input.write();
      const record = this.insertAttachment({ ...input, now });
      return { ok: true, record };
    });
  }

  /**
   * Attachment cleanup (follow-up Q1), bounded to `limit` rows per call. A row
   * older than `unreferencedAfterMs` goes when no post references it, or when
   * every post that references it is finished and its receipt was purged or
   * the post finished more than `retentionMs` ago. A row referenced by a
   * post that is not finished (`held`, `scheduled`, `sending`, `uncertain`)
   * is never deleted. The file goes with the last row of its SHA-256 (in any
   * workspace: the store is content-addressed).
   */
  cleanupAttachments(input: {
    rootDir: string;
    now: Date | string;
    unreferencedAfterMs: number;
    retentionMs: number;
    limit?: number;
  }): { deleted: number; filesDeleted: number } {
    const nowMs = Date.parse(iso(input.now));
    const createdBefore = new Date(nowMs - input.unreferencedAfterMs).toISOString();
    const finishedBefore = new Date(nowMs - input.retentionMs).toISOString();
    const open = NON_TERMINAL_POST_STATUSES.map((status) => `'${status}'`).join(", ");
    const references = `p.workspace_slug = a.workspace_slug AND instr(p.attachment_ids_json, '"' || a.id || '"') > 0`;
    return this.immediate(() => {
      const rows = this.db
        .prepare(
          `SELECT a.id, a.workspace_slug, a.sha256 FROM channel_attachment a
          WHERE a.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM channel_post p WHERE ${references} AND p.status IN (${open}))
            AND NOT EXISTS (SELECT 1 FROM channel_post p WHERE ${references} AND p.status NOT IN (${open})
              AND p.updated_at >= ? AND EXISTS (SELECT 1 FROM channel_receipt r WHERE r.post_id = p.id))
          ORDER BY a.created_at, a.id LIMIT ?`,
        )
        .all(createdBefore, finishedBefore, Math.min(Math.max(input.limit ?? 100, 1), 1000)) as Array<{ id: string; workspace_slug: string; sha256: string }>;
      let filesDeleted = 0;
      for (const row of rows) {
        this.db.prepare("DELETE FROM channel_attachment WHERE id = ?").run(row.id);
        const shared = this.db.prepare("SELECT 1 FROM channel_attachment WHERE sha256 = ? LIMIT 1").get(row.sha256);
        if (!shared && SHA256_PATTERN.test(row.sha256)) {
          try {
            fs.rmSync(path.join(input.rootDir, row.sha256));
            filesDeleted += 1;
          } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
          }
        }
      }
      return { deleted: rows.length, filesDeleted };
    });
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

  /**
   * Retention (§7): deletes receipts created before `before` whose post is
   * finished. A receipt of a post that is not terminal (`held`, `scheduled`,
   * `sending`, `uncertain`) is kept and counted as skipped: it is still the
   * record of something that may yet happen, or may have happened.
   */
  purgeReceipts(workspaceSlug: string, before: Date | string): { purged: number; skipped: number } {
    const cutoff = iso(before);
    const open = NON_TERMINAL_POST_STATUSES.map((status) => `'${status}'`).join(", ");
    return this.immediate(() => {
      const skipped = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM channel_receipt r JOIN channel_post p ON p.id = r.post_id AND p.workspace_slug = r.workspace_slug
          WHERE r.workspace_slug = ? AND r.created_at < ? AND p.status IN (${open})`,
        )
        .get(workspaceSlug, cutoff) as { count: number };
      const result = this.db
        .prepare(
          `DELETE FROM channel_receipt WHERE workspace_slug = ? AND created_at < ?
          AND NOT EXISTS (SELECT 1 FROM channel_post p WHERE p.id = channel_receipt.post_id
            AND p.workspace_slug = channel_receipt.workspace_slug AND p.status IN (${open}))`,
        )
        .run(workspaceSlug, cutoff);
      return { purged: Number(result.changes), skipped: Number(skipped.count) };
    });
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

  // ----- owner Buzz key and per-hold pins (§6.3) ---------------------------

  getOwnerKey(workspaceSlug: string): OwnerKeyRecord | null {
    const row = this.db.prepare("SELECT * FROM channel_owner_key WHERE workspace_slug = ?").get(workspaceSlug) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      workspaceSlug: String(row.workspace_slug),
      pubkey: row.pubkey === null ? null : String(row.pubkey),
      fingerprint: row.fingerprint === null ? null : String(row.fingerprint),
      epoch: Number(row.epoch),
      setBy: String(row.set_by),
      setAt: String(row.set_at),
    };
  }

  /**
   * Set, change or clear the owner key in one transaction. Any change bumps the epoch and marks every
   * pending (or resolving) hold pinned to the previous key `key_changed`. Returns the previous and new
   * fingerprints and how many holds were invalidated; `changed: false` when the key is the same.
   */
  setOwnerKey(input: { workspaceSlug: string; pubkey: string | null; fingerprint: string | null; actor: string; now?: Date }): {
    changed: boolean;
    previousFingerprint: string | null;
    fingerprint: string | null;
    invalidated: number;
    record: OwnerKeyRecord | null;
  } {
    const timestamp = iso(input.now ?? new Date());
    return this.immediate(() => {
      const previous = this.getOwnerKey(input.workspaceSlug);
      const previousFingerprint = previous?.pubkey ? previous.fingerprint : null;
      if ((previous?.pubkey ?? null) === input.pubkey) {
        return { changed: false, previousFingerprint, fingerprint: previousFingerprint, invalidated: 0, record: previous };
      }
      const epoch = (previous?.epoch ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO channel_owner_key (workspace_slug, pubkey, fingerprint, epoch, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_slug) DO UPDATE SET pubkey = excluded.pubkey, fingerprint = excluded.fingerprint,
             epoch = excluded.epoch, set_by = excluded.set_by, set_at = excluded.set_at`,
        )
        .run(input.workspaceSlug, input.pubkey, input.pubkey ? input.fingerprint : null, epoch, input.actor, timestamp);
      const invalidated = this.db
        .prepare(
          `UPDATE channel_approval_owner SET key_status = 'key_changed', updated_at = ?
           WHERE workspace_slug = ? AND key_status = 'pinned'
             AND approval_id IN (SELECT id FROM company_box_approval WHERE workspace_slug = ? AND state IN ('pending', 'resolving'))`,
        )
        .run(timestamp, input.workspaceSlug, input.workspaceSlug);
      return {
        changed: true,
        previousFingerprint,
        fingerprint: input.pubkey ? input.fingerprint : null,
        invalidated: Number(invalidated.changes),
        record: this.getOwnerKey(input.workspaceSlug),
      };
    });
  }

  /** Record the key a new held call is created under (called with the approval insert; no transaction of its own). */
  pinApprovalOwnerKey(input: { approvalId: string; workspaceSlug: string; now?: Date }): ApprovalOwnerPin {
    const key = this.getOwnerKey(input.workspaceSlug);
    const timestamp = iso(input.now ?? new Date());
    const pinned = Boolean(key?.pubkey && key.fingerprint);
    this.db
      .prepare(
        `INSERT INTO channel_approval_owner (approval_id, workspace_slug, key_fingerprint, key_epoch, key_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(approval_id) DO NOTHING`,
      )
      .run(input.approvalId, input.workspaceSlug, pinned ? key!.fingerprint : null, key?.epoch ?? 0, pinned ? "pinned" : "unpinned", timestamp, timestamp);
    return this.getApprovalOwnerPin(input.approvalId)!;
  }

  getApprovalOwnerPin(approvalId: string): ApprovalOwnerPin | null {
    const row = this.db.prepare("SELECT * FROM channel_approval_owner WHERE approval_id = ?").get(approvalId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let amr: string[] | null = null;
    if (typeof row.proof_amr_json === "string") {
      try {
        const parsed = JSON.parse(row.proof_amr_json) as unknown;
        amr = Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : null;
      } catch {
        amr = null;
      }
    }
    return {
      approvalId: String(row.approval_id),
      workspaceSlug: String(row.workspace_slug),
      keyFingerprint: row.key_fingerprint === null ? null : String(row.key_fingerprint),
      keyEpoch: Number(row.key_epoch),
      keyStatus: String(row.key_status) as ApprovalOwnerPin["keyStatus"],
      proofKind: row.proof_kind === null ? null : (String(row.proof_kind) as "nostr" | "portal"),
      proofAmr: amr,
      proofDevice: row.proof_device === null ? null : String(row.proof_device),
    };
  }

  /** Metadata of the proof that decided a held call (kind, Portal `amr` and `device`). Never the proof. */
  recordApprovalProof(input: { approvalId: string; workspaceSlug: string; kind: "nostr" | "portal"; amr?: readonly string[] | null; device?: string | null; now?: Date }): void {
    const timestamp = iso(input.now ?? new Date());
    const amr = input.amr && input.amr.length ? JSON.stringify(input.amr) : null;
    this.db
      .prepare(
        `INSERT INTO channel_approval_owner (approval_id, workspace_slug, key_fingerprint, key_epoch, key_status, proof_kind, proof_amr_json, proof_device, created_at, updated_at)
         VALUES (?, ?, NULL, 0, 'unpinned', ?, ?, ?, ?, ?)
         ON CONFLICT(approval_id) DO UPDATE SET proof_kind = excluded.proof_kind, proof_amr_json = excluded.proof_amr_json,
           proof_device = excluded.proof_device, updated_at = excluded.updated_at`,
      )
      .run(input.approvalId, input.workspaceSlug, input.kind, amr, input.device ?? null, timestamp, timestamp);
  }

  isApprovalProofUsed(proofId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM marketplace_used_approval_proof WHERE proof_id = ?").get(proofId),
    );
  }
}

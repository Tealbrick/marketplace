/**
 * Tool files (issue #59): large file arguments for `marketplace.tools.call`.
 *
 * The harness uploads the raw bytes once with `marketplace.tool-files.upload`
 * (bound to the caller's deployment, agent and consent) and then sends a small
 * reference `{fileRef, sha256, bytes, contentType, filename}` in place of the
 * file argument. Marketplace resolves the reference only where the consented
 * action's schema has an `x-file-upload` field, checks every declared value
 * against the stored file, and turns it into the `{base64, filename,
 * contentType}` object the OpenAPI engine sends, as late as possible (never in
 * the usage ledger, Rules payloads, held arguments or audit rows).
 *
 * Lifecycle of a stored file:
 *   live     uploaded, unused; expires 24 h after upload
 *   pinned   referenced by a held (owner approval) call; expires with the approval (7 d)
 *   consumed used once by an executed call (single use); bytes deleted after the call
 *   expired  TTL or approval expiry passed before use; bytes deleted
 *   released the held call was decided without running it (denied, failed); bytes deleted
 *
 * Rows outlive their bytes so a repeated upload or call with the same
 * idempotency key keeps its first answer; terminal rows are purged later.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const TOOL_FILE_TABLES = ["tool_file"] as const;

/** Relative to the Marketplace data directory (`/data` in the hosted image). */
export const TOOL_FILES_SUBDIR = "tool-files";

export const TOOL_FILE_TTL_MS = 24 * 60 * 60 * 1000;
export const TOOL_FILE_QUOTA_FILES = 20;
export const TOOL_FILE_QUOTA_BYTES = 200 * 1024 * 1024;
/** Terminal rows (consumed, expired, released) are kept this long for idempotent replays, then purged. */
export const TOOL_FILE_ROW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The kit's upload key is `upload.<tools.call key>.<sha256[:16]>`, so dots are allowed and it is longer than a tools.call key. */
export const TOOL_FILE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,200}$/u;
export const TOOL_FILE_REF_PATTERN = /^tf_[A-Za-z0-9_-]{32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ToolFileState = "live" | "pinned" | "consumed" | "expired" | "released";

export type ToolFileRecord = {
  id: string;
  workspaceSlug: string;
  deploymentId: string;
  agentId: string;
  consentId: string;
  pluginId: string;
  actionKey: string;
  sha256: string;
  bytes: number;
  contentType: string;
  filename: string;
  idempotencyKey: string;
  fingerprint: string;
  response: { status: number; body: Record<string, unknown> };
  state: ToolFileState;
  approvalId: string | null;
  usedKey: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

/** What a tools.call argument carries in place of a file. Exactly these five fields. */
export type ToolFileRef = { fileRef: string; sha256: string; bytes: number; contentType: string; filename: string };

/** Who may use a file: it resolves only for the same deployment, agent and Portal consent. */
export type ToolFileBinding = { workspaceSlug: string; deploymentId: string; agentId: string; consentId: string };

// ---------------------------------------------------------------------------
// Types and content checks
// ---------------------------------------------------------------------------

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.byteLength >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OOXML_MARKER = Buffer.from("[Content_Types].xml", "latin1");

function utf8Text(bytes: Uint8Array) {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** An OOXML package: a zip whose entries include `[Content_Types].xml`. */
function ooxml(bytes: Uint8Array) {
  return startsWith(bytes, ZIP_LOCAL) && Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(OOXML_MARKER);
}

/**
 * The allowlist: declared type → file name extensions and the content check.
 * Anything else (SVG, HTML, JavaScript, XML, executables, …) is refused.
 */
export const TOOL_FILE_TYPES: Readonly<Record<string, { extensions: readonly string[]; matches: (bytes: Uint8Array) => boolean; preview: boolean }>> = {
  "image/png": { extensions: ["png"], matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), preview: true },
  "image/jpeg": { extensions: ["jpg", "jpeg"], matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]), preview: true },
  "image/webp": { extensions: ["webp"], matches: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8), preview: true },
  "image/gif": { extensions: ["gif"], matches: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")), preview: true },
  "application/pdf": { extensions: ["pdf"], matches: (b) => startsWith(b, ascii("%PDF-")), preview: true },
  "text/plain": { extensions: ["txt", "text", "log"], matches: utf8Text, preview: false },
  "text/markdown": { extensions: ["md", "markdown"], matches: utf8Text, preview: false },
  "text/csv": { extensions: ["csv"], matches: utf8Text, preview: false },
  "application/zip": { extensions: ["zip"], matches: (b) => startsWith(b, ZIP_LOCAL) || startsWith(b, ZIP_EMPTY), preview: false },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { extensions: ["pptx"], matches: ooxml, preview: false },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extensions: ["docx"], matches: ooxml, preview: false },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { extensions: ["xlsx"], matches: ooxml, preview: false },
};

export const TOOL_FILE_CONTENT_TYPES = Object.freeze(Object.keys(TOOL_FILE_TYPES));

/** Images and PDF: the owner may preview or download them from the Approvals panel. */
export function toolFilePreviewable(contentType: string) {
  return TOOL_FILE_TYPES[contentType]?.preview === true;
}

/** The media type of a `Content-Type` header, lower-cased, without parameters. */
export function baseContentType(header: string | undefined) {
  return (header ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/**
 * The file name exactly as the owner approved it, or null. Never rewritten: the kit shows the owner this name before
 * the upload and requires Marketplace to store and return it byte for byte, so a name that would need any change is
 * refused instead. Valid: non-empty, at most 255 UTF-16 units, no control (\p{Cc}) or format/bidi (\p{Cf}) characters, no "/" or "\\", no leading or
 * trailing whitespace, not "." or "..". No Unicode normalization (exact string compare).
 */
export function validToolFileName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) return null;
  if (/[\p{Cc}\p{Cf}\\/]/u.test(raw) || raw !== raw.trim() || raw === "." || raw === "..") return null;
  return raw;
}

export type ToolFileTypeCheck = { ok: true } | { ok: false; status: number; error: string };

/** The declared type must be on the allowlist, the name's extension must belong to it and the bytes must match it. */
export function checkToolFileType(input: { bytes: Uint8Array; contentType: string; filename: string }): ToolFileTypeCheck {
  const rule = TOOL_FILE_TYPES[input.contentType];
  if (!rule) return { ok: false, status: 415, error: "tool_file_type_invalid" };
  const dot = input.filename.lastIndexOf(".");
  const extension = dot > 0 ? input.filename.slice(dot + 1).toLowerCase() : "";
  if (!rule.extensions.includes(extension) || !rule.matches(input.bytes)) {
    return { ok: false, status: 422, error: "tool_file_type_mismatch" };
  }
  return { ok: true };
}

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function newToolFileRef() {
  return `tf_${randomBytes(24).toString("base64url")}`;
}

// ---------------------------------------------------------------------------
// Where a schema takes a file, and the references in arguments
// ---------------------------------------------------------------------------

/** A path into the arguments; `*` stands for every item of an array. */
export type FileArgumentPath = readonly string[];

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Every `x-file-upload` position of an operation input schema: the raw body
 * (`["body"]`), a multipart part (`["body", "file"]`) or each item of a
 * multipart array (`["body", "files", "*"]`). Follows `properties` and
 * `items` only (the engine never puts a file elsewhere).
 */
export function fileArgumentPaths(schema: unknown, prefix: string[] = [], depth = 0): FileArgumentPath[] {
  const record = recordOf(schema);
  if (!record || depth > 6) return [];
  if (record["x-file-upload"] === true) return [prefix];
  const paths: FileArgumentPath[] = [];
  const properties = recordOf(record.properties);
  if (properties) {
    for (const [key, child] of Object.entries(properties)) paths.push(...fileArgumentPaths(child, [...prefix, key], depth + 1));
  }
  if (record.items !== undefined) paths.push(...fileArgumentPaths(record.items, [...prefix, "*"], depth + 1));
  return paths;
}

/** The values found at one path (arrays expand at `*`). Missing values are skipped. */
function valuesAt(value: unknown, filePath: FileArgumentPath, at: string[] = []): Array<{ value: unknown; at: string[] }> {
  if (filePath.length === 0) return value === undefined ? [] : [{ value, at }];
  const [head, ...rest] = filePath;
  if (head === "*") {
    return Array.isArray(value) ? value.flatMap((item, index) => valuesAt(item, rest, [...at, String(index)])) : [];
  }
  const record = recordOf(value);
  return record && head! in record ? valuesAt(record[head!], rest, [...at, head!]) : [];
}

/** Replace the value at a concrete path (`at` from `valuesAt`) without touching the input. */
function replaceAt(value: unknown, at: readonly string[], next: unknown): unknown {
  if (at.length === 0) return next;
  const [head, ...rest] = at;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[Number(head)] = replaceAt(copy[Number(head)], rest, next);
    return copy;
  }
  const record = recordOf(value) ?? {};
  return { ...record, [head!]: replaceAt(record[head!], rest, next) };
}

export class ToolFileError extends Error {
  constructor(
    readonly code: "tool_file_ref_invalid" | "tool_file_not_found" | "tool_file_mismatch",
    readonly statusCode: number,
    readonly field?: string,
  ) {
    super(code);
    this.name = "ToolFileError";
  }
}

const REF_KEYS = ["bytes", "contentType", "fileRef", "filename", "sha256"];

function parseRef(value: Record<string, unknown>, field: string): ToolFileRef {
  const keys = Object.keys(value).sort();
  const valid =
    keys.length === REF_KEYS.length &&
    keys.every((key, index) => key === REF_KEYS[index]) &&
    typeof value.fileRef === "string" &&
    TOOL_FILE_REF_PATTERN.test(value.fileRef) &&
    typeof value.sha256 === "string" &&
    SHA256_PATTERN.test(value.sha256) &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    typeof value.contentType === "string" &&
    value.contentType.length <= 255 &&
    typeof value.filename === "string" &&
    value.filename.length > 0 &&
    value.filename.length <= 255;
  if (!valid) throw new ToolFileError("tool_file_ref_invalid", 400, field);
  return value as ToolFileRef;
}

export type FoundToolFileRef = { ref: ToolFileRef; at: string[]; field: string };

/**
 * The file references in `args` at the schema's file positions. A value with
 * a `fileRef` key must be exactly `{fileRef, sha256, bytes, contentType,
 * filename}` (400 `tool_file_ref_invalid` otherwise); inline `{base64}` files
 * are left alone. A reference is an opaque id, never a URL.
 */
export function findToolFileRefs(args: Record<string, unknown>, paths: readonly FileArgumentPath[]): FoundToolFileRef[] {
  const found: FoundToolFileRef[] = [];
  for (const filePath of paths) {
    for (const { value, at } of valuesAt(args, filePath)) {
      const record = recordOf(value);
      if (!record || !("fileRef" in record)) continue;
      const field = at.join(".");
      found.push({ ref: parseRef(record, field), at, field });
    }
  }
  return found;
}

/** `args` with each reference replaced by `replacement(ref)`. */
export function replaceToolFileRefs(
  args: Record<string, unknown>,
  refs: readonly FoundToolFileRef[],
  replacement: (found: FoundToolFileRef) => unknown,
): Record<string, unknown> {
  let next: unknown = args;
  for (const found of refs) next = replaceAt(next, found.at, replacement(found));
  return next as Record<string, unknown>;
}

/** What argument validation sees before the bytes are read: a file object of the right shape with empty content. */
export function placeholderFile(ref: ToolFileRef) {
  return { base64: "", filename: ref.filename, contentType: ref.contentType };
}

/** The declared values must equal the stored file. */
export function refMatchesRecord(ref: ToolFileRef, record: ToolFileRecord) {
  return (
    ref.sha256 === record.sha256 &&
    ref.bytes === record.bytes &&
    ref.contentType === record.contentType &&
    ref.filename === record.filename
  );
}

export function bindingMatches(record: ToolFileRecord, binding: ToolFileBinding) {
  return (
    record.workspaceSlug === binding.workspaceSlug &&
    record.deploymentId === binding.deploymentId &&
    record.agentId === binding.agentId &&
    record.consentId === binding.consentId
  );
}

// ---------------------------------------------------------------------------
// Bytes on disk
// ---------------------------------------------------------------------------

function bytesPath(rootDir: string, id: string) {
  if (!TOOL_FILE_REF_PATTERN.test(id)) throw new Error("tool_file_ref_invalid");
  return path.join(rootDir, id);
}

/** Writes the bytes to `<rootDir>/<fileRef>` atomically (temp file, fsync, rename), owner-readable only. */
export function writeToolFileBytes(rootDir: string, id: string, bytes: Uint8Array) {
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const target = bytesPath(rootDir, id);
  const temp = path.join(rootDir, `.${id}.${randomUUID()}.tmp`);
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
}

/** The stored bytes, or null when they are gone. The caller re-hashes them. */
export function readToolFileBytes(rootDir: string, id: string): Buffer | null {
  try {
    return fs.readFileSync(bytesPath(rootDir, id));
  } catch {
    return null;
  }
}

export function deleteToolFileBytes(rootDir: string, id: string) {
  try {
    fs.rmSync(bytesPath(rootDir, id), { force: true });
  } catch {
    // Already gone, or an invalid id: nothing to delete.
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function migrateToolFileTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_file (
      id TEXT PRIMARY KEY,
      workspace_slug TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      consent_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      action_key TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL,
      state TEXT NOT NULL,
      approval_id TEXT,
      used_key TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_slug, agent_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_file_agent_state ON tool_file(workspace_slug, agent_id, state);
    CREATE INDEX IF NOT EXISTS idx_tool_file_approval ON tool_file(approval_id);
  `);
}

type Row = Record<string, unknown>;

function recordFromRow(row: Row): ToolFileRecord {
  return {
    id: String(row.id),
    workspaceSlug: String(row.workspace_slug),
    deploymentId: String(row.deployment_id),
    agentId: String(row.agent_id),
    consentId: String(row.consent_id),
    pluginId: String(row.plugin_id),
    actionKey: String(row.action_key),
    sha256: String(row.sha256),
    bytes: Number(row.bytes),
    contentType: String(row.content_type),
    filename: String(row.filename),
    idempotencyKey: String(row.idempotency_key),
    fingerprint: String(row.fingerprint),
    response: JSON.parse(String(row.response_json)) as ToolFileRecord["response"],
    state: String(row.state) as ToolFileState,
    approvalId: row.approval_id === null || row.approval_id === undefined ? null : String(row.approval_id),
    usedKey: row.used_key === null || row.used_key === undefined ? null : String(row.used_key),
    expiresAt: String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export type InsertToolFileResult =
  | { ok: true; record: ToolFileRecord; created: boolean }
  | { ok: false; error: "tool_file_quota_exceeded"; limit: "files" | "bytes" };

export class ToolFileStore {
  constructor(private readonly db: DatabaseSync) {}

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

  get(id: string): ToolFileRecord | null {
    const row = this.db.prepare("SELECT * FROM tool_file WHERE id = ?").get(id) as Row | undefined;
    return row ? recordFromRow(row) : null;
  }

  findByKey(input: { workspaceSlug: string; agentId: string; idempotencyKey: string }): ToolFileRecord | null {
    const row = this.db
      .prepare("SELECT * FROM tool_file WHERE workspace_slug = ? AND agent_id = ? AND idempotency_key = ?")
      .get(input.workspaceSlug, input.agentId, input.idempotencyKey) as Row | undefined;
    return row ? recordFromRow(row) : null;
  }

  /** Files that hold bytes for this agent: live and unexpired, or pinned to a held call. */
  usage(input: { workspaceSlug: string; agentId: string; now: Date }): { files: number; bytes: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM tool_file
         WHERE workspace_slug = ? AND agent_id = ? AND (state = 'pinned' OR (state = 'live' AND expires_at > ?))`,
      )
      .get(input.workspaceSlug, input.agentId, input.now.toISOString()) as { files: number; bytes: number };
    return { files: Number(row.files), bytes: Number(row.bytes) };
  }

  /**
   * Upload within the per-agent quota, in one `BEGIN IMMEDIATE` transaction:
   * a concurrent upload with the same key returns the stored row (no second
   * file); otherwise the agent's live files plus this one stay within
   * `maxFiles` and `maxBytes`, then `write` stores the bytes and the row is
   * inserted. A refusal writes nothing.
   */
  insertWithinQuota(input: {
    id: string;
    binding: ToolFileBinding;
    pluginId: string;
    actionKey: string;
    sha256: string;
    bytes: number;
    contentType: string;
    filename: string;
    idempotencyKey: string;
    fingerprint: string;
    response: (expiresAt: string) => ToolFileRecord["response"];
    now: Date;
    ttlMs: number;
    maxFiles: number;
    maxBytes: number;
    write: () => void;
  }): InsertToolFileResult {
    return this.immediate<InsertToolFileResult>(() => {
      const existing = this.findByKey({
        workspaceSlug: input.binding.workspaceSlug,
        agentId: input.binding.agentId,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) return { ok: true, record: existing, created: false };
      const usage = this.usage({ workspaceSlug: input.binding.workspaceSlug, agentId: input.binding.agentId, now: input.now });
      if (usage.files >= input.maxFiles) return { ok: false, error: "tool_file_quota_exceeded", limit: "files" };
      if (usage.bytes + input.bytes > input.maxBytes) return { ok: false, error: "tool_file_quota_exceeded", limit: "bytes" };
      const timestamp = input.now.toISOString();
      const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
      input.write();
      this.db
        .prepare(
          `INSERT INTO tool_file (
            id, workspace_slug, deployment_id, agent_id, consent_id, plugin_id, action_key, sha256, bytes, content_type,
            filename, idempotency_key, fingerprint, response_json, state, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?)`,
        )
        .run(
          input.id,
          input.binding.workspaceSlug,
          input.binding.deploymentId,
          input.binding.agentId,
          input.binding.consentId,
          input.pluginId,
          input.actionKey,
          input.sha256,
          input.bytes,
          input.contentType,
          input.filename,
          input.idempotencyKey,
          input.fingerprint,
          JSON.stringify(input.response(expiresAt)),
          expiresAt,
          timestamp,
          timestamp,
        );
      return { ok: true, record: this.get(input.id)!, created: true };
    });
  }

  /**
   * A held call keeps its file: `live` → `pinned` to the approval, with the
   * approval's expiry (which overrides the 24 h TTL). Only an unexpired live
   * file of the same binding can be pinned. Returns false otherwise.
   */
  pin(input: { id: string; binding: ToolFileBinding; approvalId: string; usedKey: string; expiresAt: string; now: Date }): boolean {
    const now = input.now.toISOString();
    const result = this.db
      .prepare(
        `UPDATE tool_file SET state = 'pinned', approval_id = ?, used_key = ?, expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'live' AND expires_at > ?
           AND workspace_slug = ? AND deployment_id = ? AND agent_id = ? AND consent_id = ?`,
      )
      .run(
        input.approvalId,
        input.usedKey,
        input.expiresAt,
        now,
        input.id,
        now,
        input.binding.workspaceSlug,
        input.binding.deploymentId,
        input.binding.agentId,
        input.binding.consentId,
      );
    return Number(result.changes) === 1;
  }

  /**
   * Single use: claim the file for one execution. A direct call claims an
   * unexpired `live` file of its binding; an approved held call claims the
   * file `pinned` to its approval. Exactly one claimer wins.
   */
  consume(
    input:
      | { id: string; mode: "direct"; binding: ToolFileBinding; usedKey: string; now: Date }
      | { id: string; mode: "held"; approvalId: string; now: Date },
  ): ToolFileRecord | null {
    const now = input.now.toISOString();
    const result =
      input.mode === "direct"
        ? this.db
            .prepare(
              `UPDATE tool_file SET state = 'consumed', used_key = ?, updated_at = ?
               WHERE id = ? AND state = 'live' AND expires_at > ?
                 AND workspace_slug = ? AND deployment_id = ? AND agent_id = ? AND consent_id = ?`,
            )
            .run(
              input.usedKey,
              now,
              input.id,
              now,
              input.binding.workspaceSlug,
              input.binding.deploymentId,
              input.binding.agentId,
              input.binding.consentId,
            )
        : this.db
            .prepare(
              `UPDATE tool_file SET state = 'consumed', updated_at = ?
               WHERE id = ? AND state = 'pinned' AND approval_id = ? AND expires_at > ?`,
            )
            .run(now, input.id, input.approvalId, now);
    return Number(result.changes) === 1 ? this.get(input.id) : null;
  }

  /** Undo a direct claim that never ran (the idempotency step refused the call): `consumed` → `live`. */
  unconsume(input: { id: string; usedKey: string; now: Date }): boolean {
    const result = this.db
      .prepare(
        `UPDATE tool_file SET state = 'live', used_key = NULL, updated_at = ?
         WHERE id = ? AND state = 'consumed' AND approval_id IS NULL AND used_key = ?`,
      )
      .run(input.now.toISOString(), input.id, input.usedKey);
    return Number(result.changes) === 1;
  }

  /**
   * Files whose bytes must go: live or pinned past their expiry (`expired`),
   * and pinned files whose held call ended without running them (`released`).
   */
  listDue(input: { now: Date; limit?: number }): Array<{ record: ToolFileRecord; next: "expired" | "released" }> {
    const now = input.now.toISOString();
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
    const expired = (
      this.db
        .prepare(`SELECT * FROM tool_file WHERE state IN ('live', 'pinned') AND expires_at <= ? ORDER BY expires_at LIMIT ?`)
        .all(now, limit) as Row[]
    ).map((row) => ({ record: recordFromRow(row), next: "expired" as const }));
    const released = (
      this.db
        .prepare(
          `SELECT f.* FROM tool_file f JOIN company_box_approval a ON a.id = f.approval_id
           WHERE f.state = 'pinned' AND f.expires_at > ? AND a.state IN ('denied', 'expired', 'failed', 'succeeded') LIMIT ?`,
        )
        .all(now, limit) as Row[]
    ).map((row) => ({ record: recordFromRow(row), next: "released" as const }));
    return [...expired, ...released];
  }

  /** Move a file from `from` to a terminal state; false when another sweep or a claim won. */
  retire(input: { id: string; from: ToolFileState; to: "expired" | "released"; now: Date }): boolean {
    const result = this.db
      .prepare("UPDATE tool_file SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
      .run(input.to, input.now.toISOString(), input.id, input.from);
    return Number(result.changes) === 1;
  }

  /** Terminal rows older than `before` go (their bytes are already deleted). */
  purgeTerminal(before: Date): number {
    const result = this.db
      .prepare("DELETE FROM tool_file WHERE state IN ('consumed', 'expired', 'released') AND updated_at < ?")
      .run(before.toISOString());
    return Number(result.changes);
  }

  listForApproval(approvalId: string): ToolFileRecord[] {
    return (this.db.prepare("SELECT * FROM tool_file WHERE approval_id = ? ORDER BY created_at").all(approvalId) as Row[]).map(recordFromRow);
  }
}

/**
 * Tool files (issue #59): upload, resolution, single-use claims, held-call
 * pins, expiry and the owner's view. Routes live in app.ts; this module holds
 * the rules so both execution paths (a direct `marketplace.tools.call` and an
 * approved held call) share one implementation.
 *
 * Audit / Activity rows carry ids, sha256 and size only: never the bytes and
 * never the file name.
 */
import { createHash } from "node:crypto";

import type { SqliteMarketplaceStore } from "./store.js";
import {
  bindingMatches,
  checkToolFileType,
  deleteToolFileBytes,
  findToolFileRefs,
  newToolFileRef,
  placeholderFile,
  readToolFileBytes,
  refMatchesRecord,
  replaceToolFileRefs,
  sha256Hex,
  TOOL_FILE_QUOTA_BYTES,
  TOOL_FILE_QUOTA_FILES,
  TOOL_FILE_ROW_RETENTION_MS,
  TOOL_FILE_TTL_MS,
  toolFilePreviewable,
  ToolFileError,
  writeToolFileBytes,
  type FileArgumentPath,
  type FoundToolFileRef,
  type ToolFileBinding,
  type ToolFileRecord,
} from "./tool-files.js";

export type ToolFileReply = { status: number; body: Record<string, unknown> };

/** A claimed set of files: the arguments with the bytes in, and how to finish. */
export type ToolFileClaim = {
  args: Record<string, unknown>;
  /** The call never ran (idempotency refusal): give direct claims back. */
  release: () => void;
  /** After the provider call (success or failure): delete the consumed bytes. */
  cleanup: () => void;
};

export type ToolFileService = ReturnType<typeof createToolFileService>;

export function createToolFileService(deps: {
  store: SqliteMarketplaceStore;
  rootDir: string;
  now: () => Date;
  maxUploadBytes: number;
}) {
  const files = () => deps.store.toolFiles;

  const audit = (record: ToolFileRecord, eventType: string, extra: Record<string, unknown> = {}) => {
    deps.store.recordAudit({
      workspaceSlug: record.workspaceSlug,
      pluginId: record.pluginId,
      eventType,
      actorId: `agent:${record.agentId}`,
      metadata: {
        fileRef: record.id,
        consentId: record.consentId,
        actionKey: record.actionKey,
        sha256: record.sha256,
        bytes: record.bytes,
        ...extra,
      },
    });
  };

  const mismatch = (record: ToolFileRecord, field: string, reason: "declared" | "stored"): never => {
    audit(record, "marketplace.tool_files.mismatch", { field, reason });
    throw new ToolFileError("tool_file_mismatch", 409, field);
  };

  /** Read the bytes and re-hash them against the stored digest; a difference refuses the call. */
  const verifiedBytes = (record: ToolFileRecord, field: string) => {
    const bytes = readToolFileBytes(deps.rootDir, record.id);
    if (!bytes) throw new ToolFileError("tool_file_not_found", 404, field);
    if (bytes.byteLength !== record.bytes || sha256Hex(bytes) !== record.sha256) mismatch(record, field, "stored");
    return bytes!;
  };

  const materialize = (args: Record<string, unknown>, claimed: Array<{ found: FoundToolFileRef; record: ToolFileRecord }>) => {
    const bytesById = new Map(claimed.map(({ found, record }) => [record.id, verifiedBytes(record, found.field)]));
    return replaceToolFileRefs(args, claimed.map(({ found }) => found), (found) => ({
      base64: bytesById.get(found.ref.fileRef)!.toString("base64"),
      filename: found.ref.filename,
      contentType: found.ref.contentType,
    }));
  };

  const service = {
    rootDir: deps.rootDir,

    /**
     * `marketplace.tool-files.upload` after the route has verified the caller, the consent binding and the
     * action's file input. Idempotent on the key: the same key and file answer the first answer, with no
     * second file; the same key with another file is a conflict. A quota refusal stores nothing.
     */
    upload(input: {
      binding: ToolFileBinding;
      pluginId: string;
      actionKey: string;
      idempotencyKey: string;
      contentType: string;
      filename: string;
      bytes: Buffer;
    }): ToolFileReply {
      const now = deps.now();
      if (input.bytes.byteLength === 0) return { status: 400, body: { ok: false, error: "tool_file_empty" } };
      if (input.bytes.byteLength > deps.maxUploadBytes) {
        return { status: 413, body: { ok: false, error: "tool_file_too_large", maxBytes: deps.maxUploadBytes } };
      }
      const type = checkToolFileType({ bytes: input.bytes, contentType: input.contentType, filename: input.filename });
      if (!type.ok) return { status: type.status, body: { ok: false, error: type.error } };
      const sha256 = sha256Hex(input.bytes);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ consentId: input.binding.consentId, sha256, contentType: input.contentType, filename: input.filename }))
        .digest("hex");
      const replay = (record: ToolFileRecord): ToolFileReply =>
        record.fingerprint === fingerprint && record.consentId === input.binding.consentId
          ? { status: record.response.status, body: { ...record.response.body, replayed: true } }
          : { status: 409, body: { ok: false, error: "idempotency_conflict" } };
      const previous = files().findByKey({
        workspaceSlug: input.binding.workspaceSlug,
        agentId: input.binding.agentId,
        idempotencyKey: input.idempotencyKey,
      });
      if (previous) return replay(previous);
      const id = newToolFileRef();
      let wrote = false;
      let inserted;
      try {
        inserted = files().insertWithinQuota({
          id,
          binding: input.binding,
          pluginId: input.pluginId,
          actionKey: input.actionKey,
          sha256,
          bytes: input.bytes.byteLength,
          contentType: input.contentType,
          filename: input.filename,
          idempotencyKey: input.idempotencyKey,
          fingerprint,
          response: (expiresAt) => ({
            status: 201,
            body: {
              ok: true,
              schema: 1,
              fileRef: id,
              sha256,
              bytes: input.bytes.byteLength,
              contentType: input.contentType,
              filename: input.filename,
              expiresAt,
            },
          }),
          now,
          ttlMs: TOOL_FILE_TTL_MS,
          maxFiles: TOOL_FILE_QUOTA_FILES,
          maxBytes: TOOL_FILE_QUOTA_BYTES,
          write: () => {
            writeToolFileBytes(deps.rootDir, id, input.bytes);
            wrote = true;
          },
        });
      } catch (error) {
        if (wrote) deleteToolFileBytes(deps.rootDir, id);
        throw error;
      }
      if (!inserted.ok) {
        return {
          status: 429,
          body: { ok: false, error: inserted.error, limit: inserted.limit, maxFiles: TOOL_FILE_QUOTA_FILES, maxBytes: TOOL_FILE_QUOTA_BYTES },
        };
      }
      // A concurrent upload with the same key won the insert: answer like a replay.
      if (!inserted.created) return replay(inserted.record);
      audit(inserted.record, "marketplace.tool_files.uploaded", { expiresAt: inserted.record.expiresAt });
      return inserted.record.response;
    },

    /**
     * `marketplace.tools.call` check before any execution: every reference at a file position must belong to
     * this deployment, agent and consent, and be unexpired and unused (or already used by this very call, so an
     * exact retry still replays). Anything else is the same 404. Declared values that differ from the stored
     * file are 409 `tool_file_mismatch`. Throws ToolFileError.
     */
    resolve(input: { args: Record<string, unknown>; paths: readonly FileArgumentPath[]; binding: ToolFileBinding; idempotencyKey: string }) {
      const found = findToolFileRefs(input.args, input.paths);
      const now = deps.now().toISOString();
      const seen = new Set<string>();
      for (const entry of found) {
        if (seen.has(entry.ref.fileRef)) throw new ToolFileError("tool_file_ref_invalid", 400, entry.field);
        seen.add(entry.ref.fileRef);
        const record = files().get(entry.ref.fileRef);
        const usable =
          record !== null &&
          bindingMatches(record, input.binding) &&
          ((record.state === "live" && record.expiresAt > now) || record.usedKey === input.idempotencyKey);
        if (!usable) throw new ToolFileError("tool_file_not_found", 404, entry.field);
        if (!refMatchesRecord(entry.ref, record!)) mismatch(record!, entry.field, "declared");
      }
      return found;
    },

    /** Arguments for schema validation before the bytes are read (each reference becomes an empty file object). */
    placeholders(args: Record<string, unknown>, refs: readonly FoundToolFileRef[]) {
      return replaceToolFileRefs(args, refs, (found) => placeholderFile(found.ref));
    },

    /**
     * Direct execution: claim each file once (live → consumed), re-hash its bytes and put them in the
     * arguments. A file already consumed by this same key means this is a retry the idempotency step will
     * replay: nothing is claimed and the arguments are never sent.
     */
    claimDirect(input: { args: Record<string, unknown>; refs: readonly FoundToolFileRef[]; binding: ToolFileBinding; usedKey: string }): ToolFileClaim | { replay: true } {
      if (input.refs.length === 0) return { args: input.args, release: () => undefined, cleanup: () => undefined };
      const already = input.refs.every((found) => {
        const record = files().get(found.ref.fileRef);
        return record?.state === "consumed" && record.usedKey === input.usedKey && bindingMatches(record, input.binding);
      });
      if (already) return { replay: true };
      const claimed: Array<{ found: FoundToolFileRef; record: ToolFileRecord }> = [];
      const giveBack = () => {
        for (const { record } of claimed) files().unconsume({ id: record.id, usedKey: input.usedKey, now: deps.now() });
      };
      try {
        for (const found of input.refs) {
          const record = files().consume({ id: found.ref.fileRef, mode: "direct", binding: input.binding, usedKey: input.usedKey, now: deps.now() });
          if (!record) throw new ToolFileError("tool_file_not_found", 404, found.field);
          if (!refMatchesRecord(found.ref, record)) {
            claimed.push({ found, record });
            mismatch(record, found.field, "declared");
          }
          claimed.push({ found, record });
        }
        const args = materialize(input.args, claimed);
        for (const { record } of claimed) audit(record, "marketplace.tool_files.consumed", { via: "tools.call" });
        return {
          args,
          release: giveBack,
          cleanup: () => {
            for (const { record } of claimed) deleteToolFileBytes(deps.rootDir, record.id);
          },
        };
      } catch (error) {
        // A refused claim (mismatch or a lost race) never runs: give the other files back.
        giveBack();
        throw error;
      }
    },

    /** A held call keeps its files until the decision: pin each to the approval (expiry = the approval's). */
    pin(input: { refs: readonly FoundToolFileRef[]; binding: ToolFileBinding; approvalId: string; usedKey: string; expiresAt: string }) {
      for (const found of input.refs) {
        const pinned = files().pin({
          id: found.ref.fileRef,
          binding: input.binding,
          approvalId: input.approvalId,
          usedKey: input.usedKey,
          expiresAt: input.expiresAt,
          now: deps.now(),
        });
        if (!pinned) return false;
        audit(files().get(found.ref.fileRef)!, "marketplace.tool_files.pinned", { approvalId: input.approvalId, expiresAt: input.expiresAt });
      }
      return true;
    },

    /**
     * Approved held call: claim the files pinned to this approval (pinned → consumed), re-hash and put the
     * bytes in. The held arguments still hold the references the approval digest covers. Throws ToolFileError.
     */
    claimHeld(input: { args: Record<string, unknown>; paths: readonly FileArgumentPath[]; approvalId: string }): ToolFileClaim {
      const refs = findToolFileRefs(input.args, input.paths);
      if (refs.length === 0) return { args: input.args, release: () => undefined, cleanup: () => undefined };
      const claimed: Array<{ found: FoundToolFileRef; record: ToolFileRecord }> = [];
      const cleanup = () => {
        for (const { record } of claimed) deleteToolFileBytes(deps.rootDir, record.id);
      };
      try {
        for (const found of refs) {
          const record = files().consume({ id: found.ref.fileRef, mode: "held", approvalId: input.approvalId, now: deps.now() });
          if (!record) throw new ToolFileError("tool_file_not_found", 404, found.field);
          claimed.push({ found, record });
          if (!refMatchesRecord(found.ref, record)) mismatch(record, found.field, "declared");
        }
        const args = materialize(input.args, claimed);
        for (const { record } of claimed) audit(record, "marketplace.tool_files.consumed", { via: "approval", approvalId: input.approvalId });
        return { args, release: () => undefined, cleanup };
      } catch (error) {
        // Single use: a held call that cannot run its file does not keep it.
        cleanup();
        throw error;
      }
    },

    /** Delete the bytes of expired files and of files whose held call ended without them; purge old rows. */
    sweep() {
      const now = deps.now();
      let retired = 0;
      for (const { record, next } of files().listDue({ now })) {
        if (!files().retire({ id: record.id, from: record.state, to: next, now })) continue;
        deleteToolFileBytes(deps.rootDir, record.id);
        audit(record, next === "expired" ? "marketplace.tool_files.expired" : "marketplace.tool_files.released", {
          ...(record.approvalId ? { approvalId: record.approvalId } : {}),
        });
        retired += 1;
      }
      files().purgeTerminal(new Date(now.getTime() - TOOL_FILE_ROW_RETENTION_MS));
      return retired;
    },

    /** The owner's Approvals view: what the held call will send (the declared values the digest covers). */
    approvalFiles(input: { approvalId: string; args: Record<string, unknown>; paths: readonly FileArgumentPath[] }) {
      let refs: FoundToolFileRef[];
      try {
        refs = findToolFileRefs(input.args, input.paths);
      } catch {
        return [];
      }
      return refs.map(({ ref, field }) => {
        const record = files().get(ref.fileRef);
        const available = record?.state === "pinned" && record.approvalId === input.approvalId;
        return {
          field,
          fileRef: ref.fileRef,
          filename: ref.filename,
          contentType: ref.contentType,
          bytes: ref.bytes,
          sha256: ref.sha256,
          state: record && record.approvalId === input.approvalId ? record.state : "unavailable",
          previewable: available && toolFilePreviewable(ref.contentType),
        };
      });
    },

    /** Owner preview/download: the file pinned to this approval, re-hashed; null when gone or not an image/PDF. */
    ownerFile(input: { approvalId: string; fileRef: string }) {
      const record = files().get(input.fileRef);
      if (!record || record.state !== "pinned" || record.approvalId !== input.approvalId || !toolFilePreviewable(record.contentType)) return null;
      const bytes = readToolFileBytes(deps.rootDir, record.id);
      if (!bytes || bytes.byteLength !== record.bytes || sha256Hex(bytes) !== record.sha256) return null;
      return { record, bytes };
    },
  };
  return service;
}

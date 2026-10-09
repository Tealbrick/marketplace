import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  createContractHandler,
  type AuthRequest,
  type ClaimBinding,
  type ClaimStore,
  type ContractAuditEvent,
  type ContractHandler,
  type CredentialResult,
  type CredentialVerifier,
} from "@tealbrick/contract";

import { MARKETPLACE_MANIFEST } from "./contract.js";
import { INSTANCE_CLAIM_TTL_SECONDS, type MarketplaceInstanceClaim } from "./instance-claim.js";

/**
 * Manifest claim (`tealbrick.miniapp/v1`, `runtime.claim`) for Marketplace.
 *
 * `/.well-known/tealbrick/claim` speaks the contract kit's handshake: `GET` → `{instanceId, publicJwk}`,
 * `POST {portalIssuer, nonce, companyId, jwksUri?, grantKids?}` → `{proof}`. The proof is signed with the
 * SAME Ed25519 key and instance id as the legacy `/api/tealbrick/claim` route (the identity file beside the
 * SQLite database); this module never generates a key. The Portal grant trust anchors (`jwksUri`,
 * `grantKids`) and the pinned issuer/tenant are kept in {@link INSTANCE_CLAIM_BINDING_FILE}, so app
 * grants can later be verified against them (`l2GrantOptionsFromClaim`).
 */
export const MANIFEST_CLAIM_PATH = "/.well-known/tealbrick/claim";
export const INSTANCE_CLAIM_BINDING_FILE = "instance-claim-binding.json";

const BINDING_KEYS = new Set(["portalIssuer", "tenantId", "instanceId", "claimedAt", "lastClaimAt", "jwksUri", "grantKids"]);

function parseBinding(raw: unknown): ClaimBinding {
  const value = raw as Record<string, unknown> | null;
  const timestamp = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !BINDING_KEYS.has(key)) ||
    typeof value.portalIssuer !== "string" ||
    typeof value.tenantId !== "string" ||
    typeof value.instanceId !== "string" ||
    !timestamp(value.claimedAt) ||
    !timestamp(value.lastClaimAt) ||
    (value.jwksUri !== undefined && typeof value.jwksUri !== "string") ||
    (value.grantKids !== undefined &&
      (!Array.isArray(value.grantKids) || !value.grantKids.every((kid) => typeof kid === "string")))
  ) {
    throw new Error("Invalid Marketplace claim binding storage");
  }
  return Object.freeze({
    portalIssuer: value.portalIssuer,
    tenantId: value.tenantId,
    instanceId: value.instanceId,
    claimedAt: value.claimedAt as number,
    lastClaimAt: value.lastClaimAt as number,
    ...(value.jwksUri !== undefined ? { jwksUri: value.jwksUri } : {}),
    ...(value.grantKids !== undefined ? { grantKids: Object.freeze([...(value.grantKids as string[])]) } : {}),
  });
}

/**
 * Durable {@link ClaimStore}: one JSON file beside the claim identity, mode 0600, replaced atomically.
 * It holds no secret (issuer, tenant, instance id, timestamps, grant JWKS URL and kids). An unsafe or
 * malformed file fails the claim closed (the kit answers 500) instead of being silently replaced.
 */
/** A synchronous {@link ClaimStore} (file-backed). */
export type FileClaimStore = { read(): ClaimBinding | null; write(binding: ClaimBinding): void };

export function createFileClaimStore(dataDir: string): FileClaimStore {
  const filename = path.join(dataDir, INSTANCE_CLAIM_BINDING_FILE);
  return Object.freeze({
    read(): ClaimBinding | null {
      let stat;
      try {
        stat = lstatSync(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384) {
        throw new Error("Unsafe Marketplace claim binding storage");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(filename, "utf8"));
      } catch {
        throw new Error("Invalid Marketplace claim binding storage");
      }
      return parseBinding(withoutVersion(parsed));
    },
    write(binding: ClaimBinding) {
      const checked = parseBinding(JSON.parse(JSON.stringify(binding)));
      const staging = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(staging, JSON.stringify({ version: 1, ...checked }), { mode: 0o600, flag: "wx" });
      try {
        renameSync(staging, filename);
      } catch (error) {
        unlinkSync(staging);
        throw error;
      }
    },
  });
}

/** `parseBinding` refuses the `version` marker; strip it before validation. */
function withoutVersion(raw: unknown) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { version, ...rest } = raw as Record<string, unknown>;
    if (version !== 1) throw new Error("Invalid Marketplace claim binding storage");
    return rest;
  }
  return raw;
}

/**
 * Wraps the legacy claim credential rule (`accepts`) as a kit {@link CredentialVerifier}, so both claim
 * paths accept exactly the same Portal-held credentials: the internal bearer, `x-knowledge-instance-token`
 * (internal token or `TEALBRICK_INSTANCE_TOKEN`) and `x-tealbrick-instance-proof`, all compared in
 * constant time by `accepts`. The kit refuses browser requests (Origin or Cookie) before this runs.
 */
export function createClaimCredentialVerifier(
  accepts: (headers: Record<string, unknown>) => boolean,
): CredentialVerifier {
  return Object.freeze({
    kind: "instance" as const,
    async verify(request: AuthRequest): Promise<CredentialResult> {
      const headers = request.headers as Record<string, unknown>;
      if (typeof (headers as { get?: unknown }).get === "function") return { ok: false, reason: "malformed_credential" };
      if (!accepts(headers)) {
        const presented = ["authorization", "x-knowledge-instance-token", "x-tealbrick-instance-proof"].some(
          (name) => headers[name] !== undefined,
        );
        return { ok: false, reason: presented ? "denied" : "missing_credential" };
      }
      return { ok: true, credential: Object.freeze({ kind: "instance" as const, subject: "portal-claim" }) };
    },
  });
}

export type ManifestClaimOptions = {
  /** The one claim identity (instance id + Ed25519 key) shared with the legacy claim route. */
  readonly identity: MarketplaceInstanceClaim;
  /** Directory of the identity file; the binding file lives beside it. */
  readonly dataDir: string;
  /** Legacy credential rule (see {@link createClaimCredentialVerifier}). */
  readonly accepts: (headers: Record<string, unknown>) => boolean;
  /** Configured Portal issuer and workspace. Without both, `POST` stays unhandled (the app answers 503). */
  readonly scope: { readonly portalIssuer: string; readonly companyId: string } | null;
  readonly store?: ClaimStore;
  readonly now?: () => number;
  readonly audit?: (event: ContractAuditEvent) => void;
};

export type ManifestClaim = {
  readonly handler: ContractHandler;
  readonly store: ClaimStore;
};

/**
 * The kit's claim handler, mounted for the manifest path only. It serves nothing but the claim: status,
 * settings and companions stay on the main contract handler (`status: false`, no settings/companions).
 */
export function createManifestClaim(options: ManifestClaimOptions): ManifestClaim {
  const store = options.store ?? createFileClaimStore(options.dataDir);
  const handler = createContractHandler({
    manifest: MARKETPLACE_MANIFEST,
    claimPaths: [MANIFEST_CLAIM_PATH],
    status: false,
    identity: { instanceId: options.identity.instanceId, publicJwk: options.identity.publicJwk },
    ...(options.scope
      ? {
          claim: {
            privateKey: options.identity.claimSigningKey(),
            tenantId: options.scope.companyId,
            issuers: [options.scope.portalIssuer],
            store,
            proofTtlSeconds: INSTANCE_CLAIM_TTL_SECONDS,
            ...(options.now ? { now: options.now } : {}),
          },
        }
      : {}),
    auth: { instance: createClaimCredentialVerifier(options.accepts) },
    ...(options.audit ? { audit: options.audit } : {}),
  });
  return { handler, store };
}

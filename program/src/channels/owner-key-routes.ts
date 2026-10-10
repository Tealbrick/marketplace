import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { USER_PRINCIPAL_PREFIX } from "@tealbrick/contract";
import { z } from "zod";

import type { MarketplacePrincipal } from "../operator-auth.js";
import type { SqliteMarketplaceStore } from "../store.js";
import { OWNER_NOSTR_KEY_SETTING, ownerKeyFingerprint, ownerKeyView, parseOwnerNostrPubkey, type OwnerKeyView } from "./owner-key.js";
import { readAttestedOwnerNostrPubkey, readOwnerPin, type OwnerPinSource } from "./owner-pin.js";

/**
 * Owner Buzz key routes (Channels spec §6.3, owner audience):
 *
 * - `GET    /api/marketplace/approvals/owner-key` (`marketplace.approval-owner-key.get`): fingerprint, trust
 *   source and status. Any owner operator session.
 * - `PUT    /api/marketplace/approvals/owner-key` `{pubkey}` (`marketplace.approval-owner-key.update`)
 * - `DELETE /api/marketplace/approvals/owner-key` (`marketplace.approval-owner-key.clear`)
 *
 * Writes need the owner's own operator session from a Portal launch ticket with its CSRF token. Refused:
 * agents (`tbag_`, refused earlier by the grant guard as an owner operation), runtime leases, the service
 * bearer, the Portal settings relay bearer, the emergency session, the operator access-token session and
 * the test bypass. The claim binding must pin the owner (`ownerSubject`) and the session user must be it;
 * without a pin every write is `409 approval_owner_unbound` (review M1, fail closed).
 * Every change (set, change, clear) is audited with the old and new fingerprints, the actor and the time;
 * the raw key is never audited, returned or logged.
 */

export const OWNER_KEY_ROUTE = "/api/marketplace/approvals/owner-key";

/** `{pubkey}`; `workspaceSlug` and `actorId` are bound by the server from the session (never trusted from the client). */
const OwnerKeyBody = z.strictObject({ pubkey: z.string().min(1).max(128), workspaceSlug: z.string().optional(), actorId: z.string().optional() });

export type OwnerKeyRouteDeps = {
  app: FastifyInstance;
  store: SqliteMarketplaceStore;
  organizationId: string;
  pinSource: OwnerPinSource;
  /** Any operator principal (reads). */
  requireOperator: (request: FastifyRequest, reply: FastifyReply) => MarketplacePrincipal | null;
  /** The owner's Portal launch session with a valid CSRF token, or null (writes). */
  ownerLaunchSession: (request: FastifyRequest) => MarketplacePrincipal | null;
};

/** The owner key state for the owner UI and the Approvals view (fingerprints only). */
export async function currentOwnerKeyView(store: SqliteMarketplaceStore, organizationId: string, pinSource: OwnerPinSource): Promise<OwnerKeyView & { ownerPin: "pinned" | "unbound" }> {
  const record = store.channels.getOwnerKey(organizationId);
  const attested = await readAttestedOwnerNostrPubkey(pinSource);
  // `unbound`: Portal has not confirmed the deployment owner yet (no ownerSubject pin), so the key cannot be set.
  const ownerPin = (await readOwnerPin(pinSource)) ? "pinned" : "unbound";
  return { ...ownerKeyView(record?.pubkey ? { pubkey: record.pubkey, setAt: record.setAt } : null, attested), ownerPin };
}

export function registerOwnerKeyRoutes(deps: OwnerKeyRouteDeps): void {
  const { app, store, organizationId: org } = deps;

  const refuse = (reply: FastifyReply, status: number, error: string) => {
    reply.code(status);
    return { ok: false, error };
  };

  app.get(OWNER_KEY_ROUTE, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = deps.requireOperator(request, reply);
    if (!principal) return { ok: false, error: "marketplace_operator_required" };
    if (principal.organizationId !== org) return refuse(reply, 403, "marketplace_operator_required");
    return { ok: true, ownerKey: await currentOwnerKeyView(store, org, deps.pinSource) };
  });

  const write = async (request: FastifyRequest, reply: FastifyReply, pubkey: string | null) => {
    const actor = `operator:${(deps.ownerLaunchSession(request) as MarketplacePrincipal).id}`;
    const fingerprint = pubkey ? ownerKeyFingerprint(pubkey) : null;
    const now = new Date();
    const result = store.channels.setOwnerKey({ workspaceSlug: org, pubkey, fingerprint, actor, now });
    if (result.changed) {
      store.recordAudit({
        workspaceSlug: org,
        eventType: "marketplace.approvals.owner_key.changed",
        actorId: actor,
        metadata: {
          setting: OWNER_NOSTR_KEY_SETTING,
          change: !pubkey ? "clear" : result.previousFingerprint ? "change" : "set",
          oldFingerprint: result.previousFingerprint,
          newFingerprint: result.fingerprint,
          invalidatedHolds: result.invalidated,
          at: now.toISOString(),
        },
      });
    }
    return {
      ok: true,
      changed: result.changed,
      invalidatedHolds: result.invalidated,
      ownerKey: await currentOwnerKeyView(store, org, deps.pinSource),
    };
  };

  /** The owner session gate for writes; answers the refusal itself and returns false. */
  const ownerWriter = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean | "approval_owner_unbound"> => {
    reply.header("cache-control", "no-store");
    const principal = deps.requireOperator(request, reply);
    if (!principal) return false;
    const owner = deps.ownerLaunchSession(request);
    // The launch session itself (cookie + CSRF, checked strictly) is the actor; the request principal only gates the org.
    if (!owner || owner.organizationId !== org || principal.organizationId !== org) {
      reply.code(403);
      return false;
    }
    // Review M1: only the PINNED deployment owner (claim binding `ownerSubject`, alpha.7) may change the key.
    // Without a pin (no claim yet, or a cleared one) nobody can: any Portal-launched member would otherwise
    // qualify. Same fail-closed rule as portal proofs.
    const pin = await readOwnerPin(deps.pinSource);
    if (!pin) {
      reply.code(409);
      return "approval_owner_unbound";
    }
    if (pin.ownerSubject !== `${USER_PRINCIPAL_PREFIX}${owner.id}`) {
      reply.code(403);
      return false;
    }
    return true;
  };
  const writerRefusal = (gate: boolean | string) => ({ ok: false, error: typeof gate === "string" ? gate : "owner_session_required" });

  app.put(OWNER_KEY_ROUTE, { bodyLimit: 1_024 }, async (request, reply) => {
    const gate = await ownerWriter(request, reply);
    if (gate !== true) return writerRefusal(gate);
    const body = OwnerKeyBody.safeParse(request.body);
    if (!body.success) return refuse(reply, 400, "owner_key_invalid");
    const parsed = parseOwnerNostrPubkey(body.data.pubkey);
    if (!parsed.ok) return refuse(reply, 400, parsed.error);
    return write(request, reply, parsed.pubkey);
  });

  app.delete(OWNER_KEY_ROUTE, async (request, reply) => {
    const gate = await ownerWriter(request, reply);
    if (gate !== true) return writerRefusal(gate);
    return write(request, reply, null);
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { BuzzIdentity } from "./buzz-identity.js";
import type { OwnerWriterGateResult } from "./owner-key-routes.js";

/**
 * Owner routes for the Buzz connection identity (audience owner; also in inert mode, since the identity is what
 * turns Buzz on):
 *
 * - `GET    /api/marketplace/channels/buzz/identity` (`marketplace.channel-buzz-identity.get`): npub, relay URL, tag
 *   status, end date and renewal reminder, and the exact NIP-OA preimage to sign. Never the secret key.
 * - `POST   /api/marketplace/channels/buzz/identity/key` `{rotate?}` (`marketplace.channel-buzz-key.generate`):
 *   generate the agent key, or rotate it (the old key is destroyed and the tag cleared).
 * - `PUT    /api/marketplace/channels/buzz/identity` `{relayUrl?, authTag?}` (`marketplace.channel-buzz-identity.update`)
 * - `DELETE /api/marketplace/channels/buzz/identity/auth-tag` (`marketplace.channel-buzz-auth-tag.revoke`)
 *
 * Every WRITE uses the strict owner gate of the owner-key routes (review M1): the owner's own Portal launch
 * session with its CSRF token, and the pinned `ownerSubject` equal to the session user; without a pin
 * `409 approval_owner_unbound`. Another operator could otherwise point the bridge at their own relay.
 */

export const BUZZ_IDENTITY_ROUTE = "/api/marketplace/channels/buzz/identity";

/** `workspaceSlug` and `actorId` are bound by the server from the session (never trusted; the gate names the actor). */
const KeyBody = z.strictObject({ rotate: z.boolean().optional(), workspaceSlug: z.string().optional(), actorId: z.string().optional() });
const UpdateBody = z.strictObject({
  relayUrl: z.string().min(1).max(300).optional(),
  authTag: z.union([z.string().min(1).max(4096), z.array(z.string().max(1024)).max(8)]).optional(),
  workspaceSlug: z.string().optional(),
  actorId: z.string().optional(),
});

export type BuzzIdentityRouteDeps = {
  app: FastifyInstance;
  identity: BuzzIdentity;
  /** The channel owner gate (operator, organization), allowing inert mode: reads only. */
  owner: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string } | null>;
  /** The strict owner gate (launch session + CSRF + pinned owner): every write. */
  ownerWriter: (request: FastifyRequest, reply: FastifyReply) => Promise<OwnerWriterGateResult>;
  ownerDenied: (request: FastifyRequest) => unknown;
  fail: (reply: FastifyReply, status: number, error: string, extra?: Record<string, unknown>) => Record<string, unknown>;
  /** Re-verify the provider, restart the relay socket and swap the bridge sink after a change. */
  onChanged: () => Promise<void>;
  /** Bridge cleanup with the old key before a rotation (report for the answer). */
  beforeRotate?: () => Promise<Record<string, unknown>>;
  /** False in inert mode: a first identity takes effect after the next start. */
  configured: boolean;
};

export function registerBuzzIdentityRoutes(deps: BuzzIdentityRouteDeps): void {
  const { app, identity } = deps;
  const writer = async (request: FastifyRequest, reply: FastifyReply): Promise<string | { ok: false; schema: 1; error: string }> => {
    const gate = await deps.ownerWriter(request, reply);
    return gate.ok ? gate.actor : { ok: false, schema: 1, error: gate.error === "marketplace_operator_required" ? "owner_session_required" : gate.error };
  };
  const answer = async (reply: FastifyReply, result: Awaited<ReturnType<BuzzIdentity["update"]>>, extra: Record<string, unknown> = {}) => {
    if (!result.ok) return deps.fail(reply, result.status, result.error, result.detail ? { detail: result.detail } : {});
    if (result.changed) await deps.onChanged();
    return { ok: true, schema: 1, changed: result.changed, buzz: identity.view(), ...extra, ...(deps.configured ? {} : { appliesAfterRestart: true }) };
  };

  app.get(BUZZ_IDENTITY_ROUTE, async (request, reply) => {
    const principal = await deps.owner(request, reply);
    if (!principal) return deps.ownerDenied(request);
    return { ok: true, schema: 1, buzz: identity.view(), ...(deps.configured ? {} : { appliesAfterRestart: true }) };
  });

  app.post(`${BUZZ_IDENTITY_ROUTE}/key`, { bodyLimit: 1024 }, async (request, reply) => {
    const actor = await writer(request, reply);
    if (typeof actor !== "string") return actor;
    const body = KeyBody.safeParse(request.body ?? {});
    if (!body.success) return deps.fail(reply, 400, "validation_failed");
    // Before a rotation, with the OLD key still in the store: delete the bridged messages and bridge channels
    // (the new key could not: Buzz deletes are author-only). Rotation proceeds even if the relay is down.
    const cleanup = body.data.rotate === true && identity.hasKey() && deps.beforeRotate ? await deps.beforeRotate() : null;
    return answer(reply, identity.generateKey({ rotate: body.data.rotate === true, actor }), cleanup ? { bridgeCleanup: cleanup } : {});
  });

  app.put(BUZZ_IDENTITY_ROUTE, { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const actor = await writer(request, reply);
    if (typeof actor !== "string") return actor;
    const body = UpdateBody.safeParse(request.body ?? {});
    // The body may hold a mistaken secret; validation errors never echo it.
    if (!body.success || (body.data.relayUrl === undefined && body.data.authTag === undefined)) return deps.fail(reply, 400, "validation_failed");
    return answer(
      reply,
      await identity.update({
        ...(body.data.relayUrl !== undefined ? { relayUrl: body.data.relayUrl } : {}),
        ...(body.data.authTag !== undefined ? { authTag: body.data.authTag } : {}),
        actor,
      }),
    );
  });

  app.delete(`${BUZZ_IDENTITY_ROUTE}/auth-tag`, async (request, reply) => {
    const actor = await writer(request, reply);
    if (typeof actor !== "string") return actor;
    return answer(reply, identity.revokeTag(actor));
  });
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { BuzzIdentity } from "./buzz-identity.js";

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
 */

export const BUZZ_IDENTITY_ROUTE = "/api/marketplace/channels/buzz/identity";

const KeyBody = z.strictObject({ rotate: z.boolean().optional(), workspaceSlug: z.string().optional() });
const UpdateBody = z.strictObject({
  relayUrl: z.string().min(1).max(300).optional(),
  authTag: z.union([z.string().min(1).max(4096), z.array(z.string().max(1024)).max(8)]).optional(),
  workspaceSlug: z.string().optional(),
});

export type BuzzIdentityRouteDeps = {
  app: FastifyInstance;
  identity: BuzzIdentity;
  /** The channel owner gate (operator, organization), allowing inert mode. */
  owner: (request: FastifyRequest, reply: FastifyReply) => Promise<{ id: string } | null>;
  ownerDenied: (request: FastifyRequest) => unknown;
  fail: (reply: FastifyReply, status: number, error: string, extra?: Record<string, unknown>) => Record<string, unknown>;
  /** Re-verify the provider, restart the relay socket and swap the bridge sink after a change. */
  onChanged: () => Promise<void>;
  /** False in inert mode: a first identity takes effect after the next start. */
  configured: boolean;
};

export function registerBuzzIdentityRoutes(deps: BuzzIdentityRouteDeps): void {
  const { app, identity } = deps;
  const answer = async (reply: FastifyReply, result: ReturnType<BuzzIdentity["update"]>) => {
    if (!result.ok) return deps.fail(reply, result.status, result.error, result.detail ? { detail: result.detail } : {});
    if (result.changed) await deps.onChanged();
    return { ok: true, schema: 1, changed: result.changed, buzz: identity.view(), ...(deps.configured ? {} : { appliesAfterRestart: true }) };
  };

  app.get(BUZZ_IDENTITY_ROUTE, async (request, reply) => {
    const principal = await deps.owner(request, reply);
    if (!principal) return deps.ownerDenied(request);
    return { ok: true, schema: 1, buzz: identity.view(), ...(deps.configured ? {} : { appliesAfterRestart: true }) };
  });

  app.post(`${BUZZ_IDENTITY_ROUTE}/key`, { bodyLimit: 1024 }, async (request, reply) => {
    const principal = await deps.owner(request, reply);
    if (!principal) return deps.ownerDenied(request);
    const body = KeyBody.safeParse(request.body ?? {});
    if (!body.success) return deps.fail(reply, 400, "validation_failed");
    return answer(reply, identity.generateKey({ rotate: body.data.rotate === true, actor: principal.id }));
  });

  app.put(BUZZ_IDENTITY_ROUTE, { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const principal = await deps.owner(request, reply);
    if (!principal) return deps.ownerDenied(request);
    const body = UpdateBody.safeParse(request.body ?? {});
    // The body may hold a mistaken secret; validation errors never echo it.
    if (!body.success || (body.data.relayUrl === undefined && body.data.authTag === undefined)) return deps.fail(reply, 400, "validation_failed");
    return answer(
      reply,
      identity.update({
        ...(body.data.relayUrl !== undefined ? { relayUrl: body.data.relayUrl } : {}),
        ...(body.data.authTag !== undefined ? { authTag: body.data.authTag } : {}),
        actor: principal.id,
      }),
    );
  });

  app.delete(`${BUZZ_IDENTITY_ROUTE}/auth-tag`, async (request, reply) => {
    const principal = await deps.owner(request, reply);
    if (!principal) return deps.ownerDenied(request);
    return answer(reply, identity.revokeTag(principal.id));
  });
}

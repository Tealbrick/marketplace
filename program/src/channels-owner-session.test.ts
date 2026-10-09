import { afterEach, describe, expect, it } from "vitest";

import { channelFixture, type ChannelFixture, TENANT } from "./channels/app-fixture.js";

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

// A real operator session binds `workspaceSlug` and `actorId` into every
// mutation body (bindMarketplacePrincipalScope). The owner channel routes
// must accept that bound body, as the owner UI sends it through a session.
describe("channels: owner routes under an operator session body binding", () => {
  it("accepts the bound workspaceSlug and actorId on every strict owner body", async () => {
    const f = await channelFixture();
    fixtures.push(f);
    const bound = { workspaceSlug: TENANT, actorId: "operator-1" };
    const discovered = await f.owner("GET", "/api/marketplace/channels/discover?provider=telegram");
    const destination = discovered.json().destinations[0];
    const created = await f.owner(
      "POST",
      "/api/marketplace/channels",
      { provider: "telegram", slug: "bound-body", label: "Bound body", destination: { externalId: destination.externalId }, policy: { standingGrants: "allowed" }, ...bound },
      { "idempotency-key": "owner-create-bound-0001" },
    );
    expect(created.statusCode, created.body).toBe(201);
    const channelId = created.json().channel.id as string;
    const patched = await f.owner("PATCH", `/api/marketplace/channels/${channelId}`, { purpose: "Updates", ...bound });
    expect(patched.statusCode, patched.body).toBe(200);
    const purged = await f.owner("POST", "/api/marketplace/channels/receipts/purge", { olderThanDays: 90, ...bound });
    expect(purged.statusCode, purged.body).toBe(200);
    const resolved = await f.owner("POST", "/api/marketplace/channels/posts/unknown-post/resolve", { status: "sent", ...bound });
    expect(resolved.statusCode, resolved.body).toBe(404);
    const approved = await f.owner("POST", "/api/marketplace/channels/grants/unknown-grant/approve", { ...bound });
    expect(approved.statusCode, approved.body).toBe(404);
  });
});

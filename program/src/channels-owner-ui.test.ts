import { afterEach, describe, expect, it } from "vitest";

import { TENANT, channelFixture, type ChannelFixture } from "./channels/app-fixture.js";
import { MarketplaceOperatorSessionManager } from "./operator-auth.js";

// Backend items found by the owner-UI build (U1–U4).

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});
async function setup(input: Parameters<typeof channelFixture>[0] = {}) {
  const f = await channelFixture(input);
  fixtures.push(f);
  return f;
}
let n = 0;
const key = (prefix = "ui") => `${prefix}-key-${String(++n).padStart(6, "0")}`;
const ORIGIN = "https://marketplace.fixture.invalid";

describe("U1: owner writes through a real operator session", () => {
  it("unlocks a session and creates, updates, test-sends and pauses a channel with cookie + CSRF", async () => {
    const f = await setup({
      environment: { MARKETPLACE_ALLOWED_ORIGINS: ORIGIN },
      options: {
        allowUnauthenticatedOperator: false,
        operatorSessionManager: new MarketplaceOperatorSessionManager({
          accessToken: "marketplace-operator-token-1234",
          operatorId: "operator-1",
          organizationId: TENANT,
        }),
      },
    });
    const unlocked = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/auth/session",
      headers: { origin: ORIGIN },
      payload: { accessToken: "marketplace-operator-token-1234" },
    });
    expect(unlocked.statusCode, unlocked.body).toBe(200);
    const cookie = String(unlocked.headers["set-cookie"]).split(";", 1)[0]!;
    const csrf = unlocked.json().session.csrfToken as string;
    const session = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
      f.app.inject({
        method,
        url,
        headers: { cookie, ...(method === "GET" ? {} : { origin: ORIGIN, "x-csrf-token": csrf }), ...extra },
        ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      });
    const discovered = await session("GET", "/api/marketplace/channels/discover?provider=telegram");
    expect(discovered.statusCode).toBe(200);
    const created = await session(
      "POST",
      "/api/marketplace/channels",
      { provider: "telegram", slug: "session-made", label: "Session made", destination: { externalId: discovered.json().destinations[0].externalId } },
      { "idempotency-key": key("create") },
    );
    expect(created.statusCode, created.body).toBe(201);
    const channelId = created.json().channel.id as string;
    expect((await session("PATCH", `/api/marketplace/channels/${channelId}`, { purpose: "From a real session" })).statusCode).toBe(200);
    const tested = await session("POST", `/api/marketplace/channels/${channelId}/test`, {}, { "idempotency-key": key("test") });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ receipt: { status: "sent", authority: "owner-test" } });
    expect((await session("POST", `/api/marketplace/channels/${channelId}/pause`, {})).statusCode).toBe(200);
    expect((await session("POST", "/api/marketplace/channels/receipts/purge", { olderThanDays: 90 })).statusCode).toBe(200);
    // Without the CSRF token the same write is refused.
    const noCsrf = await f.app.inject({ method: "POST", url: `/api/marketplace/channels/${channelId}/resume`, headers: { cookie, origin: ORIGIN }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("U2: browse carries each configured provider's declaration", () => {
  it("lists static capabilities and kinds before any channel exists", async () => {
    const f = await setup({ environment: { MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: undefined } });
    const browse = await f.owner("GET", "/api/marketplace/channels");
    expect(browse.json().channels).toEqual([]);
    expect(browse.json().providers).toEqual([
      expect.objectContaining({
        id: "telegram",
        readiness: "available",
        kinds: ["chat"],
        capabilities: expect.objectContaining({ channelCapabilities: 1, text: expect.objectContaining({ maxChars: 4096 }), voice: expect.objectContaining({ native: true }) }),
      }),
      { id: "discord", readiness: "credential_missing" },
    ]);
  });
});

describe("U3: owner list and cancel of scheduled and held posts", () => {
  it("lists scheduled, held and uncertain posts and cancels a scheduled post, failing its approval", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const sendAt = f.now + 3_600_000;
    const heldScheduled = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled`, {
      key: key(),
      payload: { text: "Later, needs approval", sendAt: new Date(sendAt).toISOString() },
    });
    expect(heldScheduled.statusCode).toBe(202);
    const heldNow = await f.post(channel.id, { text: "Now, needs approval" }, key());
    expect(heldNow.statusCode).toBe(202);
    const listed = await f.owner("GET", "/api/marketplace/channels/posts");
    expect(listed.statusCode).toBe(200);
    const posts = listed.json().posts as Array<Record<string, unknown>>;
    expect(posts.map((post) => post.id).sort()).toEqual([heldScheduled.headers["tealbrick-post-id"] as string, heldNow.headers["tealbrick-post-id"] as string].sort());
    expect(posts.find((post) => post.id === heldScheduled.headers["tealbrick-post-id"] as string)).toMatchObject({
      status: "held",
      mode: "scheduled",
      sendAt: new Date(sendAt).toISOString(),
      agentId: "agent-1",
      digestPrefix: heldScheduled.json().digest.slice(0, 12),
      channel: { slug: "community", provider: "telegram" },
      approval: { id: heldScheduled.json().approvalId, state: "pending" },
    });
    expect(listed.body).not.toContain("Later, needs approval");
    const onlyScheduled = await f.owner("GET", "/api/marketplace/channels/posts?status=scheduled");
    expect(onlyScheduled.json().posts).toEqual([]);
    expect((await f.owner("GET", "/api/marketplace/channels/posts?status=bogus")).statusCode).toBe(400);

    await f.owner("POST", `/api/marketplace/company-box/approvals/${heldScheduled.json().approvalId}/approve`, {});
    expect(f.store.getCompanyBoxApproval(heldScheduled.json().approvalId)!.state).toBe("executing");
    const cancelled = await f.owner("POST", `/api/marketplace/channels/posts/${heldScheduled.headers["tealbrick-post-id"] as string}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ receipt: { status: "cancelled" } });
    expect(f.store.getCompanyBoxApproval(heldScheduled.json().approvalId)).toMatchObject({ state: "failed", error: "channel_post_cancelled" });
    expect((await f.owner("POST", `/api/marketplace/channels/posts/${heldScheduled.headers["tealbrick-post-id"] as string}/cancel`, {})).json()).toMatchObject({ replayed: true });
    // A held immediate post can be cancelled by the owner too; its pending approval is denied.
    const cancelledNow = await f.owner("POST", `/api/marketplace/channels/posts/${heldNow.headers["tealbrick-post-id"] as string}/cancel`, {});
    expect(cancelledNow.statusCode).toBe(200);
    expect(f.store.getCompanyBoxApproval(heldNow.json().approvalId)!.state).toBe("denied");
    f.setClock(sendAt + 1_000);
    await f.runtime.tick(new Date(sendAt + 1_000));
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("cancels a grant-scheduled post so the scheduler never sends it", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    const sendAt = f.now + 120_000;
    const scheduled = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled`, {
      key: key(),
      payload: { text: "Reminder", sendAt: new Date(sendAt).toISOString() },
    });
    const postId = scheduled.json().receipt.postId;
    expect((await f.owner("GET", "/api/marketplace/channels/posts?status=scheduled")).json().posts.map((post: { id: string }) => post.id)).toEqual([postId]);
    expect((await f.owner("POST", `/api/marketplace/channels/posts/${postId}/cancel`, {})).statusCode).toBe(200);
    f.setClock(sendAt + 1_000);
    await f.runtime.tick(new Date(sendAt + 1_000));
    expect(f.telegram.sends).toHaveLength(0);
    expect(JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 200 }))).toContain("marketplace.channels.post.cancelled_by_owner");
  });
});

describe("U4: channel kind on create", () => {
  it("stores a declared kind and refuses kinds the provider does not serve", async () => {
    const f = await setup();
    const discovered = await f.owner("GET", "/api/marketplace/channels/discover?provider=telegram");
    const externalId = discovered.json().destinations[0].externalId;
    const create = (kind: unknown, slug: string) =>
      f.owner("POST", "/api/marketplace/channels", { provider: "telegram", slug, label: slug, kind, destination: { externalId } }, { "idempotency-key": key("kind") });
    const chat = await create("chat", "kind-chat");
    expect(chat.statusCode).toBe(201);
    expect(chat.json().channel.kind).toBe("chat");
    const newsletter = await create("newsletter", "kind-newsletter");
    expect(newsletter.statusCode).toBe(422);
    expect(newsletter.json()).toMatchObject({ error: "channel_kind_unsupported", supported: ["chat"] });
    const bogus = await create("fax", "kind-fax");
    expect(bogus.statusCode).toBe(400);
  });
});

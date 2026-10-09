import { afterEach, describe, expect, it } from "vitest";

import { TENANT, channelFixture, type ChannelFixture } from "./channels/app-fixture.js";

// Upgrade rehearsal defect: an owner approved a channel hold in the 0.1.19 approval queue during a
// rollback. 0.1.19 cannot run it, so it marks the approval `failed` (approval_target_unavailable) and
// sends nothing. After the upgrade back the hold must end, never send, and stay cancellable.

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});
let n = 0;
const key = () => `rollback-key-${String(++n).padStart(6, "0")}`;

async function heldWithFailedApproval(mode: "immediate" | "scheduled" = "immediate") {
  const f = await channelFixture();
  fixtures.push(f);
  const channel = await f.createChannel({ slug: "rollback" });
  f.consentFor("agent-1", channel);
  const idempotencyKey = key();
  const held =
    mode === "immediate"
      ? await f.post(channel.id, { text: "Approved in 0.1.19" }, idempotencyKey)
      : await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled`, {
          key: idempotencyKey,
          payload: { text: "Approved in 0.1.19", sendAt: new Date(f.now + 3_600_000).toISOString() },
        });
  expect(held.statusCode).toBe(202);
  // What 0.1.19 leaves behind: approve (pending -> executing), then failed with approval_target_unavailable.
  const approvalId = held.json().approvalId as string;
  f.store.decideCompanyBoxApproval({ id: approvalId, workspaceSlug: TENANT, decision: "approve", decidedBy: "operator-1" });
  f.store.finishCompanyBoxApproval({ id: approvalId, state: "failed", error: "approval_target_unavailable" });
  return { f, channel, held: { postId: held.headers["tealbrick-post-id"] as string, approvalId }, idempotencyKey };
}

describe("channel holds whose approval failed in 0.1.19 (rollback)", () => {
  it("one tick ends the held immediate post as skipped (approval_failed) with a receipt, and sends nothing", async () => {
    const { f, held } = await heldWithFailedApproval();
    const report = await f.runtime.tick(new Date(f.now));
    expect(report.skipped).toBe(1);
    expect(f.store.channels.getPost(TENANT, held.postId)).toMatchObject({ status: "skipped", reason: "approval_failed" });
    expect(f.store.channels.getReceiptByPost(TENANT, held.postId)).toMatchObject({ status: "skipped" });
    await f.runtime.tick(new Date(f.now + 60_000));
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("ends a held scheduled post before its send time too", async () => {
    const { f, held } = await heldWithFailedApproval("scheduled");
    await f.runtime.tick(new Date(f.now));
    expect(f.store.channels.getPost(TENANT, held.postId)).toMatchObject({ status: "skipped", reason: "approval_failed" });
    f.setClock(f.now + 3_600_000 + 1_000);
    await f.runtime.tick(new Date(f.now));
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("the agent's retry with the same key ends it instead of answering channel_post_held", async () => {
    const { f, channel, held, idempotencyKey } = await heldWithFailedApproval();
    const retry = await f.post(channel.id, { text: "Approved in 0.1.19" }, idempotencyKey);
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: "approval_failed" });
    expect(f.store.channels.getPost(TENANT, held.postId)!.status).toBe("skipped");
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("the owner can cancel a held immediate post (failed approval left as is)", async () => {
    const { f, held } = await heldWithFailedApproval();
    const cancelled = await f.owner("POST", `/api/marketplace/channels/posts/${held.postId}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ receipt: { status: "cancelled" } });
    expect(f.store.getCompanyBoxApproval(held.approvalId)).toMatchObject({ state: "failed", error: "approval_target_unavailable" });
    expect((await f.owner("POST", `/api/marketplace/channels/posts/${held.postId}/cancel`, {})).json()).toMatchObject({ replayed: true });
  });
});

describe("owner cancel of held posts", () => {
  it("cancels a held immediate post with an approved (executing) approval atomically and fails the approval", async () => {
    let eventStatus = 200;
    const f = await channelFixture({ options: { channelEventFetch: (async () => new Response("", { status: eventStatus })) as typeof fetch } });
    fixtures.push(f);
    const channel = await f.createChannel({
      slug: "events",
      policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: false }, content: { requireConfirmedEvent: true, listingHosts: ["lu.ma"] } },
    });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } }, key());
    eventStatus = 503; // transient: the approved hold stays held with its approval executing
    await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)!.state).toBe("executing");
    const cancelled = await f.owner("POST", `/api/marketplace/channels/posts/${held.headers["tealbrick-post-id"] as string}/cancel`, {});
    expect(cancelled.statusCode).toBe(200);
    expect(f.store.channels.getPost(TENANT, held.headers["tealbrick-post-id"] as string)).toMatchObject({ status: "cancelled", reason: "cancelled_by_owner" });
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)).toMatchObject({ state: "failed", error: "channel_post_cancelled" });
    eventStatus = 200;
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("refuses to cancel once a send took the post", async () => {
    const f = await channelFixture();
    fixtures.push(f);
    const channel = await f.createChannel({ slug: "sent" });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, { text: "Approve me" }, key());
    await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(f.store.channels.getPost(TENANT, held.headers["tealbrick-post-id"] as string)!.status).toBe("sent");
    const late = await f.owner("POST", `/api/marketplace/channels/posts/${held.headers["tealbrick-post-id"] as string}/cancel`, {});
    expect(late.statusCode).toBe(404);
    expect(f.store.channels.cancelHeldPost({ workspaceSlug: TENANT, postId: held.headers["tealbrick-post-id"] as string, reason: "x", decidedBy: "owner", now: new Date() })).toBeNull();
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)!.state).toBe("succeeded");
  });
});

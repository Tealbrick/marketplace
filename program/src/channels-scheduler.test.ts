import { afterEach, describe, expect, it } from "vitest";

import { GRANT_A, SERVICE, TENANT, channelFixture, type ChannelFixture } from "./channels/app-fixture.js";
import { CHANNEL_SCHEDULER_LEASE_MS } from "./channels/service.js";

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

let counter = 0;
const key = () => `sched-key-${String(++counter).padStart(6, "0")}`;

async function scheduledSetup(input: { grant?: boolean } = {}) {
  const f = await channelFixture();
  fixtures.push(f);
  const channel = await f.createChannel({ slug: "community" });
  const consent = f.consentFor("agent-1", channel);
  const grant = input.grant === false ? null : await f.proposeAndApprove(channel.id);
  const schedule = (text: string, sendAt: number, idempotencyKey = key()) =>
    f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled`, {
      key: idempotencyKey,
      payload: { text, sendAt: new Date(sendAt).toISOString() },
    });
  const tickAt = async (ms: number, claimer?: string) => {
    f.setClock(ms);
    return f.runtime.tick(new Date(ms), claimer);
  };
  return { f, channel, consent, grant, schedule, tickAt };
}

describe("channels scheduler (1g)", () => {
  it("validates sendAt between now + 60 s and now + 30 days", async () => {
    const { f, schedule } = await scheduledSetup();
    expect((await schedule("Too soon", f.now + 30_000)).json()).toMatchObject({ error: "channel_send_at_invalid" });
    expect((await schedule("Too late", f.now + 31 * 86_400_000)).statusCode).toBe(422);
  });

  it("sends a due post under a grant exactly once (§10 item 5)", async () => {
    const { f, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const scheduled = await schedule("Reminder", sendAt);
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(scheduled.json()).toMatchObject({ receipt: { status: "pending", postId: expect.any(String) } });
    const postId = scheduled.json().receipt.postId;
    expect((await tickAt(sendAt - 1_000)).claimed).toBe(0);
    expect(f.telegram.sends).toHaveLength(0);
    const report = await tickAt(sendAt + 1_000);
    expect(report).toMatchObject({ claimed: 1, sent: 1 });
    expect(f.telegram.sends).toHaveLength(1);
    expect((await tickAt(sendAt + 31_000)).claimed).toBe(0);
    expect(f.telegram.sends).toHaveLength(1);
    const receipts = await f.agent("GET", "/api/marketplace/v1/agent/channels/receipts");
    expect(receipts.json().receipts).toEqual([expect.objectContaining({ postId, status: "sent" })]);
    // The schedule key replays the post, never schedules or sends again.
    expect(f.store.channels.getPost(TENANT, postId)!.status).toBe("sent");
  });

  it("skips a post whose grant was revoked before sendAt (§10 item 5)", async () => {
    const { f, grant, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const postId = (await schedule("Revoked", sendAt)).json().receipt.postId;
    await f.owner("POST", `/api/marketplace/channels/grants/${grant!.id}/revoke`, {});
    const report = await tickAt(sendAt + 1_000);
    expect(report).toMatchObject({ skipped: 1, sent: 0 });
    expect(f.store.channels.getPost(TENANT, postId)).toMatchObject({ status: "skipped", reason: "channel_grant_invalid" });
    expect(f.store.channels.getReceiptByPost(TENANT, postId)).toMatchObject({ status: "skipped" });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("rechecks content at send time and skips with the reason", async () => {
    const { f, channel, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const postId = (await schedule("Mentions acme corp", sendAt)).json().receipt.postId;
    await f.owner("PATCH", `/api/marketplace/channels/${channel.id}`, {
      policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, content: { denyPatterns: ["acme"] } },
    });
    await tickAt(sendAt + 1_000);
    expect(f.store.channels.getPost(TENANT, postId)).toMatchObject({ status: "skipped", reason: "channel_content_denied" });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("takes over a claim only after its lease expired", async () => {
    const { f, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const postId = (await schedule("Takeover", sendAt)).json().receipt.postId;
    // Another replica claimed it and died before sending.
    const claimed = f.store.channels.claimDuePosts({ now: new Date(sendAt + 1_000), claimer: "dead-replica", leaseMs: CHANNEL_SCHEDULER_LEASE_MS });
    expect(claimed.map((post) => post.id)).toEqual([postId]);
    expect((await tickAt(sendAt + 60_000)).claimed).toBe(0);
    expect(f.telegram.sends).toHaveLength(0);
    const report = await tickAt(sendAt + 1_000 + CHANNEL_SCHEDULER_LEASE_MS + 1_000);
    expect(report).toMatchObject({ claimed: 1, sent: 1 });
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("marks a crash in sending uncertain on the next tick and never sends it again", async () => {
    const { f, grant, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const postId = (await schedule("Crash", sendAt)).json().receipt.postId;
    const claimer = "crashing-replica";
    f.store.channels.claimDuePosts({ now: new Date(sendAt), claimer, leaseMs: CHANNEL_SCHEDULER_LEASE_MS });
    const reserved = f.store.channels.reserveScheduledPost({
      workspaceSlug: TENANT,
      postId,
      claimer,
      grant: { id: grant!.id, caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
      ceiling: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true },
      now: new Date(sendAt),
      leaseMs: CHANNEL_SCHEDULER_LEASE_MS,
    });
    expect(reserved.ok).toBe(true);
    // The process dies here, after the row entered `sending`.
    const report = await tickAt(sendAt + CHANNEL_SCHEDULER_LEASE_MS + 1_000);
    expect(report.recovered).toBe(1);
    expect(f.store.channels.getPost(TENANT, postId)).toMatchObject({ status: "uncertain", reason: "send_lease_expired" });
    expect(f.store.channels.getReceiptByPost(TENANT, postId)).toMatchObject({ status: "uncertain" });
    await tickAt(sendAt + 2 * CHANNEL_SCHEDULER_LEASE_MS + 5_000);
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("sends once when two ticks run at the same time", async () => {
    const { f, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    await schedule("Concurrent", sendAt);
    f.setClock(sendAt + 1_000);
    const [left, right] = await Promise.all([tickAt(sendAt + 1_000, "replica-a"), tickAt(sendAt + 1_000, "replica-b")]);
    expect(left.claimed + right.claimed).toBe(1);
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("expires a post more than 15 minutes late", async () => {
    const { f, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const postId = (await schedule("Late", sendAt)).json().receipt.postId;
    await tickAt(sendAt + 16 * 60_000);
    expect(f.store.channels.getPost(TENANT, postId)).toMatchObject({ status: "expired" });
    expect(f.store.channels.getReceiptByPost(TENANT, postId)).toMatchObject({ status: "expired" });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("cancels an own scheduled post (no approval needed) and never sends it", async () => {
    const { f, channel, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const postId = (await schedule("Cancel me", sendAt)).json().receipt.postId;
    const other = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled/${postId}/cancel`, {
      token: `tbag_${"b".repeat(43)}`,
    });
    expect(other.statusCode).toBe(404);
    const cancelled = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled/${postId}/cancel`, {});
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ receipt: { status: "cancelled" } });
    await tickAt(sendAt + 1_000);
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("holds a scheduled post without a grant; the owner's approval sends it at sendAt, once", async () => {
    const { f, schedule, tickAt } = await scheduledSetup({ grant: false });
    const sendAt = f.now + 120_000;
    const held = await schedule("Needs approval later", sendAt);
    expect(held.statusCode).toBe(202);
    const approvalId = held.json().approvalId;
    // Per-payload approval of a scheduled post expires at sendAt.
    expect(Date.parse(held.json().expiresAt)).toBeLessThanOrEqual(sendAt + 1_000);
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ ok: true, channel: { scheduled: true } });
    expect(f.telegram.sends).toHaveLength(0);
    await tickAt(sendAt + 1_000);
    expect(f.telegram.sends).toHaveLength(1);
    expect(f.store.channels.getPost(TENANT, held.headers["tealbrick-post-id"] as string)).toMatchObject({ status: "sent", authority: `approval:${approvalId}` });
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("succeeded");
    await tickAt(sendAt + 31_000);
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("expires a held scheduled post the owner never approved", async () => {
    const { f, schedule, tickAt } = await scheduledSetup({ grant: false });
    const sendAt = f.now + 120_000;
    const held = await schedule("Never approved", sendAt);
    await tickAt(sendAt + 1_000);
    expect(f.store.channels.getPost(TENANT, held.headers["tealbrick-post-id"] as string)).toMatchObject({ status: "expired" });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("skips a scheduled post when the consent was revoked before sendAt", async () => {
    const { f, consent, schedule, tickAt } = await scheduledSetup();
    const sendAt = f.now + 120_000;
    const postId = (await schedule("Consent gone", sendAt)).json().receipt.postId;
    await f.app.inject({ method: "POST", url: `/api/marketplace/agent/grants/${consent.id}/revoke`, headers: { authorization: `Bearer ${SERVICE}` }, payload: {} });
    await tickAt(sendAt + 1_000);
    expect(f.store.channels.getPost(TENANT, postId)).toMatchObject({ status: "skipped" });
    expect(f.telegram.sends).toHaveLength(0);
    void GRANT_A;
  });
});

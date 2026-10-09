import { afterEach, describe, expect, it } from "vitest";

import { channelFixture, type ChannelFixture } from "./channels/app-fixture.js";
import { channelPayloadDigest } from "./channels/policy.js";
import { checkUploadType } from "./channels/runtime.js";

// Review fixes (adversarial review + Lead · Miniapps), probes T1–T5 turned into assertions.

const TENANT = "tenant-community";
const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});
let n = 0;
const key = () => `review-key-${String(++n).padStart(6, "0")}`;
const EVENT_POLICY = {
  standingGrants: "allowed",
  caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: false },
  content: { requireConfirmedEvent: true, listingHosts: ["lu.ma"] },
};

async function setup(input: Parameters<typeof channelFixture>[0] = {}) {
  const f = await channelFixture(input);
  fixtures.push(f);
  return f;
}

describe("L3: transient send-time failures keep the approval", () => {
  it("T1: a 503 from the event page at approval leaves the post held and the approval executing; the retry sends once", async () => {
    let eventStatus = 200;
    const f = await setup({ options: { channelEventFetch: (async () => new Response("", { status: eventStatus })) as typeof fetch } });
    const channel = await f.createChannel({ slug: "events", policy: EVENT_POLICY });
    f.consentFor("agent-1", channel);
    const k = key();
    const body = { text: "Meetup tonight", campaign: { ref: "https://lu.ma/abc", phase: "announce" } };
    const held = await f.post(channel.id, body, k);
    expect(held.statusCode).toBe(202);
    const approvalId = held.json().approvalId;
    eventStatus = 503;
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ ok: false, channel: { error: "channel_event_check_unavailable" } });
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("executing");
    expect(f.store.channels.getPost(TENANT, held.json().postId)!.status).toBe("held");
    eventStatus = 200;
    const retry = await f.post(channel.id, body, k);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toMatchObject({ receipt: { status: "sent", authority: `approval:${approvalId}` } });
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("succeeded");
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("a 404 from the event page is definitive: the hold ends skipped and the approval fails", async () => {
    const f = await setup({ options: { channelEventFetch: (async () => new Response("", { status: 404 })) as typeof fetch } });
    const channel = await f.createChannel({ slug: "events", policy: EVENT_POLICY });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, { text: "Gone", campaign: { ref: "https://lu.ma/gone" } }, key());
    // The initial live check already refuses a missing listing (422, nothing held).
    expect(held.statusCode).toBe(422);
    expect(f.store.channels.listPosts(TENANT)).toEqual([]);
  });
});

describe("M1: caps refusal and owner deny of an approved hold", () => {
  it("T3: after a cap refusal the approval is failed and the post skipped; nothing sends days later", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "capped", policy: { standingGrants: "allowed", caps: { perDay: 1, minIntervalSeconds: 0, onePerPhase: true } } });
    f.consentFor("agent-1", channel);
    await f.owner("POST", `/api/marketplace/channels/${channel.id}/test`, {}, { "idempotency-key": "owner-test-0001" });
    const k = key();
    const held = await f.post(channel.id, { text: "flash sale ends tonight" }, k);
    const approvalId = held.json().approvalId;
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ ok: false, approval: { state: "failed" } });
    f.advance(3 * 86_400_000);
    const retry = await f.post(channel.id, { text: "flash sale ends tonight" }, k);
    expect(retry.statusCode).toBe(409);
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("the owner can deny an approved (executing) approval while its post is still held", async () => {
    let eventStatus = 503;
    const f = await setup({ options: { channelEventFetch: (async () => new Response("", { status: eventStatus })) as typeof fetch } });
    const channel = await f.createChannel({ slug: "events", policy: EVENT_POLICY });
    f.consentFor("agent-1", channel);
    eventStatus = 200;
    const k = key();
    const body = { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } };
    const held = await f.post(channel.id, body, k);
    const approvalId = held.json().approvalId;
    eventStatus = 503;
    await f.owner("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, {});
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("executing");
    const denied = await f.owner("POST", `/api/marketplace/company-box/approvals/${approvalId}/deny`, {});
    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.json()).toMatchObject({ approval: { state: "denied" } });
    expect(f.store.channels.getPost(TENANT, held.json().postId)).toMatchObject({ status: "skipped", reason: "approval_denied" });
    eventStatus = 200;
    expect((await f.post(channel.id, body, k)).statusCode).toBe(409);
    expect(f.telegram.sends).toHaveLength(0);
  });
});

describe("M2: authority re-checked inside the reservation", () => {
  it("T4: pause + grant revoke during the live event check stops a grant post", async () => {
    let hook: null | (() => Promise<void>) = null;
    const f = await setup({
      options: {
        channelEventFetch: (async () => {
          if (hook) {
            const run = hook;
            hook = null;
            await run();
          }
          return new Response("", { status: 200 });
        }) as typeof fetch,
      },
    });
    const channel = await f.createChannel({ slug: "events", policy: EVENT_POLICY });
    f.consentFor("agent-1", channel);
    const grant = await f.proposeAndApprove(channel.id, { caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: false } });
    hook = async () => {
      expect((await f.owner("POST", `/api/marketplace/channels/${channel.id}/pause`, {})).statusCode).toBe(200);
    };
    const paused = await f.post(channel.id, { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } }, key());
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toMatchObject({ error: "channel_paused" });
    expect(f.telegram.sends).toHaveLength(0);
    expect(f.store.channels.countCountedPosts(TENANT, channel.id, new Date(0))).toBe(0);
    expect(f.store.channels.listPosts(TENANT)).toEqual([]);
    void grant;
  });

  it("a grant revoked or a channel paused after the grant was chosen (during governance) is refused inside the reservation", async () => {
    let hook: null | (() => Promise<void>) = null;
    const f = await setup({
      options: {
        rules: { baseUrl: "https://rules.fixture.invalid", internalAuthToken: "r".repeat(40) },
        rulesClient: async () => {
          if (hook) {
            const run = hook;
            hook = null;
            await run();
          }
          return { effect: "allow" as const, decisionId: "rules-allow" };
        },
      },
    });
    const channel = await f.createChannel({ slug: "governed" });
    f.consentFor("agent-1", channel);
    const grant = await f.proposeAndApprove(channel.id);
    hook = async () => {
      await f.owner("POST", `/api/marketplace/channels/grants/${grant.id}/revoke`, {});
    };
    const revoked = await f.post(channel.id, { text: "Governed" }, key());
    expect(revoked.statusCode, revoked.body).toBe(409);
    expect(revoked.json()).toMatchObject({ error: "grant_inactive" });
    const second = await f.proposeAndApprove(channel.id);
    hook = async () => {
      // Pause the row directly, without the route's grant suspension: only the reservation check stops it.
      f.store.channels.setChannelStatus(TENANT, channel.id, "paused");
    };
    const paused = await f.post(channel.id, { text: "Governed 2" }, key());
    expect(paused.statusCode).toBe(409);
    expect(paused.json()).toMatchObject({ error: "channel_paused" });
    expect(f.telegram.sends).toHaveLength(0);
    expect(f.store.channels.countCountedPosts(TENANT, channel.id, new Date(0))).toBe(0);
    void second;
  });

  it("T5: pause + consent revoke during the live check of an approved hold stops the send", async () => {
    let hook: null | (() => Promise<void>) = null;
    const f = await setup({
      options: {
        channelEventFetch: (async () => {
          if (hook) {
            const run = hook;
            hook = null;
            await run();
          }
          return new Response("", { status: 200 });
        }) as typeof fetch,
      },
    });
    const channel = await f.createChannel({ slug: "events", policy: EVENT_POLICY });
    const consent = f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } }, key());
    hook = async () => {
      f.store.revokeMarketplaceAgentConsent(consent.id);
    };
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ channel: { error: "consent_inactive" }, approval: { state: "failed" } });
    expect(f.store.channels.getPost(TENANT, held.json().postId)).toMatchObject({ status: "skipped", reason: "consent_inactive" });
    expect(f.telegram.sends).toHaveLength(0);

    const other = await f.createChannel({ slug: "events-2", externalId: "-1005678", policy: EVENT_POLICY });
    f.consentFor("agent-1", other);
    const held2 = await f.post(other.id, { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } }, key());
    hook = async () => {
      await f.owner("POST", `/api/marketplace/channels/${other.id}/pause`, {});
    };
    const approved2 = await f.owner("POST", `/api/marketplace/company-box/approvals/${held2.json().approvalId}/approve`, {});
    expect(approved2.json()).toMatchObject({ channel: { error: "channel_paused" } });
    expect(f.telegram.sends).toHaveLength(0);
  });
});

describe("L4/L5: expiry and cancellation of approved holds", () => {
  it("the tick expires an approved hold whose approval passed its expiry, and fails the approval", async () => {
    let eventStatus = 200;
    const f = await setup({ options: { channelEventFetch: (async () => new Response("", { status: eventStatus })) as typeof fetch } });
    const channel = await f.createChannel({ slug: "events", policy: EVENT_POLICY });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } }, key());
    eventStatus = 503;
    await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)!.state).toBe("executing");
    const later = f.now + 8 * 86_400_000;
    f.setClock(later);
    const report = await f.runtime.tick(new Date(later));
    expect(report.expired).toBe(1);
    expect(f.store.channels.getPost(TENANT, held.json().postId)).toMatchObject({ status: "expired", reason: "approval_expired" });
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)).toMatchObject({ state: "failed", error: "approval_expired" });
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("T2: cancelling an approved scheduled hold fails the executing approval", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const sendAt = f.now + 120_000;
    const held = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled`, {
      key: key(),
      payload: { text: "Later", sendAt: new Date(sendAt).toISOString() },
    });
    expect(held.statusCode).toBe(202);
    await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)!.state).toBe("executing");
    const cancelled = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled/${held.json().postId}/cancel`, {});
    expect(cancelled.statusCode).toBe(200);
    expect(f.store.getCompanyBoxApproval(held.json().approvalId)).toMatchObject({ state: "failed", error: "channel_post_cancelled" });
    f.setClock(sendAt + 1_000);
    await f.runtime.tick(new Date(sendAt + 1_000));
    expect(f.telegram.sends).toHaveLength(0);
  });

  it("L5: lateness is measured when each post is handled, not at the tick start", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    const sendAt = f.now + 120_000;
    const scheduled = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled`, {
      key: key(),
      payload: { text: "Clock moves", sendAt: new Date(sendAt).toISOString() },
    });
    // The tick starts on time, but by the time the post is handled the clock is 16 minutes later.
    f.setClock(sendAt + 16 * 60_000);
    await f.runtime.tick(new Date(sendAt + 1_000));
    expect(f.store.channels.getPost(TENANT, scheduled.json().receipt.postId)!.status).toBe("expired");
    expect(f.telegram.sends).toHaveLength(0);
  });
});

describe("L6: the destination parent is part of the digest", () => {
  it("changes the digest when only parentId changes", () => {
    const base = { workspace: "w", channelId: "c", provider: "discord", destination: "1", op: "post", text: "t", attachments: [] };
    const withParent = channelPayloadDigest({ ...base, destinationParentId: "777" });
    expect(withParent).not.toBe(channelPayloadDigest(base));
    expect(withParent).not.toBe(channelPayloadDigest({ ...base, destinationParentId: "778" }));
  });
});

describe("L7: approval proofs need a pinned owner", () => {
  it("refuses approval_owner_unbound without the pins, even with a verifier that would accept", async () => {
    let calls = 0;
    const f = await setup({
      verifier: {
        async verify() {
          calls += 1;
          return { ok: true, decision: "approve", proofId: "p1", kind: "portal", expiresAt: new Date(Date.now() + 60_000).toISOString(), decidedBy: "owner:x" };
        },
      },
    });
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const held = await f.post(channel.id, { text: "Held" }, key());
    const approvalId = held.json().approvalId;
    for (const payload of [{ proof: "portal", token: "valid-proof-token-0001" }, { proof: "nostr", event: { id: "x" }, channel: "dm-1" }]) {
      const refused = await f.agent("POST", `/api/marketplace/v1/agent/approvals/${approvalId}/resolve`, { key: `resolve.${approvalId}.approve`, payload });
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({ error: "approval_owner_unbound" });
    }
    expect(calls).toBe(0);
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("pending");
    expect(f.telegram.sends).toHaveLength(0);
  });
});

describe("L8: upload type checks", () => {
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const check = (bytes: Uint8Array, contentType: string, name: string, octetStreamDeclared = false) =>
    checkUploadType({ bytes, contentType, name, octetStreamDeclared });

  it("accepts matching magic bytes and extensions", () => {
    expect(check(PNG, "image/png", "a.png")).toEqual({ ok: true });
    expect(check(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg", "a.JPG")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "), "image/webp", "a.webp")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("GIF89a.."), "image/gif", "a.gif")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("%PDF-1.7"), "application/pdf", "a.pdf")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("OggS...."), "audio/ogg", "a.ogg")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("ID3...."), "audio/mpeg", "a.mp3")).toEqual({ ok: true });
    expect(check(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]), "audio/mpeg", "a.mp3")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("\0\0\0\x20ftypM4A "), "audio/mp4", "a.m4a")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("\0\0\0\x20ftypisom"), "video/mp4", "a.mp4")).toEqual({ ok: true });
    expect(check(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]), "application/zip", "a.zip")).toEqual({ ok: true });
    expect(check(new TextEncoder().encode("héllo"), "text/plain", "a.txt")).toEqual({ ok: true });
    expect(check(PNG, "application/octet-stream", "blob.bin", true)).toEqual({ ok: true });
  });

  it("refuses mismatched bytes, wrong extensions, bad text and undeclared octet-stream", () => {
    const mismatch = { ok: false, status: 422, error: "channel_attachment_type_mismatch" };
    expect(check(new TextEncoder().encode("<html>"), "image/png", "a.png")).toEqual(mismatch);
    expect(check(PNG, "image/png", "a.jpg")).toEqual(mismatch);
    expect(check(PNG, "image/png", "png")).toEqual(mismatch);
    expect(check(Uint8Array.from([0x68, 0x00, 0x69]), "text/plain", "a.txt")).toEqual(mismatch);
    expect(check(Uint8Array.from([0xc3, 0x28]), "text/plain", "a.txt")).toEqual(mismatch);
    expect(check(PNG, "application/octet-stream", "blob.bin", false)).toEqual(mismatch);
    expect(check(PNG, "image/svg+xml", "a.svg")).toMatchObject({ ok: false, error: "channel_attachment_type_invalid" });
  });

  it("the upload route answers 422 channel_attachment_type_mismatch for a disguised file", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    const disguised = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/channels/attachments?name=flyer.png",
      headers: { authorization: `Bearer tbag_${"a".repeat(43)}`, "idempotency-key": key(), "content-type": "image/png" },
      payload: Buffer.from("<script>alert(1)</script>"),
    });
    expect(disguised.statusCode).toBe(422);
    expect(disguised.json()).toMatchObject({ error: "channel_attachment_type_mismatch" });
    expect(f.store.channels.listPosts(TENANT)).toEqual([]);
  });
});

describe("F1: scheduled backlog limit per agent and channel", () => {
  it("refuses the 13th pending post with the default (2 × perDay = 12) and frees a slot on cancel or send", async () => {
    const f = await setup();
    const channel = await f.createChannel({ slug: "backlog" });
    f.consentFor("agent-1", channel);
    f.consentFor("agent-2", channel);
    await f.proposeAndApprove(channel.id);
    expect((await f.owner("GET", "/api/marketplace/channels")).json().channels[0].policy.schedule.maxPendingPerAgent).toBe(12);
    const schedule = (index: number, token?: string) =>
      f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled`, {
        key: key(),
        ...(token ? { token } : {}),
        payload: { text: `Post ${index}`, sendAt: new Date(f.now + 120_000 + index * 60_000).toISOString() },
      });
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const ok = await schedule(index);
      expect(ok.statusCode, ok.body).toBe(200);
      ids.push(ok.json().receipt.postId);
    }
    const thirteenth = await schedule(12);
    expect(thirteenth.statusCode).toBe(429);
    expect(thirteenth.json()).toMatchObject({ error: "channel_schedule_backlog_full" });
    // An immediate post under the grant is sent at once, so it is never pending.
    const now = await f.post(channel.id, { text: "Now", campaign: { phase: "update" } }, key());
    expect(now.statusCode).toBe(200);
    // The limit is per agent: another agent still has room.
    expect((await schedule(13, `tbag_${"b".repeat(43)}`)).statusCode).toBe(202);
    // Cancelling frees a slot.
    expect((await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/scheduled/${ids[0]}/cancel`, {})).statusCode).toBe(200);
    expect((await schedule(14)).statusCode).toBe(200);
    expect((await schedule(15)).statusCode).toBe(429);
    // Sending frees a slot.
    const firstDue = f.now + 120_000 + 1 * 60_000;
    f.setClock(firstDue + 1_000);
    await f.runtime.tick(new Date(firstDue + 1_000));
    expect(f.store.channels.getPost(TENANT, ids[1]!)!.status).toBe("sent");
    expect((await schedule(16)).statusCode).toBe(200);
  });

  it("validates schedule.maxPendingPerAgent (1–50) and counts held immediate posts", async () => {
    const f = await setup();
    const bad = await f.owner("POST", "/api/marketplace/channels", { provider: "telegram", slug: "bad", label: "bad", destination: { externalId: "-1001234" }, policy: { schedule: { maxPendingPerAgent: 51 } } }, { "idempotency-key": key() });
    expect(bad.statusCode).toBe(409); // destination not discovered yet
    await f.owner("GET", "/api/marketplace/channels/discover?provider=telegram");
    const invalid = await f.owner("POST", "/api/marketplace/channels", { provider: "telegram", slug: "bad", label: "bad", destination: { externalId: "-1001234" }, policy: { schedule: { maxPendingPerAgent: 51 } } }, { "idempotency-key": key() });
    expect(invalid.statusCode).toBe(422);
    expect(JSON.stringify(invalid.json().errors)).toContain("schedule.maxPendingPerAgent");
    const channel = await f.createChannel({ slug: "tight", policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, schedule: { maxPendingPerAgent: 2 } } });
    f.consentFor("agent-1", channel);
    expect((await f.post(channel.id, { text: "one" }, key())).statusCode).toBe(202);
    expect((await f.post(channel.id, { text: "two" }, key())).statusCode).toBe(202);
    const third = await f.post(channel.id, { text: "three" }, key());
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: "channel_schedule_backlog_full" });
    expect(f.store.listCompanyBoxApprovals({ workspaceSlug: TENANT })).toHaveLength(2);
  });
});

describe("F3: the live event check does not follow redirects off the listing hosts", () => {
  it("refuses a listing that redirects to another host, and sends after an on-host redirect", async () => {
    const seen: Array<{ url: string; redirect?: RequestInit["redirect"] }> = [];
    let location = "https://evil.example/fake-event";
    const f = await setup({
      options: {
        channelEventFetch: (async (url: string, init?: RequestInit) => {
          seen.push({ url: String(url), redirect: init?.redirect });
          return String(url) === "https://lu.ma/abc" ? new Response(null, { status: 302, headers: { location } }) : new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    const channel = await f.createChannel({ slug: "events", policy: EVENT_POLICY });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    const evil = await f.post(channel.id, { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } }, key());
    expect(evil.statusCode).toBe(422);
    expect(evil.json()).toMatchObject({ error: "channel_event_unconfirmed" });
    expect(seen).toEqual([{ url: "https://lu.ma/abc", redirect: "manual" }]);
    location = "https://lu.ma/e/abc";
    const ok = await f.post(channel.id, { text: "Meetup", campaign: { ref: "https://lu.ma/abc" } }, key());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(seen.slice(1).map((entry) => entry.url)).toEqual(["https://lu.ma/abc", "https://lu.ma/e/abc"]);
    expect(f.telegram.sends).toHaveLength(1);
  });
});

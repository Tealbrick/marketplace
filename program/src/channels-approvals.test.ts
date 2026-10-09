import { afterEach, describe, expect, it } from "vitest";

import type { OwnerApprovalVerifier } from "./channels/approvals.js";
import { GRANT_B, PORTAL, SERVICE, TELEGRAM_TOKEN, TENANT, channelFixture, type ChannelFixture } from "./channels/app-fixture.js";
import { createTelegramProvider } from "./channels/providers/telegram.js";
import { createFakeFetch, jsonResponse } from "./channels/providers/test-support.js";

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

let counter = 0;
const key = () => `appr-key-${String(++counter).padStart(6, "0")}`;

/** A fake proof verifier: `valid-<id>[-deny]` portal tokens verify, anything else is refused. */
function fakeVerifier() {
  const calls: Array<{ approvalId: string; digest: string }> = [];
  const verifier: OwnerApprovalVerifier = {
    async verify({ proof, approvalId, digest }) {
      calls.push({ approvalId, digest });
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (proof.proof !== "portal" || !proof.token.startsWith("valid-")) {
        return { ok: false, status: 403, error: "approval_proof_invalid" };
      }
      return {
        ok: true,
        decision: proof.token.endsWith("-deny") ? "deny" : "approve",
        proofId: proof.token,
        kind: "portal",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        decidedBy: "owner:owner-1",
        device: "Martin's Mac",
      };
    },
  };
  return { verifier, calls };
}

async function heldSetup(verifier?: OwnerApprovalVerifier) {
  const f = await channelFixture(verifier ? { verifier } : {});
  fixtures.push(f);
  const channel = await f.createChannel({ slug: "community" });
  f.consentFor("agent-1", channel);
  const held = await f.post(channel.id, { text: "Held for a signed approval" }, key());
  expect(held.statusCode).toBe(202);
  const approvalId = held.json().approvalId as string;
  const resolve = (token: string, decision: "approve" | "deny" = "approve", idempotencyKey = `resolve.${approvalId}.${decision}`, grant?: string) =>
    f.agent("POST", `/api/marketplace/v1/agent/approvals/${approvalId}/resolve`, {
      key: idempotencyKey,
      payload: { proof: "portal", token },
      ...(grant ? { token: grant } : {}),
    });
  return { f, channel, held: held.json(), approvalId, resolve };
}

describe("marketplace.approvals.resolve (K1 review)", () => {
  it("refuses every proof with 501 until kit rc.14 / contract alpha.6 ship, leaving the hold pending", async () => {
    const { f, approvalId, resolve } = await heldSetup();
    const refused = await resolve("valid-proof-token-0001");
    expect(refused.statusCode).toBe(501);
    expect(refused.json()).toMatchObject({ error: "approval_proof_unsupported" });
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("pending");
    expect(f.telegram.sends).toHaveLength(0);
    // The owner UI still decides on the same queue.
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ approval: { state: "succeeded" } });
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("two concurrent resolves: one provider call, one 409", async () => {
    const { verifier } = fakeVerifier();
    const { f, resolve } = await heldSetup(verifier);
    const [left, right] = await Promise.all([resolve("valid-proof-left-0001"), resolve("valid-proof-right-0001")]);
    const statuses = [left.statusCode, right.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = left.statusCode === 409 ? left : right;
    expect(loser.json()).toMatchObject({ error: "approval_already_resolved" });
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("a second valid proof after success is 409 and sends nothing; the same key replays", async () => {
    const { verifier } = fakeVerifier();
    const { f, approvalId, resolve, held } = await heldSetup(verifier);
    const first = await resolve("valid-proof-first-0001");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ decision: "approve", receipt: { status: "sent", digest: held.digest, authority: `approval:${approvalId}` } });
    expect(f.telegram.sends).toHaveLength(1);
    const second = await resolve("valid-proof-second-0001-deny", "deny");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: "approval_already_resolved" });
    const replay = await resolve("valid-proof-first-0001");
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, receipt: { status: "sent" } });
    expect(f.telegram.sends).toHaveLength(1);
    const audit = JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }));
    expect(audit).toContain("approvals.resolve");
    expect(audit).not.toContain("valid-proof-first-0001");
  });

  it("an invalid proof leaves the hold pending; a valid one then succeeds once", async () => {
    const { verifier } = fakeVerifier();
    const { f, approvalId, resolve } = await heldSetup(verifier);
    const invalid = await resolve("forged-proof-0001");
    expect(invalid.statusCode).toBe(403);
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("pending");
    const mismatch = await resolve("valid-proof-says-deny", "approve");
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ error: "approval_decision_mismatch" });
    expect(f.store.getCompanyBoxApproval(approvalId)!.state).toBe("pending");
    const valid = await resolve("valid-proof-ok-0001");
    expect(valid.statusCode).toBe(200);
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("refuses a reused proof, another agent's approval and a malformed key", async () => {
    const { verifier } = fakeVerifier();
    const { f, channel, resolve } = await heldSetup(verifier);
    expect((await resolve("valid-proof-once-0001")).statusCode).toBe(200);
    const next = await f.post(channel.id, { text: "Second held post" }, key());
    const reuse = await f.agent("POST", `/api/marketplace/v1/agent/approvals/${next.json().approvalId}/resolve`, {
      key: `resolve.${next.json().approvalId}.approve`,
      payload: { proof: "portal", token: "valid-proof-once-0001" },
    });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json()).toMatchObject({ error: "approval_proof_reused" });
    expect(f.store.getCompanyBoxApproval(next.json().approvalId)!.state).toBe("pending");
    const foreign = await f.agent("POST", `/api/marketplace/v1/agent/approvals/${next.json().approvalId}/resolve`, {
      key: `resolve.${next.json().approvalId}.approve`,
      payload: { proof: "portal", token: "valid-proof-foreign-0001" },
      token: GRANT_B,
    });
    expect(foreign.statusCode).toBe(404);
    const badKey = await f.agent("POST", `/api/marketplace/v1/agent/approvals/${next.json().approvalId}/resolve`, {
      key: "resolve.other.approve",
      payload: { proof: "portal", token: "valid-proof-key-0001" },
    });
    expect(badKey.statusCode).toBe(400);
    expect(f.telegram.sends).toHaveLength(1);
  });

  it("a signed deny skips the post without a provider call", async () => {
    const { verifier } = fakeVerifier();
    const { f, held, resolve } = await heldSetup(verifier);
    const denied = await resolve("valid-proof-no-0001-deny", "deny");
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toMatchObject({ decision: "deny", status: "denied" });
    expect(f.store.channels.getPost(TENANT, held.postId)).toMatchObject({ status: "skipped", reason: "approval_denied" });
    expect(f.telegram.sends).toHaveLength(0);
  });
});

describe("grant to agent: v1.4 class consent", () => {
  it("requests a channel class grant with the display label and redeems it into a usable consent", async () => {
    const portalGrants = new Map<string, Record<string, unknown>>();
    const f = await channelFixture();
    fixtures.push(f);
    const channel = await f.createChannel({ slug: "community" });
    f.store.upsertPortalHandoffSession({
      portalIssuer: PORTAL,
      deploymentId: "deployment-1",
      portalOrgId: "portal-org-1",
      productTenantId: TENANT,
      workspaceId: TENANT,
      userId: "owner-1",
      sessionToken: "s".repeat(43),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    f.portalReplies.set("/api/deployment-browser/grant-request", () => {
      const request = f.portalRequests.at(-1)!.body;
      const requestId = "r".repeat(43);
      portalGrants.set(requestId, request);
      return new Response(JSON.stringify({ requestId, approvalUrl: "https://portal.test/approve/1", expiresAt: Date.now() + 600_000 }), { status: 200 });
    });
    f.portalReplies.set("/api/deployment-browser/grant-redeem", () => {
      const requested = portalGrants.get("r".repeat(43))!;
      // Portal strips the display label before storing the selection.
      const { actionGroupLabel: _label, ...selection } = requested.selection as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          schema: 1,
          authorized: true,
          product: "marketplace",
          portalOrgId: "portal-org-1",
          productTenantId: TENANT,
          workspaceId: TENANT,
          deploymentId: "deployment-1",
          userId: "owner-1",
          agentId: requested.agentId,
          consentId: "consent-class-1",
          consentRevision: 1,
          state: "active",
          capabilities: ["connector.class.outward"],
          requiredActions: ["read", "create"],
          selection,
        }),
        { status: 200 },
      );
    });
    const browse = await f.owner("GET", "/api/marketplace/channels");
    const grantSelection = browse.json().channels[0].grantSelection;
    expect(grantSelection).toEqual({
      pluginId: "channels-telegram",
      accountId: channel.connectionId,
      resourceKind: "telegram.connected-account",
      resourceRef: `account:${channel.connectionId}`,
      grantClass: "outward",
      actionGroup: "channel:community",
      actionGroupLabel: "Label community",
    });
    const requested = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/request",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: { deploymentId: "deployment-1", agentId: "agent-1", selection: grantSelection, idempotencyKey: "grant-request-0001" },
    });
    expect(requested.statusCode, requested.body).toBe(200);
    const sent = f.portalRequests.find((entry) => entry.url.endsWith("/grant-request"))!.body.selection as Record<string, unknown>;
    expect(sent).toMatchObject({ grantClass: "outward", actionGroup: "channel:community", actionGroupLabel: "Label community" });
    // Marketplace never stores the label.
    expect(requested.json().projection.selection).not.toHaveProperty("actionGroupLabel");
    const redeemed = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/v1/agent/grants/redeem",
      headers: { authorization: `Bearer ${SERVICE}` },
      payload: { deploymentId: "deployment-1", requestId: "r".repeat(43) },
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect(JSON.stringify(f.store.listMarketplaceAgentConsents({ productTenantId: TENANT }))).not.toContain("Label community");
    const consents = await f.agent("GET", "/api/marketplace/v1/agent/consents");
    expect(consents.json().consents).toEqual([
      { consentId: "consent-class-1", toolkit: "channels-telegram", actions: [], grantClass: "outward", actionGroup: "channel:community", state: "active" },
    ]);
    const listed = await f.agent("GET", "/api/marketplace/v1/agent/channels");
    expect(listed.json().channels.map((entry: { id: string }) => entry.id)).toEqual([channel.id]);
    // A class consent can never be used through the per-action tools.call path.
    const tools = await f.agent("POST", "/api/marketplace/v1/agent/tools/call", {
      key: "tools-key-0001",
      payload: { consentId: "consent-class-1", toolkit: "channels-telegram", action: "channel.post", arguments: {} },
    });
    expect(tools.statusCode).toBe(403);
  });
});

describe("hygiene with the real Telegram adapter", () => {
  it("keeps the token (which is in the request URL) out of receipts, responses and audit", async () => {
    const fake = createFakeFetch([
      jsonResponse(200, { ok: true, result: { id: 4242, is_bot: true, username: "tb_test_bot" } }),
      jsonResponse(400, { ok: false, error_code: 400, description: `Bad Request: chat not found for bot${TELEGRAM_TOKEN}` }),
    ]);
    const f = await channelFixture({ options: { channelProviders: { telegram: createTelegramProvider({ fetchImpl: fake.fetchImpl, sleep: async () => undefined }) } } });
    fixtures.push(f);
    // The real adapter discovers through getUpdates; seed the destination directly for this test.
    const connection = f.store.getConnection(TENANT, "channels-telegram")!;
    expect(connection.state).toBe("connected");
    const channel = f.store.channels.createChannel({
      workspaceSlug: TENANT,
      slug: "real",
      label: "Real adapter",
      kind: "chat",
      provider: "telegram",
      connectionId: connection.id,
      destination: { type: "channel", externalId: "-1001234", title: "Test" },
      policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true } },
      status: "active",
    });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    const failed = await f.post(channel.id, { text: "Hello" }, key());
    expect(failed.statusCode).toBe(502);
    expect(fake.requests.at(-1)!.url).toContain(TELEGRAM_TOKEN);
    expect(failed.body).not.toContain(TELEGRAM_TOKEN);
    expect(JSON.stringify(f.store.channels.listReceipts(TENANT))).not.toContain(TELEGRAM_TOKEN);
    expect(JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }))).not.toContain(TELEGRAM_TOKEN);
  });
});

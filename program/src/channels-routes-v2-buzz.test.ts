import { afterEach, describe, expect, it } from "vitest";

import { seededPin } from "./channels/approval-test-support.js";
import { DISCORD_TOKEN, PORTAL, TELEGRAM_TOKEN, TENANT, channelFixture, fakeProvider, type ChannelFixture } from "./channels/app-fixture.js";
import { BUZZ_IDENTITY_ROUTE } from "./channels/buzz-identity-routes.js";
import { ownerKeyFingerprint } from "./channels/owner-key.js";
import { createFakeBuzzRelay, signAuthTag } from "./channels/providers/buzz-test-relay.js";
import { createBuzzProvider } from "./channels/providers/buzz.js";
import { generateSecretKey, npubEncode, publicKeyOf } from "./channels/providers/nostr.js";

// Channels P2 routes v2 on Buzz: the real Buzz adapter over the fake relay (no network). Reactions, edits, deletes and
// a direct message go through the same outward path as every post.

const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = publicKeyOf(OWNER_SECRET)!;
const AGENT_KEY_BYTES = Uint8Array.from({ length: 32 }, (_unused, index) => (index === 0 ? 0x5e : 0x31 + index));
const ORIGIN = "https://marketplace.fixture.invalid";
const BROWSER = "http://localhost:5173";
const CAPS = { perDay: 50, minIntervalSeconds: 0, onePerPhase: true };

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

let ticket = 0;
let counter = 0;
const key = (prefix: string) => `${prefix}-buzz-${String(++counter).padStart(6, "0")}`;

async function buzzSetup() {
  const relay = createFakeBuzzRelay({ members: [OWNER] });
  const f = await channelFixture({
    options: {
      channelProviders: { telegram: fakeProvider("telegram", TELEGRAM_TOKEN).provider, discord: fakeProvider("discord", DISCORD_TOKEN).provider, buzz: createBuzzProvider({ fetchImpl: relay.fetchImpl }) },
      buzzKeyRandom: () => Uint8Array.from(AGENT_KEY_BYTES),
      buzzSocketFactory: relay.socketFactory,
      buzzSocketTimers: { setTimeout: () => 0, clearTimeout: () => undefined },
      buzzRelayLookup: async () => [{ address: "104.16.132.229", family: 4 }],
      ownerPinSource: seededPin({ portalIssuer: PORTAL }),
    },
  });
  fixtures.push(f);
  f.portalReplies.set("/api/deployment-browser/redeem", () =>
    new Response(
      JSON.stringify({
        schema: 1,
        authorized: true,
        product: "marketplace",
        deploymentId: "deployment-1",
        workspaceId: TENANT,
        orgId: "portal-org-1",
        productTenantId: TENANT,
        userId: "owner-1",
        endpoint: ORIGIN,
        session: "s".repeat(43),
        expiresAt: Date.now() + 3_600_000,
      }),
      { status: 200 },
    ),
  );
  f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: OWNER, fingerprint: ownerKeyFingerprint(OWNER), actor: "operator-1" });
  const launched = await f.app.inject({
    method: "POST",
    url: "/auth/launch",
    headers: { origin: PORTAL, "content-type": "application/x-www-form-urlencoded" },
    payload: `ticket=${String(++ticket).padStart(6, "0")}${"r".repeat(37)}`,
  });
  const cookie = String(launched.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = (await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session", headers: { cookie } })).json().session.csrfToken as string;
  const ownerWrite = (method: "POST" | "PUT", url: string, payload: unknown) =>
    f.app.inject({ method, url, headers: { origin: BROWSER, cookie, "x-csrf-token": csrf }, payload: payload as Record<string, unknown> });
  await ownerWrite("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {});
  await ownerWrite("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: relay.relayUrl });
  const agentKey = publicKeyOf(Buffer.from(AGENT_KEY_BYTES).toString("hex"))!;
  const tag = signAuthTag(OWNER_SECRET, agentKey, `created_at<${Math.floor(Date.now() / 1000) + 30 * 86_400}`);
  const identity = await ownerWrite("PUT", BUZZ_IDENTITY_ROUTE, { authTag: tag });
  expect(identity.json().buzz.readiness).toBe("available");
  return { f, relay, agentKey };
}

describe("routes v2 on Buzz (real adapter, fake relay)", () => {
  it("reacts to, edits and deletes the agent's own Buzz message, and sends an owner-approved first DM", async () => {
    const { f, relay, agentKey } = await buzzSetup();
    const alice = publicKeyOf(generateSecretKey())!;
    const group = relay.createGroup({ name: "community", members: [alice, agentKey] });
    const channel = await f.createChannel({ provider: "buzz", slug: "buzz-v2", externalId: group, policy: { standingGrants: "allowed", caps: CAPS, content: { files: { types: ["png"] } } } });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id, { caps: CAPS, scope: { files: false, immediate: true, scheduled: false, reactions: true, edits: true, deletes: true, dms: true } });

    const posted = await f.post(channel.id, { text: "Meetup on Friday" }, key("post"));
    expect(posted.statusCode, posted.body).toBe(200);
    const messageId = (posted.json().receipt.resultIds as string[])[0]!;
    expect(messageId).toMatch(/^[0-9a-f]{64}$/u);

    const reacted = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/messages/${messageId}/reactions`, { key: key("react"), payload: { emoji: "+" } });
    expect(reacted.statusCode, reacted.body).toBe(200);
    expect(relay.eventsOfKind(7).filter((event) => event.pubkey === agentKey).map((event) => event.tags)).toEqual([expect.arrayContaining([["e", messageId], ["h", group]])]);

    const edited = await f.agent("PATCH", `/api/marketplace/v1/agent/channels/${channel.id}/messages/${messageId}`, { key: key("edit"), payload: { text: "Meetup on Saturday" } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(relay.eventsOfKind(40003).filter((event) => event.pubkey === agentKey).map((event) => event.content)).toEqual(["Meetup on Saturday"]);

    // Someone else's message in the same channel is never a target.
    const theirs = relay.inject(generateSecretKey(), { kind: 9, tags: [["h", group]], content: "not yours" });
    const refused = await f.agent("DELETE", `/api/marketplace/v1/agent/channels/${channel.id}/messages/${theirs.id}`, { key: key("delete") });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toMatchObject({ error: "channel_message_not_ours" });

    const deleted = await f.agent("DELETE", `/api/marketplace/v1/agent/channels/${channel.id}/messages/${messageId}`, { key: key("delete") });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(relay.eventsOfKind(5).filter((event) => event.pubkey === agentKey && event.tags.some((tag) => tag[0] === "e" && tag[1] === messageId))).toHaveLength(1);

    // DM: the owner allows the workspace; the first message is held and sent after approval.
    await f.owner("PUT", `/api/marketplace/channels/connections/${channel.connectionId}/people-policy`, { mode: "workspace" });
    const found = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/people/find`, { key: key("find"), payload: { handle: npubEncode(alice) } });
    expect(found.statusCode, found.body).toBe(200);
    expect(Object.keys(found.json().person).sort()).toEqual(["approved", "displayName", "personRef"]);
    const held = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/people/${found.json().person.personRef}/messages`, { key: key("dm"), payload: { text: "Hi Alice" } });
    expect(held.statusCode, held.body).toBe(202);
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(approved.json(), approved.body).toMatchObject({ approval: { state: "succeeded" }, channel: { receipt: { status: "sent" } } });
    expect(relay.eventsOfKind(41010).filter((event) => event.pubkey === agentKey)).toHaveLength(1);
    expect(relay.eventsOfKind(9).filter((event) => event.pubkey === agentKey && event.content.includes("Hi Alice"))).toHaveLength(1);
  });
});

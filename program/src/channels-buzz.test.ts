import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { seededPin } from "./channels/approval-test-support.js";
import { DISCORD_TOKEN, PORTAL, TELEGRAM_TOKEN, TENANT, channelFixture, fakeProvider, type ChannelFixture } from "./channels/app-fixture.js";
import { BUZZ_IDENTITY_ROUTE } from "./channels/buzz-identity-routes.js";
import type { Timers } from "./channels/discord-gateway.js";
import { ownerKeyFingerprint } from "./channels/owner-key.js";
import { createFakeBuzzRelay, signAuthTag, type FakeBuzzRelay } from "./channels/providers/buzz-test-relay.js";
import { createBuzzProvider } from "./channels/providers/buzz.js";
import { generateSecretKey, npubEncode, publicKeyOf } from "./channels/providers/nostr.js";

const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000001";
const OWNER = publicKeyOf(OWNER_SECRET)!;
/** Sentinel agent secret (the key generator is injected): it must never appear in any response, row, log or audit. */
const SENTINEL_BYTES = Uint8Array.from({ length: 32 }, (_unused, index) => (index === 0 ? 0x5e : 0x11 + index));
const SENTINEL_HEX = Buffer.from(SENTINEL_BYTES).toString("hex");
const ROTATED_BYTES = Uint8Array.from({ length: 32 }, (_unused, index) => (index === 0 ? 0x6f : 0x21 + index));
const ROTATED_HEX = Buffer.from(ROTATED_BYTES).toString("hex");

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function fakeTimers(): Timers {
  return { setTimeout: () => 0, clearTimeout: () => undefined };
}

const ORIGIN = "https://marketplace.fixture.invalid";
/** A browser origin the test environment allows for operator mutations. */
const BROWSER = "http://localhost:5173";
let ticketCounter = 0;

async function buzzFixture(input: { inert?: boolean; keys?: Uint8Array[]; pinned?: boolean; ownerKey?: boolean } = {}) {
  const relay: FakeBuzzRelay = createFakeBuzzRelay({ members: [OWNER] });
  const buzz = createBuzzProvider({ fetchImpl: relay.fetchImpl });
  const keys = [...(input.keys ?? [SENTINEL_BYTES, ROTATED_BYTES])];
  const telegram = fakeProvider("telegram", TELEGRAM_TOKEN);
  const discord = fakeProvider("discord", DISCORD_TOKEN);
  const pin = seededPin({ portalIssuer: PORTAL });
  const f = await channelFixture({
    ...(input.inert ? { environment: { MARKETPLACE_CHANNELS_TELEGRAM_BOT_TOKEN: undefined, MARKETPLACE_CHANNELS_DISCORD_BOT_TOKEN: undefined } } : {}),
    options: {
      channelProviders: input.inert ? { buzz } : { telegram: telegram.provider, discord: discord.provider, buzz },
      buzzKeyRandom: () => Uint8Array.from(keys.shift() ?? SENTINEL_BYTES),
      buzzSocketFactory: relay.socketFactory,
      buzzSocketTimers: fakeTimers(),
      ...(input.pinned === false ? {} : { ownerPinSource: pin }),
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
  // The pinned owner Buzz key (approvals.ownerNostrPubkey): a pasted tag must be signed by it.
  if (input.ownerKey !== false) f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: OWNER, fingerprint: ownerKeyFingerprint(OWNER), actor: "operator-1" });
  /** The owner's own Marketplace session from a real Portal launch ticket (cookie + CSRF). */
  let session: { cookie: string; csrf: string } | null = null;
  const ownerSession = async () => {
    if (session) return session;
    const launched = await f.app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: { origin: PORTAL, "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${String(++ticketCounter).padStart(6, "0")}${"t".repeat(37)}`,
    });
    if (launched.statusCode !== 303) throw new Error(launched.body);
    const cookie = String(launched.headers["set-cookie"]).split(";", 1)[0]!;
    const current = await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session", headers: { cookie } });
    session = { cookie, csrf: current.json().session.csrfToken as string };
    return session;
  };
  const responses: string[] = [];
  /** Reads as a plain operator; writes as the pinned owner's launch session unless `plain`. */
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, options: { plain?: boolean } = {}) => {
    const owner = method !== "GET" && !options.plain ? await ownerSession() : null;
    const response = await f.app.inject({
      method,
      url,
      ...(owner ? { headers: { origin: BROWSER, cookie: owner.cookie, "x-csrf-token": owner.csrf } } : {}),
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    responses.push(response.body);
    return response;
  };
  return { f, relay, buzz, call, responses, pin };
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("Buzz identity owner ops", () => {
  it("generates the agent key, takes the relay URL and a verified NIP-OA tag, rotates and revokes; the key never leaks", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    }
    const { f, relay, call, responses } = await buzzFixture();
    const agent = publicKeyOf(SENTINEL_HEX)!;

    const empty = await call("GET", BUZZ_IDENTITY_ROUTE);
    expect(empty.json().buzz).toMatchObject({ key: { present: false }, readiness: "credential_missing", authTag: { status: "missing" }, signing: null });

    const generated = await call("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {});
    expect(generated.statusCode, generated.body).toBe(200);
    expect(generated.json().buzz.key).toMatchObject({ present: true, npub: npubEncode(agent), pubkeyHex: agent });
    expect(generated.json().buzz.signing.preimage).toMatch(new RegExp(`^nostr:agent-auth:${agent}:created_at<\\d+$`, "u"));
    expect((await call("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {})).json()).toMatchObject({ ok: false, error: "buzz_key_exists" });

    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: "ws://insecure.relay" })).json()).toMatchObject({ ok: false, error: "buzz_relay_url_invalid" });
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: `${relay.relayUrl}/` })).json().buzz.relay).toEqual({ url: relay.relayUrl, httpBase: relay.httpBase });

    // Pinned owner Buzz key (approvals.ownerNostrPubkey): the tag must be signed by it.
    f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: OWNER, fingerprint: ownerKeyFingerprint(OWNER), actor: "operator-1" });
    const end = nowSeconds() + 60 * 86_400;
    const stranger = generateSecretKey();
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: JSON.stringify(signAuthTag(stranger, agent, `created_at<${end}`)) })).json()).toMatchObject({ error: "buzz_auth_tag_wrong_owner" });
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: signAuthTag(OWNER_SECRET, agent, `created_at<${Math.floor(f.now / 1000) - 5}`) })).json()).toMatchObject({ error: "buzz_auth_tag_expired" });
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: signAuthTag(OWNER_SECRET, agent, `created_at<${nowSeconds() + 91 * 86_400}`) })).json()).toMatchObject({ error: "buzz_auth_tag_too_long" });
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: signAuthTag(OWNER_SECRET, agent, "kind=9") })).json()).toMatchObject({ error: "buzz_auth_tag_end_missing" });
    const pastedNsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    const refusedSecret = await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: pastedNsec });
    expect(refusedSecret.json()).toMatchObject({ error: "buzz_auth_tag_malformed" });
    expect(refusedSecret.body).not.toContain(pastedNsec);

    const tag = signAuthTag(OWNER_SECRET, agent, `created_at<${end}`);
    const set = await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: JSON.stringify(tag) });
    expect(set.statusCode).toBe(200);
    expect(set.json().buzz).toMatchObject({
      readiness: "available",
      authTag: { status: "valid", ownerNpub: npubEncode(OWNER), conditions: `created_at<${end}`, daysLeft: expect.any(Number), renewalDue: false, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      pinnedOwner: { set: true },
    });
    const browse = await call("GET", "/api/marketplace/channels");
    expect(browse.json().providers).toContainEqual(expect.objectContaining({ id: "buzz", readiness: "available" }));
    expect(browse.json().connections.buzz).toMatchObject({ state: "connected", botUsername: expect.stringMatching(/^npub1/u) });
    expect(browse.json().buzz.authTag.status).toBe("valid");

    // Renewal reminder under 14 days.
    const short = signAuthTag(OWNER_SECRET, agent, `created_at<${nowSeconds() + 10 * 86_400}`);
    const renewal = (await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: short })).json().buzz.authTag;
    expect(renewal.renewalDue).toBe(true);
    expect(renewal.daysLeft).toBeLessThanOrEqual(10);
    expect(set.json().buzz.authTag.daysLeft).toBeGreaterThanOrEqual(59);

    // A changed pinned owner key makes the stored tag invalid at once.
    const otherOwner = publicKeyOf(generateSecretKey())!;
    f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: otherOwner, fingerprint: ownerKeyFingerprint(otherOwner), actor: "operator-1" });
    expect((await call("GET", "/api/marketplace/channels")).json().readiness.buzz).toBe("credential_invalid");
    f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: OWNER, fingerprint: ownerKeyFingerprint(OWNER), actor: "operator-1" });

    // Revoke clears the tag; Marketplace stops using the identity.
    const revoked = await call("DELETE", `${BUZZ_IDENTITY_ROUTE}/auth-tag`);
    expect(revoked.json().buzz).toMatchObject({ readiness: "credential_missing", authTag: { status: "missing" } });
    expect((await call("GET", "/api/marketplace/channels")).json().readiness.buzz).toBe("credential_missing");

    // Rotation: a new key, the old one gone, the tag cleared until the owner signs again.
    await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: tag });
    const rotated = await call("POST", `${BUZZ_IDENTITY_ROUTE}/key`, { rotate: true });
    const rotatedKey = publicKeyOf(ROTATED_HEX)!;
    expect(rotated.json().buzz).toMatchObject({ key: { pubkeyHex: rotatedKey }, authTag: { status: "missing" }, readiness: "credential_missing" });
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: tag })).json()).toMatchObject({ error: "buzz_auth_tag_signature_invalid" });

    const audit = (f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }) as Array<Record<string, unknown>>).map((row) => ({
      eventType: String(row.event_type),
      metadata: JSON.parse(String(row.metadata ?? row.metadata_json ?? "{}")) as Record<string, unknown>,
    }));
    const buzzAudit = audit.filter((row) => row.eventType.startsWith("marketplace.channels.buzz."));
    expect(buzzAudit.map((row) => row.eventType)).toEqual(
      expect.arrayContaining([
        "marketplace.channels.buzz.key_generated",
        "marketplace.channels.buzz.relay_changed",
        "marketplace.channels.buzz.auth_tag_set",
        "marketplace.channels.buzz.auth_tag_revoked",
        "marketplace.channels.buzz.key_rotated",
      ]),
    );
    expect(buzzAudit.find((row) => row.eventType === "marketplace.channels.buzz.key_rotated")?.metadata).toMatchObject({ npub: npubEncode(rotatedKey), previousNpub: npubEncode(agent) });
    expect(buzzAudit.find((row) => row.eventType === "marketplace.channels.buzz.auth_tag_set")?.metadata).toMatchObject({ npub: npubEncode(agent), tagSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });

    // Sentinel scan: responses, every table row, audit, logs and everything sent to the relay.
    const raw = new DatabaseSync(path.join(f.root, "marketplace.sqlite"));
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
    const rows = tables.map((table) => JSON.stringify(raw.prepare(`SELECT * FROM "${table}"`).all()));
    raw.close();
    const haystack = [...responses, ...rows, JSON.stringify(audit), ...logs, JSON.stringify(relay.requests), JSON.stringify(relay.events)].join("\n");
    for (const secret of [SENTINEL_HEX, ROTATED_HEX]) {
      expect(haystack).not.toContain(secret);
      expect(haystack.toLowerCase()).not.toContain(secret.slice(0, 40));
    }
    // The key exists only as connector_secret ciphertext (decryptable server-side).
    expect(f.store.readConnectorSecretValues({ workspaceSlug: TENANT, pluginId: "channels-buzz" }).agentSecretKey).toBe(ROTATED_HEX);
  });

  it("works in inert mode (the identity is what turns Buzz on) and says it applies after the next start", async () => {
    const { f, relay, call } = await buzzFixture({ inert: true });
    expect(f.runtime.configured).toBe(false);
    const browse = await call("GET", "/api/marketplace/channels");
    expect(browse.json()).toMatchObject({ configured: false, providers: [{ id: "buzz", readiness: "credential_missing" }], buzz: { key: { present: false } } });
    const generated = await call("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {});
    expect(generated.json()).toMatchObject({ ok: true, appliesAfterRestart: true });
    await call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: relay.relayUrl });
    const agent = generated.json().buzz.key.pubkeyHex as string;
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: signAuthTag(OWNER_SECRET, agent, `created_at<${nowSeconds() + 86_400}`) })).json().buzz.readiness).toBe("available");
    // Everything else stays refused, and nothing was posted or subscribed.
    expect((await call("GET", "/api/marketplace/channels/discover?provider=buzz")).json()).toMatchObject({ error: "channels_not_configured" });
    expect(relay.events.filter((event) => event.pubkey === agent)).toHaveLength(0);
    expect(relay.sockets).toHaveLength(0);
    expect(relay.requests).toHaveLength(0);
  });
});

describe("Buzz end to end: native send, inbound socket and the bridge", () => {
  it("discovers a Buzz channel, sends natively, receives a message on the socket and bridges it to the routed agent", async () => {
    const { f, relay, call } = await buzzFixture();
    await call("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {});
    await call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: relay.relayUrl });
    const bridgeKey = publicKeyOf(SENTINEL_HEX)!;
    const tag = signAuthTag(OWNER_SECRET, bridgeKey, `created_at<${nowSeconds() + 30 * 86_400}`);
    expect((await call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: tag })).json().buzz.readiness).toBe("available");

    const aliceSecret = generateSecretKey();
    const alice = publicKeyOf(aliceSecret)!;
    const agentSecret = generateSecretKey();
    const agentKey = publicKeyOf(agentSecret)!;
    const group = relay.createGroup({ name: "community", members: [alice, bridgeKey] });
    const channel = await f.createChannel({ provider: "buzz", slug: "buzz-community", externalId: group, policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, content: { files: { types: ["png"] } } } });

    // Native outbound: the owner test post lands in the Buzz channel, signed by the bridge identity with the tag.
    const test = await f.owner("POST", `/api/marketplace/channels/${channel.id}/test`, {}, { "idempotency-key": "buzz-owner-test-0001" });
    expect(test.statusCode).toBe(200);
    const posted = relay.eventsOfKind(9).filter((event) => event.pubkey === bridgeKey);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.tags).toEqual([["h", group], tag]);

    // Route inbound to agent-1 with its Buzz key: the relay socket starts and subscribes to the channel.
    f.consentFor("agent-1", channel);
    const routed = await call("PUT", `/api/marketplace/channels/${channel.id}/inbound`, { enabled: true, agentId: "agent-1", agentBuzzPubkey: npubEncode(agentKey) });
    expect(routed.statusCode).toBe(200);
    expect(routed.json().receivers.buzzBridge).toMatchObject({ agentNpub: npubEncode(agentKey), relayUrl: relay.relayUrl });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.runtime.inbound.worker.buzzSocket?.status).toBe("ready");
    expect(routed.json().receivers.buzz).toBeDefined();
    expect(f.runtime.inbound.pipeline.sinkId).toBe("buzz-bridge");

    const inbound = relay.inject(aliceSecret, { kind: 9, tags: [["h", group]], content: "Hi agent, when is the meetup? @everyone" });
    await f.runtime.inbound.pipeline.settled();
    const stored = f.store.channels.inbound.listEvents(TENANT, { limit: 10 });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ platform: "buzz", messageId: inbound.id, routedTo: "agent-1", bridgeStatus: "bridged" });

    const bridgeChannel = relay.eventsOfKind(9007).find((event) => event.pubkey === bridgeKey)!;
    const bridgeGroup = bridgeChannel.tags.find((entry) => entry[0] === "h")![1]!;
    expect(relay.groups.get(bridgeGroup)).toMatchObject({ private: true, name: "tb-inbound-buzz-community" });
    const bridged = relay.eventsOfKind(9).filter((event) => event.pubkey === bridgeKey && event.tags.some((entry) => entry[0] === "h" && entry[1] === bridgeGroup));
    expect(bridged).toHaveLength(1);
    expect(bridged[0]!.tags).toEqual([["h", bridgeGroup], ["p", agentKey], tag]);
    expect(bridged[0]!.content).toContain(`event: ${stored[0]!.id}`);
    expect(bridged[0]!.content).toContain("-----BEGIN UNTRUSTED EXTERNAL MESSAGE-----\nHi agent, when is the meetup? ＠everyone\n-----END UNTRUSTED EXTERNAL MESSAGE-----");
    // The bridge's own messages are never ingested (own key), and the bridge channel is not routed.
    expect(f.store.channels.inbound.listEvents(TENANT, { limit: 10 })).toHaveLength(1);

    // A relay URL change makes the bridge refuse until the owner confirms the route again.
    await call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: "wss://moved.relay.test" });
    const browse = await call("GET", "/api/marketplace/channels");
    expect(browse.json().inbound.buzzBridge).toEqual([expect.objectContaining({ channelId: channel.id, relayChanged: true })]);
  });

  it("refuses an invalid agent Buzz key on the route and a route before the relay is set", async () => {
    const { f, call } = await buzzFixture();
    const channel = await f.createChannel({ slug: "tg-community" });
    const noRelay = await call("PUT", `/api/marketplace/channels/${channel.id}/inbound`, { enabled: false, agentBuzzPubkey: npubEncode(publicKeyOf(generateSecretKey())!) });
    expect(noRelay.json()).toMatchObject({ ok: false, error: "buzz_relay_missing" });
    await call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: "wss://relay.buzz.test" });
    const bad = await call("PUT", `/api/marketplace/channels/${channel.id}/inbound`, { enabled: false, agentBuzzPubkey: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5" });
    expect(bad.json()).toMatchObject({ ok: false, error: "buzz_agent_key_invalid" });
  });
});

describe("Buzz identity security (strict owner gate, pinned owner key, relay change)", () => {
  const auditOf = (f: ChannelFixture, eventType: string) =>
    (f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }) as Array<Record<string, unknown>>)
      .filter((row) => row.event_type === eventType)
      .map((row) => ({ actor: row.actor_id, metadata: JSON.parse(String(row.metadata)) as Record<string, unknown> }));

  it("refuses every write from a non-owner operator, from a launched user who is not the pinned owner, and without a pin", async () => {
    const t = await buzzFixture();
    const channel = await t.f.createChannel({ slug: "tg-guarded" });
    const writes: Array<["POST" | "PUT" | "DELETE", string, unknown]> = [
      ["POST", `${BUZZ_IDENTITY_ROUTE}/key`, {}],
      ["POST", `${BUZZ_IDENTITY_ROUTE}/key`, { rotate: true }],
      ["PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: "wss://attacker.relay.test" }],
      ["PUT", BUZZ_IDENTITY_ROUTE, { authTag: '["auth","' + OWNER + '","created_at<1","' + "a".repeat(128) + '"]' }],
      ["DELETE", `${BUZZ_IDENTITY_ROUTE}/auth-tag`, undefined],
      ["PUT", `/api/marketplace/channels/${channel.id}/inbound`, { enabled: false, agentBuzzPubkey: npubEncode(publicKeyOf(generateSecretKey())!) }],
    ];
    // A plain operator session (not the owner's Portal launch session).
    for (const [method, url, payload] of writes) {
      const refused = await t.call(method, url, payload, { plain: true });
      expect(refused.statusCode, `${method} ${url}`).toBe(403);
      expect(refused.json()).toMatchObject({ ok: false, error: "owner_session_required" });
    }
    // A launched Portal user who is not the pinned owner.
    t.pin.current = { ...t.pin.current, ownerSubject: "tealbrick-user:someone-else" };
    for (const [method, url, payload] of writes) {
      const refused = await t.call(method, url, payload);
      expect(refused.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(t.f.store.channels.buzz.getIdentity(TENANT)).toBeNull();
    expect(t.f.store.channels.buzz.listRoutes(TENANT)).toEqual([]);
    expect(t.f.store.listConnectorSecrets({ workspaceSlug: TENANT, pluginId: "channels-buzz" })).toEqual([]);
    // Reads stay open to any operator.
    expect((await t.call("GET", BUZZ_IDENTITY_ROUTE)).statusCode).toBe(200);

    const unpinned = await buzzFixture({ pinned: false });
    for (const [method, url, payload] of writes.slice(0, 5)) {
      const refused = await unpinned.call(method, url, payload);
      expect(refused.statusCode, `${method} ${url}`).toBe(409);
      expect(refused.json()).toMatchObject({ error: "approval_owner_unbound" });
    }
  });

  it("refuses a tag when no owner Buzz key is set, and a tag signed by a different owner key", async () => {
    const t = await buzzFixture({ ownerKey: false });
    const agent = (await t.call("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {})).json().buzz.key.pubkeyHex as string;
    await t.call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: t.relay.relayUrl });
    const good = signAuthTag(OWNER_SECRET, agent, `created_at<${nowSeconds() + 86_400}`);
    const noOwnerKey = await t.call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: good });
    expect(noOwnerKey.statusCode).toBe(409);
    expect(noOwnerKey.json()).toMatchObject({ ok: false, error: "buzz_owner_key_required" });
    t.f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: OWNER, fingerprint: ownerKeyFingerprint(OWNER), actor: "operator-1" });
    const other = await t.call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: signAuthTag(generateSecretKey(), agent, `created_at<${nowSeconds() + 86_400}`) });
    expect(other.json()).toMatchObject({ ok: false, error: "buzz_auth_tag_wrong_owner" });
    expect((await t.call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: good })).json().buzz.readiness).toBe("available");
    // Clearing the owner key later makes the stored tag invalid (no tag is valid without a pinned owner key).
    t.f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: null, fingerprint: null, actor: "operator-1" });
    expect((await t.call("GET", BUZZ_IDENTITY_ROUTE)).json().buzz).toMatchObject({ readiness: "credential_invalid", authTag: { status: "invalid", reason: "owner_key_required" } });
    expect((await t.call("GET", "/api/marketplace/channels")).json().readiness.buzz).toBe("credential_invalid");
  });

  it("a relay change clears the tag (needs re-signing) and pauses the bridge until the owner confirms each route again", async () => {
    const t = await buzzFixture();
    await t.call("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {});
    await t.call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: t.relay.relayUrl });
    const bridgeKey = publicKeyOf(SENTINEL_HEX)!;
    const tag = signAuthTag(OWNER_SECRET, bridgeKey, `created_at<${nowSeconds() + 30 * 86_400}`);
    await t.call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: tag });
    const aliceSecret = generateSecretKey();
    const group = t.relay.createGroup({ name: "community", members: [publicKeyOf(aliceSecret)!, bridgeKey] });
    const channel = await t.f.createChannel({ provider: "buzz", slug: "buzz-relay-change", externalId: group, policy: { standingGrants: "allowed", caps: { perDay: 6, minIntervalSeconds: 0, onePerPhase: true }, content: { files: { types: ["png"] } } } });
    t.f.consentFor("agent-1", channel);
    const agentKey = publicKeyOf(generateSecretKey())!;
    const route = { enabled: true, agentId: "agent-1", agentBuzzPubkey: npubEncode(agentKey) };
    expect((await t.call("PUT", `/api/marketplace/channels/${channel.id}/inbound`, route)).statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    t.relay.inject(aliceSecret, { kind: 9, tags: [["h", group]], content: "before the change" });
    await t.f.runtime.inbound.pipeline.settled();
    const eventWith = (text: string) => t.f.store.channels.inbound.listEvents(TENANT, { limit: 10 }).find((event) => event.text === text);
    expect(eventWith("before the change")).toMatchObject({ bridgeStatus: "bridged" });

    // Relay change: the tag is cleared, readiness is credential_missing, routes need confirmation; audited with hosts.
    const moved = await t.call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: "wss://moved.relay.test" });
    expect(moved.json().buzz).toMatchObject({ readiness: "credential_missing", authTag: { status: "missing" }, relay: { url: "wss://moved.relay.test" } });
    expect((await t.call("GET", "/api/marketplace/channels")).json().readiness.buzz).toBe("credential_missing");
    expect(auditOf(t.f, "marketplace.channels.buzz.relay_changed").at(0)).toMatchObject({
      actor: "operator:owner-1",
      metadata: { oldRelayHost: t.relay.host, newRelayHost: "moved.relay.test", actor: "operator:owner-1", pausedRoutes: 1, clearedTagSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    });
    expect((await t.call("GET", "/api/marketplace/channels")).json().inbound.buzzBridge).toEqual([
      expect.objectContaining({ channelId: channel.id, relayUrl: null, needsConfirmation: true, bridgeChannel: null }),
    ]);

    // Back on the original relay with a re-signed tag: the identity works, but the bridge stays paused for the route.
    await t.call("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: t.relay.relayUrl });
    expect((await t.call("PUT", BUZZ_IDENTITY_ROUTE, { authTag: tag })).json().buzz.readiness).toBe("available");
    await new Promise((resolve) => setImmediate(resolve));
    t.relay.inject(aliceSecret, { kind: 9, tags: [["h", group]], content: "after the change" });
    await t.f.runtime.inbound.pipeline.settled();
    expect(eventWith("after the change")).toMatchObject({ bridgeStatus: "bridge-failed", bridgeDetail: "buzz_relay_changed" });

    // The owner confirms the route again: bridging resumes (in a new bridge channel on this relay).
    expect((await t.call("PUT", `/api/marketplace/channels/${channel.id}/inbound`, route)).statusCode).toBe(200);
    t.relay.inject(aliceSecret, { kind: 9, tags: [["h", group]], content: "confirmed again" });
    await t.f.runtime.inbound.pipeline.settled();
    expect(eventWith("confirmed again")).toMatchObject({ bridgeStatus: "bridged" });
    expect(t.relay.eventsOfKind(9007).filter((event) => event.pubkey === bridgeKey)).toHaveLength(2);
  });
});

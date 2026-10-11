import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { canonicalGrant, grantDigest, parseGrant } from "@tealbrick/contract";
import { afterEach, describe, expect, it } from "vitest";

import { ownerAssertion, portalSigner, seededPin, type PortalSigner } from "./channels/approval-test-support.js";
import { DISCORD_TOKEN, GRANT_B, PORTAL, TELEGRAM_TOKEN, TENANT, channelFixture, fakeProvider, type ChannelFixture } from "./channels/app-fixture.js";
import { BUZZ_IDENTITY_ROUTE } from "./channels/buzz-identity-routes.js";
import { encodeFrame, HUDDLE_FLAG_DTX } from "./channels/huddle/frame.js";
import { createFakeHuddleRelay, type FakeHuddleRelay } from "./channels/huddle/huddle-test-relay.js";
import { createFakeSpeechProvider, guardedTestFactory, opusPacket, waitFor } from "./channels/huddle/test-support.js";
import { LIVE_CLIP_APPROVAL_TEXT, liveClipDigest, recordWhenFullySent } from "./channels/live/routes.js";
import { forbiddenTermsIn } from "./channels/live/sessions.js";
import { ownerKeyFingerprint } from "./channels/owner-key.js";
import { createFakeBuzzRelay, signAuthTag, signTestEvent } from "./channels/providers/buzz-test-relay.js";
import { createBuzzProvider } from "./channels/providers/buzz.js";
import { publicKeyOf } from "./channels/providers/nostr.js";
import { writeOggOpus } from "./channels/providers/ogg-opus.js";

// Channels P2 live sessions (scope §2.3): live-session grants (contract alpha.8) and Buzz huddle sessions, end to end
// through the app over a fake Buzz relay, a fake huddle relay (127.0.0.1) and a fake speech provider. No network.

const OWNER_SECRET = "0000000000000000000000000000000000000000000000000000000000000003";
const OWNER = publicKeyOf(OWNER_SECRET)!;
const STRANGER_SECRET = "0000000000000000000000000000000000000000000000000000000000000004";
const CREATOR_SECRET = "0000000000000000000000000000000000000000000000000000000000000009";
const AGENT_KEY_BYTES = Uint8Array.from({ length: 32 }, (_unused, index) => (index === 0 ? 0x4d : 0x21 + index));
const AGENT_KEY = publicKeyOf(Buffer.from(AGENT_KEY_BYTES).toString("hex"))!;
const ORIGIN = "https://marketplace.fixture.invalid";
const BROWSER = "http://localhost:5173";
const JWKS_PATH = "/api/grant-jwks";
const A = "/api/marketplace/v1/agent/channels";
const O = "/api/marketplace/channels/live";
const PEER = "c3".repeat(32);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

let counter = 0;
/** Signed owner commands get strictly increasing times (they must be newer than the last change they follow). */
let commandSeconds = Math.floor(Date.now() / 1000) + 2;
const nextCommandAt = () => (commandSeconds = Math.max(commandSeconds + 1, Math.floor(Date.now() / 1000) + 2));
const key = (prefix = "k") => `${prefix}-live-${String(++counter).padStart(6, "0")}`;
let ticket = 0;

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(input: { tts?: boolean; speechReply?: (index: number) => string; synthesize?: (text: string) => Uint8Array } = {}) {
  const relay = createFakeBuzzRelay({ members: [OWNER] });
  const huddleRelay: FakeHuddleRelay = createFakeHuddleRelay({ host: "relay.buzz.test", members: [OWNER] });
  const port = await huddleRelay.start();
  cleanups.push(() => huddleRelay.close());
  const signer: PortalSigner = portalSigner();
  const speech = createFakeSpeechProvider({
    reply: (_call, index) => ({ text: input.speechReply ? input.speechReply(index) : `heard line ${index + 1}` }),
    ...(input.synthesize ? { synthesize: input.synthesize } : {}),
  });
  const f: ChannelFixture = await channelFixture({
    options: {
      channelProviders: { telegram: fakeProvider("telegram", TELEGRAM_TOKEN).provider, discord: fakeProvider("discord", DISCORD_TOKEN).provider, buzz: createBuzzProvider({ fetchImpl: relay.fetchImpl }) },
      buzzKeyRandom: () => Uint8Array.from(AGENT_KEY_BYTES),
      buzzSocketFactory: relay.socketFactory,
      buzzSocketTimers: { setTimeout: () => 0, clearTimeout: () => undefined },
      buzzRelayLookup: async () => [{ address: "104.16.132.229", family: 4 }],
      ownerPinSource: seededPin({ portalIssuer: PORTAL, jwksUri: `${PORTAL}${JWKS_PATH}`, grantKids: [signer.kid] }),
      liveSpeechProvider: speech.provider,
      liveTtsAvailable: input.tts === true,
      liveHuddleSocketFactory: guardedTestFactory(port, { allowPrivate: true }).factory,
      liveTickMs: 50,
      liveHuddleCloseGraceMs: 500,
    },
  });
  cleanups.push(() => f.close());
  f.portalReplies.set(JWKS_PATH, () => new Response(JSON.stringify({ keys: [signer.jwk] }), { status: 200, headers: { "content-type": "application/json" } }));
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
  f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: OWNER, fingerprint: ownerKeyFingerprint(OWNER), actor: "operator-1", now: new Date(Date.now() - 60_000) });
  const launched = await f.app.inject({
    method: "POST",
    url: "/auth/launch",
    headers: { origin: PORTAL, "content-type": "application/x-www-form-urlencoded" },
    payload: `ticket=${String(++ticket).padStart(6, "0")}${"l".repeat(37)}`,
  });
  const cookie = String(launched.headers["set-cookie"]).split(";", 1)[0]!;
  const csrf = (await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session", headers: { cookie } })).json().session.csrfToken as string;
  /** The pinned owner's own launch session (strict owner gate). */
  const strictHeaders = async () => ({ origin: BROWSER, cookie, "x-csrf-token": csrf });
  const strict = (method: "POST" | "PUT", url: string, payload: unknown = {}) =>
    f.app.inject({ method, url, headers: { origin: BROWSER, cookie, "x-csrf-token": csrf }, payload: payload as Record<string, unknown> });
  await strict("POST", `${BUZZ_IDENTITY_ROUTE}/key`, {});
  await strict("PUT", BUZZ_IDENTITY_ROUTE, { relayUrl: relay.relayUrl });
  const tag = signAuthTag(OWNER_SECRET, AGENT_KEY, `created_at<${Math.floor(Date.now() / 1000) + 30 * 86_400}`);
  const identity = await strict("PUT", BUZZ_IDENTITY_ROUTE, { authTag: tag });
  expect(identity.json().buzz.readiness).toBe("available");
  const group = relay.createGroup({ name: "community", members: [AGENT_KEY] });
  const channel = await f.createChannel({ provider: "buzz", slug: "buzz-live", externalId: group, policy: { standingGrants: "allowed", caps: { perDay: 20, minIntervalSeconds: 0, onePerPhase: false }, content: { files: { types: ["png"] } } } });
  f.consentFor("agent-1", channel);
  f.consentFor("agent-2", channel, "read");

  const proposal = (extra: Record<string, unknown> = {}) => ({
    modes: { listen: true, speakApproved: true },
    maxSessionMinutes: 30,
    maxDayMinutes: 60,
    costCap: { providerMinutes: 120 },
    topic: "Weekly community call",
    forbiddenTerms: ["secret-project"],
    expires: new Date(f.now + 7 * 86_400_000).toISOString(),
    ...extra,
  });
  const propose = async (extra: Record<string, unknown> = {}, token?: string) => {
    const response = await f.agent("POST", `${A}/${channel.id}/live-grants`, { key: key("propose"), payload: proposal(extra), ...(token ? { token } : {}) });
    return response;
  };
  const proposed = async (extra: Record<string, unknown> = {}) => {
    const response = await propose(extra);
    expect(response.statusCode, response.body).toBe(201);
    return response.json().grant as { id: string; digest: string; canonical: string; status: string; approvalText: string; summary: Record<string, unknown> };
  };
  const approveUi = (grantId: string, digest: string) => strict("POST", `${O}/grants/${grantId}/approve`, { digest });
  const active = async (extra: Record<string, unknown> = {}) => {
    const grant = await proposed(extra);
    const approved = await approveUi(grant.id, grant.digest);
    expect(approved.statusCode, approved.body).toBe(200);
    return approved.json().grant as typeof grant;
  };
  const approveEvent = (digest: string, input: { channel?: string; secret?: string; content?: string; createdAt?: number } = {}) =>
    signTestEvent(input.secret ?? OWNER_SECRET, {
      kind: 9,
      created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [["h", input.channel ?? group]],
      content: input.content ?? `approve grant ${digest.slice(0, 32)}`,
    });
  const resolve = (grantId: string, proof: Record<string, unknown>) =>
    f.agent("POST", `${A}/live-grants/${grantId}/resolve`, { key: key("resolve"), payload: { approvalId: grantId, proof } });
  const command = (content: string, channelId: string, secret = OWNER_SECRET, createdAt = nextCommandAt()) =>
    f.agent("POST", `${A}/live-grants/commands`, { payload: { event: signTestEvent(secret, { kind: 9, created_at: createdAt, tags: [["h", channelId]], content }) } });
  /** A huddle of the channel: the audio room, the creator-signed 48100 link in the parent, and its Buzz chat. */
  const huddle = (parent = group, startedBy = CREATOR_SECRET) => {
    const huddleId = randomUUID();
    huddleRelay.addChannel(huddleId, { parentId: parent, parentMembers: [AGENT_KEY] });
    relay.createGroup({ id: huddleId, name: "huddle", members: [AGENT_KEY] });
    // The huddle channel's creator signs its 9007 create event and the 48100 link in the parent.
    relay.inject(CREATOR_SECRET, { kind: 9007, tags: [["h", huddleId]], content: "" });
    relay.inject(startedBy, { kind: 48100, tags: [["h", parent]], content: JSON.stringify({ ephemeral_channel_id: huddleId }) });
    return huddleId;
  };
  /** A second launch session of the same pinned owner (another browser tab or device). */
  const otherOwnerSession = async () => {
    const again = await f.app.inject({
      method: "POST",
      url: "/auth/launch",
      headers: { origin: PORTAL, "content-type": "application/x-www-form-urlencoded" },
      payload: `ticket=${String(++ticket).padStart(6, "0")}${"m".repeat(37)}`,
    });
    const otherCookie = String(again.headers["set-cookie"]).split(";", 1)[0]!;
    const otherCsrf = (await f.app.inject({ method: "GET", url: "/api/marketplace/auth/session", headers: { cookie: otherCookie } })).json().session.csrfToken as string;
    return { origin: BROWSER, cookie: otherCookie, "x-csrf-token": otherCsrf };
  };
  const join = (grantId: string, huddleId: string, modes: Record<string, true> = { listen: true }, token?: string) =>
    f.agent("POST", `${A}/${channel.id}/live/sessions`, { key: key("join"), payload: { grantId, huddleId, modes }, ...(token ? { token } : {}) });
  const joined = async (grantId: string, modes: Record<string, true> = { listen: true }) => {
    const huddleId = huddle();
    const response = await join(grantId, huddleId, modes);
    expect(response.statusCode, response.body).toBe(201);
    return { huddleId, sessionId: response.json().session.sessionId as string };
  };
  const sessionRow = (sessionId: string) => f.store.channels.live.getSession(TENANT, sessionId)!;
  /** The owner's consent decision through the strict-gated narrow route, then approval of the new digest. */
  const ownerConsent = async (grantId: string, consent: { disclosureNotice: boolean; perParticipantConsent: boolean }) => {
    const record = f.store.channels.live.getGrant(TENANT, grantId)!;
    const g = JSON.parse(record.canonical) as Record<string, any>;
    const terms = { modes: g.scope.modes, maxSessionMinutes: g.scope.maxSessionMinutes, maxDayMinutes: g.scope.maxDayMinutes, costCap: g.scope.costCap, topic: g.scope.topic, forbiddenTerms: g.scope.forbiddenTerms, consent, caps: g.caps, expires: g.expires };
    const narrowed = await strict("POST", `${O}/grants/${grantId}/narrow`, { terms });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const approved = await approveUi(grantId, narrowed.json().grant.digest);
    expect(approved.statusCode, approved.body).toBe(200);
    return approved.json().grant as { id: string; digest: string; canonical: string; summary: Record<string, any> };
  };
  const audit = () => f.store.listAudit({ workspaceSlug: TENANT, limit: 1000 }) as Array<{ event_type: string; actor_id: string | null; metadata: string }>;
  return { f, relay, huddleRelay, signer, speech, group, channel, strict, strictHeaders, otherOwnerSession, ownerConsent, propose, proposed, approveUi, active, approveEvent, resolve, command, huddle, join, joined, sessionRow, audit, proposal };
}

/** Virtual peer speech: speech frames at -20 dBov carrying a marker, then DTX silence. */
function speakAsPeer(peer: { send: (frame: Uint8Array) => void }, marker: Uint8Array, start: number, speech = 20, silence = 15) {
  for (let index = 0; index < speech + silence; index += 1) {
    const seq = start + index;
    const silent = index >= speech;
    peer.send(encodeFrame({ seq, ts: seq * 960, dBov: silent ? -127 : -20, flags: silent ? HUDDLE_FLAG_DTX : 0 }, silent ? Uint8Array.from([0xf8, 0xff, 0xfe]) : Uint8Array.from([0xf8, seq & 0xff, ...marker, 0x11])));
  }
}

async function filesContaining(root: string, marker: Uint8Array): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) hits.push(...(await filesContaining(full, marker)));
    else if (entry.isFile() && (await stat(full)).size < 64 * 1024 * 1024 && (await readFile(full)).indexOf(marker) !== -1) hits.push(full);
  }
  return hits;
}

describe("live-session grants: proposal and the canonical grant", () => {
  it("builds a contract alpha.8 grant with the consent block (disclosure on by default) and the digest of its canonical JSON", async () => {
    const t = await setup();
    const grant = await t.proposed();
    expect(grant.status).toBe("proposed");
    const parsed = JSON.parse(grant.canonical) as Record<string, any>;
    expect(parsed.scope).toMatchObject({ kind: "live-session", target: { channelId: t.group }, consent: { disclosureNotice: true, perParticipantConsent: false }, modes: { listen: true, speakApproved: true } });
    expect(parsed.id).toMatch(/^live-[0-9a-f]{16}$/u);
    expect(parsed.description).toBe("Live huddle session for agent agent-1 in channel buzz-live");
    expect(canonicalGrant(parsed)).toBe(grant.canonical);
    expect(grantDigest(parsed)).toBe(grant.digest);
    expect(grant.approvalText).toBe(`approve grant ${grant.digest.slice(0, 32)}`);
    // The consent block is required by the contract: a grant without it is refused.
    const { consent: _consent, ...withoutConsent } = parsed.scope;
    expect(parseGrant({ ...parsed, scope: withoutConsent }).ok).toBe(false);
    // The agent can never ask for weaker consent than the defaults (review M1).
    const agentQuiet = await t.propose({ consent: { disclosureNotice: false, perParticipantConsent: false } });
    expect(agentQuiet.statusCode).toBe(422);
    expect(agentQuiet.json()).toMatchObject({ error: "live_consent_weaker_than_default", fields: ["consent.disclosureNotice"] });
    // false/false is the OWNER's decision (strict-gated narrow), approvable, and visible in the digest.
    const quiet = await t.ownerConsent(grant.id, { disclosureNotice: false, perParticipantConsent: false });
    expect(JSON.parse(quiet.canonical).scope.consent).toEqual({ disclosureNotice: false, perParticipantConsent: false });
    expect(quiet.digest).not.toBe(grant.digest);
    expect(quiet.summary.consent).toEqual({ disclosureNotice: false, perParticipantConsent: false });
  });

  it("refuses invalid proposals: over the contract limits, past 30 days, no outward consent, unknown fields", async () => {
    const t = await setup();
    expect((await t.propose({ maxSessionMinutes: 121 })).statusCode).toBe(400);
    const far = await t.propose({ expires: new Date(t.f.now + 40 * 86_400_000).toISOString() });
    expect(far.statusCode).toBe(422);
    expect(far.json().error).toBe("live_grant_expires_too_far");
    const hidden = await t.propose({ topic: "call​now" });
    expect(hidden.statusCode).toBe(422);
    expect(hidden.json().error).toBe("live_grant_invalid");
    expect((await t.propose({ experts: ["x"] })).statusCode).toBe(400);
    const readOnly = await t.propose({}, GRANT_B);
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().error).toBe("channel_outward_consent_required");
  });
});

describe("live-session grants: owner approval paths", () => {
  it("Marketplace UI: only the pinned owner's launch session, only the exact digest shown", async () => {
    const t = await setup();
    const grant = await t.proposed();
    // A plain operator session (test bypass) is not the strict owner gate.
    const plain = await t.f.owner("POST", `${O}/grants/${grant.id}/approve`, { digest: grant.digest });
    expect(plain.statusCode).toBe(403);
    const wrong = await t.approveUi(grant.id, "0".repeat(64));
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error).toBe("live_grant_digest_mismatch");
    const ok = await t.approveUi(grant.id, grant.digest);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().grant).toMatchObject({ status: "active", approvalSource: "marketplace-ui", digest: grant.digest });
    expect((await t.approveUi(grant.id, grant.digest)).json().error).toBe("live_grant_not_pending");
  });

  it("Buzz: `approve grant <32 hex>` from the pinned owner key, in the grant's own channel (from our record, never the request)", async () => {
    const t = await setup();
    const grant = await t.proposed();
    const other = randomUUID();
    // Signed and forwarded in another conversation: refused (the expected channel is ours).
    const elsewhere = await t.resolve(grant.id, { proof: "nostr", event: t.approveEvent(grant.digest, { channel: other }), channel: other });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().reason).toBe("wrong_channel");
    // Forwarded as if from our channel, but signed for another one: refused.
    const mismatch = await t.resolve(grant.id, { proof: "nostr", event: t.approveEvent(grant.digest, { channel: other }), channel: t.group });
    expect(mismatch.statusCode).toBe(403);
    // Not the owner.
    const stranger = await t.resolve(grant.id, { proof: "nostr", event: t.approveEvent(grant.digest, { secret: STRANGER_SECRET }), channel: t.group });
    expect(stranger.statusCode).toBe(403);
    // A post approval (`approve <hex>`, no `grant` keyword) never approves a grant.
    const postStyle = await t.resolve(grant.id, { proof: "nostr", event: t.approveEvent(grant.digest, { content: `approve ${grant.digest.slice(0, 32)}` }), channel: t.group });
    expect(postStyle.statusCode).toBe(403);
    // A shorter code is refused by the contract.
    const short = await t.resolve(grant.id, { proof: "nostr", event: t.approveEvent(grant.digest, { content: `approve grant ${grant.digest.slice(0, 31)}` }), channel: t.group });
    expect(short.statusCode).toBe(403);
    // Another grant's digest.
    const second = await t.proposed({ topic: "Another call" });
    const wrongDigest = await t.resolve(grant.id, { proof: "nostr", event: t.approveEvent(second.digest), channel: t.group });
    expect(wrongDigest.statusCode).toBe(409);
    expect(wrongDigest.json().error).toBe("live_grant_digest_mismatch");
    // Ambiguity guard: another open grant sharing the 32-hex prefix makes a Buzz code refused (nothing burned).
    const twin = t.f.store.channels.live.createGrant({
      id: "live-ffffffffffffffff",
      workspaceSlug: TENANT,
      channelId: t.channel.id,
      agentId: "agent-2",
      consentId: "x",
      approvalChannel: t.group,
      canonical: "{}",
      digest: `${grant.digest.slice(0, 32)}${"f".repeat(32)}`,
      now: new Date(),
    });
    const ambiguousEvent = t.approveEvent(grant.digest);
    const ambiguous = await t.resolve(grant.id, { proof: "nostr", event: ambiguousEvent, channel: t.group });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().error).toBe("live_grant_approval_ambiguous");
    expect(t.f.store.channels.isApprovalProofUsed(`nostr:${ambiguousEvent.id}`)).toBe(false);
    t.f.store.channels.live.updateGrant(TENANT, twin.id, { revision: twin.revision }, { status: "declined" }, new Date());
    // None of the refusals burned anything; the right proof works once.
    const event = t.approveEvent(grant.digest);
    const ok = await t.resolve(grant.id, { proof: "nostr", event, channel: t.group });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().grant).toMatchObject({ status: "active", approvalSource: "nostr" });
    expect(t.f.store.channels.isApprovalProofUsed(`nostr:${event.id}`)).toBe(true);
    // Replay: the owner narrows the consent off and back on (same canonical, same digest); the used proof is refused.
    const terms = (disclosureNotice: boolean) => ({ terms: { ...t.proposal(), forbiddenTerms: ["secret-project"], consent: { disclosureNotice, perParticipantConsent: false }, caps: { perDay: 10 } } });
    const off = await t.strict("POST", `${O}/grants/${grant.id}/narrow`, terms(false));
    expect(off.statusCode, off.body).toBe(200);
    const on = await t.strict("POST", `${O}/grants/${grant.id}/narrow`, terms(true));
    expect(on.json().grant.digest).toBe(grant.digest);
    const replay = await t.resolve(grant.id, { proof: "nostr", event, channel: t.group });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe("live_grant_proof_reused");
    // Another agent cannot forward a proof for agent-1's grant.
    const foreign = await t.f.agent("POST", `${A}/live-grants/${grant.id}/resolve`, { key: key("r"), token: GRANT_B, payload: { approvalId: grant.id, proof: { proof: "nostr", event: t.approveEvent(grant.digest), channel: t.group } } });
    expect(foreign.statusCode).toBe(404);
  });

  it("TBD: a Portal owner assertion with op tealbrick:standing-grant, the grant id and digest, the pinned owner", async () => {
    const t = await setup();
    const grant = await t.proposed();
    const claims = (extra: Record<string, unknown> = {}) => ({
      iss: PORTAL,
      sub: "tealbrick-user:owner-1",
      aud: "tealbrick-app:instance-1",
      dep: "deployment-1",
      approvalId: grant.id,
      digest: grant.digest,
      decision: "approve" as const,
      op: "tealbrick:standing-grant",
      agent: "tealbrick-agent:agent-1",
      ...extra,
    });
    const wrongOp = await t.resolve(grant.id, { proof: "portal", token: ownerAssertion(t.signer, claims({ op: "marketplace.channels.post" })) });
    expect(wrongOp.statusCode).toBe(403);
    const wrongOwner = await t.resolve(grant.id, { proof: "portal", token: ownerAssertion(t.signer, claims({ sub: "tealbrick-user:someone-else" })) });
    expect(wrongOwner.statusCode).toBe(403);
    const wrongDigest = await t.resolve(grant.id, { proof: "portal", token: ownerAssertion(t.signer, claims({ digest: "1".repeat(64) })) });
    expect(wrongDigest.statusCode).toBe(409);
    expect(wrongDigest.json().error).toBe("live_grant_digest_mismatch");
    const otherGrant = await t.resolve(grant.id, { proof: "portal", token: ownerAssertion(t.signer, claims({ approvalId: "live-0000000000000000" })) });
    expect(otherGrant.statusCode).toBe(403);
    const ok = await t.resolve(grant.id, { proof: "portal", token: ownerAssertion(t.signer, claims()) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().grant).toMatchObject({ status: "active", approvalSource: "portal" });
  });

  it("narrowing: the agent only narrows (new digest, back to proposed); widening is refused; the owner may set consent either way", async () => {
    const t = await setup();
    const grant = await t.active();
    const base = { ...t.proposal(), forbiddenTerms: ["secret-project"], consent: { disclosureNotice: true, perParticipantConsent: false }, caps: { perDay: 10 } };
    const narrow = (terms: Record<string, unknown>) => t.f.agent("POST", `${A}/live-grants/${grant.id}/narrow`, { key: key("narrow"), payload: { ...base, ...terms } });
    const wider = await narrow({ maxSessionMinutes: 60, modes: { listen: true, speakApproved: true, speakLive: true }, consent: { disclosureNotice: false, perParticipantConsent: false }, forbiddenTerms: [] });
    expect(wider.statusCode).toBe(422);
    expect(wider.json().fields).toEqual(expect.arrayContaining(["maxSessionMinutes", "modes.speakLive", "consent.disclosureNotice", "forbiddenTerms"]));
    // The consent block is required on a narrowing.
    const { consent: _c, ...noConsent } = base;
    expect((await t.f.agent("POST", `${A}/live-grants/${grant.id}/narrow`, { key: key("narrow"), payload: noConsent })).statusCode).toBe(400);
    const narrower = await narrow({ maxSessionMinutes: 10, forbiddenTerms: ["secret-project", "salary"] });
    expect(narrower.statusCode, narrower.body).toBe(200);
    expect(narrower.json().grant.status).toBe("proposed");
    expect(narrower.json().grant.digest).not.toBe(grant.digest);
    // The owner turns the disclosure notice off: the owner's decision, in the digest, approved separately.
    const owner = await t.strict("POST", `${O}/grants/${grant.id}/narrow`, { terms: { ...base, maxSessionMinutes: 10, forbiddenTerms: ["secret-project", "salary"], consent: { disclosureNotice: false, perParticipantConsent: true } } });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().grant.summary.consent).toEqual({ disclosureNotice: false, perParticipantConsent: true });
    // Even the owner cannot widen anything else.
    const ownerWider = await t.strict("POST", `${O}/grants/${grant.id}/narrow`, { terms: { ...base, maxDayMinutes: 600 } });
    expect(ownerWider.statusCode).toBe(422);
  });
});

describe("live-session grants: defence in depth and owner key changes", () => {
  const db = (t: Setup) => (t.f.store.channels.live as unknown as { db: DatabaseSync }).db;

  it("a direct database edit of the record or the grant fails closed (unusable, audited once)", async () => {
    const t = await setup();
    t.f.consentFor("agent-2", t.channel);
    const grant = await t.active();
    const { sessionId } = await t.joined(grant.id);
    // Reassign agent-1's approved grant to agent-2 in the database: the description still names agent-1.
    db(t).prepare("UPDATE channel_live_grant SET agent_id = 'agent-2' WHERE id = ?").run(grant.id);
    await waitFor(() => t.sessionRow(sessionId).status === "left", 5000, "left");
    expect(t.sessionRow(sessionId).endReason).toBe("grant_integrity_failed");
    const stolen = await t.join(grant.id, t.huddle(), { listen: true }, GRANT_B);
    expect(stolen.json()).toMatchObject({ error: "live_grant_not_active", reason: "grant_integrity_failed" });
    await t.join(grant.id, t.huddle(), { listen: true }, GRANT_B);
    const audits = t.audit().filter((entry) => entry.event_type === "marketplace.channels.live_grant.integrity_failed");
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.metadata)).toMatchObject({ grantId: grant.id, field: "description" });

    // A consistent rewrite (canonical + digest recomputed for another agent) still fails the template check.
    const other = await t.active({ topic: "Second call" });
    const parsed = JSON.parse(other.canonical) as Record<string, any>;
    const forged = { ...parsed, description: "Live huddle session for agent agent-2 in channel buzz-live" };
    db(t).prepare("UPDATE channel_live_grant SET canonical = ?, digest = ?, approved_digest = ? WHERE id = ?").run(canonicalGrant(forged), grantDigest(forged), grantDigest(forged), other.id);
    expect((await t.join(other.id, t.huddle())).json()).toMatchObject({ error: "live_grant_not_active", reason: "grant_integrity_failed" });

    // A pending grant whose approval channel was edited cannot be approved.
    const pending = await t.proposed({ topic: "Third call" });
    db(t).prepare("UPDATE channel_live_grant SET approval_channel = ? WHERE id = ?").run(randomUUID(), pending.id);
    const refused = await t.approveUi(pending.id, pending.digest);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("live_grant_corrupt");
  });

  it("refuses Buzz proofs from an old owner key and proofs signed before the current key was set (key_changed)", async () => {
    const t = await setup();
    const grant = await t.proposed();
    // The owner sets a new Buzz key after the proposal.
    const NEW_SECRET = "0000000000000000000000000000000000000000000000000000000000000005";
    const NEW_KEY = publicKeyOf(NEW_SECRET)!;
    const setAt = Date.now();
    t.f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: NEW_KEY, fingerprint: ownerKeyFingerprint(NEW_KEY), actor: "operator-1", now: new Date(setAt) });
    const oldKey = t.approveEvent(grant.digest);
    const byOld = await t.resolve(grant.id, { proof: "nostr", event: oldKey, channel: t.group });
    expect(byOld.statusCode).toBe(403);
    const early = t.approveEvent(grant.digest, { secret: NEW_SECRET, createdAt: Math.floor(setAt / 1000) - 120 });
    const beforeKey = await t.resolve(grant.id, { proof: "nostr", event: early, channel: t.group });
    expect(beforeKey.statusCode).toBe(403);
    expect(beforeKey.json()).toMatchObject({ error: "live_grant_proof_invalid", reason: "key_changed" });
    expect(t.f.store.channels.isApprovalProofUsed(`nostr:${early.id}`)).toBe(false);
    expect(t.f.store.channels.isApprovalProofUsed(`nostr:${oldKey.id}`)).toBe(false);
    const ok = await t.resolve(grant.id, { proof: "nostr", event: t.approveEvent(grant.digest, { secret: NEW_SECRET, createdAt: Math.floor(setAt / 1000) + 1 }), channel: t.group });
    expect(ok.statusCode, ok.body).toBe(200);

    // After approval the key changes again: commands from the old key, or signed before the change, are refused.
    const NEWER_SECRET = "0000000000000000000000000000000000000000000000000000000000000006";
    const NEWER_KEY = publicKeyOf(NEWER_SECRET)!;
    const changedAt = Date.now() + 2000;
    t.f.store.channels.setOwnerKey({ workspaceSlug: TENANT, pubkey: NEWER_KEY, fingerprint: ownerKeyFingerprint(NEWER_KEY), actor: "operator-1", now: new Date(changedAt) });
    const signed = (secret: string, createdAt: number) =>
      t.f.agent("POST", `${A}/live-grants/commands`, { payload: { event: signTestEvent(secret, { kind: 9, created_at: createdAt, tags: [["h", t.group]], content: `revoke ${grant.id}` }) } });
    expect((await signed(NEW_SECRET, Math.floor(changedAt / 1000) + 1)).statusCode).toBe(403);
    const stale = await signed(NEWER_SECRET, Math.floor(changedAt / 1000) - 60);
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: "live_command_invalid", reason: "key_changed" });
    expect(t.f.store.channels.live.getGrant(TENANT, grant.id)!.status).toBe("active");
    const revoked = await signed(NEWER_SECRET, Math.floor(changedAt / 1000) + 1);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(t.f.store.channels.live.getGrant(TENANT, grant.id)!.status).toBe("revoked");
  });
});

describe("live sessions: join, disclosure, transcripts, receipts", () => {
  it("refuses a join without an active covering grant, with a mode the grant lacks, without outward consent, or another agent's grant", async () => {
    const t = await setup();
    const huddleId = t.huddle();
    expect((await t.join("live-0000000000000000", huddleId)).statusCode).toBe(404);
    const pending = await t.proposed();
    const notActive = await t.join(pending.id, huddleId);
    expect(notActive.statusCode).toBe(409);
    expect(notActive.json().error).toBe("live_grant_not_active");
    const grant = await t.active();
    const mode = await t.join(grant.id, huddleId, { speakLive: true });
    expect(mode.statusCode).toBe(403);
    expect(mode.json().error).toBe("live_mode_not_granted");
    const readOnly = await t.join(grant.id, huddleId, { listen: true }, GRANT_B);
    expect(readOnly.statusCode).toBe(403);
    expect(t.huddleRelay.upgrades).toHaveLength(0);
  });

  it("posts the disclosure notice first, joins, frames other participants' words as untrusted, flags forbidden terms, keeps no raw audio", async () => {
    const t = await setup({ speechReply: (index) => (index === 0 ? "hello everyone, about the secret-project" : "second line") });
    const grant = await t.active();
    const { huddleId, sessionId } = await t.joined(grant.id);
    const notices = t.relay.eventsOfKind(9).filter((event) => event.pubkey === AGENT_KEY && event.tags.some((tag) => tag[0] === "h" && tag[1] === t.group));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain("Notice from Marketplace: an AI agent (agent-1) is joining this huddle");
    expect(t.sessionRow(sessionId)).toMatchObject({ status: "joined", disclosureEventId: notices[0]!.id });
    const peer = t.huddleRelay.addVirtualPeer(huddleId, PEER);
    const marker = randomBytes(16);
    speakAsPeer(peer, marker, 100);
    await waitFor(() => t.f.store.channels.live.listTranscript(TENANT, sessionId).length >= 1, 5000, "transcript");
    const transcript = await t.f.agent("GET", `${A}/${t.channel.id}/live/sessions/${sessionId}/transcript`);
    expect(transcript.statusCode, transcript.body).toBe(200);
    const line = transcript.json().lines[0];
    expect(line).toMatchObject({ kind: "heard", framing: "untrusted-external-speech", speaker: { pubkey: PEER }, text: "hello everyone, about the secret-project", flaggedTerms: ["secret-project"] });
    // Another agent cannot read it.
    expect((await t.f.agent("GET", `${A}/${t.channel.id}/live/sessions/${sessionId}/transcript`, { token: GRANT_B })).statusCode).toBe(404);
    const left = await t.f.agent("POST", `${A}/${t.channel.id}/live/sessions/${sessionId}/leave`);
    expect(left.statusCode, left.body).toBe(200);
    expect(t.sessionRow(sessionId)).toMatchObject({ status: "left", endReason: "left_by_agent" });
    // No raw audio anywhere in the data directory (database included); the audit has the receipt digest only.
    expect(await filesContaining(t.f.root, marker)).toEqual([]);
    const ended = t.audit().find((entry) => entry.event_type === "marketplace.channels.live_session.ended")!;
    expect(JSON.parse(ended.metadata)).toMatchObject({ sessionId, transcriptLines: 1, transcriptSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(ended.metadata).not.toContain("hello everyone");
  });

  it("joins without a notice when the owner approved disclosureNotice false (visible in the digest)", async () => {
    const t = await setup();
    const grant = await t.ownerConsent((await t.active()).id, { disclosureNotice: false, perParticipantConsent: false });
    await t.joined(grant.id);
    expect(t.relay.eventsOfKind(9).filter((event) => event.pubkey === AGENT_KEY)).toHaveLength(0);
  });

  it("refuses listening under a per-participant consent grant (no gate yet)", async () => {
    const t = await setup();
    const grant = await t.active({ consent: { perParticipantConsent: true } });
    const refused = await t.join(grant.id, t.huddle());
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("live_participant_consent_unavailable");
  });
});

describe("live sessions: stop within 5 s and caps", () => {
  it("owner revoke in the UI makes the agent leave within 5 s", async () => {
    const t = await setup();
    const grant = await t.active();
    const { sessionId } = await t.joined(grant.id);
    const started = Date.now();
    const revoked = await t.f.owner("POST", `${O}/grants/${grant.id}/revoke`, {});
    expect(revoked.statusCode, revoked.body).toBe(200);
    await waitFor(() => t.sessionRow(sessionId).status === "left", 5000, "left");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.sessionRow(sessionId).endReason).toBe("revoked_by_owner");
    expect(t.huddleRelay.conns.every((conn) => conn.closed)).toBe(true);
  });

  it("a revoke written by another instance (only the record changes) is caught by the tick within 5 s", async () => {
    const t = await setup();
    const grant = await t.active();
    const { sessionId } = await t.joined(grant.id);
    const record = t.f.store.channels.live.getGrant(TENANT, grant.id)!;
    const started = Date.now();
    t.f.store.channels.live.updateGrant(TENANT, grant.id, { revision: record.revision }, { status: "revoked" }, new Date());
    await waitFor(() => t.sessionRow(sessionId).status === "left", 5000, "left");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(t.sessionRow(sessionId).endReason).toBe("grant_revoked");
  });

  it("signed owner commands: `pause grants` in the command channel stops sessions; wrong channel and replay are refused; `revoke <id>` in the grant channel", async () => {
    const t = await setup();
    const commandChannel = randomUUID();
    expect((await t.command("pause grants", commandChannel)).json().error).toBe("live_command_channel_unset");
    const set = await t.strict("PUT", `${O}/control`, { commandChannel });
    expect(set.statusCode, set.body).toBe(200);
    const grant = await t.active();
    const { sessionId } = await t.joined(grant.id);
    expect((await t.command("pause grants", randomUUID())).statusCode).toBe(403);
    expect((await t.command("pause grants", commandChannel, STRANGER_SECRET)).statusCode).toBe(403);
    const event = signTestEvent(OWNER_SECRET, { kind: 9, created_at: nextCommandAt(), tags: [["h", commandChannel]], content: "pause grants" });
    const started = Date.now();
    const paused = await t.f.agent("POST", `${A}/live-grants/commands`, { payload: { event } });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ command: "pause", paused: true });
    await waitFor(() => t.sessionRow(sessionId).status === "left", 5000, "left");
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await t.join(grant.id, t.huddle())).json()).toMatchObject({ error: "live_grant_not_active", reason: "grants_paused" });
    const replay = await t.f.agent("POST", `${A}/live-grants/commands`, { payload: { event } });
    expect(replay.statusCode).toBe(409);
    const resumed = await t.command("resume grants", commandChannel);
    expect(resumed.json(), resumed.body).toMatchObject({ command: "resume", paused: false });
    // `revoke <id>` must come from the grant's own channel.
    expect((await t.command(`revoke ${grant.id}`, commandChannel)).statusCode).toBe(403);
    const revoked = await t.command(`revoke ${grant.id}`, t.group);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(t.f.store.channels.live.getGrant(TENANT, grant.id)!.status).toBe("revoked");
  });

  it("ends a session row left behind by a crashed instance (no heartbeat) so the grant can join again", async () => {
    const t = await setup();
    const grant = await t.active();
    const orphan = t.f.store.channels.live.startSession({ workspaceSlug: TENANT, grantId: grant.id, grantDigest: grant.digest, channelId: t.channel.id, agentId: "agent-1", huddleId: randomUUID(), modes: { listen: true }, instanceId: "marketplace-crashed", now: new Date(t.f.now) });
    expect(orphan.ok).toBe(true);
    expect((await t.join(grant.id, t.huddle())).json().error).toBe("live_session_active");
    t.f.advance(21_000);
    const { sessionId } = await t.joined(grant.id);
    expect(t.sessionRow(sessionId).status).toBe("joined");
    expect(t.sessionRow((orphan as { session: { id: string } }).session.id)).toMatchObject({ status: "failed", endReason: "stale_session" });
  });

  it("stops at the session limit, refuses joins at the day limit, and stops at the provider-minute cost cap", async () => {
    const t = await setup();
    const grant = await t.active({ maxSessionMinutes: 1, maxDayMinutes: 2, costCap: { providerMinutes: 5 } });
    const first = await t.joined(grant.id);
    t.f.advance(61_000);
    await waitFor(() => t.sessionRow(first.sessionId).status === "left", 5000, "session limit");
    expect(t.sessionRow(first.sessionId).endReason).toBe("max_session_minutes");
    const second = await t.joined(grant.id);
    t.f.advance(61_000);
    await waitFor(() => t.sessionRow(second.sessionId).status === "left", 5000, "session limit 2");
    // Two minutes used in the rolling day: the next join is refused before any connection.
    const upgrades = t.huddleRelay.upgrades.length;
    const day = await t.join(grant.id, t.huddle());
    expect(day.statusCode).toBe(429);
    expect(day.json()).toMatchObject({ error: "live_cap_reached", cap: "maxDayMinutes" });
    expect(t.huddleRelay.upgrades).toHaveLength(upgrades);

    // A wider proposal needs the current grant out of the way first (review M1).
    expect((await t.f.owner("POST", `${O}/grants/${grant.id}/revoke`, {})).statusCode).toBe(200);
    const costly = await t.active({ topic: "Cost test", costCap: { providerMinutes: 1 } });
    const third = await t.joined(costly.id);
    t.f.store.channels.live.addProviderSeconds(TENANT, costly.id, 60);
    await waitFor(() => t.sessionRow(third.sessionId).status === "left", 5000, "cost cap");
    expect(t.sessionRow(third.sessionId).endReason).toBe("cost_cap_reached");
    expect((await t.join(costly.id, t.huddle())).json()).toMatchObject({ error: "live_cap_reached", cap: "costCap.providerMinutes" });
  });
});

describe("live sessions: speaking", () => {
  it("speak-live is refused while text-to-speech in Ogg/Opus is unavailable", async () => {
    const t = await setup();
    const grant = await t.active({ modes: { speakLive: true } });
    const refused = await t.join(grant.id, t.huddle(), { speakLive: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("live_tts_unavailable");
  });

  it("speak-live refuses forbidden terms before any provider call, and speaks clean text", async () => {
    const clip = writeOggOpus(Array.from({ length: 5 }, (_unused, index) => opusPacket(index + 1)));
    const t = await setup({ tts: true, synthesize: () => Uint8Array.from(clip) });
    const grant = await t.active({ modes: { speakLive: true } });
    const { sessionId } = await t.joined(grant.id, { speakLive: true });
    const speak = (text: string) => t.f.agent("POST", `${A}/${t.channel.id}/live/sessions/${sessionId}/speak`, { key: key("speak"), payload: { text } });
    const forbidden = await speak("Let me tell you about the SECRET-PROJECT");
    expect(forbidden.statusCode).toBe(422);
    expect(forbidden.json().error).toBe("live_forbidden_term");
    expect(t.speech.synthesizeCalls).toHaveLength(0);
    const ok = await speak("Hello from the agent");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().spoken).toMatchObject({ kind: "text", aborted: false });
    expect(t.speech.synthesizeCalls).toEqual([{ text: "Hello from the agent" }]);
    expect(t.f.store.channels.live.listTranscript(TENANT, sessionId).map((line) => [line.kind, line.text])).toEqual([["said", "Hello from the agent"]]);
  });

  it("speak-approved: the owner plays the exact held clip, approves a digest bound to grant digest + session + clip, and it plays once (H1)", async () => {
    const t = await setup();
    const grant = await t.active({ modes: { speakApproved: true }, forbiddenTerms: ["secret-project"] });
    const first = await t.joined(grant.id, { speakApproved: true });
    const clip = Buffer.from(writeOggOpus(Array.from({ length: 5 }, (_unused, index) => opusPacket(index + 1))));
    const uploaded = await t.f.app.inject({
      method: "POST",
      url: `${A}/attachments?name=clip.ogg`,
      headers: { authorization: `Bearer tbag_${"a".repeat(43)}`, "idempotency-key": key("upload"), "content-type": "audio/ogg" },
      payload: clip,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const attachmentId = uploaded.json().attachmentId as string;
    const sha = uploaded.json().sha256 as string;
    const speak = (sessionId: string, transcript = "Welcome to the call") =>
      t.f.agent("POST", `${A}/${t.channel.id}/live/sessions/${sessionId}/speak`, { key: key("speak"), payload: { attachmentId, transcript } });
    // The stated transcript is checked against the forbidden terms (normalized) before anything is held.
    expect((await speak(first.sessionId, "about the ｓｅｃｒｅｔ project")).json().error).toBe("live_forbidden_term");
    const held = await speak(first.sessionId);
    expect(held.statusCode, held.body).toBe(202);
    // No Buzz approval code for a clip: it is approved only in Marketplace after playback.
    expect(held.json().approvalText).toBe(LIVE_CLIP_APPROVAL_TEXT);
    const record = t.f.store.channels.live.getGrant(TENANT, grant.id)!;
    expect(held.json().digest).toBe(liveClipDigest(record.digest, first.sessionId, sha));
    expect((await speak(first.sessionId)).json().approvalId).toBe(held.json().approvalId);
    // Owner playback: the exact stored bytes, strict owner gate only.
    const approvalId = held.json().approvalId as string;
    const approveUrl = `/api/marketplace/company-box/approvals/${approvalId}/approve`;
    const strictApprove = async (headers: Record<string, string>, playedSha256: string | undefined = sha) =>
      t.f.app.inject({ method: "POST", url: approveUrl, headers, payload: playedSha256 ? { playedSha256 } : {} });
    // Re-review MUST: no approval without the strict owner gate, and none before this owner session played the clip.
    expect((await t.f.owner("POST", approveUrl, { playedSha256: sha })).statusCode).toBe(403);
    const unheard = await strictApprove(await t.strictHeaders());
    expect(unheard.statusCode).toBe(409);
    expect(unheard.json().error).toBe("live_clip_requires_playback");
    // A Buzz reply or a TBD assertion cannot prove listening.
    const buzz = await t.f.agent("POST", `/api/marketplace/v1/agent/approvals/${approvalId}/resolve`, { key: `resolve.${approvalId}.approve`, payload: { approvalId, proof: { proof: "nostr", event: t.approveEvent(held.json().digest, { content: `approve ${String(held.json().digest).slice(0, 32)}` }), channel: t.group } } });
    expect(buzz.statusCode).toBe(409);
    expect(buzz.json().error).toBe("live_clip_requires_playback");
    expect((await t.f.owner("GET", `${O}/clips/${approvalId}`)).statusCode).toBe(403);
    expect((await t.f.app.inject({ method: "GET", url: `${O}/clips/${approvalId}`, headers: { ...(await t.strictHeaders()), range: "bytes=0-10" } })).statusCode).toBe(416);
    // Re-review H1c: HEAD (and any non-GET method) is 405 and records nothing; the approval stays refused.
    const playRows = () => (t.f.store.channels.live as unknown as { db: DatabaseSync }).db.prepare("SELECT COUNT(*) AS n FROM channel_live_clip_play").get() as { n: number };
    for (const method of ["HEAD", "POST", "PUT", "DELETE"] as const) {
      const other = await t.f.app.inject({ method, url: `${O}/clips/${approvalId}`, headers: await t.strictHeaders() });
      expect(other.statusCode, method).toBe(405);
    }
    expect(playRows().n).toBe(0);
    expect((await strictApprove(await t.strictHeaders())).json().error).toBe("live_clip_requires_playback");
    // Played to ANOTHER owner session: this session still has not listened.
    const other = await t.otherOwnerSession();
    expect((await t.f.app.inject({ method: "GET", url: `${O}/clips/${approvalId}`, headers: other })).statusCode).toBe(200);
    expect((await strictApprove(await t.strictHeaders())).json().error).toBe("live_clip_requires_playback");
    const played = await t.f.app.inject({ method: "GET", url: `${O}/clips/${approvalId}`, headers: await t.strictHeaders() });
    // A full GET to this session is recorded once the whole body was sent.
    await waitFor(() => playRows().n === 2, 3000, "play record");
    expect(played.statusCode).toBe(200);
    expect(played.headers["content-type"]).toBe("audio/ogg");
    expect(played.headers["content-disposition"]).toBe("inline");
    expect(played.headers["cache-control"]).toBe("no-store");
    expect(played.headers["x-content-sha256"]).toBe(sha);
    expect(Buffer.compare(played.rawPayload, clip)).toBe(0);
    const listed = await t.f.owner("GET", "/api/marketplace/company-box/approvals?state=pending");
    expect(listed.json().approvals.find((entry: { id: string }) => entry.id === approvalId).live).toMatchObject({ clipSha256: sha, sessionId: first.sessionId, transcript: "Welcome to the call", usedByAgent: false });
    // The page must report the SHA-256 of what it played.
    expect((await strictApprove(await t.strictHeaders(), "0".repeat(64))).json().error).toBe("live_clip_sha_mismatch");
    expect((await strictApprove(await t.strictHeaders(), "")).json().error).toBe("live_clip_sha_mismatch");
    const approved = await strictApprove(await t.strictHeaders());
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().approval.state).toBe("succeeded");
    const once = await speak(first.sessionId);
    expect(once.statusCode, once.body).toBe(200);
    expect(once.json().spoken).toMatchObject({ kind: "clip", sha256: sha });
    await waitFor(() => t.huddleRelay.conns.some((conn) => conn.framesIn.length >= 5), 3000, "frames");
    // Single use.
    const twice = await speak(first.sessionId);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe("live_clip_already_played");
    expect(t.f.store.channels.live.listTranscript(TENANT, first.sessionId).map((line) => [line.kind, line.text, line.clipSha256])).toEqual([["said", "Welcome to the call", sha]]);
    // A later session needs a new approval (the digest is bound to the session) ...
    await t.f.agent("POST", `${A}/${t.channel.id}/live/sessions/${first.sessionId}/leave`);
    const second = await t.joined(grant.id, { speakApproved: true });
    const again = await speak(second.sessionId);
    expect(again.statusCode).toBe(202);
    expect(again.json().approvalId).not.toBe(approvalId);
    // ... and a narrowed, re-approved grant invalidates a held clip of the old digest (its session stops).
    await t.ownerConsent(grant.id, { disclosureNotice: true, perParticipantConsent: true });
    await waitFor(() => t.sessionRow(second.sessionId).status === "left", 5000, "left");
    const againId = again.json().approvalId as string;
    expect((await t.f.app.inject({ method: "GET", url: `${O}/clips/${againId}`, headers: await t.strictHeaders() })).statusCode).toBe(200);
    const stale = await t.f.app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${againId}/approve`, headers: await t.strictHeaders(), payload: { playedSha256: sha } });
    expect(stale.json().approval).toMatchObject({ state: "failed" });
  });
});

describe("security review of PR #53", () => {
  it("H1c: a play is recorded only when the response finished with the whole body (an aborted GET records nothing)", async () => {
    const { EventEmitter } = await import("node:events");
    const fake = () => {
      const emitter = new EventEmitter() as InstanceType<typeof EventEmitter> & { write: (chunk: unknown) => boolean; end: (chunk?: unknown) => void };
      emitter.write = () => true;
      emitter.end = () => undefined;
      return emitter;
    };
    const recorded: string[] = [];
    const aborted = fake();
    recordWhenFullySent(aborted, 10, () => recorded.push("aborted"));
    aborted.write(Buffer.alloc(4));
    aborted.emit("close");
    const short = fake();
    recordWhenFullySent(short, 10, () => recorded.push("short"));
    short.end(Buffer.alloc(9));
    short.emit("finish");
    const full = fake();
    recordWhenFullySent(full, 10, () => recorded.push("full"));
    full.write(Buffer.alloc(4));
    full.end(Buffer.alloc(6));
    full.emit("close");
    full.emit("finish");
    expect(recorded).toEqual(["full"]);
  });

  it("M4: forbidden terms survive zero-width, soft hyphen, ligatures, full-width, Turkish İ, combining marks and Cyrillic lookalikes", async () => {
    const terms = ["secret-project", "confidential", "istanbul"];
    const cases = [
      // Re-review: small capitals, Cherokee lookalikes, Latin letters with strokes, Hangul fillers.
      "it is \u1d04\u1d0f\u0274\uA730\u026a\u1d05\u1d07\u0274\u1d1b\u026a\u1d00\u029f",
      "\u13dfonfidential",
      "\u13df\u13a5\u13a0 is \u13dfonfi\u13a0ential",
      "\uA7A9ecret-project",
      "secret\u3164project",
      "secret\u115Fproject",
      "secret\uFFA0project",
      "the secret\u200b-project is live", "it is confi\u00addential", "it is con\ufb01dential", "\uff53\uff45\uff43\uff52\uff45\uff54-project", "\u0130STANBUL office", "confide\u0301ntial", "c\u043enfidential", "the SECRET project"];
    for (const text of cases) expect(forbiddenTermsIn(text, terms), text).not.toEqual([]);
    expect(forbiddenTermsIn("a normal sentence", terms)).toEqual([]);
    // speak-live refuses hidden format characters outright.
    const ogg = writeOggOpus(Array.from({ length: 5 }, (_unused, index) => opusPacket(index + 1)));
    const t = await setup({ tts: true, synthesize: () => Uint8Array.from(ogg) });
    const grant = await t.active({ modes: { speakLive: true } });
    const { sessionId } = await t.joined(grant.id, { speakLive: true });
    const hidden = await t.f.agent("POST", `${A}/${t.channel.id}/live/sessions/${sessionId}/speak`, { key: key("speak"), payload: { text: "hello\u200bthere" } });
    expect(hidden.json().error).toBe("live_text_hidden_characters");
    const lookalike = await t.f.agent("POST", `${A}/${t.channel.id}/live/sessions/${sessionId}/speak`, { key: key("speak"), payload: { text: "the s\u0435cret project" } });
    expect(lookalike.json().error).toBe("live_forbidden_term");
    expect(t.speech.synthesizeCalls).toHaveLength(0);
  });

  it("M1: an agent proposal is never weaker than the defaults nor wider than its current approved grant", async () => {
    const t = await setup();
    expect((await t.propose({ consent: { disclosureNotice: false } })).json().error).toBe("live_consent_weaker_than_default");
    const grant = await t.active({ modes: { listen: true }, maxSessionMinutes: 20 });
    const wider = await t.propose({ modes: { listen: true, speakLive: true }, maxSessionMinutes: 60, expires: new Date(t.f.now + 8 * 86_400_000).toISOString() });
    expect(wider.statusCode).toBe(422);
    expect(wider.json()).toMatchObject({ error: "live_grant_wider_than_approved" });
    expect(wider.json().fields).toEqual(expect.arrayContaining(["modes.speakLive", "maxSessionMinutes", "expires"]));
    // A stricter one is fine; consent can only be made stricter by the agent.
    expect((await t.propose({ modes: { listen: true }, maxSessionMinutes: 10, expires: new Date(t.f.now + 86_400_000).toISOString(), consent: { perParticipantConsent: true } })).statusCode).toBe(201);
    void grant;
  });

  it("M2: an older withheld `resume grants` cannot undo a later pause; an older `revoke` is refused after a later change", async () => {
    const t = await setup();
    const commandChannel = randomUUID();
    expect((await t.strict("PUT", `${O}/control`, { commandChannel })).statusCode).toBe(200);
    const grant = await t.active();
    const staleResume = signTestEvent(OWNER_SECRET, { kind: 9, created_at: Math.floor(t.f.now / 1000) - 30, tags: [["h", commandChannel]], content: "resume grants" });
    const staleRevoke = signTestEvent(OWNER_SECRET, { kind: 9, created_at: Math.floor(t.f.now / 1000) - 30, tags: [["h", t.group]], content: `revoke ${grant.id}` });
    expect((await t.f.owner("PUT", `${O}/control`, { paused: true })).statusCode).toBe(200);
    const replayed = await t.f.agent("POST", `${A}/live-grants/commands`, { payload: { event: staleResume } });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json()).toMatchObject({ error: "live_command_stale" });
    expect(t.f.store.channels.live.getControl(TENANT).paused).toBe(true);
    expect((await t.join(grant.id, t.huddle())).json().reason).toBe("grants_paused");
    const revoke = await t.f.agent("POST", `${A}/live-grants/commands`, { payload: { event: staleRevoke } });
    expect(revoke.json()).toMatchObject({ error: "live_command_stale" });
  });

  it("M3: a channel grant joins only a huddle whose creator-signed 48100 link names this channel; the notice goes to the huddle too", async () => {
    const t = await setup();
    const grant = await t.active();
    // A channel the agent key can enter, with no 48100 link to the granted channel.
    const stray = randomUUID();
    t.huddleRelay.addChannel(stray, { members: [AGENT_KEY] });
    const refused = await t.join(grant.id, stray);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("live_huddle_not_in_channel");
    // A huddle of another channel.
    const elsewhere = await t.join(grant.id, t.huddle(randomUUID()));
    expect(elsewhere.json().error).toBe("live_huddle_not_in_channel");
    // Re-review: a 48100 link signed by someone other than the huddle channel's creator (its 9007 signer).
    const forged = await t.join(grant.id, t.huddle(t.group, STRANGER_SECRET));
    expect(forged.json().error).toBe("live_huddle_not_in_channel");
    expect(t.huddleRelay.upgrades).toHaveLength(0);
    const { huddleId } = await t.joined(grant.id);
    const notices = t.relay.eventsOfKind(9).filter((event) => event.pubkey === AGENT_KEY);
    expect(notices.map((event) => event.tags.find((tag) => tag[0] === "h")?.[1]).sort()).toEqual([t.group, huddleId].sort());
    // L2: a fixed server template; the agent topic on its own labelled line.
    expect(notices[0]!.content).toMatch(/^Notice from Marketplace: an AI agent \(agent-1\) is joining this huddle/u);
    expect(notices[0]!.content).toContain("\nTopic (from the agent): Weekly community call");
  });

  it("L1/L3: standing grants switched off or the consent downgraded stop live sessions; proposals need standing grants allowed", async () => {
    const t = await setup();
    const grant = await t.active();
    const first = await t.joined(grant.id);
    const policy = { standingGrants: "disabled", caps: { perDay: 20, minIntervalSeconds: 0, onePerPhase: false }, content: { files: { types: ["png"] } } };
    const changed = await t.f.owner("PATCH", `/api/marketplace/channels/${t.channel.id}`, { policy });
    expect(changed.statusCode, changed.body).toBe(200);
    await waitFor(() => t.sessionRow(first.sessionId).status === "left", 5000, "left");
    expect(t.sessionRow(first.sessionId).endReason).toBe("standing_grants_disabled");
    expect((await t.propose()).json().error).toBe("standing_grants_disabled");
    await t.f.owner("PATCH", `/api/marketplace/channels/${t.channel.id}`, { policy: { ...policy, standingGrants: "allowed" } });
    const second = await t.joined(grant.id);
    const record = t.f.store.channels.live.getGrant(TENANT, grant.id)!;
    t.f.store.revokeMarketplaceAgentConsent(record.consentId);
    await waitFor(() => t.sessionRow(second.sessionId).status === "left", 5000, "left");
    expect(t.sessionRow(second.sessionId).endReason).toBe("consent_inactive");
  });
});

describe("live sessions: capability and inert mode", () => {
  it("Buzz declares live {join, listen, speak, transcript, 120 min} and agents see it wired", async () => {
    const t = await setup();
    const view = await t.f.agent("GET", `${A}/${t.channel.id}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().channel.capabilities.live).toEqual({ join: true, listen: true, speak: true, transcript: true, maxSessionMinutes: 120 });
  });

  it("is inert without a usable Buzz identity: proposals and joins are refused, a running session leaves, nothing connects", async () => {
    const t = await setup();
    const grant = await t.active();
    const { sessionId } = await t.joined(grant.id);
    const upgrades = t.huddleRelay.upgrades.length;
    const revoked = await t.f.app.inject({ method: "DELETE", url: `${BUZZ_IDENTITY_ROUTE}/auth-tag`, headers: (await t.strictHeaders()) });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await waitFor(() => t.sessionRow(sessionId).status === "left", 5000, "left");
    expect(t.sessionRow(sessionId).endReason).toBe("buzz_identity_missing");
    const proposal = await t.propose();
    expect(proposal.statusCode).toBe(409);
    expect(proposal.json().error).toBe("live_buzz_identity_missing");
    const join = await t.join(grant.id, t.huddle());
    expect(join.statusCode).toBe(409);
    expect(join.json().error).toBe("live_buzz_identity_missing");
    expect(t.huddleRelay.upgrades).toHaveLength(upgrades);
  });
});

describe("pre-0.3.0 security digest of the live-voice feature", () => {
  it("M1: an owner Stop also pauses the grant; a rejoin is refused until the pinned owner presses Resume", async () => {
    const t = await setup();
    const grant = await t.active();
    const { sessionId } = await t.joined(grant.id);
    const stopped = await t.f.owner("POST", `${O}/sessions/${sessionId}/stop`, {});
    expect(stopped.statusCode, stopped.body).toBe(200);
    await waitFor(() => t.sessionRow(sessionId).status === "left", 5000, "left");
    expect(t.sessionRow(sessionId).endReason).toBe("stopped_by_owner");
    expect(t.f.store.channels.live.getGrant(TENANT, grant.id)).toMatchObject({ status: "paused", decidedReason: "stopped_by_owner" });
    const refused = await t.join(grant.id, t.huddle());
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "live_grant_not_active", reason: "grant_stopped_by_owner_resume_required" });
    // Resume is the strict owner gate: another operator session cannot do it.
    expect((await t.f.owner("POST", `${O}/grants/${grant.id}/resume`, {})).statusCode).not.toBe(200);
    expect(t.f.store.channels.live.getGrant(TENANT, grant.id)?.status).toBe("paused");
    const resumed = await t.strict("POST", `${O}/grants/${grant.id}/resume`, {});
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect((await t.join(grant.id, t.huddle())).statusCode).toBe(201);
  });
});

import { createSign, generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { TENANT, channelFixture, type ChannelFixture } from "./channels/app-fixture.js";
import { jsonResponse } from "./channels/providers/test-support.js";
import { BOT_FRAMEWORK_OPENID_URL, type BotFrameworkVerifier } from "./channels/providers/teams-auth.js";
import { createTeamsProvider, type TeamsConversationSource } from "./channels/providers/teams.js";
import { resolveChannelCredential } from "./channels/runtime.js";
import { TEAMS_MESSAGES_PATH } from "./channels/teams-inbound.js";

const APP_ID = "11111111-2222-4333-8444-555555555555";
const TENANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "Sentinel~TeamsSecret.0123456789_abcdefXYZ";
const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJib3QifQ.sentinelAccessTokenSignature0123456789";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const TEAM_ID = "19:teamaaaa0000@thread.tacv2";
const CHANNEL_ID = "19:chanbbbb1111@thread.tacv2";
// Personal conversation ids are long; the owner create route must accept them.
const PERSONAL_ID = `a:1${"Qx7_kLm-9".repeat(14)}`;
const TEAMS_ENV = {
  MARKETPLACE_CHANNELS_TEAMS_APP_ID: APP_ID,
  MARKETPLACE_CHANNELS_TEAMS_APP_SECRET: SECRET,
  MARKETPLACE_CHANNELS_TEAMS_TENANT_ID: TENANT_ID,
};

/** A JWT-shaped bearer the fake verifier accepts (the real RS256 verifier has its own tests). */
const GOOD = "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJmYWtlIn0.c2lnbmF0dXJlLWZha2U";

/** Accepts GOOD only; checks the audience it is given. */
const fakeVerifier: BotFrameworkVerifier = {
  async verify({ authorization, appId, activity }) {
    if (authorization !== GOOD || appId !== APP_ID) return { ok: false, status: 401, reason: "token_signature" };
    return { ok: true, claims: { iss: "https://api.botframework.com", aud: appId, serviceUrl: String(activity.serviceUrl), exp: 0 } };
  },
};

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

// The real Bot Framework verifier, against a locally generated RSA key served by a fake OpenID metadata endpoint.
const SIGNING_KID = "local-test-kid";
const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";
function botFrameworkJwt(claims: Record<string, unknown>, key = signingKeys.privateKey): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${part({ alg: "RS256", typ: "JWT", kid: SIGNING_KID })}.${part(claims)}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key).toString("base64url");
  return `Bearer ${signingInput}.${signature}`;
}
function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "https://api.botframework.com", aud: APP_ID, serviceurl: SERVICE_URL, nbf: now - 10, exp: now + 3600, ...overrides };
}

let activityCounter = 0;

async function setup(input: { environment?: Record<string, string | undefined>; realVerifier?: boolean } = {}) {
  const holder: { fixture?: ChannelFixture } = {};
  const source = (): TeamsConversationSource => holder.fixture!.store.channels.teams.source(TENANT, () => new Date());
  const lazy: TeamsConversationSource = {
    list: () => source().list(),
    get: (id) => source().get(id),
    forTeam: (id) => source().forTeam(id),
    forTenant: (id) => source().forTenant(id),
    upsert: (ref) => source().upsert(ref),
  };
  const requests: Array<{ method: string; url: string; body: string | undefined; authorization: string | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? init.body : undefined, authorization: headers.get("authorization") ?? undefined });
    if (url.startsWith("https://login.microsoftonline.com/")) return jsonResponse(200, { token_type: "Bearer", expires_in: 3600, access_token: ACCESS_TOKEN });
    if (url === BOT_FRAMEWORK_OPENID_URL) return jsonResponse(200, { issuer: "https://api.botframework.com", jwks_uri: JWKS_URL });
    if (url === JWKS_URL) {
      const jwk = signingKeys.publicKey.export({ format: "jwk" });
      return jsonResponse(200, { keys: [{ kty: "RSA", use: "sig", kid: SIGNING_KID, n: jwk.n, e: jwk.e, endorsements: ["msteams"] }] });
    }
    if (url.endsWith(`/v3/teams/${encodeURIComponent(TEAM_ID)}/conversations`)) {
      return jsonResponse(200, { conversations: [{ id: TEAM_ID, name: null }, { id: CHANNEL_ID, name: "announcements" }] });
    }
    if (url.includes("/v3/conversations/") && init?.method === "POST") return jsonResponse(201, { id: "1712345678901" });
    return jsonResponse(404, {});
  }) as typeof fetch;
  const teams = createTeamsProvider({ fetchImpl, conversations: lazy });
  const fixture = await channelFixture({
    environment: { ...TEAMS_ENV, ...input.environment },
    options: input.realVerifier
      ? { channelProviders: { teams }, providerFetch: fetchImpl }
      : { channelProviders: { teams }, teamsVerifier: fakeVerifier },
  });
  holder.fixture = fixture;
  fixtures.push(fixture);
  // Every activity gets a fresh id unless the test sets one (the endpoint processes one id once).
  const activity = (body: Record<string, unknown>, authorization = GOOD) =>
    fixture.app.inject({
      method: "POST",
      url: TEAMS_MESSAGES_PATH,
      headers: { authorization, "content-type": "application/json" },
      payload: { id: `f:activity-${++activityCounter}`, ...body },
    });
  return { f: fixture, requests, activity };
}

const install = {
  type: "installationUpdate",
  action: "add",
  channelId: "msteams",
  serviceUrl: SERVICE_URL,
  recipient: { id: `28:${APP_ID}` },
  from: { id: "29:installer" },
  conversation: { id: CHANNEL_ID, conversationType: "channel", tenantId: TENANT_ID, name: "announcements" },
  channelData: { team: { id: TEAM_ID, name: "Ops" }, channel: { id: CHANNEL_ID }, tenant: { id: TENANT_ID } },
};
const personalInstall = {
  ...install,
  from: { id: "29:ana", name: "Ana" },
  conversation: { id: PERSONAL_ID, conversationType: "personal", tenantId: TENANT_ID },
  channelData: { tenant: { id: TENANT_ID } },
};

describe("Teams messaging endpoint", () => {
  it("is a public route authenticated only by the Bot Framework token", async () => {
    const { activity, f } = await setup();
    const anonymous = await f.app.inject({ method: "POST", url: TEAMS_MESSAGES_PATH, payload: install });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ error: "teams_auth_invalid", reason: "token_missing" });
    // An operator-style or agent bearer is not a Bot Framework token: refused before the body is parsed.
    expect((await activity(install, "Bearer tbag_" + "a".repeat(43))).json()).toEqual({ error: "teams_auth_invalid", reason: "token_missing" });
    // A JWT-shaped bearer reaches the Bot Framework verifier, which refuses a forged one.
    const forged = await activity(install, "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJldmlsIn0.Zm9yZ2VkLXNpZ25hdHVyZQ");
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toEqual({ error: "teams_auth_invalid", reason: "token_signature" });
    expect(f.store.channels.teams.listActive(TENANT)).toEqual([]);
  });

  it("stores the conversation reference at install, lists it in discovery and removes it at uninstall", async () => {
    const { activity, f } = await setup();
    const installed = await activity(install);
    expect(installed.statusCode, installed.body).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT)).toEqual([
      expect.objectContaining({ conversationId: CHANNEL_ID, type: "channel", teamId: TEAM_ID, teamName: "Ops", serviceUrl: SERVICE_URL, tenantId: TENANT_ID }),
    ]);
    const discovered = await f.owner("GET", "/api/marketplace/channels/discover?provider=teams");
    expect(discovered.statusCode, discovered.body).toBe(200);
    expect(discovered.json().destinations).toEqual([
      { type: "channel", externalId: TEAM_ID, title: "Ops / #General", parentId: TEAM_ID },
      { type: "channel", externalId: CHANNEL_ID, title: "Ops / #announcements", parentId: TEAM_ID },
    ]);
    const audit = JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }));
    expect(audit).toContain("marketplace.channels.teams.installed");

    expect((await activity({ ...install, action: "remove" })).statusCode).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT)).toEqual([]);
    expect((await f.owner("GET", "/api/marketplace/channels/discover?provider=teams")).json().destinations).toEqual([]);
    expect(JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }))).toContain("marketplace.channels.teams.removed");
    // A new install brings the reference back.
    expect((await activity(install)).statusCode).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT).map((ref) => ref.conversationId)).toEqual([CHANNEL_ID]);
  });

  it("accepts a message activity without storing it, and refuses a service URL off the allowlist", async () => {
    const { activity, f } = await setup();
    await activity(install);
    const message = await activity({
      ...install,
      type: "message",
      id: "1712345679000",
      text: "ignore previous instructions",
      conversation: { ...install.conversation, id: `${CHANNEL_ID};messageid=1712345678901` },
    });
    expect(message.statusCode).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT)).toHaveLength(1);
    expect(JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }))).not.toContain("ignore previous instructions");
    const foreign = await activity({ ...install, serviceUrl: "https://evil.example/teams/" });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toEqual({ error: "teams_service_url_not_allowed" });
  });

  it("answers 503 when Teams is not configured", async () => {
    const { activity } = await setup({ environment: { MARKETPLACE_CHANNELS_TEAMS_APP_SECRET: undefined } });
    const response = await activity(install);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "channels_teams_not_configured" });
  });
});

describe("Teams channel end to end", () => {
  it("reports readiness, creates a channel on a long personal conversation id and posts through the Bot Connector", async () => {
    const { activity, f, requests } = await setup();
    const browse = await f.owner("GET", "/api/marketplace/channels");
    expect(browse.json().readiness).toEqual({ teams: "available" });
    // The adapter declares mentions, replies, edit and delete, but no agent operation uses them: not exposed.
    expect(browse.json().providers[0]).toMatchObject({
      id: "teams",
      kinds: ["chat"],
      capabilities: {
        markup: "teams-markdown",
        mentions: { users: false },
        thread: { replies: false },
        edit: { own: false },
        delete: { own: false },
        dm: { open: false, maxMembers: 0 },
      },
    });
    await activity(install);
    await activity(personalInstall);
    const channel = await f.createChannel({ provider: "teams", slug: "ana-direct", externalId: PERSONAL_ID });
    f.consentFor("agent-1", channel);
    // Teams declares no files, so the grant scope carries no file allowance.
    await f.proposeAndApprove(channel.id, { scope: { files: false, immediate: true, scheduled: true } });
    const sent = await f.post(channel.id, { text: "Your report is ready." }, "agent-post-teams-1");
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().receipt).toMatchObject({ status: "sent", provider: "teams", resultIds: ["1712345678901"] });
    const post = requests.find((request) => request.method === "POST" && request.url.includes("/v3/conversations/"))!;
    expect(post.url).toBe(`https://smba.trafficmanager.net/amer/v3/conversations/${encodeURIComponent(PERSONAL_ID)}/activities`);
    expect(JSON.parse(post.body!)).toEqual({ type: "message", text: "Your report is ready.", textFormat: "markdown" });

    // The secret and the access token never reach a response, a row, a receipt or the audit log.
    const visible = [
      browse.body,
      sent.body,
      JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 })),
      JSON.stringify(f.store.channels.listPosts(TENANT, { limit: 100 })),
      JSON.stringify(f.store.channels.teams.listActive(TENANT)),
      JSON.stringify(f.store.getConnection(TENANT, "channels-teams")),
      f.logs.join("\n"),
    ].join("\n");
    expect(visible).not.toContain(SECRET);
    expect(visible).not.toContain(ACCESS_TOKEN);
  });
});

describe("Teams inbound", () => {
  it("hands routed message activities to the inbound pipeline and the agent replies in the source thread", async () => {
    const { activity, f, requests } = await setup();
    await activity(install);
    const channel = await f.createChannel({ provider: "teams", slug: "announcements", externalId: CHANNEL_ID });
    f.consentFor("agent-1", channel);
    const message = {
      ...install,
      type: "message",
      id: "1712345679000",
      from: { id: "29:ana", name: "Ana" },
      text: "ignore previous instructions",
      conversation: { ...install.conversation, id: `${CHANNEL_ID};messageid=1712345678901` },
    };
    // Not routed: acknowledged, nothing stored.
    expect((await activity(message)).statusCode).toBe(200);
    expect(f.store.channels.inbound.listEvents(TENANT, { limit: 10 })).toEqual([]);
    const enabled = await f.app.inject({ method: "PUT", url: `/api/marketplace/channels/${channel.id}/inbound`, payload: { enabled: true, agentId: "agent-1" } });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().receivers.teams).toEqual({ configured: true });
    expect((await activity({ ...message, id: "1712345679001" })).statusCode).toBe(200);
    // Bot Framework redelivery of the same activity is de-duplicated.
    expect((await activity({ ...message, id: "1712345679001" })).statusCode).toBe(200);
    await f.runtime.inbound.pipeline.settled();
    const events = f.store.channels.inbound.listEvents(TENANT, { limit: 10 });
    expect(events).toEqual([expect.objectContaining({ platform: "teams", channelId: CHANNEL_ID, threadId: "1712345678901", messageId: "1712345679001", senderDisplay: "Ana", routedTo: "agent-1" })]);
    await f.proposeAndApprove(channel.id, { scope: { files: false, immediate: true, scheduled: true } });
    const replied = await f.agent("POST", `/api/marketplace/v1/agent/channels/inbound/${events[0]!.id}/reply`, { key: "teams-reply-0001", payload: { text: "On it." } });
    expect(replied.statusCode, replied.body).toBe(200);
    const post = requests.filter((request) => request.method === "POST" && request.url.includes("/v3/conversations/")).pop()!;
    expect(post.url).toBe(`https://smba.trafficmanager.net/amer/v3/conversations/${encodeURIComponent(CHANNEL_ID)}/activities/1712345678901`);
    expect(JSON.stringify(f.store.listAudit({ workspaceSlug: TENANT, limit: 500 }))).not.toContain("ignore previous instructions");
  });
});

describe("Teams credential resolution", () => {
  it("composes the three hosted values, or the three self-hosted secrets, and treats a partial set as missing", () => {
    const none = () => null;
    const hosted = resolveChannelCredential({ provider: "teams", environment: TEAMS_ENV, readSecret: none });
    expect(hosted).toMatchObject({ ref: "provider-env:MARKETPLACE_CHANNELS_TEAMS_APP_SECRET", secrets: [SECRET] });
    expect(JSON.parse(hosted!.value)).toEqual({ appId: APP_ID, appSecret: SECRET, tenantId: TENANT_ID });
    expect(resolveChannelCredential({ provider: "teams", environment: { ...TEAMS_ENV, MARKETPLACE_CHANNELS_TEAMS_TENANT_ID: "" }, readSecret: none })).toBeNull();
    const secrets: Record<string, string> = { appId: APP_ID, appSecret: SECRET, tenantId: TENANT_ID };
    const selfHosted = resolveChannelCredential({
      provider: "teams",
      environment: {},
      readSecret: (pluginId, name) => (pluginId === "channels-teams" && secrets[name] ? { value: secrets[name]!, id: `secret-${name}` } : null),
    });
    expect(selfHosted).toMatchObject({ ref: "marketplace-secret:secret-appSecret", secrets: [SECRET] });
  });
});

describe("Teams replay protection and other bots", () => {
  it("processes one activity id once, so a replayed install cannot bring back a removed conversation", async () => {
    const { activity, f } = await setup();
    const captured = { ...install, id: "f:install-0001" };
    expect((await activity(captured)).statusCode).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT)).toHaveLength(1);
    expect((await activity({ ...install, action: "remove" })).statusCode).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT)).toEqual([]);
    // The same token and body again: acknowledged, nothing changes.
    const replayed = await activity(captured);
    expect(replayed.statusCode).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT)).toEqual([]);
    // An activity with no usable id changes nothing either.
    for (const id of [undefined, "", 42, "bad id\u0000"]) {
      const response = await f.app.inject({ method: "POST", url: TEAMS_MESSAGES_PATH, headers: { authorization: GOOD, "content-type": "application/json" }, payload: { ...install, id } });
      expect(response.statusCode).toBe(200);
    }
    expect(f.store.channels.teams.listActive(TENANT)).toEqual([]);
  });
});

describe("Teams endpoint end to end with the real Bot Framework verifier", () => {
  it("accepts an RS256 token signed by the metadata key and refuses wrong audience, service URL, key or expiry", async () => {
    const { activity, f, requests } = await setup({ realVerifier: true });
    const installed = await activity(install, botFrameworkJwt(validClaims()));
    expect(installed.statusCode, installed.body).toBe(200);
    expect(f.store.channels.teams.listActive(TENANT).map((ref) => ref.conversationId)).toEqual([CHANNEL_ID]);
    // Keys came from the pinned metadata document, then its jwks_uri; nothing else was fetched to verify.
    expect(requests.filter((request) => request.url === BOT_FRAMEWORK_OPENID_URL || request.url === JWKS_URL).map((request) => request.url)).toEqual([BOT_FRAMEWORK_OPENID_URL, JWKS_URL]);

    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const refusals: Array<[string, number, string]> = [
      [botFrameworkJwt(validClaims({ aud: "99999999-2222-4333-8444-555555555555" })), 401, "token_audience"],
      [botFrameworkJwt(validClaims({ iss: "https://evil.example" })), 401, "token_issuer"],
      [botFrameworkJwt(validClaims({ serviceurl: "https://smba.trafficmanager.net/emea/" })), 403, "token_service_url"],
      [botFrameworkJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 3600 })), 401, "token_expired"],
      [botFrameworkJwt(validClaims(), other), 401, "token_signature"],
    ];
    for (const [authorization, status, reason] of refusals) {
      const response = await activity(personalInstall, authorization);
      expect(response.statusCode, reason).toBe(status);
      expect(response.json()).toMatchObject({ reason });
    }
    expect(f.store.channels.teams.listActive(TENANT).map((ref) => ref.conversationId)).toEqual([CHANNEL_ID]);
  });
});

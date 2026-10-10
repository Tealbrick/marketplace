import { DatabaseSync } from "node:sqlite";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { BotFrameworkVerifier } from "./providers/teams-auth.js";
import type { TeamsConversationRef } from "./providers/teams.js";
import { parseTrustedProxies } from "./inbound-http.js";
import { TEAMS_MESSAGES_PATH, registerTeamsInboundRoute } from "./teams-inbound.js";
import { TEAMS_CONVERSATION_DDL, TeamsConversationStore } from "./teams-store.js";

const APP_ID = "11111111-2222-4333-8444-555555555555";
const TENANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GOOD = "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJmYWtlIn0.c2lnbmF0dXJlLWZha2U";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";

function memoryStore(cap?: number) {
  const db = new DatabaseSync(":memory:");
  db.exec(TEAMS_CONVERSATION_DDL);
  return new TeamsConversationStore(db, cap);
}

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function route(input: { rate?: { capacity: number; refillPerSecond: number }; ready?: Promise<void>; trustedProxies?: string } = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  let verified = 0;
  const verifier: BotFrameworkVerifier = {
    async verify({ authorization }) {
      verified += 1;
      return authorization === GOOD ? { ok: true, claims: { iss: "x", aud: APP_ID, serviceUrl: SERVICE_URL, exp: 0 } } : { ok: false, status: 401, reason: "token_signature" };
    },
  };
  let now = 1_000_000;
  registerTeamsInboundRoute({
    app,
    store: memoryStore(),
    organizationId: "org",
    identity: () => ({ appId: APP_ID, tenantId: TENANT_ID }),
    verifier,
    ready: input.ready ?? Promise.resolve(),
    now: () => new Date(now),
    audit: () => undefined,
    ...(input.rate ? { rate: input.rate } : {}),
    trustedProxies: parseTrustedProxies(input.trustedProxies),
    clock: () => now,
  });
  await app.ready();
  return { app, verifiedCount: () => verified, advance: (ms: number) => void (now += ms) };
}

const activity = { type: "message", id: "1", channelId: "msteams", serviceUrl: SERVICE_URL, recipient: { id: `28:${APP_ID}` }, conversation: { id: "19:g@thread.v2", conversationType: "groupChat", tenantId: TENANT_ID } };

describe("Teams messaging endpoint pre-auth", () => {
  it("refuses a missing or non-JWT bearer before the body is parsed and before start-up finishes", async () => {
    const { app, verifiedCount } = await route({ ready: new Promise<void>(() => undefined) });
    for (const authorization of [undefined, "Basic abc", "Bearer tbag_aaaa", "Bearer a.b.c"]) {
      const response = await app.inject({
        method: "POST",
        url: TEAMS_MESSAGES_PATH,
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        payload: "{ this is not json",
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "teams_auth_invalid", reason: "token_missing" });
    }
    expect(verifiedCount()).toBe(0);
  });

  it("answers 401, never 400, for a malformed body with a missing, invalid or unverifiable token, and 400 only after a valid token", async () => {
    const { app } = await route();
    const send = (authorization: string | undefined, payload: string, contentType = "application/json") =>
      app.inject({ method: "POST", url: TEAMS_MESSAGES_PATH, headers: { "content-type": contentType, ...(authorization ? { authorization } : {}) }, payload });
    const invalid = "Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJmYWtlIn0.aW52YWxpZC1zaWduYXR1cmU";
    for (const payload of ["{ this is not json", "[1,2]", "null", '"text"', "", "{}"]) {
      for (const authorization of [undefined, "Bearer a.b.c", invalid]) {
        const response = await send(authorization, payload);
        expect(response.statusCode, `${payload} / ${authorization}`).toBe(401);
        expect(response.json()).toMatchObject({ error: "teams_auth_invalid" });
      }
    }
    // Another content type does not open a 415 or 400 oracle either.
    expect((await send(invalid, "{ nope", "text/plain")).statusCode).toBe(401);
    // A valid token with an unreadable body: 400.
    for (const payload of ["{ this is not json", "[1,2]", "null"]) {
      const response = await send(GOOD, payload);
      expect(response.statusCode, payload).toBe(400);
      expect(response.json()).toEqual({ error: "activity_invalid" });
    }
    expect((await send(GOOD, JSON.stringify(activity))).statusCode).toBe(200);
  });

  it("refuses a body over 128 KB", async () => {
    const { app } = await route();
    const response = await app.inject({
      method: "POST",
      url: TEAMS_MESSAGES_PATH,
      headers: { "content-type": "application/json", authorization: GOOD },
      payload: JSON.stringify({ ...activity, text: "x".repeat(130 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    const ok = await app.inject({ method: "POST", url: TEAMS_MESSAGES_PATH, headers: { authorization: GOOD }, payload: activity });
    expect(ok.statusCode).toBe(200);
  });

  it("ignores X-Forwarded-For unless the socket is a trusted proxy: rotating the header does not buy a new budget (F2)", async () => {
    const { app } = await route({ rate: { capacity: 2, refillPerSecond: 0 } });
    const codes = [];
    for (let index = 0; index < 4; index += 1) {
      codes.push((await app.inject({ method: "POST", url: TEAMS_MESSAGES_PATH, headers: { authorization: GOOD, "x-forwarded-for": `10.0.0.${index}` }, payload: activity })).statusCode);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
  });

  it("answers 429 when one source exceeds its request budget, per source (behind a trusted proxy)", async () => {
    // inject() connects from 127.0.0.1; configured as the trusted proxy, its forwarded client address is the source.
    const { app, advance } = await route({ rate: { capacity: 3, refillPerSecond: 0.5 }, trustedProxies: "127.0.0.1" });
    const send = (source: string) =>
      app.inject({ method: "POST", url: TEAMS_MESSAGES_PATH, headers: { authorization: GOOD, "x-forwarded-for": source }, payload: activity });
    for (let index = 0; index < 3; index += 1) expect((await send("203.0.113.7")).statusCode).toBe(200);
    const limited = await send("203.0.113.7");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "teams_rate_limited" });
    expect((await send("198.51.100.9")).statusCode).toBe(200);
    advance(2000);
    expect((await send("203.0.113.7")).statusCode).toBe(200);
  });
});

describe("Teams conversation store", () => {
  const ref = (conversationId: string, type: TeamsConversationRef["type"]): TeamsConversationRef => ({
    conversationId,
    type,
    ...(type === "channel" ? { teamId: "19:team@thread.tacv2", channelId: conversationId } : {}),
    teamName: "",
    title: conversationId,
    membership: "standard",
    serviceUrl: SERVICE_URL,
    tenantId: TENANT_ID,
  });

  it("lists team channels and group chats apart from 1:1 chats, so 1:1 chats never crowd them out", () => {
    const store = memoryStore();
    for (let index = 0; index < 1200; index += 1) store.upsert("org", ref(`a:1p${index}`, "personal"), new Date(1_000 + index));
    store.upsert("org", ref("19:c1@thread.tacv2", "channel"), new Date(5_000_000));
    store.upsert("org", ref("19:g1@thread.v2", "groupChat"), new Date(5_000_001));
    const listed = store.listActive("org");
    expect(listed.slice(0, 2).map((entry) => entry.conversationId)).toEqual(["19:c1@thread.tacv2", "19:g1@thread.v2"]);
    expect(listed.filter((entry) => entry.type === "personal")).toHaveLength(1000);
    // The newest 1:1 chats are the ones listed.
    expect(listed[2]!.conversationId).toBe("a:1p1199");
  });

  it("caps each kind on its own, so many group chats never crowd out team channels", () => {
    const store = memoryStore();
    store.upsert("org", ref("19:c1@thread.tacv2", "channel"), new Date(9_000_000));
    for (let index = 0; index < 1200; index += 1) store.upsert("org", ref(`19:g${index}@thread.v2`, "groupChat"), new Date(1_000 + index));
    const listed = store.listActive("org");
    expect(listed[0]!.conversationId).toBe("19:c1@thread.tacv2");
    expect(listed.filter((entry) => entry.type === "groupChat")).toHaveLength(1000);
    // The most recently updated group chats are the ones listed.
    expect(listed[1]!.conversationId).toBe("19:g1199@thread.v2");
  });

  it("keeps at most the cap of 1:1 rows per tenant, removed rows first, then the oldest", () => {
    const store = memoryStore(3);
    store.upsert("org", ref("a:1old", "personal"), new Date(1_000));
    store.upsert("org", ref("a:1gone", "personal"), new Date(2_000));
    store.markRemoved("org", { conversationId: "a:1gone" }, new Date(3_000));
    store.upsert("org", ref("a:1mid", "personal"), new Date(4_000));
    store.upsert("org", ref("a:1new", "personal"), new Date(5_000));
    expect(store.listActive("org").map((entry) => entry.conversationId).sort()).toEqual(["a:1mid", "a:1new", "a:1old"]);
    store.upsert("org", ref("a:1newest", "personal"), new Date(6_000));
    expect(store.listActive("org").map((entry) => entry.conversationId).sort()).toEqual(["a:1mid", "a:1new", "a:1newest"]);
    // Channels never count toward the 1:1 cap.
    store.upsert("org", ref("19:c1@thread.tacv2", "channel"), new Date(7_000));
    expect(store.listActive("org")).toHaveLength(4);
  });
});

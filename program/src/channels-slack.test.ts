import { afterEach, describe, expect, it } from "vitest";

import { DISCORD_TOKEN, PROOF, SERVICE, TELEGRAM_TOKEN, TENANT, channelFixture, fakeProvider, type ChannelFixture } from "./channels/app-fixture.js";
import { createSlackProvider } from "./channels/providers/slack.js";
import { OWNER_TEST_TEXT } from "./channels/service.js";

// Channels P2: the real Slack adapter (over a fake fetch) wired through the runtime registry, readiness,
// discovery, channel creation and the owner test send. No request reaches slack.com.

const SLACK_TOKEN = ["xoxb", "5550001112", "2223334445", "SentinelSLACKtokenValue99"].join("-");

const fixtures: ChannelFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
});

type Call = { method: string; form: Record<string, string>; authorization: string | null };

function slackFetch(answers: Record<string, () => unknown>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = url.replace("https://slack.com/api/", "");
    calls.push({ method, form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))), authorization: new Headers(init?.headers).get("authorization") });
    const answer = answers[method];
    return new Response(JSON.stringify(answer ? answer() : { ok: false, error: "unknown_method" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function setup(environment: Record<string, string | undefined>, answers: Record<string, () => unknown>) {
  const slack = slackFetch(answers);
  const f = await channelFixture({
    ownerPin: true,
    environment,
    options: {
      channelProviders: {
        telegram: fakeProvider("telegram", TELEGRAM_TOKEN).provider,
        discord: fakeProvider("discord", DISCORD_TOKEN).provider,
        slack: createSlackProvider({ fetchImpl: slack.fetchImpl, sleep: async () => undefined }),
      },
    },
  });
  fixtures.push(f);
  return { f, slack };
}

const AUTH_OK = () => ({ ok: true, url: "https://acme.slack.com/", team: "Acme", user: "marketplace", team_id: "T0ACME", user_id: "U0BOT1", bot_id: "B0BOT1" });

describe("channels: Slack provider through the runtime", () => {
  it("verifies at start, discovers member channels, creates a channel and sends the owner test", async () => {
    const { f, slack } = await setup(
      { MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN: SLACK_TOKEN },
      {
        "auth.test": AUTH_OK,
        "conversations.list": () => ({
          ok: true,
          channels: [
            { id: "C0ENG", name: "engineering", is_member: true },
            { id: "C0ALL", name: "all-hands", is_member: false },
          ],
          response_metadata: { next_cursor: "" },
        }),
        "chat.postMessage": () => ({ ok: true, channel: "C0ENG", ts: "1800000000.000100" }),
      },
    );
    const browse = await f.owner("GET", "/api/marketplace/channels");
    expect(browse.json()).toMatchObject({
      readiness: { telegram: "available", discord: "available", slack: "available" },
      connections: { slack: { state: "connected", botUsername: "marketplace", credentialRef: "provider-env:MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN" } },
    });
    const slackEntry = (browse.json().providers as Array<{ id: string; kinds?: string[]; capabilities?: Record<string, unknown> }>).find((entry) => entry.id === "slack");
    // Only wired features: DM, reactions, edit, delete and mentions are wired (routes v2); native schedule is
    // declared by the adapter but no agent operation performs it, so the answer shows it as not available.
    const hidden = {
      markup: "mrkdwn",
      mentions: { users: true, broadcast: "suppressed" },
      dm: { open: true, maxMembers: 1 },
      reactions: { add: true, remove: true, custom: true },
      edit: { own: true },
      delete: { own: true },
      // Reply to source (marketplace.channels.reply) and inbound are wired.
      thread: { replies: true, topics: false, forum: false },
      inbound: { mode: "webhook", dedupe: true },
      schedule: { native: false },
    };
    expect(slackEntry).toMatchObject({ kinds: ["chat"], capabilities: hidden });
    expect(f.store.getConnection(TENANT, "channels-slack")?.metadata).toMatchObject({ botId: "U0BOT1", teamId: "T0ACME" });

    const discovered = await f.owner("GET", "/api/marketplace/channels/discover?provider=slack");
    expect(discovered.json().destinations).toEqual([{ type: "channel", externalId: "C0ENG", title: "#engineering", url: "https://acme.slack.com/archives/C0ENG" }]);

    const channel = await f.createChannel({ provider: "slack", slug: "eng" });
    expect((await f.owner("GET", "/api/marketplace/channels")).json().channels[0].capabilities).toMatchObject(hidden);
    const test = await f.owner("POST", `/api/marketplace/channels/${channel.id}/test`, {}, { "idempotency-key": "owner-test-slack1" });
    expect(test.statusCode, test.body).toBe(200);
    expect(test.json()).toMatchObject({
      receipt: { status: "sent", authority: "owner-test", provider: "slack", resultIds: ["1800000000.000100"], resultUrls: ["https://acme.slack.com/archives/C0ENG/p1800000000000100"] },
    });
    const sent = slack.calls.find((call) => call.method === "chat.postMessage")!;
    expect(sent.form).toEqual({ channel: "C0ENG", text: OWNER_TEST_TEXT, mrkdwn: "true", parse: "none", link_names: "false" });
    expect(slack.calls.every((call) => call.authorization === `Bearer ${SLACK_TOKEN}`)).toBe(true);

    const readiness = await f.app.inject({ method: "GET", url: "/api/portal/readiness", headers: { "x-tealbrick-instance-proof": PROOF } });
    expect(readiness.json()).toMatchObject({ channels: { providers: { slack: "available" } } });
    const settings = await f.app.inject({ method: "GET", url: "/.well-known/tealbrick/settings", headers: { authorization: `Bearer ${SERVICE}` } });
    expect(settings.json().account).toMatchObject({ "channels.slack.botToken": { set: true }, "channels.slack.signingSecret": { set: false } });
    for (const body of [browse.body, discovered.body, test.body, readiness.body, settings.body]) {
      expect(body).not.toContain(SLACK_TOKEN);
    }
  });

  it("reports credential_missing and credential_invalid without echoing the token", async () => {
    const missing = await setup({ MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN: undefined }, { "auth.test": AUTH_OK });
    expect((await missing.f.owner("GET", "/api/marketplace/channels")).json().readiness).toMatchObject({ slack: "credential_missing" });
    expect(missing.slack.calls).toHaveLength(0);

    const invalid = await setup({ MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN: SLACK_TOKEN }, { "auth.test": () => ({ ok: false, error: "invalid_auth" }) });
    const browse = await invalid.f.owner("GET", "/api/marketplace/channels");
    expect(browse.json().readiness).toMatchObject({ slack: "credential_invalid" });
    expect(browse.body).not.toContain(SLACK_TOKEN);

    const wrongShape = await setup({ MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN: "xoxp-user-token-not-a-bot" }, { "auth.test": AUTH_OK });
    const shaped = await wrongShape.f.owner("GET", "/api/marketplace/channels");
    expect(shaped.json().readiness).toMatchObject({ slack: "credential_invalid" });
    expect(wrongShape.slack.calls).toHaveLength(0);
    expect(shaped.body).not.toContain("xoxp-user-token");
  });
});

describe("channels: the Slack signing secret is redacted like a bot token", () => {
  it("removes the signing secret from receipts and answers", async () => {
    const signing = "5f1c0de5ec7e7a11c0ffee5ca1ab1e99";
    const f = await channelFixture({ environment: { MARKETPLACE_CHANNELS_SLACK_SIGNING_SECRET: signing } });
    fixtures.push(f);
    const channel = await f.createChannel({ slug: "community" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id);
    f.telegram.reply({ status: "failed", resultIds: [], resultUrls: [], errorCode: "provider_rejected", detail: `upstream echoed ${signing}` });
    const sent = await f.post(channel.id, { text: "Meetup tonight" }, "agent-post-sign01");
    expect(sent.body).not.toContain(signing);
    const receipts = await f.agent("GET", "/api/marketplace/v1/agent/channels/receipts");
    expect(receipts.body).not.toContain(signing);
    expect(JSON.stringify(f.store.channels.listPosts(TENANT, { limit: 10 }))).not.toContain(signing);
  });
});

describe("channels: routes v2 through the real Slack adapter", () => {
  it("reacts, edits and deletes the agent's own message and sends an approved first DM found by email", async () => {
    const { f, slack } = await setup(
      { MARKETPLACE_CHANNELS_SLACK_BOT_TOKEN: SLACK_TOKEN },
      {
        "auth.test": AUTH_OK,
        "conversations.list": () => ({ ok: true, channels: [{ id: "C0ENG", name: "engineering", is_member: true }], response_metadata: { next_cursor: "" } }),
        "chat.postMessage": () => ({ ok: true, channel: "C0ENG", ts: "1800000000.000100" }),
        "reactions.add": () => ({ ok: true }),
        "chat.update": () => ({ ok: true, channel: "C0ENG", ts: "1800000000.000100" }),
        "chat.delete": () => ({ ok: true }),
        "users.lookupByEmail": () => ({ ok: true, user: { id: "U0ALICE", name: "alice", profile: { display_name: "Alice", real_name: "Alice Example" } } }),
        "conversations.open": () => ({ ok: true, channel: { id: "D0ALICE01" } }),
      },
    );
    const channel = await f.createChannel({ provider: "slack", slug: "eng" });
    f.consentFor("agent-1", channel);
    await f.proposeAndApprove(channel.id, { scope: { files: false, immediate: true, scheduled: false, reactions: true, edits: true, deletes: true, dms: true } });
    const posted = await f.post(channel.id, { text: "Hello <@U0ALICE>", mentions: ["U0ALICE"] }, "slack-v2-post-0001");
    expect(posted.statusCode, posted.body).toBe(200);
    const ts = posted.json().receipt.resultIds[0] as string;
    const base = `/api/marketplace/v1/agent/channels/${channel.id}/messages/${ts}`;
    expect((await f.agent("POST", `${base}/reactions`, { key: "slack-v2-react-01", payload: { emoji: ":tada:" } })).statusCode).toBe(200);
    expect((await f.agent("PATCH", base, { key: "slack-v2-edit-001", payload: { text: "Hello again" } })).statusCode).toBe(200);
    expect((await f.agent("DELETE", base, { key: "slack-v2-delete-01" })).statusCode).toBe(200);
    const form = (method: string) => slack.calls.find((call) => call.method === method)?.form;
    expect(form("chat.postMessage")).toMatchObject({ channel: "C0ENG", text: "Hello <@U0ALICE>" });
    expect(form("reactions.add")).toEqual({ channel: "C0ENG", timestamp: ts, name: "tada" });
    expect(form("chat.update")).toMatchObject({ channel: "C0ENG", ts, text: "Hello again" });
    expect(form("chat.delete")).toEqual({ channel: "C0ENG", ts });

    await f.ownerWrite("PUT", `/api/marketplace/channels/connections/${channel.connectionId}/people-policy`, { mode: "allowlist", domains: ["example.com"] });
    const found = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/people/find`, { key: "slack-v2-find-001", payload: { email: "alice@example.com" } });
    expect(found.json().person).toMatchObject({ approved: false });
    // The email travels in the form body only.
    expect(form("users.lookupByEmail")).toEqual({ email: "alice@example.com" });
    const held = await f.agent("POST", `/api/marketplace/v1/agent/channels/${channel.id}/people/${found.json().person.personRef}/messages`, { key: "slack-v2-dm-00001", payload: { text: "Welcome!" } });
    expect(held.statusCode, held.body).toBe(202);
    expect(slack.calls.some((call) => call.method === "conversations.open")).toBe(false);
    const approved = await f.owner("POST", `/api/marketplace/company-box/approvals/${held.json().approvalId}/approve`, {});
    expect(approved.json()).toMatchObject({ channel: { receipt: { status: "sent" } } });
    expect(form("conversations.open")).toMatchObject({ users: "U0ALICE" });
    expect(slack.calls.filter((call) => call.method === "chat.postMessage").at(-1)!.form).toMatchObject({ channel: "D0ALICE01", text: "Welcome!" });
  });
});

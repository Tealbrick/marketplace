/**
 * Adversarial QA (independent of the Marketplace build lane): outward actions in owner approval mode (no Rules).
 * The promise: an agent's outward action (sending, posting) needs the owner's approval per call or an owner-approved
 * standing grant. A one-time Portal consent to "dispatch" is not that approval.
 *
 * F3-1 (2026-10-11): only toolkits with a curated Composio policy (googlecalendar) derive `risk`; every other toolkit
 * fell through to "covered by consent granted in Portal", so GMAIL_SEND_EMAIL executed with no hold.
 * F3-4: a custom MCP server's own `readOnlyHint` made a sending tool "observe": grantable on a read-only consent and
 * never outward. (The fake Portal scope verifier here does not check the required capability; observe vs dispatch
 * consents are covered by Marketplace's own outward-default.test.ts.)
 *
 * Both tests assert only what reaches the provider (Composio execute / MCP tools/call), not how the refusal is shaped,
 * so a hold, a 403 or an approval prompt all satisfy them.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildMarketplaceApp } from "./app.js";
import { MARKETPLACE_OPERATOR_SESSION_COOKIE, MarketplaceOperatorSessionManager } from "./operator-auth.js";
import type { PortalAgentScopeVerifier } from "./portal-scope.js";
import { MarketplaceProviderSettingsStore } from "./provider-settings.js";
import { SqliteMarketplaceStore } from "./store.js";
import { startFakeMcpServer } from "./testing/fake-mcp-server.js";

const SERVICE = "marketplace-service-token-1234";
const ORIGIN = "http://localhost";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Owner mode (no Rules client or configuration), with an agent whose Portal consent carries `capabilities`. */
async function ownerMode(capabilities: string[], extra: { mcpOrigin?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "marketplace-qa-outward-"));
  const store = new SqliteMarketplaceStore(path.join(root, "marketplace.sqlite"));
  const composioExecutions: string[] = [];
  const sessions = new MarketplaceOperatorSessionManager({ accessToken: "operator-access-token", operatorId: "owner-1", organizationId: "atlas" });
  const agentScopeVerifier: PortalAgentScopeVerifier = async ({ agentToken }) => ({
    organizationId: "atlas",
    agentId: agentToken,
    attachmentId: "attachment-1",
    capabilities: capabilities as never,
    expiresAt: Math.floor(Date.now() / 1000) + 300,
  });
  const app = await buildMarketplaceApp({
    store,
    internalAuthToken: SERVICE,
    organizationId: "atlas",
    env: { COMPOSIO_API_KEY: "test-composio-key" },
    environment: { NODE_ENV: "test", ...(extra.mcpOrigin ? { MARKETPLACE_MCP_ALLOWED_ORIGINS: extra.mcpOrigin } : {}) },
    ...(extra.mcpOrigin ? { providerSettings: new MarketplaceProviderSettingsStore(path.join(root, "ps.json"), path.join(root, "pss.json"), {}) } : {}),
    operatorSessionManager: sessions,
    agentScopeVerifier,
    providerFetch: async (input) => {
      const execute = /\/tools\/execute\/([A-Z0-9_]+)/u.exec(String(input));
      if (execute) {
        composioExecutions.push(execute[1]!);
        return new Response(JSON.stringify({ data: { id: "sent-1" }, successful: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
  });
  cleanups.push(async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const login = sessions.exchange("operator-access-token", "qa-outward");
  const operator = { origin: ORIGIN, cookie: `${MARKETPLACE_OPERATOR_SESSION_COOKIE}=${login.token}`, "x-csrf-token": login.status.csrfToken! };
  const service = { authorization: `Bearer ${SERVICE}` };
  const agent = (agentId: string) => ({ ...service, "x-tealbrick-agent-token": agentId, "x-tealbrick-attachment": "attachment-1" });
  return { app, store, composioExecutions, operator, service, agent };
}

describe("owner mode: an agent's outward action needs the owner's approval", () => {
  it("F3-1: a send tool of a toolkit without a curated Composio policy does not execute on a dispatch consent alone", async () => {
    const f = await ownerMode(["connector.observe", "connector.dispatch"]);
    const imported = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/catalog/composio/import",
      headers: f.service,
      payload: {
        workspaceSlug: "atlas",
        toolkit: "gmail",
        pluginId: "gmail-composio",
        tools: [{ name: "GMAIL_SEND_EMAIL", description: "Send an email to any recipient." }],
        autoEnable: true,
      },
    });
    expect(imported.statusCode, imported.body).toBe(201);
    f.store.upsertConnection({
      workspaceSlug: "atlas", pluginId: "gmail-composio", provider: "gmail", backend: "composio", state: "connected",
      detail: "Test connected account", metadata: { connectedAccountId: "ca_1" },
    });
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: f.agent("agent-1"),
      payload: { workspaceSlug: "atlas", pluginId: "gmail-composio", actionKey: "gmail.send.email", accountId: "ca_1", resourceKind: "gmail.connected-account", resourceRef: "account:ca_1" },
    });
    const grantId = grant.statusCode === 201 ? grant.json<{ grant: { id: string } }>().grant.id : undefined;
    const sent = await f.app.inject({
      method: "POST",
      url: "/api/agent/tools/marketplace.gmail.send.email",
      headers: f.agent("agent-1"),
      payload: { workspaceSlug: "atlas", pluginId: "gmail-composio", ...(grantId ? { grantId } : {}), input: { recipient_email: "someone@example.invalid", subject: "hi", body: "sent by an agent" } },
    });
    expect(f.composioExecutions, `grant ${grant.statusCode} ${grant.body}\nsend ${sent.statusCode} ${sent.body}`).toEqual([]);
    expect(sent.statusCode).not.toBe(200);
  });

  it("F3-4: a custom MCP tool the server marks readOnlyHint:true reaches the server only through the owner", async () => {
    // The server, not the owner, says "read-only". Only the owner may make a custom MCP tool read-only (Marketplace
    // fix: an owner flag, no hint or name). Control (non-blind): through the owner the same call does reach the server
    // once (the owner approves the hold, or, when the agent call is refused outright, the owner's session runs it).
    const server = await startFakeMcpServer({
      tools: [{ name: "send_message", description: "Send a message to a customer.", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } } }, annotations: { readOnlyHint: true } }],
    });
    cleanups.push(() => server.close());
    const f = await ownerMode(["connector.observe", "connector.dispatch"], { mcpOrigin: server.origin });
    const created = await f.app.inject({ method: "POST", url: "/api/marketplace/connectors/custom", headers: f.operator, payload: { displayName: "Support Desk", url: server.streamableUrl, transport: "streamable-http" } });
    expect(created.statusCode, created.body).toBe(201);
    const pluginId = created.json<{ connector: { pluginId: string } }>().connector.pluginId;
    expect((await f.app.inject({ method: "POST", url: `/api/marketplace/connectors/custom/${pluginId}/refresh`, headers: f.operator })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url: `/api/marketplace/plugins/${pluginId}/install`, headers: f.operator, payload: {} })).statusCode).toBe(201);
    const toolCalls = () => server.requests.filter((r) => r.rpcMethod === "tools/call").length;
    const input = { to: "customer@example.invalid", text: "sent by an agent" };
    const grant = await f.app.inject({
      method: "POST",
      url: "/api/marketplace/agent/grants",
      headers: f.agent("agent-1"),
      payload: { workspaceSlug: "atlas", pluginId, actionKey: `${pluginId}.send-message`, accountId: "connector", resourceKind: `${pluginId}.connected-account`, resourceRef: "account:connector" },
    });
    const grantId = grant.statusCode === 201 ? grant.json<{ grant: { id: string } }>().grant.id : undefined;
    const sent = await f.app.inject({
      method: "POST",
      url: `/api/agent/tools/marketplace.${pluginId}.send-message`,
      headers: f.agent("agent-1"),
      payload: { workspaceSlug: "atlas", pluginId, ...(grantId ? { grantId } : {}), input },
    });
    const trace = `grant ${grant.statusCode} ${grant.body}\nsend ${sent.statusCode} ${sent.body}`;
    expect(toolCalls(), trace).toBe(0);
    expect(sent.statusCode, trace).not.toBe(200);
    const approvalId = (sent.json() as { approvalId?: string }).approvalId;
    const viaOwner = approvalId
      ? await f.app.inject({ method: "POST", url: `/api/marketplace/company-box/approvals/${approvalId}/approve`, headers: f.operator })
      : await f.app.inject({ method: "POST", url: `/api/marketplace/plugins/${pluginId}/execute`, headers: f.operator, payload: { workspaceSlug: "atlas", capability: "connector.dispatch", action: { type: `${pluginId}.send-message`, ...input } } });
    expect(toolCalls(), `control: through the owner the call reaches the server once\n${trace}\nowner ${viaOwner.statusCode} ${viaOwner.body}`).toBe(1);
  });
});

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FullConfig } from "@playwright/test";

import { buildMarketplaceApp } from "../../src/app.js";
import { MarketplaceOperatorSessionManager } from "../../src/operator-auth.js";
import { MarketplaceProviderSettingsStore } from "../../src/provider-settings.js";
import { SqliteMarketplaceStore } from "../../src/store.js";
import type { MarketplaceListing } from "../../src/types.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:55314";
const opaque = (character: string) => `${character.repeat(42)}0`;

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function json(reply: ServerResponse, status: number, value: unknown) {
  reply.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  reply.end(JSON.stringify(value));
}

function consentFor(request: { requestId: string; deploymentId: string; agentId: string; selection: Record<string, string> }) {
  return {
    schema: 1,
    authorized: true,
    product: "marketplace",
    portalOrgId: "org-1",
    productTenantId: "default",
    workspaceId: "workspace-1",
    deploymentId: request.deploymentId,
    userId: "operator-1",
    agentId: request.agentId,
    consentId: `consent-${request.requestId.slice(0, 8)}`,
    consentRevision: 1,
    state: "active",
    capabilities: ["connector.observe"],
    requiredActions: ["read"],
    selection: request.selection,
  };
}

export default async function globalSetup(config: FullConfig) {
  const baseUrl = new URL(config.projects[0]?.use.baseURL?.toString() ?? DEFAULT_BASE_URL);
  assert.equal(baseUrl.protocol, "http:");
  const requests = new Map<string, { requestId: string; deploymentId: string; agentId: string; selection: Record<string, string>; expiresAt: number; approved: boolean; denied: boolean }>();
  let sequence = 0;
  const portal = createServer(async (request, reply) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/deployment-browser/grant-request") {
      const input = await body(request);
      const requestId = `${"r".repeat(42)}${sequence % 10}`;
      sequence += 1;
      const expiresAt = String(input.agentId) === "agent-expired" ? Date.now() - 1_000 : Date.now() + 600_000;
      requests.set(requestId, { requestId, deploymentId: String(input.deploymentId), agentId: String(input.agentId), selection: input.selection as Record<string, string>, expiresAt, approved: false, denied: false });
      json(reply, 200, { requestId, approvalUrl: `${portalOrigin}/portal?requestId=${requestId}`, expiresAt });
      return;
    }
    if (request.method === "POST" && (url.pathname === "/api/deployment-browser/grant-redeem" || url.pathname === "/api/deployment-browser/grant-receipt")) {
      const input = await body(request);
      const record = requests.get(String(input.requestId));
      if (!record || record.denied || !record.approved) {
        json(reply, 403, { error: "portal_handoff_denied" });
        return;
      }
      json(reply, 200, consentFor(record));
      return;
    }
    if (request.method === "GET" && url.pathname === "/portal") {
      const requestId = url.searchParams.get("requestId") ?? "";
      reply.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      reply.end(`<main><h1>Portal consent review</h1><p>Review request ${requestId}</p><form method="post" action="/portal/approve?requestId=${requestId}"><button>Approve consent</button></form><form method="post" action="/portal/deny?requestId=${requestId}"><button>Deny consent</button></form></main>`);
      return;
    }
    if (request.method === "POST" && (url.pathname === "/portal/approve" || url.pathname === "/portal/deny")) {
      const record = requests.get(url.searchParams.get("requestId") ?? "");
      if (record) {
        record.approved = url.pathname.endsWith("/approve");
        record.denied = !record.approved;
      }
      reply.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      reply.end(`<main><h1>${record?.approved ? "Approved" : "Denied"}</h1><p>Return to Marketplace to reconcile.</p></main>`);
      return;
    }
    json(reply, 404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  const portalAddress = portal.address();
  assert.ok(portalAddress && typeof portalAddress === "object");
  const portalOrigin = `http://127.0.0.1:${portalAddress.port}`;

  const dataDir = await mkdtemp(path.join(tmpdir(), "doppelganger-marketplace-handoff-e2e-"));
  const store = new SqliteMarketplaceStore(path.join(dataDir, "marketplace.sqlite"), { debug: false, logPath: path.join(dataDir, "logs", "marketplace-debug.jsonl") });
  const providerSettings = new MarketplaceProviderSettingsStore(path.join(dataDir, "provider-settings.json"), path.join(dataDir, "provider-secrets.json"), {});
  const listing: MarketplaceListing = store.getListing("github-composio") ?? {
    pluginId: "github-composio",
    displayName: "GitHub",
    kind: "connector",
    provider: "github",
    description: "Paired browser fixture connector.",
    capabilities: ["connector.observe"],
    actions: ["github.list.repositories"],
    source: "composio",
    authOwner: "composio",
    executionOwner: "composio",
    runtimeSources: [{ runtimeSourceId: "composio-github", kind: "composio", label: "Composio" }],
    enabledByDefault: false,
    manifest: { fixture: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.upsertListing(listing);
  store.registerPlugin(listing.pluginId);
  store.install("default", listing.pluginId);
  for (const capability of listing.capabilities) store.bindCapability({ workspaceSlug: "default", pluginId: listing.pluginId, capability, enabled: true });
  for (const actionKey of listing.actions) store.bindAction({ workspaceSlug: "default", pluginId: listing.pluginId, actionKey, enabled: true });
  store.upsertConnection({ workspaceSlug: "default", pluginId: listing.pluginId, provider: "github", backend: "composio", state: "connected", detail: "Paired browser fixture connection", metadata: { connectedAccountId: "ca_1" } });
  store.upsertPortalHandoffSession({ portalIssuer: portalOrigin, deploymentId: "deployment-1", portalOrgId: "org-1", productTenantId: "default", workspaceId: "workspace-1", userId: "operator-1", sessionToken: "s".repeat(43), expiresAt: new Date(Date.now() + 600_000).toISOString() });

  const app = await buildMarketplaceApp({
    store,
    providerSettings,
    organizationId: "default",
    environment: {
      ...process.env,
      NODE_ENV: "test",
      MARKETPLACE_ALLOWED_ORIGINS: baseUrl.origin,
      MARKETPLACE_PUBLIC_ORIGIN: baseUrl.origin,
    },
    internalAuthToken: "marketplace-service-token",
    portalIssuerUrl: portalOrigin,
    portalInstanceProof: "p".repeat(43),
    rulesClient: async () => ({ effect: "allow", decisionId: "browser-fixture-rules-allow" }),
    operatorSessionManager: new MarketplaceOperatorSessionManager({ accessToken: "marketplace-e2e-operator-token", operatorId: "marketplace-e2e-operator", organizationId: "default" }),
    env: { COMPOSIO_API_KEY: "fixture-provider-key" },
  });
  try {
    await app.listen({ host: baseUrl.hostname, port: Number.parseInt(baseUrl.port, 10) });
  } catch (error) {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => portal.close(() => resolve()));
    throw error;
  }
  return async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => portal.close(() => resolve()));
  };
}

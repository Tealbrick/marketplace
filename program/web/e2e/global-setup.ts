import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FullConfig } from "@playwright/test";

import { buildMarketplaceApp } from "../../src/app.js";
import { MarketplaceOperatorSessionManager } from "../../src/operator-auth.js";
import { MarketplaceProviderSettingsStore } from "../../src/provider-settings.js";
import { SqliteMarketplaceStore } from "../../src/store.js";
import { startFakeMcpServer } from "../../src/testing/fake-mcp-server.js";
import { CUSTOM_CONNECTORS_BASE_URL, E2E_MCP_PORT, E2E_MCP_SECRET } from "./fixtures";

const DEFAULT_BASE_URL = "http://127.0.0.1:55314";

async function startCustomConnectorsFixture() {
  const baseUrl = new URL(CUSTOM_CONNECTORS_BASE_URL);
  const mcp = await startFakeMcpServer({
    port: E2E_MCP_PORT,
    requiredHeader: { name: "x-api-key", value: E2E_MCP_SECRET },
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "marketplace-e2e-custom-mcp-"));
  const store = new SqliteMarketplaceStore(path.join(dataDir, "marketplace.sqlite"), {
    debug: false,
    logPath: path.join(dataDir, "logs", "marketplace-debug.jsonl"),
    handoffEncryptionKey: "e".repeat(64),
  });
  const app = await buildMarketplaceApp({
    store,
    providerSettings: new MarketplaceProviderSettingsStore(
      path.join(dataDir, "provider-settings.json"),
      path.join(dataDir, "provider-secrets.json"),
      {},
    ),
    organizationId: "default",
    environment: {
      ...process.env,
      NODE_ENV: "test",
      MARKETPLACE_ALLOWED_ORIGINS: baseUrl.origin,
      MARKETPLACE_PUBLIC_ORIGIN: baseUrl.origin,
      MARKETPLACE_MCP_ALLOWED_ORIGINS: mcp.origin,
    },
    operatorSessionManager: new MarketplaceOperatorSessionManager({
      accessToken: "marketplace-e2e-operator-token",
      operatorId: "marketplace-e2e-operator",
      organizationId: "default",
    }),
    rulesClient: async () => ({ effect: "allow", decisionId: "e2e-allow" }),
    env: {},
  });
  try {
    await app.listen({ host: baseUrl.hostname, port: Number.parseInt(baseUrl.port, 10) });
  } catch (error) {
    await app.close();
    store.close();
    await mcp.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    await app.close();
    store.close();
    await mcp.close();
    await rm(dataDir, { recursive: true, force: true });
  };
}

export default async function globalSetup(config: FullConfig) {
  const baseUrl = new URL(config.projects[0]?.use.baseURL?.toString() ?? DEFAULT_BASE_URL);
  assert.equal(baseUrl.protocol, "http:", "Marketplace E2E fixture server must use HTTP");
  assert.ok(
    baseUrl.hostname === "127.0.0.1" || baseUrl.hostname === "localhost",
    "Marketplace E2E fixture server must remain on loopback",
  );

  const dataDir = await mkdtemp(path.join(tmpdir(), "tealbrick-marketplace-e2e-"));
  const store = new SqliteMarketplaceStore(path.join(dataDir, "marketplace.sqlite"), {
    debug: false,
    logPath: path.join(dataDir, "logs", "marketplace-debug.jsonl"),
  });
  const providerSettings = new MarketplaceProviderSettingsStore(
    path.join(dataDir, "provider-settings.json"),
    path.join(dataDir, "provider-secrets.json"),
    {},
  );
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
    operatorSessionManager: new MarketplaceOperatorSessionManager({
      accessToken: "marketplace-e2e-operator-token",
      operatorId: "marketplace-e2e-operator",
      organizationId: "default",
    }),
    env: {},
  });

  try {
    await app.listen({
      host: baseUrl.hostname,
      port: Number.parseInt(baseUrl.port, 10),
    });
  } catch (error) {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  let closeCustomConnectors: () => Promise<void>;
  try {
    closeCustomConnectors = await startCustomConnectorsFixture();
  } catch (error) {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  return async () => {
    await closeCustomConnectors();
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  };
}

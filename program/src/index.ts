import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildMarketplaceApp } from "./app.js";
import { loadConfig } from "./config.js";
import { makeRulesClient } from "./rules-client.js";
import { MarketplaceProviderSettingsStore } from "./provider-settings.js";
import { SqliteMarketplaceStore } from "./store.js";

const config = loadConfig();
const store = new SqliteMarketplaceStore(config.dbPath, {
  handoffEncryptionKey: config.handoffEncryptionKey,
});
const providerSettings = new MarketplaceProviderSettingsStore(
  config.settingsPath,
  config.secretsPath,
);
const app = await buildMarketplaceApp({
  store,
  internalAuthToken: config.internalAuthToken,
  rulesClient: makeRulesClient(config),
  rules: config.rules,
  providerSettings,
});

const address = await app.listen({ host: config.host, port: config.port });
const readyPayload = {
  event: "marketplace.ready",
  baseUrl: address,
  pluginId: "marketplace",
  sidecarId: "marketplace-program",
};

const runtimeFilePath = process.env.DOPPELGANGER_RUNTIME_FILE?.trim();

if (runtimeFilePath) {
  await mkdir(path.dirname(runtimeFilePath), { recursive: true });
  await writeFile(runtimeFilePath, `${JSON.stringify(readyPayload)}\n`);
}

console.log(JSON.stringify(readyPayload));
console.log(`Marketplace Program listening at ${address}`);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await app.close();
  store.close();
  if (runtimeFilePath) {
    await rm(runtimeFilePath, { force: true });
  }
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

import os from "node:os";
import path from "node:path";

import type { RulesReadinessConfiguration } from "./rules-readiness.js";

export type MarketplaceConfig = {
  host: string;
  port: number;
  dbPath: string;
  handoffEncryptionKey?: string;
  internalAuthToken?: string;
  settingsPath: string;
  secretsPath: string;
  rules?: RulesReadinessConfiguration;
};

function numberFromEnv(value: string | undefined, fallback: number) {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): MarketplaceConfig {
  const productWorkspaceDir =
    env.DOPPELGANGER_PRODUCT_WORKSPACE_DIR?.trim() || env.PRODUCT_WORKSPACE_DIR?.trim();
  const dataDir =
    env.MARKETPLACE_DATA_DIR?.trim() ||
    (productWorkspaceDir ? path.join(productWorkspaceDir, "data") : undefined) ||
    path.join(os.homedir(), ".doppelganger", "programs", "marketplace", "data");
  const dbPath =
    env.MARKETPLACE_DATABASE_PATH?.trim() ||
    path.join(dataDir, "marketplace.sqlite");
  return {
    host: env.MARKETPLACE_HOST?.trim() || "127.0.0.1",
    port: numberFromEnv(env.MARKETPLACE_PORT, 0),
    dbPath,
    ...(env.MARKETPLACE_HANDOFF_ENCRYPTION_KEY?.trim()
      ? { handoffEncryptionKey: env.MARKETPLACE_HANDOFF_ENCRYPTION_KEY.trim() }
      : {}),
    settingsPath:
      env.MARKETPLACE_SETTINGS_PATH?.trim() ||
      path.join(path.dirname(dbPath), "provider-settings.json"),
    secretsPath:
      env.MARKETPLACE_SECRETS_PATH?.trim() ||
      path.join(path.dirname(dbPath), "provider-secrets.json"),
    ...(env.MARKETPLACE_INTERNAL_AUTH_TOKEN?.trim()
      ? { internalAuthToken: env.MARKETPLACE_INTERNAL_AUTH_TOKEN.trim() }
      : env.DOPPELGANGER_MARKETPLACE_INTERNAL_AUTH_TOKEN?.trim()
        ? {
            internalAuthToken:
              env.DOPPELGANGER_MARKETPLACE_INTERNAL_AUTH_TOKEN.trim(),
          }
        : {}),
    ...(env.RULES_BASE_URL?.trim()
      ? {
          rules: {
            baseUrl: env.RULES_BASE_URL.trim(),
            ...(env.RULES_INTERNAL_AUTH_TOKEN?.trim()
              ? { internalAuthToken: env.RULES_INTERNAL_AUTH_TOKEN.trim() }
              : {}),
            ...(env.RULES_COMPANY_ID?.trim()
              ? { companyId: env.RULES_COMPANY_ID.trim() }
              : {}),
          },
        }
      : {}),
  };
}

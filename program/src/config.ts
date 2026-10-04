import path from "node:path";

import { readCompatEnv, resolveDefaultStateRoot, type Warn } from "./legacy-ids.js";
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

export type LoadConfigOptions = {
  /** Home directory for the default state root (tests pass a temp dir). */
  homeDir?: string;
  /**
   * Move a legacy `~/.doppelganger/programs/marketplace` state root to
   * `~/.tealbrick/programs/marketplace` when only the legacy one exists.
   * Only the server entrypoint opts in; other callers resolve read-only.
   */
  migrateLegacyStateDir?: boolean;
  warn?: Warn;
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): MarketplaceConfig {
  const productWorkspaceDir =
    readCompatEnv(env, "PRODUCT_WORKSPACE_DIR", options.warn) ||
    env.PRODUCT_WORKSPACE_DIR?.trim();
  const dataDir =
    env.MARKETPLACE_DATA_DIR?.trim() ||
    (productWorkspaceDir ? path.join(productWorkspaceDir, "data") : undefined) ||
    path.join(
      resolveDefaultStateRoot({
        homeDir: options.homeDir,
        migrate: options.migrateLegacyStateDir === true,
        warn: options.warn,
      }).root,
      "data",
    );
  const internalAuthToken =
    env.MARKETPLACE_INTERNAL_AUTH_TOKEN?.trim() ||
    readCompatEnv(env, "MARKETPLACE_INTERNAL_AUTH_TOKEN", options.warn);
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
    ...(internalAuthToken ? { internalAuthToken } : {}),
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

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProviderEnvironment } from "./provider-health.js";

export type ComposioProviderSettings = {
  composioBaseUrl: string;
  composioDefaultUserId: string;
  composioDefaultConnectedAccountId: string;
};

type SecretDocument = { composioApiKey?: string };

const DEFAULTS: ComposioProviderSettings = {
  composioBaseUrl: "https://backend.composio.dev/api/v3.1",
  composioDefaultUserId: "doppelganger",
  composioDefaultConnectedAccountId: "",
};

async function readDocument(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function atomicPrivateJson(file: string, value: unknown) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

function cleanString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

export class MarketplaceProviderSettingsStore {
  private settings: ComposioProviderSettings = { ...DEFAULTS };
  private secrets: SecretDocument = {};
  readonly settingsPath: string;
  readonly secretsPath: string;
  private readonly bootstrapEnv: ProviderEnvironment;

  constructor(
    settingsPath: string,
    secretsPath: string,
    bootstrapEnv: ProviderEnvironment = process.env,
  ) {
    this.settingsPath = settingsPath;
    this.secretsPath = secretsPath;
    this.bootstrapEnv = bootstrapEnv;
  }

  async load() {
    const [settings, secrets] = await Promise.all([
      readDocument(this.settingsPath),
      readDocument(this.secretsPath),
    ]);
    this.settings = {
      composioBaseUrl:
        cleanString(settings.composioBaseUrl) ||
        cleanString(this.bootstrapEnv.COMPOSIO_BASE_URL) ||
        DEFAULTS.composioBaseUrl,
      composioDefaultUserId:
        cleanString(settings.composioDefaultUserId) ||
        cleanString(this.bootstrapEnv.COMPOSIO_DEFAULT_USER_ID) ||
        DEFAULTS.composioDefaultUserId,
      composioDefaultConnectedAccountId:
        cleanString(settings.composioDefaultConnectedAccountId) ||
        cleanString(this.bootstrapEnv.COMPOSIO_DEFAULT_CONNECTED_ACCOUNT_ID),
    };
    this.secrets = {
      ...(cleanString(secrets.composioApiKey)
        ? { composioApiKey: cleanString(secrets.composioApiKey) }
        : {}),
    };
    return this.safeView();
  }

  environment(): ProviderEnvironment {
    const apiKey = this.secrets.composioApiKey || cleanString(this.bootstrapEnv.COMPOSIO_API_KEY);
    return {
      ...this.bootstrapEnv,
      COMPOSIO_BASE_URL: this.settings.composioBaseUrl,
      COMPOSIO_DEFAULT_USER_ID: this.settings.composioDefaultUserId,
      COMPOSIO_DEFAULT_CONNECTED_ACCOUNT_ID:
        this.settings.composioDefaultConnectedAccountId || undefined,
      COMPOSIO_API_KEY: apiKey || undefined,
    };
  }

  safeView() {
    const persisted = this.secrets.composioApiKey;
    const bootstrap = cleanString(this.bootstrapEnv.COMPOSIO_API_KEY);
    const secret = persisted || bootstrap;
    return {
      ok: true,
      values: { ...this.settings },
      status: {
        composioApiKey: {
          configured: Boolean(secret),
          source: persisted ? "program" : bootstrap ? "bootstrap-environment" : null,
          keyTail: secret ? secret.slice(-4) : null,
          fingerprint: secret
            ? createHash("sha256").update(secret).digest("hex").slice(0, 12)
            : null,
        },
      },
    };
  }

  async update(input: Record<string, unknown>) {
    const nextSettings: ComposioProviderSettings = {
      composioBaseUrl: cleanString(input.composioBaseUrl, this.settings.composioBaseUrl),
      composioDefaultUserId: cleanString(
        input.composioDefaultUserId,
        this.settings.composioDefaultUserId,
      ),
      composioDefaultConnectedAccountId: cleanString(
        input.composioDefaultConnectedAccountId,
        this.settings.composioDefaultConnectedAccountId,
      ),
    };
    const nextSecret = cleanString(input.composioApiKey);
    if (nextSecret && (nextSecret.length > 512 || !/^[\x21-\x7E]+$/u.test(nextSecret))) {
      throw new Error("Composio API key must be printable ASCII without spaces or line breaks.");
    }
    this.settings = nextSettings;
    if (nextSecret) {
      this.secrets = { composioApiKey: nextSecret };
    }
    await atomicPrivateJson(this.settingsPath, this.settings);
    if (nextSecret) {
      await atomicPrivateJson(this.secretsPath, this.secrets);
    }
    return this.safeView();
  }
}

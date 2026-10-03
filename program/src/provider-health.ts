export type ProviderEnvironment = Record<string, string | undefined>;

export type ProviderHealth = {
  state: "healthy" | "degraded" | "missing";
  configured: boolean;
  reachable: boolean;
  mode: "external";
  detail: string;
  env: string[];
  baseUrl: string | null;
  statusCode: number | null;
  checkedAt: string | null;
  error: string | null;
};

type FetchLike = typeof fetch;

function hasValue(env: ProviderEnvironment, key: string) {
  return Boolean(env[key]?.trim());
}

function readUrl(env: ProviderEnvironment, ...keys: string[]) {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value.replace(/\/+$/u, "");
    }
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      /key|token|secret|authorization|credential/iu.test(key) ? "[redacted]" : redactSensitiveFields(entry),
    ]),
  );
}

function baseHealth(input: {
  state: ProviderHealth["state"];
  configured: boolean;
  detail: string;
  env: string[];
  baseUrl: string | null;
}): ProviderHealth {
  return {
    state: input.state,
    configured: input.configured,
    reachable: false,
    mode: "external",
    detail: input.detail,
    env: input.env,
    baseUrl: input.baseUrl,
    statusCode: null,
    checkedAt: null,
    error: null,
  };
}

export function readProviderHealth(env: ProviderEnvironment = process.env): {
  nango: ProviderHealth;
  activepieces: ProviderHealth;
  composio: ProviderHealth;
} {
  const nangoConfigured = hasValue(env, "NANGO_SECRET_KEY");
  const nangoBaseUrl = readUrl(env, "NANGO_BASE_URL", "NANGO_PUBLIC_SERVER_URL");
  const activepiecesConfigured = hasValue(env, "ACTIVEPIECES_BASE_URL") && hasValue(env, "ACTIVEPIECES_API_KEY");
  const activepiecesBaseUrl = readUrl(env, "ACTIVEPIECES_BASE_URL");
  const composioConfigured = hasValue(env, "COMPOSIO_API_KEY");
  const composioBaseUrl = readUrl(env, "COMPOSIO_BASE_URL") ?? (composioConfigured ? "https://backend.composio.dev/api/v3.1" : null);

  return {
    nango: baseHealth({
      state: nangoConfigured ? "degraded" : "missing",
      configured: nangoConfigured,
      detail: nangoConfigured
        ? "Nango credentials are configured; live OAuth health is not proven by this local Program check."
        : nangoBaseUrl
          ? "Nango server is configured but OAuth start/complete flows fail closed until NANGO_SECRET_KEY is provided."
          : "Nango is not configured. OAuth start/complete flows fail closed until NANGO_SECRET_KEY is provided.",
      env: ["NANGO_SECRET_KEY", "NANGO_BASE_URL", "NANGO_PUBLIC_SERVER_URL", "NANGO_PUBLIC_CONNECT_URL"],
      baseUrl: nangoBaseUrl,
    }),
    activepieces: baseHealth({
      state: activepiecesConfigured ? "degraded" : "missing",
      configured: activepiecesConfigured,
      detail: activepiecesConfigured
        ? "Activepieces endpoint credentials are configured; sidecar reachability must be checked before execution."
        : activepiecesBaseUrl
          ? "Activepieces catalog endpoint is configured; pack scaffolding and authenticated execution still require ACTIVEPIECES_API_KEY."
          : "Activepieces is not configured. Pack scaffolding and non-native execution fail closed.",
      env: ["ACTIVEPIECES_BASE_URL", "ACTIVEPIECES_API_KEY", "ACTIVEPIECES_SHARED_SECRET"],
      baseUrl: activepiecesBaseUrl,
    }),
    composio: baseHealth({
      state: composioConfigured ? "degraded" : "missing",
      configured: composioConfigured,
      detail: composioConfigured
        ? "Composio API key is configured; remote catalog/execution health is not proven by this local Program check."
        : "Composio is not configured. Bootstrap catalog import and fallback execution fail closed.",
      env: ["COMPOSIO_API_KEY", "COMPOSIO_BASE_URL", "COMPOSIO_DEFAULT_USER_ID", "COMPOSIO_DEFAULT_CONNECTED_ACCOUNT_ID"],
      baseUrl: composioBaseUrl,
    }),
  };
}

async function probeJson(input: {
  url: string;
  fetchImpl: FetchLike;
  headers?: Record<string, string>;
}): Promise<{ reachable: boolean; statusCode: number | null; error: string | null; json: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await input.fetchImpl(input.url, {
      headers: input.headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { text: text.slice(0, 1000) };
      }
    }
    return {
      reachable: response.status >= 200 && response.status < 500,
      statusCode: response.status,
      error: response.status >= 500 ? response.statusText : null,
      json,
    };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      error: error instanceof Error ? error.message : String(error),
      json: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function withProbe(health: ProviderHealth, probe: { reachable: boolean; statusCode: number | null; error: string | null }) {
  const reachable = probe.reachable;
  return {
    ...health,
    reachable,
    statusCode: probe.statusCode,
    checkedAt: new Date().toISOString(),
    error: probe.error,
    state: reachable && health.configured ? "healthy" : reachable || health.configured ? "degraded" : "missing",
    detail:
      reachable && health.configured
        ? `${health.detail} Reachability probe succeeded.`
        : reachable
          ? `${health.detail} Reachability probe succeeded, but credentials are incomplete.`
          : probe.error
            ? `${health.detail} Reachability probe failed: ${probe.error}`
            : health.detail,
  } satisfies ProviderHealth;
}

export async function readProviderHealthWithReachability(
  env: ProviderEnvironment = process.env,
  fetchImpl: FetchLike = fetch,
) {
  const providers = readProviderHealth(env);

  const [nangoProbe, activepiecesProbe, composioProbe] = await Promise.all([
    providers.nango.baseUrl
      ? probeJson({ url: `${providers.nango.baseUrl}/health`, fetchImpl })
      : Promise.resolve({ reachable: false, statusCode: null, error: null, json: null }),
    providers.activepieces.baseUrl
      ? probeJson({ url: `${providers.activepieces.baseUrl}/api/v1/flags`, fetchImpl })
      : Promise.resolve({ reachable: false, statusCode: null, error: null, json: null }),
    providers.composio.baseUrl && env.COMPOSIO_API_KEY?.trim()
      ? probeJson({
          url: `${providers.composio.baseUrl}/tools?limit=1`,
          fetchImpl,
          headers: { "x-api-key": env.COMPOSIO_API_KEY.trim() },
        })
      : Promise.resolve({ reachable: false, statusCode: null, error: null, json: null }),
  ]);

  return {
    nango: withProbe(providers.nango, nangoProbe),
    activepieces: withProbe(providers.activepieces, activepiecesProbe),
    composio: withProbe(providers.composio, composioProbe),
  };
}

export async function fetchActivepiecesCatalog(
  env: ProviderEnvironment = process.env,
  fetchImpl: FetchLike = fetch,
) {
  const baseUrl = readUrl(env, "ACTIVEPIECES_BASE_URL");
  if (!baseUrl) {
    throw new Error("ACTIVEPIECES_BASE_URL is required for Activepieces catalog fetch.");
  }
  const response = await probeJson({ url: `${baseUrl}/api/v1/pieces`, fetchImpl });
  if (!response.reachable || !Array.isArray(response.json)) {
    throw new Error(response.error ?? `Activepieces catalog fetch failed with status ${response.statusCode ?? "unknown"}.`);
  }
  const items = response.json.map((item) => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      id: String(record.id ?? record.name ?? ""),
      name: String(record.name ?? ""),
      displayName: String(record.displayName ?? record.name ?? ""),
      description: typeof record.description === "string" ? record.description : "",
      version: typeof record.version === "string" ? record.version : null,
      actions: typeof record.actions === "number" ? record.actions : null,
      triggers: typeof record.triggers === "number" ? record.triggers : null,
      categories: Array.isArray(record.categories) ? record.categories.map(String) : [],
      authRequired: Boolean(record.auth),
    };
  });
  return {
    baseUrl,
    total: items.length,
    items,
  };
}

export async function fetchComposioCatalog(
  env: ProviderEnvironment = process.env,
  fetchImpl: FetchLike = fetch,
) {
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is required for Composio catalog fetch.");
  }
  const baseUrl = readUrl(env, "COMPOSIO_BASE_URL") ?? "https://backend.composio.dev/api/v3.1";
  const rawItems: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let reportedTotal: number | null = null;

  do {
    const params = new URLSearchParams({
      limit: "1000",
      sort_by: "usage",
      managed_by: "all",
      include_deprecated: "false",
    });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await probeJson({
      url: `${baseUrl}/toolkits?${params.toString()}`,
      fetchImpl,
      headers: { "x-api-key": apiKey },
    });
    if (
      !response.reachable ||
      response.statusCode === null ||
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      throw new Error(
        response.error ??
          `Composio catalog fetch failed with status ${response.statusCode ?? "unknown"}.`,
      );
    }
    const body = objectValue(response.json) ?? {};
    const pageItems = Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.data)
        ? body.data
        : [];
    rawItems.push(...pageItems);
    if (typeof body.total_items === "number") {
      reportedTotal = body.total_items;
    }
    const nextCursor = stringValue(body.next_cursor ?? body.nextCursor);
    if (!nextCursor || seenCursors.has(nextCursor)) {
      cursor = undefined;
    } else {
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } while (cursor);

  return {
    baseUrl,
    total: reportedTotal ?? rawItems.length,
    items: rawItems,
  };
}

export type ComposioConnectedAccountCatalogItem = {
  id: string;
  toolkit: string;
  status: string;
  disabled: boolean;
  updatedAt: string | null;
  userId: string | null;
};

export async function fetchComposioConnectedAccounts(
  env: ProviderEnvironment = process.env,
  fetchImpl: FetchLike = fetch,
) {
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "COMPOSIO_API_KEY is required for Composio connected-account fetch.",
    );
  }
  const baseUrl =
    readUrl(env, "COMPOSIO_BASE_URL") ??
    "https://backend.composio.dev/api/v3.1";
  const items: ComposioConnectedAccountCatalogItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: "1000" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await probeJson({
      url: `${baseUrl}/connected_accounts?${params.toString()}`,
      fetchImpl,
      headers: { "x-api-key": apiKey },
    });
    if (
      !response.reachable ||
      response.statusCode === null ||
      response.statusCode < 200 ||
      response.statusCode >= 300
    ) {
      throw new Error(
        response.error ??
          `Composio connected-account fetch failed with status ${response.statusCode ?? "unknown"}.`,
      );
    }
    const body = objectValue(response.json) ?? {};
    const pageItems = Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.data)
        ? body.data
        : [];
    for (const rawItem of pageItems) {
      const item = objectValue(rawItem) ?? {};
      const toolkit = objectValue(item.toolkit);
      const id = stringValue(item.id);
      const toolkitSlug = stringValue(toolkit?.slug ?? item.toolkit_slug);
      if (!id || !toolkitSlug) {
        continue;
      }
      items.push({
        id,
        toolkit: toolkitSlug.toLowerCase(),
        status: stringValue(item.status) ?? "UNKNOWN",
        disabled: item.is_disabled === true,
        updatedAt: stringValue(item.updated_at) ?? null,
        userId: stringValue(item.user_id) ?? null,
      });
    }
    const nextCursor = stringValue(body.next_cursor ?? body.nextCursor);
    if (!nextCursor || seenCursors.has(nextCursor)) {
      cursor = undefined;
    } else {
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } while (cursor);

  return { baseUrl, items };
}

export async function fetchComposioToolkitTools(
  input: {
    toolkit: string;
    env?: ProviderEnvironment;
    fetchImpl?: FetchLike;
    limit?: number;
  },
) {
  const env = input.env ?? process.env;
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is required for Composio toolkit fetch.");
  }
  const baseUrl = readUrl(env, "COMPOSIO_BASE_URL") ?? "https://backend.composio.dev/api/v3.1";
  const params = new URLSearchParams({
    toolkit_slug: input.toolkit,
    toolkit_versions: "latest",
    limit: String(Math.max(1, Math.min(input.limit ?? 100, 1000))),
  });
  const response = await probeJson({
    url: `${baseUrl}/tools?${params.toString()}`,
    fetchImpl: input.fetchImpl ?? fetch,
    headers: { "x-api-key": apiKey },
  });
  if (!response.reachable || response.statusCode === null || response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(response.error ?? `Composio toolkit fetch failed with status ${response.statusCode ?? "unknown"}.`);
  }
  const body = objectValue(response.json) ?? {};
  const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.data) ? body.data : [];
  return {
    baseUrl,
    toolkit: input.toolkit,
    total: rawItems.length,
    items: rawItems,
  };
}

export type ComposioAuthLinkResult = {
  authConfigId: string;
  connectedAccountId: string | null;
  redirectUrl: string | null;
  status: string;
  upstream: unknown;
};

export async function createComposioAuthLink(input: {
  toolkit: string;
  state: string;
  callbackUrl: string;
  env?: ProviderEnvironment;
  fetchImpl?: FetchLike;
  authConfigId?: string;
  userId?: string;
  alias?: string;
  connectionData?: Record<string, unknown>;
  authSchemes?: readonly string[];
  managedAuthSchemes?: readonly string[];
  noAuth?: boolean;
}): Promise<ComposioAuthLinkResult> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is required for Composio auth links.");
  }
  const baseUrl = readUrl(env, "COMPOSIO_BASE_URL") ?? "https://backend.composio.dev/api/v3.1";
  const connectBaseUrl =
    readUrl(env, "COMPOSIO_CONNECT_BASE_URL") ??
    baseUrl.replace(/\/v3\.1$/u, "/v3");
  const authConfigId = input.authConfigId?.trim() || await getOrCreateComposioAuthConfig({
    baseUrl,
    apiKey,
    toolkit: input.toolkit,
    fetchImpl,
    authSchemes: input.authSchemes,
    managedAuthSchemes: input.managedAuthSchemes,
    noAuth: input.noAuth,
  });
  const body = dropUndefined({
    auth_config_id: authConfigId,
    user_id: input.userId?.trim() || env.COMPOSIO_DEFAULT_USER_ID?.trim() || "doppelganger",
    alias: input.alias?.trim(),
    callback_url: input.callbackUrl,
    connection_data: {
      ...(input.connectionData ?? {}),
      state_prefix: input.state,
    },
  });
  const response = await postComposioJson({
    url: `${connectBaseUrl}/connected_accounts/link`,
    apiKey,
    fetchImpl,
    body,
  });
  const record = objectValue(response) ?? {};
  const connectedAccountId =
    stringValue(record.connected_account_id) ??
    stringValue(record.connectedAccountId) ??
    stringValue(record.connection_id) ??
    stringValue(record.id) ??
    null;
  const redirectUrl =
    stringValue(record.redirect_url) ??
    stringValue(record.redirectUrl) ??
    stringValue(record.url) ??
    stringValue(record.link) ??
    null;

  return {
    authConfigId,
    connectedAccountId,
    redirectUrl,
    status: stringValue(record.status) ?? (redirectUrl ? "PENDING" : "UNKNOWN"),
    upstream: redactSensitiveFields(response),
  };
}

export async function executeComposioTool(input: {
  toolName: string;
  arguments: Record<string, unknown>;
  connectedAccountId?: string;
  userId?: string;
  env?: ProviderEnvironment;
  fetchImpl?: FetchLike;
}) {
  const env = input.env ?? process.env;
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is required for Composio tool execution.");
  }
  const baseUrl = readUrl(env, "COMPOSIO_EXECUTE_BASE_URL") ?? "https://backend.composio.dev/api/v3";
  const body = dropUndefined({
    user_id: input.userId?.trim() || env.COMPOSIO_DEFAULT_USER_ID?.trim() || "doppelganger",
    connected_account_id: input.connectedAccountId?.trim() || env.COMPOSIO_DEFAULT_CONNECTED_ACCOUNT_ID?.trim(),
    version: "latest",
    arguments: input.arguments,
  });
  return postComposioJson({
    url: `${baseUrl}/tools/execute/${encodeURIComponent(input.toolName)}`,
    apiKey,
    fetchImpl: input.fetchImpl ?? fetch,
    body,
  });
}

async function getOrCreateComposioAuthConfig(input: {
  baseUrl: string;
  apiKey: string;
  toolkit: string;
  fetchImpl: FetchLike;
  authSchemes?: readonly string[];
  managedAuthSchemes?: readonly string[];
  noAuth?: boolean;
}): Promise<string> {
  if (input.noAuth) {
    throw new Error(`Composio toolkit ${input.toolkit} does not require an auth configuration.`);
  }
  const authSchemes = (input.authSchemes ?? []).map((scheme) =>
    scheme.trim().toUpperCase(),
  );
  const managedAuthSchemes = (input.managedAuthSchemes ?? []).map((scheme) =>
    scheme.trim().toUpperCase(),
  );
  const customAuthScheme = authSchemes.find((scheme) =>
    ["API_KEY", "BEARER_TOKEN", "BASIC"].includes(scheme),
  );
  const usesManagedAuth = managedAuthSchemes.length > 0 || authSchemes.length === 0;
  if (!usesManagedAuth && !customAuthScheme) {
    throw new Error(
      `Composio toolkit ${input.toolkit} requires custom ${authSchemes.join(", ") || "authentication"} configuration before it can be connected.`,
    );
  }
  const params = new URLSearchParams({
    toolkit_slug: input.toolkit,
    is_composio_managed: String(usesManagedAuth),
    limit: "100",
  });
  const existingResponse = await probeJson({
    url: `${input.baseUrl}/auth_configs?${params.toString()}`,
    fetchImpl: input.fetchImpl,
    headers: { "x-api-key": input.apiKey },
  });
  const existing = authConfigIdFromPayload(existingResponse.json, input.toolkit);
  if (existing) {
    return existing;
  }

  const created = await postComposioJson({
    url: `${input.baseUrl}/auth_configs`,
    apiKey: input.apiKey,
    fetchImpl: input.fetchImpl,
    body: {
      toolkit: { slug: input.toolkit },
      auth_config: usesManagedAuth
        ? {
            type: "use_composio_managed_auth",
            credentials: {},
            restrict_to_following_tools: [],
          }
        : {
            type: "use_custom_auth",
            authScheme: customAuthScheme,
            credentials: {},
            restrict_to_following_tools: [],
          },
    },
  });
  const createdId = authConfigIdFromPayload(created, input.toolkit);
  if (!createdId) {
    throw new Error(`Composio auth config creation for ${input.toolkit} did not return an id.`);
  }
  return createdId;
}

async function postComposioJson(input: {
  url: string;
  apiKey: string;
  fetchImpl: FetchLike;
  body: unknown;
}): Promise<unknown> {
  const response = await input.fetchImpl(input.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": input.apiKey,
    },
    body: JSON.stringify(input.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    throw new Error(`Composio request failed with status ${response.status}: ${JSON.stringify(redactSensitiveFields(payload))}`);
  }
  return payload;
}

function authConfigIdFromPayload(payload: unknown, toolkit: string): string | null {
  const record = objectValue(payload);
  const direct =
    stringValue(record?.id) ??
    stringValue(record?.nanoid) ??
    stringValue(record?.nanoId);
  if (direct) {
    return direct;
  }
  const nested = objectValue(record?.auth_config) ?? objectValue(record?.authConfig);
  const nestedId =
    stringValue(nested?.id) ??
    stringValue(nested?.nanoid) ??
    stringValue(nested?.nanoId);
  if (nestedId) {
    return nestedId;
  }
  const items = Array.isArray(record?.items) ? record.items : Array.isArray(record?.data) ? record.data : [];
  for (const item of items) {
    const itemRecord = objectValue(item);
    const itemToolkit = objectValue(itemRecord?.toolkit);
    const slug = stringValue(itemToolkit?.slug) ?? toolkit;
    if (slug !== toolkit) {
      continue;
    }
    const itemId =
      stringValue(itemRecord?.id) ??
      stringValue(itemRecord?.nanoid) ??
      stringValue(itemRecord?.nanoId);
    if (itemId) {
      return itemId;
    }
  }
  return null;
}

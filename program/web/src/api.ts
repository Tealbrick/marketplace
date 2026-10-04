import type { AuditResponse, CardDetailResponse, CardsResponse, CardsSummaryResponse, CustomConnector, CustomConnectorCreate, CustomConnectorPatch, CustomConnectorsResponse, FrontendBootstrap, OperatorSession, ProviderSettings, RuntimeHealth } from "./types";

let operatorCsrfToken: string | null = null;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export async function api<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(route, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && operatorCsrfToken
        ? { "x-csrf-token": operatorCsrfToken }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
    if (response.status === 401 && route !== "/api/marketplace/auth/session") {
      operatorCsrfToken = null;
      window.dispatchEvent(new Event("marketplace-auth-expired"));
    }
    throw new ApiError(String(record?.detail ?? record?.error ?? response.statusText), response.status, body);
  }
  return body as T;
}

export async function getOperatorSession() {
  const result = await api<{ session: OperatorSession }>("/api/marketplace/auth/session");
  operatorCsrfToken = result.session.csrfToken;
  return result;
}

export async function unlockOperator(accessToken: string) {
  const result = await api<{ session: OperatorSession }>("/api/marketplace/auth/session", {
    method: "POST",
    body: JSON.stringify({ accessToken }),
  });
  operatorCsrfToken = result.session.csrfToken;
  return result;
}

export async function logoutOperator() {
  await api<void>("/api/marketplace/auth/session", { method: "DELETE" });
  operatorCsrfToken = null;
}

const workspaceQuery = (workspaceSlug: string) => `workspaceSlug=${encodeURIComponent(workspaceSlug)}`;

export async function getBootstrap(): Promise<FrontendBootstrap> {
  try {
    return await api<FrontendBootstrap>("/bootstrap.json");
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    return {
      program: { id: "marketplace", name: "Marketplace", version: "unknown" },
      authorization: {
        browserOperatorRoutes: "rules-governed-local-program",
        hubRoutesRequireBearer: true,
        crossAppRoutesRequireBearer: true,
        credentialExposedToBrowser: false,
        operatorSessionRequired: true,
      },
      surfaces: { standalone: "/", embed: "/embed", openapi: "/openapi.json" },
      contractGaps: {
        browserEnableDisable: "hub-auth-required",
        browserMcpCrud: "remote-only",
        runtimeAdapterExecution: "composio-and-custom-mcp",
      },
    };
  }
}
export const getCards = (workspaceSlug: string) => api<CardsResponse>(`/api/marketplace/cards?${workspaceQuery(workspaceSlug)}`);
export const getCardSummaries = (input: { workspaceSlug: string; search: string; source: string; installed: boolean; offset: number; limit: number }) => {
  const query = new URLSearchParams({
    workspaceSlug: input.workspaceSlug,
    search: input.search,
    source: input.source,
    installed: String(input.installed),
    offset: String(input.offset),
    limit: String(input.limit),
  });
  return api<CardsSummaryResponse>(`/api/marketplace/cards/summary?${query.toString()}`);
};
export const getCardDetail = (pluginId: string, workspaceSlug: string) =>
  api<CardDetailResponse>(`/api/marketplace/cards/${encodeURIComponent(pluginId)}?${workspaceQuery(workspaceSlug)}`);
export const getAudit = (workspaceSlug: string) => api<AuditResponse>(`/api/marketplace/audit?${workspaceQuery(workspaceSlug)}&limit=100`);
export const getLiveness = () => api<{ ok: boolean; status: string }>("/healthz");
export const getRuntimeHealth = () => api<RuntimeHealth>("/api/marketplace/health");
export const getOpenApi = () => api<Record<string, unknown>>("/openapi.json");
export const getProviderSettings = () => api<ProviderSettings>("/api/settings/providers/composio");
export const getAgentCapabilities = (workspaceSlug: string) => api<{ workspaceSlug: string; capabilities: Array<Record<string, unknown>> }>(`/api/agent/capabilities?${workspaceQuery(workspaceSlug)}`);

const lifecycle = (pluginId: string, action: "install" | "uninstall" | "register" | "unregister", workspaceSlug: string) =>
  api<Record<string, unknown>>(`/api/marketplace/plugins/${encodeURIComponent(pluginId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({ workspaceSlug, actorId: "operator" }),
  });

export const installPlugin = (pluginId: string, workspaceSlug: string) => lifecycle(pluginId, "install", workspaceSlug);
export const uninstallPlugin = (pluginId: string, workspaceSlug: string) => lifecycle(pluginId, "uninstall", workspaceSlug);
export const registerPlugin = (pluginId: string, workspaceSlug: string) => lifecycle(pluginId, "register", workspaceSlug);
export const unregisterPlugin = (pluginId: string, workspaceSlug: string) => lifecycle(pluginId, "unregister", workspaceSlug);

// Only Composio-backed connectors can be connected from the browser in this
// launch profile; the Connect action is disabled for every other source.
export const connectPlugin = (pluginId: string, workspaceSlug: string, provider: string) =>
  api<{ auth?: { redirectUrl?: string | null }; connection?: Record<string, unknown> }>(`/api/marketplace/plugins/${encodeURIComponent(pluginId)}/connection`, {
    method: "POST",
    body: JSON.stringify({ workspaceSlug, actorId: "operator", provider, backend: "composio" }),
  });

export const bindAction = (pluginId: string, workspaceSlug: string, actionKey: string, enabled: boolean) =>
  api<Record<string, unknown>>(`/api/marketplace/plugins/${encodeURIComponent(pluginId)}/action-binding`, {
    method: "POST",
    body: JSON.stringify({ workspaceSlug, actorId: "operator", actionKey, enabled }),
  });

export const executeAction = (pluginId: string, workspaceSlug: string, capability: string, action: Record<string, unknown>) =>
  api<Record<string, unknown>>(`/api/marketplace/plugins/${encodeURIComponent(pluginId)}/execute`, {
    method: "POST",
    body: JSON.stringify({ workspaceSlug, actorId: "operator", capability, action }),
  });

export const saveProviderSettings = (settings: ProviderSettings["values"] & { composioApiKey?: string }) =>
  api<ProviderSettings>("/api/settings/providers/composio", { method: "PUT", body: JSON.stringify({ settings }) });

export const testProviderKey = (composioApiKey?: string) =>
  api<{ ok: true; status: "valid"; checkedAt: string }>("/api/settings/providers/composio/test", {
    method: "POST",
    body: JSON.stringify(composioApiKey ? { composioApiKey } : {}),
  });

export const removeProviderKey = () =>
  api<ProviderSettings & { removed: boolean }>("/api/settings/providers/composio/key", { method: "DELETE" });

// Custom MCP connectors. The workspace comes from the operator session, so
// no workspaceSlug is sent. Secret values go up once and never come back.
const customConnectorRoute = (pluginId?: string, suffix = "") =>
  `/api/marketplace/connectors/custom${pluginId ? `/${encodeURIComponent(pluginId)}` : ""}${suffix}`;

export const getCustomConnectors = () => api<CustomConnectorsResponse>(customConnectorRoute());

export const createCustomConnector = (input: CustomConnectorCreate) =>
  api<{ ok: true; connector: CustomConnector }>(customConnectorRoute(), { method: "POST", body: JSON.stringify(input) });

export const updateCustomConnector = (pluginId: string, patch: CustomConnectorPatch) =>
  api<{ ok: true; connector: CustomConnector }>(customConnectorRoute(pluginId), { method: "PATCH", body: JSON.stringify(patch) });

export const deleteCustomConnector = (pluginId: string) =>
  api<{ ok: true; pluginId: string; deleted: true }>(customConnectorRoute(pluginId), { method: "DELETE" });

export const refreshCustomConnector = (pluginId: string) =>
  api<{ ok: true; connector: CustomConnector }>(customConnectorRoute(pluginId, "/refresh"), { method: "POST" });

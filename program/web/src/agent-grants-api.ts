import { api } from "./api";
import type {
  AgentActionCatalogResponse,
  AgentApprovalMode,
  AgentModesResponse,
  AgentModeView,
  AgentGrantRequestResponse,
  AgentGrantRedeemResponse,
  AgentGrantSelection,
  AgentGrantsResponse,
  ChannelGrantSelection,
} from "./types";

export const getAgentGrants = (workspaceSlug: string) => {
  const query = new URLSearchParams({ workspaceSlug });
  return api<AgentGrantsResponse>(`/api/marketplace/agent/grants?${query.toString()}`);
};

export const getAgentActionCatalog = (workspaceSlug: string) => {
  const query = new URLSearchParams({ workspaceSlug });
  return api<AgentActionCatalogResponse>(`/api/marketplace/v1/agent/action-catalog?${query.toString()}`);
};

export const requestAgentGrant = (input: {
  deploymentId: string;
  agentId: string;
  /** A connector action, or a channel class selection ("Grant to agent" from Channels). */
  selection: AgentGrantSelection | ChannelGrantSelection;
  idempotencyKey: string;
}) =>
  api<AgentGrantRequestResponse>("/api/marketplace/v1/agent/grants/request", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const redeemAgentGrant = (input: { deploymentId: string; requestId: string }) =>
  api<AgentGrantRedeemResponse>("/api/marketplace/v1/agent/grants/redeem", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const revokeAgentGrant = (grantId: string) =>
  api<{ ok: true; traceId: string; grant: Record<string, unknown> | null }>(
    `/api/marketplace/agent/grants/${encodeURIComponent(grantId)}/revoke`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const getAgentModes = () => api<AgentModesResponse>("/api/marketplace/agents");

export const updateAgentMode = (agentId: string, body: { mode?: AgentApprovalMode; dailyCap?: number | null; connectorDailyCap?: number | null }) =>
  api<{ ok: true; agent: AgentModeView }>(`/api/marketplace/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: JSON.stringify(body) });

export const setAgentPaused = (agentId: string, paused: boolean) =>
  api<{ ok: true; agent: AgentModeView }>(`/api/marketplace/agents/${encodeURIComponent(agentId)}/${paused ? "pause" : "resume"}`, { method: "POST", body: JSON.stringify({}) });

export const setAllAgentsPaused = (paused: boolean) =>
  api<AgentModesResponse>(`/api/marketplace/agents/${paused ? "pause-all" : "resume-all"}`, { method: "POST", body: JSON.stringify({}) });

export const setHoldFamily = (familyId: string, on: boolean) =>
  api<AgentModesResponse>(`/api/marketplace/agents/hold-families/${encodeURIComponent(familyId)}`, { method: "PATCH", body: JSON.stringify({ on }) });

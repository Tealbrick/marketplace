import { api } from "./api";
import type {
  AgentGrantRequestResponse,
  AgentGrantRedeemResponse,
  AgentGrantSelection,
  AgentGrantsResponse,
} from "./types";

export const getAgentGrants = (workspaceSlug: string) => {
  const query = new URLSearchParams({ workspaceSlug });
  return api<AgentGrantsResponse>(`/api/marketplace/agent/grants?${query.toString()}`);
};

export const requestAgentGrant = (input: {
  deploymentId: string;
  agentId: string;
  selection: AgentGrantSelection;
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

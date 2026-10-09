import { api, ApiError } from "./api";
import type {
  ChannelCreateInput,
  ChannelDiscoverResponse,
  ChannelPolicyInput,
  ChannelProviderId,
  ChannelReceipt,
  ChannelReceiptExport,
  ChannelsBrowseResponse,
  ChannelView,
  GrantTerms,
  StandingGrantView,
} from "./types";

// Owner channel operations (`audience: owner`). The workspace comes from the
// operator session; the shared `api` helper adds the CSRF header. Bot tokens
// are never part of any request or response here.
const ROOT = "/api/marketplace/channels";
const channelRoute = (channelId: string, suffix = "") => `${ROOT}/${encodeURIComponent(channelId)}${suffix}`;
const grantRoute = (grantId: string, verb: string) => `${ROOT}/grants/${encodeURIComponent(grantId)}/${verb}`;

export function newChannelKey(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 100);
}

export const getChannels = () => api<ChannelsBrowseResponse>(ROOT);

export const discoverChannels = (provider: ChannelProviderId) =>
  api<ChannelDiscoverResponse>(`${ROOT}/discover?provider=${encodeURIComponent(provider)}`);

export const createChannel = (input: ChannelCreateInput, idempotencyKey: string) =>
  api<{ ok: true; channel: ChannelView }>(ROOT, { method: "POST", body: JSON.stringify(input), headers: { "idempotency-key": idempotencyKey } });

export const updateChannel = (
  channelId: string,
  patch: { label?: string; audience?: string; language?: string; purpose?: string; policy?: ChannelPolicyInput; expectRevision?: number },
) => api<{ ok: true; channel: ChannelView; suspendedGrants: StandingGrantView[] }>(channelRoute(channelId), { method: "PATCH", body: JSON.stringify(patch) });

export const setChannelStatus = (channelId: string, verb: "pause" | "resume" | "archive") =>
  api<{ ok: true; channel: ChannelView; suspendedGrants?: StandingGrantView[] }>(channelRoute(channelId, `/${verb}`), { method: "POST", body: JSON.stringify({}) });

export type ChannelSendAnswer = { ok: boolean; receipt?: ChannelReceipt; error?: string; replayed?: boolean };

/** Sends the fixed test text. A failed or uncertain send still answers with its receipt (HTTP 502). */
export async function sendChannelTest(channelId: string, idempotencyKey: string): Promise<ChannelSendAnswer> {
  try {
    return await api<ChannelSendAnswer>(channelRoute(channelId, "/test"), { method: "POST", body: JSON.stringify({}), headers: { "idempotency-key": idempotencyKey } });
  } catch (error) {
    const body = error instanceof ApiError && error.body && typeof error.body === "object" ? (error.body as ChannelSendAnswer) : null;
    if (body?.receipt) return { ...body, ok: false };
    throw error;
  }
}

export const approveGrant = (grantId: string, final?: GrantTerms) =>
  api<{ ok: true; grant: StandingGrantView }>(grantRoute(grantId, "approve"), { method: "POST", body: JSON.stringify(final ? { final } : {}) });

export const declineGrant = (grantId: string) =>
  api<{ ok: true; grant: StandingGrantView }>(grantRoute(grantId, "decline"), { method: "POST", body: JSON.stringify({}) });

export const revokeGrant = (grantId: string) =>
  api<{ ok: true; grant: StandingGrantView }>(grantRoute(grantId, "revoke"), { method: "POST", body: JSON.stringify({}) });

export const resolveChannelPost = (postId: string, status: "sent" | "failed") =>
  api<{ ok: true; post: { id: string; status: string }; receipt?: ChannelReceipt }>(`${ROOT}/posts/${encodeURIComponent(postId)}/resolve`, { method: "POST", body: JSON.stringify({ status }) });

export const exportChannelReceipts = (input: { channelId?: string; limit?: number } = {}) => {
  const query = new URLSearchParams({ limit: String(input.limit ?? 1000) });
  if (input.channelId) query.set("channelId", input.channelId);
  return api<{ ok: true; receipts: ChannelReceiptExport[] }>(`${ROOT}/receipts/export?${query.toString()}`);
};

export const purgeChannelReceipts = (olderThanDays: number) =>
  api<{ ok: true; purged: number; before: string }>(`${ROOT}/receipts/purge`, { method: "POST", body: JSON.stringify({ olderThanDays }) });

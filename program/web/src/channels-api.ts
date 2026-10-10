import { api, ApiError } from "./api";
import type {
  BuzzIdentityResponse,
  ChannelCreateInput,
  ChannelDiscoverResponse,
  ChannelPolicyInput,
  ChannelProviderId,
  ChannelReceipt,
  ChannelReceiptExport,
  ChannelPostStatus,
  ChannelPostSummary,
  ChannelsBrowseAnswer,
  ChannelPersonView,
  ChannelView,
  GrantTerms,
  LiveGrantView,
  LiveOverview,
  LiveSessionView,
  LiveTranscriptLine,
  PeoplePolicyMode,
  PeoplePolicyView,
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

export const getChannels = () => api<ChannelsBrowseAnswer>(ROOT);

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

/** Waiting posts (default held, scheduled and uncertain), soonest first; never the text. */
export const listChannelPosts = (input: { statuses?: ChannelPostStatus[]; channelId?: string; limit?: number } = {}) => {
  const query = new URLSearchParams({ limit: String(input.limit ?? 100) });
  if (input.statuses?.length) query.set("status", input.statuses.join(","));
  if (input.channelId) query.set("channelId", input.channelId);
  return api<{ ok: true; posts: ChannelPostSummary[] }>(`${ROOT}/posts?${query.toString()}`);
};

/** Cancels a scheduled post (waiting for approval or for its send time). Cancelling only narrows. */
export const cancelChannelPost = (postId: string) =>
  api<{ ok: true; receipt?: ChannelReceipt; replayed?: boolean }>(`${ROOT}/posts/${encodeURIComponent(postId)}/cancel`, { method: "POST", body: JSON.stringify({}) });

export const exportChannelReceipts = (input: { channelId?: string; limit?: number } = {}) => {
  const query = new URLSearchParams({ limit: String(input.limit ?? 1000) });
  if (input.channelId) query.set("channelId", input.channelId);
  return api<{ ok: true; receipts: ChannelReceiptExport[] }>(`${ROOT}/receipts/export?${query.toString()}`);
};

export const purgeChannelReceipts = (olderThanDays: number) =>
  api<{ ok: true; purged: number; before: string }>(`${ROOT}/receipts/purge`, { method: "POST", body: JSON.stringify({ olderThanDays }) });

// ----- Buzz identity (owner). The agent secret key never travels: only the npub, relay URL and NIP-OA tag do.
const BUZZ_IDENTITY = `${ROOT}/buzz/identity`;

export const getBuzzIdentity = () => api<BuzzIdentityResponse>(BUZZ_IDENTITY);

export const generateBuzzKey = (rotate: boolean) =>
  api<BuzzIdentityResponse>(`${BUZZ_IDENTITY}/key`, { method: "POST", body: JSON.stringify(rotate ? { rotate: true } : {}) });

export const updateBuzzIdentity = (input: { relayUrl?: string; authTag?: string }) =>
  api<BuzzIdentityResponse>(BUZZ_IDENTITY, { method: "PUT", body: JSON.stringify(input) });

export const revokeBuzzTag = () => api<BuzzIdentityResponse>(`${BUZZ_IDENTITY}/auth-tag`, { method: "DELETE" });

// ----- People policy and approved people (routes v2). Per connection; agents never see these lists.
const connectionRoute = (connectionId: string, suffix: string) => `${ROOT}/connections/${encodeURIComponent(connectionId)}${suffix}`;

export type PeoplePolicyAnswer = { ok: true; connectionId: string; provider: ChannelProviderId; policy: PeoplePolicyView };

export const updatePeoplePolicy = (connectionId: string, input: { mode: PeoplePolicyMode; people?: string[]; domains?: string[] }) =>
  api<PeoplePolicyAnswer>(connectionRoute(connectionId, "/people-policy"), { method: "PUT", body: JSON.stringify(input) });

export const listChannelPeople = (connectionId: string) =>
  api<PeoplePolicyAnswer & { people: ChannelPersonView[]; recentFinds?: Array<{ agentId: string; outcome: string; at: string }> }>(connectionRoute(connectionId, "/people"));

export const revokeChannelPerson = (connectionId: string, personRef: string) =>
  api<{ ok: true; person: ChannelPersonView; replayed?: boolean }>(connectionRoute(connectionId, `/people/${encodeURIComponent(personRef)}/revoke`), { method: "POST", body: JSON.stringify({}) });

// ----- Live sessions (P2 scope 2.3) -----
const LIVE = `${ROOT}/live`;
const liveGrantRoute = (grantId: string, verb: string) => `${LIVE}/grants/${encodeURIComponent(grantId)}/${verb}`;

export const getLiveOverview = () => api<LiveOverview>(LIVE);

/** Approves exactly the digest the owner was shown (strict owner gate on the server). */
export const approveLiveGrant = (grantId: string, digest: string) =>
  api<{ ok: true; grant: LiveGrantView }>(liveGrantRoute(grantId, "approve"), { method: "POST", body: JSON.stringify({ digest }) });

export const liveGrantAction = (grantId: string, verb: "decline" | "revoke" | "pause" | "resume") =>
  api<{ ok: true; grant: LiveGrantView }>(liveGrantRoute(grantId, verb), { method: "POST", body: JSON.stringify({}) });

export const updateLiveControl = (patch: { paused?: boolean; commandChannel?: string | null }) =>
  api<{ ok: true; control: LiveOverview["control"] }>(`${LIVE}/control`, { method: "PUT", body: JSON.stringify(patch) });

export const stopLiveSession = (sessionId: string) =>
  api<{ ok: true; session: LiveSessionView }>(`${LIVE}/sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST", body: JSON.stringify({}) });

export const getLiveTranscript = (sessionId: string) =>
  api<{ ok: true; session: LiveSessionView; lines: LiveTranscriptLine[] }>(`${LIVE}/sessions/${encodeURIComponent(sessionId)}/transcript`);

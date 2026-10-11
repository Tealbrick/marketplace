import { createHash } from "node:crypto";

import type { ChannelRecord, ChannelStore } from "../store.js";

/**
 * The disclosure notice counts against the channel's post caps (pre-0.3.0 review L2): each notice is reserved like a
 * post (`reservePost`: perDay / perHour / minimum gap of the channel ceiling, shared with every agent) BEFORE it is
 * sent, and settled afterwards (`sent`, `failed` = not counted, `uncertain` = still counted). The second notice of a
 * join (the huddle itself) is the same burst as the first, so it skips the minimum gap but still counts for the day
 * and hour caps. A refused reservation refuses the join with the cap error: nothing joins without its notice.
 */
export type NoticeReservation =
  | { ok: true; settle: (outcome: "sent" | "failed" | "uncertain") => void }
  | { ok: false; error: string; retryAfterSeconds?: number };

export type NoticeReserver = (input: {
  channel: ChannelRecord;
  agentId: string;
  consentId: string;
  grantId: string;
  /** One join attempt: keeps the idempotency keys of its notices apart. */
  attempt: string;
  conversationId: string;
  /** 0 for the first notice of the join, 1 for the second (no minimum gap). */
  index: number;
  text: string;
}) => NoticeReservation;

export function createNoticeReserver(input: { channels: ChannelStore; organizationId: string; now: () => Date; leaseMs?: number }): NoticeReserver {
  return ({ channel, agentId, consentId, grantId, attempt, conversationId, index, text }) => {
    const ceiling = index === 0 ? channel.policy.caps : { ...channel.policy.caps, minIntervalSeconds: 0 };
    const now = input.now();
    const reserver = `live-notice:${attempt}`;
    const reserved = input.channels.reservePost({
      workspaceSlug: input.organizationId,
      channelId: channel.id,
      agentId,
      consentId,
      mode: "immediate",
      text,
      digest: createHash("sha256").update(text).digest("hex"),
      authority: `grant:${grantId}`,
      idempotencyKey: `live-notice:${attempt}:${conversationId}`,
      reason: "live_disclosure_notice",
      ceiling,
      now,
      reserver,
      ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
      live: { consentRowId: consentId, grantId: null },
    });
    if (!reserved.ok) return { ok: false, error: reserved.error, ...(reserved.retryAfterSeconds !== undefined ? { retryAfterSeconds: reserved.retryAfterSeconds } : {}) };
    return {
      ok: true,
      settle: (outcome) => {
        input.channels.finishPost(input.organizationId, reserved.post.id, { status: outcome, from: ["sending"], reason: outcome === "sent" ? "live_disclosure_notice" : `live_disclosure_notice_${outcome}`, claimer: reserver, now: input.now() });
      },
    };
  };
}

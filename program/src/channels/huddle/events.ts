import { verifyEvent } from "../providers/nostr.js";

/**
 * Buzz huddle lifecycle kinds (buzz-src crates/buzz-core/src/kind.rs). Marketplace READS these; it signs none of
 * them, so BUZZ_SIGNABLE_KINDS is unchanged:
 *
 * - 48100 started: client-signed by the huddle creator, `h` = parent channel, content `{"ephemeral_channel_id"}`.
 * - 48101 joined / 48102 left: RELAY-signed (relay_keypair) on audio-socket admission / disconnect, tags
 *   `h` = parent channel and `p` = participant, content `{"ephemeral_channel_id","roster_revision"?,
 *   "admission_id"?,"generation"}` (audio/handler.rs emit_participant_event).
 * - 48103 ended: the creator, or the relay when the room empties (then also a `p` tag).
 * - 48104 liveness: relay-synthesized per REQ (`d` = session, `h` = parent), never published by clients.
 * - 48106 guidelines (creator, `h` = huddle channel) and 24810 emoji burst (ephemeral, `h` = huddle channel).
 */
export const HUDDLE_KIND = Object.freeze({
  started: 48100,
  joined: 48101,
  left: 48102,
  ended: 48103,
  liveness: 48104,
  guidelines: 48106,
  reaction: 24810,
});

export type HuddleLifecycle = {
  type: "started" | "joined" | "left" | "ended" | "liveness";
  parentChannelId: string;
  huddleChannelId: string;
  participant: string | null;
  signer: string;
  createdAt: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const TYPES: Record<number, HuddleLifecycle["type"]> = { 48100: "started", 48101: "joined", 48102: "left", 48103: "ended", 48104: "liveness" };

/**
 * Untrusted input → a verified lifecycle record, or null. Joined/left/liveness must be signed by the relay key
 * (`relayPubkey`, from the relay's NIP-11 `pubkey`); started may be signed by anyone (the relay checks the creator).
 */
export function parseHuddleLifecycle(value: unknown, relayPubkey: string): HuddleLifecycle | null {
  if (!verifyEvent(value)) return null;
  const type = TYPES[value.kind];
  if (!type) return null;
  if ((type === "joined" || type === "left" || type === "liveness") && value.pubkey !== relayPubkey) return null;
  const tag = (name: string) => value.tags.find((entry) => entry[0] === name)?.[1];
  const parent = tag("h");
  if (!parent || !UUID.test(parent)) return null;
  let content: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(value.content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    content = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const huddle = content.ephemeral_channel_id;
  if (typeof huddle !== "string" || !UUID.test(huddle)) return null;
  const participant = tag("p");
  return { type, parentChannelId: parent, huddleChannelId: huddle, participant: participant && HEX64.test(participant) ? participant : null, signer: value.pubkey, createdAt: value.created_at };
}

import { guardedHuddleSocketFactory, type BinarySocketFactory, type RelayLookup } from "../buzz-relay-guard.js";
import { encodeBuzzCredential } from "../providers/buzz.js";
import { signAuthTag } from "../providers/buzz-test-relay.js";
import { generateSecretKey, publicKeyOf } from "../providers/nostr.js";
import { readOggOpusPackets } from "../providers/ogg-opus.js";

import type { SpeechProvider, Transcription } from "./speech.js";

// Test-only helpers for the huddle suites. Never imported by runtime code.

export type FakeTranscribeCall = { packets: number; durationSecs: number; firstPacketHex: string; language?: string; bytes: number };

/** A fake SpeechProvider: records the SHAPE of each call (never the audio bytes) and answers with `reply`. */
export function createFakeSpeechProvider(
  input: {
    reply?: (call: FakeTranscribeCall, index: number) => Transcription | Promise<Transcription>;
    synthesize?: (text: string) => Uint8Array | Promise<Uint8Array>;
    /** Transcriptions never settle unless aborted (stop tests). */
    hang?: boolean;
  } = {},
) {
  const transcribeCalls: FakeTranscribeCall[] = [];
  const synthesizeCalls: Array<{ text: string; voice?: string }> = [];
  const invalid: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const provider: SpeechProvider = {
    async transcribe(oggOpus, options) {
      const parsed = readOggOpusPackets(oggOpus);
      if (!parsed.ok) {
        invalid.push(parsed.reason);
        throw new Error("fake_invalid_ogg");
      }
      const call: FakeTranscribeCall = {
        packets: parsed.packets.length,
        durationSecs: parsed.info.durationSecs,
        firstPacketHex: Buffer.from(parsed.packets[0]!.subarray(0, 4)).toString("hex"),
        bytes: oggOpus.length,
        ...(options.language ? { language: options.language } : {}),
      };
      transcribeCalls.push(call);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (input.hang) {
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        return input.reply ? await input.reply(call, transcribeCalls.length - 1) : { text: `utterance ${transcribeCalls.length}` };
      } finally {
        inFlight -= 1;
      }
    },
    async synthesize(text, options) {
      synthesizeCalls.push({ text, ...(options.voice ? { voice: options.voice } : {}) });
      if (!input.synthesize) throw new Error("fake_no_synthesis");
      return input.synthesize(text);
    },
  };
  return {
    provider,
    transcribeCalls,
    synthesizeCalls,
    invalid,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

export const OWNER_SECRET = "22".repeat(32);
export const OWNER_PUBKEY = publicKeyOf(OWNER_SECRET)!;

/** A connection credential: fresh agent key, the owner relay URL and an owner-signed NIP-OA tag (60 days). */
export function huddleCredential(input: { relayUrl?: string; nowMs?: number } = {}) {
  const secretKey = generateSecretKey();
  const pubkey = publicKeyOf(secretKey)!;
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const authTag = signAuthTag(OWNER_SECRET, pubkey, `created_at<${nowSeconds + 60 * 86_400}`);
  return { secretKey, pubkey, credential: encodeBuzzCredential({ secretKey, relayUrl: input.relayUrl ?? "wss://relay.buzz.test", authTag }) };
}

/**
 * The REAL guarded factory (address-pinned undici agent) pointed at the in-process relay: the relay name resolves
 * to 127.0.0.1 through the injected lookup, and only the scheme/port are rewritten (no TLS in tests).
 */
export function guardedTestFactory(port: number, input: { allowPrivate: boolean; host?: string }): { factory: BinarySocketFactory; lookups: string[] } {
  const host = input.host ?? "relay.buzz.test";
  const lookups: string[] = [];
  const lookup: RelayLookup = async (hostname) => {
    lookups.push(hostname);
    return hostname === host ? [{ address: "127.0.0.1", family: 4 }] : [];
  };
  const guarded = guardedHuddleSocketFactory({ allowPrivate: input.allowPrivate, lookup });
  return { factory: (url) => guarded(url.replace(`wss://${host}`, `ws://${host}:${port}`)), lookups };
}

/** One 20 ms CELT packet (TOC 0xF8) carrying `marker` bytes. */
export function opusPacket(marker: number, size = 40): Uint8Array {
  const packet = new Uint8Array(size).fill(marker & 0xff);
  packet[0] = 0xf8;
  return packet;
}

export async function waitFor(check: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

import { createVoiceHandler, type VoiceOptions } from "@tealbrick/voice";

import { type SpeechProvider, SpeechProviderError, type Transcription } from "./speech.js";

/**
 * SpeechProvider on @tealbrick/voice 0.3.0-rc.16 (Coordinator approval, 2026-10-10): Portal-authorized,
 * configurable speech endpoints. DISABLED by default: constructing it needs `enabled: true`, and nothing outside
 * tests constructs it; no route reaches it until live-session grants exist (contract alpha.8).
 *
 * - Authorization: every call goes through the package's own handler, which verifies the owner's Portal user
 *   session (Bearer ID token + `x-tealbrick-bundle` policy bundle with a `use`/`manage` grant for this agent)
 *   before any provider dispatch. Marketplace never holds a provider key: `voice.resolveCredential` and
 *   `voice.endpoints` come from Portal / account connections, and the Portal session comes from `portalSession`.
 * - transcribe: sends the utterance as `audio/ogg` (Ogg/Opus is accepted by the handler: AUDIO_TYPES maps
 *   audio/ogg → `recording.ogg`, multipart `openai-audio-v1`). Result: `{text}` only (no segments in this protocol).
 * - synthesize: NOT AVAILABLE in this version. The package's `openai-audio-v1` synthesis always requests
 *   `response_format: "mp3"` and accepts only `audio/mpeg`; a huddle needs Ogg/Opus with 20 ms packets and there is
 *   no decoder/encoder here. Needed upstream: a synthesis output-format setting for `opus` (OpenAI `audio/speech`
 *   returns Ogg/Opus for `response_format: "opus"`) with `audio/ogg` accepted in the response. Until then
 *   synthesize refuses BEFORE dispatch (`speech_ogg_opus_unavailable`), so no provider minute is spent.
 */

export type PortalSession = { idToken: string; bundle: string };

export type PortalVoiceSpeechOptions = {
  /** Must be exactly `true`; anything else refuses to construct (`voice_speech_disabled`). */
  enabled: boolean;
  voice: VoiceOptions;
  /** The owner's current Portal session for this agent (never stored here). */
  portalSession: () => Promise<PortalSession> | PortalSession;
};

/** Internal request origin: the handler is called in-process, nothing listens here. */
const INTERNAL_BASE = "https://marketplace.invalid/eve/v1/voice";

export function createPortalVoiceSpeechProvider(options: PortalVoiceSpeechOptions): SpeechProvider {
  if (options.enabled !== true) throw new SpeechProviderError("voice_speech_disabled");
  const handle = createVoiceHandler(options.voice);

  const headers = async (contentType: string): Promise<Headers> => {
    const session = await options.portalSession();
    if (!session || typeof session.idToken !== "string" || typeof session.bundle !== "string" || !session.idToken || !session.bundle) {
      throw new SpeechProviderError("portal_session_unavailable");
    }
    return new Headers({ authorization: `Bearer ${session.idToken}`, "x-tealbrick-bundle": session.bundle, "content-type": contentType });
  };

  return {
    async transcribe(oggOpus, input): Promise<Transcription> {
      if (!(oggOpus instanceof Uint8Array) || oggOpus.length === 0) throw new SpeechProviderError("empty_voice_audio");
      const request = new Request(`${INTERNAL_BASE}/transcribe`, {
        method: "POST",
        headers: await headers("audio/ogg"),
        body: oggOpus,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const response = await handle("transcribe", request);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SpeechProviderError("invalid_voice_response", response.status);
      }
      const record = (body && typeof body === "object" ? body : {}) as { ok?: unknown; text?: unknown; error?: unknown };
      if (!response.ok || record.ok !== true || typeof record.text !== "string") {
        throw new SpeechProviderError(typeof record.error === "string" && /^[a-z_]{1,64}$/u.test(record.error) ? record.error : "voice_unavailable", response.status);
      }
      // `language` is not part of the package's transcription request; the endpoint's configuration decides it.
      return { text: record.text };
    },
    async synthesize(): Promise<Uint8Array> {
      throw new SpeechProviderError("speech_ogg_opus_unavailable");
    },
  };
}

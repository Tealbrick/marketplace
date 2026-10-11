/**
 * Speech-to-text and text-to-speech for huddles. Audio crosses this interface only as in-memory Ogg/Opus bytes
 * (RFC 7845); an implementation must not keep or log them.
 *
 * Implementations: the fake in `test-support.ts` (tests), or one injected through the app option
 * `liveSpeechProvider`. TODO(@tealbrick/voice rc.19): add the voice-backed implementation (Portal-authorized speech
 * endpoints; credentials stay in Portal / account connections). @tealbrick/voice 0.3.0-rc.18 synthesis returns MP3
 * only (no `format: "opus"`), and a huddle needs Ogg/Opus (20 ms packets), so the dependency is not added yet and
 * speak-live stays refused (`live_tts_unavailable`) until rc.19.
 */
export type TranscriptionSegment = { startSecs: number; endSecs: number; text: string };

export type Transcription = { text: string; segments?: TranscriptionSegment[] };

export interface SpeechProvider {
  transcribe(oggOpus: Uint8Array, options: { language?: string; signal?: AbortSignal }): Promise<Transcription>;
  /** Returns an Ogg/Opus file (mono, 48 kHz, 20 ms packets) ready for `speak`. */
  synthesize(text: string, options: { voice?: string; signal?: AbortSignal }): Promise<Uint8Array>;
}

/** A provider failure with a stable public code (never the provider's own error text). */
export class SpeechProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
  }
}

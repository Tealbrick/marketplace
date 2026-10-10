/**
 * Speech-to-text and text-to-speech for huddles. Audio crosses this interface only as in-memory Ogg/Opus bytes
 * (RFC 7845); an implementation must not keep or log them.
 *
 * Implementations: the fake in `test-support.ts` (tests) and `createPortalVoiceSpeechProvider` in
 * `voice-speech.ts` (@tealbrick/voice, Portal-authorized endpoints; disabled unless explicitly enabled and not
 * reachable from any route until live-session grants exist, contract alpha.8).
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

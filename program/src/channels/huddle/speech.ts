/**
 * Speech-to-text and text-to-speech for huddles. Audio crosses this interface only as in-memory Ogg/Opus bytes
 * (RFC 7845); an implementation must not keep or log them.
 *
 * Implementations: the fake in `test-support.ts` (tests only for now).
 * TODO(channels P2 wiring PR, with live-session grants / contract alpha.8): add the @tealbrick/voice-backed
 * implementation (Portal-authorized speech endpoints; credentials stay in Portal / account connections) together
 * with the dependency and the Node >= 24 engines alignment. Note: @tealbrick/voice 0.3.0-rc.16 synthesis returns
 * MP3 only; a huddle needs Ogg/Opus (20 ms packets), so it needs an `opus` output option upstream.
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

import type { AudioPrivacyTier, SttProviderId } from "@/lib/voice-types";

export interface SttOpts {
  /** ISO 639-3, e.g. "eng". Omit for auto-detect (where supported). */
  languageCode?: string;
  /** Sample rate of the supplied PCM bytes; 16000 by default. */
  sampleRate?: number;
}

export interface SttResult {
  text: string;
  /** Provider-reported model id (logged to inference_usage). */
  model: string;
  /** Wall-clock ms for the transcription call. */
  latencyMs: number;
}

export interface SttAdapter {
  id: SttProviderId;
  privacyTier: AudioPrivacyTier;
  requiresNetwork: boolean;
  /**
   * Transcribe a single utterance. The caller MUST null the supplied buffer
   * in a `finally` block. Implementations MUST NOT persist the audio bytes
   * to localStorage, IndexedDB, OPFS, or any network endpoint other than
   * the transcription provider.
   */
  transcribe(audioBytes: Uint8Array, opts: SttOpts): Promise<SttResult>;
}

import type { AudioPrivacyTier, TtsProviderId } from "@/lib/voice-types";

export interface TtsOpts {
  voiceId?: string;
  languageCode?: string;
}

export interface TtsResult {
  /** Object URL or data URL the caller can hand to <audio>. */
  audioUrl: string;
  model: string;
  /** Time-to-first-byte. */
  latencyMs: number;
  /** Character count of the input text (cost basis). */
  chars: number;
}

export interface TtsAdapter {
  id: TtsProviderId;
  privacyTier: AudioPrivacyTier;
  requiresNetwork: boolean;
  speak(text: string, opts: TtsOpts): Promise<TtsResult>;
}

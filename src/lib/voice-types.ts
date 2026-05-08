/**
 * Voice types shim — Phase 2.8.
 *
 * Mirrors the new columns added by `20260530000000_phase28_voice.sql`
 * without touching `src/integrations/supabase/types.ts` (which is regenerated
 * by the Supabase CLI). At Phase 2 integration time, fold these into the
 * canonical Database types.
 */

export type SttProviderId =
  | "groq-whisper"
  | "google-stt"
  | "elevenlabs-scribe"
  | "deepgram-nova-2"
  | "browser-speech-recognition"
  | "whisper-cpp-wasm";

export type TtsProviderId =
  | "elevenlabs-flash"
  | "elevenlabs-multilingual-v2"
  | "piper-wasm";

/** T0 = local; T2 = cloud zero-retention; T3 = cloud may retain. */
export type AudioPrivacyTier = "T0" | "T2" | "T3";

export type Badge = "FLASH" | "PRO" | "Genius" | "PRIVATE";

/** Sub-shape of `inference_usage` introduced by Phase 2.8. */
export interface VoiceUsageRow {
  stt_provider: SttProviderId | null;
  stt_model: string | null;
  stt_latency_ms: number | null;
  tts_provider: TtsProviderId | null;
  tts_model: string | null;
  tts_chars: number | null;
  tts_latency_ms: number | null;
  audio_micro_usd: number;
  vtl_ms: number | null;
}

/** Sub-shape of `user_settings` introduced by Phase 2.8. */
export interface VoiceSettingsRow {
  prefer_local_audio: boolean;
  local_audio_capability: LocalAudioCapability | null;
}

export interface LocalAudioCapability {
  webgpu: boolean;
  opfsBytes: number;
  wasmSimd: boolean;
  probedAt: string; // ISO
}

export interface ResolvedTriple {
  stt: SttProviderId;
  llm: string; // resolved by chat router separately
  tts: TtsProviderId | "text-only";
  /** Per-turn privacy color for the badge in the input row. */
  privacyColor: "green" | "violet" | "amber";
}

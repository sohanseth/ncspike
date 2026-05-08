import type { SttProviderId, TtsProviderId } from "@/lib/voice-types";

/** Micro-USD per second of audio (STT) or per character (TTS). */
const STT_USD_PER_SEC: Record<SttProviderId, number> = {
  "groq-whisper": 0.04 / 3600, // $0.04/hr
  "google-stt": 0.024 / 60, // $0.024/min (latest_long)
  "elevenlabs-scribe": 0.4 / 3600, // $0.40/hr realtime
  "deepgram-nova-2": 0.0043 / 60,
  "browser-speech-recognition": 0,
  "whisper-cpp-wasm": 0,
};

const TTS_USD_PER_1K_CHARS: Record<TtsProviderId, number> = {
  "elevenlabs-flash": 0.3,
  "elevenlabs-multilingual-v2": 0.5,
  "piper-wasm": 0,
};

export function sttCostMicroUsd(provider: SttProviderId, audioSeconds: number): number {
  return Math.round(STT_USD_PER_SEC[provider] * audioSeconds * 1_000_000);
}

export function ttsCostMicroUsd(provider: TtsProviderId, chars: number): number {
  return Math.round((TTS_USD_PER_1K_CHARS[provider] / 1000) * chars * 1_000_000);
}

export function audioCostMicroUsd(args: {
  stt?: { provider: SttProviderId; audioSeconds: number };
  tts?: { provider: TtsProviderId; chars: number };
}): number {
  const s = args.stt ? sttCostMicroUsd(args.stt.provider, args.stt.audioSeconds) : 0;
  const t = args.tts ? ttsCostMicroUsd(args.tts.provider, args.tts.chars) : 0;
  return s + t;
}

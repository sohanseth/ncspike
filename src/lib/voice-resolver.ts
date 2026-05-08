/**
 * Badge × prefer-local toggle → (STT, TTS) resolution.
 * The LLM half is owned by the existing chat router (Phase 2.6); we only
 * surface its eventual `provider_used` into the status pill at runtime.
 *
 * See docs/07-spec-phase-2.8-voice.md §3 V2.
 */
import type { Badge, ResolvedTriple, SttProviderId, TtsProviderId } from "./voice-types";

interface AudioPair {
  stt: SttProviderId;
  tts: TtsProviderId | "text-only";
}

const TOGGLE_OFF: Record<Badge, AudioPair> = {
  FLASH: { stt: "groq-whisper", tts: "elevenlabs-flash" },
  PRO: { stt: "groq-whisper", tts: "elevenlabs-flash" },
  Genius: { stt: "elevenlabs-scribe", tts: "elevenlabs-multilingual-v2" },
  PRIVATE: { stt: "whisper-cpp-wasm", tts: "piper-wasm" },
};

const TOGGLE_ON: Record<Badge, AudioPair> = {
  FLASH: { stt: "groq-whisper", tts: "piper-wasm" },
  PRO: { stt: "groq-whisper", tts: "piper-wasm" },
  Genius: { stt: "groq-whisper", tts: "piper-wasm" },
  PRIVATE: { stt: "whisper-cpp-wasm", tts: "piper-wasm" },
};

const LOCAL_STT = new Set<SttProviderId>(["whisper-cpp-wasm", "browser-speech-recognition"]);
const LOCAL_TTS = new Set<string>(["piper-wasm", "text-only"]);
const CLOSED_LLM_PROVIDERS = new Set(["openai", "anthropic"]);

export function resolveAudioPair(badge: Badge, preferLocal: boolean): AudioPair {
  return preferLocal ? TOGGLE_ON[badge] : TOGGLE_OFF[badge];
}

export function privacyColorForTriple(args: {
  stt: SttProviderId;
  tts: TtsProviderId | "text-only";
  llmProvider: string | null;
}): "green" | "violet" | "amber" {
  const sttLocal = LOCAL_STT.has(args.stt);
  const ttsLocal = LOCAL_TTS.has(args.tts);
  const llmClosed = args.llmProvider ? CLOSED_LLM_PROVIDERS.has(args.llmProvider) : false;
  if (sttLocal && ttsLocal && !args.llmProvider) return "green";
  if (sttLocal && ttsLocal && args.llmProvider === "cloudflare") return "green";
  if (llmClosed) return "amber";
  return "violet";
}

export function buildTriple(
  badge: Badge,
  preferLocal: boolean,
  llmProvider: string | null,
): ResolvedTriple {
  const pair = resolveAudioPair(badge, preferLocal);
  return {
    stt: pair.stt,
    llm: llmProvider ?? "pending",
    tts: pair.tts,
    privacyColor: privacyColorForTriple({ stt: pair.stt, tts: pair.tts, llmProvider }),
  };
}

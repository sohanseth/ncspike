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
  // Web today: no Whisper.cpp / Piper WASM (deferred to native shell, ~Phase 4).
  // PRIVATE on web = browser SpeechRecognition + text-only reply.
  PRIVATE: { stt: "browser-speech-recognition", tts: "text-only" },
};

const TOGGLE_ON: Record<Badge, AudioPair> = {
  // Toggle is hidden on web (capability probe forces wasmSimd=false), so these
  // FLASH/PRO/Genius rows are unreachable until the native shell ships. Kept
  // here so the type-level Record<Badge, …> stays exhaustive.
  FLASH: { stt: "groq-whisper", tts: "piper-wasm" },
  PRO: { stt: "groq-whisper", tts: "piper-wasm" },
  Genius: { stt: "groq-whisper", tts: "piper-wasm" },
  PRIVATE: { stt: "browser-speech-recognition", tts: "text-only" },
};

const LOCAL_STT = new Set<SttProviderId>(["whisper-cpp-wasm", "browser-speech-recognition"]);
const LOCAL_TTS = new Set<string>(["piper-wasm", "text-only"]);
const CLOSED_LLM_PROVIDERS = new Set(["openai", "anthropic"]);

export function resolveAudioPair(
  badge: Badge,
  preferLocal: boolean,
  nativeShell: boolean = false,
): AudioPair {
  // Defense-in-depth: TOGGLE_ON FLASH/PRO/Genius rows reference `piper-wasm`,
  // whose adapter throws `NATIVE_ONLY_MSG` on web. The settings UI hides the
  // toggle when `!nativeShell` (capability probe forces wasmSimd=false), but
  // the persisted `prefer_local_audio` value can survive across native↔web
  // sessions, so we coerce to TOGGLE_OFF here whenever we're not in the
  // native shell. This guarantees no web turn ever resolves to a stub adapter
  // regardless of what's in localStorage / user_settings.
  if (!nativeShell) return TOGGLE_OFF[badge];
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

import type { SttAdapter } from "./types";
import { groqWhisper } from "./groq-whisper";
import { googleStt } from "./google-stt";
import { elevenlabsScribe } from "./elevenlabs-scribe";
import { deepgramNova2 } from "./deepgram";
import { browserSpeech } from "./browser-speech";
import { whisperCppWasm } from "./whisper-cpp-wasm";
import type { SttProviderId } from "@/lib/voice-types";

export const STT_REGISTRY: Record<SttProviderId, SttAdapter> = {
  "groq-whisper": groqWhisper,
  "google-stt": googleStt,
  "elevenlabs-scribe": elevenlabsScribe,
  "deepgram-nova-2": deepgramNova2,
  "browser-speech-recognition": browserSpeech,
  "whisper-cpp-wasm": whisperCppWasm,
};

export type { SttAdapter, SttOpts, SttResult } from "./types";

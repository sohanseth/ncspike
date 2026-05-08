import type { TtsProviderId } from "@/lib/voice-types";
import type { TtsAdapter } from "./types";
import { elevenlabsFlash } from "./elevenlabs-flash";
import { elevenlabsMultilingual } from "./elevenlabs-multilingual";
import { piperWasm } from "./piper-wasm";

export const TTS_REGISTRY: Record<TtsProviderId, TtsAdapter> = {
  "elevenlabs-flash": elevenlabsFlash,
  "elevenlabs-multilingual-v2": elevenlabsMultilingual,
  "piper-wasm": piperWasm,
};

export type { TtsAdapter, TtsOpts, TtsResult } from "./types";

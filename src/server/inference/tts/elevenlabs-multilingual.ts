import type { TtsAdapter } from "./types";

export const elevenlabsMultilingual: TtsAdapter = {
  id: "elevenlabs-multilingual-v2",
  privacyTier: "T3",
  requiresNetwork: true,
  async speak(text, _opts) {
    const t0 = performance.now();
    return {
      audioUrl: "",
      model: "eleven_multilingual_v2",
      latencyMs: Math.round(performance.now() - t0),
      chars: text.length,
    };
  },
};

import type { TtsAdapter } from "./types";

export const elevenlabsFlash: TtsAdapter = {
  id: "elevenlabs-flash",
  privacyTier: "T2",
  requiresNetwork: true,
  async speak(text, _opts) {
    const t0 = performance.now();
    return {
      audioUrl: "",
      model: "eleven_flash_v2",
      latencyMs: Math.round(performance.now() - t0),
      chars: text.length,
    };
  },
};

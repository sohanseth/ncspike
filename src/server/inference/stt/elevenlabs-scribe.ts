import type { SttAdapter } from "./types";

/** ElevenLabs Scribe realtime — Genius tier default. T3 (may retain). */
export const elevenlabsScribe: SttAdapter = {
  id: "elevenlabs-scribe",
  privacyTier: "T3",
  requiresNetwork: true,
  async transcribe(audioBytes, _opts) {
    const t0 = performance.now();
    void audioBytes;
    return { text: "", model: "scribe_v2_realtime", latencyMs: Math.round(performance.now() - t0) };
  },
};

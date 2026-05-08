import type { SttAdapter } from "./types";

export const googleStt: SttAdapter = {
  id: "google-stt",
  privacyTier: "T2",
  requiresNetwork: true,
  async transcribe(audioBytes, _opts) {
    const t0 = performance.now();
    void audioBytes;
    return { text: "", model: "google-stt-latest_long", latencyMs: Math.round(performance.now() - t0) };
  },
};

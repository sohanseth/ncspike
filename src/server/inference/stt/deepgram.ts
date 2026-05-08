import type { SttAdapter } from "./types";

export const deepgramNova2: SttAdapter = {
  id: "deepgram-nova-2",
  privacyTier: "T2",
  requiresNetwork: true,
  async transcribe(audioBytes, _opts) {
    const t0 = performance.now();
    void audioBytes;
    return { text: "", model: "nova-2", latencyMs: Math.round(performance.now() - t0) };
  },
};

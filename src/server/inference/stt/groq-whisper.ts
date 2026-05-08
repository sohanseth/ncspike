import type { SttAdapter } from "./types";

/**
 * Groq Whisper-large-v3-turbo. ZDR (T2). ~$0.04/hr.
 * Network call from the client; audio bytes never persisted.
 *
 * NOTE: stub for Phase 2.8 Day 1 scaffolding. Real implementation posts to
 * a server function that proxies to Groq with the user's request.
 */
export const groqWhisper: SttAdapter = {
  id: "groq-whisper",
  privacyTier: "T2",
  requiresNetwork: true,
  async transcribe(audioBytes, _opts) {
    const t0 = performance.now();
    // TODO(phase-2.8 day-1): POST audioBytes to /api/stt/groq
    void audioBytes;
    return {
      text: "",
      model: "whisper-large-v3-turbo",
      latencyMs: Math.round(performance.now() - t0),
    };
  },
};

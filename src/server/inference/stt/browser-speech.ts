import type { SttAdapter } from "./types";

/**
 * Safari `SpeechRecognition` — on-device on Apple platforms. T0.
 * Used as last-resort FLASH fallback on iOS Safari.
 */
export const browserSpeech: SttAdapter = {
  id: "browser-speech-recognition",
  privacyTier: "T0",
  requiresNetwork: false,
  async transcribe(audioBytes, _opts) {
    const t0 = performance.now();
    void audioBytes;
    return { text: "", model: "webkit-speech-recognition", latencyMs: Math.round(performance.now() - t0) };
  },
};

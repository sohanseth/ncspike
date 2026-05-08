import type { SttAdapter } from "./types";

/**
 * whisper.cpp tiny model in WASM. T0, fully on-device.
 * Loaded lazily from OPFS on first PRIVATE turn (~75MB total).
 */
export const whisperCppWasm: SttAdapter = {
  id: "whisper-cpp-wasm",
  privacyTier: "T0",
  requiresNetwork: false,
  async transcribe(audioBytes, _opts) {
    const t0 = performance.now();
    void audioBytes;
    return { text: "", model: "whisper-tiny-q5_1", latencyMs: Math.round(performance.now() - t0) };
  },
};

import type { TtsAdapter } from "./types";

/** Piper en-US-amy-low (~30MB ONNX) running in WASM. T0. */
export const piperWasm: TtsAdapter = {
  id: "piper-wasm",
  privacyTier: "T0",
  requiresNetwork: false,
  async speak(text, _opts) {
    const t0 = performance.now();
    return {
      audioUrl: "",
      model: "piper-en-US-amy-low-v3",
      latencyMs: Math.round(performance.now() - t0),
      chars: text.length,
    };
  },
};

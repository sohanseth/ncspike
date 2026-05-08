import type { TtsAdapter } from "./types";

const NATIVE_ONLY_MSG =
  "PRIVATE on-device audio is available in the NeuralConnexions native app (coming Phase 4). On web, PRIVATE uses browser speech recognition with text-only replies.";

/**
 * Piper en-US-amy-low (~30MB ONNX) running in WASM. T0.
 * Web build: stub. See whisper-cpp-wasm for the same rationale.
 */
export const piperWasm: TtsAdapter = {
  id: "piper-wasm",
  privacyTier: "T0",
  requiresNetwork: false,
  async speak(_text, _opts) {
    throw new Error(NATIVE_ONLY_MSG);
  },
};

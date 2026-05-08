import type { SttAdapter } from "./types";

const NATIVE_ONLY_MSG =
  "PRIVATE on-device audio is available in the NeuralConnexions native app (coming Phase 4). On web, PRIVATE uses browser speech recognition with text-only replies.";

/**
 * whisper.cpp tiny model in WASM. T0, fully on-device.
 * Web build: stub. Real implementation ships in the Capacitor native shell
 * (Phase 4) where ~75 MB of model + WASM runtime is acceptable. The resolver
 * gates this ID behind a `nativeShell` capability flag, so this throw is a
 * defense-in-depth signal — it should never fire on web.
 */
export const whisperCppWasm: SttAdapter = {
  id: "whisper-cpp-wasm",
  privacyTier: "T0",
  requiresNetwork: false,
  async transcribe(_audioBytes, _opts) {
    throw new Error(NATIVE_ONLY_MSG);
  },
};

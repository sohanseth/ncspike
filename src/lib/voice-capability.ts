/**
 * One-time capability probe for the local-audio toggle.
 * Fails closed: any error → toggle hidden.
 * See docs/07-spec-phase-2.8-voice.md §3 V9.
 */
import type { LocalAudioCapability } from "./voice-types";

const REQUIRED_OPFS_BYTES = 1.2 * 1024 * 1024 * 1024;

export async function probeLocalAudioCapability(): Promise<LocalAudioCapability> {
  const probedAt = new Date().toISOString();
  let webgpu = false;
  let opfsBytes = 0;
  let wasmSimd = false;

  try {
    webgpu = typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu != null;
  } catch {
    webgpu = false;
  }

  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      opfsBytes = est.quota ?? 0;
    }
  } catch {
    opfsBytes = 0;
  }

  try {
    // Tiny SIMD feature detection: WebAssembly.validate of a SIMD-using module.
    // 0xfd is the SIMD opcode prefix; this module declares (i32x4) usage.
    const simdBytes = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 17, 11,
    ]);
    wasmSimd = WebAssembly.validate(simdBytes);
  } catch {
    wasmSimd = false;
  }

  return { webgpu, opfsBytes, wasmSimd, probedAt };
}

export function isLocalAudioToggleAvailable(cap: LocalAudioCapability | null): boolean {
  if (!cap) return false;
  return cap.opfsBytes >= REQUIRED_OPFS_BYTES && cap.wasmSimd;
}

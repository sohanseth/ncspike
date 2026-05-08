/**
 * One-time capability probe for the local-audio toggle.
 * Fails closed: any error → toggle hidden.
 * See docs/07-spec-phase-2.8-voice.md §3 V9.
 *
 * Web policy (Phase 2.8 Day 2 → ~Phase 4):
 *   - `wasmSimd` is forced to `false` on web regardless of actual support.
 *     The "Prefer on-device" toggle therefore stays hidden until the native
 *     shell ships (real Whisper.cpp + Piper run there, not in the browser).
 *   - `nativeShell` reflects whether we're running inside the Capacitor app.
 *   - `webgpu` and `opfsBytes` are still probed honestly for telemetry.
 */
import type { LocalAudioCapability } from "./voice-types";

const REQUIRED_OPFS_BYTES = 1.2 * 1024 * 1024 * 1024;

export interface ExtendedLocalAudioCapability extends LocalAudioCapability {
  nativeShell: boolean;
  mediaDevices: boolean;
  audioContext: boolean;
  speechRecognition: boolean;
}

function detectNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  // Capacitor injects `window.Capacitor`; the user-agent also contains
  // "NeuralConnexionsApp" once we ship the native shell.
  const w = window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } };
  if (w.Capacitor?.isNativePlatform?.()) return true;
  if (typeof navigator !== "undefined" && /NeuralConnexionsApp/i.test(navigator.userAgent)) {
    return true;
  }
  return false;
}

function detectSpeechRecognition(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition);
}

export async function probeLocalAudioCapability(): Promise<ExtendedLocalAudioCapability> {
  const probedAt = new Date().toISOString();
  const nativeShell = detectNativeShell();
  let webgpu = false;
  let opfsBytes = 0;
  let mediaDevices = false;
  let audioContext = false;
  const speechRecognition = detectSpeechRecognition();

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
    mediaDevices =
      typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia);
  } catch {
    mediaDevices = false;
  }

  try {
    audioContext =
      typeof window !== "undefined" &&
      Boolean(
        (window as unknown as { AudioContext?: unknown; webkitAudioContext?: unknown })
          .AudioContext ??
          (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext,
      );
  } catch {
    audioContext = false;
  }

  // Web policy: WASM SIMD only counts when running inside the native shell.
  // Until then, we never light up the heavy on-device pipeline.
  let wasmSimd = false;
  if (nativeShell) {
    try {
      const simdBytes = new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 17, 11,
      ]);
      wasmSimd = WebAssembly.validate(simdBytes);
    } catch {
      wasmSimd = false;
    }
  }

  return {
    webgpu,
    opfsBytes,
    wasmSimd,
    probedAt,
    nativeShell,
    mediaDevices,
    audioContext,
    speechRecognition,
  };
}

export function isLocalAudioToggleAvailable(cap: ExtendedLocalAudioCapability | null): boolean {
  if (!cap) return false;
  // Hide on web entirely until the native shell ships.
  if (!cap.nativeShell) return false;
  return cap.opfsBytes >= REQUIRED_OPFS_BYTES && cap.wasmSimd;
}

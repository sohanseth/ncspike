/**
 * On-device LLM capability detection (Phase 2.8 — see docs/11-spec-on-device-tier.md).
 *
 * The PRIVATE badge runs entirely on the user's hardware. Three pathways are
 * supported, in priority order:
 *
 *   1. Apple Foundation Models (iOS 18+, iPhone 15 Pro / 16 family or newer,
 *      Apple Intelligence enabled). Bridged via the `OnDeviceLLM` Capacitor
 *      plugin — see docs/11 §3 for the Swift reference implementation.
 *   2. Gemini Nano via AICore (Android 14+, Pixel 8+ / Galaxy S24+ with the
 *      AICore APK present). Bridged via the same `OnDeviceLLM` Capacitor
 *      plugin — see docs/11 §4 for the Kotlin reference.
 *   3. WebLLM (any browser with WebGPU — primarily desktop Chrome/Edge and
 *      iOS 18 Safari with WebGPU enabled). Runs Llama 3.2 1B-Instruct
 *      in-browser via WebAssembly. ~700 MB cached on first use.
 *
 * Detection MUST be runtime-only — build-time flags lie about end-user
 * hardware. The result is cached for the session because each probe involves
 * non-trivial work (Capacitor plugin handshake or WebGPU adapter request).
 *
 * The `unsupportedReason` is shown verbatim to the user when the PRIVATE
 * badge is disabled, so it must be plain English and never include
 * personally-identifying device strings.
 */
import type { OnDeviceProviderId } from "./provider-tiers";

export type OnDeviceCapability = {
  /** Which adapter wins on this device. `null` = no on-device path available. */
  providerId: OnDeviceProviderId | null;
  /** True when the PRIVATE badge can run; false otherwise. */
  available: boolean;
  /** User-facing English reason when `available === false`. */
  unsupportedReason: string | null;
  /**
   * For WebLLM only — true when the model weights are already cached and
   * the next generation will start instantly. False = first run will
   * download ~700 MB. Always undefined for native paths.
   */
  modelReady?: boolean;
};

let _cached: Promise<OnDeviceCapability> | null = null;

/**
 * Detect the best available on-device LLM path. Memoized for the session.
 * Pass `force: true` to re-probe (e.g. after the user installs AICore or
 * grants Apple Intelligence permission).
 */
export async function detectOnDeviceCapability(opts?: { force?: boolean }): Promise<OnDeviceCapability> {
  if (_cached && !opts?.force) return _cached;
  _cached = (async (): Promise<OnDeviceCapability> => {
    // ─── 1. Native bridge (iOS / Android) ────────────────────────────────
    try {
      const native = await import("./native-on-device-llm");
      const probe = await native.probeNativeOnDeviceLLM();
      if (probe.available) {
        return {
          providerId: probe.platform === "ios" ? "onDeviceApple" : "onDeviceAndroid",
          available: true,
          unsupportedReason: null,
        };
      }
    } catch {
      // Capacitor plugin not registered (e.g. running in pure web build).
      // Fall through to WebLLM probe.
    }

    // ─── 2. WebLLM (WebGPU browsers) ─────────────────────────────────────
    try {
      const webllm = await import("./on-device-webllm");
      const probe = await webllm.probeWebLLM();
      if (probe.available) {
        return {
          providerId: "onDeviceWebLLM",
          available: true,
          unsupportedReason: null,
          modelReady: probe.modelReady,
        };
      }
      return {
        providerId: null,
        available: false,
        unsupportedReason: probe.reason ?? "Your browser doesn't support on-device AI yet.",
      };
    } catch {
      return {
        providerId: null,
        available: false,
        unsupportedReason:
          "On-device AI couldn't load on this device. Try a different browser or use a different badge.",
      };
    }
  })();
  return _cached;
}

/** Reset the cache. Test-only and "settings → re-probe" use. */
export function resetOnDeviceCapabilityCache(): void {
  _cached = null;
}

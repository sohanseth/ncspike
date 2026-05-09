/**
 * On-device IMAGE-GENERATION capability detection (Phase 2.9 — see
 * `docs/12-spec-image-gen-private.md` §15).
 *
 * Mirrors the shape of `src/lib/on-device-capability.ts` but probes for
 * image-out support, which has different hardware requirements than the
 * text-only on-device LLM tier:
 *
 *   - `apple-ip` — Apple Image Playground, iOS 18+ on A17 Pro / M-series.
 *   - `mediapipe` — Android, MediaPipe Image Generator on SD8 Gen 2+ /
 *     Tensor G3+ devices.
 *   - `webgpu-sdxl` / `webgpu-sd15` / `webgpu-sd-turbo` / `webgpu-janus-1b`
 *     — desktop WebGPU with `maxBufferSize ≥ 2 GB` (SDXL needs more VRAM
 *     than the base model; the picker in slice b will downgrade as
 *     constraints tighten).
 *
 * Slice a (this file) wires the detection surface but every probe returns
 * `available: false` with an honest reason — slice b ships the real probes
 * and adapter bindings. Until then the PRIVATE+image path stays fail-closed
 * at the SSE-route edge in `src/routes/api.chat.stream.ts`.
 *
 * Detection is runtime-only (build-time flags lie about end-user hardware)
 * and memoised per session because each probe is non-trivial (Capacitor
 * plugin handshake or WebGPU adapter request).
 *
 * The `reason` is shown verbatim to the user when image-out is disabled,
 * so it must be plain English and never include device serial / OS build
 * numbers.
 */

/** Adapter identifiers — the union the picker resolves to once a probe wins. */
export type ImageGenAdapterId =
  | "apple-ip"
  | "mediapipe"
  | "webgpu-sdxl"
  | "webgpu-sd15"
  | "webgpu-sd-turbo"
  | "webgpu-janus-1b";

export type ImageGenCapability =
  | { available: false; reason: string }
  | { available: true; adapter: ImageGenAdapterId };

let _cached: Promise<ImageGenCapability> | null = null;

/**
 * Detect the best available on-device image-gen path. Memoised for the
 * session. Pass `force: true` to re-probe (settings → re-check, or after
 * the user installs a system update).
 *
 * Slice a: every probe returns `available: false`. The "not yet wired"
 * reason tells the future caller exactly which probe ran so slice b can
 * differentiate "wrong device" from "adapter not implemented yet" without
 * a wire-protocol bump.
 */
export async function detectImageGenCapability(
  opts?: { force?: boolean },
): Promise<ImageGenCapability> {
  if (_cached && !opts?.force) return _cached;
  _cached = (async (): Promise<ImageGenCapability> => {
    // ─── 1. Native bridge (iOS Apple IP / Android MediaPipe) ────────────
    // Slice b will dynamic-import the Capacitor plugin and call
    // `probeNativeImageGen()`. Today we record the slot.
    try {
      // intentionally await so future slice-b probes can `await import(...)`
      // without us having to flip async-ness later.
      await Promise.resolve();
      // fall through to WebGPU
    } catch {
      // fall through
    }

    // ─── 2. WebGPU (desktop browsers) ───────────────────────────────────
    // Slice b will request a WebGPU adapter and inspect
    // `adapter.limits.maxBufferSize` to pick between SDXL / SD1.5 /
    // SD-Turbo / Janus-1B. Today we report unsupported with the honest
    // reason — the adapters do not exist yet.
    return {
      available: false,
      reason: "On-device image generation isn't wired yet on this device.",
    };
  })();
  return _cached;
}

/** Reset the cache. Test-only and "settings → re-probe" use. */
export function resetImageGenCapabilityCache(): void {
  _cached = null;
}

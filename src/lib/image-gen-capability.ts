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
 *   - `webgpu-sdxl` — desktop WebGPU with `maxBufferSize >= 2 GB`.
 *   - `webgpu-sd15` — desktop WebGPU with `maxBufferSize >= 1 GB`.
 *   - `webgpu-sd-turbo` / `webgpu-janus-1b` — fallbacks for tighter VRAM
 *     (these are the picker's slice-b downgrade targets; slice a names
 *     the slot but leaves them unwired so the probe surface is stable).
 *
 * Detection runs the platform probes in priority order (native first,
 * then WebGPU). Each branch returns a DIFFERENTIATED reason string so
 * the UI can tell "wrong device" apart from "adapter not implemented
 * yet". Slice a (this file) wires the probes but every branch that WOULD
 * pick an adapter currently returns `available:false` with a "not yet
 * wired" reason — slice b adds the actual adapter bindings. Until then
 * the PRIVATE+image path stays fail-closed at the SSE-route edge.
 *
 * Detection is runtime-only (build-time flags lie about end-user
 * hardware) and memoised per session because each probe is non-trivial
 * (Capacitor plugin handshake or WebGPU adapter request).
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

/** Reason strings live as constants so tests can assert branch identity
 *  without coupling to copy. They are also the strings shown verbatim to
 *  the user when the badge is unavailable, so they must read as plain
 *  English. */
export const IMAGE_GEN_REASONS = {
  /** Native path matched (iOS A17 Pro+ / M-series), but the slice-b
   *  Apple Image Playground bridge isn't shipped yet. Slice b ships the
   *  WebGPU adapter only — the iOS plugin needs Xcode 16 / macOS, which
   *  Replit's Linux container can't build, so it lives in a follow-up
   *  task (see docs/12 §15). The branch stays fail-closed until then. */
  appleIpNotWired:
    "On-device image generation isn't enabled yet on this iPhone. We're shipping it in the next update.",
  /** Native path matched (Android SD8 Gen 2+ / Tensor G3+), but the
   *  AICore / MediaPipe Image Generator bridge isn't shipped yet — same
   *  toolchain gap as the iOS branch (Android Studio + Pixel-8-class
   *  device required). Follow-up task. */
  mediapipeNotWired:
    "On-device image generation isn't enabled yet on this Android device. We're shipping it in the next update.",
  /** WebGPU adapter present but `maxBufferSize` below the SD-Turbo floor. */
  webgpuInsufficientVram:
    "On-device image generation needs more video memory than this browser can offer.",
  /** WebGPU not supported by the browser at all (no `navigator.gpu`,
   *  or `requestAdapter()` returned null). */
  webgpuUnsupported:
    "Your browser doesn't support the WebGPU features needed for on-device image generation.",
  /** Neither native bridge nor WebGPU were reachable (e.g. SSR / Node). */
  noPathAvailable:
    "On-device image generation isn't available on this device.",
} as const;

/** Minimum buffer size for the SD-Turbo WebGPU adapter we actually ship in
 *  slice b. SDXL / Janus tiers are still defined in `ImageGenAdapterId` for
 *  forward compatibility but the picker maps both VRAM tiers to the SD-Turbo
 *  adapter today (the only adapter slice b wires). */
const SD_TURBO_MIN_BUFFER_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

/** What the native bridge returns. Kept loose because `native-on-device-llm`
 *  is the chat-text bridge today; slice b will add an analogous image probe.
 *  We sniff `platform` only and treat any reachable native bridge as a
 *  candidate native path. */
type NativeProbe = {
  available: boolean;
  platform?: "ios" | "android" | string;
};

/** WebGPU shape we depend on. Typed locally so this file compiles in
 *  Node test runs (where `navigator.gpu` is absent). */
type GpuLimits = { maxBufferSize?: number };
type GpuAdapter = { limits?: GpuLimits } | null;
type GpuLike = {
  requestAdapter?: (opts?: unknown) => Promise<GpuAdapter>;
};

let _cached: Promise<ImageGenCapability> | null = null;

/**
 * Detect the best available on-device image-gen path. Memoised for the
 * session. Pass `force: true` to re-probe (settings → re-check, or after
 * the user installs a system update).
 */
export async function detectImageGenCapability(
  opts?: { force?: boolean },
): Promise<ImageGenCapability> {
  if (_cached && !opts?.force) return _cached;
  _cached = runProbes();
  return _cached;
}

async function runProbes(): Promise<ImageGenCapability> {
  // ─── 1. Native bridge (iOS Apple IP / Android MediaPipe) ──────────────
  // Reuse the chat-text native bridge for platform detection. A reachable
  // bridge with `platform === 'ios'` on a capable device means the Apple
  // IP path is the right slot; same for Android. Slice b will replace
  // this with a dedicated `probeNativeImageGen()` that also reports
  // whether the model assets are downloaded.
  const native = await probeNative();
  if (native?.available) {
    if (native.platform === "ios") {
      return { available: false, reason: IMAGE_GEN_REASONS.appleIpNotWired };
    }
    if (native.platform === "android") {
      return { available: false, reason: IMAGE_GEN_REASONS.mediapipeNotWired };
    }
    // Bridge present but unknown platform — treat as no path so we never
    // claim support for a platform we haven't validated.
    return { available: false, reason: IMAGE_GEN_REASONS.noPathAvailable };
  }

  // ─── 2. WebGPU (desktop / capable mobile browsers) ────────────────────
  const webgpu = await probeWebGpu();
  if (webgpu.kind === "unsupported") {
    return { available: false, reason: IMAGE_GEN_REASONS.webgpuUnsupported };
  }
  if (webgpu.kind === "insufficient") {
    return {
      available: false,
      reason: IMAGE_GEN_REASONS.webgpuInsufficientVram,
    };
  }
  // Slice b: any WebGPU adapter at or above the SD-Turbo VRAM floor wins.
  // Both former tiers (sdxl-class, sd15-class) collapse onto the SD-Turbo
  // adapter for now — it's the only one with a shipped runner. SDXL / Janus
  // adapter ids stay in the public type for forward compatibility (slice
  // b+1 will register them as separate adapters and the picker will choose
  // by VRAM); the type is intentionally additive so later picker changes
  // don't bump the public surface.
  if (webgpu.kind === "sdxl" || webgpu.kind === "sd15") {
    return { available: true, adapter: "webgpu-sd-turbo" };
  }

  // ─── 3. No reachable path (SSR / Node test runner / locked-down env) ──
  return { available: false, reason: IMAGE_GEN_REASONS.noPathAvailable };
}

async function probeNative(): Promise<NativeProbe | null> {
  try {
    const native = (await import("./native-on-device-llm")) as unknown as {
      probeNativeOnDeviceLLM?: () => Promise<NativeProbe>;
    };
    if (typeof native.probeNativeOnDeviceLLM !== "function") return null;
    return await native.probeNativeOnDeviceLLM();
  } catch {
    // Capacitor plugin not registered (e.g. pure web build, Node test).
    return null;
  }
}

type WebGpuProbe =
  | { kind: "unsupported" }
  | { kind: "insufficient" }
  | { kind: "sd15" }
  | { kind: "sdxl" };

async function probeWebGpu(): Promise<WebGpuProbe> {
  // `navigator` doesn't exist in Node / SSR. `navigator.gpu` doesn't exist
  // in Safari < 18 or in Firefox stable. Treat both as unsupported with
  // the same reason.
  const nav: unknown =
    typeof navigator === "undefined" ? null : (navigator as unknown);
  const gpu: GpuLike | null =
    nav && typeof nav === "object" && "gpu" in nav
      ? ((nav as { gpu?: GpuLike }).gpu ?? null)
      : null;
  if (!gpu || typeof gpu.requestAdapter !== "function") {
    return { kind: "unsupported" };
  }
  let adapter: GpuAdapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch {
    return { kind: "unsupported" };
  }
  if (!adapter) return { kind: "unsupported" };
  const maxBuffer = Number(adapter.limits?.maxBufferSize ?? 0);
  // Two tiers preserved for forward-compat: slice b+1 will distinguish
  // SDXL-class (≥2 GB) from SD15-class (≥1 GB) when the SDXL adapter
  // ships. Today both collapse onto the SD-Turbo adapter at the picker.
  if (maxBuffer >= 2 * 1024 * 1024 * 1024) return { kind: "sdxl" };
  if (maxBuffer >= SD_TURBO_MIN_BUFFER_BYTES) return { kind: "sd15" };
  return { kind: "insufficient" };
}

/** Reset the cache. Test-only and "settings → re-probe" use. */
export function resetImageGenCapabilityCache(): void {
  _cached = null;
}

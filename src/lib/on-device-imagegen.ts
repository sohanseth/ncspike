/**
 * Client-side runner for on-device IMAGE GENERATION (Phase 2.9 — see
 * `docs/12-spec-image-gen-private.md`).
 *
 * Mirrors `src/lib/on-device-chat.ts`: a typed event stream the UI consumes
 * the same way it consumes a text turn. Slice a (this file) ships the
 * surface only — every adapter currently rejects with
 * `IMAGE_OUT_NOT_AVAILABLE`. Slice b wires real adapters (Apple Image
 * Playground, MediaPipe Image Generator, WebGPU SDXL/SD1.5/SD-Turbo/Janus).
 *
 * Failure modes are explicit — PRIVATE is fail-closed by design (no silent
 * fallback to a hosted image-gen provider per `replit.md` §"No silent
 * fallbacks" and `docs/12` §15.1.5):
 *   - No on-device capability → `error` event with `kind: 'unsupported'`.
 *   - Adapter throws → `error` event with `kind: 'internal'`; nothing is
 *     persisted server-side because the runner never round-trips for
 *     image-out turns (image bytes stay on device → uploaded under
 *     `attachment_kind = 'image_out'` only after slice b lands).
 *   - User cancels → `error` event with `kind: 'cancelled'`.
 */
import {
  detectImageGenCapability,
  type ImageGenAdapterId,
} from "./image-gen-capability";

/** Public input the UI hands the runner per turn. */
export type StreamImageGenInput = {
  /** Free-form prompt. */
  prompt: string;
  /**
   * Optional source image bytes for edit / variation turns. Empty for pure
   * text-to-image. Each entry is the raw decoded image (PNG/JPEG/WEBP);
   * the adapter handles re-encoding if the model wants something else.
   */
  sourceImages?: { bytes: Uint8Array; mime: string }[];
  /** Resolution hint. Adapters may snap to the nearest supported size. */
  width?: number;
  height?: number;
  /** Inference steps. Adapter chooses a default if omitted. */
  steps?: number;
  /** Adapter-agnostic guidance / CFG scale. Adapter clamps to its range. */
  guidance?: number;
  /** Reproducibility seed. Adapter uses time-based default if omitted. */
  seed?: number;
  /** AbortSignal — fires `error: { kind: 'cancelled' }` on the stream. */
  signal?: AbortSignal;
};

/** Event protocol — wire-compatible-ish with the text streamer for reuse. */
export type ImageGenStreamEvent =
  | { kind: "init"; adapter: ImageGenAdapterId }
  /** Adapter download / model load progress (0..1). */
  | { kind: "load_progress"; pct: number }
  /** Per-step generation progress (0..1). */
  | { kind: "step"; step: number; totalSteps: number }
  /** Final image bytes. Caller uploads to storage under `attachment_kind = 'image_out'`. */
  | {
      kind: "done";
      bytes: Uint8Array;
      mime: string;
      width: number;
      height: number;
      adapter: ImageGenAdapterId;
      seed: number;
    }
  | {
      kind: "error";
      type: "unsupported" | "internal" | "cancelled" | "validation";
      message: string;
    };

/**
 * Adapter contract — slice b will implement one per ImageGenAdapterId.
 * The runner never imports adapters directly; it dispatches via
 * `pickAdapter()` after capability detection picks the winner.
 */
export interface ImageGenAdapter {
  readonly id: ImageGenAdapterId;
  /**
   * One-shot generation. Returns an async iterator of stream events. The
   * adapter is responsible for emitting at least `init`, optionally
   * `load_progress` / `step`, then exactly one of `done` or `error`.
   */
  stream(input: StreamImageGenInput): AsyncGenerator<ImageGenStreamEvent, void, void>;
}

/**
 * Top-level runner. Capability-detects, then either yields an unsupported
 * error (slice a default — every adapter is unwired) or hands off to the
 * picked adapter. Mirrors `streamOnDeviceChat()` so the UI can consume
 * identically.
 */
export async function* streamOnDeviceImageGen(
  input: StreamImageGenInput,
): AsyncGenerator<ImageGenStreamEvent, void, void> {
  // ─── 0. Validate cancel before any work ─────────────────────────────────
  if (input.signal?.aborted) {
    yield { kind: "error", type: "cancelled", message: "Cancelled by user" };
    return;
  }

  // ─── 1. Validate prompt presence ────────────────────────────────────────
  // Empty prompt + no source image is an unrecoverable validation error;
  // an adapter would reject anyway and we'd waste a load.
  if (
    (!input.prompt || input.prompt.trim().length === 0) &&
    (!input.sourceImages || input.sourceImages.length === 0)
  ) {
    yield {
      kind: "error",
      type: "validation",
      message: "Provide a prompt or a source image to start.",
    };
    return;
  }

  // ─── 2. Capability detection (memoised) ─────────────────────────────────
  const cap = await detectImageGenCapability();
  if (!cap.available) {
    yield {
      kind: "error",
      type: "unsupported",
      message: cap.reason,
    };
    return;
  }

  // ─── 3. Pick adapter and stream ─────────────────────────────────────────
  const adapter = pickAdapter(cap.adapter);
  if (!adapter) {
    // Shouldn't happen — detectImageGenCapability returned a winner — but
    // keep an explicit branch so future adapter additions can't silently
    // fail-open. PRIVATE means we MUST refuse rather than fall back.
    yield {
      kind: "error",
      type: "unsupported",
      message: "On-device image generation isn't wired yet on this device.",
    };
    return;
  }

  yield { kind: "init", adapter: adapter.id };
  for await (const ev of adapter.stream(input)) {
    if (input.signal?.aborted) {
      yield { kind: "error", type: "cancelled", message: "Cancelled by user" };
      return;
    }
    yield ev;
    if (ev.kind === "done" || ev.kind === "error") return;
  }
}

/**
 * Adapter dispatcher. Slice a ships no adapters; slice b will register
 * each (apple-ip / mediapipe / webgpu-*) and route here. Returning `null`
 * means PRIVATE+image MUST refuse — never fall back to a hosted provider.
 */
function pickAdapter(_id: ImageGenAdapterId): ImageGenAdapter | null {
  return null;
}

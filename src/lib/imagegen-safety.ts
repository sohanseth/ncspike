/**
 * Phase 2.9b — output-side safety gate for on-device generated images.
 *
 * This module implements the locked NSFW pipeline from
 * `docs/12-spec-image-gen-private.md` §15.4:
 *
 *   - **WebGPU path** runs an NSFW image classifier on-device via
 *     `@huggingface/transformers` (a NSFWJS-equivalent ViT pinned by
 *     model id). No bytes leave the device — the classifier runs in
 *     the user's GPU/WASM runtime against the just-generated image
 *     held in memory.
 *   - **iOS path** calls `VNClassifyImageRequest` via the Capacitor
 *     plugin `NCImageSafetyVision`.
 *   - **Android path** calls MediaPipe Image Classifier via the
 *     Capacitor plugin `NCImageSafetyMediaPipe`.
 *
 * Contract:
 *   - `classifyGeneratedImage(bytes, mime)` returns `{ allow, reason? }`.
 *   - The gate is fail-CLOSED:
 *       * Any throw → `{allow: false, reason: '…'}`.
 *       * Classifier model fails to load → deny (§15.4: never persist
 *         an unchecked image).
 *       * Classifier itself throws mid-inference → deny.
 *       * Classifier flags the image → deny with the §15.4 toast.
 *   - The gate runs CLIENT-SIDE before the bytes are uploaded. Refused
 *     bytes never touch the storage bucket.
 *
 * Native plugin source for iOS (`NCImageSafetyVision.swift`) and
 * Android (`NCImageSafetyMediaPipe.kt`) lives outside this repo until
 * `npx cap add ios|android` has been run on a Mac / Android Studio
 * respectively (Replit's Linux container can't build them, same gap
 * documented in `src/lib/native-on-device-llm.ts`). The bridge below
 * activates automatically once those plugins are registered.
 *
 * Tests inject a fake classifier via `__setNsfwClassifierForTests`
 * because (a) Node's vitest runner has no WebGPU and no Capacitor
 * bridge, and (b) we want to assert both deny verdicts (model-flagged)
 * and allow verdicts deterministically without downloading model
 * weights at test time.
 */
/**
 * Structured reason category for a deny verdict. Persisted by the
 * dispatcher onto `inference_usage.metadata.image_blocked_reason`
 * (Task #51) so the CPAUD admin surface can group blocked turns by
 * what triggered the refusal — not just by which adapter ran.
 *
 *   - `nsfw`                  — the on-device NSFW classifier flagged
 *                               the image with confidence ≥ threshold.
 *   - `classifier_unavailable`— the classifier model failed to load or
 *                               threw mid-inference (fail-CLOSED — we
 *                               still deny so we never persist an
 *                               unchecked image).
 *   - `invalid_image`         — structural pre-checks rejected the
 *                               bytes (too small, too large, mime not
 *                               in the allow-list).
 *   - `other`                 — any unexpected throw the inner branches
 *                               missed (belt-and-braces fail-closed).
 *
 * The list is closed for now — adding a category (e.g. when the
 * prompt-injection gate ships) is a deliberate change, not a free
 * string, so the CPAUD aggregation can stay typed.
 */
export type ImageSafetyReason =
  | "nsfw"
  | "classifier_unavailable"
  | "invalid_image"
  | "other";

export type ImageSafetyVerdict =
  | { allow: true }
  | { allow: false; reason: string; reasonCategory: ImageSafetyReason };

const MIN_BYTES = 64;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB hard cap on stored generated images
const ALLOWED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/** §15.4 toast text. Surfaced verbatim to the user when the classifier
 *  flags an output OR when the classifier model can't be loaded. The
 *  same string is used for both because we don't leak to the user
 *  whether the deny was "model-flagged" vs "model-unavailable" — both
 *  are "we couldn't certify this image as safe, so we won't store it".
 */
const NSFW_TOAST =
  "Generated image was blocked by on-device safety filter. Try a different prompt.";

/** Classifier scores below this aren't enough to flag on their own —
 *  we want a confident verdict, not a hair-trigger. Tuned conservatively;
 *  model id + threshold are part of the spec, bumping either is a
 *  deliberate change. */
const UNSAFE_THRESHOLD = 0.6;

/** Substrings that mark a label as unsafe. Matched case-insensitively
 *  via `includes()` because the supported model families use slightly
 *  different label vocabularies (Falconsai uses {normal, nsfw};
 *  NSFWJS uses {drawings, hentai, neutral, porn, sexy}; Vision uses
 *  Apple-internal scene tags like "Explicit" / "Nudity"). */
const UNSAFE_LABEL_NEEDLES = [
  "nsfw",
  "porn",
  "hentai",
  "explicit",
  "nudity",
  "sexy",
] as const;

export type NsfwClassifierResult = {
  /** True iff the model is confident the image is unsafe. */
  nsfw: boolean;
  /** Top label string for diagnostics (never persisted server-side). */
  topLabel?: string;
  /** Top label score in [0, 1]. */
  score?: number;
};

export type NsfwClassifier = (
  bytes: Uint8Array,
  mime: string,
) => Promise<NsfwClassifierResult>;

let _override: NsfwClassifier | null = null;
let _loadPromise: Promise<NsfwClassifier> | null = null;

/**
 * Test-only injector. Production code never calls this. Pass `null` to
 * clear and force the production load path on the next call.
 */
export function __setNsfwClassifierForTests(
  fn: NsfwClassifier | null,
): void {
  _override = fn;
  _loadPromise = null;
}

/** Reset the cached classifier promise. Test-only / settings "free
 *  GPU memory" use. */
export function __resetNsfwClassifierCache(): void {
  _loadPromise = null;
}

export async function classifyGeneratedImage(
  bytes: Uint8Array,
  mime: string,
): Promise<ImageSafetyVerdict> {
  try {
    // ─── 1. Structural checks (cheap, run first) ─────────────────────────
    if (!bytes || bytes.length < MIN_BYTES) {
      return {
        allow: false,
        reason: "Generated image is too small to be a valid image.",
        reasonCategory: "invalid_image",
      };
    }
    if (bytes.length > MAX_BYTES) {
      return {
        allow: false,
        reason: "Generated image exceeds the 25 MB safety cap.",
        reasonCategory: "invalid_image",
      };
    }
    if (!ALLOWED_MIMES.has(mime)) {
      return {
        allow: false,
        reason: `Generated image mime "${mime}" is not in the allow-list.`,
        reasonCategory: "invalid_image",
      };
    }

    // ─── 2. Load classifier (fail-closed on load failure, §15.4) ─────────
    let classifier: NsfwClassifier;
    try {
      classifier = await getClassifier();
    } catch {
      return {
        allow: false,
        reason: NSFW_TOAST,
        reasonCategory: "classifier_unavailable",
      };
    }

    // ─── 3. Run classifier (fail-closed on inference failure) ────────────
    let result: NsfwClassifierResult;
    try {
      result = await classifier(bytes, mime);
    } catch {
      return {
        allow: false,
        reason: NSFW_TOAST,
        reasonCategory: "classifier_unavailable",
      };
    }

    if (result.nsfw) {
      return { allow: false, reason: NSFW_TOAST, reasonCategory: "nsfw" };
    }
    return { allow: true };
  } catch (err) {
    // Belt-and-braces fail-closed for any throw the inner branches missed.
    return {
      allow: false,
      reason:
        err instanceof Error
          ? `Image safety check failed: ${err.message}`
          : "Image safety check failed.",
      reasonCategory: "other",
    };
  }
}

async function getClassifier(): Promise<NsfwClassifier> {
  if (_override) return _override;
  if (_loadPromise) return _loadPromise;
  // If the load fails (transient WebGPU hiccup, model fetch network
  // blip), clear the cached promise so the NEXT generation attempt
  // can retry. We still fail-CLOSED on this turn — the dispatcher
  // gets a deny verdict — but the user isn't pinned to "broken
  // forever" by a one-off failure.
  const p = loadBestClassifier();
  _loadPromise = p;
  p.catch(() => {
    if (_loadPromise === p) _loadPromise = null;
  });
  return p;
}

async function loadBestClassifier(): Promise<NsfwClassifier> {
  // Priority order matches docs/12 §15.4: native first (Apple Vision /
  // MediaPipe — zero download, OS-bundled), then WebGPU NSFWJS-style.
  const ios = await tryLoadNativeClassifier("ios", "NCImageSafetyVision");
  if (ios) return ios;
  const android = await tryLoadNativeClassifier(
    "android",
    "NCImageSafetyMediaPipe",
  );
  if (android) return android;
  return await loadWebClassifier();
}

type NativeSafetyPlugin = {
  isAvailable(): Promise<{ available: boolean }>;
  classify(opts: {
    pngBase64: string;
    mime: string;
  }): Promise<{ nsfw: boolean; topLabel?: string; score?: number }>;
};

async function tryLoadNativeClassifier(
  want: "ios" | "android",
  pluginName: string,
): Promise<NsfwClassifier | null> {
  if (typeof window === "undefined") return null;
  try {
    const cap = await import(/* @vite-ignore */ "@capacitor/core");
    const Cap = (
      cap as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          getPlatform?: () => string;
          Plugins?: Record<string, unknown>;
        };
      }
    ).Capacitor;
    if (!Cap?.isNativePlatform?.()) return null;
    if (Cap.getPlatform?.() !== want) return null;
    const plugin = Cap.Plugins?.[pluginName] as
      | NativeSafetyPlugin
      | undefined;
    if (!plugin) return null;
    const probe = await plugin.isAvailable();
    if (!probe?.available) return null;
    return async (bytes, mime) => {
      const r = await plugin.classify({
        pngBase64: toBase64(bytes),
        mime,
      });
      return {
        nsfw: !!r?.nsfw,
        topLabel: r?.topLabel,
        score: typeof r?.score === "number" ? r.score : undefined,
      };
    };
  } catch {
    // Capacitor not present (pure web build) → fall through to WebGPU.
    return null;
  }
}

type TransformersPipelineFn = (
  task: string,
  model: string,
  options?: Record<string, unknown>,
) => Promise<unknown>;

type ImageClassifierPipeline = (
  input: Blob | string,
  opts?: { topk?: number },
) => Promise<Array<{ label: string; score: number }>>;

/** Pinned NSFW classifier. Falconsai's ViT-based binary detector ships
 *  with ONNX weights on the Hugging Face Hub and weighs ~86 MB —
 *  comparable to NSFWJS's MobileNet but reuses the transformers.js
 *  runtime we already loaded for SD-Turbo, so no second JS dep. */
const WEB_MODEL_ID = "Falconsai/nsfw_image_detection";

async function loadWebClassifier(): Promise<NsfwClassifier> {
  // No browser → no WebGPU and no `Blob` URL flow. Refuse to load so
  // the gate fail-closes (Node test runner takes this branch unless a
  // test injects a classifier override).
  if (
    typeof window === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  ) {
    throw new Error("On-device NSFW classifier needs a browser runtime.");
  }
  const mod = (await import(
    /* @vite-ignore */ "@huggingface/transformers"
  )) as { pipeline: TransformersPipelineFn };

  // Try WebGPU first; fall back to WASM if the device can't host the
  // model on GPU. Both are on-device — no network egress for inference.
  let pipe: ImageClassifierPipeline;
  try {
    pipe = (await mod.pipeline("image-classification", WEB_MODEL_ID, {
      device: "webgpu",
      dtype: "fp16",
    })) as ImageClassifierPipeline;
  } catch {
    pipe = (await mod.pipeline("image-classification", WEB_MODEL_ID, {
      device: "wasm",
    })) as ImageClassifierPipeline;
  }

  return async (bytes, mime) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      const out = await pipe(url, { topk: 5 });
      const top = out[0];
      const flagged = out.some(
        (r) => isUnsafeLabel(r.label) && r.score >= UNSAFE_THRESHOLD,
      );
      return {
        nsfw: flagged,
        topLabel: top?.label,
        score: top?.score,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  };
}

function isUnsafeLabel(label: string): boolean {
  const k = label.toLowerCase();
  for (const needle of UNSAFE_LABEL_NEEDLES) {
    if (k.includes(needle)) return true;
  }
  return false;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked btoa to avoid blowing the call stack on large images.
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  if (typeof btoa === "function") return btoa(s);
  // Node fallback (test runner).
  return Buffer.from(bytes).toString("base64");
}

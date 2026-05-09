/**
 * Phase 2.9c — WebGPU on-device img2img adapter (SDXL + InstructPix2Pix).
 *
 * Desktop-class GPU tier (≥ 2 GB `maxBufferSize`). Uses InstructPix2Pix —
 * the canonical "edit this photo following a text instruction" model — via
 * Hugging Face's `@huggingface/transformers` v4 WebGPU backend. The model
 * weights (~4 GB on first run) download into the browser's OPFS/cache and
 * reuse on subsequent runs. No bytes ever leave the device — generation
 * runs entirely in the user's GPU.
 *
 * Slice c ships this adapter and `webgpu-sd15-controlnet` (mid-tier).
 * Apple Core ML SD 1.5 + ControlNet (iOS) and MediaPipe ControlNet plugin
 * (Android) live in follow-up tasks because their plugin source needs
 * Xcode 16 / Android Studio respectively (Replit's Linux container can't
 * build them). The dispatcher in `pickAdapter()` keeps those branches as
 * `null` (fail-closed) — never a silent fallback to this WebGPU adapter,
 * per `replit.md` §"No silent fallbacks".
 *
 * Mirrors `webgpu-sd-turbo.ts` shape so a future refactor can collapse
 * the loaders behind a shared helper if more adapters land.
 */
import type {
  ImageGenAdapter,
  ImageGenStreamEvent,
  StreamImageGenInput,
} from "@/lib/on-device-imagegen";

const MODEL_ID = "diffusers/sdxl-instructpix2pix-768";
const MODEL_REVISION = "main";

const DEFAULT_STEPS = 20;
const DEFAULT_GUIDANCE = 7.5;
const DEFAULT_IMAGE_GUIDANCE = 1.5;

type TransformersModule = {
  pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  RawImage?: {
    fromBlob: (blob: Blob) => Promise<unknown>;
  };
};

type EditPipeline = (
  prompt: string,
  options: {
    image: unknown;
    num_inference_steps?: number;
    guidance_scale?: number;
    image_guidance_scale?: number;
    seed?: number;
  },
) => Promise<{
  images?: Array<{
    toBlob?: () => Promise<Blob>;
    data?: Uint8Array;
    width?: number;
    height?: number;
  }>;
}>;

let _pipeline: EditPipeline | null = null;
let _rawImage: TransformersModule["RawImage"] | null = null;

async function loadPipeline(): Promise<{
  pipeline: EditPipeline;
  RawImage: NonNullable<TransformersModule["RawImage"]>;
}> {
  let mod: TransformersModule;
  try {
    mod = (await import(
      /* @vite-ignore */ "@huggingface/transformers"
    )) as TransformersModule;
  } catch {
    throw new Error(
      "WebGPU image-edit runtime (@huggingface/transformers) is not " +
        "installed. Add it to package.json to enable PRIVATE photo " +
        "editing in the browser.",
    );
  }
  if (!mod.RawImage) {
    throw new Error(
      "@huggingface/transformers is missing RawImage — please upgrade " +
        "to a version that supports image-to-image pipelines.",
    );
  }
  if (!_pipeline) {
    _pipeline = (await mod.pipeline("image-to-image", MODEL_ID, {
      revision: MODEL_REVISION,
      device: "webgpu",
      dtype: "fp16",
    })) as EditPipeline;
  }
  _rawImage = mod.RawImage;
  return { pipeline: _pipeline, RawImage: mod.RawImage };
}

/** Reset the cached pipeline. Test-only / "free GPU memory" use. */
export function resetWebGpuSdxlIp2pCache(): void {
  _pipeline = null;
  _rawImage = null;
}

export const webgpuSdxlIp2pAdapter: ImageGenAdapter = {
  id: "webgpu-sdxl-ip2p",
  async *stream(
    input: StreamImageGenInput,
  ): AsyncGenerator<ImageGenStreamEvent, void, void> {
    if (input.signal?.aborted) {
      yield { kind: "error", type: "cancelled", message: "Cancelled by user" };
      return;
    }

    // InstructPix2Pix REQUIRES a source image — refuse a text-only prompt
    // here rather than degrading to text-to-image (silent degradation
    // would be a fail-open per replit.md).
    if (!input.sourceImages || input.sourceImages.length === 0) {
      yield {
        kind: "error",
        type: "validation",
        message:
          "Photo editing needs a source image. Attach a photo to edit, or " +
          "remove the attachment and ask to generate from scratch.",
      };
      return;
    }
    // v1 accepts a single source image (multi-image style transfer is
    // out of scope per docs/12 §15.5 deferred list).
    const src = input.sourceImages[0];

    let pipeline: EditPipeline;
    let RawImage: NonNullable<TransformersModule["RawImage"]>;
    try {
      ({ pipeline, RawImage } = await loadPipeline());
    } catch (err) {
      yield {
        kind: "error",
        type: "internal",
        message: err instanceof Error ? err.message : "Failed to load model",
      };
      return;
    }

    if (input.signal?.aborted) {
      yield { kind: "error", type: "cancelled", message: "Cancelled by user" };
      return;
    }

    const steps = Math.max(1, Math.min(input.steps ?? DEFAULT_STEPS, 50));
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);

    let image: unknown;
    try {
      const blob = new Blob([new Uint8Array(src.bytes)], { type: src.mime });
      image = await RawImage.fromBlob(blob);
    } catch (err) {
      yield {
        kind: "error",
        type: "validation",
        message:
          err instanceof Error ? err.message : "Couldn't decode the source image",
      };
      return;
    }

    let result: Awaited<ReturnType<EditPipeline>>;
    try {
      result = await pipeline(input.prompt, {
        image,
        num_inference_steps: steps,
        guidance_scale: input.guidance ?? DEFAULT_GUIDANCE,
        image_guidance_scale: DEFAULT_IMAGE_GUIDANCE,
        seed,
      });
    } catch (err) {
      if (input.signal?.aborted) {
        yield {
          kind: "error",
          type: "cancelled",
          message: "Cancelled by user",
        };
        return;
      }
      yield {
        kind: "error",
        type: "internal",
        message:
          err instanceof Error ? err.message : "Image editing failed",
      };
      return;
    }

    yield { kind: "step", step: steps, totalSteps: steps };

    const out = result.images?.[0];
    if (!out) {
      yield {
        kind: "error",
        type: "internal",
        message: "Model produced no image",
      };
      return;
    }

    let bytes: Uint8Array;
    let mime = "image/png";
    let width = 0;
    let height = 0;
    try {
      if (typeof out.toBlob === "function") {
        const b = await out.toBlob();
        bytes = new Uint8Array(await b.arrayBuffer());
        mime = b.type || "image/png";
      } else if (out.data) {
        bytes = out.data;
      } else {
        throw new Error("Image has neither toBlob() nor raw data");
      }
      width = out.width ?? 0;
      height = out.height ?? 0;
    } catch (err) {
      yield {
        kind: "error",
        type: "internal",
        message:
          err instanceof Error ? err.message : "Failed to encode image bytes",
      };
      return;
    }

    yield {
      kind: "done",
      bytes,
      mime,
      width,
      height,
      adapter: "webgpu-sdxl-ip2p",
      seed,
    };
  },
};

/**
 * Phase 2.9c — WebGPU on-device img2img adapter (SD 1.5 + ControlNet).
 *
 * Mid-tier WebGPU device (≥ 1 GB `maxBufferSize`, < 2 GB SDXL floor).
 * Uses Stable Diffusion 1.5 with a depth/lineart ControlNet conditioner
 * via Hugging Face's `@huggingface/transformers` v4 WebGPU backend.
 * Roughly ~1.5 GB of weights download on first run into OPFS/cache.
 *
 * Slice c ships this adapter alongside `webgpu-sdxl-ip2p` (desktop). The
 * picker resolves to this one when the user's GPU has enough memory for
 * SD 1.5 but not for SDXL. No bytes ever leave the device.
 *
 * Mirrors `webgpu-sd-turbo.ts` shape — fail-closed on a missing source
 * image (img2img is the entire point of this adapter), fail-closed on a
 * missing transformers.js install, fail-closed on adapter throws.
 */
import type {
  ImageGenAdapter,
  ImageGenStreamEvent,
  StreamImageGenInput,
} from "@/lib/on-device-imagegen";

const MODEL_ID = "Xenova/stable-diffusion-v1-5-controlnet";
const MODEL_REVISION = "main";

const DEFAULT_STEPS = 20;
const DEFAULT_GUIDANCE = 7.5;
const DEFAULT_STRENGTH = 0.75;

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
    strength?: number;
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
  return { pipeline: _pipeline, RawImage: mod.RawImage };
}

/** Reset the cached pipeline. Test-only / "free GPU memory" use. */
export function resetWebGpuSd15ControlNetCache(): void {
  _pipeline = null;
}

export const webgpuSd15ControlNetAdapter: ImageGenAdapter = {
  id: "webgpu-sd15-controlnet",
  async *stream(
    input: StreamImageGenInput,
  ): AsyncGenerator<ImageGenStreamEvent, void, void> {
    if (input.signal?.aborted) {
      yield { kind: "error", type: "cancelled", message: "Cancelled by user" };
      return;
    }

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
        strength: DEFAULT_STRENGTH,
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
      adapter: "webgpu-sd15-controlnet",
      seed,
    };
  },
};

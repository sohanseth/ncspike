/**
 * Inference dispatcher. Selects a provider via the INFERENCE_PROVIDER env
 * var (default: "cloudflare"). Adapters for openai/anthropic/openrouter
 * are loaded lazily so they add zero bundle weight when unused.
 */
import { lovableProvider } from "./lovable";
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

export type { InferenceMessage, InferenceRequest, InferenceResult } from "./types";
export { InferenceError } from "./types";

const PROVIDER_LOADERS: Record<string, () => Promise<InferenceProvider>> = {
  lovable: async () => lovableProvider,
  cloudflare: async () => (await import("./cloudflare")).cloudflareProvider,
};

let _selected: Promise<InferenceProvider> | undefined;

function getProvider(): Promise<InferenceProvider> {
  if (_selected) return _selected;
  const id = (process.env.INFERENCE_PROVIDER || "lovable").toLowerCase();
  const loader = PROVIDER_LOADERS[id];
  if (!loader) {
    throw new InferenceError(
      `Unknown INFERENCE_PROVIDER: ${id}. Known: ${Object.keys(PROVIDER_LOADERS).join(", ")}`,
      id,
    );
  }
  _selected = loader();
  return _selected;
}

/** Provider-agnostic generation. Throws InferenceError on failure. */
export async function generate(req: InferenceRequest): Promise<InferenceResult> {
  const provider = await getProvider();
  return provider.generate(req);
}

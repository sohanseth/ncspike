/**
 * Inference dispatcher.
 *
 * D7 (Phase 2.6) replaces the previous singleton-via-INFERENCE_PROVIDER pattern
 * with `getProvider(id)` so chatGenerate can pick a provider per request based
 * on the badge → chain resolution from `router.ts`. The legacy no-arg
 * `generate()` remains for non-chat callers (briefings, voice drafts, etc.)
 * and routes via INFERENCE_PROVIDER (default "lovable") to keep them stable.
 *
 * Adapters are loaded lazily so unused providers add zero bundle weight.
 */
import { lovableProvider } from "./lovable";
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";
import type { ProviderId } from "./tiers";

export type { InferenceMessage, InferenceRequest, InferenceResult } from "./types";
export { InferenceError } from "./types";
export { PROVIDER_TIERS, tierOf, strictestTierInChain, type PrivacyTier, type ProviderId } from "./tiers";

const PROVIDER_LOADERS: Record<ProviderId, () => Promise<InferenceProvider>> = {
  lovable: async () => lovableProvider,
  cloudflare: async () => (await import("./cloudflare")).cloudflareProvider,
  groq: async () => (await import("./groq")).groqProvider,
  google: async () => (await import("./google")).googleProvider,
  openai: async () => (await import("./openai")).openaiProvider,
  anthropic: async () => (await import("./anthropic")).anthropicProvider,
};

const _cache = new Map<ProviderId, Promise<InferenceProvider>>();

export function getProvider(id: ProviderId): Promise<InferenceProvider> {
  let p = _cache.get(id);
  if (p) return p;
  const loader = PROVIDER_LOADERS[id];
  if (!loader) {
    throw new InferenceError(
      `Unknown provider: ${id}. Known: ${Object.keys(PROVIDER_LOADERS).join(", ")}`,
      id,
    );
  }
  p = loader();
  _cache.set(id, p);
  return p;
}

/**
 * Legacy provider-agnostic generation. Used by non-chat callers (briefings,
 * voice drafts, research-cron) that don't need badge-based routing.
 *
 * Selects via INFERENCE_PROVIDER env var (default "lovable"). Chat traffic
 * should call `getProvider(id).generate(...)` directly via the router.
 */
export async function generate(req: InferenceRequest): Promise<InferenceResult> {
  const id = ((process.env.INFERENCE_PROVIDER || "lovable").toLowerCase() as ProviderId);
  const provider = await getProvider(id);
  return provider.generate(req);
}

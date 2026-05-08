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
import type { ProviderId } from "@/lib/provider-tiers";

export type { InferenceMessage, InferenceRequest, InferenceResult } from "./types";
export { InferenceError } from "./types";
export { PROVIDER_TIERS, tierOf, strictestTierInChain, type PrivacyTier, type ProviderId } from "@/lib/provider-tiers";

/**
 * Server-side stub for on-device providers. The PRIVATE badge runs entirely
 * on the user's device — the server must NEVER execute generation for these
 * IDs. The client dispatcher in `src/lib/chat-stream.ts` short-circuits
 * before ever POSTing to `/api/chat/stream`; this stub is a defense-in-depth
 * guard in case anything reaches the chain runner anyway. See docs/11.
 */
function onDeviceServerStub(id: ProviderId): InferenceProvider {
  const msg =
    `Provider '${id}' is on-device only and cannot run on the server. ` +
    `The client must invoke the on-device path directly. See docs/11.`;
  async function* throwing(): AsyncGenerator<never, void, void> {
    throw new InferenceError(msg, id, { errorClass: "unknown", retriable: false });
  }
  return {
    id,
    privacyTier: -1,
    async generate() {
      throw new InferenceError(msg, id, { errorClass: "unknown", retriable: false });
    },
    generateStream: throwing,
  } satisfies InferenceProvider;
}

const PROVIDER_LOADERS: Record<ProviderId, () => Promise<InferenceProvider>> = {
  lovable: async () => lovableProvider,
  cloudflare: async () => (await import("./cloudflare")).cloudflareProvider,
  groq: async () => (await import("./groq")).groqProvider,
  google: async () => (await import("./google")).googleProvider,
  openai: async () => (await import("./openai")).openaiProvider,
  anthropic: async () => (await import("./anthropic")).anthropicProvider,
  onDeviceApple: async () => onDeviceServerStub("onDeviceApple"),
  onDeviceAndroid: async () => onDeviceServerStub("onDeviceAndroid"),
  onDeviceWebLLM: async () => onDeviceServerStub("onDeviceWebLLM"),
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

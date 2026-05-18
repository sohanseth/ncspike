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
import { chainFor, modalityFor, type Badge } from "./router";
import { isOnDeviceProvider, type ProviderId } from "@/lib/provider-tiers";

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
  // Phase 2.9b — on-device IMAGE providers. Server-side execution is a
  // hard error for the same reason as the text on-device providers:
  // these only run in the user's browser/native shell. The chat router
  // never composes them into a chain, so this stub exists purely so the
  // ProviderId record stays exhaustive.
  onDeviceWebGpuImage: async () => onDeviceServerStub("onDeviceWebGpuImage"),
  onDeviceAppleImage: async () => onDeviceServerStub("onDeviceAppleImage"),
  onDeviceAndroidImage: async () => onDeviceServerStub("onDeviceAndroidImage"),
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
 * Provider-agnostic generation. Two modes:
 *
 *   - With `opts.badge` (preferred for agent/template callers): walks
 *     `chainFor(badge).chain` with the same 429/5xx fall-through semantics
 *     as `runChain` in chat.ts — retriable errors advance to the next
 *     provider, non-retriable errors throw immediately, failClosed badges
 *     never silently fall through. Chain exhaustion re-throws the last
 *     provider's InferenceError so callers can scrub + record it.
 *
 *   - Without a badge (legacy callers — voice drafts, email intent,
 *     agent-tools): single-provider via INFERENCE_PROVIDER env (default
 *     "lovable"). No retry, no fallback. Same behaviour as before
 *     2026-05-18.
 *
 * Chat traffic still calls `runChain` directly — that path needs the cap
 * accounting + per-hop inference_usage rows that this dispatcher
 * deliberately doesn't replicate.
 */
export async function generate(
  req: InferenceRequest,
  opts?: { badge?: Badge },
): Promise<InferenceResult> {
  if (opts?.badge) {
    return generateViaChain(req, opts.badge);
  }
  const id = ((process.env.INFERENCE_PROVIDER || "lovable").toLowerCase() as ProviderId);
  const provider = await getProvider(id);
  return provider.generate(req);
}

async function generateViaChain(
  req: InferenceRequest,
  badge: Badge,
): Promise<InferenceResult> {
  const cfg = chainFor(badge);
  if (modalityFor(cfg) === "image-out") {
    throw new InferenceError(
      `Badge '${badge}' resolves to an image-out chain; not callable via generate().`,
      "router",
      { errorClass: "unknown", retriable: false },
    );
  }
  // Mirror chat.ts's defense-in-depth guard. Agent templates default to
  // 'flash' so this branch is dormant today, but a future template that
  // sets defaultBadge='private' would otherwise resolve to on-device
  // stubs that always throw — surface the misroute loudly.
  const onDevice = cfg.chain.find(isOnDeviceProvider);
  if (onDevice !== undefined) {
    throw new InferenceError(
      `Badge '${badge}' resolves to an on-device chain (${onDevice}); ` +
        `generate() cannot run on-device providers server-side.`,
      "router",
      { errorClass: "unknown", retriable: false },
    );
  }

  let lastError: unknown = new InferenceError(
    `Chain for badge '${badge}' is empty`,
    "router",
    { errorClass: "unknown", retriable: false },
  );
  for (let i = 0; i < cfg.chain.length; i++) {
    const providerId = cfg.chain[i];
    try {
      const provider = await getProvider(providerId);
      return await provider.generate(req);
    } catch (e) {
      lastError = e;
      // Fail-closed badges (PRIVATE) MUST NOT silently fall through.
      if (cfg.failClosed) throw e;
      // Non-retriable errors (bad shape, missing creds) are adapter/config
      // bugs that further providers won't fix — re-throw rather than
      // burning the rest of the chain.
      const retriable = e instanceof InferenceError ? e.retriable : false;
      if (!retriable) throw e;
      // Otherwise: advance to next provider.
    }
  }
  throw lastError;
}

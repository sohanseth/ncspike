/**
 * Privacy tier declarations per provider. See docs/06-spec-phase-2.7-context-broker.md §B4
 * and docs/11-spec-on-device-tier.md.
 *
 *   T-1 — On-device. Runs entirely on the user's hardware (Apple Foundation
 *         Models, Gemini Nano via AICore, or WebLLM). Nothing leaves the
 *         device. Most permissive: full personalization with no redaction.
 *   T0  — On-platform (Workers AI). Full personalization allowed.
 *   T1  — Hosted OSS, ZDR (Groq). Most categories OK; no household, no transient.
 *   T2  — Hosted closed, ZDR (Google, Lovable). Top-K categories, max 3.
 *   T3  — Hosted closed, no ZDR (OpenAI, Anthropic). Top-K, max 2; never household, never wellness.
 *
 * Higher number = stricter. -1 is most permissive (data is local).
 *
 * The broker (D8) selects context for the
 * `strictestTierInChain = max(chain.privacyTier)` per D7 §C4-bis, eliminating
 * the bypass class where a fragment assembled for tier N could leak to a
 * provider with stricter rules.
 */
export type PrivacyTier = -1 | 0 | 1 | 2 | 3;

export const PROVIDER_TIERS = {
  // T-1 — on-device (see docs/11-spec-on-device-tier.md). The three IDs are
  // the three pathways the PRIVATE badge can run on; capability detection
  // picks the right one per device. Server-side execution of these IDs is
  // a hard error — see src/server/inference/index.ts and chat.ts.
  onDeviceApple: -1,
  onDeviceAndroid: -1,
  onDeviceWebLLM: -1,
  // T0 — Cloudflare Workers AI. Now used by FLASH chain only; the PRIVATE
  // badge no longer routes here, because "data leaves the device" is not
  // what users expect from the word "private".
  cloudflare: 0,
  groq: 1,
  google: 2,
  lovable: 2,
  openai: 3,
  anthropic: 3,
} as const satisfies Record<string, PrivacyTier>;

export type ProviderId = keyof typeof PROVIDER_TIERS;

/**
 * The three on-device provider IDs. Useful for short-circuit checks in the
 * client dispatcher and the server-side defensive guard in `runChain`.
 */
export const ON_DEVICE_PROVIDERS = [
  "onDeviceApple",
  "onDeviceAndroid",
  "onDeviceWebLLM",
] as const satisfies readonly ProviderId[];

export type OnDeviceProviderId = (typeof ON_DEVICE_PROVIDERS)[number];

export function isOnDeviceProvider(id: ProviderId): id is OnDeviceProviderId {
  return (ON_DEVICE_PROVIDERS as readonly ProviderId[]).includes(id);
}

export function tierOf(provider: ProviderId): PrivacyTier {
  return PROVIDER_TIERS[provider];
}

/**
 * Strictest (= numerically max) tier across a chain. Empty chain returns 0
 * (the historical default), but in practice chains are never empty because
 * the router builds them from a fixed table.
 *
 * NOTE: must seed from chain[0]'s tier rather than 0 — otherwise an
 * all-on-device chain (e.g. PRIVATE = [onDeviceApple, onDeviceAndroid,
 * onDeviceWebLLM]) would falsely report tier 0 because max(-1, 0) = 0.
 */
export function strictestTierInChain(chain: ProviderId[]): PrivacyTier {
  if (chain.length === 0) return 0;
  let max: PrivacyTier = PROVIDER_TIERS[chain[0]!];
  for (let i = 1; i < chain.length; i++) {
    const t = PROVIDER_TIERS[chain[i]!];
    if (t > max) max = t;
  }
  return max;
}

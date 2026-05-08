/**
 * Privacy tier declarations per provider. See docs/06-spec-phase-2.7-context-broker.md §B4.
 *
 *   T0 — On-platform (Workers AI). Full personalization allowed.
 *   T1 — Hosted OSS, ZDR (Groq). Most categories OK; no household, no transient.
 *   T2 — Hosted closed, ZDR (Google, Lovable). Top-K categories, max 3.
 *   T3 — Hosted closed, no ZDR (OpenAI, Anthropic). Top-K, max 2; never household, never wellness.
 *
 * Higher number = stricter. The broker (D8) selects context for the
 * `strictestTierInChain = max(chain.privacyTier)` per D7 §C4-bis, eliminating
 * the bypass class where a fragment assembled for tier N could leak to a
 * provider with stricter rules.
 */
export type PrivacyTier = 0 | 1 | 2 | 3;

export const PROVIDER_TIERS = {
  cloudflare: 0,
  groq: 1,
  google: 2,
  lovable: 2,
  openai: 3,
  anthropic: 3,
} as const satisfies Record<string, PrivacyTier>;

export type ProviderId = keyof typeof PROVIDER_TIERS;

export function tierOf(provider: ProviderId): PrivacyTier {
  return PROVIDER_TIERS[provider];
}

export function strictestTierInChain(chain: ProviderId[]): PrivacyTier {
  if (chain.length === 0) return 0;
  return chain.reduce<PrivacyTier>((max, p) => {
    const t = PROVIDER_TIERS[p];
    return t > max ? t : max;
  }, 0);
}

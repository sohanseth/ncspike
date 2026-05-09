/**
 * Badge → provider chain resolver. See docs/05-spec-phase-2.6-chat-providers.md §C2.
 *
 * The four UI badges are intent profiles. Users pick intent; we pick provider.
 * Each chain has a primary + fallbacks. The PRIVATE chain has length 1
 * (fail-closed, no silent fallback to a non-private provider — see §C4).
 */
import type { ProviderId } from "@/lib/provider-tiers";

export type Badge = "flash" | "pro" | "genius" | "private";

/**
 * Output modality of a chain. Phase 2.9a (slice a) introduces this fork so
 * the runner can route image-generation turns separately from text turns
 * without refactoring the existing text path. All shipping chains default
 * to `'text-out'` for now; an `'image-out'` chain is reachable only via
 * future routing in slice b. See docs/12-spec-image-gen-private.md §15.
 */
export type Modality = "text-out" | "image-out";

export type BadgeChain = {
  badge: Badge;
  /** Display label shown in the UI. */
  label: string;
  /** Ordered chain. Index 0 is primary, rest are fallbacks. */
  chain: ProviderId[];
  /** True = badge requires paid tier. Free users see an upsell. */
  paidOnly: boolean;
  /** True = no fallback allowed. PRIVATE-only. */
  failClosed: boolean;
  /**
   * Output modality. Defaults to `'text-out'` if omitted (every shipping
   * chain in 2.9a). The chain runner forks on this BEFORE walking providers
   * — image-out is currently a stub that throws `IMAGE_OUT_NOT_AVAILABLE`.
   */
  modality?: Modality;
};

export const BADGE_CHAINS: Record<Badge, BadgeChain> = {
  flash: {
    badge: "flash",
    label: "Fast answer",
    chain: ["groq", "google", "cloudflare", "lovable"],
    paidOnly: false,
    failClosed: false,
    modality: "text-out",
  },
  pro: {
    badge: "pro",
    label: "Best for the task",
    chain: ["anthropic", "openai", "groq", "lovable"],
    paidOnly: false,
    failClosed: false,
    modality: "text-out",
  },
  genius: {
    // Renamed from "GPT-5" per gate G3 (locked 2026-05-08).
    badge: "genius",
    label: "Smartest model",
    chain: ["openai", "anthropic", "lovable"],
    paidOnly: true,
    failClosed: false,
    modality: "text-out",
  },
  private: {
    badge: "private",
    // Re-labeled in Phase 2.8 — the prior "Stays on safe rails" copy was
    // promising Cloudflare Workers AI under the word "private", which is
    // a third-party hosted inference path. The badge now routes to a real
    // on-device chain (Apple Foundation Models / Gemini Nano / WebLLM)
    // selected per-device by capability detection. See docs/11.
    label: "On your device",
    chain: ["onDeviceApple", "onDeviceAndroid", "onDeviceWebLLM"],
    paidOnly: false,
    failClosed: true,
    modality: "text-out",
  },
};

/**
 * Resolved modality for a chain, with the slice-a default applied. Callers
 * should prefer this over reading `cfg.modality` directly so the default
 * lives in one place.
 */
export function modalityFor(cfg: BadgeChain): Modality {
  return cfg.modality ?? "text-out";
}

export function chainFor(badge: Badge): BadgeChain {
  return BADGE_CHAINS[badge];
}

/** Per-day caps. See §C3. Counted in completed responses, not tokens. */
export const FREE_TIER_CAPS: Record<Badge, number> = {
  flash: 20,
  pro: 10,
  genius: 0, // disabled for free users; UI shows upsell
  private: 20,
};

export const PAID_TIER_CAPS: Record<Badge, number> = {
  flash: 200,
  pro: 100,
  genius: 50,
  private: 100,
};

export function capFor(badge: Badge, paidTier: boolean): number {
  return paidTier ? PAID_TIER_CAPS[badge] : FREE_TIER_CAPS[badge];
}

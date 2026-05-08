/**
 * Badge → provider chain resolver. See docs/05-spec-phase-2.6-chat-providers.md §C2.
 *
 * The four UI badges are intent profiles. Users pick intent; we pick provider.
 * Each chain has a primary + fallbacks. The PRIVATE chain has length 1
 * (fail-closed, no silent fallback to a non-private provider — see §C4).
 */
import type { ProviderId } from "@/lib/provider-tiers";

export type Badge = "flash" | "pro" | "genius" | "private";

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
};

export const BADGE_CHAINS: Record<Badge, BadgeChain> = {
  flash: {
    badge: "flash",
    label: "Fast answer",
    chain: ["groq", "google", "cloudflare", "lovable"],
    paidOnly: false,
    failClosed: false,
  },
  pro: {
    badge: "pro",
    label: "Best for the task",
    chain: ["anthropic", "openai", "groq", "lovable"],
    paidOnly: false,
    failClosed: false,
  },
  genius: {
    // Renamed from "GPT-5" per gate G3 (locked 2026-05-08).
    badge: "genius",
    label: "Smartest model",
    chain: ["openai", "anthropic", "lovable"],
    paidOnly: true,
    failClosed: false,
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
  },
};

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

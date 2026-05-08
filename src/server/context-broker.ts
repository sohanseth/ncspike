/**
 * Context Broker — per-request middleware that personalizes chat responses
 * without leaking PII to third-party providers.
 *
 * Spec: docs/06-spec-phase-2.7-context-broker.md §B3, §B4, §B5.
 *
 * Called from the chat pipeline at canonical step 5 — AFTER chain resolution
 * (so we know the strictest tier in the chain), BEFORE the LLM call (so we
 * can inject the assembled fragment as a system-prompt prefix).
 *
 * Day 1: scaffold + types + signature. Days 2-4 fill in:
 *   Day 2: trait sheet read path
 *   Day 3: cosine ranking + tier-aware filtering
 *   Day 4: fragment assembly (§13 JSON-only) + scrub integration + chat wiring
 */
import type { Badge } from "./inference/router";
import type { PrivacyTier } from "./inference/tiers";
import type { TraitCategory } from "./trait-schema";

export type AssembleArgs = {
  userId: string;
  /** The user's latest message — embedded for cosine selection against the
   *  sheet's per-category embeddings. */
  query: string;
  badge: Badge;
  /** Strictest (max) tier across the chosen badge's full provider chain.
   *  Per spec §B4 worst-tier-across-chain rule: assembling for the strictest
   *  tier means the fragment is safe at every depth in the chain, including
   *  fallbacks. Computed by the caller via `strictestTierInChain(chain)`. */
  strictestTierInChain: PrivacyTier;
};

/**
 * Structured trait identification for the ContextFooter UI (Day 5) and the
 * `chat_messages.context_used` audit column.
 *
 * `categories` is the coarse list (matches `chat_context_log.categories_used`).
 * `traitPaths` is the leaf-key list — e.g. `["physical.hair", "physical.scalp",
 * "preferences.tone"]` for the footer's "Used: physical (hair, scalp)" copy
 * and the "Forget this trait" deep-link target.
 *
 * Storing both shapes avoids a Day-5 contract break that would force the
 * broker to re-emit category-only data for chat_context_log and path-level
 * data for chat_messages.context_used; it's cheap to emit at assembly time.
 */
export type ContextUsed = {
  categories: TraitCategory[];
  trait_paths: string[];
};

export type AssembleResult = {
  /** The system-prompt fragment to PREFIX to the model's system prompt.
   *  Empty string when no context was injected (no sheet, no relevant
   *  categories above threshold, or scrub blocked). */
  fragment: string;
  /** Categories + leaf trait paths that survived selection + tier filter +
   *  per-category blocks and made it into the fragment.
   *  - `contextUsed.categories` → chat_context_log.categories_used (audit row)
   *  - `contextUsed` (full object) → chat_messages.context_used jsonb (UI) */
  contextUsed: ContextUsed;
  /** True if the scrub rejected the assembled fragment. When true, fragment
   *  is empty and a pii_scrub_events row has already been written. */
  scrubBlocked: boolean;
  /** trait_sheet_version this decision was made against; null if no sheet. */
  traitSheetVersion: number | null;
};

/**
 * Day 1 stub: returns no-context. Wires the type contract so D7's
 * `runChain`/`runChainStream` can already import + call it once Day 4 lands.
 */
export async function assembleSystemPrompt(_args: AssembleArgs): Promise<AssembleResult> {
  return {
    fragment: "",
    contextUsed: { categories: [], trait_paths: [] },
    scrubBlocked: false,
    traitSheetVersion: null,
  };
}

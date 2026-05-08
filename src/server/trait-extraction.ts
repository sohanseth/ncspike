/**
 * Nightly trait sheet extractor. Spec: docs/06-spec-phase-2.7-context-broker.md §B2.
 *
 * Distils the user's raw memory (searches, voice notes, manual memories,
 * calendar titles, email subjects) into the canonical trait sheet via
 * Cloudflare Workers AI Llama 3.1 8B (T0 — never leaves the platform).
 *
 * Runs from research-cron at the user's local 03:00 (Day 2 wires the schedule).
 * Cold-start trigger: first chat after sign-up if no sheet exists.
 *
 * Day 1: scaffold + signature. Day 2 fills in the load → bucket → prompt →
 *   validate → merge → embed → upsert pipeline.
 */

export type ExtractionResult = {
  /** True if a new sheet was written. False on no-op (no new memory) or
   *  validator rejection (rolled back per §13 rule 5). */
  written: boolean;
  /** Reason for no-op, when written=false. */
  reason?:
    | "no_new_memory"
    | "zod_reject"
    | "llm_no_response"
    | "embedding_failed"
    | "blocked_by_user_setting";
  /** Version that was written (or, on rollback, the version that was kept). */
  version: number;
};

/**
 * Day 1 stub. Day 2 implementation:
 *   1. load last 30 days of memory (searches, voice_notes, manual_memories,
 *      calendar_events titles, email_metadata subjects+sender domains)
 *   2. load existing user_traits row + version (if any)
 *   3. bucket inputs by candidate category (heuristic pre-filter, no LLM yet)
 *   4. for each non-empty bucket: prompt Llama 3.1 8B for a category JSON patch
 *   5. Zod-validate each patch; reject with extraction_failures log on failure
 *   6. merge patches + apply 90-day decay against source_memory_ids
 *   7. compute bge-small-en embedding per top-level category present
 *   8. upsert user_traits with conflict on (user_id) → bump version
 */
export async function runTraitExtractionForUserId(_userId: string): Promise<ExtractionResult> {
  return { written: false, reason: "no_new_memory", version: 0 };
}

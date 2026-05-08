/**
 * THE leak suite — 200 queries × 4 badges × 4 tiers = 3200 broker
 * invocations against the synthetic Aarav Mehta sheet. ZERO PII overlap is
 * required between any assembled fragment and the synthetic PII set.
 *
 * Spec: docs/06 §9.
 *
 * The broker normally reads from Supabase + calls Cloudflare embeddings.
 * Both are stubbed here with vi.mock so the test runs deterministically and
 * offline. The stub returns Aarav's hand-crafted sheet for the user_traits
 * table, the empty list for the two block tables and known-names, and a
 * deterministic embedding for embedTexts.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import {
  AARAV_TRAIT_SHEET,
  AARAV_KNOWN_NAMES,
  AARAV_PII_LITERALS,
  findPiiLeak,
} from "./fixtures/aarav-mehta";
import { QUERY_CORPUS } from "./fixtures/query-corpus";
import type { TraitCategory } from "@/server/trait-schema";

/**
 * Mirrors the broker's NEVER_AT_TIER policy (src/server/context-broker.ts).
 * If the broker drift, this test catches it: any tier-forbidden category that
 * appears in the assembled fragment is a policy bug, not just a leak risk.
 */
const TIER_FORBIDDEN: Record<0 | 1 | 2 | 3, readonly TraitCategory[]> = {
  0: [],
  1: ["household", "transient"],
  2: ["household", "transient"],
  3: ["household", "wellness", "transient"],
};

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// Mock supabaseAdmin to return the Aarav sheet for user_traits and empty rows
// for everything else. The chained `.from(...).select(...).eq(...)` API is
// thin enough to stub by hand — easier than wiring a fake @supabase/supabase-js.
//
// Mock embedTexts to return a deterministic 384-dim vector that is identical
// to one of Aarav's category embeddings (so cosine = 1.0 → top-K always wins).

vi.mock("@/integrations/supabase/client.server", () => {
  function buildResult(table: string) {
    if (table === "user_traits") {
      // maybeSingle()-shaped result
      return { data: { version: 1, sheet: AARAV_TRAIT_SHEET }, error: null };
    }
    if (table === "user_known_names") {
      return { data: AARAV_KNOWN_NAMES.map((name) => ({ name })), error: null };
    }
    // user_trait_blocks, user_provider_category_blocks, pii_scrub_events insert,
    // chat_context_log insert, etc. — empty / null is fine.
    return { data: [], error: null };
  }

  function makeQuery(table: string) {
    const result = buildResult(table);
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      gt: () => chain,
      maybeSingle: async () => result,
      then: (resolve: (v: typeof result) => unknown) => Promise.resolve(resolve(result)),
      // For inserts: just resolve to {data:null,error:null}
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }),
    };
    return chain;
  }

  const supabaseAdmin = new Proxy({} as any, {
    get(_, prop) {
      if (prop === "from") return (table: string) => makeQuery(table);
      return undefined;
    },
  });
  return { supabaseAdmin };
});

vi.mock("@/server/inference/cloudflare", () => {
  // Return Aarav's `physical` category embedding — guarantees cosine ≥ floor
  // for at least one category so the broker always assembles a non-empty
  // fragment. That's actually what we want: we WANT context injection so we
  // can verify it's leak-free, not absence of injection trivially.
  return {
    embedTexts: async (texts: string[]) =>
      texts.map(() => AARAV_TRAIT_SHEET.category_embeddings.physical),
  };
});

// ─── Suite ──────────────────────────────────────────────────────────────────

import type { Badge } from "@/server/inference/router";
import type { PrivacyTier } from "@/server/inference/tiers";

const BADGES: readonly Badge[] = ["flash", "pro", "genius", "private"];
const TIERS: readonly PrivacyTier[] = [0, 1, 2, 3];

describe("Broker leak suite — 200 queries × 4 badges × 4 tiers", () => {
  // Lazy-import after mocks are in place.
  let assembleSystemPrompt: typeof import("@/server/context-broker").assembleSystemPrompt;

  beforeAll(async () => {
    ({ assembleSystemPrompt } = await import("@/server/context-broker"));
  });

  it("zero PII overlap across all 3200 invocations", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    let invocations = 0;
    let leakCount = 0;
    const leaks: string[] = [];

    // For each (badge, tier, query) — call the broker, scan the result.
    // Cap details captured to 25 to keep test failure messages bounded.
    for (const badge of BADGES) {
      for (const tier of TIERS) {
        for (const query of QUERY_CORPUS) {
          invocations++;
          const result = await assembleSystemPrompt({
            userId,
            query,
            badge,
            strictestTierInChain: tier,
          });
          const leak = findPiiLeak(result.fragment);
          if (leak) {
            leakCount++;
            if (leaks.length < 25) {
              leaks.push(
                `[${badge}/T${tier}] q="${query.slice(0, 40)}" → leaked "${leak}"`,
              );
            }
          }
        }
      }
    }

    expect(invocations).toBe(BADGES.length * TIERS.length * QUERY_CORPUS.length); // 3200
    expect(leakCount, leaks.join("\n")).toBe(0);
  });

  it("tier policy: forbidden categories never appear in fragment OR contextUsed", async () => {
    // Smaller sweep — 12 personalization-rich queries × 4 tiers × 4 badges.
    // The mocks force user_trait_blocks and user_provider_category_blocks
    // empty, so any forbidden-category presence here is a tier-policy bug.
    const userId = "00000000-0000-0000-0000-000000000002";
    const personalQueries = QUERY_CORPUS.slice(0, 12);
    const violations: string[] = [];

    for (const badge of BADGES) {
      for (const tier of TIERS) {
        const forbidden = TIER_FORBIDDEN[tier];
        if (forbidden.length === 0) continue;
        for (const query of personalQueries) {
          const result = await assembleSystemPrompt({
            userId,
            query,
            badge,
            strictestTierInChain: tier,
          });
          for (const cat of forbidden) {
            const inUsed = result.contextUsed.categories.includes(cat);
            const inFragment = result.fragment.includes(`"${cat}"`);
            if (inUsed || inFragment) {
              violations.push(
                `[${badge}/T${tier}] q="${query.slice(0, 30)}" leaked forbidden category "${cat}" (inUsed=${inUsed}, inFragment=${inFragment})`,
              );
            }
          }
        }
      }
    }
    expect(violations, violations.slice(0, 10).join("\n")).toEqual([]);
  });

  it("PII literal scanner catches obvious leaks (sanity check)", () => {
    expect(findPiiLeak("My friend Aarav called.")).toBe("Aarav");
    // Note: findPiiLeak returns the first-found literal. "Aarav" appears
    // before the email literal in the list, so it wins on substring scan.
    expect(findPiiLeak("Email me at aarav@stripe.com please.")).not.toBeNull();
    expect(findPiiLeak("Contact: support@stripe.com")).toBe("Stripe");
    expect(findPiiLeak("This fragment is clean.")).toBe(null);
    expect(findPiiLeak("")).toBe(null);
    expect(AARAV_PII_LITERALS.length).toBeGreaterThan(0);
  });
});

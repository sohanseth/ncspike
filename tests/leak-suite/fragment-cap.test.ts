/**
 * Phase 2.7-bis hardening — broker fragment-length cap.
 *
 * Architects flagged: "no fragment length cap enforcement, and tests don't
 * assert it" (FAIL on Phase 2.7 review). This test pins the invariant: a
 * synthetic trait sheet whose JSON exceeds MAX_FRAGMENT_CHARS must cause
 * `assembleSystemPrompt` to return `scrubBlocked: true` with an empty
 * fragment, NOT a silently truncated or oversized fragment.
 *
 * The companion fail-closed wiring lives in:
 *   - src/lib/chat.functions.ts  (sendChatMessage + prepareOnDeviceTurn)
 *   - src/routes/api.chat.stream.ts
 *   - src/lib/on-device-chat.ts (typed validation event)
 *
 * Strategy:
 *   - Build a TraitSheet that PASSES Zod validation (max 12 strings × 80
 *     chars per safeStringArray, max 20 household members, .strict() obeyed)
 *     but which, when ALL categories are filled to their cap, produces a
 *     JSON-stringified fragment > 6000 chars.
 *   - At tier=-1 the broker has no maxK limit and the mocked all-1
 *     embeddings make every category pass cosine, so all categories get
 *     selected → fragment definitely overflows.
 */
import { describe, it, expect, vi } from "vitest";

// Spy on logScrubEvent so we can assert the audit row identity for the
// fragment-oversize branch. Preserve the rest of the module (notably `scrub`
// and `loadKnownNames`) so the broker's step-8 PII pass still runs normally.
const logScrubEventSpy = vi.fn(async () => {});
vi.mock("@/server/pii-scrub", async () => {
  const actual = await vi.importActual<typeof import("@/server/pii-scrub")>(
    "@/server/pii-scrub",
  );
  return {
    ...actual,
    logScrubEvent: logScrubEventSpy,
  };
});

// 80-char string (the safeString cap). Letters only so it can't trip any PII
// regex or injection sentinel.
const STR80 = "x".repeat(80);
const ARR12 = Array.from({ length: 12 }, (_, i) =>
  `${i.toString().padStart(2, "0")}${"x".repeat(78)}`,
);

// Maxed PreferencesSchema (5 fields × 12 × 80 ≈ 4.8 KB raw).
const MAXED_PREFERENCES = {
  shopping: ARR12,
  tone: "concise" as const,
  diet: ARR12,
  brands_liked: ARR12,
  brands_avoided: ARR12,
};

// Maxed household (20 members × 2 safeStringArrays each).
const MAXED_HOUSEHOLD = Array.from({ length: 20 }, (_, i) => ({
  ref: `child_${i + 1}`,
  relation: "child" as const,
  age_band: "6-9" as const,
  interests: ARR12,
  preferences: ARR12,
}));

// Maxed physical (open shape — keep small, just need the category present).
const MAXED_PHYSICAL = {
  hair: STR80,
  scalp: STR80,
  skin: STR80,
  build: STR80,
  mobility: STR80,
};

// Embeddings: 384-dim, all 1s — mocked embedTexts also returns all-1s, so
// cosine = 1.0 for every category and the broker selects them all.
const ONES_384 = Array.from({ length: 384 }, () => 1);

const OVERSIZED_SHEET = {
  schema_version: 1 as const,
  derived_at: "2026-05-09T00:00:00.000Z",
  source_memory_ids: [],
  categories: {
    physical: MAXED_PHYSICAL,
    household: MAXED_HOUSEHOLD,
    preferences: MAXED_PREFERENCES,
  },
  category_embeddings: {
    physical: ONES_384,
    household: ONES_384,
    preferences: ONES_384,
  },
};

vi.mock("@/integrations/supabase/client.server", () => {
  function buildResult(table: string) {
    if (table === "user_traits") {
      return { data: { version: 1, sheet: OVERSIZED_SHEET }, error: null };
    }
    if (table === "user_known_names") return { data: [], error: null };
    return { data: [], error: null };
  }
  function makeQuery(table: string) {
    const chain: any = {
      maybeSingle: async () => buildResult(table),
      then: (res: any) => Promise.resolve(buildResult(table)).then(res),
      insert: async () => ({ data: null, error: null }),
    };
    for (const m of ["select", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "order", "limit", "filter"]) {
      chain[m] = () => chain;
    }
    return chain;
  }
  return {
    supabaseAdmin: { from: (table: string) => makeQuery(table) },
  };
});

vi.mock("@/server/inference/cloudflare", () => ({
  embedTexts: async (texts: string[]) => texts.map(() => ONES_384),
}));

describe("Broker — fragment length cap", () => {
  it("MAX_FRAGMENT_CHARS is exported and reasonable", async () => {
    const mod = await import("@/server/context-broker");
    expect(typeof mod.MAX_FRAGMENT_CHARS).toBe("number");
    expect(mod.MAX_FRAGMENT_CHARS).toBeGreaterThan(1000);
    expect(mod.MAX_FRAGMENT_CHARS).toBeLessThan(50_000);
  });

  it("oversized (but schema-valid) trait sheet → scrubBlocked=true, empty fragment", async () => {
    logScrubEventSpy.mockClear();
    const { assembleSystemPrompt } = await import("@/server/context-broker");
    const result = await assembleSystemPrompt({
      userId: "00000000-0000-0000-0000-000000000001",
      query: "what should I cook tonight?",
      // tier -1 → no maxK cap → broker selects all categories → fragment
      // overflows the MAX_FRAGMENT_CHARS guard.
      badge: "private",
      strictestTierInChain: -1,
    });
    expect(result.scrubBlocked).toBe(true);
    expect(result.fragment).toBe("");
    expect(result.contextUsed.categories).toHaveLength(0);

    // Pin the audit-row identity: the fragment-oversize branch — and ONLY
    // that branch — must have fired. A future refactor that returns
    // scrubBlocked from a different code path (e.g. the step-8 PII scrub,
    // or a silent early-return) would either drop this call or log a
    // different patternClass, and this assertion would catch it.
    expect(logScrubEventSpy).toHaveBeenCalledTimes(1);
    expect(logScrubEventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "00000000-0000-0000-0000-000000000001",
        patternClass: "fragment_oversize",
        badge: "private",
        providerTier: -1,
      }),
    );
  });
});

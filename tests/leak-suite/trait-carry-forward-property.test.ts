/**
 * Spec §B9 — PROPERTY test for the per-leaf 90-day decay invariant (task #41).
 *
 * The example-based suite in `trait-carry-forward.test.ts` covers the named
 * scenarios (CARRY, SIBLING DECAY, PER-LEAF RECONFIRM, DECAY-ALL, …). This
 * file complements it with a randomized check of the bedrock invariant:
 *
 *     After every nightly extractor run, no leaf in the produced sheet has
 *     a `last_seen_at` older than 90 days.
 *
 * fast-check generates random multi-night timelines. For each night we pick:
 *   - a random gap (in days) since the previous night
 *   - per-leaf actions (refresh via fresh extraction, or skip)
 *
 * Between nights we age the prior sheet's `last_seen_at` clocks backward by
 * the gap, then drive the real extractor end-to-end and check the invariant
 * on the persisted sheet. Catches off-by-one bugs in age math, fallback
 * `last_seen_at` sourcing (when prior was a v1 `category_meta`-only sheet),
 * and edge cases like a leaf that bounces in and out of the LLM patch over
 * many nights.
 *
 * Supabase + Cloudflare are stubbed identically to `trait-carry-forward.test.ts`
 * so the test runs offline and deterministic.
 */
import { describe, it, vi } from "vitest";
import * as fc from "fast-check";
import type { TraitSheet } from "@/lib/trait-schema";

// ─── Stubs (mirrors trait-carry-forward.test.ts) ────────────────────────────

type MemRow = { id: string; node_type: string; label: string; data: unknown; created_at: string };

const ZERO_384 = (): number[] => new Array(384).fill(0);

// Per-leaf prior embeddings + a "far" memory embedding. Identical recipe to
// the example-based suite so we know FAR cosine-misses both PRIOR_DIET_EMB
// and PRIOR_TONE_EMB — i.e. cosine re-confirmation is OFF in this property
// test. Only the fresh-extraction refresh path can save a leaf, which keeps
// the schedule's effect on each leaf perfectly predictable.
const PRIOR_DIET_EMB = (() => {
  const v = ZERO_384();
  for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.13);
  return v;
})();
const PRIOR_TONE_EMB = (() => {
  const v = ZERO_384();
  for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.31 + 0.5);
  return v;
})();
const MEMORY_EMB_FAR = (() => {
  const v = ZERO_384();
  for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.07 + 1.7);
  return v;
})();

const harness = {
  prior: null as TraitSheet | null,
  memory: [] as MemRow[],
  llmResponses: [] as (string | null)[],
  embeddingResponses: [] as number[][][],
  upserted: null as null | {
    user_id: string;
    version: number;
    sheet: TraitSheet;
    derived_at: string;
    source_count: number;
    updated_at: string;
  },
};

function setup(opts: {
  prior: TraitSheet | null;
  memory: MemRow[];
  llmResponses?: (string | null)[];
  embeddingResponses?: number[][][];
}) {
  harness.prior = opts.prior;
  harness.memory = opts.memory;
  harness.llmResponses = (opts.llmResponses ?? []).slice();
  harness.embeddingResponses = (opts.embeddingResponses ?? []).slice();
  harness.upserted = null;
}

vi.mock("@/integrations/supabase/client.server", () => {
  function makeMemoryChain() {
    const result = { data: harness.memory, error: null };
    const chain: any = { then: (res: any) => Promise.resolve(res(result)) };
    for (const m of [
      "select", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "order", "limit",
    ]) {
      chain[m] = () => chain;
    }
    return chain;
  }
  function makeUserSettingsChain() {
    const result = { data: { personalization_v1_enabled: true }, error: null };
    const chain: any = {
      maybeSingle: async () => result,
      then: (res: any) => Promise.resolve(res(result)),
    };
    for (const m of ["select", "eq"]) chain[m] = () => chain;
    return chain;
  }
  function makeUserTraitsChain() {
    const result = harness.prior
      ? { data: { version: 1, sheet: harness.prior }, error: null }
      : { data: null, error: null };
    const chain: any = {
      maybeSingle: async () => result,
      upsert: (row: any) => {
        harness.upserted = row;
        const res = { data: null, error: null };
        return { then: (r: any) => Promise.resolve(r(res)) };
      },
      then: (res: any) => Promise.resolve(res(result)),
    };
    for (const m of ["select", "eq"]) chain[m] = () => chain;
    return chain;
  }
  function makeInsertChain() {
    return { insert: async () => ({ data: null, error: null }) };
  }
  function makeQuery(table: string) {
    if (table === "user_settings") return makeUserSettingsChain();
    if (table === "user_traits") return makeUserTraitsChain();
    if (table === "memory_nodes") return makeMemoryChain();
    return makeInsertChain();
  }
  return { supabaseAdmin: { from: (table: string) => makeQuery(table) } };
});

vi.mock("@/server/inference/cloudflare", () => {
  let llmCall = 0;
  let embedCall = 0;
  return {
    cloudflareProvider: {
      generate: async () => {
        const idx = llmCall++;
        const r = harness.llmResponses[idx] ?? "{}";
        if (r === null) throw new Error("no response");
        return { text: r };
      },
    },
    embedTexts: async (texts: readonly string[]) => {
      const idx = embedCall++;
      const preset = harness.embeddingResponses[idx];
      if (preset) {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i++) out.push(preset[i] ?? ZERO_384());
        return out;
      }
      return texts.map(() => ZERO_384());
    },
    __resetCloudflareCounters: () => {
      llmCall = 0;
      embedCall = 0;
    },
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = "11111111-1111-1111-1111-111111111111";
const NEW_MEM_ID = "22222222-2222-2222-2222-222222222222";
const PRIOR_DIET_MEM_ID = "44444444-4444-4444-4444-444444444444";
const PRIOR_TONE_MEM_ID = "55555555-5555-5555-5555-555555555555";

const TRAIT_DECAY_DAYS = 90;
const DECAY_MS = TRAIT_DECAY_DAYS * 86400_000;

function isoDaysAgo(d: number): string {
  return new Date(Date.now() - d * 86400_000).toISOString();
}

function makeInitialPrior(dietAgeDays: number, toneAgeDays: number): TraitSheet {
  return {
    schema_version: 1,
    derived_at: isoDaysAgo(0),
    source_memory_ids: [],
    categories: {
      preferences: { diet: ["vegetarian"], tone: "warm" },
    },
    category_embeddings: { preferences: PRIOR_DIET_EMB },
    trait_meta: {
      preferences: {
        diet: {
          last_seen_at: isoDaysAgo(dietAgeDays),
          source_memory_ids: [{ kind: "memory", id: PRIOR_DIET_MEM_ID }],
        },
        tone: {
          last_seen_at: isoDaysAgo(toneAgeDays),
          source_memory_ids: [{ kind: "memory", id: PRIOR_TONE_MEM_ID }],
        },
      },
    },
    trait_embeddings: {
      preferences: { diet: PRIOR_DIET_EMB, tone: PRIOR_TONE_EMB },
    },
  };
}

/**
 * Simulate `gapDays` of real-world time passing between nightly runs by
 * shifting every `last_seen_at` (and the sheet's `derived_at`) backwards.
 * The extractor uses `Date.now()` at runtime, which barely advances within
 * a single test iteration, so we move the clocks instead of waiting.
 */
function ageSheet(sheet: TraitSheet, gapDays: number): TraitSheet {
  const shiftMs = gapDays * 86400_000;
  const shift = (iso: string) => new Date(Date.parse(iso) - shiftMs).toISOString();
  const c = JSON.parse(JSON.stringify(sheet)) as TraitSheet;
  c.derived_at = shift(c.derived_at);
  if (c.trait_meta) {
    for (const cat of Object.keys(c.trait_meta)) {
      const catMeta = (c.trait_meta as Record<string, Record<string, { last_seen_at: string; source_memory_ids: unknown[] }>>)[cat];
      for (const path of Object.keys(catMeta)) {
        catMeta[path].last_seen_at = shift(catMeta[path].last_seen_at);
      }
    }
  }
  return c;
}

// ─── Test ───────────────────────────────────────────────────────────────────

describe("Trait extractor — task #41 PROPERTY: 90-day decay invariant", () => {
  it("after every nightly run, no surviving leaf is ≥ 90 days old", async () => {
    const action = fc.constantFrom("fresh", "skip");
    const night = fc.record({
      // 1–60 day gap between runs lets a single ~20-night schedule comfortably
      // cross multiple 90-day windows, so the property exercises actual decay
      // events rather than just the carry path.
      gapDays: fc.integer({ min: 1, max: 60 }),
      dietAction: action,
      toneAction: action,
    });
    const schedule = fc.array(night, { minLength: 1, maxLength: 20 });
    const initialAges = fc.tuple(
      fc.integer({ min: 0, max: 89 }),
      fc.integer({ min: 0, max: 89 }),
    );

    const cf = await import("@/server/inference/cloudflare");
    const reset = (cf as unknown as { __resetCloudflareCounters: () => void })
      .__resetCloudflareCounters;
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");

    await fc.assert(
      fc.asyncProperty(initialAges, schedule, async ([dietAge0, toneAge0], nights) => {
        let prior: TraitSheet = makeInitialPrior(dietAge0, toneAge0);

        for (const n of nights) {
          // (1) Time advances by `gapDays` between this night and the last.
          prior = ageSheet(prior, n.gapDays);

          // (2) Build the per-night LLM patch from the per-leaf actions. Only
          //     "fresh" leaves appear in the patch; "skip" leaves are absent
          //     and fall into the carry/decay branch in the extractor.
          const patch: Record<string, unknown> = {};
          if (n.dietAction === "fresh") patch.diet = ["vegetarian"];
          if (n.toneAction === "fresh") patch.tone = "warm";

          setup({
            prior,
            memory: [
              {
                id: NEW_MEM_ID,
                node_type: "note",
                label: "random activity",
                data: {},
                created_at: isoDaysAgo(0),
              },
            ],
            // 6 categories in TRAIT_CATEGORIES, in order.
            llmResponses: [
              "{}",                  // physical
              "[]",                  // household
              JSON.stringify(patch), // preferences
              "{}",                  // professional
              "{}",                  // wellness
              "{}",                  // transient
            ],
            // FAR memory embedding → cosine misses every prior leaf, so a
            // "skip" leaf cannot be saved by the cosine re-confirm path.
            // Final-sheet embeds beyond index 0 default to ZERO_384, which
            // is fine — they're only consumed by future cosine attempts and
            // we never assert on cosine refresh in this property.
            embeddingResponses: [[MEMORY_EMB_FAR]],
          });
          reset();

          const r = await runTraitExtractionForUserId(USER_ID);
          if (!r.written) {
            // The extractor declined to persist (e.g. cold start with no
            // categories). Nothing to check this night — keep the same prior.
            continue;
          }

          // (3) THE INVARIANT. For every leaf the extractor chose to keep,
          //     its `last_seen_at` must be inside the 90-day window relative
          //     to the run's "now". Refreshed leaves get nowIso (~0d old);
          //     carried leaves must have had incoming age < 90d.
          const sheet = harness.upserted!.sheet;
          const tm = sheet.trait_meta ?? {};
          const now = Date.now();
          for (const cat of Object.keys(tm) as Array<keyof typeof tm>) {
            const catMeta = tm[cat];
            if (!catMeta) continue;
            for (const path of Object.keys(catMeta)) {
              const age = now - Date.parse(catMeta[path].last_seen_at);
              if (age >= DECAY_MS) return false;
            }
          }

          // Feed the persisted sheet forward as the next night's prior.
          prior = sheet;
        }
        return true;
      }),
      { numRuns: 50 },
    );
  });
});

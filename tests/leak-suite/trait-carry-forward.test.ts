/**
 * Spec §B9 — cross-night trait carry-forward + 90-day decay.
 *
 * History:
 * - Task #24 introduced carry-forward / decay at the CATEGORY level. That
 *   meant any re-confirmation refreshed every leaf in the category — so
 *   re-confirming `preferences.diet` would also reset the clock for siblings
 *   (`tone`, `brands_avoided`, …) and could keep them alive past 90 days.
 * - Task #28 moves the decay clock down to each individual leaf (per spec
 *   §B9 wording: "a trait whose source memories haven't been touched in 90
 *   days drops out"). The two new behaviours under test:
 *
 *     (a) PER-LEAF decay: in the same category, one leaf can be refreshed
 *         while a sibling expires. Re-confirming `diet` does NOT bump
 *         `tone`'s clock.
 *     (b) PER-LEAF re-confirmation: cosine match against the prior PER-LEAF
 *         embedding refreshes only that leaf, not the whole category.
 *
 * The old behaviours (CARRY, FRESH-EXTENDS, SILENT-NIGHT-DECAY, COLD-START)
 * are still exercised, just now expressed against `trait_meta` instead of
 * `category_meta`.
 *
 * Supabase + Cloudflare are stubbed so the test runs offline & deterministic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TraitSheet } from "@/lib/trait-schema";

// ─── Knobs the per-test setup writes to ─────────────────────────────────────

type MemRow = { id: string; node_type: string; label: string; data: unknown; created_at: string };

const ZERO_384 = (): number[] => new Array(384).fill(0);

// Three orthogonal-ish base vectors used as per-LEAF embeddings on the prior
// sheet. Memory embeddings are then chosen identical to one of them so the
// test gets a clean cosine = 1.0 hit on exactly the leaf it's targeting.
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
const PRIOR_FOCUS_EMB = (() => {
  const v = ZERO_384();
  for (let i = 0; i < 384; i++) v[i] = Math.cos(i * 0.21);
  return v;
})();
// "Far" vector — orthogonal-ish to all three priors so cosine << 0.4.
const MEMORY_EMB_FAR = (() => {
  const v = ZERO_384();
  for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.07 + 1.7);
  return v;
})();

const harness = {
  prior: null as TraitSheet | null,
  memory: [] as MemRow[],
  // For each cloudflareProvider.generate call (per category), what to return.
  // null = no response. If the queue is empty we return "{}" (empty patch).
  llmResponses: [] as (string | null)[],
  // Per-call return for embedTexts; index = call number.
  embeddingResponses: [] as number[][][],
  // Captured upsert payload.
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

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Prompt E: these jobs run only with the owner's cloud consent. This suite
// tests the job itself, so consent is on here.
vi.mock("@/server/cloud-features.server", () => ({
  isCloudFeatureOn: async () => true,
  requireCloudFeature: async () => {},
  noteCloudActivity: async () => {},
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function makeMemoryChain() {
    const result = { data: harness.memory, error: null };
    const chain: any = {
      then: (res: any) => Promise.resolve(res(result)),
    };
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
        return {
          then: (r: any) => Promise.resolve(r(res)),
        };
      },
      then: (res: any) => Promise.resolve(res(result)),
    };
    for (const m of ["select", "eq"]) chain[m] = () => chain;
    return chain;
  }

  function makeInsertChain() {
    const chain: any = {
      insert: async () => ({ data: null, error: null }),
    };
    return chain;
  }

  function makeQuery(table: string) {
    if (table === "user_settings") return makeUserSettingsChain();
    if (table === "user_traits") return makeUserTraitsChain();
    if (table === "memory_nodes") return makeMemoryChain();
    return makeInsertChain();
  }

  return {
    supabaseAdmin: { from: (table: string) => makeQuery(table) },
  };
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
        // Pad with ZERO_384 if the preset is shorter than the request, so a
        // test that only cares about the FIRST few vectors doesn't have to
        // enumerate every trait-embedding the implementation requests.
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i++) {
          out.push(preset[i] ?? ZERO_384());
        }
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

beforeEach(async () => {
  const cf = await import("@/server/inference/cloudflare");
  (cf as unknown as { __resetCloudflareCounters: () => void }).__resetCloudflareCounters();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = "11111111-1111-1111-1111-111111111111";
const MEM_ID_NEW_PREFS = "22222222-2222-2222-2222-222222222222";
const MEM_ID_NEW_FAR = "33333333-3333-3333-3333-333333333333";
const MEM_ID_PRIOR_DIET = "44444444-4444-4444-4444-444444444444";
const MEM_ID_PRIOR_TONE = "55555555-5555-5555-5555-555555555555";
const MEM_ID_PRIOR_FOCUS = "66666666-6666-6666-6666-666666666666";

/**
 * Build a prior sheet with leaves whose `last_seen_at` clocks are set
 * INDEPENDENTLY per leaf. Mirrors how the new (task #28) extractor writes
 * sheets — one entry per leaf in trait_meta, plus a per-leaf embedding in
 * trait_embeddings used for re-confirmation.
 */
function priorSheetWith(opts: {
  dietLastSeenDaysAgo: number;
  toneLastSeenDaysAgo: number;
  focusLastSeenDaysAgo: number;
}): TraitSheet {
  const now = Date.now();
  const isoDaysAgo = (n: number) => new Date(now - n * 86400_000).toISOString();
  const dietSeen = isoDaysAgo(opts.dietLastSeenDaysAgo);
  const toneSeen = isoDaysAgo(opts.toneLastSeenDaysAgo);
  const focusSeen = isoDaysAgo(opts.focusLastSeenDaysAgo);
  return {
    schema_version: 1,
    derived_at: dietSeen,
    source_memory_ids: [],
    categories: {
      preferences: {
        diet: ["vegetarian"],
        tone: "warm",
      },
      transient: {
        current_focus: "preparing for spring marathon",
      },
    },
    // Category embeddings are still required by the schema (broker uses
    // them at request time). They don't gate carry-forward in the new
    // per-trait model.
    category_embeddings: {
      preferences: PRIOR_DIET_EMB,
      transient: PRIOR_FOCUS_EMB,
    },
    trait_meta: {
      preferences: {
        diet: {
          last_seen_at: dietSeen,
          source_memory_ids: [{ kind: "memory", id: MEM_ID_PRIOR_DIET }],
        },
        tone: {
          last_seen_at: toneSeen,
          source_memory_ids: [{ kind: "memory", id: MEM_ID_PRIOR_TONE }],
        },
      },
      transient: {
        current_focus: {
          last_seen_at: focusSeen,
          source_memory_ids: [{ kind: "memory", id: MEM_ID_PRIOR_FOCUS }],
        },
      },
    },
    trait_embeddings: {
      preferences: {
        diet: PRIOR_DIET_EMB,
        tone: PRIOR_TONE_EMB,
      },
      transient: {
        current_focus: PRIOR_FOCUS_EMB,
      },
    },
  };
}

// 6 categories in TRAIT_CATEGORIES, so 6 LLM calls per run.
const ALL_EMPTY_LLM: (string | null)[] = ["{}", "[]", "{}", "{}", "{}", "{}"];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Trait extractor — spec §B9 PER-TRAIT carry-forward & decay (task #28)", () => {
  it("CARRY: every leaf inside its 90-day window survives a night with no re-confirming memory", async () => {
    setup({
      prior: priorSheetWith({
        dietLastSeenDaysAgo: 60,
        toneLastSeenDaysAgo: 60,
        focusLastSeenDaysAgo: 60,
      }),
      memory: [
        {
          id: MEM_ID_NEW_FAR,
          node_type: "search",
          label: "best graphics cards 2026",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      llmResponses: ALL_EMPTY_LLM,
      // Memory-embed call returns a FAR vector; cosine << 0.4 against every
      // prior leaf embedding → nothing re-confirmed.
      embeddingResponses: [[MEMORY_EMB_FAR]],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm",
    });
    expect(sheet.categories.transient).toEqual({
      current_focus: "preparing for spring marathon",
    });
    // last_seen_at preserved per leaf (no refresh because nothing matched).
    const tm = sheet.trait_meta!;
    expect(tm.preferences.diet.last_seen_at).toBe(
      harness.prior!.trait_meta!.preferences.diet.last_seen_at,
    );
    expect(tm.preferences.tone.last_seen_at).toBe(
      harness.prior!.trait_meta!.preferences.tone.last_seen_at,
    );
    // source_memory_ids untouched on plain carry.
    expect(tm.preferences.diet.source_memory_ids).toEqual([
      { kind: "memory", id: MEM_ID_PRIOR_DIET },
    ]);
  });

  it("SIBLING DECAY: re-confirming `preferences.diet` does NOT save expired sibling `preferences.tone`", async () => {
    // The headline scenario for task #28. Prior:
    //   - preferences.diet  → last seen 80d ago (inside window)
    //   - preferences.tone  → last seen 200d ago (already expired)
    // The user mentions diet again. Under the OLD per-category model, the
    // category-wide `last_seen_at` would refresh and `tone` would be kept
    // alive forever. Under the new per-leaf model, only `diet` refreshes;
    // `tone` decays out.
    setup({
      prior: priorSheetWith({
        dietLastSeenDaysAgo: 80,
        toneLastSeenDaysAgo: 200,
        focusLastSeenDaysAgo: 999,
      }),
      memory: [
        {
          id: MEM_ID_NEW_PREFS,
          node_type: "note",
          label: "tried a new vegetarian recipe with chickpeas",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      // LLM extracts preferences with ONLY diet (no tone) — i.e. the user
      // didn't restate their tone preference, only diet.
      llmResponses: [
        "{}", // physical
        "[]", // household
        '{"diet":["vegetarian"]}', // preferences
        "{}", // professional
        "{}", // wellness
        "{}", // transient
      ],
      // Embedding-call sequence for the new per-trait pipeline:
      //   call 0: memory embeddings for re-confirm (1 memory)
      //   call 1: final-sheet embeddings (cat: preferences + trait: diet)
      embeddingResponses: [
        [MEMORY_EMB_FAR], // memory does NOT cosine-match tone OR focus
        [PRIOR_DIET_EMB, PRIOR_DIET_EMB], // category + per-trait
      ],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    // Diet refreshed (kept). Tone decayed (gone). The whole `tone` LEAF must
    // be missing from the merged content — proving sibling clocks are
    // independent within the same category.
    expect(sheet.categories.preferences).toEqual({ diet: ["vegetarian"] });
    expect(sheet.trait_meta!.preferences.tone).toBeUndefined();
    // Diet's source_memory_ids EXTENDED with the new memory (spec §B9
    // "re-confirmed extends, not re-creates").
    const dietIds = sheet.trait_meta!.preferences.diet.source_memory_ids.map((s) => s.id);
    expect(dietIds).toContain(MEM_ID_PRIOR_DIET);
    expect(dietIds).toContain(MEM_ID_NEW_PREFS);
    // transient leaf was 999d old and not re-confirmed → whole category
    // disappears (every leaf decayed).
    expect(sheet.categories.transient).toBeUndefined();
    expect(sheet.trait_meta!.transient).toBeUndefined();
  });

  it("PER-LEAF RECONFIRM: cosine match against ONE leaf's embedding refreshes only that leaf", async () => {
    // Sibling proof at the cosine layer. New memory matches the prior
    // `diet` embedding (cosine = 1.0) but NOT the `tone` embedding
    // (orthogonal-ish). With per-LEAF embeddings, only diet refreshes.
    // Both leaves were 200d old (would expire on plain age), so without
    // re-confirmation tone drops out — proving the sibling clock is
    // truly independent.
    setup({
      prior: priorSheetWith({
        dietLastSeenDaysAgo: 200,
        toneLastSeenDaysAgo: 200,
        focusLastSeenDaysAgo: 999,
      }),
      memory: [
        {
          id: MEM_ID_NEW_PREFS,
          node_type: "note",
          label: "tried a new vegetarian recipe",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      llmResponses: ALL_EMPTY_LLM,
      embeddingResponses: [
        [PRIOR_DIET_EMB], // memory cosine=1.0 vs DIET, far from TONE/FOCUS
        // No final-sheet embeddings needed: the only surviving leaf (diet)
        // is carried forward unchanged → its category & trait embedding are
        // both reused from prior. No second embedTexts call is made.
      ],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories.preferences).toEqual({ diet: ["vegetarian"] });
    expect(sheet.trait_meta!.preferences.diet.last_seen_at).not.toBe(
      harness.prior!.trait_meta!.preferences.diet.last_seen_at,
    );
    expect(sheet.trait_meta!.preferences.tone).toBeUndefined();
  });

  it("DECAY-ALL: every prior leaf > 90 days with no re-confirmation drops out (write empty sheet)", async () => {
    setup({
      prior: priorSheetWith({
        dietLastSeenDaysAgo: 120,
        toneLastSeenDaysAgo: 120,
        focusLastSeenDaysAgo: 120,
      }),
      memory: [
        {
          id: MEM_ID_NEW_FAR,
          node_type: "search",
          label: "weather in tokyo",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      llmResponses: ALL_EMPTY_LLM,
      embeddingResponses: [[MEMORY_EMB_FAR]],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    // Spec §B9 still requires we PERSIST the empty sheet so the broker stops
    // serving the stale prior.
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories).toEqual({});
    expect(sheet.trait_meta).toEqual({});
    expect(sheet.category_embeddings).toEqual({});
    expect(sheet.trait_embeddings).toEqual({});
  });

  it("SILENT NIGHT: no new memory + mixed-age prior → in-window leaves kept, expired ones dropped", async () => {
    setup({
      prior: priorSheetWith({
        dietLastSeenDaysAgo: 10,
        toneLastSeenDaysAgo: 10,
        focusLastSeenDaysAgo: 200,
      }),
      memory: [],
      llmResponses: [],
      embeddingResponses: [],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm",
    });
    expect(sheet.trait_meta!.preferences.diet.last_seen_at).toBe(
      harness.prior!.trait_meta!.preferences.diet.last_seen_at,
    );
    // transient.current_focus: 200d, not re-confirmable on a silent night → dropped
    expect(sheet.categories.transient).toBeUndefined();
    expect(sheet.trait_meta!.transient).toBeUndefined();
  });

  it("SILENT NIGHT with no prior sheet → no_new_memory, no write", async () => {
    setup({
      prior: null,
      memory: [],
      llmResponses: [],
      embeddingResponses: [],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(false);
    expect(r.reason).toBe("no_new_memory");
    expect(harness.upserted).toBeNull();
  });

  it("FRESH EXTRACTION extends a re-confirmed leaf's source_memory_ids", async () => {
    setup({
      prior: priorSheetWith({
        dietLastSeenDaysAgo: 10,
        toneLastSeenDaysAgo: 10,
        focusLastSeenDaysAgo: 200,
      }),
      memory: [
        {
          id: MEM_ID_NEW_PREFS,
          node_type: "note",
          label: "ordered vegetarian thali for lunch",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      // Only `preferences` returns content (just the diet leaf).
      llmResponses: [
        "{}", // physical
        "[]", // household
        '{"diet":["vegetarian"]}', // preferences
        "{}", // professional
        "{}", // wellness
        "{}", // transient
      ],
      embeddingResponses: [
        [MEMORY_EMB_FAR],                       // memory re-confirm pass
        [PRIOR_DIET_EMB, PRIOR_DIET_EMB],       // [cat:preferences, trait:diet]
                                                // tone is carried unchanged →
                                                // its embedding is reused from
                                                // prior, no new embed needed.
      ],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm", // tone carried (10d, no re-confirm needed)
    });
    const dietIds = sheet.trait_meta!.preferences.diet.source_memory_ids.map((s) => s.id);
    // Spec §B9: prior id must survive (extension, not re-create).
    expect(dietIds).toContain(MEM_ID_PRIOR_DIET);
    expect(dietIds).toContain(MEM_ID_NEW_PREFS);
    // tone: carried unchanged — same single source id, same last_seen.
    expect(sheet.trait_meta!.preferences.tone.source_memory_ids).toEqual([
      { kind: "memory", id: MEM_ID_PRIOR_TONE },
    ]);
    expect(sheet.trait_meta!.preferences.tone.last_seen_at).toBe(
      harness.prior!.trait_meta!.preferences.tone.last_seen_at,
    );
  });

  it("BACKWARD COMPAT: prior sheet with only category_meta migrates to per-leaf clocks", async () => {
    // Sheet from before task #28 — has category_meta but no trait_meta or
    // trait_embeddings. Each leaf inherits the category_meta last_seen_at as
    // its starting clock; from then on each runs independently.
    const dietSeen = new Date(Date.now() - 60 * 86400_000).toISOString();
    const legacyPrior: TraitSheet = {
      schema_version: 1,
      derived_at: dietSeen,
      source_memory_ids: [],
      categories: {
        preferences: { diet: ["vegetarian"], tone: "warm" },
      },
      category_embeddings: { preferences: PRIOR_DIET_EMB },
      category_meta: {
        preferences: {
          last_seen_at: dietSeen,
          source_memory_ids: [{ kind: "memory", id: MEM_ID_PRIOR_DIET }],
        },
      },
    };
    setup({
      prior: legacyPrior,
      memory: [
        {
          id: MEM_ID_NEW_FAR,
          node_type: "search",
          label: "weather",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      llmResponses: ALL_EMPTY_LLM,
      // No trait_embeddings on the prior sheet → no per-leaf re-confirm
      // possible this night; carry by age. Memory-embed call still happens
      // because there are prior categories.
      embeddingResponses: [[MEMORY_EMB_FAR]],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm",
    });
    // Both leaves seeded with the legacy category-level last_seen_at.
    expect(sheet.trait_meta!.preferences.diet.last_seen_at).toBe(dietSeen);
    expect(sheet.trait_meta!.preferences.tone.last_seen_at).toBe(dietSeen);
  });
});

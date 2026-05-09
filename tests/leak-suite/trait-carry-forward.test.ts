/**
 * Spec §B9 — cross-night trait carry-forward + 90-day decay (task #24).
 *
 * v1's extractor regenerated the sheet from scratch every night and only saw
 * the last 30 days of memory, so a trait mentioned in March and not again
 * until June got silently wiped on day 31. This test exercises the three
 * branches of the carry-forward logic:
 *
 *   1. CARRY: prior category, no new memory references it, last_seen < 90d
 *      → carried forward unchanged with prior meta.
 *   2. RECONFIRM: prior category, ≥1 new memory cosine ≥ 0.4 against prior
 *      embedding → carried forward, last_seen refreshed, source_memory_ids
 *      EXTENDED (not re-created).
 *   3. EXPIRE: prior category, no re-confirmation, last_seen ≥ 90d → dropped.
 *
 * Supabase + Cloudflare are stubbed so the test runs offline & deterministic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TraitSheet } from "@/lib/trait-schema";

// ─── Knobs the per-test setup writes to ─────────────────────────────────────
//
// We declare these at module scope so the vi.mock factories (hoisted to the
// top of the file) can read them. Each test mutates them via `setup(...)`.

type MemRow = { id: string; node_type: string; label: string; data: unknown; created_at: string };

const ZERO_384 = (): number[] => new Array(384).fill(0);

// Two orthogonal-ish base vectors. PRIOR_EMB is what the prior sheet's
// preferences-category embedding is set to. MEMORY_EMB_MATCH is identical to
// PRIOR_EMB so cosine = 1.0 (re-confirms). MEMORY_EMB_FAR is a different
// pattern so cosine << 0.4 (does not re-confirm).
const PRIOR_PREF_EMB = (() => {
  const v = ZERO_384();
  for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.13);
  return v;
})();
const PRIOR_TRANSIENT_EMB = (() => {
  const v = ZERO_384();
  for (let i = 0; i < 384; i++) v[i] = Math.cos(i * 0.21);
  return v;
})();
const MEMORY_EMB_MATCH_PREFS = PRIOR_PREF_EMB.slice();
const MEMORY_EMB_FAR = (() => {
  // Orthogonal-ish to both prior embeddings: a different sinusoid phase.
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
  // Captured upsert payload (the sheet written).
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
      // upsert() — capture payload, return success. The extractor calls
      // .upsert(row, { onConflict }) and awaits the resulting promise; the
      // promise resolves to `{ error: null }` (Supabase's pattern).
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
    return makeInsertChain(); // extraction_failures et al
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
        if (r === null) {
          // Mimic the real provider's error path; extractCategoryPatch
          // catches and treats as null patch.
          throw new Error("no response");
        }
        return { text: r };
      },
    },
    embedTexts: async (texts: readonly string[]) => {
      const idx = embedCall++;
      const preset = harness.embeddingResponses[idx];
      if (preset) return preset.slice(0, texts.length);
      // Fallback: deterministic per-text vector so unmocked callers don't hang.
      return texts.map(() => ZERO_384());
    },
    // Reset call counters between tests via a magic re-import is tricky —
    // we instead reset the closures by re-mocking. Vitest re-evaluates the
    // factory once, so we use a getter to allow tests to peek if needed.
    __resetCloudflareCounters: () => {
      llmCall = 0;
      embedCall = 0;
    },
  };
});

beforeEach(async () => {
  // Reset the module-level call counters in the cloudflare mock between tests.
  const cf = await import("@/server/inference/cloudflare");
  (cf as unknown as { __resetCloudflareCounters: () => void }).__resetCloudflareCounters();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const USER_ID = "11111111-1111-1111-1111-111111111111";
const MEM_ID_NEW_PREFS = "22222222-2222-2222-2222-222222222222";
const MEM_ID_NEW_FAR = "33333333-3333-3333-3333-333333333333";
const MEM_ID_PRIOR_PREFS = "44444444-4444-4444-4444-444444444444";
const MEM_ID_PRIOR_TRANSIENT = "55555555-5555-5555-5555-555555555555";

function priorSheetWith(opts: {
  prefsLastSeenDaysAgo: number;
  transientLastSeenDaysAgo: number;
}): TraitSheet {
  const now = Date.now();
  const prefsSeen = new Date(now - opts.prefsLastSeenDaysAgo * 86400_000).toISOString();
  const transientSeen = new Date(
    now - opts.transientLastSeenDaysAgo * 86400_000,
  ).toISOString();
  return {
    schema_version: 1,
    derived_at: prefsSeen,
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
    category_embeddings: {
      preferences: PRIOR_PREF_EMB,
      transient: PRIOR_TRANSIENT_EMB,
    },
    category_meta: {
      preferences: {
        last_seen_at: prefsSeen,
        source_memory_ids: [{ kind: "memory", id: MEM_ID_PRIOR_PREFS }],
      },
      transient: {
        last_seen_at: transientSeen,
        source_memory_ids: [{ kind: "memory", id: MEM_ID_PRIOR_TRANSIENT }],
      },
    },
  };
}

// 6 categories in TRAIT_CATEGORIES, so 6 LLM calls per run. We return "{}"
// for every category to simulate "the new memory window contains nothing
// the LLM can pull a category from" — which is the exact case the
// carry-forward fix is for.
const ALL_EMPTY_LLM: (string | null)[] = ["{}", "[]", "{}", "{}", "{}", "{}"];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Trait extractor — spec §B9 carry-forward & 90-day decay", () => {
  it("CARRY: prior trait survives a night with no re-confirming memory (still inside 90d)", async () => {
    setup({
      prior: priorSheetWith({ prefsLastSeenDaysAgo: 60, transientLastSeenDaysAgo: 60 }),
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
      // memory embedding call returns FAR, so cosine << 0.4 → no re-confirm
      embeddingResponses: [[MEMORY_EMB_FAR]],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    // Both prior categories carried forward unchanged.
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm",
    });
    expect(sheet.categories.transient).toEqual({
      current_focus: "preparing for spring marathon",
    });
    // Embeddings re-used from prior (not re-computed).
    expect(sheet.category_embeddings.preferences).toEqual(PRIOR_PREF_EMB);
    // Meta preserved (last_seen_at NOT refreshed because no re-confirmation).
    expect(sheet.category_meta!.preferences.last_seen_at).toBe(
      harness.prior!.category_meta!.preferences.last_seen_at,
    );
    // source_memory_ids unchanged (no extension on plain carry-forward).
    expect(sheet.category_meta!.preferences.source_memory_ids).toEqual([
      { kind: "memory", id: MEM_ID_PRIOR_PREFS },
    ]);
  });

  it("RECONFIRM: cosine ≥ 0.4 refreshes last_seen_at and EXTENDS source_memory_ids", async () => {
    setup({
      prior: priorSheetWith({ prefsLastSeenDaysAgo: 80, transientLastSeenDaysAgo: 200 }),
      memory: [
        {
          id: MEM_ID_NEW_PREFS,
          node_type: "note",
          label: "tried a new vegetarian recipe with chickpeas",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      llmResponses: ALL_EMPTY_LLM,
      // Memory embedding identical to prior preferences embedding ⇒ cosine=1.0
      // ⇒ preferences is re-confirmed. transient's prior embedding is far
      // from this memory, so transient is NOT re-confirmed.
      embeddingResponses: [[MEMORY_EMB_MATCH_PREFS]],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;

    // preferences: re-confirmed → carried forward, meta refreshed + extended
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm",
    });
    const prefsMeta = sheet.category_meta!.preferences;
    // last_seen_at refreshed (newer than prior)
    expect(Date.parse(prefsMeta.last_seen_at)).toBeGreaterThan(
      Date.parse(harness.prior!.category_meta!.preferences.last_seen_at),
    );
    // source_memory_ids EXTENDED — prior id present, new id appended.
    const ids = prefsMeta.source_memory_ids.map((s) => s.id);
    expect(ids).toContain(MEM_ID_PRIOR_PREFS);
    expect(ids).toContain(MEM_ID_NEW_PREFS);

    // transient: 200 days since last_seen, no re-confirmation → DROPPED
    expect(sheet.categories.transient).toBeUndefined();
    expect(sheet.category_meta!.transient).toBeUndefined();
  });

  it("EXPIRE: prior trait > 90 days with no re-confirmation drops out (write empty sheet)", async () => {
    setup({
      prior: priorSheetWith({ prefsLastSeenDaysAgo: 120, transientLastSeenDaysAgo: 120 }),
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
    // Both prior categories expired. Spec §B9: "drops out of the next sheet
    // version" — we MUST persist an empty-categories sheet so the stale prior
    // is overwritten in user_traits, otherwise the broker keeps serving the
    // expired traits.
    expect(r.written).toBe(true);
    expect(harness.upserted).not.toBeNull();
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories).toEqual({});
    expect(sheet.category_meta).toEqual({});
    expect(sheet.category_embeddings).toEqual({});
  });

  it("SILENT NIGHT: no new memory + prior expired → expired traits dropped, fresh ones kept", async () => {
    // User went fully silent (memory.length === 0) but prior sheet still has
    // both an in-window category (preferences, last_seen 10 days ago) and an
    // expired one (transient, last_seen 200 days ago). Carry-forward/decay
    // must still run — preferences kept, transient dropped.
    setup({
      prior: priorSheetWith({ prefsLastSeenDaysAgo: 10, transientLastSeenDaysAgo: 200 }),
      memory: [],
      llmResponses: [], // LLM must NOT be called on silent nights
      embeddingResponses: [],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    // preferences: still inside 90-day window → carried forward
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm",
    });
    expect(sheet.category_meta!.preferences.last_seen_at).toBe(
      harness.prior!.category_meta!.preferences.last_seen_at,
    );
    // transient: 200d > 90d, no re-confirmation possible (no memory) → dropped
    expect(sheet.categories.transient).toBeUndefined();
    expect(sheet.category_meta!.transient).toBeUndefined();
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

  it("FRESH EXTRACTION extends prior per-category source_memory_ids (re-confirmed by overlap)", async () => {
    // The extractor freshly extracts `preferences` from new memory. The prior
    // sheet also had `preferences` with one source id. Spec §B9 says the
    // re-confirmed category's source_memory_ids should be EXTENDED, not
    // re-created — i.e. the prior id must survive into the new sheet.
    setup({
      prior: priorSheetWith({ prefsLastSeenDaysAgo: 10, transientLastSeenDaysAgo: 200 }),
      memory: [
        {
          id: MEM_ID_NEW_PREFS,
          node_type: "note",
          label: "ordered vegetarian thali for lunch",
          data: {},
          created_at: new Date().toISOString(),
        },
      ],
      // 6 LLM calls: only `preferences` returns content.
      // Order in TRAIT_CATEGORIES: physical, household, preferences,
      // professional, wellness, transient.
      llmResponses: [
        "{}", // physical
        "[]", // household
        '{"diet":["vegetarian"],"tone":"warm"}', // preferences
        "{}", // professional
        "{}", // wellness
        "{}", // transient
      ],
      // First embedTexts call: 1 newly-extracted category (preferences) ⇒
      // returns 1 vector. Second call (memory re-confirmation): not made
      // because transient's prior age (200d) means it expires regardless,
      // BUT the implementation still embeds memory if there is at least one
      // carry-forward CANDIDATE. transient is a candidate, so embedTexts is
      // called a second time — make it return 1 FAR vector so transient does
      // not get re-confirmed.
      embeddingResponses: [
        [PRIOR_PREF_EMB], // newly-extracted preferences embedding
        [MEMORY_EMB_FAR], // memory re-confirmation
      ],
    });
    const { runTraitExtractionForUserId } = await import("@/server/trait-extraction");
    const r = await runTraitExtractionForUserId(USER_ID);
    expect(r.written).toBe(true);
    const sheet = harness.upserted!.sheet;
    expect(sheet.categories.preferences).toEqual({
      diet: ["vegetarian"],
      tone: "warm",
    });
    const ids = sheet.category_meta!.preferences.source_memory_ids.map((s) => s.id);
    // Spec §B9: prior id must survive (extension, not re-create).
    expect(ids).toContain(MEM_ID_PRIOR_PREFS);
    expect(ids).toContain(MEM_ID_NEW_PREFS);
  });
});

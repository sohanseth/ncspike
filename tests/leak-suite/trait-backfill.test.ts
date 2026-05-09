/**
 * Task #40: backfill of v1 user_traits sheets (category_meta + per-category
 * embeddings only) to the per-trait freshness format introduced by task #28
 * (trait_meta + trait_embeddings).
 *
 * Coverage:
 *   1. v1 sheet → upgraded sheet has trait_meta seeded from category_meta
 *      and a trait_embedding for every leaf in every non-empty category.
 *   2. Idempotent: re-running on an already-upgraded sheet is a no-op (no
 *      embedding calls, no upsert).
 *   3. Partial-upgrade tolerance: a sheet that already has trait_meta but is
 *      missing trait_embeddings still gets embeddings filled in, and we don't
 *      clobber the existing trait_meta clocks.
 *   4. Embedding failure is surfaced as a failed result and does NOT upsert.
 *
 * Supabase + Cloudflare are stubbed so this runs offline & deterministic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TraitSheet } from "@/lib/trait-schema";

type UserTraitsRow = { version: number; sheet: TraitSheet; derived_at?: string };

const ZERO_384 = (): number[] => new Array(384).fill(0);

const harness = {
  row: null as UserTraitsRow | null,
  upserted: null as null | { user_id: string; version: number; sheet: TraitSheet },
  embedCalls: 0,
  embedShouldThrow: false,
};

function setup(row: UserTraitsRow | null, opts: { embedShouldThrow?: boolean } = {}) {
  harness.row = row;
  harness.upserted = null;
  harness.embedCalls = 0;
  harness.embedShouldThrow = opts.embedShouldThrow ?? false;
}

// For multi-page tests: a list of user_ids the harness should serve up via the
// paginated user-list query, plus a per-user sheet store. Single-user tests
// keep using `harness.row`; the helpers fall back to that when these are unset.
const harnessList = {
  ids: null as string[] | null,
  sheets: new Map<string, UserTraitsRow>(),
  pageCalls: [] as Array<{ from: number; to: number }>,
};

function setupMulti(rows: UserTraitsRow[], idPrefix = "u") {
  harness.row = null;
  harness.upserted = null;
  harness.embedCalls = 0;
  harness.embedShouldThrow = false;
  harnessList.ids = rows.map((_, i) => `${idPrefix}${String(i).padStart(4, "0")}`);
  harnessList.sheets.clear();
  harnessList.pageCalls = [];
  rows.forEach((r, i) => harnessList.sheets.set(harnessList.ids![i], r));
}

vi.mock("@/integrations/supabase/client.server", () => {
  function makeUserTraitsChain() {
    let pendingEqUserId: string | null = null;
    let pendingRange: { from: number; to: number } | null = null;
    const chain: any = {
      maybeSingle: async () => {
        if (pendingEqUserId !== null && harnessList.sheets.size > 0) {
          const row = harnessList.sheets.get(pendingEqUserId);
          if (!row) return { data: null, error: null };
          return {
            data: { version: row.version, sheet: row.sheet, derived_at: row.derived_at },
            error: null,
          };
        }
        return harness.row
          ? {
              data: {
                version: harness.row.version,
                sheet: harness.row.sheet,
                derived_at: harness.row.derived_at,
              },
              error: null,
            }
          : { data: null, error: null };
      },
      upsert: (row: any) => {
        harness.upserted = row;
        if (harnessList.sheets.has(row.user_id)) {
          // Reflect the upsert back into the per-user store so a subsequent
          // backfill iteration sees the upgraded sheet (idempotency check).
          harnessList.sheets.set(row.user_id, {
            version: row.version,
            sheet: row.sheet,
            derived_at: row.derived_at,
          });
        }
        const res = { data: null, error: null };
        return { then: (r: any) => Promise.resolve(r(res)) };
      },
      then: (res: any) => {
        // user-list query path used by backfillTraitMetaAllUsers.
        if (harnessList.ids !== null) {
          const range = pendingRange ?? { from: 0, to: harnessList.ids.length - 1 };
          harnessList.pageCalls.push(range);
          const slice = harnessList.ids.slice(range.from, range.to + 1);
          return Promise.resolve(
            res({ data: slice.map((id) => ({ user_id: id })), error: null }),
          );
        }
        const list = harness.row ? [{ user_id: "u1" }] : [];
        return Promise.resolve(res({ data: list, error: null }));
      },
    };
    chain.select = () => chain;
    chain.order = () => chain;
    chain.range = (from: number, to: number) => {
      pendingRange = { from, to };
      return chain;
    };
    chain.eq = (_col: string, val: string) => {
      pendingEqUserId = val;
      return chain;
    };
    return chain;
  }

  function makeInsertChain() {
    return { insert: async () => ({ data: null, error: null }) };
  }

  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "user_traits") return makeUserTraitsChain();
        return makeInsertChain();
      },
    },
  };
});

vi.mock("@/server/inference/cloudflare", () => ({
  cloudflareProvider: { generate: async () => ({ text: "{}" }) },
  embedTexts: async (texts: readonly string[]) => {
    harness.embedCalls++;
    if (harness.embedShouldThrow) throw new Error("embed failed");
    // Deterministic: encode the text length into the first slot so we can
    // tell different leaves' embeddings apart in assertions if needed.
    return texts.map((t) => {
      const v = ZERO_384();
      v[0] = t.length;
      return v;
    });
  },
}));

beforeEach(() => {
  vi.resetModules();
});

const NOW_ISO = "2026-04-01T00:00:00.000Z";
const OLD_ISO = "2026-01-15T00:00:00.000Z";
const MEM_REF = { kind: "memory" as const, id: "11111111-1111-1111-1111-111111111111" };

function v1Sheet(): TraitSheet {
  // Sheet as written by the task #24 extractor: category_meta only, no
  // trait_meta, no trait_embeddings.
  const catEmb = ZERO_384();
  return {
    schema_version: 1,
    derived_at: NOW_ISO,
    source_memory_ids: [MEM_REF],
    categories: {
      preferences: { diet: ["vegetarian"], tone: "warm" },
      transient: { current_focus: "spring marathon" },
    },
    category_embeddings: { preferences: catEmb, transient: catEmb },
    category_meta: {
      preferences: { last_seen_at: OLD_ISO, source_memory_ids: [MEM_REF] },
      transient: { last_seen_at: OLD_ISO, source_memory_ids: [] },
    },
  };
}

describe("backfillTraitMetaForUserId — task #40", () => {
  it("upgrades a v1 sheet: seeds trait_meta from category_meta and embeds every leaf", async () => {
    const { backfillTraitMetaForUserId } = await import("@/server/trait-extraction");
    setup({ version: 3, sheet: v1Sheet() });

    const r = await backfillTraitMetaForUserId("u1");

    expect(r.status).toBe("upgraded");
    if (r.status !== "upgraded") return;
    expect(r.categories).toBe(2);
    // preferences.diet, preferences.tone, transient.current_focus = 3 leaves
    expect(r.leaves).toBe(3);

    expect(harness.upserted).not.toBeNull();
    const upserted = harness.upserted!;
    expect(upserted.version).toBe(3); // version preserved on backfill

    const sheet = upserted.sheet;
    // trait_meta seeded from category_meta.last_seen_at
    expect(sheet.trait_meta?.preferences?.diet?.last_seen_at).toBe(OLD_ISO);
    expect(sheet.trait_meta?.preferences?.tone?.last_seen_at).toBe(OLD_ISO);
    expect(sheet.trait_meta?.transient?.current_focus?.last_seen_at).toBe(OLD_ISO);
    // source_memory_ids carried over from category_meta where present
    expect(sheet.trait_meta?.preferences?.diet?.source_memory_ids).toEqual([MEM_REF]);
    expect(sheet.trait_meta?.transient?.current_focus?.source_memory_ids).toEqual([]);
    // every leaf has an embedding
    expect(sheet.trait_embeddings?.preferences?.diet).toHaveLength(384);
    expect(sheet.trait_embeddings?.preferences?.tone).toHaveLength(384);
    expect(sheet.trait_embeddings?.transient?.current_focus).toHaveLength(384);
    // original content preserved
    expect(sheet.categories.preferences).toEqual({ diet: ["vegetarian"], tone: "warm" });
    expect(sheet.categories.transient).toEqual({ current_focus: "spring marathon" });
  });

  it("is idempotent: a fully-upgraded sheet is a no-op (no embed call, no upsert)", async () => {
    const { backfillTraitMetaForUserId } = await import("@/server/trait-extraction");
    // Run once to upgrade, then feed the upgraded sheet back in.
    setup({ version: 3, sheet: v1Sheet() });
    const first = await backfillTraitMetaForUserId("u1");
    expect(first.status).toBe("upgraded");
    const upgradedSheet = harness.upserted!.sheet;

    setup({ version: 3, sheet: upgradedSheet });
    const second = await backfillTraitMetaForUserId("u1");

    expect(second.status).toBe("noop");
    if (second.status === "noop") expect(second.reason).toBe("already_upgraded");
    expect(harness.embedCalls).toBe(0);
    expect(harness.upserted).toBeNull();
  });

  it("partial-upgrade: fills in missing trait_embeddings without clobbering existing trait_meta clocks", async () => {
    const { backfillTraitMetaForUserId } = await import("@/server/trait-extraction");
    const partial = v1Sheet();
    // Pretend trait_meta exists but trait_embeddings does not (hand-edited
    // sheet, or partial backfill that died after writing meta).
    const customClock = "2026-02-20T00:00:00.000Z";
    partial.trait_meta = {
      preferences: {
        diet: { last_seen_at: customClock, source_memory_ids: [MEM_REF] },
        tone: { last_seen_at: customClock, source_memory_ids: [] },
      },
      transient: {
        current_focus: { last_seen_at: customClock, source_memory_ids: [] },
      },
    };
    setup({ version: 5, sheet: partial });

    const r = await backfillTraitMetaForUserId("u1");
    expect(r.status).toBe("upgraded");
    expect(harness.embedCalls).toBe(1);
    const sheet = harness.upserted!.sheet;
    // trait_meta clocks were preserved, NOT reset to derived_at
    expect(sheet.trait_meta?.preferences?.diet?.last_seen_at).toBe(customClock);
    expect(sheet.trait_meta?.preferences?.tone?.last_seen_at).toBe(customClock);
    expect(sheet.trait_meta?.transient?.current_focus?.last_seen_at).toBe(customClock);
    // embeddings now present for every leaf
    expect(sheet.trait_embeddings?.preferences?.diet).toHaveLength(384);
    expect(sheet.trait_embeddings?.preferences?.tone).toHaveLength(384);
    expect(sheet.trait_embeddings?.transient?.current_focus).toHaveLength(384);
  });

  it("returns a failed result and does not upsert when embedding fails", async () => {
    const { backfillTraitMetaForUserId } = await import("@/server/trait-extraction");
    setup({ version: 3, sheet: v1Sheet() }, { embedShouldThrow: true });

    const r = await backfillTraitMetaForUserId("u1");
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.reason).toBe("embedding_failed");
    expect(harness.upserted).toBeNull();
  });

  it("returns no-sheet noop when the user has no row", async () => {
    const { backfillTraitMetaForUserId } = await import("@/server/trait-extraction");
    setup(null);

    const r = await backfillTraitMetaForUserId("u1");
    expect(r.status).toBe("noop");
    if (r.status === "noop") expect(r.reason).toBe("no_sheet");
    expect(harness.embedCalls).toBe(0);
  });
});

describe("backfillTraitMetaAllUsers — task #40", () => {
  it("aggregates a summary across users", async () => {
    const { backfillTraitMetaAllUsers } = await import("@/server/trait-extraction");
    setup({ version: 3, sheet: v1Sheet() });

    const summary = await backfillTraitMetaAllUsers();
    expect(summary.users).toBe(1);
    expect(summary.upgraded).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("paginates the user-list query so deployments past the PostgREST row cap are fully covered", async () => {
    const { backfillTraitMetaAllUsers } = await import("@/server/trait-extraction");
    // 1100 users — more than one page of the 500-page batch size, exercising
    // the pagination loop's stop-on-short-page condition.
    const rows: UserTraitsRow[] = [];
    for (let i = 0; i < 1100; i++) rows.push({ version: 1, sheet: v1Sheet() });
    setupMulti(rows);

    const summary = await backfillTraitMetaAllUsers();

    expect(summary.users).toBe(1100);
    expect(summary.upgraded).toBe(1100);
    expect(summary.failed).toBe(0);
    // Pages: 0..499, 500..999, 1000..1499 → three select calls, last one short.
    expect(harnessList.pageCalls.length).toBe(3);
    expect(harnessList.pageCalls[0]).toEqual({ from: 0, to: 499 });
    expect(harnessList.pageCalls[1]).toEqual({ from: 500, to: 999 });
    expect(harnessList.pageCalls[2]).toEqual({ from: 1000, to: 1499 });
  });

  it("re-running on an already-upgraded population is a full no-op", async () => {
    const { backfillTraitMetaAllUsers } = await import("@/server/trait-extraction");
    const rows: UserTraitsRow[] = [];
    for (let i = 0; i < 3; i++) rows.push({ version: 1, sheet: v1Sheet() });
    setupMulti(rows);

    const first = await backfillTraitMetaAllUsers();
    expect(first.upgraded).toBe(3);
    const embedCallsAfterFirst = harness.embedCalls;

    const second = await backfillTraitMetaAllUsers();
    expect(second.users).toBe(3);
    expect(second.upgraded).toBe(0);
    expect(second.alreadyUpgraded).toBe(3);
    expect(second.failed).toBe(0);
    expect(harness.embedCalls).toBe(embedCallsAfterFirst); // no new embed calls
  });
});

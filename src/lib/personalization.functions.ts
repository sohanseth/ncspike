/**
 * Personalization server functions (Phase 2.7 D8 Day 5).
 *
 * Surface for the /workspace/personalization route, the ContextFooter actions,
 * and the GDPR data-export / delete-account flow (Day 6).
 *
 *   getTraitSheet()                      → load + sanitised view of user_traits
 *   exportTraitSheet()                   → full JSON for download
 *   deleteTraitSheet()                   → wipe user_traits row
 *   scheduleReextract()                  → flag the cron job to re-derive
 *   forgetTrait({category, traitPath, days?}) → user_trait_blocks insert
 *   listTraitBlocks()                    → for the settings UI
 *   removeTraitBlock({category, traitPath}) → undo
 *   blockProviderCategory({tier, category})
 *   unblockProviderCategory({tier, category})
 *   listProviderCategoryBlocks()
 *   applyPersonalizationPreset({preset})  → 'simple' | 'strict' | 'open'
 *   getPersonalizationGlobals()           → oss_only_mode + private_only_mode + enabled flag
 *   setPersonalizationGlobals({...})
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  TRAIT_CATEGORIES,
  TRAIT_DECAY_DAYS,
  TraitSheetSchema,
  type TraitCategory,
  type TraitSheet,
} from "@/lib/trait-schema";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * One leaf in the user's trait sheet, surfaced to the personalization UI.
 *
 * `lastSeenAt` / `expiresAt` come from per-leaf `trait_meta` (task #28). For
 * sheets written before #28 we fall back to:
 *   - the v1 `category_meta[cat].last_seen_at` (task #24 cross-night carry),
 *   - then to the sheet's top-level `derived_at`,
 *   - and finally to `null` if even that is missing (oldest sheets).
 *
 * `expiresAt` is `lastSeenAt + TRAIT_DECAY_DAYS` so the UI can render a
 * "expires in N days" countdown matching the extractor's actual decay cut.
 */
export type TraitLeafView = {
  /** Broker-format path, e.g. "preferences.diet" or "household.child_1.interests".
   *  Stable join key against `forgetTrait` / `removeTraitBlock`. */
  path: string;
  lastSeenAt: string | null;
  expiresAt: string | null;
};

export type TraitSheetView = {
  exists: boolean;
  version: number | null;
  derivedAt: string | null;
  sourceCount: number;
  /** Categories present + their leaves with per-leaf freshness. */
  categories: Array<{ category: TraitCategory; leaves: TraitLeafView[] }>;
};

export type TraitBlockRow = {
  category: TraitCategory;
  traitPath: string;
  blockedUntil: string;
};

export type ProviderCategoryBlockRow = {
  providerTier: 0 | 1 | 2 | 3;
  category: TraitCategory;
};

export type PersonalizationGlobals = {
  enabled: boolean;
  ossOnlyMode: boolean;
  privateOnlyMode: boolean;
};

export type PersonalizationPreset = "simple" | "strict" | "open";

// ─── Helpers ────────────────────────────────────────────────────────────────

function isCategory(x: unknown): x is TraitCategory {
  return typeof x === "string" && (TRAIT_CATEGORIES as readonly string[]).includes(x);
}

function isTier(x: unknown): x is 0 | 1 | 2 | 3 {
  return x === 0 || x === 1 || x === 2 || x === 3;
}

/**
 * Walk a category payload and emit one leaf per renderable trait, attaching
 * its per-leaf freshness from `trait_meta` (or the v1 `category_meta`
 * fallback, or the sheet's `derived_at` as a last resort).
 *
 * Path format MATCHES `context-broker.ts:collectTraitPaths` so the UI's
 * delete button can pass it straight to `forgetTrait`.
 *
 * For household, `trait_meta.household` is keyed by member `ref`
 * (e.g. "child_1") rather than per-(ref, sub-key) — every sub-leaf of a given
 * member shares the member's `last_seen_at`.
 */
function collectCategoryLeaves(
  category: TraitCategory,
  payload: unknown,
  sheet: TraitSheet,
): TraitLeafView[] {
  const out: TraitLeafView[] = [];
  if (payload == null) return out;
  const perTrait = sheet.trait_meta?.[category];
  const categoryFallback =
    sheet.category_meta?.[category]?.last_seen_at ?? sheet.derived_at ?? null;

  const decayMs = TRAIT_DECAY_DAYS * 24 * 60 * 60 * 1000;
  const computeExpiry = (lastSeenAt: string | null): string | null => {
    if (lastSeenAt == null) return null;
    const t = Date.parse(lastSeenAt);
    if (Number.isNaN(t)) return null;
    return new Date(t + decayMs).toISOString();
  };

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const ref = (item as { ref?: string }).ref ?? "_";
      const memberLastSeen = perTrait?.[ref]?.last_seen_at ?? categoryFallback;
      for (const k of Object.keys(item as Record<string, unknown>)) {
        if (k === "ref") continue;
        out.push({
          path: `${category}.${ref}.${k}`,
          lastSeenAt: memberLastSeen,
          expiresAt: computeExpiry(memberLastSeen),
        });
      }
    }
    return out;
  }

  if (typeof payload === "object") {
    for (const k of Object.keys(payload as Record<string, unknown>)) {
      const leafLastSeen = perTrait?.[k]?.last_seen_at ?? categoryFallback;
      out.push({
        path: `${category}.${k}`,
        lastSeenAt: leafLastSeen,
        expiresAt: computeExpiry(leafLastSeen),
      });
    }
  }
  return out;
}

// ─── Trait sheet IO ─────────────────────────────────────────────────────────

export const getTraitSheet = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<TraitSheetView> => {
    const { data, error } = await (supabaseAdmin as any)
      .from("user_traits")
      .select("version, sheet, derived_at, source_count")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return { exists: false, version: null, derivedAt: null, sourceCount: 0, categories: [] };
    }
    const parsed = TraitSheetSchema.safeParse(data.sheet);
    const categories: Array<{ category: TraitCategory; leaves: TraitLeafView[] }> = [];
    if (parsed.success) {
      const sheet: TraitSheet = parsed.data;
      for (const cat of TRAIT_CATEGORIES) {
        const payload = sheet.categories[cat];
        if (payload == null) continue;
        if (Array.isArray(payload) && payload.length === 0) continue;
        const leaves = collectCategoryLeaves(cat, payload, sheet);
        if (leaves.length === 0) continue;
        categories.push({ category: cat, leaves });
      }
    }
    return {
      exists: true,
      version: data.version ?? 1,
      derivedAt: data.derived_at ?? null,
      sourceCount: data.source_count ?? 0,
      categories,
    };
  });

export type TraitSheetExport = { sheet: string | null; version: number | null };

export const exportTraitSheet = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<TraitSheetExport> => {
    const { data, error } = await (supabaseAdmin as any)
      .from("user_traits")
      .select("version, sheet")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw error;
    // Pre-stringify so the server-fn serializer doesn't reject `unknown`.
    return {
      sheet: data?.sheet == null ? null : JSON.stringify(data.sheet),
      version: data?.version ?? null,
    };
  });

export const deleteTraitSheet = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ deleted: boolean }> => {
    const { error } = await (supabaseAdmin as any)
      .from("user_traits")
      .delete()
      .eq("user_id", context.userId);
    if (error) throw error;
    return { deleted: true };
  });

/**
 * Mark the sheet as needing re-extraction. The trait extractor cron will pick
 * this up on its next run; until then the existing sheet (if any) keeps being
 * used by the broker. We bump derived_at to a sentinel-old value so the cron's
 * cold-start trigger fires.
 */
export const scheduleReextract = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ scheduled: boolean }> => {
    const { error } = await (supabaseAdmin as any)
      .from("user_traits")
      .update({ derived_at: new Date(0).toISOString() })
      .eq("user_id", context.userId);
    if (error) throw error;
    return { scheduled: true };
  });

// ─── Per-trait blocks (ContextFooter "Forget this trait") ──────────────────

export const forgetTrait = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { category: string; traitPath: string; days?: number }) => {
    if (!isCategory(d.category)) throw new Error("Invalid category");
    if (typeof d.traitPath !== "string" || d.traitPath.length === 0 || d.traitPath.length > 200) {
      throw new Error("Invalid traitPath");
    }
    const days = typeof d.days === "number" && d.days > 0 && d.days <= 3650 ? d.days : 365;
    return { category: d.category, traitPath: d.traitPath, days };
  })
  .handler(async ({ data, context }): Promise<{ blockedUntil: string }> => {
    const blockedUntil = new Date(Date.now() + data.days * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await (supabaseAdmin as any)
      .from("user_trait_blocks")
      .upsert(
        {
          user_id: context.userId,
          category: data.category,
          trait_path: data.traitPath,
          blocked_until: blockedUntil,
        },
        { onConflict: "user_id,category,trait_path" },
      );
    if (error) throw error;
    return { blockedUntil };
  });

export const listTraitBlocks = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<TraitBlockRow[]> => {
    const { data, error } = await (supabaseAdmin as any)
      .from("user_trait_blocks")
      .select("category, trait_path, blocked_until")
      .eq("user_id", context.userId)
      .gt("blocked_until", new Date().toISOString());
    if (error) throw error;
    return ((data ?? []) as Array<{ category: string; trait_path: string; blocked_until: string }>)
      .filter((r) => isCategory(r.category))
      .map((r) => ({
        category: r.category as TraitCategory,
        traitPath: r.trait_path,
        blockedUntil: r.blocked_until,
      }));
  });

export const removeTraitBlock = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { category: string; traitPath: string }) => {
    if (!isCategory(d.category)) throw new Error("Invalid category");
    if (typeof d.traitPath !== "string") throw new Error("Invalid traitPath");
    return { category: d.category, traitPath: d.traitPath };
  })
  .handler(async ({ data, context }): Promise<{ removed: boolean }> => {
    const { error } = await (supabaseAdmin as any)
      .from("user_trait_blocks")
      .delete()
      .eq("user_id", context.userId)
      .eq("category", data.category)
      .eq("trait_path", data.traitPath);
    if (error) throw error;
    return { removed: true };
  });

// ─── Per-provider-tier per-category blocks (matrix) ─────────────────────────

export const blockProviderCategory = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { tier: number; category: string }) => {
    if (!isTier(d.tier)) throw new Error("Invalid tier");
    if (!isCategory(d.category)) throw new Error("Invalid category");
    return { tier: d.tier, category: d.category };
  })
  .handler(async ({ data, context }): Promise<{ blocked: boolean }> => {
    const { error } = await (supabaseAdmin as any)
      .from("user_provider_category_blocks")
      .upsert(
        {
          user_id: context.userId,
          provider_tier: data.tier,
          category: data.category,
        },
        { onConflict: "user_id,provider_tier,category" },
      );
    if (error) throw error;
    return { blocked: true };
  });

export const unblockProviderCategory = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { tier: number; category: string }) => {
    if (!isTier(d.tier)) throw new Error("Invalid tier");
    if (!isCategory(d.category)) throw new Error("Invalid category");
    return { tier: d.tier, category: d.category };
  })
  .handler(async ({ data, context }): Promise<{ unblocked: boolean }> => {
    const { error } = await (supabaseAdmin as any)
      .from("user_provider_category_blocks")
      .delete()
      .eq("user_id", context.userId)
      .eq("provider_tier", data.tier)
      .eq("category", data.category);
    if (error) throw error;
    return { unblocked: true };
  });

export const listProviderCategoryBlocks = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<ProviderCategoryBlockRow[]> => {
    const { data, error } = await (supabaseAdmin as any)
      .from("user_provider_category_blocks")
      .select("provider_tier, category")
      .eq("user_id", context.userId);
    if (error) throw error;
    return ((data ?? []) as Array<{ provider_tier: number; category: string }>)
      .filter((r) => isTier(r.provider_tier) && isCategory(r.category))
      .map((r) => ({
        providerTier: r.provider_tier as 0 | 1 | 2 | 3,
        category: r.category as TraitCategory,
      }));
  });

// ─── Presets (spec §B11) ────────────────────────────────────────────────────
//
// Simple (default): T0/T1 all on; T2 on for physical/preferences/professional;
//                   T3 on for preferences only. → Block T2 wellness, T3 physical,
//                   T3 professional. (T1+ household and T3 wellness/transient
//                   are already non-overridable in broker NEVER_AT_TIER.)
// Strict: T0 only. Equivalent to PRIVATE-only mode (B10). Clear category
//         blocks; flip privateOnlyMode = true on user_settings. Routing is
//         enforced upstream by the chain resolver, so the broker doesn't
//         need extra blocks here.
// Open:   T0/T1/T2/T3 on for physical/preferences/professional. T2 wellness
//         requires separate confirmation (spec §B11) → leave it blocked by
//         default; the user toggles it on via Advanced. T3 wellness +
//         household at all tiers >0 stay blocked by NEVER_AT_TIER (non-
//         overridable). Clears privateOnlyMode if it was on.

const PRESET_BLOCKS: Record<PersonalizationPreset, ProviderCategoryBlockRow[]> = {
  simple: [
    { providerTier: 2, category: "wellness" },
    { providerTier: 3, category: "physical" },
    { providerTier: 3, category: "professional" },
  ],
  strict: [],
  open: [
    // T2 wellness is opt-in per B11 — block by default; user re-enables in Advanced.
    { providerTier: 2, category: "wellness" },
  ],
};

const PRESET_GLOBALS: Record<PersonalizationPreset, { privateOnlyMode: boolean }> = {
  simple: { privateOnlyMode: false },
  strict: { privateOnlyMode: true },
  open: { privateOnlyMode: false },
};

export const applyPersonalizationPreset = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { preset: string }) => {
    if (d.preset !== "simple" && d.preset !== "strict" && d.preset !== "open") {
      throw new Error("Invalid preset");
    }
    return { preset: d.preset as PersonalizationPreset };
  })
  .handler(async ({ data, context }): Promise<{ applied: PersonalizationPreset }> => {
    // Replace all existing rows with the preset's rows. Service-role bypasses
    // RLS so we pin user_id explicitly on every statement.
    const { error: dErr } = await (supabaseAdmin as any)
      .from("user_provider_category_blocks")
      .delete()
      .eq("user_id", context.userId);
    if (dErr) throw dErr;
    const rows = PRESET_BLOCKS[data.preset];
    if (rows.length > 0) {
      const { error: iErr } = await (supabaseAdmin as any)
        .from("user_provider_category_blocks")
        .insert(
          rows.map((r) => ({
            user_id: context.userId,
            provider_tier: r.providerTier,
            category: r.category,
          })),
        );
      if (iErr) throw iErr;
    }
    // Reflect the preset's routing mode on user_settings (B10/B11 — Strict ≡
    // PRIVATE-only mode). Done as an upsert so first-run users get a row.
    const { privateOnlyMode } = PRESET_GLOBALS[data.preset];
    const { error: sErr } = await (supabaseAdmin as any)
      .from("user_settings")
      .upsert(
        { user_id: context.userId, private_only_mode: privateOnlyMode },
        { onConflict: "user_id" },
      );
    if (sErr) throw sErr;
    return { applied: data.preset };
  });

// ─── Global toggles (B7 + B10 + B11) ────────────────────────────────────────

export const getPersonalizationGlobals = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<PersonalizationGlobals> => {
    const { data, error } = await (supabaseAdmin as any)
      .from("user_settings")
      .select("personalization_v1_enabled, oss_only_mode, private_only_mode")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw error;
    return {
      enabled: data?.personalization_v1_enabled ?? false,
      ossOnlyMode: data?.oss_only_mode ?? false,
      privateOnlyMode: data?.private_only_mode ?? false,
    };
  });

export const setPersonalizationGlobals = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: { enabled?: boolean; ossOnlyMode?: boolean; privateOnlyMode?: boolean }) => d,
  )
  .handler(async ({ data, context }): Promise<PersonalizationGlobals> => {
    const patch: Record<string, boolean> = {};
    if (typeof data.enabled === "boolean") patch.personalization_v1_enabled = data.enabled;
    if (typeof data.ossOnlyMode === "boolean") patch.oss_only_mode = data.ossOnlyMode;
    if (typeof data.privateOnlyMode === "boolean") patch.private_only_mode = data.privateOnlyMode;
    const { error } = await (supabaseAdmin as any)
      .from("user_settings")
      .upsert({ user_id: context.userId, ...patch }, { onConflict: "user_id" });
    if (error) throw error;
    const { data: row } = await (supabaseAdmin as any)
      .from("user_settings")
      .select("personalization_v1_enabled, oss_only_mode, private_only_mode")
      .eq("user_id", context.userId)
      .maybeSingle();
    return {
      enabled: row?.personalization_v1_enabled ?? false,
      ossOnlyMode: row?.oss_only_mode ?? false,
      privateOnlyMode: row?.private_only_mode ?? false,
    };
  });

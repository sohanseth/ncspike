/**
 * Zod schema for the canonical TraitSheet artifact.
 * Spec: docs/06-spec-phase-2.7-context-broker.md §B1 + §13.
 *
 * Two responsibilities:
 *
 * 1. SHAPE — six top-level categories, identifier-free by construction
 *    (refs like `child_1`, age bands not exact ages, no employer/salary/title).
 *
 * 2. PROMPT-INJECTION DEFENSE (§13) — every string-typed trait field must:
 *    - be ≤ 80 characters (trait values are short labels, not paragraphs)
 *    - contain no newline characters
 *    - not contain prompt-injection sentinels (system:/assistant:/<|/|>/[INST]/`)
 *
 *    The same rule is applied transitively to every leaf string in arrays
 *    (e.g. `interests: string[]`) via `safeString()`.
 *
 * The extractor (Day 2) feeds Llama 8B output through `TraitSheetSchema.parse`.
 * On Zod failure the entire sheet is rolled back to the previous version and an
 * `extraction_failures` row is written (§13 rule 5).
 */
import { z } from "zod";

// ─── String safety ──────────────────────────────────────────────────────────
// Sentinels that, if found inside a trait value, would let a poisoned memory
// hijack the assembled system prompt. List from §13 plus a few common variants.
// Exported so `pii-scrub.ts` can reuse the exact same list at fragment-assembly
// time (defense in depth).
export const INJECTION_SENTINELS = [
  /\bsystem\s*:/i,
  /\bassistant\s*:/i,
  /\buser\s*:/i,
  /<\|/,           // chat-ml turn markers
  /\|>/,
  /\[INST\]/i,     // llama-style instruction markers
  /\[\/INST\]/i,
  /```/,           // triple backtick — would break our JSON-string fragment
  /\bignore (?:all )?(?:prior|previous|above) (?:instructions?|messages?)\b/i,
];

/**
 * String field with §13 sandboxing. Used as the leaf type for every
 * user-derived string in the sheet.
 */
const safeString = (maxLen = 80) =>
  z
    .string()
    .min(1)
    .max(maxLen)
    .refine((s) => !s.includes("\n") && !s.includes("\r"), {
      message: "trait strings must be single-line",
    })
    .refine((s) => !INJECTION_SENTINELS.some((re) => re.test(s)), {
      message: "trait string contains a prompt-injection sentinel",
    });

const safeStringArray = (maxItems = 12) =>
  z.array(safeString()).max(maxItems);

// ─── Categories ─────────────────────────────────────────────────────────────

export const PhysicalSchema = z
  .object({
    hair: safeString().optional(),
    scalp: safeString().optional(),
    skin: safeString().optional(),
    build: safeString().optional(),
    mobility: safeString().optional(),
  })
  .catchall(safeString()); // open shape — extractor can add keys as patterns emerge

// All closed-shape categories use `.strict()` so unknown keys (including the
// banned-by-spec ones like `name`, `email`, `exact_age`) are HARD-rejected
// rather than silently stripped. Only `physical` stays open via `.catchall`
// because the spec explicitly allows the extractor to add new physical keys
// as patterns emerge.
export const HouseholdMemberSchema = z
  .object({
    // `ref` is the identifier-free handle. Names are NEVER stored.
    ref: z
      .string()
      .regex(/^(child|partner|parent|sibling|roommate|pet)(?:_\d+)?$/, {
        message: "household.ref must be e.g. 'child_1', 'partner', 'parent_1'",
      }),
    relation: z.enum(["child", "partner", "parent", "sibling", "roommate", "pet"]),
    age_band: z
      .enum(["0-2", "3-5", "6-9", "10-12", "13-17", "18-25", "26-40", "41-60", "61+"])
      .optional(),
    interests: safeStringArray().optional(),
    preferences: safeStringArray().optional(),
  })
  .strict();

export const PreferencesSchema = z
  .object({
    shopping: safeStringArray().optional(),
    tone: z.enum(["concise", "warm", "playful", "formal", "professional"]).optional(),
    diet: safeStringArray().optional(),
    brands_liked: safeStringArray().optional(),
    brands_avoided: safeStringArray().optional(),
  })
  .strict();

// EXPLICITLY BANNED keys per §B1 — Zod refuses these on write.
const PROFESSIONAL_BANNED_KEYS = [
  "employer",
  "employer_name",
  "company",
  "salary",
  "title",
  "name",
  "email",
] as const;

export const ProfessionalSchema = z
  .object({
    role_band: z
      .enum([
        "student",
        "junior_ic",
        "senior_ic",
        "lead",
        "manager",
        "director",
        "exec",
        "founder",
        "retired",
      ])
      .optional(),
    industry: safeString().optional(),
    domains: safeStringArray().optional(),
  })
  .strict() // refuse unknown keys outright
  .superRefine((val, ctx) => {
    for (const banned of PROFESSIONAL_BANNED_KEYS) {
      if (banned in (val as Record<string, unknown>)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `professional.${banned} is forbidden by spec §B1 (privacy)`,
          path: [banned],
        });
      }
    }
  });

export const WellnessSchema = z
  .object({
    sleep_pattern: safeString().optional(),
    activity_level: safeString().optional(),
    focus_areas: safeStringArray().optional(),
  })
  .strict();

export const TransientSchema = z
  .object({
    current_focus: safeString().optional(),
    expires_at: z.string().datetime().optional(),
  })
  .strict();

// Embeddings: 384-dim from bge-small-en-v1.5. Number-only arrays — they don't
// pass through prompt assembly, so no injection risk; size-bounded to catch
// shape regressions.
const CategoryEmbeddingSchema = z.array(z.number()).length(384);

/**
 * Source-typed reference to whatever memory artifact contributed a trait.
 *
 * Phase 2.7 only emits `kind: 'memory'` (memory_nodes.id), but the shape is
 * pre-widened so Phase 3's behavioural ingestion (browsing signal, calendar,
 * email metadata) can feed the same extractor without a schema migration.
 * See docs/09 §5 forward-compat note 1.
 */
export const SourceRefSchema = z.object({
  kind: z.enum(["memory", "signal", "calendar", "contact", "email_meta"]),
  id: z.string().uuid(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

// ─── TraitSheet root ────────────────────────────────────────────────────────

/**
 * Per-category provenance + freshness metadata. Originally added in task #24
 * for cross-night carry-forward at the category granularity. Task #28 moved
 * the source-of-truth for freshness down to `trait_meta` (per-leaf), but we
 * keep `CategoryMetaSchema` exported and `category_meta` accepted on read
 * for backward compatibility with sheets written by the v1 extractor —
 * task-#28 migration treats a v1 `category_meta[cat].last_seen_at` as the
 * implicit `last_seen_at` for every leaf trait inside that category.
 */
export const CategoryMetaSchema = z.object({
  last_seen_at: z.string().datetime(),
  source_memory_ids: z.array(SourceRefSchema).max(500).default([]),
});
export type CategoryMeta = z.infer<typeof CategoryMetaSchema>;

/**
 * Per-trait (leaf) provenance + freshness metadata. Spec §B9 talks about
 * decay at the trait level — "a trait whose source memories haven't been
 * touched in 90 days drops out". Task #28 implements that:
 *
 * - `last_seen_at` is refreshed to "now" whenever the leaf trait is freshly
 *   extracted OR re-confirmed by an in-window memory whose embedding is
 *   within 0.4 cosine of the prior PER-TRAIT embedding.
 * - `source_memory_ids` is the per-leaf union of memory refs that have ever
 *   contributed to or re-confirmed this leaf. Extended (not re-created) on
 *   re-confirmation.
 *
 * Trait-path keys within a category:
 *   - physical / preferences / professional / wellness / transient → the
 *     top-level field name (e.g. "diet", "tone", "role_band").
 *   - household → the member `ref` (e.g. "child_1", "partner").
 */
export const TraitMetaSchema = z.object({
  last_seen_at: z.string().datetime(),
  source_memory_ids: z.array(SourceRefSchema).max(500).default([]),
});
export type TraitMeta = z.infer<typeof TraitMetaSchema>;

export const TraitSheetSchema = z.object({
  schema_version: z.literal(1),
  derived_at: z.string().datetime(),
  source_memory_ids: z.array(SourceRefSchema).max(2000),
  // `.strict()` so a top-level "name" / "email" / unknown category key is
  // hard-rejected by the validator instead of silently dropped.
  categories: z
    .object({
      physical: PhysicalSchema.optional(),
      household: z.array(HouseholdMemberSchema).max(20).optional(),
      preferences: PreferencesSchema.optional(),
      professional: ProfessionalSchema.optional(),
      wellness: WellnessSchema.optional(),
      transient: TransientSchema.optional(),
    })
    .strict(),
  category_embeddings: z.record(z.string(), CategoryEmbeddingSchema),
  // v1 (task #24) per-category meta. Optional and only consulted on read as
  // a migration fallback — task #28 writes `trait_meta` instead.
  category_meta: z.record(z.string(), CategoryMetaSchema).optional(),
  // task #28: per-leaf freshness map. Outer key = category, inner key =
  // trait path within that category. Optional for backward compatibility.
  trait_meta: z
    .record(z.string(), z.record(z.string(), TraitMetaSchema))
    .optional(),
  // task #28: per-leaf embedding for trait-level re-confirmation on the next
  // run. Outer key = category, inner key = trait path. Optional — sheets
  // written before #28 don't carry these and re-confirm is skipped (carry
  // forward by age only) until the next fresh extraction populates them.
  trait_embeddings: z
    .record(z.string(), z.record(z.string(), CategoryEmbeddingSchema))
    .optional(),
});

export type TraitSheet = z.infer<typeof TraitSheetSchema>;
export type TraitCategory = keyof TraitSheet["categories"];

// The list is duplicated as a value (not just a type) so the broker, settings
// UI, and tests can iterate categories without poking at Zod internals.
export const TRAIT_CATEGORIES: readonly TraitCategory[] = [
  "physical",
  "household",
  "preferences",
  "professional",
  "wellness",
  "transient",
] as const;

/**
 * Per-category schema lookup for the extractor's Day-2 per-category validation
 * path. Each value validates the SHAPE of one category in isolation — the
 * extractor calls these on every Llama patch before merging it into the
 * candidate sheet, so one bad category doesn't roll back the others.
 *
 * Note `household` validates the FULL ARRAY (max 20 members), not a single
 * member, because that's what the extractor receives back as a category patch.
 */
export const CATEGORY_PATCH_SCHEMAS = {
  physical: PhysicalSchema,
  household: z.array(HouseholdMemberSchema).max(20),
  preferences: PreferencesSchema,
  professional: ProfessionalSchema,
  wellness: WellnessSchema,
  transient: TransientSchema,
} as const satisfies Record<TraitCategory, z.ZodTypeAny>;

/**
 * Tier-tie-break order from spec §B3 — used when more than K categories pass
 * the cosine threshold and we have to pick which ones to keep.
 * Higher = preferred to keep.
 */
export const CATEGORY_TIE_BREAK_ORDER: Record<TraitCategory, number> = {
  physical: 6,
  preferences: 5,
  professional: 4,
  household: 3,
  wellness: 2,
  transient: 1,
};

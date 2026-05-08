/**
 * Synthetic user fixture for the leak suite — see docs/06 §9.
 *
 * Aarav Mehta is the canonical test subject: 38, lives in Bangalore, works at
 * Stripe, has child Ishaan (8) who plays football, partner Priya. Email
 * aarav@stripe.com. Phone +91 9876543210.
 *
 * The PII set is everything that MUST NEVER appear in an assembled fragment
 * for any badge × tier combination. The leak suite asserts zero overlap.
 *
 * The trait sheet itself is HAND-CRAFTED to be schema-valid — i.e. it does
 * NOT contain the raw PII. The fixture pairs the schema-valid sheet with the
 * PII set so we can verify "the broker built from a clean sheet doesn't
 * accidentally re-introduce PII via fragment assembly".
 */
import type { TraitSheet } from "@/server/trait-schema";

// ─── PII set ────────────────────────────────────────────────────────────────
//
// Substrings that, if found in any assembled fragment, indicate a leak.
// Both raw forms and lowercased variants are checked.

export const AARAV_PII_LITERALS = [
  // Names — explicit identifiers
  "Aarav",
  "Mehta",
  "Aarav Mehta",
  "Ishaan",
  "Priya",
  // Email
  "aarav@stripe.com",
  // Phone (with and without spaces / dashes)
  "+91 9876543210",
  "+919876543210",
  "9876543210",
  // Employer
  "Stripe",
  // Exact age / DOB-ish
  "38 years old",
  "age 38",
  "I am 38",
  // Address fragments
  "Bangalore",
  "Indiranagar",
  "560038",
] as const;

/** Literal lowercase substrings to scan a fragment for. */
export const AARAV_PII_LOWERCASE = AARAV_PII_LITERALS.map((s) => s.toLowerCase());

// ─── Trait sheet (schema-valid, identifier-free by construction) ────────────

const ZERO_EMBEDDING = (): number[] => {
  // Deterministic mock embedding — small varying values per category so the
  // cosine ranker has something to distinguish on. The actual content of the
  // sheet is what the leak suite scans.
  const out = new Array<number>(384);
  for (let i = 0; i < 384; i++) out[i] = (i % 7) / 13;
  return out;
};

function categoryEmbedding(seed: number): number[] {
  // Stable per-category embedding: rotation of the base vector by `seed`.
  const base = ZERO_EMBEDDING();
  return base.map((v, i) => v + Math.sin((i + seed) * 0.13) * 0.1);
}

export const AARAV_TRAIT_SHEET: TraitSheet = {
  schema_version: 1,
  derived_at: "2026-05-01T00:00:00.000Z",
  source_memory_ids: [],
  categories: {
    physical: {
      hair: "short, straight, dark",
      skin: "light brown, sensitive to sun",
      build: "average build, slim shoulders",
    },
    household: [
      {
        ref: "child_1",
        relation: "child",
        age_band: "6-9",
        interests: ["football", "lego", "cartoons"],
      },
      {
        ref: "partner",
        relation: "partner",
        age_band: "26-40",
        interests: ["yoga", "cooking"],
      },
    ],
    preferences: {
      shopping: ["minimalist", "brand-loyal"],
      tone: "concise",
      diet: ["vegetarian", "no eggs"],
      brands_liked: ["Apple", "Muji", "Uniqlo"],
      brands_avoided: ["fast-fashion in general"],
    },
    professional: {
      role_band: "senior_ic",
      industry: "fintech",
      domains: ["payments", "developer tools"],
    },
    wellness: {
      sleep_pattern: "7-8 hours, late riser",
      activity_level: "moderate, 3x weekly",
      focus_areas: ["lower back mobility", "stress management"],
    },
    transient: {
      current_focus: "preparing a Q2 product launch",
    },
  },
  category_embeddings: {
    physical: categoryEmbedding(1),
    household: categoryEmbedding(2),
    preferences: categoryEmbedding(3),
    professional: categoryEmbedding(4),
    wellness: categoryEmbedding(5),
    transient: categoryEmbedding(6),
  },
};

/** Known names list as the user would have imported it. */
export const AARAV_KNOWN_NAMES: string[] = [
  "Aarav",
  "Mehta",
  "Aarav Mehta",
  "Ishaan",
  "Priya",
];

/** PII overlap scanner. Returns the first literal it finds, or null. */
export function findPiiLeak(fragment: string): string | null {
  if (!fragment) return null;
  const lower = fragment.toLowerCase();
  for (let i = 0; i < AARAV_PII_LOWERCASE.length; i++) {
    if (lower.includes(AARAV_PII_LOWERCASE[i])) return AARAV_PII_LITERALS[i];
  }
  return null;
}

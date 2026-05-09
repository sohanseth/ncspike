/**
 * Nightly trait sheet extractor. Spec: docs/06 §B2.
 *
 * Distils the user's recent memory into the canonical trait sheet via
 * Cloudflare Workers AI Llama 3.1 8B (T0 — never leaves the platform).
 *
 * Pipeline (per user, per night):
 *   1. read memory_nodes from the last 30 days
 *   2. for each closed-shape category, prompt Llama for a JSON patch
 *   3. Zod-validate each patch; on failure log extraction_failures + skip
 *   4. compute bge-small-en embedding per non-empty category
 *   5. upsert user_traits (PK on user_id, version bump in-row per spec §B0)
 *
 * Decay: spec calls for a 90-day source_memory_ids decay rule. v1 implements
 * decay implicitly — the LLM only sees the last 30 days of memory, so anything
 * that hasn't reappeared in that window naturally drops out at re-extraction.
 * The 90-day window matters once we add cross-night carry-forward of the prior
 * sheet's traits (Phase 3); for v1's full-regeneration model it's a no-op.
 *
 * Gating: extraction is a no-op unless `user_settings.personalization_v1_enabled`
 * is true (B11 rollout flag — defaults to false on existing users so we don't
 * surprise anyone with new behaviour).
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { cloudflareProvider, embedTexts } from "@/server/inference/cloudflare";
import {
  CATEGORY_PATCH_SCHEMAS,
  TRAIT_CATEGORIES,
  TraitSheetSchema,
  type CategoryMeta,
  type SourceRef,
  type TraitCategory,
  type TraitSheet,
} from "@/lib/trait-schema";
import { scrub } from "@/server/pii-scrub";

const MEMORY_WINDOW_DAYS = 30;
const MAX_MEMORY_NODES = 400; // truncate input to keep prompts under the budget
const MAX_PATCH_TOKENS = 600;
// Spec §B9: a trait whose source memories haven't been touched (read,
// updated, or re-confirmed by similar new memory) in 90 days drops out of
// the next sheet version.
const TRAIT_DECAY_DAYS = 90;
// Spec §B9: "Re-confirmed" means a new in-window memory embeds within 0.4
// cosine of the existing trait's source memories. We compare against the
// prior category embedding as the per-category proxy for that signal.
const RECONFIRM_COSINE_FLOOR = 0.4;
// Cap on how many memory nodes we embed for re-confirmation. Embedding the
// full window (up to MAX_MEMORY_NODES = 400) per user per night would blow
// our embedding budget; the most-recent 100 is more than enough signal.
const MAX_MEMORY_FOR_RECONFIRM = 100;
// Per-category source_memory_ids cap — matches CategoryMetaSchema.max(500).
const MAX_PER_CATEGORY_SOURCES = 500;

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
    | "blocked_by_user_setting"
    | "no_categories_extracted";
  /** Version that was written (or, on rollback, the version that was kept). */
  version: number;
};

// ─── 1. Memory load ─────────────────────────────────────────────────────────

type MemoryNode = {
  id: string;
  node_type: string;
  label: string;
  data: unknown;
  created_at: string;
};

async function loadRecentMemory(userId: string): Promise<MemoryNode[]> {
  const since = new Date(Date.now() - MEMORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await (supabaseAdmin as any)
    .from("memory_nodes")
    .select("id, node_type, label, data, created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_MEMORY_NODES);
  if (error) throw new Error(`memory_nodes load failed: ${error.message}`);
  return (data ?? []) as MemoryNode[];
}

// ─── 2. Prompt construction ─────────────────────────────────────────────────

/**
 * Per-category Zod-shape examples shown to Llama. Kept tight because Llama 8B
 * follows JSON schemas best when the example fits in ~150 tokens.
 *
 * IMPORTANT: every example is identifier-free. The model will pattern-match
 * what it's shown, so showing it `{name: "Alice"}` here would teach it to
 * return names. Defence in depth on top of the Zod `.strict()` rejection.
 */
const CATEGORY_PROMPT_SCHEMAS: Record<TraitCategory, string> = {
  physical: `{"hair":"long, grey","scalp":"dry","skin":"sensitive","build":"petite","mobility":"good"}  // open shape — add keys as patterns emerge. Strings ≤80 chars, single-line. NEVER include exact measurements or photos.`,
  household: `[{"ref":"child_1","relation":"child","age_band":"6-9","interests":["football","Lego"]},{"ref":"partner","relation":"partner","preferences":["vegetarian"]}]  // ref MUST be e.g. child_1 / partner / parent_1. NEVER a name. age_band one of: 0-2,3-5,6-9,10-12,13-17,18-25,26-40,41-60,61+`,
  preferences: `{"shopping":["sustainable","mid-range"],"tone":"warm","diet":["vegetarian"],"brands_liked":["Patagonia"],"brands_avoided":[]}  // tone one of: concise, warm, playful, formal, professional`,
  professional: `{"role_band":"senior_ic","industry":"software","domains":["fintech","mobile"]}  // role_band one of: student, junior_ic, senior_ic, lead, manager, director, exec, founder, retired. NEVER include employer name, title, salary, or any company name.`,
  wellness: `{"sleep_pattern":"7-8 hours","activity_level":"moderate","focus_areas":["stress management","strength training"]}`,
  transient: `{"current_focus":"job search","expires_at":"2026-06-01T00:00:00Z"}  // expires_at ISO datetime when this focus is no longer relevant`,
};

/**
 * Build the per-category prompt. We feed Llama:
 *   1. an explicit "JSON only, no prose" instruction
 *   2. the exact schema example for this category
 *   3. the user's last-30-days memory as a compact list of `[type] label` lines
 *   4. an instruction to return `{}` (or `[]` for household) when there's no
 *      evidence in the memory for this category — explicit empty beats the
 *      model hallucinating a shape just to avoid an empty response
 */
function buildPrompt(category: TraitCategory, memory: MemoryNode[]): string {
  const memoryLines = memory
    .map((n) => `[${n.node_type}] ${n.label}`)
    .slice(0, MAX_MEMORY_NODES)
    .join("\n");
  const emptyShape = category === "household" ? "[]" : "{}";
  return [
    `You are a privacy-respecting personal-context extractor.`,
    `Read the user's recent activity and produce ONLY a JSON value matching this exact shape for the category "${category}":`,
    ``,
    CATEGORY_PROMPT_SCHEMAS[category],
    ``,
    `Rules:`,
    `- Output JSON only — no prose, no markdown, no code fences.`,
    `- Never invent personal identifiers (names, email, phone, exact age, employer, salary, address).`,
    `- If the activity contains no evidence for this category, output exactly: ${emptyShape}`,
    `- Strings must be ≤80 chars and single-line.`,
    ``,
    `Recent activity (last ${MEMORY_WINDOW_DAYS} days):`,
    memoryLines || "(no activity recorded)",
  ].join("\n");
}

// ─── 3. LLM call + JSON parse ───────────────────────────────────────────────

/**
 * Quote/escape-aware JSON span finder. Returns the [start, end] inclusive
 * indices of the first balanced `{...}` or `[...]` value in `s`, or null if
 * none. Crucially, brackets and braces inside JSON string literals don't
 * affect depth — that was the bug in the naive implementation.
 *
 * Handles: backslash-escapes inside strings, nested objects/arrays, and the
 * common Llama pattern of surrounding-prose-then-JSON-value.
 */
function findJsonSpan(s: string, opener: "{" | "["): { start: number; end: number } | null {
  const closer = opener === "{" ? "}" : "]";
  const start = s.indexOf(opener);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escapeNext = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer) {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

/**
 * Call Llama with the per-category prompt, parse the response.
 *
 * Tolerant JSON parser: Llama 8B occasionally wraps output in ```json fences
 * or surrounds the value with prose even when told not to. We strip fences,
 * then locate the first balanced JSON span using a quote/escape-aware walker.
 * Anything that fails to parse is treated as a no-response (logged by caller).
 */
async function extractCategoryPatch(
  category: TraitCategory,
  memory: MemoryNode[],
): Promise<unknown | null> {
  const prompt = buildPrompt(category, memory);
  let raw: string;
  try {
    const result = await cloudflareProvider.generate({
      messages: [{ role: "user", content: prompt }],
      maxTokens: MAX_PATCH_TOKENS,
      temperature: 0.2,
    });
    raw = result.text.trim();
  } catch {
    return null;
  }

  // Strip code fences if present.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) raw = fenced[1].trim();

  const opener = category === "household" ? "[" : "{";
  const span = findJsonSpan(raw, opener);
  if (!span) return null;
  try {
    return JSON.parse(raw.slice(span.start, span.end + 1));
  } catch {
    return null;
  }
}

/**
 * Recursively walk a category patch and collect every string value (leaf or
 * inside arrays/objects). Used by `scrubCategoryPatch` to run defense-in-depth
 * PII checks against extracted strings before writing them into the sheet.
 */
function* iterStrings(val: unknown): Generator<string> {
  if (typeof val === "string") {
    yield val;
    return;
  }
  if (Array.isArray(val)) {
    for (const v of val) yield* iterStrings(v);
    return;
  }
  if (val && typeof val === "object") {
    for (const v of Object.values(val as Record<string, unknown>)) yield* iterStrings(v);
  }
}

/**
 * Defense-in-depth scrub for an individual category patch. Even though
 * trait-schema.ts already rejects sentinels and bans identifier keys at the
 * Zod layer, we re-scan extracted string values with the full B5 pattern
 * set here. If ANY string in the patch trips the scrub, we drop the whole
 * category — partial keep is unsafe because the leaked PII might be the
 * key signal binding the rest of the category together.
 *
 * Returns the scrub result so the caller can route it to extraction_failures
 * with the right `failure_class` (`injection_pattern` for sentinel hits, or
 * a synthesized `injection_pattern` row for any other class — extraction-time
 * scrub hits are always logged as injection_pattern because the table's
 * failure_class enum doesn't carry the full scrub taxonomy).
 */
function scrubCategoryPatch(patch: unknown): { ok: boolean; pattern?: string } {
  for (const s of iterStrings(patch)) {
    const r = scrub({ fragment: s });
    if (!r.ok) return { ok: false, pattern: r.pattern_class };
  }
  return { ok: true };
}

/**
 * True if a category patch is "explicitly empty" — i.e. the model correctly
 * signalled "no evidence for this category" and we should skip it without
 * logging an extraction failure.
 *
 * Treats both `{}` and `[]` as empty for any category, because Llama 8B
 * sometimes returns the wrong empty shape (e.g. `{}` for household). Bug from
 * the v1 implementation: only `[]` was empty for household, so a `{}`
 * household reply would fall through, fail Zod, and roll back the entire run.
 */
function isExplicitlyEmpty(patch: unknown): boolean {
  if (Array.isArray(patch)) return patch.length === 0;
  if (patch && typeof patch === "object") {
    return Object.keys(patch as Record<string, unknown>).length === 0;
  }
  return false;
}

// ─── 4. Audit logging ───────────────────────────────────────────────────────

async function logExtractionFailure(
  userId: string,
  category: TraitCategory | null,
  failureClass: "zod_reject" | "llm_no_response" | "embedding_failed" | "injection_pattern",
  fieldPath: string | null = null,
): Promise<void> {
  try {
    await (supabaseAdmin as any).from("extraction_failures").insert({
      user_id: userId,
      category,
      failure_class: failureClass,
      field_path: fieldPath,
    });
  } catch (e) {
    // never let an audit-write failure break extraction
    console.warn(`[trait-extraction] audit write failed for ${userId}:`, e);
  }
}

// ─── 5. Embedding text per category ─────────────────────────────────────────

/**
 * Serialize a category's content to a string for bge-small embedding.
 *
 * Goal: produce text that semantically represents the category so that the
 * broker's request-time cosine ranking can match a user's query against it.
 * "tone:warm; shopping:sustainable, mid-range; diet:vegetarian" is what we
 * want — a flat, key-rich, compact summary. NOT raw JSON (curly braces and
 * quotes drag the embedding toward "json document" rather than meaning).
 */
function categoryToEmbeddingText(category: TraitCategory, content: unknown): string {
  if (content == null) return category;
  const flatten = (val: unknown, prefix = ""): string[] => {
    if (val == null) return [];
    if (Array.isArray(val)) {
      return val.flatMap((v, i) => flatten(v, `${prefix}[${i}]`));
    }
    if (typeof val === "object") {
      return Object.entries(val as Record<string, unknown>).flatMap(([k, v]) =>
        flatten(v, prefix ? `${prefix}.${k}` : k),
      );
    }
    return [`${prefix}:${String(val)}`];
  };
  const parts = flatten(content);
  return `${category}; ${parts.join("; ")}`.slice(0, 1500);
}

// ─── 6. Carry-forward helpers (spec §B9) ────────────────────────────────────

function cosineSim(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  return denom === 0 ? 0 : dot / denom;
}

/** Stable union of SourceRef arrays, deduped on `${kind}:${id}`. */
function mergeSources(...lists: readonly SourceRef[][]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const list of lists) {
    for (const r of list) {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

// ─── 7. Main entry ──────────────────────────────────────────────────────────

export async function runTraitExtractionForUserId(userId: string): Promise<ExtractionResult> {
  // Gate on rollout flag.
  const { data: settings } = await (supabaseAdmin as any)
    .from("user_settings")
    .select("personalization_v1_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (!settings?.personalization_v1_enabled) {
    return { written: false, reason: "blocked_by_user_setting", version: 0 };
  }

  // Load existing sheet (full row — needed for spec §B9 carry-forward).
  const { data: existing } = await (supabaseAdmin as any)
    .from("user_traits")
    .select("version, sheet")
    .eq("user_id", userId)
    .maybeSingle();
  const nextVersion = (existing?.version ?? 0) + 1;
  const priorSheet = (existing?.sheet ?? null) as TraitSheet | null;
  const priorCats = (priorSheet?.categories ?? {}) as Partial<TraitSheet["categories"]>;
  const priorEmbeds = (priorSheet?.category_embeddings ?? {}) as Record<string, number[]>;
  const priorMeta = (priorSheet?.category_meta ?? {}) as Record<string, CategoryMeta>;

  // Load 30-day memory.
  const memory = await loadRecentMemory(userId);
  // Spec §B9: even on a "silent night" (no new memory in the 30-day window),
  // we must still age out prior categories whose `last_seen_at` exceeds the
  // 90-day decay window — otherwise stale traits persist forever for any user
  // who goes quiet. We only short-circuit when there's NOTHING to do: no new
  // memory AND no prior sheet to potentially decay.
  if (memory.length === 0 && !priorSheet) {
    return { written: false, reason: "no_new_memory", version: existing?.version ?? 0 };
  }
  const memoryRefs: SourceRef[] = memory.map((n) => ({ kind: "memory" as const, id: n.id }));

  // Per-category extraction with per-category Zod validation BEFORE merge.
  // Architect-required (Day-2 review): one bad category must not roll back
  // the others. The final TraitSheetSchema.safeParse remains as a guard
  // against the assembled-shape ever drifting from per-category shape.
  //
  // Silent-night skip: if there's no in-window memory, there is by definition
  // nothing for the LLM to extract. Skipping the loop avoids 6 wasted LLM
  // calls per silent night per user, and the carry-forward / decay block
  // below still runs against the prior sheet.
  const categories: Partial<TraitSheet["categories"]> = {};
  const newlyExtracted = new Set<TraitCategory>();
  for (const cat of memory.length === 0 ? [] : TRAIT_CATEGORIES) {
    const patch = await extractCategoryPatch(cat, memory);
    if (patch == null) {
      await logExtractionFailure(userId, cat, "llm_no_response");
      continue;
    }
    if (isExplicitlyEmpty(patch)) continue;
    const perCat = CATEGORY_PATCH_SCHEMAS[cat].safeParse(patch);
    if (!perCat.success) {
      for (const issue of perCat.error.issues) {
        await logExtractionFailure(userId, cat, "zod_reject", issue.path.join("."));
      }
      continue; // skip this category, keep the rest
    }
    // Day-3 defense-in-depth: re-scan validated strings against the full B5
    // pattern set. Catches anything that slipped past the Zod refines (e.g.
    // an email or phone number that didn't trip the injection-sentinel list
    // because it contained no role markers).
    const scrubResult = scrubCategoryPatch(perCat.data);
    if (!scrubResult.ok) {
      await logExtractionFailure(userId, cat, "injection_pattern", scrubResult.pattern ?? null);
      continue;
    }
    (categories as Record<string, unknown>)[cat] = perCat.data;
    newlyExtracted.add(cat);
  }

  // Embed each newly-extracted category. Carried-forward categories reuse
  // their prior embedding, so we don't re-embed them.
  const newCatKeys = Array.from(newlyExtracted);
  let newEmbeddings: number[][] = [];
  if (newCatKeys.length > 0) {
    try {
      newEmbeddings = await embedTexts(
        newCatKeys.map((k) =>
          categoryToEmbeddingText(k, (categories as Record<string, unknown>)[k]),
        ),
      );
    } catch {
      for (const cat of newCatKeys) {
        await logExtractionFailure(userId, cat, "embedding_failed");
      }
      return { written: false, reason: "embedding_failed", version: existing?.version ?? 0 };
    }
  }
  const category_embeddings: Record<string, number[]> = {};
  newCatKeys.forEach((k, i) => {
    category_embeddings[k] = newEmbeddings[i];
  });

  // ─── Spec §B9 carry-forward ──────────────────────────────────────────────
  //
  // Without this, a user who mentions "I'm vegetarian" in March and not again
  // until June has the trait silently wiped on day 31 because we only see the
  // last 30 days of memory. Carry-forward keeps prior categories alive across
  // nights up to the 90-day decay window, and re-confirmation refreshes the
  // window when a new in-window memory is semantically similar.
  const nowIso = new Date().toISOString();
  const newCategoryMeta: Record<string, CategoryMeta> = {};

  // Step 1: For each freshly-extracted category, mark fresh and EXTEND
  // (not replace) any prior per-category source_memory_ids. This is the
  // spec §B9 "re-confirmed extends, not re-creates" rule applied to the
  // case where a freshly-extracted category overlaps a prior one.
  for (const cat of newlyExtracted) {
    const priorSources = priorMeta[cat]?.source_memory_ids ?? [];
    newCategoryMeta[cat] = {
      last_seen_at: nowIso,
      source_memory_ids: mergeSources(priorSources, memoryRefs).slice(
        0,
        MAX_PER_CATEGORY_SOURCES,
      ),
    };
  }

  // Step 2: For each prior category NOT freshly extracted, decide whether to
  // carry it forward. Re-confirm via cosine ≥ 0.4 against new memory; else
  // age-decay at 90 days from last_seen_at.
  const priorCatKeys = Object.keys(priorCats) as TraitCategory[];
  const carryForwardCandidates = priorCatKeys.filter(
    (cat) => !newlyExtracted.has(cat) && priorCats[cat] != null,
  );

  // Embed new memory for re-confirmation (one batched call). Only if there
  // are categories we might carry forward — skip the API hit otherwise.
  let memoryEmbeddings: number[][] = [];
  if (carryForwardCandidates.length > 0) {
    const memoryToEmbed = memory.slice(0, MAX_MEMORY_FOR_RECONFIRM);
    try {
      memoryEmbeddings = await embedTexts(
        memoryToEmbed.map((n) => `[${n.node_type}] ${n.label}`),
      );
    } catch {
      // Soft-fail: without memory embeddings, we can't re-confirm by cosine,
      // but age-based carry-forward still applies. Don't roll back the run.
      memoryEmbeddings = [];
    }
  }

  for (const cat of carryForwardCandidates) {
    const priorContent = priorCats[cat];
    const priorEmbedding = priorEmbeds[cat];
    const meta = priorMeta[cat];
    const lastSeenStr = meta?.last_seen_at ?? priorSheet!.derived_at;
    const ageMs = Date.now() - Date.parse(lastSeenStr);
    const decayMs = TRAIT_DECAY_DAYS * 24 * 60 * 60 * 1000;

    // Re-confirmation check: any new memory whose embedding is within 0.4
    // cosine of the prior category embedding counts as "still relevant".
    const reconfirmingRefs: SourceRef[] = [];
    if (priorEmbedding && memoryEmbeddings.length > 0) {
      for (let i = 0; i < memoryEmbeddings.length; i++) {
        if (cosineSim(memoryEmbeddings[i], priorEmbedding) >= RECONFIRM_COSINE_FLOOR) {
          reconfirmingRefs.push(memoryRefs[i]);
        }
      }
    }
    const reconfirmed = reconfirmingRefs.length > 0;

    if (!reconfirmed && ageMs >= decayMs) {
      // Expired: drop. (Skip writing this category into the new sheet.)
      continue;
    }

    // Carry forward content + embedding from prior.
    (categories as Record<string, unknown>)[cat] = priorContent;
    if (priorEmbedding) category_embeddings[cat] = priorEmbedding;

    if (reconfirmed) {
      // Spec §B9: re-confirmed traits get source_memory_ids EXTENDED, not
      // re-created. last_seen_at refreshes the 90-day window.
      newCategoryMeta[cat] = {
        last_seen_at: nowIso,
        source_memory_ids: mergeSources(
          meta?.source_memory_ids ?? [],
          reconfirmingRefs,
        ).slice(0, MAX_PER_CATEGORY_SOURCES),
      };
    } else {
      // Within 90-day window but no re-confirmation: carry meta unchanged.
      newCategoryMeta[cat] = {
        last_seen_at: lastSeenStr,
        source_memory_ids: meta?.source_memory_ids ?? [],
      };
    }
  }

  // If carry-forward + extraction produced nothing AND there is no prior
  // sheet to decay, this is a true no-op (cold-start with no signal yet).
  // BUT if a prior sheet exists and everything in it has decayed, we MUST
  // write the resulting empty sheet — otherwise the stale prior persists in
  // user_traits and the broker keeps serving expired traits, defeating the
  // 90-day rule. Spec §B9: "drops out of the next sheet version" requires
  // an actual next sheet.
  if (Object.keys(categories).length === 0 && !priorSheet) {
    return {
      written: false,
      reason: "no_categories_extracted",
      version: existing?.version ?? 0,
    };
  }

  // Build candidate sheet.
  const sourceRefs: SourceRef[] = memoryRefs;
  const candidate: TraitSheet = {
    schema_version: 1,
    derived_at: nowIso,
    source_memory_ids: sourceRefs,
    categories,
    category_embeddings,
    category_meta: newCategoryMeta,
  };

  // Final assembled-sheet guard. Per-category validation already ran above,
  // so a failure here means a sheet-level invariant (source_memory_ids shape,
  // schema_version, derived_at) is wrong — i.e. an extractor bug, not a
  // model output bug. Map the failure precisely: only call something a
  // category failure when issue.path actually starts with "categories" or
  // "category_embeddings"; otherwise log category=null to avoid misleading
  // audit data (architect-flagged Day-2 misattribution bug).
  const validated = TraitSheetSchema.safeParse(candidate);
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      const root = issue.path[0];
      const isCategoryScoped = root === "categories" || root === "category_embeddings";
      const candidateCat = issue.path[1] as TraitCategory | undefined;
      const cat: TraitCategory | null =
        isCategoryScoped && candidateCat && TRAIT_CATEGORIES.includes(candidateCat)
          ? candidateCat
          : null;
      await logExtractionFailure(userId, cat, "zod_reject", issue.path.join("."));
    }
    return { written: false, reason: "zod_reject", version: existing?.version ?? 0 };
  }

  // Upsert. Conflict on user_id is the spec contract — one row per user, ever.
  const { error: upsertError } = await (supabaseAdmin as any)
    .from("user_traits")
    .upsert(
      {
        user_id: userId,
        version: nextVersion,
        sheet: validated.data,
        derived_at: validated.data.derived_at,
        source_count: sourceRefs.length,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (upsertError) {
    console.error(`[trait-extraction] upsert failed for ${userId}:`, upsertError);
    return { written: false, reason: "no_categories_extracted", version: existing?.version ?? 0 };
  }

  return { written: true, version: nextVersion };
}

/**
 * Cron-callable batch entry. Iterates users who have ANY recent memory_nodes
 * activity in the extraction window. Errors are isolated per-user so one bad
 * user can't poison the batch.
 */
export type ExtractionCronSummary = {
  users: number;
  written: number;
  skipped: number;
  failed: number;
  budgetExceeded: boolean;
};

/**
 * Soft per-batch wall-clock budget. Cloudflare cron triggers have a generous
 * but finite execution window. Per-user extraction is ~6 LLM calls + 1
 * embedding call ≈ 5-15s of provider time, so a 4-minute budget can comfortably
 * service ~25 users per batch even on the slow side. Larger batches will need
 * sharded cron schedules (Phase 3 problem — write a follow-up if it bites).
 */
const BATCH_TIME_BUDGET_MS = 4 * 60 * 1000;

export async function runTraitExtractionAllUsers(): Promise<ExtractionCronSummary> {
  const summary: ExtractionCronSummary = {
    users: 0,
    written: 0,
    skipped: 0,
    failed: 0,
    budgetExceeded: false,
  };
  const since = new Date(Date.now() - MEMORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const deadline = Date.now() + BATCH_TIME_BUDGET_MS;

  // Find users with recent memory activity. We pull the user_id list from
  // memory_nodes (not auth.users) so we don't run extraction on cold accounts.
  const { data, error } = await (supabaseAdmin as any)
    .from("memory_nodes")
    .select("user_id")
    .gte("created_at", since);
  if (error) {
    console.error("[trait-extraction] user-list query failed:", error);
    return summary;
  }
  const userIds = Array.from(
    new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id)),
  );
  summary.users = userIds.length;

  for (const userId of userIds) {
    if (Date.now() >= deadline) {
      summary.budgetExceeded = true;
      console.warn(
        `[trait-extraction] batch time budget exceeded; ${userIds.indexOf(userId)}/${userIds.length} users processed; remainder picked up next cron`,
      );
      break;
    }
    try {
      const r = await runTraitExtractionForUserId(userId);
      if (r.written) summary.written++;
      else summary.skipped++;
    } catch (e) {
      summary.failed++;
      console.error(`[trait-extraction] user ${userId} threw:`, e);
    }
  }

  console.log(
    `[trait-extraction] done: users=${summary.users} written=${summary.written} skipped=${summary.skipped} failed=${summary.failed} budgetExceeded=${summary.budgetExceeded}`,
  );
  return summary;
}

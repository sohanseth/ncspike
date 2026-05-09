/**
 * PII scrub — the hard floor. Spec: docs/06-spec-phase-2.7-context-broker.md §B5.
 *
 * Runs on the assembled prompt fragment AFTER the broker has built it, BEFORE
 * the request leaves the server. Defence in depth — the trait sheet should
 * already be identifier-free by construction (Zod schema), but if anything
 * leaked past the extractor + validator we catch it here.
 *
 * Behaviour on detection: caller drops the fragment to empty string; an
 * `inference_usage.error_class = 'pii_scrub_blocked'` row is written; a
 * `pii_scrub_events` row records the pattern class (NEVER the matched
 * substring — logging it would itself leak the PII we caught).
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { INJECTION_SENTINELS } from "@/lib/trait-schema";

export type ScrubPatternClass =
  | "email"
  | "phone"
  | "postal"
  | "credit_card"
  | "name_match"
  | "exact_age"
  | "gov_id"
  | "employer_heuristic"
  | "injection_sentinel"
  // Phase 2.7-bis: assembled fragment exceeded MAX_FRAGMENT_CHARS. Not a
  // PII shape per se, but reuses the same fail-closed code path so the
  // audit trail is uniform.
  | "fragment_oversize"
  // Phase 2.7-bis (B2 architect, 2026-05-09): the broker could not load the
  // user's per-trait or per-provider-tier blocklists from Supabase. Treated
  // as fail-closed (empty fragment, scrubBlocked: true) because we can't
  // honour exclusions we can't read. Audited as its own class so ops can
  // distinguish a transient DB blip from a true PII pattern hit.
  | "blocklist_unavailable";

export type ScrubResult =
  | { ok: true }
  | { ok: false; pattern_class: ScrubPatternClass };

export type ScrubArgs = {
  fragment: string;
  /** Names to redact for this user. Loaded once per request from
   *  `user_known_names`; passed in so this module stays IO-free + testable. */
  knownNames?: readonly string[];
};

// ─── Regex set ──────────────────────────────────────────────────────────────
//
// Each regex is documented with: what it catches, what it deliberately doesn't,
// and the false-positive vector we accept. The scrub is a *hard floor* — false
// positives (over-scrubbing) are far cheaper than false negatives (PII leak),
// so patterns lean conservative.

// Standard RFC-ish email. We don't try to validate every legal local-part —
// "looks like an email" is enough; if it matches, we drop the fragment.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

// Phone numbers: 7+ consecutive digit-group characters, optionally with +,
// spaces, dashes, dots, or parens. Catches E.164, US, UK, IN. Min 7 digits
// to avoid matching dates/years. Bounded total length to avoid runaway.
// Walks digits separately to enforce the digit-only count.
function detectPhone(s: string): boolean {
  const candidates = s.match(/\+?[\d][\d\s().\-]{6,20}\d/g);
  if (!candidates) return false;
  for (const c of candidates) {
    const digits = c.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) return true;
  }
  return false;
}

// Postal address heuristic. Two complementary signals — either is a hit:
//   1. UK-ish postcode (e.g. SW1A 1AA, M1 1AA, EC1A 1BB)
//   2. US-ish "<number> <Word> <street-suffix>" (e.g. "221B Baker St",
//      "1600 Pennsylvania Avenue")
// We deliberately don't try to catch ALL international addresses — those that
// slip through this heuristic should be caught by the broker NEVER putting
// memory `data` blobs through, only Zod-validated trait strings (max 80 chars,
// single line).
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const US_STREET_RE =
  /\b\d{1,6}[A-Z]?\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Square|Sq|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\b/;

// Credit card — 13-19 digits with optional spaces/dashes, validated with Luhn
// to reject coincidental digit runs (UPCs, ISBNs, phone scribbles).
function detectCreditCard(s: string): boolean {
  const candidates = s.match(/\b(?:\d[\s-]?){12,18}\d\b/g);
  if (!candidates) return false;
  for (const c of candidates) {
    const digits = c.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (luhnValid(digits)) return true;
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Exact age. Catches "I am 34", "age: 34", "34 years old", "34yo", "34 yo".
// Doesn't catch age bands ("late 30s") — those are spec-allowed in the schema.
const EXACT_AGE_RE =
  /\b(?:i\s+am\s+|age\s*[:=]\s*|aged\s+)\d{1,3}(?:\s*(?:years?\s+old|y\.?o\.?))?\b|\b\d{1,3}\s*(?:years?\s+old|y\.?o\.?)\b/i;

// Government IDs (lean but covers the four threat-modelled origins):
//   - US SSN: 123-45-6789 (with dashes — we don't try to catch the
//     dashless form because that overlaps too much with phone numbers)
//   - Singapore NRIC: S/T/F/G + 7 digits + letter
//   - India Aadhaar: 12 digits as 4-4-4 with spaces (the canonical print form)
//   - UK NHS: 3-3-4 digit grouping
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const NRIC_RE = /\b[STFG]\d{7}[A-Z]\b/;
const AADHAAR_RE = /\b\d{4}\s\d{4}\s\d{4}\b/;
const NHS_RE = /\b\d{3}\s\d{3}\s\d{4}\b/;

// Employer heuristic. Catches "works at Acme", "employed by GoldmanSachs",
// "I work for Microsoft". Requires the company name to start with a capital
// letter and be 2-30 chars to avoid matching common nouns. Spec-banned by
// trait-schema's professional category, but we double-check at fragment time.
const EMPLOYER_RE =
  /\b(?:works?\s+at|employed\s+(?:at|by)|work(?:s|ing)?\s+for)\s+[A-Z][A-Za-z0-9&.\-]{1,29}\b/;

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Scrub the assembled fragment. Returns `{ok: true}` on clean, or
 * `{ok: false, pattern_class}` on FIRST hit.
 *
 * Order is BY SPECIFICITY/CONFIDENCE, highest first — architect Day-3 fix.
 * Naive B5 §1-9 ordering would log a US SSN ("123-45-6789") as `phone` because
 * its 9 digits trip the phone regex too. We test the most-specific patterns
 * (formal IDs, Luhn-checked credit cards) before the looser heuristics so the
 * audit trail in `pii_scrub_events` reflects what actually leaked.
 *
 * Blocking behaviour is identical regardless of order — this only governs
 * which class gets logged, not whether the fragment is dropped.
 */
export function scrub({ fragment, knownNames }: ScrubArgs): ScrubResult {
  if (!fragment) return { ok: true };

  // Both haystack and known names get NFC-normalised before any matching
  // (architect Day-3 fix). Without this, a known name "Renée" stored as NFC
  // would miss a fragment containing "Rene\u0301e" (NFD), which is the exact
  // form some platforms emit (notably macOS HFS+ filenames and a number of
  // Latin-keyboard input methods).
  const normalised = fragment.normalize("NFC");

  // 1. Highest-specificity: formal government IDs.
  if (
    SSN_RE.test(normalised) ||
    NRIC_RE.test(normalised) ||
    AADHAAR_RE.test(normalised) ||
    NHS_RE.test(normalised)
  ) {
    return { ok: false, pattern_class: "gov_id" };
  }

  // 2. Luhn-validated credit card — also a formal-format check.
  if (detectCreditCard(normalised)) return { ok: false, pattern_class: "credit_card" };

  // 3. Email — rigid format, low false-positive rate.
  if (EMAIL_RE.test(normalised)) return { ok: false, pattern_class: "email" };

  // 4. Postal address — UK postcode is high-confidence, US street suffix is
  //    medium-confidence but still a defined shape.
  if (UK_POSTCODE_RE.test(normalised) || US_STREET_RE.test(normalised)) {
    return { ok: false, pattern_class: "postal" };
  }

  // 5. Phone — generic digit run, lower confidence than the above (a 9-digit
  //    SSN would have tripped here if we hadn't checked gov_id first).
  if (detectPhone(normalised)) return { ok: false, pattern_class: "phone" };

  // 6. Exact age phrase (still pretty rigid — "X years old" idioms).
  if (EXACT_AGE_RE.test(normalised)) return { ok: false, pattern_class: "exact_age" };

  // 7. Employer heuristic — looser ("works at <Cap>" pattern).
  if (EMPLOYER_RE.test(normalised)) {
    return { ok: false, pattern_class: "employer_heuristic" };
  }

  // 8. Known-name substring match. Lower priority than IDs because false-
  //    positive rate scales with the imported list size; users who import
  //    common first names will trip this often.
  if (knownNames && knownNames.length > 0) {
    const lower = normalised.toLowerCase();
    for (const raw of knownNames) {
      const name = raw.normalize("NFC").trim();
      // Skip 1-2 char "names" — too high a false-positive rate vs the
      // word-boundary check, and the regex set above already covers richer
      // identifiers. Spec allows the manual import to add anything the user
      // wants, but we still apply this floor.
      if (name.length < 3) continue;
      const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`).test(lower)) {
        return { ok: false, pattern_class: "name_match" };
      }
    }
  }

  // 9. Lowest-specificity backstop: prompt-injection sentinels. These are
  //    already enforced at the Zod layer for trait sheet strings (see
  //    trait-schema.INJECTION_SENTINELS); checking here catches anything
  //    that arrives via a different route into the assembled fragment.
  for (const re of INJECTION_SENTINELS) {
    if (re.test(normalised)) return { ok: false, pattern_class: "injection_sentinel" };
  }

  return { ok: true };
}

// ─── Audit + name-list IO helpers ───────────────────────────────────────────

/**
 * Write a `pii_scrub_events` row. Pattern class only — never the matched
 * substring (logging it would defeat the whole purpose of the scrub).
 *
 * Errors are swallowed: if the audit write fails, we still want the request
 * to continue with the empty fragment, not throw and lose the privacy guard.
 */
export async function logScrubEvent(args: {
  userId: string;
  patternClass: ScrubPatternClass;
  category?: string | null;
  badge?: string | null;
  providerTier?: number | null;
}): Promise<void> {
  try {
    await (supabaseAdmin as any).from("pii_scrub_events").insert({
      user_id: args.userId,
      category: args.category ?? null,
      pattern_class: args.patternClass,
      badge: args.badge ?? null,
      provider_tier: args.providerTier ?? null,
    });
  } catch (e) {
    console.warn(`[pii-scrub] audit write failed for ${args.userId}:`, e);
  }
}

/**
 * Load this user's known-names list for the scrub. Called once per chat
 * request from the broker, not on every scrub call (the scrub itself stays
 * IO-free for testability).
 *
 * Returns `[]` when the user hasn't run an explicit import (G7 lock —
 * we never auto-populate). The regex patterns above still cover the
 * highest-risk PII classes for unimported users.
 */
export async function loadKnownNames(userId: string): Promise<string[]> {
  const { data, error } = await (supabaseAdmin as any)
    .from("user_known_names")
    .select("name")
    .eq("user_id", userId);
  if (error) {
    console.warn(`[pii-scrub] known-names load failed for ${userId}:`, error);
    return [];
  }
  return ((data ?? []) as Array<{ name: string }>).map((r) => r.name);
}

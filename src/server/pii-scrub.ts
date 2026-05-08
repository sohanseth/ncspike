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
 *
 * Day 1: scaffold + signature. Day 3 fills in the actual regex set + the
 * `user_known_names` lookup (B5 item 5).
 */

export type ScrubPatternClass =
  | "email"
  | "phone"
  | "postal"
  | "credit_card"
  | "name_match"
  | "exact_age"
  | "gov_id"
  | "employer_heuristic"
  | "injection_sentinel";

export type ScrubResult =
  | { ok: true }
  | { ok: false; pattern_class: ScrubPatternClass };

export type ScrubArgs = {
  fragment: string;
  /** Names to redact for this user. Loaded once per request from
   *  `user_known_names`; passed in so this module stays IO-free + testable. */
  knownNames?: readonly string[];
};

/**
 * Day 1 stub. Always passes.
 *
 * Day 3 implementation will check (in order, returning on first hit):
 *   1. Email regex
 *   2. Phone regex (E.164, US, UK, IN)
 *   3. Postal address heuristic
 *   4. Credit card (Luhn-checked)
 *   5. user_known_names case-insensitive substring match
 *   6. Exact-age pattern
 *   7. Gov ID patterns (SSN, NRIC, Aadhaar, NHS)
 *   8. Employer-name heuristic ("works at <CapWord>")
 *   9. Prompt-injection sentinel (defence-in-depth vs trait-schema)
 */
export function scrub(_args: ScrubArgs): ScrubResult {
  return { ok: true };
}

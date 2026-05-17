/**
 * Phase 3.0 agent runtime — error-message scrubber.
 *
 * **The invariant (docs/16 §15.1 + §22 #3):** no user content (email
 * subjects, search queries, finding payloads, prompt fragments, URLs)
 * ever reaches `agent_runs.error` or structured logs. Errors thrown
 * mid-run get caught by the runner and run through this helper before
 * persistence.
 *
 * Different shape from `src/server/pii-scrub.ts:scrub` — that function
 * is a fragment validator (returns pass/fail verdict for the broker's
 * assembled prompt). This one is a string-in / string-out **redactor**
 * for free-form error messages, designed for the "best-effort scrub +
 * truncate" path. Wrong fit to reuse.
 *
 * What gets stripped (replaced with `[REDACTED]`):
 *   - Anything between single or double quotes (covers the common case
 *     of LLM-thrown errors that quote the offending input: `"the
 *     request 'find me articles about <topic>' failed"`)
 *   - URLs (http(s)://...)
 *   - Email addresses
 *   - Phone-number-shaped digit runs
 *   - Long digit sequences (CC numbers, gov IDs)
 *
 * What is kept (these are safe and useful for debugging):
 *   - Exception class names, error codes
 *   - HTTP status codes ("502", "rate_limited")
 *   - Provider names ("openai", "groq")
 *   - Stack-trace-shaped tokens (file:line — covered by quote stripping
 *     in most cases anyway)
 *
 * Output is capped at 500 chars (matches `agent_runs.error` documented
 * width). Truncation is hard cut, not ellipsis — adversarial fixtures
 * shouldn't be able to use a "..." suffix as a marker.
 */

const QUOTED_RE = /(['"])(?:\\.|(?!\1).)*?\1/g;
const URL_RE = /\bhttps?:\/\/[^\s)>'"]+/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// 7+ consecutive digits with optional separators — catches phones, CCs,
// long IDs. Won't catch short numerics (status codes, depth counters).
const LONG_DIGITS_RE = /\b[\d][\d\s\-.]{6,}[\d]\b/g;

const MAX_LEN = 500;
const REDACTED = "[REDACTED]";

/**
 * Returns a PII-scrubbed, truncated form of `raw`. Always returns a
 * string (never null or undefined) so callers can assign to a `text |
 * null` column without conditional logic.
 *
 * Order: quotes → URLs → emails → long digits. Quotes go first because
 * a quoted email or URL should not show up at all (the redactor would
 * otherwise leave the surrounding quotes as a hint that there was a
 * value here).
 */
export function scrubErrorMessage(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = typeof raw === "string" ? raw : String(raw);
  let out = s;
  out = out.replace(QUOTED_RE, REDACTED);
  out = out.replace(URL_RE, REDACTED);
  out = out.replace(EMAIL_RE, REDACTED);
  out = out.replace(LONG_DIGITS_RE, REDACTED);
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN);
  return out;
}

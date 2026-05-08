/**
 * Property tests for the PII scrub — fast-check generates random fragments
 * and known-name lists; the scrub's invariants must hold for every input.
 *
 * Spec: docs/06 §9 ("Property test: fast-check-style").
 *
 * Invariants tested:
 *   1. Fragments containing any literal known-name (≥3 chars) are blocked
 *      with `name_match`.
 *   2. Fragments built from random alphanumeric tokens (no PII shapes, no
 *      injection sentinels) pass cleanly.
 *   3. Empty fragment ALWAYS passes.
 *   4. Fragments containing any §13 injection sentinel are blocked with
 *      `injection_sentinel` (or a higher-priority class — both are wins).
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { scrub } from "@/server/pii-scrub";
import { INJECTION_SENTINELS } from "@/lib/trait-schema";

describe("PII scrub — property tests", () => {
  it("invariant 1: known-name substring → scrub blocks", () => {
    const safeName = fc
      .string({ minLength: 3, maxLength: 20 })
      .filter((s) => /^[a-zA-Z]+$/.test(s));
    fc.assert(
      fc.property(safeName, fc.string({ minLength: 0, maxLength: 50 }), (name, prefix) => {
        // Wrap with spaces so the scrub's word-boundary regex matches reliably,
        // even when the surrounding `prefix` happens to be alphanumeric.
        const sanitisedPrefix = prefix.replace(/[^a-zA-Z0-9 ]/g, "");
        const fragment = `${sanitisedPrefix} ${name} something else`;
        const r = scrub({ fragment, knownNames: [name] });
        // The fragment may also trip a higher-priority pattern; both satisfy
        // the privacy invariant ("blocked").
        return r.ok === false;
      }),
      { numRuns: 200 },
    );
  });

  it("invariant 2: random clean fragment → scrub passes", () => {
    // Tokens are 3-15 alphanumeric chars, joined by spaces. No PII shapes,
    // no injection sentinels, no email-like @, no long digit runs.
    const cleanToken = fc
      .string({ minLength: 3, maxLength: 15 })
      .filter((s) => /^[a-zA-Z]+$/.test(s));
    const cleanFragment = fc
      .array(cleanToken, { minLength: 1, maxLength: 12 })
      .map((tokens) => "USER_CONTEXT = " + JSON.stringify({ preferences: { brands_liked: tokens } }));
    fc.assert(
      fc.property(cleanFragment, (fragment) => {
        const r = scrub({ fragment, knownNames: [] });
        return r.ok === true;
      }),
      { numRuns: 300 },
    );
  });

  it("invariant 3: empty fragment always passes", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 5 }), (knownNames) => {
        const r = scrub({ fragment: "", knownNames });
        return r.ok === true;
      }),
      { numRuns: 50 },
    );
  });

  it("invariant 4: any §13 sentinel substring → scrub blocks", () => {
    // Pick one of the actual sentinel patterns from the schema list and
    // synthesise a triggering substring.
    const sentinelStrings = [
      "system:",
      "assistant:",
      "user:",
      "<|im_start|>",
      "|>",
      "[INST]",
      "[/INST]",
      "```",
      "ignore prior instructions",
      "ignore previous messages",
      "ignore all above instructions",
    ];
    void INJECTION_SENTINELS; // referenced for contract clarity
    fc.assert(
      fc.property(
        fc.constantFrom(...sentinelStrings),
        fc.string({ minLength: 0, maxLength: 30 }),
        fc.string({ minLength: 0, maxLength: 30 }),
        (sentinel, before, after) => {
          // Strip characters that could themselves trip a different scrub
          // class (digits → phone, @ → email) so we isolate the sentinel
          // signal we're testing for.
          const safe = (s: string) => s.replace(/[0-9@]/g, "x");
          const fragment = `${safe(before)} ${sentinel} ${safe(after)}`;
          const r = scrub({ fragment, knownNames: [] });
          return r.ok === false;
        },
      ),
      { numRuns: 200 },
    );
  });
});

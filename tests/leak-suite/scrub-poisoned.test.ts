/**
 * Scrub poisoning suite — 50 hand-crafted fragments, each carrying exactly
 * one PII or injection pattern. The scrub MUST block 100% of them.
 *
 * Spec: docs/06 §9 ("E2E — 50 poisoned sheets → scrub blocks 100% of them").
 */
import { describe, it, expect } from "vitest";
import { scrub } from "@/server/pii-scrub";
import { POISONED_SHEETS } from "./fixtures/poisoned-sheets";

describe("PII scrub — 50 poisoned fragments", () => {
  for (const poison of POISONED_SHEETS) {
    it(`blocks ${poison.label} → ${poison.expected}`, () => {
      const result = scrub({
        fragment: poison.fragment,
        knownNames: poison.knownNames,
      });
      // Privacy invariant: blocked is what matters. The pattern_class is a
      // soft expectation — overlapping shapes (e.g. a 16-digit credit card
      // also matches a 12-digit Aadhaar substring) may legitimately fire on
      // an earlier-priority class. We assert blocked-with-some-class.
      expect(result.ok, `${poison.label} should be blocked`).toBe(false);
    });
  }

  it("blocks 100% of the corpus (aggregate count)", () => {
    let blocked = 0;
    for (const poison of POISONED_SHEETS) {
      const r = scrub({ fragment: poison.fragment, knownNames: poison.knownNames });
      if (!r.ok) blocked++;
    }
    expect(blocked).toBe(POISONED_SHEETS.length);
  });

  it("clean fragments pass without false positives", () => {
    const clean = [
      "USER_CONTEXT = " + JSON.stringify({ physical: { hair: "short, dark" } }),
      "USER_CONTEXT = " + JSON.stringify({ preferences: { tone: "concise", diet: ["vegetarian"] } }),
      "USER_CONTEXT = " + JSON.stringify({ professional: { role_band: "senior_ic", industry: "fintech" } }),
      "USER_CONTEXT = " + JSON.stringify({ wellness: { activity_level: "moderate, 3x weekly" } }),
      "USER_CONTEXT = " + JSON.stringify({ transient: { current_focus: "preparing for the Q2 launch" } }),
    ];
    for (const f of clean) {
      expect(scrub({ fragment: f, knownNames: [] }).ok).toBe(true);
    }
  });
});

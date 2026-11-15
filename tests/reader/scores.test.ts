// The message reader's scores on invented messages (fixtures/), so a change that makes it find less, or name things
// worse, fails here. The check set (src/lib/reader/reader-check-messages.ts) only has floors: it measures Apple's
// model on a real iPhone, so the reader isn't tuned on it.
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findInMessage, type Raw } from "@/lib/reader/family-engine";
import { scoreMessage, total, type TestMessage } from "@/lib/reader/score-lib";
import { CHECK_MESSAGES } from "@/lib/reader/reader-check-messages";

const fixture = (f: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const replies = fixture("model-replies.json").replies as Record<string, Raw[]>;

async function score(messages: TestMessage[], withModel: boolean) {
  const scores = [];
  for (const m of messages) {
    const model = withModel ? async () => replies[m.id] || [] : null;
    const { items } = await findInMessage(m.text, {
      today: m.today,
      children: m.children || [],
      model,
    });
    scores.push(scoreMessage(m, items));
  }
  return {
    ...total(scores),
    misses: scores.flatMap((s) => s.misses.map((x) => `${s.id}: ${x}`)),
    extras: scores.flatMap((s) => s.extras.map((x) => `${s.id}: ${x}`)),
  };
}

for (const set of ["messages", "heldout", "heldout2"]) {
  for (const withModel of [false, true]) {
    test(`${set}, ${withModel ? "with simulated model replies" : "rules alone"}: everything found and well named`, async () => {
      const t = await score(fixture(`${set}.json`).messages, withModel);
      assert.deepEqual(t.misses, []);
      assert.deepEqual(t.extras, []);
      assert.equal(t.found, t.want);
      assert.equal(t.named, t.want);
    });
  }
}

test("the check set, rules alone: no worse than on 15 Nov 2026 (17 of 24 found, 13 well named, 3 unwanted)", async () => {
  const t = await score(CHECK_MESSAGES, false);
  assert.equal(t.want, 24);
  assert.ok(t.found >= 17, `found ${t.found}`);
  assert.ok(t.named >= 13, `named ${t.named}`);
  assert.ok(t.unwanted <= 3, `unwanted ${t.unwanted}`);
});

// The app's side of the message reader (src/lib/reader), with stand-in plugins.
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  appleModel,
  forgetShared,
  nativePlugins,
  readLetter,
  readShared,
  readText,
  todayHere,
  type NativePlugins,
  type SharedItem,
} from "@/lib/reader/phone-reader";
import { checkSummary, runReaderCheck } from "@/lib/reader/reader-check";
import { CHECK_MESSAGES } from "@/lib/reader/reader-check-messages";

const NEWSLETTER =
  "Bake sale. Friday 20 November after school in the hall. Please send in cakes in a named tub.";
const LETTER =
  "Dear Parents,\n\nOn Monday 7th December Year 4 will be visiting the National Museum. Children need a packed lunch.";

function fakes(shared: SharedItem[] = [], letters: Record<string, string> = {}) {
  const removed: string[][] = [];
  const reads: string[] = [];
  const p: NativePlugins = {
    SharedInbox: {
      list: async () => ({ items: shared }),
      remove: async ({ ids }) => {
        removed.push(ids);
        return { removed: ids.length };
      },
    },
    LetterText: {
      read: async ({ path }) => {
        reads.push(path);
        if (!(path in letters)) throw new Error("Couldn't open the photo.");
        return { text: letters[path], lines: letters[path].split("\n").length };
      },
    },
  };
  return { p, removed, reads };
}

test("on the web, or without the plugins, there are none and the rules do the reading", async () => {
  assert.deepEqual(await nativePlugins(), {});
  const none = await appleModel({});
  assert.equal(none.model, null);
  assert.match(none.reason, /doesn't have Apple's model/);
  const r = await readText(NEWSLETTER, { today: "2026-11-14", model: none.model });
  assert.equal(r.usedModel, false);
  assert.deepEqual(
    r.items.map((i) => i.date),
    ["2026-11-20"],
  );
});

test("Apple's model is used only when the iPhone says it's ready", async () => {
  const off = await appleModel({
    FoundItems: {
      status: async () => ({
        available: false,
        reason: "Apple Intelligence is turned off in Settings.",
      }),
      find: async () => ({ items: [] }),
    },
  });
  assert.equal(off.model, null);
  assert.equal(off.reason, "Apple Intelligence is turned off in Settings.");
  const broken = await appleModel({
    FoundItems: {
      status: async () => {
        throw new Error("x");
      },
      find: async () => ({ items: [] }),
    },
  });
  assert.equal(broken.model, null);
  const asked: { instructions: string; text: string }[] = [];
  const on = await appleModel({
    FoundItems: {
      status: async () => ({ available: true, reason: "" }),
      find: async (o) => {
        asked.push(o);
        return {
          items: [
            {
              type: "event",
              title: "Bake sale",
              child: "",
              when: "Friday 20 November",
              time: "",
              prep: "",
              quote: "Friday 20 November after school in the hall.",
            },
          ],
        };
      },
    },
  });
  assert.ok(on.model);
  const r = await readText(NEWSLETTER, { today: "2026-11-14", model: on.model });
  assert.equal(r.usedModel, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].text, NEWSLETTER);
  assert.match(asked[0].instructions, /COPY the exact words/);
  assert.equal(r.items.find((i) => i.date === "2026-11-20")?.title, "Bake sale");
});

test("shared messages and photos are read on the phone, oldest first, and forgotten only when asked", async () => {
  const { p, removed, reads } = fakes(
    [
      { id: "a1", capturedAt: "2026-11-14T08:00:00.000Z", kind: "text", text: NEWSLETTER },
      {
        id: "b2",
        capturedAt: "2026-11-14T08:01:00.000Z",
        kind: "image",
        path: "/group/captures/pending/b2.bin",
      },
      {
        id: "c3",
        capturedAt: "2026-11-14T08:02:00.000Z",
        kind: "image",
        path: "/group/captures/pending/c3.bin",
      },
    ],
    { "/group/captures/pending/b2.bin": LETTER },
  );
  const got = await readShared(p, { today: "2026-11-23" });
  assert.deepEqual(
    got.map((g) => g.id),
    ["a1", "b2", "c3"],
  );
  assert.deepEqual(
    got[0].items.map((i) => i.date),
    ["2026-11-20"],
  );
  assert.equal(got[1].items[0].date, "2026-12-07");
  assert.match(got[1].items[0].title, /National Museum/);
  assert.equal(got[1].items[0].bring, "a packed lunch");
  assert.equal(got[2].error, "Couldn't read the words in that photo.");
  assert.deepEqual(reads, ["/group/captures/pending/b2.bin", "/group/captures/pending/c3.bin"]);
  assert.deepEqual(removed, []); // nothing removed until the app has kept it
  assert.equal(await forgetShared(p, ["a1", "b2"]), 2);
  assert.deepEqual(removed, [["a1", "b2"]]);
  assert.equal(await forgetShared(p, []), 0);
  assert.equal(await forgetShared({}, ["a1"]), 0);
});

test("a build that can't read photos says so instead of failing", async () => {
  const r = await readLetter({}, "/x.jpg", { today: "2026-11-23" });
  assert.equal(r.error, "This version of the app can't read photos yet.");
  const blank = await readLetter(fakes([], { "/blank.jpg": "  " }).p, "/blank.jpg", {
    today: "2026-11-23",
  });
  assert.equal(blank.error, "No words found in that photo.");
  const failing: NativePlugins = {
    SharedInbox: {
      list: async () => {
        throw new Error("no group");
      },
      remove: async () => ({ removed: 0 }),
    },
  };
  assert.deepEqual(await readShared(failing, { today: "2026-11-23" }), []);
});

test("today is the phone's own date, not UTC's", () => {
  assert.equal(todayHere(new Date(2026, 10, 15, 0, 30)), "2026-11-15");
  assert.equal(todayHere(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("the check scores the rules and the model on the same invented messages, and says what went wrong", async () => {
  let t = 0;
  const alone = await runReaderCheck(null, {
    modelReason: "Apple Intelligence is turned off in Settings.",
  });
  assert.equal(alone.model, null);
  assert.equal(
    alone.rules.want,
    CHECK_MESSAGES.reduce((n, m) => n + m.expect.length, 0),
  );
  assert.match(
    checkSummary(alone),
    /Apple's model: not used \(Apple Intelligence is turned off in Settings\.\)/,
  );

  const silent = await runReaderCheck(async () => [], { now: () => (t += 500) });
  assert.deepEqual(silent.model, silent.rules); // a model that finds nothing changes nothing
  assert.equal(silent.modelOwn!.found, 0);
  assert.equal(silent.modelOwn!.unwanted, 0);
  assert.match(
    checkSummary(silent),
    /Apple's model's own items: found 0 of \d+, well named 0, 0 unwanted/,
  );
  assert.equal(silent.secondsPerMessage, 0.5);

  const refusing = await runReaderCheck(
    async () => {
      throw new Error("guardrailViolation");
    },
    { messages: CHECK_MESSAGES.slice(0, 2) },
  );
  assert.deepEqual(
    refusing.rows.map((r) => r.modelError),
    ["guardrailViolation", "guardrailViolation"],
  );
  const text = checkSummary(refusing, new Date("2026-11-23T10:00:00Z"));
  assert.match(text, /^Message reader check, 2026-11-23 10:00 UTC\nRules alone: found \d+ of 3/);
  assert.match(text, /model error photo-letter: guardrailViolation/);
  for (const m of CHECK_MESSAGES) assert.ok(!text.includes(m.text.slice(0, 60))); // never a message itself
});

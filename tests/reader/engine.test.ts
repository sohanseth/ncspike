// The message reader's tests (src/lib/reader/family-engine.ts), with parity against the Mac's own nc/app/family.py
// answers in fixtures/parity.json.
import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseWhen,
  sweepDates,
  checkItems,
  findInMessage,
  chunksOf,
  rulesFind,
  MODEL_SCHEMA,
  MODEL_INSTRUCTIONS,
  isoDate,
  addDays,
  weekdayOf,
  type Raw,
} from "@/lib/reader/family-engine";

const here = (f: string) =>
  JSON.parse(readFileSync(new URL(f.replace("./", "./fixtures/"), import.meta.url), "utf8"));
const parity = here("./parity.json");
const msgs = [
  ...here("./messages.json").messages,
  ...here("./heldout.json").messages,
  ...here("./heldout2.json").messages,
];
const byId = Object.fromEntries(msgs.map((m: { id: string }) => [m.id, m]));
const strip = (items: object[]) =>
  items.map((it) => Object.fromEntries(Object.entries(it).filter(([k]) => k !== "id")));

test("dates come out exactly as on the Mac", () => {
  for (const c of parity.parseWhen) {
    assert.deepEqual(
      parseWhen(c.when, c.ref, c.weekly),
      c.out,
      `${JSON.stringify(c.when)} from ${c.ref}${c.weekly ? " (weekly)" : ""}`,
    );
  }
});

test("the date check finds the same sentences as on the Mac", () => {
  for (const c of parity.sweepDates) {
    const m = byId[c.id];
    assert.deepEqual(strip(sweepDates(m.text, [], m.today)), c.out, c.id);
  }
});

test("a model's proposals are checked exactly as on the Mac", () => {
  const replies = here("./model-replies.json").replies;
  for (const c of parity.checkItems) {
    const m = byId[c.id];
    const got = checkItems(replies[c.id], m.text, m.children || [], m.today);
    assert.deepEqual(strip(got.items), c.out, c.id);
    assert.deepEqual(got.rejected, c.rejected, c.id);
  }
});

test("what the model makes up never gets through", async () => {
  const m = byId["newsletter"];
  const replies = here("./model-replies.json").replies.newsletter as Raw[];
  const { items, rejected } = await findInMessage(m.text, {
    today: m.today,
    model: async () => replies,
  });
  assert.ok(rejected.some((r) => r.title === "Sports day")); // a sentence that isn't there
  assert.ok(!items.some((i) => i.date === "2027-07-03" || /sports day/i.test(i.title)));
  const trip = items.find((i) => i.date === "2026-12-02")!;
  assert.equal(trip.child, ""); // "Tom" isn't in the message
  assert.ok(!/raincoat|wellies/.test(trip.bring)); // nor are a raincoat and wellies
  assert.equal(items.find((i) => /non-uniform/i.test(i.title))!.date, "2026-11-27"); // "27/11" was its own words
});

test("a model can't name things with words the message doesn't have", async () => {
  const m = byId["advert"];
  const { items } = await findInMessage(m.text, {
    today: m.today,
    model: async () => here("./model-replies.json").replies.advert,
  });
  assert.deepEqual(items, []);
});

test("without the model, or when it fails, the rules still find everything dated", async () => {
  const m = byId["newsletter"];
  const without = await findInMessage(m.text, { today: m.today });
  const failing = await findInMessage(m.text, {
    today: m.today,
    model: async () => {
      throw new Error("not available");
    },
  });
  assert.equal(without.usedModel, false);
  assert.equal(failing.usedModel, false);
  assert.deepEqual(
    strip(failing.items).map((i) => [i.type, i.date]),
    strip(without.items).map((i) => [i.type, i.date]),
  );
  assert.deepEqual(without.items.map((i) => i.date).sort(), [
    "2026-11-20",
    "2026-11-27",
    "2026-11-27",
    "2026-11-30",
    "2026-12-02",
  ]);
});

test("a child's name only when the message has it", async () => {
  const m = byId["party-invite"];
  const { items } = await findInMessage(m.text, { today: m.today, children: ["Ella", "Arjun"] });
  assert.ok(items.every((i) => i.child === "Ella"));
  const none = await findInMessage(byId["clubs"].text, { today: "2026-11-14", children: ["Ella"] });
  assert.ok(none.items.every((i) => i.child === ""));
});

test("long messages go to the model in parts it can read whole", async () => {
  const para =
    "Bake sale. Friday 20 November after school in the hall. Please send in cakes in a named tub.";
  const long = Array.from({ length: 120 }, () => para).join("\n\n");
  const parts = chunksOf(long);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 5000));
  assert.equal(parts.join("\n\n"), long); // nothing lost, nothing split mid-paragraph
  let calls = 0;
  await findInMessage(long, {
    today: "2026-11-14",
    model: async () => {
      calls++;
      return [];
    },
  });
  assert.equal(calls, parts.length);
  assert.ok(MODEL_INSTRUCTIONS.length < 2200); // short enough for a 4,096-token window
  let sizes: number[] = []; // too long for the window: smaller parts
  const r = await findInMessage(long, {
    today: "2026-11-14",
    model: async (part) => {
      sizes.push(part.length);
      if (part.length > 2500) throw new Error("exceededContextWindowSize");
      return [];
    },
  });
  assert.ok(r.usedModel && sizes.some((x) => x > 2500) && sizes.slice(-1)[0] <= 2500);
  sizes = [];
  const other = await findInMessage(long, {
    today: "2026-11-14",
    model: async () => {
      throw new Error("modelNotReady");
    },
  });
  assert.equal(other.usedModel, false);
  assert.deepEqual(MODEL_SCHEMA.properties.items.items.required, [
    "type",
    "title",
    "child",
    "when",
    "time",
    "prep",
    "quote",
  ]);
});

test("calendar arithmetic", () => {
  assert.equal(isoDate(2026, 2, 29), null);
  assert.equal(isoDate(2028, 2, 29), "2028-02-29");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekdayOf("2026-11-14"), 5); // a Saturday
});

test("rules: worked-out days stay the message's days", () => {
  const raw = rulesFind(
    "Would be great if Arjun can make it, let me know by Thurs 26th x",
    "2026-11-16",
  );
  assert.equal(raw[0].when, "26 nov");
  assert.equal(raw[0].type, "forward");
  const list = rulesFind(
    "Term dates\nChristmas holidays: 21 December - 1 January\nFebruary half term: 15-19 February",
    "2026-11-16",
  );
  assert.deepEqual(
    list.map((r) => [r.type, r.title, r.when]),
    [
      ["closure", "Christmas holidays", "21 December to 1 January"],
      ["closure", "February half term", ""],
    ],
  );
});

test("loads on older iPhones: no lookbehind, which iOS 15 can't parse", () => {
  const src = readFileSync(
    new URL("../../src/lib/reader/family-engine.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!/\(\?<[=!]/.test(src));
});

test("money is not a time, and a time range stays whole", async () => {
  const pay = await findInMessage(
    "The cost of the trip on Monday 7th December is £8.50, which should be paid on ParentPay no later than Monday 30th November.",
    { today: "2026-11-17" },
  );
  assert.ok(
    pay.items.length >= 1 && pay.items.every((i) => i.time === ""),
    JSON.stringify(pay.items.map((i) => i.time)),
  );
  const club = await findInMessage(
    "Brownies meets every Tuesday in the church hall from 6 till 7.30pm.",
    { today: "2026-11-17" },
  );
  assert.equal(club.items[0].time, "6 till 7.30pm");
});

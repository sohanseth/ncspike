// How well the reader does on invented messages with known answers: shared by the test script (test/score.ts) and
// the app's "Check the message reader" (phone/app/reader-check.ts), so a score on the iPhone means the same as here.
import type { Found } from "./family-engine";

/** One thing a message should give: its type, its date or weekdays, and words its title should have (any one). */
export interface Expect {
  type?: string;
  date?: string;
  endDate?: string;
  weekdays?: number[];
  title?: string[];
}

/** An invented message, the day it's read, and what it should give ("maybe": fine to give, not counted). */
export interface TestMessage {
  id: string;
  today: string;
  text: string;
  children?: string[];
  expect: Expect[];
  maybe?: Expect[];
}

export interface MessageScore {
  id: string;
  want: number;
  found: number;
  named: number;
  unwanted: number;
  misses: string[];
  extras: string[];
}

function fits(f: Found, e: Expect, loose = false): boolean {
  if (e.type && f.type !== e.type) return false;
  if (e.date && f.date !== e.date) return false;
  if (e.endDate && f.endDate !== e.endDate) return false;
  if (e.weekdays && JSON.stringify(f.weekdays) !== JSON.stringify(e.weekdays)) return false;
  if (!loose && e.title && !e.title.some((w) => f.title.toLowerCase().includes(w))) return false;
  return true;
}

/** Each expected item counts once: found (right type and day), and well named (its title says what it is). */
export function scoreMessage(m: TestMessage, items: Found[]): MessageScore {
  const s: MessageScore = {
    id: m.id,
    want: m.expect.length,
    found: 0,
    named: 0,
    unwanted: 0,
    misses: [],
    extras: [],
  };
  const used = new Set<number>();
  for (const e of m.expect) {
    const i = items.findIndex((f, k) => !used.has(k) && fits(f, e, true));
    if (i < 0) {
      s.misses.push(JSON.stringify(e));
      continue;
    }
    used.add(i);
    s.found++;
    if (fits(items[i], e)) s.named++;
    else s.misses.push(`found, but named "${items[i].title}" for ${JSON.stringify(e.title)}`);
  }
  items.forEach((f, k) => {
    if (used.has(k) || (m.maybe || []).some((e) => fits(f, e, true))) return;
    s.unwanted++;
    s.extras.push(`${f.type} ${f.date || JSON.stringify(f.weekdays)} "${f.title}"`);
  });
  return s;
}

export function total(scores: MessageScore[]) {
  const sum = (k: "want" | "found" | "named" | "unwanted") => scores.reduce((n, s) => n + s[k], 0);
  return { want: sum("want"), found: sum("found"), named: sum("named"), unwanted: sum("unwanted") };
}

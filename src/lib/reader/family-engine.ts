/*
 * NeuralConnexions on the phone: what a shared message asks of you, found on the phone itself.
 *
 * One message at a time (a school newsletter, a class WhatsApp group, a club email, a photo of a letter, an
 * invitation) becomes proposals: things on a date, things that repeat, things to do by a deadline, days without
 * school, and what to bring. Nothing leaves the phone and nothing here calls a server.
 *
 * Two layers:
 *   rules  work on every phone: every dated sentence, weekly days ("PE on Tuesdays and Thursdays"), days without
 *          school, deadlines ("return the form by Friday") and what to bring, in the message's own words;
 *   model  Apple's on-device model (iPhone 15 Pro and newer), through the app's native plugin, names and sorts
 *          them better. It proposes; code checks every quote is really in the message, works out every date
 *          itself (the model never writes a date), keeps a child's name only if the message has it, and drops
 *          titles or things to bring that add what the message doesn't say.
 *
 * A port of the Mac app's nc/app/family.py and nc/app/grounded.py (same rules, same results: see
 * test/parity.test.ts). No dependencies. Dates are "YYYY-MM-DD" strings. Every item is a proposal until the
 * parent adds it.
 */

// ------------------------------------------------------------------------------------------- words and novelty
const STOP = new Set(
  `a an the and or but nor of to in on at for with by from as is are was were be been being it its this
that these those i i'm i've i'd me my mine we our you your yours he she they them their his her him will would can
could should may might must shall do does did done have has had having not no so than then very more most into
over under about after before up down out also just only which who whom whose what when where why how all any each
both few other some such own same too there here per via while during within across through again further once
am if because until against between both off onto upon whether yet ever every`.split(/\s+/),
);
const CONNECTIVE =
  `using use used including include includes across within role work worked working team staff
experience project projects course skills skill knowledge strong good well new key main daily weekly results result
help helped support supported ensure ensured make made create created build built develop developed apply applying
application interest interested keen eager look looking forward opportunity opportunities contribute contribution
welcome chance discuss thank thanks time consider considering position job write writing dear regards kind sincerely
best wishes currently current student studying study studies degree based want would like love hope`.split(
    /\s+/,
  );
const ACTION_VERBS =
  `built managed trained developed scheduled created designed cut reduced improved delivered
analysed analyzed organised organized coordinated predicted supervised planned ran wrote completed studied achieved
increased decreased launched handled supported prepared presented modelled modeled cleaned tested researched
conducted taught mentored produced implemented automated`.split(/\s+/);
const UPGRADES = [
  "led",
  "lead",
  "headed",
  "spearheaded",
  "expert",
  "expertise",
  "proficient",
  "proficiency",
  "advanced",
  "extensive",
  "extensively",
  "proven",
  "senior",
  "fluent",
  "native",
  "mastery",
  "mastered",
  "strong",
  "exceptional",
  "outstanding",
  "excellent",
  "significantly",
  "large-scale",
  "large",
  "robust",
  "superior",
];
const WORD_RE = /[A-Za-z][A-Za-z'’-]+/g;
const NUM_RE = /[£$€]?\d[\d,.]*%?/g; // numbers not straight after a letter (see numMatches)

/** NUM_RE's matches that don't follow a letter or digit ("a12" has none; "x£5" has "5"), without lookbehind, which
 *  iPhones on iOS 15 can't parse. */
function numMatches(t: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [],
    re = new RegExp(NUM_RE.source, "g");
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index > 0 && /\w/.test(t[m.index - 1])) re.lastIndex = m.index + 1;
    else out.push(m);
  }
  return out;
}

export function stem(word: string): string {
  let w = word
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^['-]+|['-]+$/g, "");
  for (const suf of ["ings", "ing", "ers", "er", "ies", "ied", "ed", "es", "s", "ly"]) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  return w.slice(0, 6);
}

export function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text || "").matchAll(WORD_RE)) {
    if (m[0].length > 2 && !STOP.has(m[0].toLowerCase())) out.add(stem(m[0]));
  }
  return out;
}

const ALLOWED = new Set([...CONNECTIVE, ...ACTION_VERBS].map(stem));

/** Content stems in text that appear in none of the supporting texts (and aren't generic connectives). */
export function novelty(text: string, ...support: string[]): Set<string> {
  const have = new Set<string>();
  for (const s of support) for (const x of contentStems(s)) have.add(x);
  const out = new Set<string>();
  for (const x of contentStems(text)) if (!have.has(x) && !ALLOWED.has(x)) out.add(x);
  return out;
}

const NUM_WORDS: Record<string, string> = {};
"zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
  .split(" ")
  .forEach((w, i) => {
    NUM_WORDS[w] = String(i);
  });
Object.assign(NUM_WORDS, { thirty: "30", forty: "40", fifty: "50", hundred: "100", half: "50" });

/** Numbers in a text, with number words counted as digits ("three months" = "3 months"). */
export function numbers(text: string): Set<string> {
  const t = text || "";
  const found = new Set<string>();
  for (const m of numMatches(t)) {
    const n = m[0].replace(/^[£$€%,.]+|[£$€%,.]+$/g, "").replace(/,/g, "");
    if (n) found.add(n);
  }
  for (const m of t.matchAll(/[A-Za-z]+/g)) {
    const w = m[0].toLowerCase();
    if (w in NUM_WORDS && w !== "half") found.add(NUM_WORDS[w]);
  }
  return found;
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function upgradesAdded(text: string, support: string): string[] {
  const low = (text || "").toLowerCase(),
    sup = (support || "").toLowerCase();
  return UPGRADES.filter(
    (u) =>
      new RegExp(`\\b${escapeRx(u)}\\b`).test(low) && !new RegExp(`\\b${escapeRx(u)}\\b`).test(sup),
  );
}

export function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ------------------------------------------------------------------------------------------- dates
export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const WD_SRC = String.raw`\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(day|days|s)?\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const DAY_MON_SRC = String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?` + MON + String.raw`\b`;
const MON_DAY_SRC = String.raw`\b` + MON + String.raw`\s+(\d{1,2})(?:st|nd|rd|th)?\b`;
const NUMERIC_SRC = String.raw`\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b`;
const RANGE_DAYS_SRC =
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|to|until)\s*(\d{1,2})(?:st|nd|rd|th)?\s+` +
  MON +
  String.raw`\b`;
const RELATIVE_SRC = String.raw`\b(this weekend|tomorrow|tonight|next week|this (mon|tue|wed|thu|fri|sat|sun)\w*day)\b`;
const WD_RE = new RegExp(WD_SRC, "i");
const DAY_MON = new RegExp(DAY_MON_SRC, "i");
const MON_DAY = new RegExp(MON_DAY_SRC, "i");
const RELATIVE = new RegExp(RELATIVE_SRC, "i");
const MSG_HEAD =
  /^\[?\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\]?\s*(?:-\s*)?[^:]{1,40}:\s*/;
const STAMP_SRC = String.raw`^\[?(\d{1,2})/(\d{1,2})/(\d{2,4}),?\s+\d{1,2}:\d{2}`; // a WhatsApp export's line start
const MAIL_HEAD = /^(?:(?:from|to|cc|bcc|reply-to|subject|date|sent):[^\n]*\n)+\n?/i; // a mail's own header
const EMAIL_DATE_SRC = String.raw`^Date:\s*(.{6,60})$`; // a shared email's header

const all = (src: string, flags: string, text: string) =>
  text.matchAll(new RegExp(src, flags.includes("g") ? flags : flags + "g"));

/** Calendar days as "YYYY-MM-DD"; null when the day doesn't exist (31 June). */
export function isoDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const t = new Date(day + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday, as on the Mac. */
export function weekdayOf(day: string): number {
  return (new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7;
}

function wd(token: string): number {
  return WEEKDAYS.map((w) => w.slice(0, 3)).indexOf(token.toLowerCase().slice(0, 3));
}

function mon(token: string): number {
  return MONTHS.indexOf(token.toLowerCase().slice(0, 3)) + 1;
}

/** The date with this day and month nearest after the reference (a school message talks about what's coming); up
 *  to 30 days in the past still counts as this year. */
function yearFor(month: number, day: number, ref: string): string | null {
  const y0 = Number(ref.slice(0, 4));
  for (const y of [y0, y0 + 1]) {
    const d = isoDate(y, month, day);
    if (!d) return null;
    if (d >= addDays(ref, -30)) return d;
  }
  return null;
}

export interface When {
  date: string | null;
  end_date: string | null;
  weekdays: number[];
}

/** Code, not the model, decides dates. Empty values when unclear. */
export function parseWhen(when: string, ref: string, weekly = false): When {
  const w = (when || "").trim();
  const out: When = { date: null, end_date: null, weekdays: [] };
  if (!w) return out;
  const low = w.toLowerCase();
  const days: number[] = [];
  for (const m of all(WD_SRC, "i", w)) {
    const d = wd(m[1] || m[3]);
    if (d >= 0 && !days.includes(d)) days.push(d);
  }
  if (weekly) {
    out.weekdays = [...days].sort((a, b) => a - b);
    return out;
  }
  const r = new RegExp(RANGE_DAYS_SRC, "i").exec(w);
  if (r) {
    const a = yearFor(mon(r[3]), Number(r[1]), ref),
      b = yearFor(mon(r[3]), Number(r[2]), ref);
    if (a && b && b >= a) {
      out.date = a;
      out.end_date = b;
      return out;
    }
  }
  let found: string[] = [];
  for (const m of all(DAY_MON_SRC, "i", w)) {
    const d = yearFor(mon(m[2]), Number(m[1]), ref);
    if (d) found.push(d);
  }
  for (const m of all(MON_DAY_SRC, "i", w)) {
    const d = yearFor(mon(m[1]), Number(m[2]), ref);
    if (d) found.push(d);
  }
  if (!found.length) {
    for (const m of all(NUMERIC_SRC, "", w)) {
      // UK order: 16/10
      const dd = Number(m[1]),
        mm = Number(m[2]);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        if (m[3]) {
          let y = Number(m[3]);
          y = y < 100 ? y + 2000 : y;
          const d = isoDate(y, mm, dd);
          if (d) found.push(d);
        } else {
          const d = yearFor(mm, dd, ref);
          if (d) found.push(d);
        }
      }
    }
  }
  if (!found.length) {
    if (/\b(today|tonight|this evening)\b/.test(low)) found.push(ref);
    else if (/\btomorrow\b/.test(low)) found.push(addDays(ref, 1));
    else if (/\bthis weekend\b/.test(low)) found.push(addDays(ref, (5 - weekdayOf(ref) + 7) % 7));
    else if (/\bnext week\b/.test(low)) found.push(addDays(ref, 7 - weekdayOf(ref)));
    else if (days.length === 1) {
      let ahead = (days[0] - weekdayOf(ref) + 7) % 7;
      if (/\bnext\s+(mon|tue|wed|thu|fri|sat|sun)/.test(low)) ahead = ahead ? ahead + 7 : 7;
      found.push(addDays(ref, ahead));
    }
  }
  found = [...new Set(found)].sort();
  if (found.length) {
    out.date = found[0];
    if (found.length > 1 && /\b(to|until|till|through|-|–)\b/.test(low))
      out.end_date = found[found.length - 1];
  }
  return out;
}

/** The date of the WhatsApp message (or shared email) a quote sits in. */
export function refDateFor(text: string, pos: number, dflt: string): string {
  let best: RegExpMatchArray | null = null;
  for (const m of all(STAMP_SRC, "m", text)) {
    if ((m.index ?? 0) > pos) break;
    best = m;
  }
  if (!best) {
    let mail: RegExpMatchArray | null = null; // "Date: Wed, 14 Oct 2026, 09:12"
    for (const m of all(EMAIL_DATE_SRC, "m", text)) {
      if ((m.index ?? 0) > pos) break;
      mail = m;
    }
    if (mail) {
      const y = /\b(20\d\d)\b/.exec(mail[1]);
      const p = parseWhen(mail[1].replace(/\b20\d\d\b/g, ""), dflt);
      if (p.date) {
        let got = p.date;
        if (y)
          got =
            isoDate(Number(y[1]), Number(p.date.slice(5, 7)), Number(p.date.slice(8, 10))) ||
            p.date;
        return got <= dflt ? got : dflt;
      }
    }
    return dflt;
  }
  let yy = Number(best[3]);
  yy = yy < 100 ? yy + 2000 : yy;
  return isoDate(yy, Number(best[2]), Number(best[1])) || dflt;
}

/** The WhatsApp message before the one at pos ("trip money" asked about, "£12, on ParentPay by Friday" answered). */
export function prevMessage(text: string, pos: number): string {
  const starts = [...all(STAMP_SRC, "m", text)].map((m) => m.index ?? 0).filter((i) => i <= pos);
  if (starts.length < 2) return "";
  return text.slice(starts[starts.length - 2], starts[starts.length - 1]).slice(0, 600);
}

/** The paragraph (or WhatsApp message) around a quote. */
export function contextOf(text: string, pos: number, quote: string): string {
  if (pos < 0) return quote;
  const blank = pos >= 2 ? text.lastIndexOf("\n\n", pos - 2) : -1;
  let stamp = -1;
  for (const m of all(STAMP_SRC, "m", text.slice(0, pos + 1)))
    stamp = Math.max(stamp, m.index ?? -1);
  const a = Math.max(blank, stamp);
  const ends: number[] = [];
  const nb = text.indexOf("\n\n", pos + quote.length);
  if (nb !== -1) ends.push(nb);
  const re = new RegExp(STAMP_SRC, "gm");
  re.lastIndex = pos + 1;
  const nxt = re.exec(text);
  if (nxt) ends.push(nxt.index);
  const b = ends.length ? Math.min(...ends) : text.length;
  return text.slice(Math.max(0, a), b).slice(0, 1200) || quote;
}

// ------------------------------------------------------------------------------------------- what the model proposes
const REPEATS =
  /\b(every|each|weekly|from now on|from next week|(mon|tues|wednes|thurs|fri|satur|sun)days)\b/i;
const ONE_OFF =
  /\b(this week|next week|tomorrow|today|tonight|this (mon|tue|wed|thu|fri|sat|sun)\w*)\b/i;

/** Weekly only if the message says it repeats; "moved to Thursday this week" is a one-off. */
export function settleType(typ: string, words: string): string {
  if (
    typ === "weekly" &&
    (ONE_OFF.test(words) || DAY_MON.test(words) || MON_DAY.test(words)) &&
    !REPEATS.test(words)
  ) {
    return "event";
  }
  if (
    (typ === "event" || typ === "forward") &&
    REPEATS.test(words) &&
    !(DAY_MON.test(words) || MON_DAY.test(words)) &&
    !ONE_OFF.test(words)
  ) {
    return "weekly";
  }
  return typ;
}

export function sentences(text: string): string[] {
  const out: string[] = [];
  for (let block of text.split(/\n{2,}|\n(?=\[?\d{1,2}\/\d{1,2}\/\d{2,4})/)) {
    block = block.split(/\s+/).filter(Boolean).join(" ");
    block = block.replace(MSG_HEAD, "").trim(); // "[12/10/2026, 19:05:17] Lucy: " -> the message itself
    for (const x of block.replace(/([.!?;])\s+/g, "$1\n").split("\n"))
      if (x.trim().length > 3) out.push(x.trim());
  }
  return out;
}

/** The sentence (or two) a near-quote came from; "" if nothing matches well enough. */
export function recoverQuote(quote: string, text: string): string {
  const q = contentStems(quote);
  if (q.size < 3) return "";
  const sents = sentences(text);
  let best = "",
    score = 0;
  for (let i = 0; i < sents.length; i++) {
    for (const span of [
      sents[i],
      sents.slice(i, i + 2).join(" "),
      sents.slice(i, i + 3).join(" "),
    ]) {
      const st = contentStems(span);
      if (!st.size) continue;
      let both = 0;
      for (const x of q) if (st.has(x)) both++;
      const sc = both / q.size - (0.02 * Math.max(0, st.size - q.size)) / Math.max(1, q.size);
      if (sc > score) {
        best = span;
        score = sc;
      }
    }
  }
  return score >= 0.75 && norm(text).includes(norm(best)) ? best : "";
}

/** The dated clause of a quote that shares most words with the item's title. */
export function bestClause(quote: string, title: string): string {
  const t = contentStems(title);
  let best = "",
    score = -1;
  for (const cl of quote
    .replace(/([.!?;])\s+/g, "$1\u0000")
    .replace(/,\s+(?=(?:and |but )?(?:please|rsvp|appointment|booking))/g, "\u0000")
    .split("\u0000")) {
    if (!(DAY_MON.test(cl) || MON_DAY.test(cl) || RELATIVE.test(cl) || WD_RE.test(cl))) continue;
    let sc = 0;
    for (const x of contentStems(cl)) if (t.has(x)) sc++;
    if (sc > score) {
      best = cl;
      score = sc;
    }
  }
  return best;
}

export interface Raw {
  type?: string;
  title?: string;
  child?: string;
  when?: string;
  time?: string;
  prep?: string;
  quote?: string;
  rules?: boolean;
} // rules: proposed by this file's rules, whose "when" may be worked out ("1 and 2 December" -> "1 December")
export interface Item {
  id: string;
  type: string;
  title: string;
  child: string;
  time: string;
  prep: string;
  quote: string;
  status: string;
  added: string;
  date?: string;
  end_date?: string;
  weekdays?: number[];
  needs?: string;
  found_by?: string;
  named?: string;
}

let makeId = (): string => {
  const b = new Uint8Array(5);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
};
/** For tests: ids that don't change from run to run. */
export function setIdMaker(f: () => string) {
  makeId = f;
}

const PREP_SRC = String.raw`\b(?:need|needs|bring|wear|send in|pack)\s+(?!to\b)(.{5,140}?)[.!]?$`;

/** What to bring: "Children need a packed lunch." -> "a packed lunch"; not after "no ", "don't " or "not ". */
function prepExec(s: string): RegExpExecArray | null {
  const re = new RegExp(PREP_SRC, "gi");
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!/(?:no |don't |not )$/i.test(s.slice(0, m.index))) return m;
    re.lastIndex = m.index + 1;
  }
  return null;
}

/** Dated sentences no proposed item covers become proposals too, named with the message's own words. alsoCovered:
 *  days already accounted for another way (the second of "on 9 and 10 December"). */
export function sweepDates(
  text: string,
  items: Item[],
  today: string,
  alsoCovered: string[] = [],
): Item[] {
  const covered = new Set<string>(alsoCovered);
  for (const it of items)
    for (const k of ["date", "end_date"] as const) if (it[k]) covered.add(it[k] as string);
  const head = MAIL_HEAD.exec(text);
  let body: string;
  if (head)
    body = text.slice(head[0].length); // a mail's header is never a dated sentence
  else {
    const parts = text.split("\n\n");
    const first = parts[0],
      rest = parts.slice(1).join("\n\n");
    body =
      parts.length >= 2 && first.length < 200 && !new RegExp(STAMP_SRC, "m").test(first)
        ? rest
        : text;
  }
  const extra: Item[] = [];
  const quoted = items.filter((it) => it.type === "weekly").map((it) => norm(it.quote)); // a repeat's own words aren't a date
  for (const sn of sentences(body)) {
    if (!(DAY_MON.test(sn) || MON_DAY.test(sn) || RELATIVE.test(sn))) continue;
    if (quoted.some((q) => q.includes(norm(sn)))) continue;
    const pos = text.indexOf(sn.slice(0, 40));
    const ref = refDateFor(text, pos >= 0 ? pos : 0, today);
    const d = parseWhen(sn, ref).date;
    if (!d || covered.has(d) || d < addDays(today, -1)) continue;
    covered.add(d);
    let label = "";
    const para = contextOf(text, pos, sn);
    const m = /^\s*(?:\[[^\]]*\]\s*[^:]*:\s*)?([A-Z][\w' -]{2,30}?)\.\s/.exec(para);
    if (m && m[1].split(/\s+/).length <= 6 && !sn.includes(m[1])) label = m[1] + ": "; // "Bake sale." heads an item
    const isAction = /\b(please|check|book|pay|return|rsvp|bring|send)\b/i.test(sn);
    const words = (!label || isAction ? label + sn : label.replace(/:\s*$/, ""))
      .split(/\s+/)
      .filter(Boolean);
    let prep = ""; // what to bring, word for word from the paragraph
    for (const other of sentences(para)) {
      const pm = prepExec(other);
      if (pm && other !== sn && !(DAY_MON.test(other) || MON_DAY.test(other))) {
        prep = pm[1].trim().replace(/\.$/, "");
        break;
      }
    }
    extra.push({
      id: makeId(),
      type: isAction ? "forward" : "event",
      title:
        words
          .slice(0, 11)
          .join(" ")
          .replace(/[,.;:!]+$/, "") + (words.length > 11 ? "…" : ""),
      child: "",
      time: "",
      prep,
      quote: sn,
      status: "proposed",
      added: today,
      date: d,
      end_date: "",
      found_by: "date check",
      named: "quote",
    });
  }
  return extra;
}

/** Keep only what the message supports; dates by code. */
export function checkItems(
  raw: Raw[],
  text: string,
  children: string[],
  today: string,
): { items: Item[]; rejected: { title: string; why: string }[] } {
  const nt = norm(text);
  const names = children.filter(Boolean);
  const items: Item[] = [],
    rejected: { title: string; why: string }[] = [];
  for (const r of raw || []) {
    if (!r || typeof r !== "object") continue;
    let typ = ["weekly", "event", "forward", "closure"].includes(String(r.type))
      ? String(r.type)
      : "";
    let quote = String(r.quote || "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    let title = String(r.title || "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (!typ || !quote || !title) continue;
    if (!nt.includes(norm(quote))) {
      const found = recoverQuote(quote, text); // a small model often trims or joins sentences
      if (!found) {
        rejected.push({ title, why: "the quote isn't in what you shared" });
        continue;
      }
      quote = found;
    }
    const pos = text.toLowerCase().indexOf(quote.toLowerCase().slice(0, 40));
    const ref = refDateFor(text, pos >= 0 ? pos : 0, today);
    const ctx = contextOf(text, pos, quote); // preparation is often in the next sentence
    let when = String(r.when || "");
    if (when && !r.rules && !norm(quote).includes(norm(when))) when = ""; // an invented "when": the quote's words instead
    typ = settleType(typ, typ !== "weekly" ? `${when} ${quote}` : when || quote);
    if (!when && typ !== "weekly") when = bestClause(quote, title);
    const parsed = parseWhen(when || quote, ref, typ === "weekly");
    if (typ === "weekly" && !parsed.weekdays.length) {
      rejected.push({ title, why: "no weekday in the message" });
      continue;
    }
    let named = "";
    if (novelty(title, ctx, prevMessage(text, pos)).size > 2) {
      // a reply often names its subject earlier
      const q = quote.split(/\s+/);
      title =
        q
          .slice(0, 8)
          .join(" ")
          .replace(/[,.;:]+$/, "") + (q.length > 8 ? "…" : "");
      named = "quote";
    }
    let prep = String(r.prep || "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (prep && (RELATIVE.test(prep) || DAY_MON.test(prep) || WD_RE.test(prep))) prep = ""; // news, not packing
    if (
      prep &&
      (novelty(prep, ctx).size ||
        upgradesAdded(prep, ctx).length ||
        ![...numbers(prep)].every((n) => numbers(ctx).has(n)))
    )
      prep = ""; // every word from the message
    let tm = String(r.time || "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (tm && ![...numbers(tm)].every((n) => numbers(ctx).has(n))) tm = "";
    let child = String(r.child || "").trim();
    const inCtx = names.filter((c) => new RegExp(`\\b${escapeRx(c)}\\b`, "i").test(ctx));
    child = inCtx.length ? (inCtx.includes(child) ? child : inCtx[0]) : "";
    const it: Item = {
      id: makeId(),
      type: typ,
      title,
      child,
      time: tm,
      prep,
      quote,
      status: "proposed",
      added: today,
    };
    if (named) it.named = named;
    if (typ === "weekly") it.weekdays = parsed.weekdays;
    else {
      it.date = parsed.date || "";
      it.end_date = parsed.end_date || "";
      if (!it.date) it.needs = "date";
    }
    items.push(it);
  }
  return { items: items.concat(sweepDates(text, items, today)), rejected }; // every dated sentence surfaces
}

// ------------------------------------------------------------------------------------------- rules, for every phone
// What a phone without Apple's model can still find, in the message's own words: dated sentences (named by their
// subject, the heading or label above them, or what the event is), weekly days, deadlines, days without school or
// clubs, times and what to bring. They go through checkItems like the model's proposals, so dates and children are
// decided the same way; their "when" may be worked out by code ("Thurs 26th" -> "26 November").
const TIME_RE =
  /\b\d{1,2}(?:[:.]\d{2})\s*(?:am|pm)?(?:\s*(?:-|–|to|til|till|until)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)?|\b\d{1,2}\s*(?:am|pm)(?:\s*(?:-|–|to|til|till|until)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)?|\b\d{1,2}\s*(?:-|–)\s*\d{1,2}\s*(?:am|pm)\b|\b\d{1,2}(?:[:.]\d{2})?\s*(?:-|–|to|til|till|until)\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/i;
// "No meeting on 22nd December", "no football training this week" (not "no swimming kit needed")
const NO_SESSION_SRC = String.raw`no\s+((?:[\w-]+\s+)?(?:meeting|club|session|class|lessons?|practice|training|rehearsal|swimming|football|activities|brownies|beavers|cubs|scouts|guides|rainbows))\b(?!\s+(?:kit|bag|costume|clothes|uniform|money|form|stuff|things|needed))`;
const NO_SESSION = new RegExp(String.raw`\b` + NO_SESSION_SRC, "i");
const CLOSED = new RegExp(
  String.raw`\b(closed|closure|inset|in-service|training day|staff training|half[- ]term|holidays?|no school|bank holiday|cancell?ed|called off|postponed)\b|\b` +
    NO_SESSION_SRC,
  "i",
);
const OPENS = /\b(re-?opens?|back to school|returns? on|term starts?|starts? back)\b/i;
const DEADLINE = /\b(by|no later than|deadline|before|due)\b/i;
const ACTION =
  /\b(please|return|pay|book|complete|sign|send|rsvp|reply|respond|confirm|bring|order|register|apply|choose|fill in|sign up|request|requested|submit|let (?:me|us|the school) know|must be|should be|needs? to be)\b|£\s?\d/i;
const DUE_IS = /\b(deadline|due date|closing date)\s+(?:is|will be)\b/i;
const DAY_NAME = String.raw`(mon|tues|wednes|thurs|fri|satur|sun)day`;
const WEEKLY_DAYS = new RegExp(
  String.raw`\b(every|each)\s+${DAY_NAME}\b|\b(mon|tues|wednes|thurs|fri|satur|sun)days\b`,
  "i",
);
const BY_WEEKDAY = new RegExp(String.raw`\bby\s+(?:this\s+|next\s+)?${DAY_NAME}\b`, "i");
const THIS_WEEK_DAY = new RegExp(String.raw`\b${DAY_NAME}\s+this\s+week\b`, "i");
const ONE_DAY = new RegExp(
  String.raw`\b(?:on|this|next|by|until|till)\s+${DAY_NAME}\b|^(?:(?:and|also|but|so)\s+)?${DAY_NAME}\s+(?:is|will be|we|there)\b`,
  "i",
);
const DAY_ORD =
  /\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)\w*\.?\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;
const CROSS_MONTH = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+` +
    MON +
    String.raw`\s*(?:-|–|to|until)\s*(\d{1,2})(?:st|nd|rd|th)?\s+` +
    MON +
    String.raw`\b`,
  "i",
);
const INSTEAD = new RegExp(
  String.raw`\b(?:instead of|rather than|not on|no longer on|moved from)\s+(?:${DAY_NAME}s?(?:\s*(?:,|and|or)\s*)?)+`,
  "gi",
);
const NUMERIC_DATE = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/;
const SUBJECT =
  /^(?:(?:the|our|your|a|an|this year's|next week's)\s+)?(.{2,48}?)\s+(?:is|are|will be|will now be|will take place|takes? place|starts?|runs?|meets?|moves?|is moved|has moved|changes?|will run|must|should|needs? to|has been|have been)\b/i;
const SALUTATION =
  /^(?:dear\s+[^,]{2,30},\s*|(?:hi|hiya|hello|hey)(?:\s+(?:all|everyone|everybody|parents|parents\/carers))?[!,.]?\s*|(?:(?:a\s+(?:quick\s+|friendly\s+|gentle\s+|little\s+)?)?reminder|don't forget|please note|also|just a (?:heads up|reminder|note))\s*[:,!–-]?\s+(?:that\s+)?)+/i;
const LEAD_TIME = /^(?:from|starting|as of|after|until)\s+[^,]{2,30},\s*/i;
const WHEN_FIRST =
  /^(?:tomorrow|today|tonight|next week|this week|this weekend|on\s+\w+day|\w+day)\s*,?\s+/i;
const DATE_WORD_SUBJECT =
  /^(?:tomorrow|today|tonight|next week|this week|this weekend|\w+day)\s+(?:is|will be)\s+(.{3,60}?)[.!]?$/i;
const PRONOUN = /^(?:we|you|they|it|he|she|i|there|this|that|everyone|anyone|nobody)$/i;
const EVENT_WORDS =
  "birthday party|party|trip|festival|fair|sale|assembly|performance|concert|play|disco|show|match|tournament|visit|appointment|check-up|vaccinations?|photos?|service|celebration|gala|day|evening|training|club|lessons?|tests?|workshop|meeting";
const EVENT_NOUN = new RegExp(String.raw`\b(${EVENT_WORDS})\b`, "i");
const NOUN_PHRASE = new RegExp(
  String.raw`((?:[A-Za-z0-9][\w'’-]*\s+){0,4}?)(${EVENT_WORDS})\b`,
  "i",
);
const THING_PHRASE =
  /\b((?:[\w-]+\s+){0,3}?(?:consent form|reply slip|permission slip|form|slip|payment|order|booking))\b/i;
const DAY_AND_DAY = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:and|&|,)\s*\d{1,2}(?:st|nd|rd|th)?\s+` +
    MON +
    String.raw`\b`,
  "i",
);
const NEEDED = /^(.{3,60}?)\s+(?:needed|required)[.!]?$/i;
const LINE_LABEL = /^([A-Z][\w' -]{2,40}?):\s+/;
const LEADING_STOP =
  /^(?:(?:is|are|the|our|a|an|to|for|in|on|at|of|we|you|your|their|his|her|with|and|delighted|invite|invited|join|us)\s+)+/i;
const GENERIC_LABEL =
  /(?:^|\s)(?:reminders?|notes?|updates?|important|ps|fyi|re|fwd|urgent|news|newsletter|notice|info|information|announcement|message)$/i;
const ASKED_ABOUT =
  /\b(?:when|what time|what day|what date|where)(?:'s|\s+is|\s+are|\s+will)?\s+(?:the\s+|our\s+|this\s+|that\s+)?([\w'’ -]{2,40}?)(?:\s+(?:is|are|be|on|happening|starting|starts?))?\s*\?/i;
const INVITE =
  /\b(?:would|can|could|does|do|will)\s+[\w'’-]+\s+(?:like|want|fancy|be able)\s+to\s+((?:come|go|join|play)\b[^?.!]{0,40}?)(?=\s+(?:on|this|next|at|from|after|tomorrow|today|tonight)\b|[?.!,]|$)/i;
const PASSIVE =
  /\b(?:are|is|must be|should be|can be|to be|be)\s+(requested|ordered|booked|returned|paid|placed|submitted|completed|signed|sent|handed in|collected)\b(.{0,50}?)(?=\s+(?:by|before|no later than|until)\b|[.,;]|$)/i;
const DO_IT: Record<string, string> = {
  requested: "Request",
  ordered: "Order",
  booked: "Book",
  returned: "Return",
  paid: "Pay",
  placed: "Place",
  submitted: "Submit",
  completed: "Complete",
  signed: "Sign",
  sent: "Send",
  "handed in": "Hand in",
  collected: "Collect",
};
const DATE_FIRST = new RegExp(
  String.raw`^(?:on\s+)?(?:${DAY_NAME}\s+)?(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?` +
    MON +
    String.raw`\b(?:\s+\d{4})?\s*,?\s+`,
  "i",
);
const GROUP =
  /^(?:year\s*\d{1,2}|y\d{1,2}|class\s*[\w-]+|reception|nursery|p\d|primary\s*\d|key stage \d|ks\d|all classes|(?:the\s+)?(?:children|pupils|students|kids|class))$/i;
const ACTIVITY =
  /^\s*((?:visiting|going (?:on|to)|travelling to|heading (?:off )?to|off to|taking part in|competing in|performing (?:at|in))\s.{2,60}?)(?=\s+(?:as part of|because|so that|for (?:the|their|a)|on (?:mon|tues|wednes|thurs|fri|satur|sun)|at \d|from \d|this|next|and will)\b|[.,!;(]|$)/i;

function timeIn(s: string): string {
  const re = new RegExp(TIME_RE.source, "gi");
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!/[£$€]\s?$/.test(s.slice(0, m.index))) return m[0].trim(); // "£8.50" is money, not a time
  }
  return "";
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** What to bring, word for word: "Children need a packed lunch…", "Grip socks needed!". Not a call for help. */
function prepIn(sents: string[], skip: string): string {
  for (const other of sents) {
    if (other === skip || DAY_MON.test(other) || MON_DAY.test(other)) continue;
    const pm = prepExec(other);
    const got = pm ? pm[1].trim().replace(/\.$/, "") : (NEEDED.exec(other)?.[1] || "").trim();
    if (got && !/\b(volunteers?|helpers?|please|sign up|help|you to|parents to)\b/i.test(got))
      return got;
  }
  return "";
}

/** What the event is, in the message's words: "our Year 1 Christmas performance" -> "Year 1 Christmas performance". */
function eventPhrase(s: string): string {
  const m = NOUN_PHRASE.exec(s);
  if (!m) return "";
  const phrase = (m[1] + m[2]).replace(LEADING_STOP, "").trim();
  if (!(
    phrase.split(/\s+/).length >= 2 ||
    /^(?:party|trip|festival|fair|sale|assembly|performance|concert|disco|gala|appointment)$/i.test(
      phrase,
    )
  ))
    return "";
  const after = s.slice(m.index + m[0].length);
  const sale = /^\s+(tickets?|sign-?ups?|bookings?|registration)\b/i.exec(after); // "school disco tickets go on sale"
  return sale
    ? `${phrase} ${sale[1].toLowerCase()}${/^\s+\S+\s+(?:go\s+|are\s+)?on sale\b/i.test(after) ? " on sale" : ""}`
    : phrase;
}

/** A short name: the action asked for, the heading or label above it, the sentence's subject, or what an event is
 *  ("Maya's party"), in the message's own words. */
function nameFor(sn: string, heading: string, forward: boolean, before = "", prev = ""): string {
  const clean = sn.replace(SALUTATION, "").replace(LEAD_TIME, "");
  if (forward) {
    const m =
      /\b(?:please\s+)?((?:return|pay|book|complete|sign|send in|send|rsvp|reply|respond|confirm|bring|order|register|apply|choose|fill in|sign up|submit|let (?:me|us|the school) know)\b.{0,80}?)\s+(?:by|no later than|before)\b/i.exec(
        clean,
      );
    if (m) {
      let act = m[1].replace(/[,;:]+$/, "").trim();
      const ps = /\b(?:it|them)\b/i.test(act)
        ? SUBJECT.exec(prev.replace(SALUTATION, "").replace(WHEN_FIRST, ""))
        : null;
      const what = ps ? ps[1].replace(/^(?:the|our|your)\s+/i, "").trim() : "";
      if (
        what &&
        what.split(/\s+/).length <= 4 &&
        !PRONOUN.test(what) &&
        clean.toLowerCase().includes(what.toLowerCase())
      ) {
        act = act.replace(/\b(?:it|them)\b/i, what); // "order it" -> "order Christmas lunch"
      }
      const whether = /^(?:let (?:me|us|the school) know|reply|respond|confirm)$/i.test(act)
        ? /\b(if|whether)\s+([\w'’]+\s+(?:can|could|is able to|would like to|will)\s+(?:make it|come|attend|join(?: us)?))\b/i.exec(
            clean,
          )
        : null;
      return cap(whether ? `${act} ${whether[1].toLowerCase()} ${whether[2]}` : act); // "Let me know if Arjun can make it"
    }
    if (/\brsvp\b/i.test(clean)) return "RSVP";
    const money = /(£\s?\d[\d.,]*\s+(?:on|to|for|via)\s+[\w' ]{2,30}?)\s+(?:by|before)\b/i.exec(
      clean,
    );
    if (money) return "Pay " + money[1].trim();
    const amt = /£\s?\d+(?:[.,]\d{2})?/.exec(clean);
    if (amt && /\bpa(?:y|id|yable|yment)\b/i.test(clean)) {
      // "The cost of the trip is £8.50, … paid on ParentPay …"
      const ev = EVENT_NOUN.exec(clean)?.[1].toLowerCase();
      const via =
        /\b(?:on|via|through|using)\s+((?:the\s+)?(?:[A-Z]\w*Pay\w*|OSM|ParentMail|Arbor|SchoolMoney|Scopay|[Aa]pp|[Ww]ebsite))\b/.exec(
          clean,
        )?.[1];
      return `Pay ${amt[0].replace(/\s/g, "")}${ev ? ` for the ${ev}` : ""}${via ? ` on ${via}` : ""}`;
    }
    const pv = PASSIVE.exec(clean),
      sj = SUBJECT.exec(clean); // "Orders must be placed online by …" -> "Place orders online"
    if (pv && sj && sj[1].split(/\s+/).length <= 4 && !PRONOUN.test(sj[1].trim())) {
      const art = /^(the|your|all)\s/i.exec(clean)?.[1].toLowerCase();
      const obj = sj[1].trim().replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
      return `${DO_IT[pv[1].toLowerCase()]} ${art ? art + " " : ""}${obj}${pv[2].replace(/[,;:]+$/, "")}`.trim();
    }
    if (DUE_IS.test(clean) || !SUBJECT.test(clean)) {
      const thing = THING_PHRASE.exec(clean) || THING_PHRASE.exec(before); // "deadline is this Thursday", after
      if (thing) return cap(thing[1].replace(LEADING_STOP, "").trim()); // "…done the flu spray consent form?"
    }
  }
  if (heading) return heading;
  if (/^(?:it'?s|it is|it will be|its|that'?s|that is)\b/i.test(clean)) {
    // a reply: "it's next Thursday after school!"
    const q = ASKED_ABOUT.exec(prev) || ASKED_ABOUT.exec(before); // … to "when the PTA bake off is?"
    if (q) return cap(q[1].trim());
  }
  const asked = /\?\s*$/.test(clean) // "What do they need for the trip on …?" -> "Trip"
    ? new RegExp(
        String.raw`\b(?:the|our|your|this|a|an)\s+((?:[\w'’-]+\s+){0,2}?(?:${EVENT_WORDS}))\b`,
        "i",
      ).exec(clean)
    : null;
  if (asked && !INVITE.test(clean)) return cap(asked[1]);
  const inv = INVITE.exec(clean); // "Would Zara like to come over to ours … to play?"
  if (inv)
    return cap(
      inv[1].trim() + (/\bto play\b/i.test(clean) && !/\bplay\b/i.test(inv[1]) ? " to play" : ""),
    );
  const dw = DATE_WORD_SUBJECT.exec(clean);
  if (dw) return cap(dw[1].trim()); // "Friday is pyjama day for Children in Need"
  const body = clean.replace(WHEN_FIRST, "").replace(DATE_FIRST, ""); // "On Monday 7th December Year 4 will…"
  const s = SUBJECT.exec(body);
  const act = s ? ACTIVITY.exec(body.slice(s[0].length)) : null;
  if (s && act && (GROUP.test(s[1].trim()) || PRONOUN.test(s[1].trim()))) {
    // a class going somewhere
    const who = s[1].replace(/^(?:that|the|your|our)\s+/i, "").trim();
    return cap(
      PRONOUN.test(who) || /^(?:children|pupils|students|kids|class)$/i.test(who)
        ? act[1]
        : `${who} ${act[1]}`,
    );
  }
  if (s && s[1].split(/\s+/).length <= 7 && !PRONOUN.test(s[1].trim())) {
    const subj = s[1].replace(/^(?:that|the|your|our)\s+/i, "").trim();
    const ev = EVENT_NOUN.exec(body);
    if (
      /^[A-Z][a-z]+$/.test(subj) &&
      ev &&
      new RegExp(`\\b(?:her|his|their)\\s+${ev[1]}`, "i").test(body)
    ) {
      return `${subj}'s ${ev[1].toLowerCase()}`; // "Maya is turning 7 … her party" -> "Maya's party"
    }
    return cap(subj);
  }
  const ev = eventPhrase(body);
  if (ev) return cap(ev); // "We are delighted to invite you to our … performance"
  const w = body
    .replace(
      /\s+(?:on|by|from|[-–])\s+(?:\w+day\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s+\w+|\/\d{1,2}(?:\/\d{2,4})?).*$/i,
      "",
    )
    .replace(/[?!.]+$/, "")
    .split(/\s+/)
    .filter(Boolean);
  return (
    cap(
      w
        .slice(0, 8)
        .join(" ")
        .replace(/[,.;:!]+$/, ""),
    ) + (w.length > 8 ? "…" : "")
  );
}

function closureName(sn: string, heading: string, prev = ""): string {
  if (heading) return heading;
  const m =
    /\b((?:christmas |easter |summer |october |february |may )?half[- ]term|inset day|in-service day|training day|bank holiday|(?:christmas|easter|summer) holidays?)\b/i.exec(
      sn,
    );
  if (m) return cap(m[1].toLowerCase()).replace(/\binset\b/i, "INSET");
  const no = NO_SESSION.exec(sn); // "No meeting on 22nd December", after "Brownies meets…"
  if (no) {
    const what = no[1].toLowerCase();
    const who =
      /^([A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+){0,2})\s+(?:meets?|is|are|runs?|will|starts?|takes?|practi[cs]es?|trains?)\b/.exec(
        prev.replace(SALUTATION, ""),
      )?.[1] || "";
    return who &&
      !PRONOUN.test(who) &&
      /^(?:meeting|session|club|class|lessons?|practice|activities|training)$/.test(what) &&
      !new RegExp(`\\b${escapeRx(who)}\\b`, "i").test(sn)
      ? `No ${who} ${what}`
      : `No ${what}`;
  }
  const s = SUBJECT.exec(sn.replace(SALUTATION, "").replace(LEAD_TIME, ""));
  const subj =
    s && !PRONOUN.test(s[1].trim()) && s[1].split(/\s+/).length <= 5
      ? s[1]
          .replace(/^(?:the|our|your)\s+/i, "")
          .replace(/\s+(?:planned|scheduled|due|booked|arranged|organi[sz]ed)\b.*$/i, "") // "flu vaccinations planned for
          .replace(/\s+(?:on|for|this|next|tomorrow|today|tonight)\b.*$/i, "")
          .trim()
      : ""; //  tomorrow" -> "flu vaccinations"
  const word =
    /\b(cancell?ed|called off|postponed)\b/i
      .exec(sn)?.[1]
      .toLowerCase()
      .replace("canceled", "cancelled") || "closed";
  if (subj) return `${cap(subj)} ${word}`; // "Nursery closed", "Football training cancelled"
  return /\bschool\b/i.test(sn) ? `School ${word}` : cap(word);
}

/** The ref date a sentence's days count from (its WhatsApp message's date, else today). */
function dayOrd(sn: string, ref: string): string {
  const m = DAY_ORD.exec(sn);
  if (!m) return "";
  const want = Number(m[2]),
    wday = wd(m[1]);
  let fallback = "";
  for (let i = 0; i <= 62; i++) {
    // "Thurs 26th": the next 26th that is a Thursday
    const d = addDays(ref, i);
    if (Number(d.slice(8, 10)) !== want) continue;
    if (weekdayOf(d) === wday) return `${want} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
    fallback = fallback || `${want} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
  }
  return fallback;
}

function blocksOf(body: string): string[] {
  const out: string[] = [];
  for (const para of body.split(/\n{2,}|\n(?=\[?\d{1,2}\/\d{1,2}\/\d{2,4})/)) {
    const lines = para
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (
      lines.length >= 2 &&
      lines.filter((l) => l.length <= 100 && !/[.!?]$/.test(l)).length >= lines.length - 1
    ) {
      out.push(...lines); // a list ("Christmas holidays: 21 December - 1 January")
    } else out.push(para);
  }
  return out;
}

/** Proposals from rules alone, for checkItems. today: for days like "Thurs 26th" (else the message's own date). */
export function rulesFind(text: string, today = ""): Raw[] {
  const out: Raw[] = [];
  const head = MAIL_HEAD.exec(text);
  const body = head ? text.slice(head[0].length) : text;
  let before = "";
  for (const block of blocksOf(body)) {
    const sents = sentences(block);
    const pos = text.indexOf(block.slice(0, 40));
    const ref = today ? refDateFor(text, pos >= 0 ? pos : 0, today) : "";
    sents.forEach((sn, i) => {
      const prev = i > 0 ? sents[i - 1] : "";
      let heading =
        /^[A-Z][\w' -]{2,30}\.$/.test(prev) && prev.split(/\s+/).length <= 6 && !DAY_MON.test(prev)
          ? prev.replace(/\.$/, "")
          : "";
      const label = LINE_LABEL.exec(sn);
      const generic = !!label && GENERIC_LABEL.test(label[1]); // "Reminder:", "Beavers update:", "PTA news:"
      if (label && label[1].split(/\s+/).length <= 5 && !generic) heading = heading || label[1];
      const named = generic ? sn.slice(label![0].length) : sn; // named from what follows such a label
      const names = new Set(
        [...sn.matchAll(new RegExp(String.raw`\b${DAY_NAME}s?\b`, "gi"))].map((x) =>
          x[1].toLowerCase(),
        ),
      );
      const single = names.size === 1 && ONE_DAY.test(sn);
      const ord = ref ? dayOrd(sn, ref) : "";
      const dated =
        DAY_MON.test(sn) ||
        MON_DAY.test(sn) ||
        RELATIVE.test(sn) ||
        NUMERIC_DATE.test(sn) ||
        BY_WEEKDAY.test(sn) ||
        THIS_WEEK_DAY.test(sn) ||
        single ||
        !!ord;
      if (WEEKLY_DAYS.test(sn) && !THIS_WEEK_DAY.test(sn)) {
        const kept = sn.replace(INSTEAD, " ");
        if (!new RegExp(String.raw`\b${DAY_NAME}`, "i").test(kept)) return;
        out.push({
          type: "weekly",
          title: nameFor(named.replace(INSTEAD, " "), heading, false),
          child: "",
          when: kept,
          time: timeIn(sn),
          prep: prepIn(sents, sn),
          quote: sn,
          rules: true,
        });
        return;
      }
      if (
        !dated ||
        (names.size > 1 && !(DAY_MON.test(sn) || MON_DAY.test(sn) || NUMERIC_DATE.test(sn)))
      )
        return;
      const closure = CLOSED.test(sn) && !OPENS.test(sn);
      const forward = !closure && (DUE_IS.test(sn) || (DEADLINE.test(sn) && ACTION.test(sn)));
      const explicit = DAY_MON.test(sn) || MON_DAY.test(sn) || NUMERIC_DATE.test(sn);
      const list = DAY_AND_DAY.exec(sn),
        cross = CROSS_MONTH.exec(sn);
      const when = cross
        ? `${cross[1]} ${cross[2]} to ${cross[3]} ${cross[4]}` // "21 December - 1 January"
        : list
          ? `${list[1]} ${list[2]}` // "on 9 and 10 December": from the first
          : explicit
            ? ""
            : ord ||
              BY_WEEKDAY.exec(sn)?.[0] ||
              THIS_WEEK_DAY.exec(sn)?.[0] ||
              ONE_DAY.exec(sn)?.[0] ||
              "";
      out.push({
        type: closure ? "closure" : forward ? "forward" : "event",
        title: closure
          ? closureName(named, heading, prev)
          : nameFor(named, heading, forward, before, prev),
        child: "",
        when,
        time: closure ? "" : timeIn(sn),
        prep: forward || closure ? "" : prepIn(sents, sn),
        quote: sn,
        rules: true,
      });
    });
    before = block;
  }
  return out;
}

// ------------------------------------------------------------------------------------------- Apple's model
/** What the app's native plugin gives Apple's on-device model with each part of a message (it has room for about
 *  4,096 tokens in all, so it gets one part at a time, and these instructions are kept short). */
export const MODEL_INSTRUCTIONS = `You read one message a parent shared: a school newsletter, a class WhatsApp group, a club email, a letter or an invitation.
List everything that affects their days or their children's days. Types:
- weekly: repeats on certain weekdays ("PE on Tuesdays and Thursdays").
- event: a one-off on a day (trip, dress-up day, sale, parents' evening, party, appointment).
- forward: something to DO by a deadline (pay, sign, return, book, RSVP, reply).
- closure: no school or no club (in-service day, holidays, closed).
For each item:
- title: a few words ("Class trip to the Science Centre", "Pay £12 and return the consent form").
- child: the child's name only if the quote names them, else "".
- when: COPY the exact words that say when ("Wednesday 2 December", "Tuesdays and Thursdays", "by Friday"). Never write a date yourself.
- time: copy any time given, else "".
- prep: what to bring or wear, only as the message says it, else "".
- quote: copy the sentence it comes from, exactly, at most 40 words.
Ignore thanks, chit-chat, adverts and signatures.`;

/** The shape the model fills (the plugin's Swift types mirror it, with @Generable). */
export const MODEL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["weekly", "event", "forward", "closure"] },
          title: { type: "string" },
          child: { type: "string" },
          when: { type: "string" },
          time: { type: "string" },
          prep: { type: "string" },
          quote: { type: "string" },
        },
        required: ["type", "title", "child", "when", "time", "prep", "quote"],
      },
    },
  },
  required: ["items"],
};

/** A long message in parts the model can read whole (paragraphs kept together; about 1,250 tokens each by default,
 *  which leaves room in a 4,096-token window for the instructions, the shape it fills and its answer). */
export function chunksOf(text: string, maxChars = 5000): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    const p = para.length > maxChars ? para.slice(0, maxChars) : para;
    if (cur && cur.length + p.length + 2 > maxChars) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ------------------------------------------------------------------------------------------- one message, start to end
export interface Found {
  id: string;
  type: "weekly" | "event" | "forward" | "closure";
  title: string;
  child: string;
  date: string;
  endDate: string;
  weekdays: number[];
  time: string;
  bring: string;
  quote: string;
  needsDate: boolean;
  foundBy: "model" | "rules" | "date check";
}

/** The model, through the app's native plugin: one part of a message in, raw proposals out (or it throws). */
export type ModelCall = (part: string, instructions: string) => Promise<Raw[]>;

function samish(a: Item, b: Item): boolean {
  if (a.type === "weekly" || b.type === "weekly") {
    return a.type === b.type && JSON.stringify(a.weekdays) === JSON.stringify(b.weekdays);
  }
  if (!a.date || a.date !== b.date) return false;
  const x = contentStems(a.title);
  for (const s of contentStems(b.title)) if (x.has(s)) return true;
  return norm(a.quote) === norm(b.quote);
}

/** Everything one message asks of you, as proposals. With model, Apple's model proposes first and the rules only
 *  add what it missed; without it (or if it fails), the rules do it all. */
export async function findInMessage(
  text: string,
  opts: { today: string; children?: string[]; model?: ModelCall | null },
): Promise<{ items: Found[]; rejected: { title: string; why: string }[]; usedModel: boolean }> {
  const children = opts.children || [];
  let raw: Raw[] = [],
    usedModel = false;
  if (opts.model) {
    for (const size of [5000, 2500]) {
      // too long for its window: again in smaller parts
      try {
        raw = [];
        for (const part of chunksOf(text, size))
          raw = raw.concat(await opts.model(part, MODEL_INSTRUCTIONS));
        usedModel = true;
        break;
      } catch (e) {
        if (!/context|too long|exceeded/i.test(String((e as Error)?.message || e))) break; // not that: the rules alone
      }
    }
    if (!usedModel) raw = [];
  }
  const byModel = usedModel
    ? checkItems(raw, text, children, opts.today)
    : { items: [], rejected: [] };
  const dayish = (q: string) =>
    DAY_MON.test(q) ||
    MON_DAY.test(q) ||
    RELATIVE.test(q) ||
    WD_RE.test(q) ||
    NUMERIC_DATE.test(q) ||
    /\b(today|tonight|tomorrow|next week|this week|weekend|month|term)\b/i.test(q);
  byModel.items = byModel.items.filter(
    (i) => !(i.needs === "date" && i.type !== "forward" && !dayish(i.quote)),
  ); // an advert
  const byRules = checkItems(rulesFind(text, opts.today), text, children, opts.today);
  const kept: Item[] = byModel.items.filter((i) => i.found_by !== "date check");
  const fromModel = new Set(kept.map((i) => i.id));
  for (const it of byRules.items.filter((i) => i.found_by !== "date check")) {
    if (!kept.some((k) => samish(k, it))) kept.push(it); // what the model missed
  }
  const listed: string[] = []; // "on 9 and 10 December": one item, both days
  for (const it of kept) {
    for (const m of all(
      String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:and|&|,)\s*(\d{1,2})(?:st|nd|rd|th)?\s+` +
        MON +
        String.raw`\b`,
      "i",
      it.quote,
    )) {
      const d = parseWhen(`${m[2]} ${m[3]}`, it.date || opts.today).date;
      if (d) listed.push(d);
    }
  }
  for (const it of sweepDates(text, kept, opts.today, listed)) kept.push(it); // every dated sentence surfaces
  const items: Found[] = kept.map((i) => ({
    id: i.id,
    type: i.type as Found["type"],
    title: i.title,
    child: i.child,
    date: i.date || "",
    endDate: i.end_date || "",
    weekdays: i.weekdays || [],
    time: i.time,
    bring: i.prep,
    quote: i.quote,
    needsDate: i.needs === "date",
    foundBy: i.found_by === "date check" ? "date check" : fromModel.has(i.id) ? "model" : "rules",
  }));
  return { items, rejected: byModel.rejected, usedModel };
}

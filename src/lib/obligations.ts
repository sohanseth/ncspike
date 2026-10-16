/**
 * Evening brief — rules-only obligation extraction (no AI, runs in the browser).
 *
 * Reads short text (email subject + snippet, or a task) and pulls out
 * "things to prepare, book, buy or reply to" with a due date.
 *   - kind "tonight": prep for tomorrow (kit, bring, wear, pack…)
 *   - kind "ahead":   book / buy / reply / pay while there's still time
 * Children's names are stored locally and can be swapped for CHILD_1 tokens
 * before any text ever leaves the device.
 */
import { useCallback, useEffect, useState } from "react";

export type ObligationKind = "tonight" | "ahead";

export interface Obligation {
  id: string;
  title: string;
  due: string | null; // YYYY-MM-DD
  kind: ObligationKind;
  child: string | null;
  source: "email" | "task";
  sourceLabel: string;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const PREP = /\b(bring|wear|pack|kit|uniform|pe kit|swim(ming)? kit|packed lunch|costume|non[- ]uniform|show and tell|sign(ed)? (the )?(form|slip)|permission slip|homework|reading book|put by the door|remember)\b/i;
const AHEAD = /\b(book|booking|buy|order|reply|rsvp|respond|pay|payment|register|sign up|deadline|due|renew|submit|confirm|tickets?|by (mon|tue|wed|thu|fri|sat|sun)|closes)\b/i;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Find the first date mentioned in text, relative to `now`. */
export function findDate(text: string, now = new Date()): string | null {
  const t = text.toLowerCase();
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/\btoday|tonight\b/.test(t)) return iso(base);
  if (/\btomorrow\b/.test(t)) return iso(new Date(base.getTime() + 864e5));

  // "12 June", "12th jun"
  let m = t.match(/\b(\d{1,2})(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (m) return monthDay(base, MONTHS.indexOf(m[3]), Number(m[1]));
  // "June 12"
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(st|nd|rd|th)?\b/);
  if (m) return monthDay(base, MONTHS.indexOf(m[1]), Number(m[2]));
  // "12/06" (UK day/month)
  m = t.match(/\b(\d{1,2})\/(\d{1,2})(\/\d{2,4})?\b/);
  if (m && Number(m[2]) <= 12) return monthDay(base, Number(m[2]) - 1, Number(m[1]));
  // weekday names → next occurrence (today counts if "this")
  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(next |this )?${WEEKDAYS[i]}s?\\b`);
    const wm = t.match(re);
    if (wm) {
      let diff = (i - base.getDay() + 7) % 7;
      if (diff === 0 && wm[1] === "next ") diff = 7;
      return iso(new Date(base.getTime() + diff * 864e5));
    }
  }
  return null;
}

function monthDay(base: Date, month: number, day: number): string | null {
  if (month < 0 || day < 1 || day > 31) return null;
  let d = new Date(base.getFullYear(), month, day);
  if (d.getTime() < base.getTime() - 30 * 864e5) d = new Date(base.getFullYear() + 1, month, day);
  return iso(d);
}

/** Returns an obligation if the text looks like one, else null. */
export function extractObligation(
  input: { id: string; text: string; source: "email" | "task"; sourceLabel: string },
  children: string[],
  now = new Date(),
): Obligation | null {
  const { text } = input;
  const prep = PREP.test(text);
  const ahead = AHEAD.test(text);
  if (!prep && !ahead) return null;
  const due = findDate(text, now);
  const tomorrow = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const today = iso(now);
  const kind: ObligationKind = prep && (!due || due <= tomorrow) && due !== null && due >= today ? "tonight" : prep && !ahead && !due ? "tonight" : "ahead";
  const child = children.find((c) => c && new RegExp(`\\b${escapeRe(c)}\\b`, "i").test(text)) ?? null;
  const title = (text.length <= 90 ? text : text.split(/\s[—–-]\s|\n/)[0]).trim().slice(0, 140);
  return { id: input.id, title, due, kind, child, source: input.source, sourceLabel: input.sourceLabel };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Swap children's names for CHILD_n tokens (and back). */
export function pseudonymise(text: string, children: string[]) {
  let out = text;
  children.forEach((name, i) => {
    if (name) out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, "gi"), `CHILD_${i + 1}`);
  });
  return out;
}
export function restoreNames(text: string, children: string[]) {
  return text.replace(/CHILD_(\d+)/g, (m, n) => children[Number(n) - 1] ?? m);
}

/** Plain-text brief, suitable for WhatsApp. */
export function briefText(items: Obligation[], now = new Date()) {
  const tonight = items.filter((o) => o.kind === "tonight");
  const ahead = items.filter((o) => o.kind === "ahead");
  const line = (o: Obligation) => `• ${o.child ? `${o.child}: ` : ""}${o.title}${o.due ? ` (${fmt(o.due, now)})` : ""}`;
  const parts = [`Evening brief — ${now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })}`];
  parts.push("", "Tonight, get ready:", ...(tonight.length ? tonight.map(line) : ["• Nothing — enjoy the evening"]));
  if (ahead.length) parts.push("", "Plan ahead:", ...ahead.map(line));
  return parts.join("\n");
}

export function fmt(due: string, now = new Date()) {
  const d = new Date(due + "T00:00:00");
  const days = Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 864e5);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return "overdue";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const CHILD_KEY = "nc.children.v1";
export function useChildren() {
  const [children, setChildren] = useState<string[]>([]);
  useEffect(() => {
    try { setChildren(JSON.parse(localStorage.getItem(CHILD_KEY) ?? "[]")); } catch { /* ignore */ }
  }, []);
  const save = useCallback((next: string[]) => {
    const clean = next.map((s) => s.trim()).filter(Boolean);
    setChildren(clean);
    localStorage.setItem(CHILD_KEY, JSON.stringify(clean));
  }, []);
  return { children, setChildren: save };
}

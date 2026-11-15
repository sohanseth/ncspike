"use client";
// Browser-only module: reads/writes the AES-GCM keys for the Mac app's
// encrypted cards. Call this only from effects/handlers — never from a
// server function or at module scope, since it needs `indexedDB` and
// `crypto.subtle`, which only exist in the browser.
import { insightCardSchema } from "@/lib/insight-card.schema";
import type { InsightCard } from "@/lib/insight-card";
import { listRelayCards } from "@/lib/relay.functions";
import { sendRelayAnswer } from "@/lib/relay-answers.functions";
import { listRelayLists } from "@/lib/relay-lists.functions";
import { macListsDocumentSchema, type RelayListsRow } from "@/lib/relay-lists-schema";
import { z } from "zod";

const DB_NAME = "nc-keys";
const STORE = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/** The CryptoKey stored under `kid`, or null. Never export or log it. */
export async function getKey(kid: string): Promise<CryptoKey | null> {
  try {
    const db = await openDb();
    const key = await new Promise<CryptoKey | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(kid);
      req.onsuccess = () => resolve((req.result as CryptoKey | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return key;
  } catch {
    return null;
  }
}

async function putKey(kid: string, key: CryptoKey): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(key, kid);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type RelayCardRow = {
  device_id: string;
  key_id: string;
  ref: string;
  nonce: string;
  ciphertext: string;
  ord: number;
  expires_at: string;
};

/** Decrypts one relay row into an InsightCard, or null. Never throws into the UI, never logs the plaintext. */
export async function decryptCard(row: Pick<RelayCardRow, "nonce" | "ciphertext" | "key_id" | "ref">, key: CryptoKey): Promise<InsightCard | null> {
  try {
    const iv = base64ToBytes(row.nonce);
    const ciphertext = base64ToBytes(row.ciphertext);
    const additionalData = new TextEncoder().encode(`nc-card-v1|${row.key_id}|${row.ref}`);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, ciphertext);
    const text = new TextDecoder().decode(plain).trim();
    const json = JSON.parse(text);
    const parsed = insightCardSchema.safeParse(json);
    if (!parsed.success) return null;
    if (parsed.data.origin !== "mac") return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** listRelayCards(), decrypted with whatever keys this browser has. Keeps server order. */
export type MacCard = InsightCard & { row: Pick<RelayCardRow, "device_id" | "key_id" | "ref" | "nonce"> };
export async function loadMacCards(): Promise<{ cards: MacCard[]; missingKey: boolean }> {
  let rows: RelayCardRow[];
  try {
    rows = (await listRelayCards()) as unknown as RelayCardRow[];
  } catch {
    return { cards: [], missingKey: false };
  }
  const cards: MacCard[] = [];
  let missingKey = false;
  const keyCache = new Map<string, CryptoKey | null>();
  for (const row of rows) {
    let key = keyCache.get(row.key_id);
    if (key === undefined) {
      key = await getKey(row.key_id);
      keyCache.set(row.key_id, key);
    }
    if (!key) {
      missingKey = true;
      continue;
    }
    const card = await decryptCard(row, key);
    if (card) cards.push({ ...card, row: { device_id: row.device_id, key_id: row.key_id, ref: row.ref, nonce: row.nonce } });
  }
  return { cards, missingKey };
}

/** Saves a key pasted from a link like https://<site>/link#k=...&kid=.... Never sends the text anywhere or logs it. */
export async function saveKeyFromLink(text: string): Promise<boolean> {
  try {
    const hashIndex = text.indexOf("#");
    if (hashIndex === -1) return false;
    const p = new URLSearchParams(text.slice(hashIndex + 1));
    const k = p.get("k") || "";
    const kid = p.get("kid") || "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(k) || !/^[0-9a-f]{8}$/.test(kid)) return false;
    const raw = atob(k.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = raw.charCodeAt(i);
    const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    bytes.fill(0);
    await putKey(kid, key);
    return true;
  } catch {
    return false;
  }
}

export type MacAnswer = { v: 1; id: string; ref: string; action: string; at: string };
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export function makeAnswer(ref: string, action: string): MacAnswer {
  return {
    v: 1,
    id: toBase64(crypto.getRandomValues(new Uint8Array(16))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    ref,
    action,
    at: new Date().toISOString().slice(0, 19) + "Z",
  };
}
export async function encryptAnswer(answer: MacAnswer, key: CryptoKey, keyId: string, nonce: Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(answer));
  if (bytes.length > 256 || nonce.length !== 12) throw new Error("bad_answer");
  const plaintext = new Uint8Array(256).fill(0x20);
  plaintext.set(bytes);
  const additionalData = new TextEncoder().encode(`nc-answer-v1|${keyId}|${answer.ref}`);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData }, key, plaintext);
  return toBase64(new Uint8Array(encrypted));
}
export function canAnswer(key: CryptoKey | null): boolean { return key?.usages.includes("encrypt") ?? false; }
export async function answerCard(row: MacCard["row"], action: string) {
  const key = await getKey(row.key_id);
  if (!key || !canAnswer(key)) return { needsScan: true as const };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await encryptAnswer(makeAnswer(row.ref, action), key, row.key_id, nonce);
  return sendRelayAnswer({ data: { deviceId: row.device_id, keyId: row.key_id, ref: row.ref, nonce: toBase64(nonce), ciphertext } });
}

export async function openMacLists(row: RelayListsRow) {
  const key = await getKey(row.key_id);
  if (!key) return { needsScan: true as const };
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(row.nonce), additionalData: new TextEncoder().encode(`nc-lists-v1|${row.key_id}`) }, key, base64ToBytes(row.ciphertext));
    const parsed = macListsDocumentSchema.passthrough().safeParse(JSON.parse(new TextDecoder().decode(plain).replace(/ +$/, "")));
    return parsed.success ? { doc: parsed.data, row } : null;
  } catch { return null; }
}
export async function loadMacLists() {
  const rows = await listRelayLists();
  for (const row of rows) {
    const opened = await openMacLists(row);
    if (opened && "doc" in opened) return opened;
  }
  return rows.length ? { needsScan: true as const } : null;
}
export async function tickMacItem(row: RelayListsRow, ref: string) {
  const key = await getKey(row.key_id);
  if (!key || !canAnswer(key)) return { needsScan: true as const };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await encryptAnswer(makeAnswer(ref, "tick"), key, row.key_id, nonce);
  return sendRelayAnswer({ data: { deviceId: row.device_id, keyId: row.key_id, ref, nonce: toBase64(nonce), ciphertext } });
}
export function dayWords(due: string, today: string): string {
  if (!due) return "";
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} late`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const date = new Date(`${due}T12:00:00`);
  return days <= 6 ? date.toLocaleDateString("en-GB", { weekday: "short" }) : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const foundDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal(""));
const foundItemSchema = z.object({
  ref: z.string().regex(/^[0-9a-f]{24}$/).nullable(),
  type: z.enum(["weekly", "event", "forward", "closure"]),
  title: z.string().max(200), child: z.string().max(40),
  date: foundDate, endDate: foundDate, time: z.string().max(40),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  needsDate: z.boolean(), from: z.enum(["email", "shared"]), private: z.boolean(),
});
const foundSchema = z.object({ found: z.array(foundItemSchema).max(10), foundMore: z.number().int().min(0).max(1000) });
export type MacFoundItem = z.infer<typeof foundItemSchema>;
export function foundIn(doc: unknown): { items: MacFoundItem[]; more: number } | null {
  if (!doc || typeof doc !== "object" || !("found" in doc)) return null;
  const parsed = foundSchema.safeParse(doc);
  return parsed.success ? { items: parsed.data.found, more: parsed.data.foundMore } : null;
}
export async function answerFound(row: RelayListsRow, ref: string, action: "add" | "skip") {
  const key = await getKey(row.key_id);
  if (!key || !canAnswer(key)) return { needsScan: true as const };
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await encryptAnswer(makeAnswer(ref, action), key, row.key_id, nonce);
  return sendRelayAnswer({ data: { deviceId: row.device_id, keyId: row.key_id, ref, nonce: toBase64(nonce), ciphertext } });
}
export function foundWhen(item: MacFoundItem, today: string): string {
  if (item.needsDate) return "No date yet";
  if (item.type === "weekly") {
    const names = item.weekdays.map(day => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]);
    return `Every ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("")}`;
  }
  if (!item.date) return "";
  const start = new Date(`${item.date}T12:00:00`);
  const format = (date: Date, options: Intl.DateTimeFormatOptions) => date.toLocaleDateString("en-GB", options);
  const relative = dayWords(item.date, today);
  const date = relative === "today" || relative === "tomorrow" ? relative : format(start, { weekday: "short", day: "numeric", month: "short" });
  if (item.type === "closure" && item.endDate > item.date) {
    const end = new Date(`${item.endDate}T12:00:00`);
    return item.date.slice(0, 7) === item.endDate.slice(0, 7)
      ? `${start.getDate()}–${format(end, { day: "numeric", month: "short" })}`
      : `${format(start, { day: "numeric", month: "short" })} – ${format(end, { day: "numeric", month: "short" })}`;
  }
  if (item.type === "forward") return `By ${date}`;
  return item.type === "event" && item.time ? `${date} · ${item.time}` : date;
}

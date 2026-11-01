"use client";
// Browser-only module: reads/writes the AES-GCM keys for the Mac app's
// encrypted cards. Call this only from effects/handlers — never from a
// server function or at module scope, since it needs `indexedDB` and
// `crypto.subtle`, which only exist in the browser.
import { insightCardSchema } from "@/lib/insight-card.schema";
import type { InsightCard } from "@/lib/insight-card";
import { listRelayCards } from "@/lib/relay.functions";
import { sendRelayAnswer } from "@/lib/relay-answers.functions";

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

"use client";
// Browser-only module: reads/writes the AES-GCM keys for the Mac app's
// encrypted cards. Call this only from effects/handlers — never from a
// server function or at module scope, since it needs `indexedDB` and
// `crypto.subtle`, which only exist in the browser.
import { insightCardSchema } from "@/lib/insight-card.schema";
import type { InsightCard } from "@/lib/insight-card";
import { listRelayCards } from "@/lib/relay.functions";

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
  key_id: string;
  ref: string;
  nonce: string;
  ciphertext: string;
  ord: number;
  expires_at: string;
};

/** Decrypts one relay row into an InsightCard, or null. Never throws into the UI, never logs the plaintext. */
export async function decryptCard(row: RelayCardRow, key: CryptoKey): Promise<InsightCard | null> {
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
export async function loadMacCards(): Promise<{ cards: InsightCard[]; missingKey: boolean }> {
  let rows: RelayCardRow[];
  try {
    rows = (await listRelayCards()) as unknown as RelayCardRow[];
  } catch {
    return { cards: [], missingKey: false };
  }
  const cards: InsightCard[] = [];
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
    if (card) cards.push(card);
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
    const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["decrypt"]);
    bytes.fill(0);
    await putKey(kid, key);
    return true;
  } catch {
    return false;
  }
}

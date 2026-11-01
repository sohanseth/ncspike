import { describe, it, expect, vi, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vectors from "./vectors.json";
import { insightCardSchema } from "@/lib/insight-card.schema";
vi.mock("@/lib/relay.functions", () => ({ listRelayCards: vi.fn(async () => vectors.examples.map(e => e.row)) }));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => ({ options }) }));
import { getKey, saveKeyFromLink, decryptCard, loadMacCards } from "@/lib/mac-cards";
import { Route } from "@/routes/link";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); });
const importKey = (value: string) => crypto.subtle.importKey("raw", Buffer.from(value, "base64url"), "AES-GCM", false, ["decrypt"]);
describe("Mac cards browser safety", () => {
  it("matches the three cross-app encrypted vectors and fails closed on tampering", async () => {
    const key = await importKey(vectors.key);
    const wrong = await importKey(Buffer.alloc(32).toString("base64url"));
    for (const example of vectors.examples) {
      expect(await decryptCard(example.row, key)).toEqual(example.card);
      expect(await decryptCard({ ...example.row, ref: "different" }, key)).toBeNull();
      expect(await decryptCard({ ...example.row, key_id: "deadbeef" }, key)).toBeNull();
      expect(await decryptCard(example.row, wrong)).toBeNull();
    }
  });
  it("strictly validates schema limits and private-card invariants", () => {
    for (const e of vectors.examples) expect(insightCardSchema.parse(e.card)).toEqual(e.card);
    const c = vectors.examples[0].card;
    for (const patch of [ { unknown: true }, { text: "a".repeat(321) }, { actions: Array(4).fill(c.actions[0]) }, { private: true }, { about: "2026-10-15 15:00" }, { sources: [] }, { sources: ["mac", "mac"] }, { id: "x\ny" }, { actions: [{ ...c.actions[0], unknown: true }] } ]) {
      expect(insightCardSchema.safeParse({ ...c, ...patch }).success).toBe(false);
    }
  });
  it("saves a non-extractable key without network traffic and preserves server order", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    expect(await saveKeyFromLink(`https://example.test/link#k=${vectors.key}&kid=${vectors.keyId}`)).toBe(true);
    const key = await getKey(vectors.keyId);
    expect(key?.extractable).toBe(false);
    expect(key?.usages).toEqual(["encrypt", "decrypt"]);
    for (const bad of ["", "https://example.test/link", "#k=bad&kid=1a2b3c4d", `#k=${vectors.key}&kid=ABCDEF12`]) expect(await saveKeyFromLink(bad)).toBe(false);
    expect(network).not.toHaveBeenCalled();
    expect(await loadMacCards()).toEqual({ cards: vectors.examples.map(e => ({ ...e.card, row: { device_id: undefined, key_id: e.row.key_id, ref: e.row.ref, nonce: e.row.nonce } })), missingKey: false });
    vi.stubGlobal("indexedDB", new IDBFactory());
    expect(await loadMacCards()).toEqual({ cards: [], missingKey: true });
  });
  it("serves an unauthenticated isolated link page with matching fresh nonces", async () => {
    const get = (Route as unknown as { options: { server: { handlers: { GET: () => Promise<Response> } } } }).options.server.handlers.GET;
    const a = await get(), b = await get();
    expect(a.status).toBe(200); expect(a.headers.get("location")).toBeNull();
    expect(a.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(a.headers.get("referrer-policy")).toBe("no-referrer");
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
    const nonce = a.headers.get("content-security-policy")?.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const html = await a.text();
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${nonce}">`); expect(html).toContain(`<style nonce="${nonce}">`);
    expect(a.headers.get("content-security-policy")).not.toBe(b.headers.get("content-security-policy"));
    for (const rule of ["default-src 'none'", "connect-src 'none'", "img-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) expect(a.headers.get("content-security-policy")).toContain(rule);
  });
  it("forbids third-party scripts anywhere in src", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
    for (const path of walk("src").filter(p => /\.(tsx?|jsx?)$/.test(p))) {
      const s = readFileSync(path, "utf8");
      expect(s, path).not.toMatch(/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i);
      expect(s, path).not.toMatch(/\bscripts\s*:\s*\[[\s\S]*?\bsrc\s*:\s*["']https?:\/\//i);
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import vectors from "./found-vectors.json";
import lists from "./lists-vectors.json";
vi.mock("@/lib/relay.functions", () => ({ listRelayCards: vi.fn() }));
vi.mock("@/lib/relay-lists.functions", () => ({ listRelayLists: vi.fn() }));
vi.mock("@/lib/relay-answers.functions", () => ({ sendRelayAnswer: vi.fn(async () => ({ ok: true })) }));
import { sendRelayAnswer } from "@/lib/relay-answers.functions";
import { answerFound, encryptAnswer, foundIn, foundWhen, openMacLists, saveKeyFromLink, type MacFoundItem } from "@/lib/mac-cards";
import { MacFound, pruneFound } from "@/components/workspace/MacFound";
const key = (usage: KeyUsage[] = ["encrypt", "decrypt"]) => crypto.subtle.importKey("raw", Buffer.from(vectors.key, "base64url"), "AES-GCM", false, usage);
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.clearAllMocks();
  await saveKeyFromLink(`#k=${vectors.key}&kid=${vectors.keyId}`);
});
async function encryptedDoc(doc: unknown) {
  const row = vectors.found.row;
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: Buffer.from(row.nonce, "base64"), additionalData: new TextEncoder().encode(`nc-lists-v1|${row.key_id}`) }, await key(), new TextEncoder().encode(JSON.stringify(doc)));
  return { ...row, ciphertext: Buffer.from(ciphertext).toString("base64") };
}
describe("Mac found-items contract", () => {
  it("opens the exact found vector with both new fields and preserves the earlier list vector", async () => {
    expect(await openMacLists(vectors.found.row)).toEqual({ doc: vectors.found.document, row: vectors.found.row });
    expect(await openMacLists(lists.lists.row)).toEqual({ doc: lists.lists.document, row: lists.lists.row });
  });
  it("validates six items and more 2, and treats an absent found field as absent", () => {
    expect(foundIn(vectors.found.document)).toEqual({ items: vectors.found.document.found, more: 2 });
    expect(foundIn(lists.lists.document)).toBeNull();
  });
  it("ignores unknown item keys but retains top-level document fields", async () => {
    const doc = { ...vectors.found.document, extra: "kept", found: vectors.found.document.found.map(item => ({ ...item, extra: "ignored" })) };
    expect(foundIn(doc)?.items).toEqual(vectors.found.document.found);
    expect((await openMacLists(await encryptedDoc(doc)))?.doc).toEqual(doc);
  });
  it.each(["too many", "wrong type"])("invalid found data (%s) hides only found, not the lists", async reason => {
    const doc = { ...vectors.found.document, found: reason === "too many" ? Array(11).fill(vectors.found.document.found[0]) : [{ ...vectors.found.document.found[0], type: "party" }] };
    expect(foundIn(doc)).toBeNull();
    expect((await openMacLists(await encryptedDoc(doc)))?.doc).toEqual(doc);
  });
  it("enforces all stated item limits and metadata bounds", () => {
    const item = vectors.found.document.found[0];
    for (const patch of [{ ref: "a".repeat(23) }, { title: "a".repeat(201) }, { child: "a".repeat(41) }, { time: "a".repeat(41) }, { date: "20 Nov" }, { endDate: "20 Nov" }, { weekdays: [7] }, { weekdays: [-1] }, { weekdays: [1.5] }, { weekdays: Array(8).fill(1) }, { needsDate: "yes" }, { from: "chat" }, { private: "yes" }]) {
      expect(foundIn({ found: [{ ...item, ...patch }], foundMore: 0 })).toBeNull();
    }
    for (const more of [-1, 1001, 0.5, "2", undefined]) expect(foundIn({ found: [], foundMore: more })).toBeNull();
    expect(foundIn({ found: [], foundMore: 1000 })).toEqual({ items: [], more: 1000 });
    expect(foundIn({ found: Array(10).fill(item), foundMore: 0 })?.items).toHaveLength(10);
  });
  it("matches the exact add-answer ciphertext vector", async () => {
    const answer = vectors.found.answer;
    expect(await encryptAnswer({ ...answer.answer, v: 1 }, await key(), vectors.keyId, new Uint8Array(Buffer.from(answer.row.nonce, "base64")))).toBe(answer.row.ciphertext);
  });
  it.each(["add", "skip"] as const)("sends only the encrypted %s envelope for the item's ref", async action => {
    const ref = vectors.found.document.found[0].ref;
    expect(await answerFound(vectors.found.row, ref, action)).toEqual({ ok: true });
    const sent = vi.mocked(sendRelayAnswer).mock.calls[0][0].data;
    expect(Object.keys(sent)).toEqual(["deviceId", "keyId", "ref", "nonce", "ciphertext"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sent.nonce, "base64"), additionalData: new TextEncoder().encode(`nc-answer-v1|${sent.keyId}|${sent.ref}`) }, await key(), Buffer.from(sent.ciphertext, "base64"));
    expect(plain.byteLength).toBe(256);
    expect(JSON.parse(new TextDecoder().decode(plain).trim())).toMatchObject({ v: 1, ref, action });
  });
  it("decrypt-only keys require scanning and never send an answer", async () => {
    const readOnly = await key(["decrypt"]);
    await new Promise<void>(resolve => {
      const q = indexedDB.open("nc-keys", 1);
      q.onsuccess = () => { const tx = q.result.transaction("keys", "readwrite"); tx.objectStore("keys").put(readOnly, vectors.keyId); tx.oncomplete = () => { q.result.close(); resolve(); }; };
    });
    expect(await answerFound(vectors.found.row, vectors.found.document.found[0].ref, "add")).toEqual({ needsScan: true });
    expect(sendRelayAnswer).not.toHaveBeenCalled();
  });
  it("formats each vector item and tomorrow using the browser date", () => {
    const items = foundIn(vectors.found.document)?.items ?? [];
    expect(items.map(item => foundWhen(item, "2026-11-14"))).toEqual(["Fri 20 Nov · 9am", "Every Tue and Thu", "No date yet", "Wed 18 Nov", "27–28 Nov", "Wed 25 Nov"]);
    expect(foundWhen({ ...items[0], date: "2026-11-15", time: "" } as MacFoundItem, "2026-11-14")).toBe("tomorrow");
    expect(foundWhen({ ...items[4], date: "2026-11-30", endDate: "2026-12-02" } as MacFoundItem, "2026-11-14")).toBe("30 Nov – 2 Dec");
    expect(foundWhen({ ...items[2], date: "2026-11-20", needsDate: false } as MacFoundItem, "2026-11-14")).toBe("By Fri 20 Nov");
  });
  it("remembers only valid active refs less than four days old", () => {
    const now = Date.now();
    expect(pruneFound({ live: { action: "add", at: now }, skip: { action: "skip", at: now }, old: { action: "add", at: now - 4 * 86400000 }, removed: { action: "skip", at: now }, future: { action: "add", at: now + 1 }, bad: { action: "tick", at: now } }, ["live", "skip", "old", "future", "bad"], now)).toEqual({ live: { action: "add", at: now }, skip: { action: "skip", at: now } });
  });
  it("renders nothing before browser-only document loading", () => {
    expect(renderToStaticMarkup(createElement(MacFound))).toBe("");
  });
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import vectors from "./lists-vectors.json";
vi.mock("@/lib/relay.functions", () => ({ listRelayCards: vi.fn() }));
vi.mock("@/lib/relay-lists.functions", () => ({ listRelayLists: vi.fn() }));
vi.mock("@/lib/relay-answers.functions", () => ({ sendRelayAnswer: vi.fn(async () => ({ ok: true })) }));
import { listRelayLists } from "@/lib/relay-lists.functions";
import { sendRelayAnswer } from "@/lib/relay-answers.functions";
import { openMacLists, loadMacLists, tickMacItem, encryptAnswer, saveKeyFromLink, dayWords } from "@/lib/mac-cards";
import { relayListsSchema } from "@/lib/relay-lists-schema";
import { pruneTicks } from "@/lib/mac-tick-state";
beforeEach(async () => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.clearAllMocks(); await saveKeyFromLink(`#k=${vectors.key}&kid=${vectors.keyId}`); });
describe("Mac list encryption and local ticks", () => {
  it("opens the exact Mac document", async () => { expect(await openMacLists(vectors.lists.row)).toEqual({ doc: vectors.lists.document, row: vectors.lists.row }); });
  it("matches the exact tick encryption vector and decrypts it", async () => {
    const key = await crypto.subtle.importKey("raw", Buffer.from(vectors.key, "base64url"), "AES-GCM", false, ["encrypt", "decrypt"]);
    const tick = vectors.lists.tick;
    expect(await encryptAnswer({ ...tick.answer, v: 1 }, key, vectors.keyId, new Uint8Array(Buffer.from(tick.row.nonce, "base64")))).toBe(tick.row.ciphertext);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(tick.row.nonce, "base64"), additionalData: new TextEncoder().encode(`nc-answer-v1|${vectors.keyId}|${tick.answer.ref}`) }, key, Buffer.from(tick.row.ciphertext, "base64"));
    expect(JSON.parse(new TextDecoder().decode(plain).trim())).toEqual(tick.answer);
  });
  it("rejects changed ciphertext, wrong authenticated key id and 31 items", async () => {
    const changed = Buffer.from(vectors.lists.row.ciphertext, "base64"); changed[0] ^= 1;
    expect(await openMacLists({ ...vectors.lists.row, ciphertext: changed.toString("base64") })).toBeNull();
    await saveKeyFromLink(`#k=${vectors.key}&kid=deadbeef`);
    expect(await openMacLists({ ...vectors.lists.row, key_id: "deadbeef" })).toBeNull();
    const key = await crypto.subtle.importKey("raw", Buffer.from(vectors.key, "base64url"), "AES-GCM", false, ["encrypt"]);
    const bad = { ...vectors.lists.document, list: Array(31).fill(vectors.lists.document.list[0]) };
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: Buffer.from(vectors.lists.row.nonce, "base64"), additionalData: new TextEncoder().encode(`nc-lists-v1|${vectors.keyId}`) }, key, new TextEncoder().encode(JSON.stringify(bad)));
    expect(await openMacLists({ ...vectors.lists.row, ciphertext: Buffer.from(encrypted).toString("base64") })).toBeNull();
  });
  it("loads the first opening document, and reports unavailable keys", async () => {
    vi.mocked(listRelayLists).mockResolvedValue([ { ...vectors.lists.row, key_id: "00000000" }, vectors.lists.row ]);
    expect(await loadMacLists()).toEqual({ doc: vectors.lists.document, row: vectors.lists.row });
    vi.mocked(listRelayLists).mockResolvedValue([{ ...vectors.lists.row, key_id: "00000000" }]); expect(await loadMacLists()).toEqual({ needsScan: true });
    vi.mocked(listRelayLists).mockResolvedValue([]); expect(await loadMacLists()).toBeNull();
  });
  it("sends only an encrypted tick and refuses decrypt-only keys", async () => {
    const ref = vectors.lists.tick.answer.ref; await tickMacItem(vectors.lists.row, ref);
    const sent = vi.mocked(sendRelayAnswer).mock.calls[0][0].data;
    const key = await crypto.subtle.importKey("raw", Buffer.from(vectors.key, "base64url"), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sent.nonce, "base64"), additionalData: new TextEncoder().encode(`nc-answer-v1|${sent.keyId}|${ref}`) }, key, Buffer.from(sent.ciphertext, "base64"));
    expect(JSON.parse(new TextDecoder().decode(plain).trim())).toMatchObject({ ref, action: "tick" });
    await new Promise<void>((resolve) => { const q = indexedDB.open("nc-keys", 1); q.onsuccess = () => { const tx = q.result.transaction("keys", "readwrite"); tx.objectStore("keys").put(key, vectors.keyId); tx.oncomplete = () => { q.result.close(); resolve(); }; }; });
    vi.mocked(sendRelayAnswer).mockClear(); expect(await tickMacItem(vectors.lists.row, ref)).toEqual({ needsScan: true }); expect(sendRelayAnswer).not.toHaveBeenCalled();
  });
  it.each([["2026-11-12", "2 days late"], ["2026-11-13", "1 day late"], ["2026-11-14", "today"], ["2026-11-15", "tomorrow"], ["2026-11-18", "Wed"], ["2026-11-26", "26 Nov"], ["", ""]])("labels %s as %s", (date, words) => expect(dayWords(date, "2026-11-14")).toBe(words));
  it("prunes ticks older than four days and refs not in the current document", () => {
    const now = Date.now(); expect(pruneTicks({ live: now, removed: now, old: now - 4 * 86400000 }, ["live", "old"], now)).toEqual({ live: now });
  });
});
describe("Mac list envelope validation", () => {
  const input = () => ({ v: 1, seq: 1, keyId: vectors.keyId, generatedAt: new Date().toISOString(), nonce: vectors.lists.row.nonce, ciphertext: vectors.lists.row.ciphertext, refs: Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(24, "0")), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  it("accepts the padded Mac envelope", () => expect(relayListsSchema.safeParse(input()).success).toBe(true));
  it("rejects unknown fields and invalid counts, order, size and expiry", () => {
    const good = input();
    for (const change of [{ extra: true }, { refs: good.refs.slice(1) }, { refs: [...good.refs, "f".repeat(24)] }, { refs: Array(30).fill(good.refs[0]) }, { refs: [...good.refs].reverse() }, { ciphertext: Buffer.alloc(1041).toString("base64") }, { ciphertext: Buffer.alloc(65537).toString("base64") }, { expiresAt: new Date(Date.now() + 10 * 86400000).toISOString() }]) expect(relayListsSchema.safeParse({ ...good, ...change }).success).toBe(false);
  });
});
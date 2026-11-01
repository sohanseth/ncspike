import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { Client } from "pg";
import vectors from "./answer-vectors.json";
import { readFileSync } from "node:fs";
vi.mock("@/lib/relay.functions", () => ({ listRelayCards: vi.fn() }));
vi.mock("@/lib/relay-answers.functions", () => ({ sendRelayAnswer: vi.fn(async () => ({ ok: true })) }));
import { sendRelayAnswer } from "@/lib/relay-answers.functions";
import { encryptAnswer, makeAnswer, canAnswer, answerCard, saveKeyFromLink, type MacAnswer } from "@/lib/mac-cards";
import { answerIdentity, recentAnswers, answerableActions } from "@/lib/mac-answer-state";
import { handleRelayAnswers, sendRelayAnswerFor } from "@/server/relay-answers.server";
import { sha256 } from "@/server/relay.server";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.clearAllMocks(); });
describe("encrypted Mac answer contract", () => {
  it("matches both exact Mac AES-GCM vectors and decrypts to the ordered answer", async () => {
    const key = await crypto.subtle.importKey("raw", Buffer.from(vectors.key, "base64url"), "AES-GCM", false, ["encrypt", "decrypt"]);
    for (const example of vectors.answers) {
      const nonce = new Uint8Array(Buffer.from(example.row.nonce, "base64"));
      expect(await encryptAnswer(example.answer as MacAnswer, key, vectors.keyId, nonce)).toBe(example.row.ciphertext);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`nc-answer-v1|${vectors.keyId}|${example.answer.ref}`) }, key, Buffer.from(example.row.ciphertext, "base64"));
      expect(plain.byteLength).toBe(256);
      expect(JSON.parse(new TextDecoder().decode(plain).trim())).toEqual(example.answer);
    }
  });
  it("makes random 22-character ids, second-resolution UTC times and exact field order", () => {
    const answer = makeAnswer("a".repeat(24), "done#0");
    expect(answer.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(answer.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Object.keys(answer)).toEqual(["v", "id", "ref", "action", "at"]);
    expect(makeAnswer(answer.ref, answer.action).id).not.toBe(answer.id);
  });
  it("refuses over-256 UTF-8 bytes and non-12-byte nonces", async () => {
    const key = await crypto.subtle.importKey("raw", Buffer.alloc(32), "AES-GCM", false, ["encrypt", "decrypt"]);
    await expect(encryptAnswer(makeAnswer("a".repeat(24), "😀".repeat(100)), key, vectors.keyId, new Uint8Array(12))).rejects.toThrow("bad_answer");
    await expect(encryptAnswer(makeAnswer("a".repeat(24), "not_now"), key, vectors.keyId, new Uint8Array(11))).rejects.toThrow("bad_answer");
  });
  it("encrypts the selected action before sending, and missing keys send nothing", async () => {
    const row = { device_id: "11111111-1111-4111-8111-111111111111", key_id: vectors.keyId, ref: vectors.answers[0].answer.ref, nonce: "old" };
    expect(await answerCard(row, "done#0")).toEqual({ needsScan: true });
    expect(sendRelayAnswer).not.toHaveBeenCalled();
    await saveKeyFromLink(`#k=${vectors.key}&kid=${vectors.keyId}`);
    expect(await answerCard(row, "done#0")).toEqual({ ok: true });
    const sent = vi.mocked(sendRelayAnswer).mock.calls[0][0].data;
    const key = await crypto.subtle.importKey("raw", Buffer.from(vectors.key, "base64url"), "AES-GCM", false, ["decrypt"]);
    expect(canAnswer(key)).toBe(false);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(sent.nonce, "base64"), additionalData: new TextEncoder().encode(`nc-answer-v1|${sent.keyId}|${sent.ref}`) }, key, Buffer.from(sent.ciphertext, "base64"));
    expect(JSON.parse(new TextDecoder().decode(plain).trim()).action).toBe("done#0");
    expect(Buffer.from(sent.ciphertext, "base64")).toHaveLength(272);
  });
  it("hides ref+nonce only for four days and allows a republished card", () => {
    const now = Date.now();
    const row = { ref: "ref", nonce: "first", device_id: "device", key_id: "key" };
    const kept = recentAnswers({ [answerIdentity(row)]: now, old: now - 4 * 86400000, invalid: "value" }, now);
    expect(kept).toEqual({ "ref:first": now });
    expect(kept[answerIdentity({ ...row, nonce: "second" })]).toBeUndefined();
  });
  it("offers only done/remind refs in order, and none for private cards", () => {
    const card = { actions: [{ kind: "done", label: "Done", ref: "done" }, { kind: "open", label: "Open", ref: "open" }, { kind: "remind", label: "Remind", ref: "remind" }, { kind: "done", label: "No ref" }] } as Parameters<typeof answerableActions>[0];
    expect(answerableActions(card).map(a => a.ref)).toEqual(["done", "remind"]);
    expect(answerableActions({ ...card, private: true })).toEqual([]);
  });
});

// Managed local database; each case rolls back its own fixtures and never touches user rows.
describe("Mac answers — real PostgreSQL atomic rules and HTTP handler", () => {
  let client: Client;
  let db: any;
  const user = "f1111111-1111-4111-8111-111111111111";
  const other = "f2222222-2222-4222-8222-222222222222";
  let device: string; let otherDevice: string;
  const token = "test-answer-device-token-" + "a".repeat(32);
  const ref = "a".repeat(24);
  const input = () => ({ deviceId: device, keyId: vectors.keyId, ref, nonce: Buffer.alloc(12).toString("base64"), ciphertext: Buffer.alloc(272).toString("base64") });
  const request = (body: unknown, bearer = token, json = true) => new Request("http://localhost/api/relay/answers", { method: "POST", headers: { ...(json ? { "content-type": "application/json" } : {}), authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
  beforeEach(async () => {
    client = new Client({ ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined }); await client.connect(); await client.query("begin");
    device = (await client.query("insert into relay_devices(user_id,name,token_hash) values($1,'Answer test',$2) returning id", [user, await sha256(token)])).rows[0].id;
    otherDevice = (await client.query("insert into relay_devices(user_id,name,token_hash) values($1,'Other test',$2) returning id", [other, await sha256(token + "b")])).rows[0].id;
    await client.query("insert into relay_cards(user_id,device_id,key_id,ref,nonce,ciphertext,ord,expires_at) values($1,$2,$3,$4,'nonce','ciphertext',0,now()+interval '1 day')", [user, device, vectors.keyId, ref]);
    db = {
      from: () => {
        const filters: unknown[] = [];
        const query = { select: () => query, eq: (_key: string, value: unknown) => { filters.push(value); return query; }, is: () => query, maybeSingle: async () => ({ data: (await client.query("select id from relay_devices where token_hash=$1 and revoked_at is null", filters)).rows[0] ?? null, error: null }) };
        return query;
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        const keys = Object.keys(args);
        const result = await client.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) as data`, Object.values(args));
        return { data: result.rows[0].data, error: null };
      },
    };
  });
  afterEach(async () => { if (client) { await client.query("rollback"); await client.end(); } });
  it("migration reruns with owner-only storage and service-role-only functions", async () => {
    await client.query(readFileSync("drizzle/migrations/0005_encrypted_relay_answers.sql", "utf8"));
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["relay_answers", "relay_answer_log"]) expect((await client.query("select has_table_privilege($1,$2,'SELECT') as allowed", [role, table])).rows[0].allowed).toBe(false);
      for (const fn of ["relay_answer_put(uuid,uuid,text,text,text,text)", "relay_answers_take(uuid,uuid[])", "relay_revoke(uuid)", "cleanup_relay()"]) expect((await client.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, fn])).rows[0].allowed).toBe(false);
    }
  });
  it("enforces JSON, active tokens, strict keys, 200 acknowledgements and 16KiB", async () => {
    expect((await handleRelayAnswers(request({}, token, false), db)).status).toBe(415);
    expect((await handleRelayAnswers(request({ v: 1, ack: [] }, token + "x"), db)).status).toBe(401);
    expect((await handleRelayAnswers(request({ v: 1, ack: [], extra: true }), db)).status).toBe(400);
    expect((await handleRelayAnswers(request({ v: 1, ack: Array(201).fill(device) }), db)).status).toBe(400);
    expect((await handleRelayAnswers(request({ huge: "a".repeat(16384) }), db)).status).toBe(413);
    const response = await handleRelayAnswers(request({ v: 1, ack: [] }), db);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("refuses foreign/revoked devices, unknown/expired refs, wrong key and malformed envelopes", async () => {
    await expect(sendRelayAnswerFor(db, other, input())).rejects.toThrow("This card has changed");
    await expect(sendRelayAnswerFor(db, user, { ...input(), ref: "b".repeat(24) })).rejects.toThrow("This card has changed");
    await expect(sendRelayAnswerFor(db, user, { ...input(), keyId: "deadbeef" })).rejects.toThrow("This card has changed");
    for (const length of [0, 271, 273, 528]) await expect(sendRelayAnswerFor(db, user, { ...input(), ciphertext: Buffer.alloc(length).toString("base64") })).rejects.toThrow("bad_answer");
    await expect(sendRelayAnswerFor(db, user, { ...input(), nonce: Buffer.alloc(11).toString("base64") })).rejects.toThrow("bad_answer");
    await client.query("update relay_cards set expires_at=now()-interval '1 second' where device_id=$1", [device]);
    await expect(sendRelayAnswerFor(db, user, input())).rejects.toThrow("This card has changed");
    await client.query("select relay_revoke($1)", [device]);
    await expect(sendRelayAnswerFor(db, user, input())).rejects.toThrow("This card has changed");
    expect((await handleRelayAnswers(request({ v: 1, ack: [] }), db)).status).toBe(401);
  });
  it("stores good answers, rejects the 61st per hour even after acknowledgement", async () => {
    for (let i = 0; i < 60; i++) expect(await sendRelayAnswerFor(db, user, input())).toEqual({ ok: true });
    const ids = (await client.query("select id from relay_answers where device_id=$1", [device])).rows.map(r => r.id);
    expect((await handleRelayAnswers(request({ v: 1, ack: ids }), db)).status).toBe(200);
    await expect(sendRelayAnswerFor(db, user, input())).rejects.toThrow("Too many answers");
    expect((await client.query("select count(*)::int as n from relay_answer_log where user_id=$1", [user])).rows[0].n).toBe(60);
  });
  it("caps pending answers at 200 and expires them after three days", async () => {
    await client.query("insert into relay_answers(user_id,device_id,key_id,ref,nonce,ciphertext) select $1,$2,$3,$4,'n','c' from generate_series(1,200)", [user, device, vectors.keyId, ref]);
    await expect(sendRelayAnswerFor(db, user, input())).rejects.toThrow("Too many answers");
    expect((await client.query("select bool_and(expires_at=created_at+interval '3 days') as ok from relay_answers where device_id=$1", [device])).rows[0].ok).toBe(true);
  });
  it("polls only this device's live oldest 50, acks only its rows and preserves last_seen_at", async () => {
    await client.query("insert into relay_answers(user_id,device_id,key_id,ref,nonce,ciphertext,created_at) select $1,$2,$3,$4,'n','c',now()-(i*interval '1 minute') from generate_series(1,55) i", [user, device, vectors.keyId, ref]);
    const foreign = (await client.query("insert into relay_answers(user_id,device_id,key_id,ref,nonce,ciphertext) values($1,$2,$3,$4,'n','c') returning id", [other, otherDevice, vectors.keyId, ref])).rows[0].id;
    await client.query("insert into relay_answers(user_id,device_id,key_id,ref,nonce,ciphertext,expires_at) values($1,$2,$3,$4,'n','expired',now()-interval '1 second')", [user, device, vectors.keyId, ref]);
    const before = (await client.query("select last_seen_at from relay_devices where id=$1", [device])).rows[0].last_seen_at;
    const response = await handleRelayAnswers(request({ v: 1, ack: [foreign] }), db);
    const { answers } = await response.json(); expect(answers).toHaveLength(50);
    expect(answers.every((a: any, i: number) => a.ciphertext !== "expired" && (i === 0 || a.createdAt >= answers[i - 1].createdAt))).toBe(true);
    await handleRelayAnswers(request({ v: 1, ack: [answers[0].id] }), db);
    expect((await client.query("select id from relay_answers where id=$1", [answers[0].id])).rowCount).toBe(0);
    expect((await client.query("select id from relay_answers where id=$1", [foreign])).rowCount).toBe(1);
    expect((await client.query("select last_seen_at from relay_devices where id=$1", [device])).rows[0].last_seen_at).toEqual(before);
    await client.query("select relay_revoke($1)", [device]);
    expect((await client.query("select id from relay_answers where device_id=$1", [device])).rowCount).toBe(0);
  });
});
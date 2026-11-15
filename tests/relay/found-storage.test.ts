import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { webcrypto } from "node:crypto";
import vectors from "./found-vectors.json";

describe("existing relay storage accepts encrypted found answers", () => {
  it.each(["add", "skip", "unchanged-action"])("stores a lists ref with opaque action %s", async action => {
    const client = new Client({ ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined });
    await client.connect();
    try {
      await client.query("begin");
      const user = "fa111111-1111-4111-8111-111111111111";
      const device = (await client.query("insert into relay_devices(user_id,name,token_hash) values($1,'Found storage test',$2) returning id", [user, `found-storage-${action}`])).rows[0].id;
      const ref = vectors.found.document.found[0].ref;
      await client.query("insert into relay_lists(device_id,user_id,key_id,nonce,ciphertext,refs,seq,expires_at) values($1,$2,$3,$4,$5,$6,1,now()+interval '1 day')", [device, user, vectors.keyId, vectors.found.row.nonce, vectors.found.row.ciphertext, [ref]]);
      const nonce = webcrypto.getRandomValues(new Uint8Array(12));
      const key = await webcrypto.subtle.importKey("raw", Buffer.from(vectors.key, "base64url"), "AES-GCM", false, ["encrypt", "decrypt"]);
      const plain = new Uint8Array(256).fill(32);
      plain.set(new TextEncoder().encode(JSON.stringify({ v: 1, id: "pQ7sW2xY9zA4bC6dE8fG1h", ref, action, at: "2026-11-14T21:10:00Z" })));
      const aad = new TextEncoder().encode(`nc-answer-v1|${vectors.keyId}|${ref}`);
      const cipher = Buffer.from(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plain)).toString("base64");
      const result = await client.query("select relay_answer_put($1,$2,$3,$4,$5,$6) as result", [user, device, vectors.keyId, ref, Buffer.from(nonce).toString("base64"), cipher]);
      expect(result.rows[0].result).toEqual({ status: "ok" });
      const stored = (await client.query("select ref,ciphertext,nonce from relay_answers where device_id=$1", [device])).rows;
      expect(stored).toHaveLength(1); expect(stored[0].ref).toBe(ref); expect(stored[0].ciphertext).toBe(cipher);
      const decrypted = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(stored[0].nonce, "base64"), additionalData: aad }, key, Buffer.from(stored[0].ciphertext, "base64"));
      expect(JSON.parse(new TextDecoder().decode(decrypted).trim())).toMatchObject({ ref, action });
    } finally { await client.query("rollback"); await client.end(); }
  });
});
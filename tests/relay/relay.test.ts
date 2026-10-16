import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { createPairingCodeFor, handleRelay, listCardsFor, listDevicesFor, revokeDeviceFor, sha256 } from "@/server/relay.server";

const URL = process.env.RELAY_TEST_DB_URL;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const migration = readFileSync("supabase/migrations/20261016091000_encrypted_mac_relay.sql", "utf8");
const req = (body: unknown, token?: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/relay/claim", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
const envelope = (seq = 1) => ({ v: 1, seq, keyId: "12345678", generatedAt: new Date().toISOString(), cards: [{ ref: "a".repeat(24), nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==", order: 0, expiresAt: new Date(Date.now() + 600000).toISOString() }] });

// Real SQL adapter for the tiny Data API surface used here. No mocked RPCs:
// every lock, sequence check, owner predicate, and transaction hits Postgres.
class Query {
  op = "select"; cols = "*"; input: any; filters: string[] = []; values: unknown[] = []; singular = false; orderBy = "";
  constructor(private pool: Pool, private table: string) {}
  select(cols = "*") { this.cols = cols; return this; }
  insert(input: any) { this.op = "insert"; this.input = input; return this; }
  delete() { this.op = "delete"; return this; }
  eq(key: string, value: unknown) { this.values.push(value); this.filters.push(`${key === "relay_devices.user_id" ? "d.user_id" : `t.${key}`} = $${this.values.length}`); return this; }
  is(key: string, _value: null) { this.filters.push(`${key === "relay_devices.revoked_at" ? "d.revoked_at" : `t.${key}`} is null`); return this; }
  gt(key: string, value: unknown) { this.values.push(value); this.filters.push(`t.${key} > $${this.values.length}`); return this; }
  order(key: string, opts: { ascending: boolean }) { this.orderBy = ` order by t.${key} ${opts.ascending ? "asc" : "desc"}`; return this; }
  single() { this.singular = true; return this; }
  maybeSingle() { this.singular = true; return this; }
  then(resolve: any, reject: any) { return this.execute().then(resolve, reject); }
  async execute() {
    try {
      let sql: string;
      if (this.op === "insert") {
        const cols = Object.keys(this.input); this.values = Object.values(this.input);
        sql = `insert into public.${this.table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning ${this.cols}`;
      } else {
        const join = this.cols.includes("!inner");
        const cols = join ? "t.*, json_build_object('last_seen_at',d.last_seen_at,'revoked_at',d.revoked_at,'user_id',d.user_id) as relay_devices" : this.cols;
        sql = this.op === "delete" ? `delete from public.${this.table} t` : `select ${cols} from public.${this.table} t`;
        if (join) sql += " join public.relay_devices d on d.id = t.device_id";
        if (this.filters.length) sql += ` where ${this.filters.join(" and ")}`;
        sql += this.orderBy;
      }
      const result = await this.pool.query(sql, this.values);
      return { data: this.singular ? result.rows[0] ?? null : result.rows, error: null };
    } catch { return { data: null, error: { message: "SQL error" } }; }
  }
}

describe.skipIf(!URL)("encrypted relay — real database and handler lifecycle", () => {
  let pool: Pool; let db: any;
  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, ssl: false, max: 30 });
    db = { from: (table: string) => new Query(pool, table), rpc: async (name: string, args: Record<string, unknown>) => {
      try { const keys = Object.keys(args); const r = await pool.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) as data`, Object.values(args).map((v) => Array.isArray(v) ? JSON.stringify(v) : v)); return { data: r.rows[0].data, error: null }; }
      catch { return { data: null, error: { message: "SQL error" } }; }
    } };
    // Minimal siblings needed by the existing delete RPC for this isolated test.
    for (const t of ["chat_context_log", "pii_scrub_events", "extraction_failures", "user_trait_blocks", "user_provider_category_blocks", "user_known_names", "user_traits"]) await pool.query(`create table if not exists public.${t} (user_id uuid)`);
    await pool.query(migration);
  });
  afterAll(async () => { if (pool) await pool.end(); });
  beforeEach(async () => { await pool.query("truncate relay_cards,relay_devices,relay_pairing_codes,relay_claim_attempts cascade"); });
  async function pair(user = A) {
    const { code } = await createPairingCodeFor(db, user);
    const response = await handleRelay(req({ v: 1, code, deviceName: "Test Mac" }), "claim", db, "test-only");
    expect(response.status).toBe(200);
    return response.json() as Promise<{ token: string; deviceId: string }>;
  }
  it("migration re-runs and denies direct SELECT and EXECUTE to anon/authenticated", async () => {
    await pool.query(migration);
    for (const role of ["anon", "authenticated"]) {
      const c = await pool.connect();
      try {
        await c.query(`set role ${role}`);
        for (const table of ["relay_pairing_codes", "relay_devices", "relay_cards", "relay_claim_attempts"]) await expect(c.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
        for (const sql of ["relay_claim('ip','code')", "relay_publish(gen_random_uuid(),1,'key','[]')", "relay_revoke(gen_random_uuid())", "cleanup_relay()"]) await expect(c.query(`select public.${sql}`)).rejects.toThrow(/permission denied/);
      } finally { await c.query("reset role"); c.release(); }
    }
  });
  it("replaces unused codes, stores hashes only, and consumes a code exactly once", async () => {
    const first = await createPairingCodeFor(db, A);
    const second = await createPairingCodeFor(db, A);
    expect((await pool.query("select * from relay_pairing_codes")).rows).toHaveLength(1);
    expect((await handleRelay(req({ v: 1, code: first.code, deviceName: "Mac" }), "claim", db, "test-only")).status).toBe(404);
    const responses = await Promise.all(Array.from({ length: 2 }, (_, i) => handleRelay(req({ v: 1, code: second.code, deviceName: "Mac" }, undefined, { "cf-connecting-ip": `10.0.0.${i}` }), "claim", db, "test-only")));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
    const token = (await responses.find((r) => r.status === 200)?.json()).token;
    expect((await pool.query("select token_hash from relay_devices")).rows[0].token_hash).toBe(await sha256(token));
    await pool.query("update relay_pairing_codes set used_at = null,expires_at = now()-interval '1 second'");
    expect((await handleRelay(req({ v: 1, code: second.code, deviceName: "Mac" }), "claim", db, "test-only")).status).toBe(404);
  });
  it("21 concurrent same-IP attempts admit at most 10 and DB failure fails closed", async () => {
    const result = await Promise.all(Array.from({ length: 21 }, () => handleRelay(req({ v: 1, code: "ABCDEFGH", deviceName: "Mac" }), "claim", db, "test-only")));
    expect(result.filter((r) => r.status === 404)).toHaveLength(10);
    expect(result.filter((r) => r.status === 429)).toHaveLength(11);
    const broken = { rpc: async () => ({ data: null, error: {} }) } as any;
    expect((await handleRelay(req({ v: 1, code: "ABCDEFGH", deviceName: "Mac" }), "claim", broken, "test-only")).status).toBe(429);
  });
  it("global failure cap denies new claims without growing attempts", async () => {
    await pool.query("insert into relay_claim_attempts (ip_hash,ok) select 'many',false from generate_series(1,2000)");
    expect((await handleRelay(req({ v: 1, code: "ABCDEFGH", deviceName: "Mac" }), "claim", db, "test-only")).status).toBe(429);
    expect(Number((await pool.query("select count(*) from relay_claim_attempts")).rows[0].count)).toBe(2000);
  });
  it("full claim → publish → owner read-back → revoke excludes other users and rejects revoked tokens", async () => {
    const { token, deviceId } = await pair();
    expect((await handleRelay(req(envelope(), token), "publish", db, "test-only")).status).toBe(200);
    expect(await listCardsFor(db, B)).toEqual([]);
    expect(await listDevicesFor(db, B)).toEqual([]);
    await expect(revokeDeviceFor(db, B, deviceId)).rejects.toThrow("Device not found");
    const cards = await listCardsFor(db, A);
    expect(cards).toHaveLength(1); expect(cards[0].ciphertext).toBe(envelope().cards[0].ciphertext);
    expect((await listDevicesFor(db, A))[0]).not.toHaveProperty("token_hash");
    await revokeDeviceFor(db, A, deviceId);
    expect(await listCardsFor(db, A)).toEqual([]);
    expect((await handleRelay(req(envelope(2), token), "publish", db, "test-only")).status).toBe(401);
  });
  it("seq retries and simultaneous publications serialize; [] clears cards", async () => {
    const { token } = await pair();
    const results = await Promise.all([1, 2].map((seq) => handleRelay(req(envelope(seq), token), "publish", db, "test-only")));
    expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(Number((await pool.query("select last_seq from relay_devices")).rows[0].last_seq)).toBe(2);
    const stale = await handleRelay(req(envelope(1), token), "publish", db, "test-only");
    expect(stale.status).toBe(409); expect((await stale.json()).lastSeq).toBe(2);
    expect((await handleRelay(req({ ...envelope(3), cards: [] }, token), "publish", db, "test-only")).status).toBe(200);
    expect(await listCardsFor(db, A)).toEqual([]);
  });
  it("publish racing revoke cannot leave cards", async () => {
    const { token } = await pair();
    await Promise.all([handleRelay(req(envelope(), token), "publish", db, "test-only"), handleRelay(req({}, token), "revoke", db, "test-only")]);
    expect(Number((await pool.query("select count(*) from relay_cards")).rows[0].count)).toBe(0);
  });
  it("rejects wrong content type and oversized streams before consuming JSON", async () => {
    expect((await handleRelay(new Request("http://localhost", { method: "POST", body: "{}" }), "claim", db, "test-only")).status).toBe(415);
    const huge = req({ body: "x".repeat(410000) });
    expect((await handleRelay(huge, "claim", db, "test-only")).status).toBe(413);
    expect((await handleRelay(req(envelope()), "publish", db, "test-only")).status).toBe(401);
  });
  it("expiry, retention and GDPR wipe preserve the other user's rows", async () => {
    const one = await pair(A); const two = await pair(B);
    await handleRelay(req(envelope(), one.token), "publish", db, "test-only");
    await handleRelay(req(envelope(), two.token), "publish", db, "test-only");
    await pool.query("update relay_cards set expires_at = now()-interval '1 second' where user_id=$1", [A]);
    expect(await listCardsFor(db, A)).toEqual([]);
    await pool.query("select cleanup_relay()");
    expect(await listCardsFor(db, B)).toHaveLength(1);
    await createPairingCodeFor(db, A);
    const result = await pool.query("select * from delete_user_data($1)", [A]);
    expect(result.rows[0].relay_devices_deleted).toBe(1);
    expect(result.rows[0].relay_pairing_codes_deleted).toBe(1);
    expect(await listDevicesFor(db, A)).toEqual([]); expect(await listCardsFor(db, B)).toHaveLength(1);
    expect((await handleRelay(req(envelope(2), one.token), "publish", db, "test-only")).status).toBe(401);
  });
  it("relay paths do not log credentials, codes, bodies or raw IPs", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try { const { token } = await pair(); await handleRelay(req(envelope(), token), "publish", db, "test-only"); expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true); }
    finally { spies.forEach((s) => s.mockRestore()); }
  });
});
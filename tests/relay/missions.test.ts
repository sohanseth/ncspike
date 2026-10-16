import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { handleRelayMission, missionResults, type MissionAction } from "@/server/relay-missions.server";
import { handleRelay, sha256 } from "@/server/relay.server";

const URL = process.env.RELAY_MISSIONS_TEST_DB_URL;
const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const token = "a".repeat(43), otherToken = "b".repeat(43);
const since = "2026-10-16T02:10:00.000000Z";
const mission = (n = 1, extra = {}) => ({ v: 1, id: `m-${n.toString(16).padStart(16, "0")}`, template: "research_digest", name: "Cottage hedge planting", topics: ["Beech", "Hawthorn"], cadence: "weekly", status: "active", ...extra });
const req = (body: unknown, t: string | undefined = token, extra = {}) => new Request("https://example.test/api/relay/missions/results", { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}), ...extra }, body: JSON.stringify(body) });

describe("mission endpoint input protections", () => {
  const db = { from: () => ({ select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { id: A }, error: null }) }) }) }) }) } as any;
  it.each<MissionAction>(["upsert", "delete", "results"])("%s requires JSON and a valid active token", async (action) => {
    expect((await handleRelayMission(req({}, token, { "content-type": "text/plain" }), action, db)).status).toBe(415);
    expect((await handleRelayMission(req({}, undefined), action, db)).status).toBe(401);
    expect((await handleRelayMission(req({}, "bad!"), action, db)).status).toBe(401);
    const revoked = { from: () => ({ select: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) } as any;
    const response = await handleRelayMission(req({}, token), action, revoked);
    expect(response.status).toBe(401); expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it.each([
    { mission: mission(1, { unknown: true }) }, { mission: mission(), unknown: true },
    { mission: mission(1, { id: "m-123" }) }, { mission: mission(1, { name: "x".repeat(81) }) },
    { mission: mission(1, { name: "Trailing " }) }, { mission: mission(1, { topics: ["😀".repeat(61)] }) },
    { mission: mission(1, { topics: ["a", "b", "c", "d", "e", "f"] }) }, { mission: mission(1, { topics: ["Beech", "beech"] }) },
    { mission: mission(1, { cadence: "hourly" }) }, { mission: mission(1, { v: 2 }) }, { v: 2, mission: mission() },
  ])("rejects invalid mission %j", async (body) => {
    expect((await handleRelayMission(req({ v: 1, ...body }), "upsert", db)).status).toBe(400);
  });
  it.each<MissionAction>(["upsert", "delete", "results"])("%s caps both advertised and streamed body at 16 KiB", async (action) => {
    expect((await handleRelayMission(req({}, token, { "content-length": "16385" }), action, db)).status).toBe(413);
    expect((await handleRelayMission(req({ large: "a".repeat(16384) }), action, db)).status).toBe(413);
  });
  it.each(["not-a-date", "2026-10-16", "2026-99-99T99:99:99Z"])("rejects results timestamp %s", async (bad) => {
    expect((await handleRelayMission(req({ v: 1, since: bad }), "results", db)).status).toBe(400);
  });
  it("rejects extra delete/result fields", async () => {
    expect((await handleRelayMission(req({ v: 1, missionId: mission().id, extra: 1 }), "delete", db)).status).toBe(400);
    expect((await handleRelayMission(req({ v: 1, since, extra: 1 }), "results", db)).status).toBe(400);
  });
});

describe("digest conversion", () => {
  const run = (briefing: unknown, n: number, itemsKept = 1) => ({ missionId: mission().id, agentId: A, runId: String(n), finishedAt: `2026-10-16T03:0${n}:00+00:00`, itemsKept, briefing });
  it("maps v3 titles, fallback titles and v2 synthesis; skips empty and failed output but advances cursor", () => {
    const data = { runs: [
      run({ version: 3, whatsNew: " New\n trees ", keepInMind: [{ text: " First note " }, { text: "Second\n note" }] }, 1),
      run({ version: 3, whatsNew: "", keepInMind: [{ text: "Fallback title" }, { text: "Other note" }] }, 2),
      run({ version: 2, headline: "Old title", synthesis: "Old\n summary" }, 3),
      run({ version: 3, whatsNew: "Ignored", failureClass: "failed" }, 4),
      run({ version: 2, headline: "Zero" }, 5, 0), run({ version: 1 }, 6),
    ], states: { [mission().id]: "active" } };
    const result = missionResults(data, since, "https://example.test");
    expect(result.results.map(({ title, summary }) => ({ title, summary }))).toEqual([
      { title: "New trees", summary: "First note Second note" }, { title: "Fallback title", summary: "Other note" }, { title: "Old title", summary: "Old summary" },
    ]);
    expect(result.results[0].url).toBe(`https://example.test/workspace/agents/${A}`);
    expect(result.results[0].createdAt).toBe("2026-10-16T03:01:00.000Z");
    expect(result.until).toBe("2026-10-16T03:06:00.000Z"); expect(result.states).toEqual(data.states);
  });
  it("limits title to 200 and summary to 600 characters", () => {
    const result = missionResults({ runs: [run({ version: 2, headline: "x".repeat(201), synthesis: "y".repeat(601) }, 1)], states: {} }, since, "https://example.test");
    expect(result.results[0].title.length).toBe(200); expect(result.results[0].summary.length).toBe(600);
  });
  it("preserves the exact supplied cursor with no runs", () => {
    expect(missionResults({ runs: [], states: {} }, since, "https://example.test").until).toBe(since);
  });
});

describe.skipIf(!URL)("missions — real SQL locking, permissions and lifecycle", () => {
  let pool: Pool; let db: any; let device: string; let other: string;
  const migration = readFileSync("supabase/migrations/20261016232000_mac_overnight_missions.sql", "utf8");
  beforeAll(async () => {
    pool = new Pool({ connectionString: URL, ssl: false, max: 20 });
    await pool.query(migration);
    db = {
      from: () => ({ select: () => ({ eq: (_key: string, hash: string) => ({ is: () => ({ maybeSingle: async () => {
        const r = await pool.query("select id from relay_devices where token_hash=$1 and revoked_at is null", [hash]); return { data: r.rows[0] ?? null, error: null };
      } }) }) }) }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        try { const r = await pool.query(`select public.${name}(${Object.keys(args).map((k, i) => `${k} => $${i + 1}`).join(",")}) as data`, Object.values(args)); return { data: r.rows[0].data, error: null }; }
        catch (error) { return { data: null, error }; }
      },
    };
  });
  afterAll(async () => { if (pool) await pool.end(); });
  beforeEach(async () => {
    await pool.query("truncate relay_cards,relay_devices,relay_missions,agents cascade");
    device = (await pool.query("insert into relay_devices(user_id,name,token_hash) values($1,'Mac A',$2) returning id", [A, await sha256(token)])).rows[0].id;
    other = (await pool.query("insert into relay_devices(user_id,name,token_hash) values($1,'Mac B',$2) returning id", [B, await sha256(otherToken)])).rows[0].id;
  });
  const upsert = (n = 1, extra = {}, t = token) => handleRelayMission(req({ v: 1, mission: mission(n, extra) }, t), "upsert", db);
  const agent = async (n = 1) => (await pool.query("select a.* from agents a join relay_missions m on m.agent_id=a.id where m.device_id=$1 and m.mission_id=$2", [device, mission(n).id])).rows[0];
  it("reruns migration and denies all table writes/reads and four RPCs to anon/authenticated", async () => {
    await pool.query(migration);
    for (const role of ["anon", "authenticated"]) {
      const c = await pool.connect();
      try {
        await c.query(`set role ${role}`);
        for (const sql of ["select * from relay_missions", "insert into relay_missions(user_id,device_id,mission_id,agent_id) values(gen_random_uuid(),gen_random_uuid(),'test',gen_random_uuid())", "update relay_missions set mission_id='x'", "delete from relay_missions", "select relay_mission_upsert(gen_random_uuid(),'m','name','{}',24,false,'flash','{}')", "select relay_mission_delete(gen_random_uuid(),'m')", "select relay_mission_runs(gen_random_uuid(),now())", "select relay_revoke(gen_random_uuid())"]) await expect(c.query(sql)).rejects.toThrow(/permission denied/);
      } finally { await c.query("reset role"); c.release(); }
    }
  });
  it("creates the owner's weekly digest once and updates topics/cadence; pauses and resumes from error", async () => {
    expect((await upsert()).status).toBe(200);
    let a = await agent();
    expect(a).toMatchObject({ user_id: A, template_id: "research_digest", display_name: "Cottage hedge planting", cadence_hours: 168, state: "active" });
    expect(a.config.topics).toEqual(["Beech", "Hawthorn"]);
    await upsert(1, { topics: ["New topic"], cadence: "nightly", status: "paused" });
    a = await agent(); expect(a.config.topics).toEqual(["New topic"]); expect(a.cadence_hours).toBe(24); expect(a.state).toBe("paused");
    expect(Number((await pool.query("select count(*) from agents")).rows[0].count)).toBe(1);
    await upsert(); expect((await agent()).state).toBe("active");
    await pool.query("update agents set state='error',consecutive_failures=20 where id=$1", [a.id]);
    await upsert(); expect(await agent()).toMatchObject({ state: "active", consecutive_failures: 0 });
  });
  it("creates paused missions immediately", async () => {
    await upsert(1, { status: "paused", cadence: "nightly" }); expect(await agent()).toMatchObject({ state: "paused", cadence_hours: 24 });
  });
  it("allows only three running missions, admitting a fourth after one pauses", async () => {
    for (const n of [1, 2, 3]) expect((await upsert(n)).status).toBe(200);
    expect((await upsert(4)).status).toBe(409); expect(await agent(4)).toBeUndefined();
    await upsert(1, { status: "paused" }); expect((await upsert(4)).status).toBe(200);
  });
  it("allows at most ten total missions even when paused", async () => {
    for (let n = 1; n <= 10; n++) expect((await upsert(n, { status: "paused" })).status).toBe(200);
    expect((await upsert(11, { status: "paused" })).status).toBe(409); expect(await agent(11)).toBeUndefined();
  });
  it("concurrent upserts of the same mission create one agent", async () => {
    expect((await Promise.all([upsert(), upsert()])).map((r) => r.status)).toEqual([200, 200]);
    expect(Number((await pool.query("select count(*) from agents")).rows[0].count)).toBe(1);
  });
  async function seedRun(aid: string, user: string, finished: string, status = "ok", kept = 1, briefing: unknown = { version: 2, headline: "Trees", synthesis: "A digest" }) {
    const r = await pool.query("insert into agent_runs(agent_id,user_id,finished_at,status,items_kept,briefing) values($1,$2,$3,$4,$5,$6) returning id", [aid, user, finished, status, kept, briefing]);
    return r.rows[0].id;
  }
  it("delete cascades runs, findings and state; repeated delete is false", async () => {
    await upsert(); const a = await agent(); const rid = await seedRun(a.id, A, "2026-10-16T03:00:00Z");
    await pool.query("insert into agent_findings(agent_id,user_id,run_id,dedupe_key,title,score) values($1,$2,$3,'key','Trees',1)", [a.id, A, rid]);
    await pool.query("insert into agent_state(agent_id,user_id,key,value) values($1,$2,'cursor','{}')", [a.id, A]);
    expect(await (await handleRelayMission(req({ v: 1, missionId: mission().id }), "delete", db)).json()).toEqual({ ok: true, deleted: true });
    for (const table of ["agents", "agent_runs", "agent_findings", "agent_state", "relay_missions"]) expect(Number((await pool.query(`select count(*) from ${table}`)).rows[0].count)).toBe(0);
    expect(await (await handleRelayMission(req({ v: 1, missionId: mission().id }), "delete", db)).json()).toEqual({ ok: true, deleted: false });
  });
  it("other devices cannot mutate, delete or fetch this device's missions", async () => {
    await upsert(); const a = await agent(); await seedRun(a.id, A, "2026-10-16T03:00:00Z");
    expect(await (await handleRelayMission(req({ v: 1, missionId: mission().id }, otherToken), "delete", db)).json()).toEqual({ ok: true, deleted: false });
    const results = await (await handleRelayMission(req({ v: 1, since }, otherToken), "results", db)).json(); expect(results.results).toEqual([]); expect(results.states).toEqual({});
    await upsert(1, { name: "Other user's trees" }, otherToken); expect((await agent()).display_name).toBe(a.display_name);
    expect((await pool.query("select user_id from agents where id<>$1", [a.id])).rows[0].user_id).toBe(B);
  });
  it("returns only newer successful runs, oldest first, capped at twenty with states", async () => {
    await upsert(); await upsert(1, {}, otherToken); const a = await agent(); const b = (await pool.query("select agent_id from relay_missions where device_id=$1", [other])).rows[0].agent_id;
    await seedRun(a.id, A, since); await seedRun(a.id, A, "2026-10-16T02:11:00Z", "failed"); await seedRun(b, B, "2026-10-16T02:12:00Z");
    for (let i = 21; i >= 1; i--) await seedRun(a.id, A, new Date(Date.parse("2026-10-16T03:00:00Z") + i * 60000).toISOString());
    const output = await (await handleRelayMission(req({ v: 1, since }), "results", db)).json();
    expect(output.results).toHaveLength(20); expect(output.results[0].createdAt).toBe("2026-10-16T03:01:00.000Z"); expect(output.until).toBe("2026-10-16T03:20:00.000Z"); expect(output.states).toEqual({ [mission().id]: "active" });
  });
  it("revoke removes mission agents and blocks subsequent mission requests", async () => {
    await upsert(); expect((await handleRelay(req({}), "revoke", db, "test-only")).status).toBe(200);
    expect(await agent()).toBeUndefined(); expect((await upsert()).status).toBe(401);
    for (const action of ["upsert", "delete", "results"] as const) expect((await handleRelayMission(req({}), action, db)).status).toBe(401);
  });
});
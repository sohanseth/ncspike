/**
 * Phase 3.0 agent runtime — claim_due_agents lease invariants (real DB).
 *
 * Pins the four invariants from docs/16 §22 that the SQL claim/release
 * machinery has to hold for the agent runtime to be safe:
 *
 *   I1. NO DUPLICATE RUNS
 *       Once an agent is claimed, claim_expires_at is set in the SAME
 *       transaction that returns the row. A second claim within the lease
 *       window must not include the same agent — even with a fresh
 *       Postgres session and matching cadence eligibility.
 *
 *   I2. NO UNBOUNDED BATCHES
 *       claim_due_agents(p_limit) returns at most p_limit rows; p_limit
 *       outside (0, 50] raises rather than silently capping.
 *
 *   I3. CADENCE IS MEASURED FROM last_completed_at, NOT last_claimed_at
 *       The schema correction in docs/16 §6.1 explicitly forbids the old
 *       overload. Setting last_claimed_at without last_completed_at must
 *       leave the agent due; setting last_completed_at recent must make
 *       it not-due.
 *
 *   I4. CRASH RECOVERY VIA LEASE EXPIRY
 *       An agent with claim_expires_at < now() (representing a crashed
 *       runner that never called release_agent_lease) is eligible for
 *       re-claim on the next cron tick.
 *
 * Plus two release_agent_lease checks tied to the lifecycle:
 *
 *   R1. release_agent_lease clears claim_expires_at and sets
 *       last_completed_at — so cadence starts counting from finalize.
 *
 *   R2. release_agent_lease bumps last_useful_at ONLY when items_kept > 0.
 *
 * Same skip-on-no-DB pattern as gdpr-roundtrip-realdb.test.ts and
 * cap-race-realdb.test.ts: gated on GDPR_REAL_DB_URL so the offline
 * `bun run test` path stays green; CI applies migrations then sets the URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";

const REAL_DB_URL = process.env.GDPR_REAL_DB_URL;

const USER = "44444444-4444-4444-4444-444444444444";

const describeIfDb = REAL_DB_URL ? describe : describe.skip;

describeIfDb("Phase 3.0 claim_due_agents invariants (docs/16 §22)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: REAL_DB_URL, max: 8 });
    await pool.query(`delete from auth.users where id = $1`, [USER]);
    await pool.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, $3::jsonb)`,
      [USER, `${USER}@test.local`, JSON.stringify({ name: USER })],
    );
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`delete from auth.users where id = $1`, [USER]);
    await pool.end();
  });

  beforeEach(async () => {
    // Wipe agent rows for our test user only. FK cascades clean up
    // agent_runs / agent_findings / agent_state.
    await pool.query(`delete from public.agents where user_id = $1`, [USER]);
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  async function makeAgent(opts: {
    cadenceHours?: number;
    state?: string;
    lastClaimedAt?: Date | null;
    lastCompletedAt?: Date | null;
    lastUsefulAt?: Date | null;
    claimExpiresAt?: Date | null;
  } = {}): Promise<string> {
    const r = await pool.query(
      `insert into public.agents
         (user_id, template_id, display_name, badge, budget, state,
          cadence_hours, last_claimed_at, last_completed_at,
          last_useful_at, claim_expires_at)
       values ($1, 'research_digest', 'T', 'private', '{}'::jsonb,
               $2::public.agent_state_enum, $3, $4, $5, $6, $7)
       returning id`,
      [
        USER,
        opts.state ?? "active",
        opts.cadenceHours ?? 24,
        opts.lastClaimedAt ?? null,
        opts.lastCompletedAt ?? null,
        opts.lastUsefulAt ?? null,
        opts.claimExpiresAt ?? null,
      ],
    );
    return r.rows[0].id;
  }

  async function claim(limit: number): Promise<Array<Record<string, unknown>>> {
    const r = await pool.query(
      `select * from public.claim_due_agents($1::int)`,
      [limit],
    );
    return r.rows;
  }

  async function readAgent(id: string): Promise<Record<string, unknown>> {
    const r = await pool.query(`select * from public.agents where id = $1`, [id]);
    return r.rows[0];
  }

  // ─── I1: no duplicate runs ──────────────────────────────────────────────

  it("I1: an agent claimed once is not returned by the next claim within lease window", async () => {
    const id = await makeAgent();

    const first = await claim(10);
    expect(first.map((r) => r.id)).toContain(id);

    const second = await claim(10);
    expect(second.map((r) => r.id), "lease should hide the agent").not.toContain(id);

    const after = await readAgent(id);
    expect(after.last_claimed_at, "last_claimed_at bumped").not.toBeNull();
    expect(after.claim_expires_at, "claim_expires_at set").not.toBeNull();
    expect(
      (after.claim_expires_at as Date).getTime(),
      "claim_expires_at is in the future",
    ).toBeGreaterThan(Date.now());
  });

  // ─── I2: bounded batches ────────────────────────────────────────────────

  it("I2: claim_due_agents respects p_limit when more agents are due", async () => {
    // 5 due agents, claim with p_limit=2 → 2 rows.
    for (let i = 0; i < 5; i++) await makeAgent();
    const claimed = await claim(2);
    expect(claimed.length).toBe(2);
  });

  it("I2: p_limit <= 0 raises (no silent capping at zero)", async () => {
    await expect(claim(0)).rejects.toThrow(/p_limit must be > 0/);
    await expect(claim(-1)).rejects.toThrow(/p_limit must be > 0/);
  });

  it("I2: p_limit > 50 raises (hard safety cap)", async () => {
    await expect(claim(51)).rejects.toThrow(/p_limit must be <= 50/);
  });

  // ─── I3: cadence is measured from last_completed_at ─────────────────────

  it("I3a: agent with recent last_claimed_at but NULL last_completed_at is still due", async () => {
    // If the old overloaded last_run_at semantics were still in place,
    // setting it to "1 minute ago" would suppress the agent. Under the
    // corrected schema, cadence ignores last_claimed_at entirely — only
    // last_completed_at gates the next due time.
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    const id = await makeAgent({
      lastClaimedAt: oneMinuteAgo,
      lastCompletedAt: null,
      // Lease cleared (simulating: prior claim crashed and recovered, or
      // we're seeding a fresh agent that's never finalized).
      claimExpiresAt: null,
    });

    const r = await claim(10);
    expect(
      r.map((row) => row.id),
      "cadence must read last_completed_at, not last_claimed_at",
    ).toContain(id);
  });

  it("I3b: agent with recent last_completed_at is NOT due", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000);
    const id = await makeAgent({
      cadenceHours: 24,
      lastCompletedAt: oneHourAgo,
    });
    const r = await claim(10);
    expect(r.map((row) => row.id)).not.toContain(id);
  });

  it("I3c: agent past cadence window IS due", async () => {
    const longAgo = new Date(Date.now() - 25 * 60 * 60_000); // 25h ago
    const id = await makeAgent({
      cadenceHours: 24,
      lastCompletedAt: longAgo,
    });
    const r = await claim(10);
    expect(r.map((row) => row.id)).toContain(id);
  });

  // ─── I4: crash recovery via lease expiry ────────────────────────────────

  it("I4: agent with expired claim_expires_at is re-claimable", async () => {
    // Lease that expired one minute ago — represents a runner that crashed
    // mid-run and never reached release_agent_lease. The next cron tick
    // must treat the agent as unleased.
    const expiredLease = new Date(Date.now() - 60_000);
    const id = await makeAgent({
      claimExpiresAt: expiredLease,
      lastClaimedAt: new Date(Date.now() - 31 * 60_000), // before lease expired
      lastCompletedAt: null,
    });

    const r = await claim(10);
    expect(
      r.map((row) => row.id),
      "expired lease must not block re-claim",
    ).toContain(id);

    const after = await readAgent(id);
    expect(
      (after.claim_expires_at as Date).getTime(),
      "new claim_expires_at is in the future",
    ).toBeGreaterThan(Date.now());
  });

  // ─── State-filter checks ────────────────────────────────────────────────

  it("only claims agents in (active, degraded, inactive)", async () => {
    const active   = await makeAgent({ state: "active" });
    const degraded = await makeAgent({ state: "degraded" });
    const paused   = await makeAgent({ state: "paused" });
    const draft    = await makeAgent({ state: "draft" });
    const archived = await makeAgent({ state: "archived" });

    const claimed = (await claim(10)).map((r) => r.id as string);
    expect(claimed).toContain(active);
    expect(claimed).toContain(degraded);
    expect(claimed).not.toContain(paused);
    expect(claimed).not.toContain(draft);
    expect(claimed).not.toContain(archived);
  });

  it("inactive agents run at half cadence", async () => {
    // cadence_hours=24, so inactive should be due only after 48h.
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60_000);
    const fiftyHoursAgo  = new Date(Date.now() - 50 * 60 * 60_000);

    const recentInactive = await makeAgent({
      state: "inactive",
      cadenceHours: 24,
      lastCompletedAt: thirtyHoursAgo,
    });
    const oldInactive = await makeAgent({
      state: "inactive",
      cadenceHours: 24,
      lastCompletedAt: fiftyHoursAgo,
    });

    const claimed = (await claim(10)).map((r) => r.id as string);
    expect(claimed, "inactive at 30h with 24h cadence is NOT due").not.toContain(
      recentInactive,
    );
    expect(claimed, "inactive at 50h with 24h cadence IS due").toContain(oldInactive);
  });

  // ─── R1 + R2: release_agent_lease semantics ─────────────────────────────

  it("R1: release_agent_lease clears claim_expires_at and sets last_completed_at", async () => {
    const id = await makeAgent();
    await claim(1); // claim it

    const before = await readAgent(id);
    expect(before.claim_expires_at).not.toBeNull();
    expect(before.last_completed_at).toBeNull();

    await pool.query(
      `select public.release_agent_lease($1::uuid, $2::int)`,
      [id, 0],
    );

    const after = await readAgent(id);
    expect(after.claim_expires_at, "lease cleared").toBeNull();
    expect(after.last_completed_at, "last_completed_at set").not.toBeNull();
  });

  it("R2: release_agent_lease bumps last_useful_at only when items_kept > 0", async () => {
    const idA = await makeAgent();
    const idB = await makeAgent();
    await claim(10);

    await pool.query(`select public.release_agent_lease($1::uuid, 0)`, [idA]);
    await pool.query(`select public.release_agent_lease($1::uuid, 3)`, [idB]);

    const a = await readAgent(idA);
    const b = await readAgent(idB);
    expect(a.last_useful_at, "items_kept=0 must NOT bump last_useful_at").toBeNull();
    expect(b.last_useful_at, "items_kept>0 MUST bump last_useful_at").not.toBeNull();
  });

  it("after release, agent becomes claimable again on the next cron tick (full lifecycle)", async () => {
    // cadence_hours=1, simulate a finish 2h ago → must be due now.
    const id = await makeAgent({ cadenceHours: 1 });
    await claim(1);
    await pool.query(
      `update public.agents
         set last_completed_at = now() - interval '2 hours',
             claim_expires_at  = null
       where id = $1`,
      [id],
    );

    const r = await claim(10);
    expect(r.map((row) => row.id)).toContain(id);
  });
});

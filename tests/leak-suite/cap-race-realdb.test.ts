/**
 * Per-day cap enforcement — REAL-DATABASE variant (Task #15).
 *
 * The companion file `cap-race.test.ts` stubs the supabase admin client
 * with an in-memory simulation of `reserve_inference_slot` /
 * `finalize_inference_usage` / `release_inference_slot` to pin the
 * application-side `assertCap` / `finalizeReservedUsage` /
 * `releaseReservedUsage` lifecycle. That gives fast, deterministic
 * coverage of the TS code, but it cannot catch a regression in the
 * actual SQL — a wrong advisory-lock key, a wrong status filter on the
 * cap-counting select, a wrong stale-sweep window, or a function whose
 * return signature drifts away from what the TS layer expects.
 *
 * This file closes that gap by running the cap-edge race directly
 * against a real Postgres instance with all `supabase/migrations/*.sql`
 * applied. Same skip-pattern as `gdpr-roundtrip-realdb.test.ts`: the
 * suite is gated on `GDPR_REAL_DB_URL` so the offline `bun run test`
 * path stays green; CI sets the URL via `scripts/test-gdpr-real-db.sh`,
 * which spins up an ephemeral cluster with the migrations applied.
 *
 * What it pins:
 *   1. Concurrent `reserve_inference_slot` calls at the cap edge admit
 *      EXACTLY `cap` (the advisory lock + count-and-reserve in a single
 *      transaction is honored by the real SQL, not just the JS mock).
 *   2. `finalize_inference_usage` on half + `release_inference_slot` on
 *      the rest leaves the next `reserve_inference_slot` seeing a
 *      `used_count` consistent with what's actually on disk (only `ok`
 *      and `pending` rows count, terminal `error/user_abort` do not,
 *      released rows are gone).
 *   3. The 5-minute stale-`pending` sweep clears an artificially-aged
 *      pending row, so a crashed chain run cannot permanently consume
 *      a cap slot.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";

const REAL_DB_URL = process.env.GDPR_REAL_DB_URL;

const USER = "33333333-3333-3333-3333-333333333333";
const BADGE = "flash";
const CAP = 20; // FREE_TIER_CAPS.flash — same value the in-memory test uses.
const CHAIN = ["groq", "openai"];

const describeIfDb = REAL_DB_URL ? describe : describe.skip;

describeIfDb("per-day cap enforcement against a real Postgres (task #15)", () => {
  // A pool (not a single Client) is essential: each `reserve_inference_slot`
  // call runs in its own implicit transaction and takes a
  // `pg_advisory_xact_lock`. Serializing all calls onto one client would
  // hide the very race we're trying to exercise.
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: REAL_DB_URL, max: 32 });
    // Seed the auth.users row once. The `handle_new_user` trigger will
    // create the matching public.profiles + public.user_settings rows.
    await pool.query(`delete from auth.users where id = $1`, [USER]);
    await pool.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, $3::jsonb)`,
      [USER, `${USER}@test.local`, JSON.stringify({ name: USER })],
    );
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await pool.query(`delete from auth.users where id = $1`, [USER]).catch(() => {});
      await pool.end();
    }
  });

  beforeEach(async () => {
    // Wipe just this user's inference_usage so each test starts from a
    // known-empty ledger. Keep the auth.users row across tests.
    await pool.query(`delete from public.inference_usage where user_id = $1`, [USER]);
  });

  async function reserve(): Promise<{
    usage_id: string;
    used_count: number;
    accepted: boolean;
  }> {
    const r = await pool.query(
      `select usage_id, used_count, accepted
         from public.reserve_inference_slot($1::uuid, null, $2, $3::text[], $4::int)`,
      [USER, BADGE, CHAIN, CAP],
    );
    return r.rows[0];
  }

  async function activeCount(): Promise<number> {
    // Mirrors `reserve_inference_slot`: ok + pending rows for today
    // (UTC day boundary) are what count toward the cap.
    const r = await pool.query(
      `select count(*)::int as n
         from public.inference_usage
         where user_id = $1
           and badge   = $2
           and status in ('ok','pending')
           and started_at >= date_trunc('day', timezone('UTC', now())) at time zone 'UTC'`,
      [USER, BADGE],
    );
    return r.rows[0].n as number;
  }

  it(
    "admits exactly `cap` of N concurrent reserve_inference_slot calls at the cap edge",
    async () => {
      const N = 50;

      const results = await Promise.all(
        Array.from({ length: N }, () => reserve()),
      );

      const accepted = results.filter((r) => r.accepted);
      const rejected = results.filter((r) => !r.accepted);

      expect(accepted.length).toBe(CAP);
      expect(rejected.length).toBe(N - CAP);

      // Every winner got a unique reservation id — no double-issue.
      const ids = new Set(accepted.map((r) => r.usage_id));
      expect(ids.size).toBe(CAP);

      // The on-disk ledger holds exactly `cap` ok+pending rows. This is
      // the authoritative anti-overshoot assertion: the in-memory test
      // can only show what its mock returned, this one shows what
      // Postgres actually persisted under contention.
      expect(await activeCount()).toBe(CAP);

      // Rejected reservations are persisted as `cap_exceeded` so the
      // operator can see denied requests in the usage log; they must
      // NOT count toward the next day's cap (only ok+pending do).
      const denied = await pool.query(
        `select count(*)::int as n
           from public.inference_usage
           where user_id = $1 and status = 'cap_exceeded'`,
        [USER],
      );
      expect(denied.rows[0].n).toBe(N - CAP);
    },
    30_000,
  );

  it(
    "finalize half + release rest leaves the next reserve seeing the right used_count",
    async () => {
      // Fill to cap with pending reservations.
      const winners: string[] = [];
      for (let i = 0; i < CAP; i++) {
        const r = await reserve();
        expect(r.accepted).toBe(true);
        winners.push(r.usage_id);
      }
      expect(await activeCount()).toBe(CAP);

      // Finalize the first half to status='ok' (these stay counted).
      // Release the second half (these should free their slots).
      const half = CAP / 2;
      for (let i = 0; i < half; i++) {
        const ok = await pool.query(
          `select public.finalize_inference_usage(
             $1::uuid, $2::uuid, 'ok', 'groq', 'llama-3.1-8b-instant',
             0, 10, 20, 0::bigint, 100, null, null
           ) as ok`,
          [winners[i], USER],
        );
        expect(ok.rows[0].ok).toBe(true);
      }
      for (let i = half; i < CAP; i++) {
        const ok = await pool.query(
          `select public.release_inference_slot($1::uuid, $2::uuid) as ok`,
          [winners[i], USER],
        );
        expect(ok.rows[0].ok).toBe(true);
      }

      // After half-finalize + half-release: only `half` ok rows count.
      expect(await activeCount()).toBe(half);

      // The next reservation must see used_count = half (the finalized
      // ones), and accepted=true since we're well below cap. This pins
      // the SQL's `status in ('ok','pending')` filter — a regression
      // that mistakenly counted released or terminal-error rows would
      // surface as a wrong used_count or a wrong accepted flag.
      const next = await reserve();
      expect(next.accepted).toBe(true);
      expect(next.used_count).toBe(half + 1); // existing `half` + this one

      // We can now reserve up to (cap - half - 1) more before hitting
      // the cap again. Race the boundary one more time to confirm.
      const remaining = CAP - half - 1;
      const more = await Promise.all(
        Array.from({ length: remaining + 5 }, () => reserve()),
      );
      const moreAccepted = more.filter((r) => r.accepted).length;
      expect(moreAccepted).toBe(remaining);
      expect(await activeCount()).toBe(CAP);
    },
    30_000,
  );

  it(
    "5-minute stale-pending sweep clears an artificially-aged pending row",
    async () => {
      // Reserve one slot, then back-date it past the 5-minute sweep
      // window. The next reserve call must run the in-RPC sweep and
      // delete the aged row before counting.
      const aged = await reserve();
      expect(aged.accepted).toBe(true);
      expect(await activeCount()).toBe(1);

      await pool.query(
        `update public.inference_usage
            set started_at = now() - interval '6 minutes'
          where id = $1`,
        [aged.usage_id],
      );

      // After back-dating, the active-count query (which is scoped to
      // "today" but doesn't filter by age) still sees the row — the
      // sweep is what removes it. Sanity-check that pre-state.
      const stillThere = await pool.query(
        `select 1 from public.inference_usage where id = $1 and status = 'pending'`,
        [aged.usage_id],
      );
      expect(stillThere.rowCount).toBe(1);

      // Trigger the sweep by issuing another reserve.
      const next = await reserve();
      expect(next.accepted).toBe(true);

      // The aged row is gone (swept), and only the new pending row
      // counts. used_count from the RPC is 1 (the new reservation),
      // not 2 — proving the sweep ran inside the same transaction and
      // the count happened AFTER the delete.
      expect(next.used_count).toBe(1);

      const sweptCheck = await pool.query(
        `select 1 from public.inference_usage where id = $1`,
        [aged.usage_id],
      );
      expect(sweptCheck.rowCount).toBe(0);

      expect(await activeCount()).toBe(1);
    },
    30_000,
  );
});

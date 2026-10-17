/**
 * delete_user_data must be service_role-only (prompt D step 1d): before the
 * privacy-fixes migration, any signed-in user could execute it directly.
 * Runs only when GDPR_REAL_DB_URL points at a Postgres with the migrations
 * applied (same gate as gdpr-roundtrip-realdb.test.ts).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REAL_DB_URL = process.env.GDPR_REAL_DB_URL;
const describeIfDb = REAL_DB_URL ? describe : describe.skip;

describeIfDb("delete_user_data grants (real DB)", () => {
  it("authenticated and anon cannot execute delete_user_data", async () => {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: REAL_DB_URL });
    await client.connect();
    try {
      const { rows } = await client.query(
        `select has_function_privilege('authenticated', 'public.delete_user_data(uuid)', 'execute') as auth_can,
                has_function_privilege('anon', 'public.delete_user_data(uuid)', 'execute') as anon_can,
                has_function_privilege('service_role', 'public.delete_user_data(uuid)', 'execute') as service_can`,
      );
      expect(rows[0].auth_can).toBe(false);
      expect(rows[0].anon_can).toBe(false);
      expect(rows[0].service_can).toBe(true);
    } finally {
      await client.end();
    }
  });
});

// Static counterpart that always runs: the migration itself must carry the
// revoke/grant pair, so the guarantee can't silently drift.
describe("delete_user_data grants (migration SQL)", () => {
  it("revokes public/anon/authenticated and grants service_role", () => {
    const sql = readFileSync(
      join(__dirname, "..", "..", "supabase", "migrations", "20261018000000_privacy_fixes.sql"),
      "utf8",
    );
    expect(sql).toMatch(/revoke\s+execute[\s\S]*?from\s+public,\s*anon,\s*authenticated/i);
    expect(sql).toMatch(/grant\s+execute[\s\S]*?to\s+service_role/i);
  });
});

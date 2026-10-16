/**
 * GDPR per-user table coverage check.
 *
 * Walks every SQL migration under `supabase/migrations/`, extracts every
 * `create table public.<name> (...)` block that declares a `user_id` column,
 * and asserts each one is either:
 *
 *   • exported by `EXPORT_TABLES`
 *   • wiped by `delete_user_data()` (mapped via `RPC_COLUMN_TO_TABLE`)
 *   • or explicitly listed in `GDPR_IGNORE_TABLES` with a reason.
 *
 * If a brand-new feature adds a per-user table and the engineer forgets both
 * the export array and the delete RPC, this test fails with a clear message
 * naming the table and where it was declared. That is the regression
 * inference_usage_daily slipped past us once already.
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EXPORT_TABLES,
  RPC_COLUMN_TO_TABLE,
} from "@/lib/gdpr.functions";
import {
  GDPR_IGNORE_TABLE_NAMES,
  GDPR_IGNORE_TABLES,
  findDeleteRpcTables,
  findUserIdTablesInSql,
} from "@/lib/gdpr.coverage";

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
);

async function loadMigrations(): Promise<Array<{ path: string; sql: string }>> {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((e) => e.endsWith(".sql")).sort();
  return Promise.all(
    sqlFiles.map(async (name) => ({
      path: name,
      sql: await fs.readFile(path.join(MIGRATIONS_DIR, name), "utf8"),
    })),
  );
}

describe("GDPR per-user table coverage", () => {
  it("detects owner UUIDs in compact mission table declarations", () => {
    const { tables } = findUserIdTablesInSql([{ path: "missions.sql", sql: "CREATE TABLE IF NOT EXISTS public.relay_missions (\n id uuid PRIMARY KEY, user_id uuid NOT NULL, device_id uuid NOT NULL\n);" }]);
    expect([...tables]).toEqual(["relay_missions"]);
  });
  it("every public table with a user_id column is in EXPORT_TABLES, the delete RPC body, or the ignore list", async () => {
    const migrations = await loadMigrations();
    const { tables, occurrences } = findUserIdTablesInSql(migrations);

    const exportSet = new Set<string>(EXPORT_TABLES);
    // Source of truth: actual `delete from public.<x> where user_id =
    // target_user_id` statements in the function body, NOT the UI-facing
    // RPC_COLUMN_TO_TABLE map. This is the failure mode we care about — a
    // table that's listed in the UI mapping but never actually deleted.
    const rpcDeleteSet = findDeleteRpcTables(migrations);

    const missingFromExport: string[] = [];
    const missingFromDelete: string[] = [];

    for (const t of tables) {
      if (GDPR_IGNORE_TABLE_NAMES.has(t)) continue;
      if (!exportSet.has(t)) missingFromExport.push(t);
      if (!rpcDeleteSet.has(t)) missingFromDelete.push(t);
    }

    const fmt = (names: string[]) =>
      names
        .sort()
        .map(
          (n) =>
            `  - ${n}  (declared in: ${(occurrences.get(n) ?? []).join(", ")})`,
        )
        .join("\n");

    const lines: string[] = [];
    if (missingFromExport.length) {
      lines.push(
        `Missing from EXPORT_TABLES in src/lib/gdpr.functions.ts:\n${fmt(missingFromExport)}`,
      );
    }
    if (missingFromDelete.length) {
      lines.push(
        `Missing from public.delete_user_data() function body (no \`delete from public.<table> where user_id = target_user_id\` statement found):\n${fmt(missingFromDelete)}`,
      );
    }
    if (lines.length) {
      lines.unshift(
        "Per-user table coverage drift detected. Either wire each table into both GDPR surfaces, or add it to GDPR_IGNORE_TABLES (src/lib/gdpr.coverage.ts) with a justification.",
      );
    }

    expect(lines.join("\n\n"), lines.join("\n\n")).toBe("");
  });

  it("EXPORT_TABLES, RPC_COLUMN_TO_TABLE, and the delete RPC body all describe the same set of tables", async () => {
    const migrations = await loadMigrations();
    const exportSet = new Set<string>(EXPORT_TABLES);
    const rpcMapSet = new Set<string>(Object.values(RPC_COLUMN_TO_TABLE));
    const rpcBodySet = findDeleteRpcTables(migrations);

    // export ↔ rpc-map (UI-facing) parity
    const exportOnly = [...exportSet].filter((t) => !rpcMapSet.has(t));
    const rpcMapOnly = [...rpcMapSet].filter((t) => !exportSet.has(t));

    // rpc-map (UI label) ↔ rpc-body (actual SQL DELETE) parity. This is the
    // exact gap that lets a developer "register" a table in the UI map
    // without ever wiping it. Both directions matter: a body delete with no
    // map entry would mean the UI silently swallows a counter.
    const mapWithoutBody = [...rpcMapSet].filter((t) => !rpcBodySet.has(t));
    const bodyWithoutMap = [...rpcBodySet].filter((t) => !rpcMapSet.has(t));

    expect(
      { exportOnly, rpcMapOnly, mapWithoutBody, bodyWithoutMap },
      "EXPORT_TABLES, RPC_COLUMN_TO_TABLE, and the SQL function body must all agree on the per-user table set",
    ).toEqual({
      exportOnly: [],
      rpcMapOnly: [],
      mapWithoutBody: [],
      bodyWithoutMap: [],
    });
  });

  it("GDPR_IGNORE_TABLES does not overlap with the active GDPR surfaces", async () => {
    const migrations = await loadMigrations();
    const exportSet = new Set<string>(EXPORT_TABLES);
    const rpcMapSet = new Set<string>(Object.values(RPC_COLUMN_TO_TABLE));
    const rpcBodySet = findDeleteRpcTables(migrations);
    const overlap = GDPR_IGNORE_TABLES.filter(
      (e) =>
        exportSet.has(e.table) ||
        rpcMapSet.has(e.table) ||
        rpcBodySet.has(e.table),
    ).map((e) => e.table);
    expect(
      overlap,
      `These tables are listed as ignored AND covered — pick one: ${overlap.join(", ")}`,
    ).toEqual([]);
  });

  it("every GDPR_IGNORE_TABLES entry still corresponds to a real per-user table", async () => {
    const migrations = await loadMigrations();
    const { tables } = findUserIdTablesInSql(migrations);
    const stale = GDPR_IGNORE_TABLES.filter((e) => !tables.has(e.table)).map(
      (e) => e.table,
    );
    expect(
      stale,
      `These ignore-list entries no longer match any per-user table in migrations — remove them: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("findDeleteRpcTables uses the LATEST function definition (drops, not unions, removed tables)", () => {
    // Two synthetic migrations: an older one that wipes table_a + table_b,
    // and a newer one that drops+recreates the function so it ONLY wipes
    // table_a. The parser must report {table_a}, not {table_a, table_b} —
    // otherwise a regression that silently removes a delete would be
    // hidden behind the historical union.
    const fixtures = [
      {
        path: "20260101000000_old.sql",
        sql: `
          create or replace function public.delete_user_data(target_user_id uuid)
          returns void language plpgsql as $$
          begin
            delete from public.table_a where user_id = target_user_id;
            delete from public.table_b where user_id = target_user_id;
          end;
          $$;
        `,
      },
      {
        path: "20260202000000_new.sql",
        sql: `
          drop function if exists public.delete_user_data(uuid);
          create or replace function public.delete_user_data(target_user_id uuid)
          returns void language plpgsql as $$
          begin
            delete from public.table_a where user_id = target_user_id;
          end;
          $$;
        `,
      },
    ];
    const got = findDeleteRpcTables(fixtures);
    expect([...got].sort()).toEqual(["table_a"]);
  });

  it("every GDPR_IGNORE_TABLES entry has a non-empty justification", () => {
    const blank = GDPR_IGNORE_TABLES.filter(
      (e) => !e.reason || e.reason.trim().length < 10,
    ).map((e) => e.table);
    expect(blank, `Ignore entries need a real reason: ${blank.join(", ")}`).toEqual(
      [],
    );
  });
});

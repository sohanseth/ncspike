/**
 * GDPR round-trip regression test (Phase 2.7 D8).
 *
 * Spec §14: "Delete my data" must wipe every per-user table in a single
 * transaction, and the export must surface the same set so users can verify
 * what was held. Three surfaces have to stay in lock-step:
 *
 *   1. EXPORT_TABLES                    in src/lib/gdpr.functions.ts
 *   2. RPC_COLUMN_TO_TABLE              in src/lib/gdpr.functions.ts
 *   3. public.delete_user_data(uuid)    in supabase/migrations/...
 *
 * If any one of those drifts (a table is added to the SQL but forgotten in
 * the export list, a column is renamed in the migration but not in the map,
 * etc.) account-deletion silently leaks data. This test pins all three to a
 * single source of truth — the migration SQL — and fails loudly on drift.
 *
 * What the test does:
 *
 *   - Parses the latest delete_user_data() migration to extract:
 *       * the ORDERED list of `delete from public.<t> where user_id = ...`
 *         tables (the FK-safe wipe order),
 *       * the return-table column list.
 *   - Asserts EXPORT_TABLES, RPC_COLUMN_TO_TABLE values, and the SQL
 *     delete-set are all the same set.
 *   - Asserts RPC_COLUMN_TO_TABLE keys match the SQL return columns
 *     exactly, so a column rename in the migration trips the test even if
 *     the wipe still works.
 *   - Drives an in-memory supabaseAdmin whose RPC behavior is GENERATED
 *     from the parsed SQL, not hand-maintained — so a SQL change flows
 *     into the mock automatically and any drift between the SQL and the
 *     TS contracts surfaces as a failure.
 *   - Seeds USER_A and USER_B across every table, runs export → delete →
 *     re-export, and asserts USER_A is wiped while USER_B is intact.
 *
 * The mock path is deliberate: the rest of the leak suite runs offline and
 * we don't have a CI-attached Supabase. Follow-up #4 covers running the
 * same scenario against a real ephemeral Postgres so SQL-level mistakes
 * (compilation errors, FK cascades, RLS) get caught too.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Fixed identities (deterministic, no PII) ──────────────────────────────

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

// ─── Resolve the newest migration that defines delete_user_data() ──────────
//
// Hardcoding the v2 filename would silently miss a v3 written next year.
// The migration filenames are timestamp-prefixed, so lexicographic sort is
// chronological — the last match wins.

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

function findLatestDeleteUserDataMigration(dir: string): string {
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest: string | null = null;
  for (const name of candidates) {
    const sql = readFileSync(join(dir, name), "utf8");
    if (
      /create\s+or\s+replace\s+function\s+public\.delete_user_data\s*\(/i.test(sql)
    ) {
      latest = name;
    }
  }
  if (!latest) {
    throw new Error(
      `No migration in ${dir} defines public.delete_user_data(...)`,
    );
  }
  return join(dir, latest);
}

const MIGRATION_PATH = findLatestDeleteUserDataMigration(MIGRATIONS_DIR);

type MigrationContract = {
  /** Ordered list of {table, column} pairs as they appear in the SQL. */
  pairs: ReadonlyArray<{ table: string; column: string }>;
  /** Set of table names the SQL function wipes. */
  tables: ReadonlySet<string>;
  /** Set of return-table column names declared by the SQL function. */
  returnColumns: ReadonlySet<string>;
};

function parseMigration(path: string): MigrationContract {
  const sql = readFileSync(path, "utf8");

  const deleteRe = /delete\s+from\s+public\.([a-z_][a-z0-9_]*)\s+where\s+user_id\s*=\s*target_user_id\s*;/gi;
  const deleteOrder: string[] = [];
  for (const m of sql.matchAll(deleteRe)) deleteOrder.push(m[1]);

  const returnsBlock = sql.match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  if (!returnsBlock) {
    throw new Error(`Could not locate "returns table (...)" in ${path}`);
  }
  const returnColumns = returnsBlock[1]
    .split(",")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const colMatch = line.match(/^([a-z_][a-z0-9_]*)\s+/i);
      if (!colMatch) {
        throw new Error(`Unparseable return-table line: "${line}"`);
      }
      return colMatch[1];
    });

  if (deleteOrder.length !== returnColumns.length) {
    throw new Error(
      `Migration parse mismatch: ${deleteOrder.length} delete statements vs ${returnColumns.length} return columns`,
    );
  }

  const pairs = deleteOrder.map((table, i) => ({
    table,
    column: returnColumns[i],
  }));

  return {
    pairs,
    tables: new Set(deleteOrder),
    returnColumns: new Set(returnColumns),
  };
}

const MIGRATION = parseMigration(MIGRATION_PATH);

// ─── In-memory Supabase mock (driven by parsed SQL, no hand-maintained list) ─

type Row = Record<string, unknown>;

type SupabaseAdminMock = {
  from(table: string): {
    select(cols: string): {
      eq(column: string, value: unknown): Promise<{
        data: Row[];
        error: null;
      }>;
    };
  };
  rpc(
    name: string,
    args: { target_user_id: string },
  ): Promise<{
    data: Array<Record<string, number>> | null;
    error: { message: string } | null;
  }>;
};

type Fixture = {
  store: Record<string, Row[]>;
  supabaseAdmin: SupabaseAdminMock;
};

const fixture: Fixture = vi.hoisted(() => {
  // The hoisted factory cannot capture outer-scope identifiers, so it
  // re-parses the migration itself. Same source of truth, just imported
  // inside the closure.
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");

  const migrationsDir = path.join(__dirname, "..", "..", "supabase", "migrations");
  const candidates = fs
    .readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith(".sql"))
    .sort();
  let latest: string | null = null;
  for (const name of candidates) {
    const body = fs.readFileSync(path.join(migrationsDir, name), "utf8");
    if (/create\s+or\s+replace\s+function\s+public\.delete_user_data\s*\(/i.test(body)) {
      latest = name;
    }
  }
  if (!latest) {
    throw new Error("No migration defines public.delete_user_data(...)");
  }
  const sql = fs.readFileSync(path.join(migrationsDir, latest), "utf8");

  const deleteRe = /delete\s+from\s+public\.([a-z_][a-z0-9_]*)\s+where\s+user_id\s*=\s*target_user_id\s*;/gi;
  const tables: string[] = [];
  for (const m of sql.matchAll(deleteRe)) tables.push(m[1]);

  const returnsBlock = sql.match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  const columns: string[] = (returnsBlock ? returnsBlock[1] : "")
    .split(",")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .map((line: string) => {
      const m = line.match(/^([a-z_][a-z0-9_]*)\s+/i);
      return m ? m[1] : "";
    })
    .filter((c: string) => c.length > 0);

  const pairs = tables.map((table, i) => ({ table, column: columns[i] }));

  type RowLocal = Record<string, unknown>;
  const store: Record<string, RowLocal[]> = {};

  const supabaseAdmin: SupabaseAdminMock = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(column: string, value: unknown) {
              const rows = (store[table] ?? []).filter(
                (r) => r[column] === value,
              );
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
    async rpc(name: string, args: { target_user_id: string }) {
      if (name !== "delete_user_data") {
        return { data: null, error: { message: `unknown rpc: ${name}` } };
      }
      const counts: Record<string, number> = {};
      for (const { table, column } of pairs) {
        const rows = store[table] ?? [];
        const before = rows.length;
        store[table] = rows.filter((r) => r.user_id !== args.target_user_id);
        counts[column] = before - store[table].length;
      }
      return { data: [counts], error: null };
    },
  };

  return { store, supabaseAdmin };
});

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: fixture.supabaseAdmin,
}));

// ─── Subject under test (imported AFTER mocks) ─────────────────────────────

import {
  exportAccountDataFor,
  deleteAccountFor,
  EXPORT_TABLES,
  RPC_COLUMN_TO_TABLE,
} from "@/lib/gdpr.functions";

const store = fixture.store;

function seedAllTables(userId: string, marker: string): void {
  for (const table of EXPORT_TABLES) {
    if (!store[table]) store[table] = [];
    store[table].push({
      id: `${marker}-${table}`,
      user_id: userId,
      payload: `${marker}:${table}`,
    });
  }
}

beforeEach(() => {
  for (const t of Object.keys(store)) delete store[t];
});

// ─── Drift detectors (the headline assertions) ─────────────────────────────

describe("GDPR contract alignment (TS ↔ SQL)", () => {
  it("EXPORT_TABLES exactly matches the tables the SQL function wipes", () => {
    const exportSet = new Set<string>(EXPORT_TABLES);
    const sqlSet = MIGRATION.tables;

    const onlyInExport = [...exportSet].filter((t) => !sqlSet.has(t)).sort();
    const onlyInSql = [...sqlSet].filter((t) => !exportSet.has(t)).sort();

    expect(
      onlyInExport,
      `tables EXPORTED but never DELETED by delete_user_data(): ${onlyInExport.join(", ")}`,
    ).toEqual([]);
    expect(
      onlyInSql,
      `tables DELETED by delete_user_data() but missing from EXPORT_TABLES: ${onlyInSql.join(", ")}`,
    ).toEqual([]);
  });

  it("RPC_COLUMN_TO_TABLE values match EXPORT_TABLES exactly", () => {
    const mapValues = new Set(Object.values(RPC_COLUMN_TO_TABLE));
    const exportSet = new Set<string>(EXPORT_TABLES);
    expect([...mapValues].sort()).toEqual([...exportSet].sort());
  });

  it("RPC_COLUMN_TO_TABLE keys match the SQL return-table columns exactly", () => {
    const mapKeys = new Set(Object.keys(RPC_COLUMN_TO_TABLE));
    const sqlCols = MIGRATION.returnColumns;

    const onlyInMap = [...mapKeys].filter((c) => !sqlCols.has(c)).sort();
    const onlyInSql = [...sqlCols].filter((c) => !mapKeys.has(c)).sort();

    expect(
      onlyInMap,
      `RPC columns mapped in TS but not returned by SQL: ${onlyInMap.join(", ")}`,
    ).toEqual([]);
    expect(
      onlyInSql,
      `RPC columns returned by SQL but unmapped in TS: ${onlyInSql.join(", ")}`,
    ).toEqual([]);
  });
});

// ─── Behavioral round-trip ─────────────────────────────────────────────────

describe("GDPR round-trip: export → delete → re-export", () => {
  it("exportAccountDataFor() returns every seeded row for the caller and nothing else", async () => {
    seedAllTables(USER_A, "alpha");
    seedAllTables(USER_B, "bravo");

    const result = await exportAccountDataFor(USER_A);

    const dump = JSON.parse(result.json) as {
      schema: string;
      userId: string;
      tables: Record<string, Array<Record<string, unknown>>>;
    };

    expect(dump.schema).toBe("neuralconnexions.account-export.v1");
    expect(dump.userId).toBe(USER_A);

    for (const table of EXPORT_TABLES) {
      const rows = dump.tables[table];
      expect(rows, `export missing table ${table}`).toBeDefined();
      expect(rows.length, `export should contain exactly 1 ${table} row`).toBe(1);
      expect(rows[0].user_id).toBe(USER_A);
      expect(rows[0].payload).toBe(`alpha:${table}`);
      expect(result.counts[table]).toBe(1);
    }
  });

  it("deleteAccountFor() wipes every per-user table for USER_A and leaves USER_B intact", async () => {
    seedAllTables(USER_A, "alpha");
    seedAllTables(USER_B, "bravo");

    const del = await deleteAccountFor(USER_A);

    expect(del.deleted).toBe(true);
    for (const table of EXPORT_TABLES) {
      expect(
        del.perTable[table],
        `deleteAccount should wipe ${table} (got ${del.perTable[table]})`,
      ).toBe(1);
    }

    for (const table of EXPORT_TABLES) {
      const remaining = (store[table] ?? []).filter((r) => r.user_id === USER_A);
      expect(remaining, `${table} still has USER_A rows`).toEqual([]);
    }

    for (const table of EXPORT_TABLES) {
      const bravo = (store[table] ?? []).filter((r) => r.user_id === USER_B);
      expect(bravo.length, `${table} lost a USER_B row`).toBe(1);
      expect(bravo[0].payload).toBe(`bravo:${table}`);
    }

    const reexport = await exportAccountDataFor(USER_A);
    const redump = JSON.parse(reexport.json) as {
      tables: Record<string, unknown[]>;
    };
    for (const table of EXPORT_TABLES) {
      expect(redump.tables[table], `${table} not empty after delete`).toEqual([]);
      expect(reexport.counts[table]).toBe(0);
    }

    const bravoExport = await exportAccountDataFor(USER_B);
    for (const table of EXPORT_TABLES) {
      expect(bravoExport.counts[table], `USER_B lost ${table}`).toBe(1);
    }
  });
});

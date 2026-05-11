/**
 * GDPR coverage manifest — supports the per-user-table-coverage CI check.
 *
 * The check (see `tests/gdpr/per-user-table-coverage.test.ts`) statically
 * parses every migration under `supabase/migrations/` for `create table
 * public.<name> (...)` blocks containing a `user_id` column, then asserts
 * each such table is either:
 *
 *   1. covered by the GDPR export   (`EXPORT_TABLES`), AND
 *   2. covered by the delete RPC    (`RPC_COLUMN_TO_TABLE` values), OR
 *   3. explicitly listed in `GDPR_IGNORE_TABLES` below with a justification.
 *
 * Adding a new feature with a `user_id` column? You have to either wire the
 * table into both surfaces or add it here with a comment explaining why it's
 * out of scope. Forgetting both will fail CI — that's the whole point.
 */

export type GdprIgnoreEntry = {
  table: string;
  /** Why this per-user table is intentionally excluded from export+delete. */
  reason: string;
};

/**
 * Tables with a `user_id` column that are intentionally NOT wiped by
 * `delete_user_data()` and NOT included in `exportAccountData()`.
 *
 * Every entry is treated as an audit checkpoint: when a table appears here it
 * means a human has decided the data is either (a) cascade-deleted via the
 * `auth.users` foreign key when the auth row goes away, (b) operational /
 * non-personal telemetry where the user_id is just a soft attribution, or
 * (c) a shared lookup the GDPR surfaces don't own.
 *
 * NOTE: every `user_id` here is declared `references auth.users(id) on delete
 * cascade` (or `set null`), so when the auth.users row is removed via the
 * Supabase admin API the rows go with it. The GDPR delete RPC explicitly
 * does NOT touch auth.users (see header in `gdpr.functions.ts`), so any
 * table listed here will only be cleaned up at full-account-removal time, not
 * at "delete my data" time. If you need it wiped earlier, move it into
 * `EXPORT_TABLES` + the delete RPC instead of leaving it here.
 *
 * The "Verify the GDPR delete really wipes everything (regression test)"
 * follow-up task is the canonical place to revisit each of these and decide
 * whether the current categorization is correct.
 */
export const GDPR_IGNORE_TABLES: readonly GdprIgnoreEntry[] = [
  {
    table: "user_endpoints",
    reason:
      "Per-user provider endpoint config — cascades from auth.users; not user-generated content the export surfaces.",
  },
  {
    table: "connections",
    reason:
      "OAuth/connection records — cascades from auth.users on full account removal.",
  },
  {
    table: "watchers",
    reason:
      "Background watcher subscriptions — cascades from auth.users; operational state, not export-surface content.",
  },
  {
    table: "voice_profiles",
    reason:
      "Per-user voice tuning — cascades from auth.users on full account deletion.",
  },
  {
    table: "drafts",
    reason:
      "Outgoing message drafts — cascades from auth.users on full account deletion; not part of the chat/memory export.",
  },
  {
    table: "research_tasks",
    reason:
      "Background research jobs — cascades from auth.users on full account deletion.",
  },
  {
    table: "tool_invocations",
    reason:
      "Tool call audit log — cascades from auth.users on full account deletion.",
  },
  {
    table: "device_tokens",
    reason:
      "Push notification device tokens — cascades from auth.users on full account deletion.",
  },
  {
    table: "push_permission_events",
    reason:
      "Push permission telemetry — cascades from auth.users on full account deletion.",
  },
  {
    table: "auth_callback_rejections",
    reason:
      "Auth-callback failure log; user_id is `on delete set null`, retained as security telemetry per spec.",
  },
  {
    table: "cron_run",
    reason:
      "Cron execution audit; user_id is `on delete set null` (admin runs have null), retained as operational telemetry.",
  },
  {
    table: "search_queries",
    reason:
      "TEMP: Brought in by the May-10 merge from origin (web-search history surface). Must be wired into EXPORT_TABLES + delete_user_data() RPC before paid-tier launch — tracked as a follow-up. Cascades from auth.users on full account deletion in the meantime.",
  },
] as const;

export const GDPR_IGNORE_TABLE_NAMES: ReadonlySet<string> = new Set(
  GDPR_IGNORE_TABLES.map((e) => e.table),
);

/**
 * Parse all `create table [if not exists] public.<name> (...)` blocks across
 * a set of SQL migration files and return the names of those whose body
 * declares a `user_id` column.
 *
 * Pure / synchronous so it can run inside vitest without a live DB. We use
 * static parsing rather than `information_schema` because CI doesn't have a
 * Postgres instance handy and migrations are the source of truth anyway.
 */
export function findUserIdTablesInSql(sources: ReadonlyArray<{ path: string; sql: string }>): {
  tables: Set<string>;
  occurrences: Map<string, string[]>;
} {
  const tables = new Set<string>();
  const occurrences = new Map<string, string[]>();

  // Matches: create table [if not exists] public.<name> ( ... );
  // The body is captured non-greedily up to the first `\n);` (column 0
  // closing paren + semicolon) — the convention every migration in this repo
  // follows for table definitions.
  const re =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\)\s*;/gi;

  // A `user_id` column declaration starts at the beginning of a line (after
  // optional whitespace) followed by `user_id` and at least one space and a
  // type token. This avoids matching `(user_id)` inside an index expression
  // or `auth.uid() = user_id` inside an RLS policy that might appear elsewhere.
  const colRe = /^\s*user_id\s+[a-z]/im;

  // Also catch later-added user_id columns:
  //   alter table public.<name> add [column] user_id ...
  const alterRe =
    /alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z_][a-z0-9_]*)\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?user_id\s+[a-z]/gi;

  const record = (name: string, path: string) => {
    tables.add(name);
    const list = occurrences.get(name) ?? [];
    list.push(path);
    occurrences.set(name, list);
  };

  for (const { path, sql } of sources) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const name = m[1];
      const body = m[2];
      if (colRe.test(body)) record(name, path);
    }

    alterRe.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = alterRe.exec(sql)) !== null) {
      record(a[1], path);
    }
  }

  return { tables, occurrences };
}

/**
 * Extract the set of tables actually wiped by the **latest effective**
 * definition of `public.delete_user_data(...)`.
 *
 * Migrations are applied in lexicographic order (Supabase convention:
 * timestamp-prefixed filenames), so the last `create [or replace] function
 * public.delete_user_data(...)` block in the sorted migration sequence is
 * the version Postgres ends up running. We parse only THAT body for
 * `delete from public.<x> where user_id = <param>` statements.
 *
 * Why not union across history? If a later migration accidentally drops a
 * delete for a table that earlier versions wiped, a union would still
 * report the table as "covered" and silently hide the regression. Taking
 * only the latest definition makes this test fail loudly in that case,
 * which is the whole point of the check.
 *
 * Returns an empty set if no definition is found (which itself would be a
 * problem and is asserted by the caller indirectly).
 */
export function findDeleteRpcTables(
  sources: ReadonlyArray<{ path: string; sql: string }>,
): Set<string> {
  // Sort by path so migration order is deterministic and matches what the
  // database actually applied. Callers may already pass a sorted list, but
  // we sort defensively.
  const ordered = [...sources].sort((a, b) => a.path.localeCompare(b.path));

  // Match: create [or replace] function public.delete_user_data(<param> ...)
  // ... language plpgsql ... as $$ <body> $$;
  // Capture the parameter name and the dollar-quoted body.
  const fnRe =
    /create\s+(?:or\s+replace\s+)?function\s+public\.delete_user_data\s*\(\s*([a-z_][a-z0-9_]*)\b[^)]*\)[\s\S]*?as\s+\$\$([\s\S]*?)\$\$\s*;/gi;

  let latestParam: string | null = null;
  let latestBody: string | null = null;

  for (const { sql } of ordered) {
    fnRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(sql)) !== null) {
      // Each successive match overwrites — the final assignment is the
      // latest effective definition across all migrations.
      latestParam = m[1];
      latestBody = m[2];
    }
  }

  const tables = new Set<string>();
  if (latestBody === null || latestParam === null) return tables;

  const escapedParam = latestParam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delRe = new RegExp(
    `delete\\s+from\\s+public\\.([a-z_][a-z0-9_]*)\\s+where\\s+user_id\\s*=\\s*${escapedParam}\\b`,
    "gi",
  );
  let d: RegExpExecArray | null;
  while ((d = delRe.exec(latestBody)) !== null) {
    tables.add(d[1]);
  }
  return tables;
}

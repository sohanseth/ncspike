/**
 * Phase 2.9a slice-a — attachment_kind migration shape check.
 *
 * The leak-suite already has an offline GDPR roundtrip test that parses
 * SQL files; this one is narrower: it confirms the new column has the
 * shape slice-b will rely on (default 'image_in', not-null, CHECK
 * restricted to {'image_in','image_out'}, idempotency guards present).
 *
 * Real-DB application is covered by `gdpr-roundtrip-realdb.test.ts` when
 * `GDPR_REAL_DB_URL` is set. This test runs offline against the SQL text.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SQL_PATH = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260518000000_phase29a_attachment_kind.sql",
);

describe("Phase 2.9a — attachment_kind migration", () => {
  const sql = readFileSync(SQL_PATH, "utf8");

  it("adds attachment_kind with default 'image_in' and not-null", () => {
    expect(sql).toMatch(
      /add column if not exists attachment_kind text not null default 'image_in'/,
    );
  });

  it("constrains attachment_kind to {'image_in','image_out'}", () => {
    expect(sql).toMatch(
      /check\s*\(\s*attachment_kind in \(\s*'image_in'\s*,\s*'image_out'\s*\)\s*\)/,
    );
  });

  it("guards re-runs with to_regclass and drop-if-exists on the constraint", () => {
    expect(sql).toMatch(/to_regclass\('public\.chat_message_attachments'\)/);
    expect(sql).toMatch(
      /drop constraint if exists chat_message_attachments_kind_check/,
    );
  });

  it("does not modify RLS or storage bucket policies (slice-a scope)", () => {
    expect(sql).not.toMatch(/alter\s+policy/i);
    expect(sql).not.toMatch(/storage\.buckets/i);
    expect(sql).not.toMatch(/storage\.objects/i);
    // No new RLS policies on the table either.
    expect(sql).not.toMatch(/create\s+policy/i);
  });

  it("backfill is idempotent (only updates NULLs)", () => {
    expect(sql).toMatch(
      /update public\.chat_message_attachments\s+set attachment_kind = 'image_in'\s+where attachment_kind is null/,
    );
  });
});

/**
 * GDPR round-trip — REAL-DATABASE variant (Phase 2.7 D8, follow-up #4).
 *
 * The companion file `gdpr-roundtrip.test.ts` exercises an in-memory
 * Supabase mock that is generated from the SQL of the latest
 * `delete_user_data()` migration. That catches contract drift between the
 * TS export list, the RPC column map, and the SQL DELETE list — but it
 * cannot catch SQL-level mistakes:
 *
 *   - a typo in a table name inside the function body,
 *   - a Postgres function that no longer compiles after a migration,
 *   - a missing FK cascade that lets orphans linger,
 *   - an RLS policy that silently blocks the DELETE.
 *
 * This file closes that gap by running the SAME scenario against a real
 * Postgres instance with all `supabase/migrations/*.sql` applied. It is
 * gated by the env var `GDPR_REAL_DB_URL`; without it the suite skips so
 * the offline `bun run test` path stays green. CI sets the URL via
 * `scripts/test-gdpr-real-db.sh`, which spins up an ephemeral cluster.
 *
 * Why a separate file (not a flag in the mock test): the two paths have
 * different failure modes and different setup costs. Keeping them apart
 * means the mock test stays a fast unit-style guard while this one is the
 * heavyweight end-to-end check.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { EXPORT_TABLES, RPC_COLUMN_TO_TABLE } from "@/lib/gdpr.functions";

const REAL_DB_URL = process.env.GDPR_REAL_DB_URL;

// ─── Fixed identities (deterministic, no PII) ──────────────────────────────

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

// ─── Per-table seed strategy ───────────────────────────────────────────────
//
// One seed row per (table, user). Columns are the minimum needed to satisfy
// NOT NULL / CHECK constraints; everything else is left to its default.
//
// thread ids are passed in so chat_messages / chat_context_log can reference
// the per-user chat_threads / chat_messages rows.

type SeedRow = (userId: string, ctx: { threadId: string; messageId: string }) =>
  { columns: string[]; values: unknown[] };

const SEEDS: Record<string, SeedRow> = {
  relay_pairing_codes: (userId) => ({ columns: ["user_id", "code_hash", "expires_at"], values: [userId, `code-${userId}`, new Date(Date.now() + 600000)] }),
  relay_devices: (userId) => ({ columns: ["user_id", "name", "token_hash"], values: [userId, "Test Mac", `token-${userId}`] }),
  relay_cards: (userId, ctx) => ({ columns: ["user_id", "device_id", "ref", "key_id", "nonce", "ciphertext", "expires_at"], values: [userId, ctx.threadId, "a".repeat(24), "a".repeat(8), "AAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAA==", new Date(Date.now() + 600000)] }),
  user_settings: (userId) => ({
    columns: ["user_id"],
    values: [userId],
  }),
  user_traits: (userId) => ({
    columns: ["user_id", "sheet"],
    values: [userId, { v: 1 }],
  }),
  user_trait_blocks: (userId) => ({
    columns: ["user_id", "category", "trait_path", "blocked_until"],
    values: [userId, "test_cat", "test.path", new Date(Date.now() + 86_400_000)],
  }),
  user_provider_category_blocks: (userId) => ({
    columns: ["user_id", "provider_tier", "category"],
    values: [userId, 1, "test_cat"],
  }),
  user_known_names: (userId) => ({
    columns: ["user_id", "name", "source"],
    values: [userId, `name-${userId.slice(0, 8)}`, "manual"],
  }),
  pii_scrub_events: (userId) => ({
    columns: ["user_id", "pattern_class"],
    values: [userId, "email"],
  }),
  extraction_failures: (userId) => ({
    columns: ["user_id", "failure_class"],
    values: [userId, "zod_reject"],
  }),
  memory_nodes: (userId) => ({
    columns: ["user_id", "node_type", "label"],
    values: [userId, "note", "seed"],
  }),
  memory_edges: (userId, ctx) => ({
    // Reuses the per-user node we'll insert just before this row.
    // The fixture inserts memory_nodes first and pins the id in ctx so
    // memory_edges can reference it for both endpoints.
    columns: ["user_id", "from_node", "to_node", "relation"],
    values: [userId, ctx.threadId, ctx.threadId, "self"],
  }),
  chat_threads: (userId) => ({
    columns: ["user_id"],
    values: [userId],
  }),
  chat_messages: (userId, ctx) => ({
    columns: ["user_id", "thread_id", "role", "content"],
    values: [userId, ctx.threadId, "user", "hello"],
  }),
  chat_message_attachments: (userId, ctx) => ({
    // Lovable's vision feature (migration 20260508221834_*). Requires a real
    // chat_messages row to point at — the fixture seeds chat_messages first
    // and pins messageId in ctx so this can FK-reference it.
    columns: ["user_id", "message_id", "storage_path", "mime"],
    values: [userId, ctx.messageId, `${userId}/seed.png`, "image/png"],
  }),
  chat_context_log: (userId, ctx) => ({
    columns: ["user_id", "message_id", "badge", "strictest_tier"],
    values: [userId, ctx.messageId, "flash", 1],
  }),
  inference_usage: (userId) => ({
    columns: ["user_id", "badge", "provider_chain", "provider_used", "status"],
    values: [userId, "flash", ["openai"], "openai", "ok"],
  }),
  inference_usage_daily: (userId) => ({
    columns: ["user_id", "day", "badge", "provider_used"],
    values: [userId, "2026-05-01", "flash", "openai"],
  }),
  search_queries: (userId) => ({
    // Brought in by the May-10 web-search merge from origin
    // (migration 20260510103014_*). Wired into delete_user_data() via
    // 20260517000300_phase29_gdpr_search_queries.sql.
    columns: ["user_id", "query", "engine"],
    values: [userId, "seed query", "perplexity"],
  }),
  // ─── Phase 3.0 agent runtime (migration 20260601000000_*) ────────────────
  // These four tables FK-chain: agent_findings → agent_runs + agents,
  // agent_state → agents, agent_runs → agents. The seedUser() function
  // below inserts them in FK order; the SEEDS entries here are stub shapes
  // used only by the EXPORT_TABLES coverage assertion above. Real inserts
  // happen inline in seedUser() because they need ids passed between rows.
  agents: (userId) => ({
    columns: ["user_id", "template_id", "display_name", "badge", "budget"],
    values: [userId, "research_digest", "Test agent", "private", {}],
  }),
  agent_runs: (userId) => ({
    columns: ["agent_id", "user_id"],
    values: ["00000000-0000-0000-0000-000000000000", userId],
  }),
  agent_findings: (userId) => ({
    columns: ["agent_id", "user_id", "run_id", "dedupe_key", "title", "score"],
    values: [
      "00000000-0000-0000-0000-000000000000",
      userId,
      "00000000-0000-0000-0000-000000000000",
      "seed",
      "seed finding",
      0.5,
    ],
  }),
  agent_state: (userId) => ({
    columns: ["agent_id", "user_id", "key", "value"],
    values: ["00000000-0000-0000-0000-000000000000", userId, "cursor", { v: 1 }],
  }),
  // ─── Privacy fixes (migration 20261018000000_*) — newly wiped tables ─────
  connections: (userId) => ({
    columns: ["user_id", "provider"],
    values: [userId, "gmail"],
  }),
  drafts: (userId) => ({
    columns: ["user_id", "template", "body_encrypted", "chars_in_draft"],
    values: [userId, "reply", "enc-seed", 10],
  }),
  voice_profiles: (userId) => ({
    columns: ["user_id", "expires_at"],
    values: [userId, new Date(Date.now() + 86_400_000)],
  }),
  research_tasks: (userId) => ({
    columns: ["user_id", "tool_id", "input", "input_key"],
    values: [userId, "research_thread_context", {}, "seed-key"],
  }),
  user_endpoints: (userId) => ({
    columns: ["user_id"],
    values: [userId],
  }),
  watchers: (userId) => ({
    columns: ["user_id", "kind", "target", "rule"],
    values: [userId, "web", "example.com", {}],
  }),
};

// ─── Ensure every EXPORT_TABLES entry has a seed strategy ──────────────────

for (const t of EXPORT_TABLES) {
  if (!(t in SEEDS)) {
    throw new Error(
      `gdpr-roundtrip-realdb: missing SEEDS entry for table "${t}". ` +
        `Add one so the real-DB regression covers it.`,
    );
  }
}

// ─── Test wiring ───────────────────────────────────────────────────────────

const describeIfDb = REAL_DB_URL ? describe : describe.skip;

describeIfDb("GDPR round-trip against a real Postgres", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: REAL_DB_URL });
    await client.connect();
  }, 30_000);

  afterAll(async () => {
    if (client) await client.end();
  });

  beforeEach(async () => {
    // FK-safe wipe: same order as delete_user_data() itself.
    await client.query("begin");
    try {
      for (const t of [
        "relay_cards", "relay_devices", "relay_pairing_codes",
        // FK-safe: children first within each subsystem.
        "agent_findings",
        "agent_state",
        "agent_runs",
        "agents",
        "chat_messages",
        "chat_context_log",
        "chat_threads",
        "pii_scrub_events",
        "extraction_failures",
        "user_trait_blocks",
        "user_provider_category_blocks",
        "user_known_names",
        "user_traits",
        "memory_edges",
        "memory_nodes",
        "inference_usage",
        "inference_usage_daily",
        "user_settings",
        "search_queries",
        "profiles",
      ]) {
        await client.query(`delete from public.${t}`);
      }
      await client.query("delete from auth.users");
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  });

  /**
   * Insert one auth.users row (which fires the on_auth_user_created
   * trigger and creates public.profiles + public.user_settings) and one
   * row per per-user table. Returns the thread + message ids so the
   * caller can reason about what was seeded.
   */
  async function seedUser(userId: string): Promise<void> {
    await client.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, $3::jsonb)`,
      [userId, `${userId}@test.local`, JSON.stringify({ name: userId })],
    );

    // Seed in FK order: parents first.
    // 1. memory_nodes (memory_edges references it)
    const node = SEEDS.memory_nodes(userId, { threadId: "", messageId: "" });
    const nodeRes = await client.query(
      `insert into public.memory_nodes (${node.columns.join(",")})
       values (${node.columns.map((_, i) => `$${i + 1}`).join(",")})
       returning id`,
      node.values,
    );
    const nodeId: string = nodeRes.rows[0].id;

    // memory_edges needs a node id for both endpoints; rebuild seed.
    await client.query(
      `insert into public.memory_edges (user_id, from_node, to_node, relation)
       values ($1, $2, $2, 'self')`,
      [userId, nodeId],
    );

    // 2. chat_threads → chat_messages → chat_context_log
    const threadRes = await client.query(
      `insert into public.chat_threads (user_id) values ($1) returning id`,
      [userId],
    );
    const threadId: string = threadRes.rows[0].id;

    const msgRes = await client.query(
      `insert into public.chat_messages (user_id, thread_id, role, content)
       values ($1, $2, 'user', 'hello') returning id`,
      [userId, threadId],
    );
    const messageId: string = msgRes.rows[0].id;

    await client.query(
      `insert into public.chat_context_log (user_id, message_id, badge, strictest_tier)
       values ($1, $2, 'flash', 1)`,
      [userId, messageId],
    );

    // chat_message_attachments — depends on chat_messages.id (FK cascade).
    // Seeded explicitly so the pre-delete count is 1 and the post-delete
    // assertion validates the new explicit `delete from
    // public.chat_message_attachments` in 20260516_phase28_*.sql, not just
    // the cascade.
    {
      const seed = SEEDS.chat_message_attachments(userId, { threadId, messageId });
      await client.query(
        `insert into public.chat_message_attachments (${seed.columns.join(",")})
         values (${seed.columns.map((_, i) => `$${i + 1}`).join(",")})`,
        seed.values,
      );
    }

    // 3. Everything else — order-independent, no per-row FK to siblings.
    const device = await client.query("insert into public.relay_devices (user_id,name,token_hash) values ($1,'Test Mac',$2) returning id", [userId, `token-${userId}`]);
    const relaySeed = SEEDS.relay_cards(userId, { threadId: device.rows[0].id, messageId });
    await client.query(`insert into public.relay_cards (${relaySeed.columns.join(",")}) values (${relaySeed.columns.map((_, i) => `$${i + 1}`).join(",")})`, relaySeed.values);
    const independent = [
      "relay_pairing_codes",
      "user_traits",
      "user_trait_blocks",
      "user_provider_category_blocks",
      "user_known_names",
      "pii_scrub_events",
      "extraction_failures",
      "inference_usage",
      "inference_usage_daily",
      "search_queries",
    ];
    for (const t of independent) {
      const seed = SEEDS[t](userId, { threadId, messageId });
      await client.query(
        `insert into public.${t} (${seed.columns.join(",")})
         values (${seed.columns.map((_, i) => `$${i + 1}`).join(",")})`,
        seed.values,
      );
    }

    // 4. Phase 3.0 agent runtime — chain agents → agent_runs → agent_findings,
    // with agent_state hanging off agents. FK-ordered inserts using returned ids.
    const agentRes = await client.query(
      `insert into public.agents
         (user_id, template_id, display_name, badge, budget, state)
       values ($1, 'research_digest', 'Test agent', 'private', '{}'::jsonb, 'active')
       returning id`,
      [userId],
    );
    const agentId: string = agentRes.rows[0].id;

    const runRes = await client.query(
      `insert into public.agent_runs (agent_id, user_id) values ($1, $2) returning id`,
      [agentId, userId],
    );
    const runId: string = runRes.rows[0].id;

    await client.query(
      `insert into public.agent_findings
         (agent_id, user_id, run_id, dedupe_key, title, score)
       values ($1, $2, $3, 'seed-dedupe', 'seed finding', 0.5)`,
      [agentId, userId, runId],
    );

    await client.query(
      `insert into public.agent_state (agent_id, user_id, key, value)
       values ($1, $2, 'cursor', '{"v":1}'::jsonb)`,
      [agentId, userId],
    );

    // user_settings was auto-created by the on_auth_user_created trigger,
    // so it already has exactly one row for this user. Don't insert again.
  }

  async function countFor(table: string, userId: string): Promise<number> {
    const r = await client.query(
      `select count(*)::int as n from public.${table} where user_id = $1`,
      [userId],
    );
    return r.rows[0].n as number;
  }

  it("delete_user_data() compiles and is callable with the expected return shape", async () => {
    const r = await client.query(
      `select * from public.delete_user_data($1::uuid)`,
      [USER_A],
    );
    expect(r.rows.length).toBe(1);
    const row = r.rows[0];
    for (const col of Object.keys(RPC_COLUMN_TO_TABLE)) {
      expect(row, `RPC return missing column ${col}`).toHaveProperty(col);
      expect(typeof row[col], `${col} should be a number`).toBe("number");
    }
  });

  it("wipes USER_A across every per-user table and leaves USER_B intact", async () => {
    await seedUser(USER_A);
    await seedUser(USER_B);

    // Sanity: every table has 1 row for each user before the delete.
    for (const t of EXPORT_TABLES) {
      expect(await countFor(t, USER_A), `pre-delete USER_A ${t}`).toBe(1);
      expect(await countFor(t, USER_B), `pre-delete USER_B ${t}`).toBe(1);
    }

    const r = await client.query(
      `select * from public.delete_user_data($1::uuid)`,
      [USER_A],
    );
    const row = r.rows[0] as Record<string, number>;

    // Every RPC return column should report 0 or 1 — never negative or
    // unexpectedly large. We don't insist on exactly 1 because some tables
    // (chat_context_log) cascade-delete via FK when chat_messages is wiped
    // first; the explicit DELETE then sees no rows. The authoritative
    // "wiped or not" check is the per-table row-count assertion below.
    for (const [col, table] of Object.entries(RPC_COLUMN_TO_TABLE)) {
      expect(
        row[col],
        `${col} (${table}) returned non-sensible count ${row[col]}`,
      ).toBeGreaterThanOrEqual(0);
      expect(row[col]).toBeLessThanOrEqual(1);
    }

    // USER_A is gone everywhere.
    for (const t of EXPORT_TABLES) {
      expect(await countFor(t, USER_A), `post-delete USER_A ${t}`).toBe(0);
    }

    // USER_B is untouched everywhere.
    for (const t of EXPORT_TABLES) {
      expect(await countFor(t, USER_B), `post-delete USER_B ${t}`).toBe(1);
    }
  });

  it("is idempotent: a second call for the same user returns all-zeros", async () => {
    await seedUser(USER_A);
    await client.query(`select * from public.delete_user_data($1::uuid)`, [USER_A]);

    const r = await client.query(
      `select * from public.delete_user_data($1::uuid)`,
      [USER_A],
    );
    const row = r.rows[0] as Record<string, number>;
    for (const col of Object.keys(RPC_COLUMN_TO_TABLE)) {
      expect(row[col], `second call ${col} should be 0`).toBe(0);
    }
  });
});

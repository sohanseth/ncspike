/**
 * Phase 3.0 PR3b — full pipeline against a real Postgres + real Supabase admin.
 *
 * Companion to `phase30-research-digest.test.ts` (in-memory unit + pipeline
 * tests). The in-memory test proves the JS pipeline; this one proves the
 * SQL schema accepts what ResearchDigest actually writes:
 *
 *   - agent_findings.payload jsonb shape
 *   - agent_findings.score CHECK constraint
 *   - agent_findings.urgency CHECK constraint
 *   - agent_runs.status enum + cost_usd numeric width
 *   - agent_state upsert + value jsonb
 *   - the UNIQUE(agent_id, dedupe_key) dedupe guard with real onConflict
 *
 * Same skip-on-no-DB pattern as `gdpr-roundtrip-realdb.test.ts` and
 * `phase30-claim-due-agents-realdb.test.ts`. Gated on two env vars:
 *
 *   GDPR_REAL_DB_URL          — postgres:// for pg.Client (seed + assert)
 *   SUPABASE_URL              — Supabase project URL (admin HTTPS client)
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (same admin client)
 *
 * Missing any → skip. CI sets all three; local dev opts in by exporting them.
 *
 * Only the truly external APIs are mocked (SearXNG + LLM dispatcher). All
 * Supabase reads and writes go to the real cluster.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";

const REAL_DB_URL = process.env.GDPR_REAL_DB_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const enabled = Boolean(REAL_DB_URL && SUPABASE_URL && SERVICE_ROLE);
const describeIfReal = enabled ? describe : describe.skip;

// ─── Mock only the external APIs (search + LLM). Supabase = real. ────────

let searxngCalls: string[] = [];
vi.mock("@/lib/search.functions", () => ({
  searxngSearch: vi.fn(async (q: string) => {
    searxngCalls.push(q);
    return {
      instance: "https://test.searxng.example",
      lastError: null,
      results: [
        {
          title: `${q} article one`,
          url: `https://e2e.test/${encodeURIComponent(q)}/one`,
          snippet: `Snippet one about ${q}.`,
          engine: "duckduckgo",
        },
        {
          title: `${q} article two`,
          url: `https://e2e.test/${encodeURIComponent(q)}/two`,
          snippet: `Snippet two about ${q}.`,
          engine: "google",
        },
      ],
    };
  }),
}));

vi.mock("@/server/inference", () => ({
  generate: vi.fn(async (req: { maxTokens?: number }) => {
    // Distinguish score (small max-tokens) from summarise (larger) calls.
    const isScore = (req.maxTokens ?? 0) <= 16;
    return {
      text: isScore ? "0.85" : "End-to-end summary sentence one. Sentence two follows.",
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      inputTokens: 90,
      outputTokens: isScore ? 4 : 60,
    };
  }),
}));

// We let queue + budget hit real Supabase too — the in-memory test already
// pinned their behavior; here we want the full real path exercised once.

// ─── Subjects (import after vi.mock) ─────────────────────────────────────

import { execute } from "@/server/agents/runner";
import { resolveTemplate } from "@/server/agents/templates";
import type { AgentRow, BrokerContext } from "@/server/agents/types";

// ─── Test wiring ─────────────────────────────────────────────────────────

const USER = "55555555-5555-5555-5555-555555555555";
const BROKER: BrokerContext = {
  fragment: "(opaque broker fragment — pinned for e2e)",
  resolvedTier: 1,
};

describeIfReal("Phase 3.0 PR3b — ResearchDigest → real Supabase end-to-end", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: REAL_DB_URL!, max: 4 });
    // Seed the user once. handle_new_user trigger creates profiles + settings.
    await pool.query(`delete from auth.users where id = $1`, [USER]);
    await pool.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, $3::jsonb)`,
      [USER, `${USER}@e2e.test`, JSON.stringify({ name: USER })],
    );
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    // Cascade from auth.users wipes per-user rows including the agent tables.
    await pool.query(`delete from auth.users where id = $1`, [USER]);
    await pool.end();
  });

  beforeEach(async () => {
    searxngCalls = [];
    vi.clearAllMocks();
    // Wipe the user's agent rows before each test (cascade-safe order).
    await pool.query(`delete from public.agent_findings where user_id = $1`, [USER]);
    await pool.query(`delete from public.agent_state where user_id = $1`, [USER]);
    await pool.query(`delete from public.agent_runs where user_id = $1`, [USER]);
    await pool.query(`delete from public.agents where user_id = $1`, [USER]);
  });

  async function seedResearchAgent(): Promise<AgentRow> {
    const r = await pool.query(
      `insert into public.agents
         (user_id, template_id, display_name, badge, budget, state, cadence_hours,
          last_claimed_at, claim_expires_at)
       values ($1, 'research_digest', 'E2E research digest', 'flash',
               $2::jsonb, 'active', 24, now(), now() + interval '30 minutes')
       returning *`,
      [
        USER,
        JSON.stringify({
          maxRunsPerDay: 5,
          maxItemsConsideredPerRun: 30,
          maxLLMHopsPerItem: 1,
          maxNotificationsPerDay: 1,
        }),
      ],
    );
    const row = r.rows[0];
    // Inject the config (separate update so JSONB stays clean).
    await pool.query(
      `update public.agents set config = $2::jsonb where id = $1`,
      [
        row.id,
        JSON.stringify({
          topics: ["e2e topic alpha", "e2e topic beta"],
          minScore: 0.5,
        }),
      ],
    );
    return { ...row, config: { topics: ["e2e topic alpha", "e2e topic beta"], minScore: 0.5 } };
  }

  it("execute(agent, deps) writes a complete run + findings to real Supabase", async () => {
    const agent = await seedResearchAgent();

    const run = await execute(agent, {
      resolveTemplate,
      assembleBroker: async () => BROKER,
      now: () => new Date(),
    });

    expect(run.status).toBe("ok");
    expect(run.items_fetched).toBe(4); // 2 topics × 2 search hits
    expect(run.items_kept).toBe(4);
    expect(run.cost_usd).toBeGreaterThan(0);

    // SearXNG mock was called per topic.
    expect(searxngCalls).toEqual(["e2e topic alpha", "e2e topic beta"]);

    // The run row landed in the real DB.
    const runRow = await pool.query(
      `select status, items_fetched, items_kept, cost_usd from public.agent_runs where id = $1`,
      [run.id],
    );
    expect(runRow.rows[0].status).toBe("ok");
    expect(runRow.rows[0].items_fetched).toBe(4);
    expect(runRow.rows[0].items_kept).toBe(4);
    expect(Number(runRow.rows[0].cost_usd)).toBeGreaterThan(0);

    // Findings persisted with the right shape — proves the jsonb payload +
    // score CHECK + urgency CHECK constraints all accept what ResearchDigest
    // actually writes.
    const findings = await pool.query(
      `select title, payload, score, urgency, state, source_url
         from public.agent_findings
        where user_id = $1
        order by title`,
      [USER],
    );
    expect(findings.rows).toHaveLength(4);
    for (const row of findings.rows) {
      expect(row.urgency).toBe("normal");
      expect(row.state).toBe("new");
      expect(Number(row.score)).toBeGreaterThan(0);
      expect(Number(row.score)).toBeLessThanOrEqual(1);
      expect(row.source_url).toMatch(/^https:\/\/e2e\.test\//);
      expect(row.payload).toHaveProperty("matched_topic");
      expect(row.payload).toHaveProperty("provider", "groq");
    }

    // Dedupe state persisted.
    const stateRow = await pool.query(
      `select value from public.agent_state
        where agent_id = $1 and key = 'seen_dedupe_keys'`,
      [agent.id],
    );
    expect(stateRow.rows).toHaveLength(1);
    expect(stateRow.rows[0].value).toHaveLength(4);

    // Lifecycle was released.
    const lifecycle = await pool.query(
      `select last_completed_at, last_useful_at, claim_expires_at
         from public.agents where id = $1`,
      [agent.id],
    );
    expect(lifecycle.rows[0].last_completed_at).not.toBeNull();
    expect(lifecycle.rows[0].last_useful_at).not.toBeNull();
    expect(lifecycle.rows[0].claim_expires_at).toBeNull();
  });

  it("a second run with the same SearXNG fixture dedupes to zero new findings", async () => {
    const agent = await seedResearchAgent();
    const deps = {
      resolveTemplate,
      assembleBroker: async () => BROKER,
      now: () => new Date(),
    };

    const first = await execute(agent, deps);
    expect(first.items_kept).toBe(4);

    // Second run — same fixture, same dedupe keys. The runner's agent_state
    // check skips them all BEFORE summarise(), so items_kept = 0 and we
    // never call the LLM for them. Critical cost-control property.
    const second = await execute(agent, deps);
    expect(second.status).toBe("ok");
    expect(second.items_fetched).toBe(4); // still fetched
    expect(second.items_kept).toBe(0);    // all deduped
    expect(second.llm_hops).toBe(0);      // no summarise calls

    const totalFindings = await pool.query(
      `select count(*)::int as n from public.agent_findings where user_id = $1`,
      [USER],
    );
    expect(totalFindings.rows[0].n).toBe(4); // still just the first run's 4
  });
});

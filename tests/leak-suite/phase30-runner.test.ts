/**
 * Phase 3.0 PR3a — generic AgentRunner + batch entrypoint tests.
 *
 * Pins the invariants Sneha listed for the PR3a split:
 *   - preflight budget exceeded  → status='skipped_budget_exceeded'
 *   - mid-run CPAUD ceiling      → status='partial_success' (with items)
 *   - thrown error in pipeline   → status='failed' (with scrubbed message)
 *   - stuck-run sweep behavior   → 'running' rows older than threshold
 *                                  become 'timeout' with no user content
 *   - no template-specific branches in the runner code
 *
 * Plus the lifecycle guarantees the runner shape imposes:
 *   - agent_runs row is inserted as 'running' before any work
 *   - finalize runs on every path (ok, failed, skipped, partial)
 *   - releaseAgentLease + updateAgentLifecycleState called exactly once
 *   - mid-run failure with 0 items kept → 'skipped_budget_exceeded'
 *     (don't surface 'partial' to the user when nothing was persisted)
 *
 * Mocking strategy: stub the queue + budget modules (already pinned by
 * their own tests in PR1/PR2). Stub the supabase chains for the four
 * tables the runner writes to (agent_runs, agent_findings, agent_state).
 * Fake templates live inline. No imports from src/server/agents/templates
 * (which doesn't exist yet — that's PR3b).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── In-memory supabase state ─────────────────────────────────────────────

type Row = Record<string, unknown>;
let agentRunsRows: Row[] = [];
let agentRunsInsertSnapshots: Row[] = []; // append-only, frozen at insert time
let agentFindingsInserts: Row[] = [];
let agentStateRows: Row[] = [];
let agentRunsSweptIds: string[] = [];

beforeEach(() => {
  agentRunsRows = [];
  agentRunsInsertSnapshots = [];
  agentFindingsInserts = [];
  agentStateRows = [];
  agentRunsSweptIds = [];
  vi.clearAllMocks();
});

// Prompt E: these jobs run only with the owner's cloud consent. This suite
// tests the job itself, so consent is on here.
vi.mock("@/server/cloud-features.server", () => ({
  isCloudFeatureOn: async () => true,
  requireCloudFeature: async () => {},
  noteCloudActivity: async () => {},
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const supabaseAdmin = {
    from(table: string) {
      if (table === "agent_runs") {
        // Three chains this table sees from the runner+batch:
        //   1. .insert({...})                  — initial 'running' row
        //   2. .update({...}).eq("id", runId)  — finalize
        //   3. .update({...}).eq("status","running").lt("started_at", cutoff).select("id")
        //      — sweepStuckRuns
        return {
          insert(row: Row) {
            agentRunsRows.push({ ...row });
            agentRunsInsertSnapshots.push({ ...row }); // frozen snapshot
            return Promise.resolve({ error: null });
          },
          update(patch: Row) {
            // The two .update() shapes are distinguished by what's chained.
            // Build a small builder that records the eventual where clause.
            const filters: Array<{ op: string; col: string; val: unknown }> = [];
            const chain = {
              eq(col: string, val: unknown) {
                filters.push({ op: "eq", col, val });
                return chain;
              },
              lt(col: string, val: unknown) {
                filters.push({ op: "lt", col, val });
                return chain;
              },
              select(_cols: string) {
                // sweepStuckRuns terminal — apply filters, return matching ids.
                const matching = agentRunsRows.filter((r) =>
                  filters.every((f) =>
                    f.op === "eq" ? r[f.col] === f.val : (r[f.col] as string) < (f.val as string),
                  ),
                );
                for (const m of matching) {
                  Object.assign(m, patch);
                  agentRunsSweptIds.push(m.id as string);
                }
                return Promise.resolve({
                  data: matching.map((m) => ({ id: m.id })),
                  error: null,
                });
              },
              then(resolve: (v: { error: null }) => void) {
                // finalize terminal — single-row update by id.
                const target = agentRunsRows.find((r) =>
                  filters.every((f) => f.op === "eq" && r[f.col] === f.val),
                );
                if (target) Object.assign(target, patch);
                resolve({ error: null });
              },
            };
            return chain;
          },
        };
      }

      if (table === "agent_findings") {
        return {
          insert(row: Row, _opts?: unknown) {
            agentFindingsInserts.push({ ...row });
            return Promise.resolve({ error: null });
          },
        };
      }

      if (table === "agent_state") {
        return {
          select(_cols: string) {
            const builder = {
              _agentId: undefined as string | undefined,
              _key: undefined as string | undefined,
              eq(col: string, val: string) {
                if (col === "agent_id") builder._agentId = val;
                if (col === "key") builder._key = val;
                return builder;
              },
              maybeSingle() {
                const found = agentStateRows.find(
                  (r) => r.agent_id === builder._agentId && r.key === builder._key,
                );
                return Promise.resolve({
                  data: found ? { value: found.value } : null,
                  error: null,
                });
              },
            };
            return builder;
          },
          upsert(row: Row, _opts?: unknown) {
            const idx = agentStateRows.findIndex(
              (r) => r.agent_id === row.agent_id && r.key === row.key,
            );
            if (idx >= 0) agentStateRows[idx] = { ...row };
            else agentStateRows.push({ ...row });
            return Promise.resolve({ error: null });
          },
        };
      }

      throw new Error(`unexpected supabase.from(${table}) in runner test`);
    },
  };
  return { supabaseAdmin };
});

// Stub queue — these are pinned by their own RPC-level tests already.
vi.mock("@/server/agents/queue", () => ({
  claimDueAgents: vi.fn(),
  releaseAgentLease: vi.fn(),
  updateAgentLifecycleState: vi.fn(),
}));

// Stub budget — pinned by PR2 budget tests.
vi.mock("@/server/agents/budget", () => ({
  checkBudget: vi.fn(),
  recordCost: vi.fn(),
  CPAUD_CEILING_USD: 1.5,
}));

// ─── Subject under test (imported AFTER mocks) ────────────────────────────

import { execute, type RunnerDeps } from "@/server/agents/runner";
import { runAgentBatch, sweepStuckRuns, STUCK_RUN_THRESHOLD_MIN } from "@/server/agents/batch";
import { claimDueAgents, releaseAgentLease, updateAgentLifecycleState } from "@/server/agents/queue";
import { checkBudget } from "@/server/agents/budget";
import type { AgentRow, AgentTemplate, BrokerContext } from "@/server/agents/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const USER = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";

const FIXED_NOW = new Date("2026-05-17T12:00:00Z");

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: AGENT_ID,
    user_id: USER,
    template_id: "fake_template",
    display_name: "Test agent",
    config: {},
    badge: "flash",
    state: "active",
    cadence_hours: 24,
    budget: {
      maxRunsPerDay: 5,
      maxItemsConsideredPerRun: 30,
      maxLLMHopsPerItem: 1,
      maxNotificationsPerDay: 1,
    },
    notify: {},
    created_at: FIXED_NOW.toISOString(),
    updated_at: FIXED_NOW.toISOString(),
    last_claimed_at: FIXED_NOW.toISOString(),
    last_completed_at: null,
    last_useful_at: null,
    claim_expires_at: new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString(),
    consecutive_failures: 0,
    ...overrides,
  };
}

const BROKER: BrokerContext = { fragment: "", resolvedTier: 1 };

function fakeTemplate(opts: {
  id?: string;
  items?: unknown[];
  scoreFn?: (item: unknown) => number;
  summariseFn?: (item: unknown, i: number) => {
    title: string;
    summary: string;
    payload: Record<string, unknown>;
    _llmHops: number;
    _costMicroUsd: number;
  };
  throwOn?: "fetch" | "score" | "summarise";
}): AgentTemplate<unknown, unknown> {
  const items = opts.items ?? [
    { id: "a", title: "Item A" },
    { id: "b", title: "Item B" },
  ];
  return {
    id: opts.id ?? "fake_template",
    displayName: "Fake",
    description: "fake test template",
    defaultBadge: "flash",
    defaultCadenceHours: 24,
    defaultBudget: {
      maxRunsPerDay: 5,
      maxItemsConsideredPerRun: 30,
      maxLLMHopsPerItem: 1,
      maxNotificationsPerDay: 1,
    },
    configSchema: { parse: (x) => x },
    brokerCategories: [],
    fetch: async function* () {
      if (opts.throwOn === "fetch") throw new Error("fake fetch boom 'sekret value'");
      for (const item of items) yield item;
    },
    dedupeKey: (item) => (item as { id: string }).id,
    score: async (item) => {
      if (opts.throwOn === "score") throw new Error("fake score boom 'sekret value'");
      return opts.scoreFn ? opts.scoreFn(item) : 0.9;
    },
    summarise: async (item, _ctx) => {
      if (opts.throwOn === "summarise") {
        throw new Error("fake summarise boom 'sekret value'");
      }
      const i = items.indexOf(item);
      return opts.summariseFn
        ? { urgency: "normal", ...opts.summariseFn(item, i) }
        : {
            title: (item as { title: string }).title,
            summary: `summary of ${(item as { title: string }).title}`,
            payload: { url: `https://example.test/${(item as { id: string }).id}` },
            urgency: "normal",
            _llmHops: 1,
            _costMicroUsd: 5000, // 0.005 USD per item
          };
    },
  };
}

function makeDeps(template: AgentTemplate<unknown, unknown>): RunnerDeps {
  return {
    resolveTemplate: (id) => (id === template.id ? template : undefined),
    assembleBroker: async () => BROKER,
    now: () => FIXED_NOW,
  };
}

// ─── execute() — happy path ───────────────────────────────────────────────

describe("execute() — happy path", () => {
  it("inserts 'running' row, persists findings, finalizes 'ok'", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });

    const run = await execute(makeAgent(), makeDeps(fakeTemplate({})));

    // Initial insert payload captured 'running' (durability invariant).
    expect(agentRunsInsertSnapshots[0].status).toBe("running");
    // Same row was then updated in place to 'ok'.
    expect(agentRunsRows[0].status).toBe("ok");
    expect(agentRunsRows[0].items_fetched).toBe(2);
    expect(agentRunsRows[0].items_kept).toBe(2);
    expect(agentRunsRows[0].llm_hops).toBe(2);
    // 2 items * 5000 micro-USD each = 10_000 micro = $0.01
    expect(agentRunsRows[0].cost_usd).toBeCloseTo(0.01, 5);

    expect(agentFindingsInserts).toHaveLength(2);
    expect(agentFindingsInserts[0].title).toBe("Item A");

    expect(run.status).toBe("ok");
    expect(run.items_kept).toBe(2);

    // Lease released + lifecycle transitioned exactly once.
    expect(releaseAgentLease).toHaveBeenCalledTimes(1);
    expect(releaseAgentLease).toHaveBeenCalledWith(AGENT_ID, 2);
    expect(updateAgentLifecycleState).toHaveBeenCalledTimes(1);
    expect(updateAgentLifecycleState).toHaveBeenCalledWith(AGENT_ID, "ok", 2);
  });

  it("filters items below minScore without summarising them", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });

    const template = fakeTemplate({
      items: [
        { id: "low", title: "Low" },
        { id: "high", title: "High" },
      ],
      scoreFn: (item) => ((item as { id: string }).id === "low" ? 0.2 : 0.9),
    });
    const agent = makeAgent({ config: { minScore: 0.5 } });
    await execute(agent, makeDeps(template));

    expect(agentFindingsInserts).toHaveLength(1);
    expect(agentFindingsInserts[0].title).toBe("High");
    expect(agentRunsRows[0].items_fetched).toBe(2);
    expect(agentRunsRows[0].items_kept).toBe(1);
  });

  it("caps items_fetched at maxItemsConsideredPerRun", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });

    const lots = Array.from({ length: 50 }, (_, i) => ({ id: `k${i}`, title: `T${i}` }));
    const agent = makeAgent({
      budget: { ...makeAgent().budget, maxItemsConsideredPerRun: 10 },
    });
    await execute(agent, makeDeps(fakeTemplate({ items: lots })));

    expect(agentRunsRows[0].items_fetched).toBe(10);
  });
});

// ─── execute() — budget paths ─────────────────────────────────────────────

describe("execute() — kind → status mapping", () => {
  it("preflight per_agent_runs failure → skipped_budget_exceeded", async () => {
    vi.mocked(checkBudget).mockResolvedValueOnce({
      ok: false,
      kind: "per_agent_runs",
      reason: "per-agent maxRunsPerDay (5) reached",
    });

    const run = await execute(makeAgent(), makeDeps(fakeTemplate({})));

    expect(run.status).toBe("skipped_budget_exceeded");
    expect(run.items_fetched).toBe(0);
    expect(run.items_kept).toBe(0);
    expect(run.error).toMatch(/per-agent/);
    expect(agentFindingsInserts).toHaveLength(0);
    // Still finalized: lease released, lifecycle updated.
    expect(updateAgentLifecycleState).toHaveBeenCalledWith(
      AGENT_ID,
      "skipped_budget_exceeded",
      0,
    );
  });

  it("preflight cpaud_ceiling failure → skipped_budget_exceeded", async () => {
    vi.mocked(checkBudget).mockResolvedValueOnce({
      ok: false,
      kind: "cpaud_ceiling",
      reason: "CPAUD ceiling reached",
    });

    const run = await execute(makeAgent(), makeDeps(fakeTemplate({})));

    expect(run.status).toBe("skipped_budget_exceeded");
  });

  it("mid-run cpaud_ceiling AFTER persisting items → partial_success", async () => {
    // Preflight passes; first mid-run check passes (1st item summarised);
    // second mid-run check fails (would-be 2nd item).
    vi.mocked(checkBudget)
      .mockResolvedValueOnce({ ok: true }) // preflight
      .mockResolvedValueOnce({ ok: true }) // before item 0 summarise
      .mockResolvedValueOnce({
        ok: false,
        kind: "cpaud_ceiling",
        reason: "user CPAUD ceiling ($1.5000) reached",
      }); // before item 1 summarise

    const run = await execute(makeAgent(), makeDeps(fakeTemplate({})));

    expect(run.status).toBe("partial_success");
    expect(run.items_kept).toBe(1); // first item persisted
    expect(run.error).toMatch(/mid-run.*CPAUD ceiling/);
    expect(agentFindingsInserts).toHaveLength(1);
  });

  it("mid-run cpaud_ceiling with ZERO items persisted → skipped_budget_exceeded", async () => {
    // No items yet kept → 'partial_success' would mislead the user
    // ("partial of what?"). Bail with the same status as preflight.
    vi.mocked(checkBudget)
      .mockResolvedValueOnce({ ok: true }) // preflight
      .mockResolvedValueOnce({
        ok: false,
        kind: "cpaud_ceiling",
        reason: "CPAUD ceiling reached",
      }); // before first item summarise

    const run = await execute(makeAgent(), makeDeps(fakeTemplate({})));

    expect(run.status).toBe("skipped_budget_exceeded");
    expect(run.items_kept).toBe(0);
  });
});

// ─── execute() — error paths ──────────────────────────────────────────────

describe("execute() — error handling", () => {
  it("thrown error in fetch → status='failed' with PII-scrubbed error", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });

    const run = await execute(
      makeAgent(),
      makeDeps(fakeTemplate({ throwOn: "fetch" })),
    );

    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
    // 'sekret value' was in single quotes in the thrown message — must be redacted.
    expect(run.error).not.toMatch(/sekret value/);
    expect(run.error).toMatch(/REDACTED/);

    expect(updateAgentLifecycleState).toHaveBeenCalledWith(AGENT_ID, "failed", 0);
  });

  it("per-item score throw does NOT fail the whole run", async () => {
    // 2026-05-18: symmetric with the summarise per-item catch. One unlucky
    // provider-chain exhaustion on score() (e.g. transient 429s across every
    // provider) should skip that item, not kill the whole run. Before this
    // change the score throw bubbled up to the runner's outer catch and
    // stamped status='failed' — the briefing layer was never reached.
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const run = await execute(
      makeAgent(),
      makeDeps(fakeTemplate({ throwOn: "score" })),
    );

    // Items fetched + each score() throws → all skipped, none summarised.
    expect(run.status).toBe("ok");
    expect(run.items_kept).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();
    // The thrown string must still be scrubbed in the log even though
    // the run finished ok.
    const errorLog = consoleSpy.mock.calls.map((c) => String(c[1])).join(" ");
    expect(errorLog).not.toMatch(/sekret value/);
    consoleSpy.mockRestore();
  });

  it("per-item summarise throw does NOT fail the whole run", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const run = await execute(
      makeAgent(),
      makeDeps(fakeTemplate({ throwOn: "summarise" })),
    );

    // Items fetched + scored, but each summarise() throws → all skipped.
    expect(run.status).toBe("ok"); // no items kept but no top-level throw
    expect(run.items_kept).toBe(0);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("unknown template_id → status='failed' with safe message", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });

    const run = await execute(
      makeAgent({ template_id: "ghost_template" }),
      makeDeps(fakeTemplate({ id: "fake_template" })), // doesn't match
    );

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/unknown template_id: ghost_template/);
    // No PII leak risk here — template_id is opaque and chosen by us.
  });
});

// ─── execute() — dedupe ───────────────────────────────────────────────────

describe("execute() — dedupe via agent_state", () => {
  it("skips items whose dedupe_key is in agent_state.seen_dedupe_keys", async () => {
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });

    // Seed agent_state with one already-seen key.
    agentStateRows.push({
      agent_id: AGENT_ID,
      user_id: USER,
      key: "seen_dedupe_keys",
      value: ["a"],
    });

    await execute(makeAgent(), makeDeps(fakeTemplate({})));

    // Item 'a' was seen → skipped. Item 'b' summarised + persisted.
    expect(agentFindingsInserts).toHaveLength(1);
    expect(agentFindingsInserts[0].dedupe_key).toBe("b");

    // Both keys end up in agent_state after the run.
    const stored = agentStateRows.find((r) => r.key === "seen_dedupe_keys");
    expect(stored?.value).toEqual(["a", "b"]);
  });
});

// ─── sweepStuckRuns() ────────────────────────────────────────────────────

describe("sweepStuckRuns()", () => {
  it("marks 'running' rows older than threshold as 'timeout' with a non-content error", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();   // 5m ago
    agentRunsRows.push(
      { id: "old-stuck", status: "running", started_at: longAgo },
      { id: "recent-running", status: "running", started_at: recent },
      { id: "old-ok", status: "ok", started_at: longAgo },
    );

    const swept = await sweepStuckRuns(30);

    expect(swept).toBe(1);
    expect(agentRunsSweptIds).toEqual(["old-stuck"]);
    const oldStuck = agentRunsRows.find((r) => r.id === "old-stuck");
    expect(oldStuck?.status).toBe("timeout");
    expect(oldStuck?.error).toMatch(/runner did not finalize within 30 minutes/);
    // No user content / no PII in the sweep error string.
    expect(oldStuck?.error).not.toMatch(/['"@]/);

    // Other rows untouched.
    expect(agentRunsRows.find((r) => r.id === "recent-running")?.status).toBe("running");
    expect(agentRunsRows.find((r) => r.id === "old-ok")?.status).toBe("ok");
  });

  it("STUCK_RUN_THRESHOLD_MIN matches the cron cadence (30 min)", () => {
    expect(STUCK_RUN_THRESHOLD_MIN).toBe(30);
  });
});

// ─── runAgentBatch() ─────────────────────────────────────────────────────

describe("runAgentBatch()", () => {
  it("sweeps stuck runs, claims, executes serially, returns tally", async () => {
    // No stuck runs to sweep.
    // claimDueAgents returns 2 agents; both succeed.
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    const agents = [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })];
    vi.mocked(claimDueAgents).mockResolvedValue(agents);

    const tally = await runAgentBatch(makeDeps(fakeTemplate({})));

    expect(tally.claimed).toBe(2);
    expect(tally.succeeded).toBe(2);
    expect(tally.failed).toBe(0);
    expect(tally.sweptTimedOut).toBe(0);

    // Two 'running' inserts, two finalized 'ok'.
    expect(agentRunsRows).toHaveLength(2);
    expect(agentRunsRows.every((r) => r.status === "ok")).toBe(true);
  });

  it("a failing agent does not stop the batch from running other agents", async () => {
    // First agent: template throws on fetch → 'failed'
    // Second agent: succeeds normally → 'ok'
    vi.mocked(checkBudget).mockResolvedValue({ ok: true });
    const failing = makeAgent({ id: "a-fail", template_id: "throws" });
    const ok = makeAgent({ id: "a-ok", template_id: "fake_template" });
    vi.mocked(claimDueAgents).mockResolvedValue([failing, ok]);

    const goodTemplate = fakeTemplate({});
    const throwingTemplate = fakeTemplate({ id: "throws", throwOn: "fetch" });
    const deps: RunnerDeps = {
      resolveTemplate: (id) =>
        id === "throws" ? throwingTemplate : id === "fake_template" ? goodTemplate : undefined,
      assembleBroker: async () => BROKER,
      now: () => FIXED_NOW,
    };

    const tally = await runAgentBatch(deps);

    expect(tally.claimed).toBe(2);
    expect(tally.succeeded).toBe(1);
    expect(tally.failed).toBe(1);

    expect(agentRunsRows.find((r) => r.agent_id === "a-fail")?.status).toBe("failed");
    expect(agentRunsRows.find((r) => r.agent_id === "a-ok")?.status).toBe("ok");
  });

  it("returns swept count when there are stuck runs to clean up", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    agentRunsRows.push({ id: "stuck", status: "running", started_at: longAgo });
    vi.mocked(claimDueAgents).mockResolvedValue([]);

    const tally = await runAgentBatch(makeDeps(fakeTemplate({})));

    expect(tally.sweptTimedOut).toBe(1);
    expect(tally.claimed).toBe(0);
  });
});

// ─── Invariant #7 — no template-specific branches in the runner ──────────

describe("Invariant #7 (docs/16 §22): handler vs runtime separation", () => {
  const RUNNER_SRC = readFileSync(
    join(__dirname, "..", "..", "src", "server", "agents", "runner.ts"),
    "utf8",
  );

  it("runner.ts does not branch on agent.template_id", () => {
    // Allowed: the one resolveTemplate(agent.template_id) lookup +
    // the error-message string for unknown templates.
    // Forbidden: `if (agent.template_id === ...)`, switch/case on it,
    // any equality check between template_id and a string literal.
    expect(RUNNER_SRC).not.toMatch(/template_id\s*===\s*['"]/);
    expect(RUNNER_SRC).not.toMatch(/template_id\s*==\s*['"]/);
    expect(RUNNER_SRC).not.toMatch(/case\s+['"](research_digest|job|shopping|deal_watcher)['"]/);
  });

  it("runner.ts does not import from any templates/ path", () => {
    // The registry ships in PR3b; the runner must never depend on it.
    expect(RUNNER_SRC).not.toMatch(/from\s+['"][^'"]*templates[\/'"]/);
    expect(RUNNER_SRC).not.toMatch(/from\s+['"][^'"]*\/templates['"]/);
  });

  it("batch.ts does not import from any templates/ path either", () => {
    const BATCH_SRC = readFileSync(
      join(__dirname, "..", "..", "src", "server", "agents", "batch.ts"),
      "utf8",
    );
    expect(BATCH_SRC).not.toMatch(/from\s+['"][^'"]*templates[\/'"]/);
    expect(BATCH_SRC).not.toMatch(/from\s+['"][^'"]*\/templates['"]/);
  });
});

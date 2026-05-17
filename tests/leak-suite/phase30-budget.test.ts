/**
 * Phase 3.0 PR2 — `checkBudget` + `recordCost` unit tests.
 *
 * These pin the two-layered budget semantics from docs/16 §11 + §22 #4:
 *
 *   - Preflight: BOTH per-agent maxRunsPerDay AND CPAUD ceiling checked.
 *   - Mid-run:   ONLY CPAUD ceiling checked, with accumulated in-flight
 *                cost added to today's spend. Per-agent runs count is
 *                skipped because the in-flight run's own row would always
 *                make it tautologically over budget.
 *
 * And the cost-recording shape from docs/16 §11:
 *
 *   - `recordCost` writes an `inference_usage` row matching the chat-side
 *     shape (`cost_micro_usd`, full provider info) with the agent run
 *     tagged via `metadata.agent_run_id`.
 *   - Insert failures are logged but never thrown (cap fail-open invariant
 *     inherited from chat's writeUsage — fix lands with the atomic ledger).
 *
 * The real-DB regression for these same invariants ships with PR3 once the
 * runner exists to exercise them end-to-end. Here we just pin the math +
 * the shape of every supabase call the function makes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocked supabase admin client ─────────────────────────────────────────
//
// Each test seeds `agentRunsRows` (for the per-agent maxRunsPerDay query)
// and `inferenceUsageDailyRows` (for the today-spend lookup), then asserts
// against the recorded fields of any insert.

type AgentRunRow = { id: string; agent_id: string; started_at: string };
type InfDailyRow = { user_id: string; day: string; cost_micro_usd_sum: number };

let agentRunsRows: AgentRunRow[] = [];
let inferenceUsageDailyRows: InfDailyRow[] = [];
const inferenceUsageInserts: Array<Record<string, unknown>> = [];
const queriedTables: string[] = [];
let nextInsertError: { message: string } | null = null;

beforeEach(() => {
  agentRunsRows = [];
  inferenceUsageDailyRows = [];
  inferenceUsageInserts.length = 0;
  queriedTables.length = 0;
  nextInsertError = null;
});

vi.mock("@/integrations/supabase/client.server", () => {
  const supabaseAdmin = {
    from(table: string) {
      queriedTables.push(table);

      if (table === "agent_runs") {
        // Chain: .select(_, {count:'exact', head:true}).eq(...).gte(...)
        // Returns { count, error } when awaited at the end of the chain.
        const builder = {
          _agentId: undefined as string | undefined,
          _since: undefined as string | undefined,
          select(_cols: string, _opts: { count?: string; head?: boolean }) {
            return builder;
          },
          eq(col: string, val: string) {
            if (col === "agent_id") builder._agentId = val;
            return builder;
          },
          gte(col: string, val: string) {
            if (col === "started_at") builder._since = val;
            return builder;
          },
          then(resolve: (v: { count: number; error: null }) => void) {
            const count = agentRunsRows.filter(
              (r) =>
                (!builder._agentId || r.agent_id === builder._agentId) &&
                (!builder._since || r.started_at >= builder._since),
            ).length;
            resolve({ count, error: null });
          },
        };
        return builder;
      }

      if (table === "inference_usage_daily") {
        // Chain: .select("cost_micro_usd_sum").eq("user_id", ...).eq("day", ...)
        // Returns { data: Array<{cost_micro_usd_sum}>, error } when awaited.
        const builder = {
          _userId: undefined as string | undefined,
          _day: undefined as string | undefined,
          select(_cols: string) {
            return builder;
          },
          eq(col: string, val: string) {
            if (col === "user_id") builder._userId = val;
            if (col === "day") builder._day = val;
            return builder;
          },
          then(resolve: (v: { data: InfDailyRow[]; error: null }) => void) {
            const data = inferenceUsageDailyRows.filter(
              (r) => r.user_id === builder._userId && r.day === builder._day,
            );
            resolve({ data, error: null });
          },
        };
        return builder;
      }

      if (table === "inference_usage") {
        return {
          insert(row: Record<string, unknown>) {
            inferenceUsageInserts.push(row);
            return Promise.resolve({ error: nextInsertError });
          },
        };
      }

      throw new Error(`unexpected supabase.from(${table}) in test`);
    },
  };
  return { supabaseAdmin };
});

// Subject under test — imported AFTER the mock.
import { checkBudget, recordCost, CPAUD_CEILING_USD } from "@/server/agents/budget";
import type { AgentBudget } from "@/server/agents/types";

const USER = "11111111-1111-1111-1111-111111111111";
const AGENT = "22222222-2222-2222-2222-222222222222";
const RUN = "33333333-3333-3333-3333-333333333333";

const BUDGET: AgentBudget = {
  maxRunsPerDay: 5,
  maxItemsConsideredPerRun: 30,
  maxLLMHopsPerItem: 1,
  maxNotificationsPerDay: 1,
};

const NOW = new Date("2026-05-17T12:00:00Z");
const DAY_KEY = "2026-05-17";

// Helper: micro-USD value for $1.50 ceiling.
const CEILING_MICRO = CPAUD_CEILING_USD * 1_000_000;

// ─── Preflight: per-agent maxRunsPerDay boundary ──────────────────────────

describe("checkBudget — preflight per-agent maxRunsPerDay", () => {
  function seedRuns(n: number) {
    for (let i = 0; i < n; i++) {
      agentRunsRows.push({
        id: `r${i}`,
        agent_id: AGENT,
        // All within the rolling 24h window.
        started_at: new Date(NOW.getTime() - 60_000).toISOString(),
      });
    }
  }

  it("ok when zero runs in window", async () => {
    seedRuns(0);
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("ok at maxRunsPerDay - 1 (slot still open)", async () => {
    seedRuns(4); // max=5, 4 used, 1 slot remaining
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects at exactly maxRunsPerDay (off-by-one paranoia)", async () => {
    seedRuns(5);
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("per_agent_runs");
      expect(r.reason).toMatch(/maxRunsPerDay \(5\)/);
    }
  });

  it("rejects when over maxRunsPerDay", async () => {
    seedRuns(7);
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it("ignores rows for other agents", async () => {
    for (let i = 0; i < 10; i++) {
      agentRunsRows.push({
        id: `other-${i}`,
        agent_id: "99999999-9999-9999-9999-999999999999",
        started_at: NOW.toISOString(),
      });
    }
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("ignores rows older than 24h", async () => {
    for (let i = 0; i < 10; i++) {
      agentRunsRows.push({
        id: `old-${i}`,
        agent_id: AGENT,
        started_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
      });
    }
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });
});

// ─── Preflight: CPAUD ceiling boundary ────────────────────────────────────

describe("checkBudget — preflight CPAUD ceiling", () => {
  function seedSpend(usd: number) {
    inferenceUsageDailyRows.push({
      user_id: USER,
      day: DAY_KEY,
      cost_micro_usd_sum: Math.floor(usd * 1_000_000),
    });
  }

  it("ok at zero spend", async () => {
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("ok just below ceiling ($1.49)", async () => {
    seedSpend(1.49);
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects at exactly the ceiling ($1.50)", async () => {
    inferenceUsageDailyRows.push({
      user_id: USER,
      day: DAY_KEY,
      cost_micro_usd_sum: CEILING_MICRO,
    });
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("cpaud_ceiling");
      expect(r.reason).toMatch(/CPAUD ceiling \(\$1\.50\)/);
    }
  });

  it("rejects when over ceiling", async () => {
    seedSpend(2.0);
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it("sums multiple rows for the same user-day", async () => {
    seedSpend(0.75);
    seedSpend(0.75); // total = $1.50, at ceiling
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(false);
  });

  it("ignores other users' spend", async () => {
    inferenceUsageDailyRows.push({
      user_id: "other-user",
      day: DAY_KEY,
      cost_micro_usd_sum: 5 * 1_000_000,
    });
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("ignores other days' spend", async () => {
    inferenceUsageDailyRows.push({
      user_id: USER,
      day: "2026-05-16",
      cost_micro_usd_sum: 5 * 1_000_000,
    });
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });
});

// ─── Mid-run: skips per-agent, only CPAUD with accumulated cost ───────────

describe("checkBudget — mid-run (accumulatedCostUsd > 0)", () => {
  it("rejects when today-spend + accumulated reaches ceiling", async () => {
    inferenceUsageDailyRows.push({
      user_id: USER,
      day: DAY_KEY,
      cost_micro_usd_sum: Math.floor(1.49 * 1_000_000),
    });
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      accumulatedCostUsd: 0.01,
      now: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("cpaud_ceiling");
      expect(r.reason).toMatch(/in-flight \$0\.0100/);
    }
  });

  it("ok when projected total stays below ceiling", async () => {
    inferenceUsageDailyRows.push({
      user_id: USER,
      day: DAY_KEY,
      cost_micro_usd_sum: Math.floor(1.0 * 1_000_000),
    });
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      accumulatedCostUsd: 0.49,
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it("does NOT query agent_runs (skips per-agent check on mid-run)", async () => {
    // Seed 10 runs — would trip the per-agent check if it ran.
    for (let i = 0; i < 10; i++) {
      agentRunsRows.push({
        id: `r${i}`,
        agent_id: AGENT,
        started_at: NOW.toISOString(),
      });
    }
    const r = await checkBudget({
      userId: USER,
      agentId: AGENT,
      perAgentBudget: BUDGET,
      accumulatedCostUsd: 0.01,
      now: NOW,
    });
    expect(r.ok).toBe(true); // CPAUD has room; per-agent should be skipped
    expect(queriedTables).not.toContain("agent_runs");
    expect(queriedTables).toContain("inference_usage_daily");
  });
});

// ─── recordCost shape + fail-open ─────────────────────────────────────────

describe("recordCost", () => {
  it("inserts a complete inference_usage row tagged with the agent run", async () => {
    await recordCost({
      userId: USER,
      agentRunId: RUN,
      badge: "flash",
      providerChain: ["groq", "openai"],
      providerUsed: "groq",
      modelUsed: "llama-3.3-70b",
      fallbackDepth: 0,
      inputTokens: 1234,
      outputTokens: 56,
      costMicroUsd: 7890,
      latencyMs: 412,
      status: "ok",
    });

    expect(inferenceUsageInserts).toHaveLength(1);
    const row = inferenceUsageInserts[0];
    expect(row.user_id).toBe(USER);
    expect(row.thread_id).toBeNull();
    expect(row.badge).toBe("flash");
    expect(row.provider_chain).toEqual(["groq", "openai"]);
    expect(row.provider_used).toBe("groq");
    expect(row.model_used).toBe("llama-3.3-70b");
    expect(row.cost_micro_usd).toBe(7890);
    expect(row.status).toBe("ok");
    expect(row.error_class).toBeNull();
    expect(row.metadata).toEqual({ agent_run_id: RUN });
  });

  it("passes errorClass through when provided", async () => {
    await recordCost({
      userId: USER,
      agentRunId: RUN,
      badge: "private",
      providerChain: ["onnx-local"],
      providerUsed: "onnx-local",
      modelUsed: null,
      fallbackDepth: 0,
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: 0,
      latencyMs: 12,
      status: "error",
      errorClass: "model_unavailable",
    });
    expect(inferenceUsageInserts[0].error_class).toBe("model_unavailable");
    expect(inferenceUsageInserts[0].status).toBe("error");
  });

  it("does NOT throw when the insert fails (cap fail-open invariant)", async () => {
    // Mirrors chat-side writeUsage policy: log loudly, don't raise. Raising
    // here would cancel an agent finding that already completed.
    nextInsertError = { message: "simulated insert failure" };
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordCost({
        userId: USER,
        agentRunId: RUN,
        badge: "flash",
        providerChain: ["groq"],
        providerUsed: "groq",
        modelUsed: "llama-3.3-70b",
        fallbackDepth: 0,
        inputTokens: 100,
        outputTokens: 50,
        costMicroUsd: 1000,
        latencyMs: 200,
        status: "ok",
      }),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringMatching(/CAP-CRITICAL agent recordCost insert failure/),
      "simulated insert failure",
    );
    consoleSpy.mockRestore();
  });
});

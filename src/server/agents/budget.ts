/**
 * Phase 3.0 agent runtime — budget enforcement.
 *
 * Two layers, checked both pre-flight (before any external compute) and
 * mid-run (after each item's LLM hops have been billed):
 *
 *   1. **Per-agent budget** — `maxRunsPerDay` from `agents.budget` JSONB,
 *      enforced against a rolling 24h count of `agent_runs` for this agent.
 *   2. **Unified CPAUD ceiling** — `CPAUD_CEILING_USD` (currently $1.50/day),
 *      enforced against the user's daily spend across all features (chat,
 *      agents, on-device). Source: `inference_usage_daily.cost_micro_usd_sum`
 *      aggregated for today; mid-run callers pass `accumulatedCostMicroUsd` so
 *      the projected total accounts for in-flight spend not yet flushed.
 *
 * The status mapping the runner uses (docs/16 §11.1):
 *
 *   Preflight `checkBudget` → false → `agent_runs.status = 'skipped_budget_exceeded'`
 *   Mid-run `checkBudget`  → false → `agent_runs.status = 'partial_success'`
 *
 * **Cost durability invariant (docs/16 §11):** `recordCost` runs INLINE per
 * LLM hop, not batched at finalize. A runner crash post-hop still leaves
 * the cost in the CPAUD ledger. Don't introduce a batched-flush path.
 *
 * **Template-agnostic invariant (Sneha's PR2 constraint):** this file
 * doesn't import any concrete template and doesn't read template-specific
 * config keys. It sees only the generic `AgentBudget` shape and per-hop
 * inference telemetry.
 *
 * **Spec deviation note:** docs/16 §11 sample code uses `source` /
 * `source_id` / `cost_usd` columns on `inference_usage`. The real schema
 * uses `cost_micro_usd` + `metadata jsonb` (`metadata.agent_run_id` is
 * how we tag agent rows here). Update docs/16 §11 in a small follow-up.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CPAUD_CEILING_USD } from "@/lib/cpaud.functions";
import type { AgentBudget, BudgetCheckResult } from "./types";
import type { Badge } from "@/server/inference/router";
import { scrubErrorMessage } from "./error-scrub";

const MICRO_PER_USD = 1_000_000;

/**
 * CPAUD ceiling as micro-USD — the unit used for all internal budget math.
 * The dollar constant in cpaud.functions stays the source of truth for UI;
 * we derive the integer micro form once at module load to avoid per-call
 * float multiplication.
 *
 * **Unit invariant (Sneha audit, 2026-05-17):** every internal cost
 * comparison and accumulation in this file is micro-USD. Dollars only
 * appear in human-facing reason strings. If you ever find yourself
 * dividing or multiplying by MICRO_PER_USD outside `formatDollarsForLog`,
 * something is wrong.
 */
const CPAUD_CEILING_MICRO_USD = Math.round(CPAUD_CEILING_USD * MICRO_PER_USD);

/** Re-exported so callers don't reach into cpaud.functions just for the constant. */
export { CPAUD_CEILING_USD };

/** Dollar formatting helper for human-readable log lines. NEVER for budget math. */
function formatDollarsForLog(microUsd: number): string {
  return `$${(microUsd / MICRO_PER_USD).toFixed(4)}`;
}

// ─── Budget check ─────────────────────────────────────────────────────────

export type CheckBudgetArgs = {
  userId: string;
  agentId: string;
  perAgentBudget: AgentBudget;
  /**
   * Cost (MICRO-USD) accumulated within the current run, NOT yet visible
   * in `inference_usage_daily`. Mid-run callers pass the running sum of
   * `_costMicroUsd` from each `template.summarise()`. Preflight callers
   * pass 0 (or omit). Used to compute the projected total against the
   * ceiling.
   *
   * Micro-USD because all internal cost math in this module is micro;
   * see the unit invariant on `CPAUD_CEILING_MICRO_USD`.
   */
  accumulatedCostMicroUsd?: number;
  /**
   * Optional clock override for deterministic tests. Production callers
   * should omit it and let the function use the wall clock.
   */
  now?: Date;
};

/**
 * Decides whether the agent may continue. Both layers are checked; the
 * stricter one wins.
 *
 * - Preflight (`accumulatedCostMicroUsd` omitted or 0): both per-agent
 *   maxRunsPerDay and CPAUD ceiling are checked. Per-agent is the
 *   cheaper check, so it runs first.
 * - Mid-run (`accumulatedCostMicroUsd > 0`): only the CPAUD ceiling is
 *   checked. The per-agent runs count would always include the current
 *   in-flight run, making it tautologically over budget; skip it.
 */
export async function checkBudget(args: CheckBudgetArgs): Promise<BudgetCheckResult> {
  const accumulatedMicro = args.accumulatedCostMicroUsd ?? 0;
  const isPreflight = accumulatedMicro === 0;
  const now = args.now ?? new Date();

  // 1. Per-agent maxRunsPerDay — preflight only.
  //
  // Counts **finalized** runs in the last 24h, NOT all runs. The runner
  // inserts the current run's `agent_runs` row as `status='running',
  // finished_at=NULL` BEFORE this preflight check (per the documented
  // lifecycle step 1: durability). Without the `finished_at IS NOT NULL`
  // filter, the current in-flight row counted toward its own budget —
  // every fresh ResearchDigest agent (maxRunsPerDay=1) was immediately
  // skipped_budget_exceeded with reason "1 runs in the last 24h".
  // Caught during 2026-05-18 deploy verification.
  //
  // Stuck `status='running'` rows (crashed runner awaiting sweep) are
  // also excluded until the stuck-run sweep finalizes them to `timeout`
  // with `finished_at` set. Acceptable: max window is the 30-min lease
  // TTL, after which the sweep closes the loop.
  if (isPreflight) {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await (supabaseAdmin as any)
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", args.agentId)
      .gte("started_at", since)
      .not("finished_at", "is", null);

    if (error) {
      throw new Error(`checkBudget: failed to read agent_runs count: ${error.message}`);
    }

    const runsToday = count ?? 0;
    if (runsToday >= args.perAgentBudget.maxRunsPerDay) {
      return {
        ok: false,
        kind: "per_agent_runs",
        reason: `per-agent maxRunsPerDay (${args.perAgentBudget.maxRunsPerDay}) reached: ${runsToday} runs in the last 24h`,
      };
    }
  }

  // 2. Unified CPAUD ceiling — user's daily spend (micro-USD) plus any
  // in-flight accumulated cost. Sum across all badges/providers for today.
  const todaySpendMicro = await fetchTodaySpendMicroUsd(args.userId, now);
  const projectedTotalMicro = todaySpendMicro + accumulatedMicro;

  if (projectedTotalMicro >= CPAUD_CEILING_MICRO_USD) {
    return {
      ok: false,
      kind: "cpaud_ceiling",
      reason: `user CPAUD ceiling (${formatDollarsForLog(CPAUD_CEILING_MICRO_USD)}) reached: projected ${formatDollarsForLog(projectedTotalMicro)} (today ${formatDollarsForLog(todaySpendMicro)} + in-flight ${formatDollarsForLog(accumulatedMicro)})`,
    };
  }

  return { ok: true };
}

/**
 * Sum today's `inference_usage_daily.cost_micro_usd_sum` for the user
 * across all badges/providers. Returns **micro-USD** (no conversion) so
 * caller-side math stays in the same unit as the column.
 *
 * Reads the aggregate (not the raw `inference_usage` table) because the
 * aggregate already exists, is indexed on `(user_id, day)`, and stays in
 * sync via the existing retention sweep. Chat-side cap enforcement reads
 * from `inference_usage` directly because it needs sub-day latency; the
 * agent runtime's 30-min cron tick + 30-min cron cadence means the daily
 * aggregate is more than fresh enough for budget decisions.
 *
 * NB: when chat lands a row mid-day that hasn't yet rolled up into
 * `inference_usage_daily`, this query under-counts. That's a known
 * under-enforcement window (~24h). The CPAUD viewer (`cpaud.functions`)
 * already uses both surfaces; the agent runtime can graduate to direct
 * `inference_usage` reads if the under-counting causes real CPAUD breaches.
 */
async function fetchTodaySpendMicroUsd(userId: string, now: Date): Promise<number> {
  // UTC day key — matches the daily-aggregate's `day` column.
  const dayKey = now.toISOString().slice(0, 10);
  const { data, error } = await (supabaseAdmin as any)
    .from("inference_usage_daily")
    .select("cost_micro_usd_sum")
    .eq("user_id", userId)
    .eq("day", dayKey);

  if (error) {
    throw new Error(`checkBudget: failed to read inference_usage_daily: ${error.message}`);
  }

  return (data as Array<{ cost_micro_usd_sum: number | null }> | null)?.reduce(
    (acc, row) => acc + Number(row.cost_micro_usd_sum ?? 0),
    0,
  ) ?? 0;
}

// ─── Cost recording ───────────────────────────────────────────────────────

export type RecordCostArgs = {
  userId: string;
  agentRunId: string;
  badge: Badge;
  providerChain: string[];
  providerUsed: string;
  modelUsed: string | null;
  fallbackDepth: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number;
  latencyMs: number;
  /** Mirrors `inference_usage.status` check constraint. */
  status: "ok" | "rate_limited" | "error" | "user_abort" | "cap_exceeded";
  errorClass?: string;
};

/**
 * Records a single per-hop inference cost into `inference_usage`, tagged
 * with the agent run via `metadata.agent_run_id` so CPAUD breakdowns can
 * attribute spend to agents vs chat.
 *
 * Mirrors the shape `src/server/inference/chat.ts:writeUsage` writes for
 * chat — same column set, just with an extra metadata tag. This keeps the
 * existing CPAUD aggregation paths working without schema changes.
 *
 * **Telemetry-write failure handling:** matches chat's policy. Failed
 * inserts are logged loudly (cap fail-open is a known regression to fix
 * with the atomic ledger migration) but do NOT throw, because raising in
 * the recordCost path could cancel a successful agent finding and surface
 * as a user-visible failure of work that actually completed.
 */
export async function recordCost(args: RecordCostArgs): Promise<void> {
  const { error } = await (supabaseAdmin as any).from("inference_usage").insert({
    user_id: args.userId,
    thread_id: null,
    badge: args.badge,
    provider_chain: args.providerChain,
    provider_used: args.providerUsed,
    model_used: args.modelUsed,
    fallback_depth: args.fallbackDepth,
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    cost_micro_usd: args.costMicroUsd,
    latency_ms: args.latencyMs,
    status: args.status,
    error_class: args.errorClass ?? null,
    metadata: { agent_run_id: args.agentRunId },
  });

  if (error) {
    console.error(
      `[inference_usage] CAP-CRITICAL agent recordCost insert failure (status=${args.status}, run=${args.agentRunId}):`,
      scrubErrorMessage(error.message),
    );
  }
}

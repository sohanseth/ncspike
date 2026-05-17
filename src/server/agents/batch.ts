/**
 * Phase 3.0 agent runtime — batch entrypoint.
 *
 * `runAgentBatch(deps)` is the one function the Cloudflare cron (PR3c)
 * will call every 30 minutes. It does three things, in this order:
 *
 *   1. Sweep — finalize any `agent_runs` row that's been stuck in
 *      'running' longer than the threshold. Without this, a Worker
 *      that crashed between INSERT and finalize-UPDATE leaves the row
 *      'running' forever; the UI would show "still running" indefinitely
 *      and the next claim would still happen on schedule (driven by the
 *      lease, not by the run-row status), but the audit trail rots.
 *
 *   2. Claim — `claimDueAgents(BATCH_LIMIT)` atomically claims up to
 *      BATCH_LIMIT due agents with a 30-min DB-backed lease.
 *
 *   3. Execute — run each claimed agent through `execute()` serially.
 *      An outer try/catch guards against the (very rare) case where
 *      execute() itself throws after the run-row was inserted; the
 *      stuck-run sweep on the next tick will finalize it.
 *
 * **No template-specific code here.** Same invariant as the runner.
 * batch.ts sees only `AgentRow` + `RunnerDeps` + the queue wrappers.
 * Templates are resolved inside `execute()` via the injected
 * `resolveTemplate` callback. PR3b adds the registry; PR3c wires the
 * cron with `resolveTemplate: (id) => templates[id]`.
 *
 * **Sequential, not parallel.** docs/13 §18.5 locks scheduled batches
 * as serial in v1. The 30-min cron means at most ~10 agents (BATCH_LIMIT)
 * runs per tick; each typically <30s; comfortably under the 15-min
 * Worker invocation budget. Parallel-3 ships for user-triggered runs
 * in 3.3 — different code path, will not live here.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { claimDueAgents } from "./queue";
import { execute, type RunnerDeps } from "./runner";
import { scrubErrorMessage } from "./error-scrub";

/**
 * Hard cap on agents claimed per cron tick. Matches docs/16 §10.
 *
 * Tuning rationale (docs/16 §10): with the 30-min cron and ~30s typical
 * per-run latency, 10 agents/tick = ~5min of work, well under the
 * 15-min Worker scheduled-invocation budget. Bump when load profile
 * actually demands it; resist the urge to over-parallelize before the
 * runtime has run on real traffic for a while.
 */
export const BATCH_LIMIT = 10;

/**
 * Threshold for the stuck-run sweep, in minutes. A run in 'running'
 * older than this is treated as crashed and finalized to 'timeout'.
 *
 * Chosen to match the cron cadence: any run that didn't finish within
 * one cron interval is, by construction, in a state the next tick
 * can't reason about. The lease TTL is also 30 min — same intuition,
 * different surface.
 */
export const STUCK_RUN_THRESHOLD_MIN = 30;

// ─── Public entry points ──────────────────────────────────────────────────

/**
 * One cron tick. Always returns; never throws. Caller (worker.scheduled
 * in PR3c) should wrap in `ctx.waitUntil(runAgentBatch(deps))`.
 *
 * Outer try/catch around each `execute()` is for the pathological case
 * where the runner itself throws AFTER inserting an agent_runs row but
 * BEFORE the finalize block — that would leave the row 'running' until
 * the next sweep, which is intentional: we never want one bad agent to
 * stop the batch from running others.
 */
export async function runAgentBatch(deps: RunnerDeps): Promise<{
  sweptTimedOut: number;
  claimed: number;
  succeeded: number;
  failed: number;
}> {
  const sweptTimedOut = await sweepStuckRuns(STUCK_RUN_THRESHOLD_MIN);

  let claimed = 0;
  let succeeded = 0;
  let failed = 0;

  const agents = await claimDueAgents(BATCH_LIMIT);
  claimed = agents.length;

  for (const agent of agents) {
    try {
      const run = await execute(agent, deps);
      // 'ok' / 'partial_success' / 'skipped_*' are all "the runner
      // reached finalize without a crash". 'failed' means the runner
      // caught a thrown exception and recorded it — also not a batch
      // crash. The only thing we count as 'failed' at the batch level
      // is `execute()` throwing AFTER its finalize block would normally
      // run, which is the catch arm below.
      if (run.status === "failed") {
        failed++;
      } else {
        succeeded++;
      }
    } catch (e) {
      failed++;
      console.error(
        `[batch] execute() threw outside the runner's catch for agent ${agent.id}:`,
        scrubErrorMessage(e),
      );
      // The lease auto-expires in 30 min; next tick will re-claim.
      // The run row (if it was inserted) gets finalized by the next
      // sweep. We deliberately do not try to recover here — the runner
      // is the unit of error containment; the batch is the loop.
    }
  }

  return { sweptTimedOut, claimed, succeeded, failed };
}

/**
 * Finalize stuck `agent_runs` rows — set status='timeout', stamp
 * finished_at, write a non-content error. Returns the number of rows
 * swept. Never throws to caller.
 *
 * The error string is a fixed template ("runner did not finalize
 * within N minutes") — no user content, satisfies docs/16 §22 #3.
 */
export async function sweepStuckRuns(thresholdMinutes: number): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

  const { data, error } = await (supabaseAdmin as any)
    .from("agent_runs")
    .update({
      status: "timeout",
      finished_at: new Date().toISOString(),
      error: `runner did not finalize within ${thresholdMinutes} minutes`,
    })
    .eq("status", "running")
    .lt("started_at", cutoff)
    .select("id");

  if (error) {
    console.error(`[batch] sweepStuckRuns failed:`, error.message);
    return 0;
  }
  return Array.isArray(data) ? data.length : 0;
}

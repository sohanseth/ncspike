/**
 * Phase 3.0 agent runtime — the queue boundary.
 *
 * Thin, typed wrappers around the three SQL RPCs that own scheduling and
 * lifecycle for agent runs:
 *
 *   - `claim_due_agents(p_limit)`           — atomic claim with 30-min lease
 *   - `release_agent_lease(id, items_kept)` — finalize a successful claim
 *   - `update_agent_lifecycle_state(...)`   — state-machine transitions
 *
 * **Why a thin wrapper layer instead of inlining RPC calls in the runner**
 * (docs/16 §8): this is the deliberate boundary kept despite cutting queue
 * infrastructure. Future evolutions — priority columns, exponential-backoff
 * retries, write-action safety gates, lease-table migration — slot in
 * behind these functions without the runner changing. Don't bypass them
 * just because the current implementation is one RPC call.
 *
 * **Template-agnostic invariant (Sneha's PR2 constraint):** this file
 * MUST NOT know what kind of agent it claims. It returns generic
 * `AgentRow[]`. The runner dispatches on `agent.template_id`; the queue
 * sees only IDs and lifecycle timestamps.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { AgentRow, AgentRunStatus } from "./types";

/**
 * Hard safety cap on per-call batch size — must match the cap inside the
 * SQL function. The SQL raises on `p_limit > 50`; keeping the constant
 * mirrored here lets callers fail fast in TypeScript before round-tripping.
 */
export const CLAIM_BATCH_HARD_CAP = 50;

/**
 * Atomically claims up to `limit` agents that are due to run. The SQL
 * function sets `last_claimed_at = now()` and
 * `claim_expires_at = now() + 30min` in the same transaction; callers MUST
 * call `releaseAgentLease()` to clear the lease, or the agent will be
 * unclaimable until the lease expires.
 *
 * Cadence + lease semantics live in the SQL function (see
 * `supabase/migrations/20260601000000_phase30_agent_runtime.sql` and
 * docs/16 §6.1). This wrapper only enforces the TypeScript-side bound check
 * — every other invariant is the DB's job.
 *
 * @throws if `limit < 1`, `limit > CLAIM_BATCH_HARD_CAP`, or the RPC errors.
 */
export async function claimDueAgents(limit: number): Promise<AgentRow[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`claimDueAgents: limit must be a positive integer, got ${limit}`);
  }
  if (limit > CLAIM_BATCH_HARD_CAP) {
    throw new Error(
      `claimDueAgents: limit ${limit} exceeds hard cap ${CLAIM_BATCH_HARD_CAP} (matches SQL guard)`,
    );
  }

  const { data, error } = await (supabaseAdmin as any).rpc("claim_due_agents", {
    p_limit: limit,
  });
  if (error) {
    throw new Error(`claim_due_agents RPC failed: ${error.message}`);
  }
  return (data ?? []) as AgentRow[];
}

/**
 * Releases the lease on a claimed agent and stamps `last_completed_at`.
 * Bumps `last_useful_at` if `itemsKept > 0` (drives the inactive
 * transition). Idempotent on the SQL side — safe to call twice.
 *
 * MUST be called by the runner once per claim, in a try/finally or
 * equivalent. A missed release leaves the agent unclaimable for 30 minutes
 * until the lease expires; the stuck-run sweep in `batch.ts` (PR3) catches
 * the corresponding `agent_runs` row but does NOT release the lease.
 */
export async function releaseAgentLease(
  agentId: string,
  itemsKept: number,
): Promise<void> {
  if (!agentId) throw new Error("releaseAgentLease: agentId is required");
  if (!Number.isInteger(itemsKept) || itemsKept < 0) {
    throw new Error(`releaseAgentLease: itemsKept must be a nonneg integer, got ${itemsKept}`);
  }

  const { error } = await (supabaseAdmin as any).rpc("release_agent_lease", {
    p_agent_id: agentId,
    p_items_kept: itemsKept,
  });
  if (error) {
    throw new Error(`release_agent_lease RPC failed: ${error.message}`);
  }
}

/**
 * Drives state-machine transitions per docs/13 §4, encoded inside the SQL
 * function. The runner calls this AFTER `releaseAgentLease()` at finalize.
 * Idempotent.
 *
 * Status semantics relevant to lifecycle (the SQL handles the rest):
 *   - `ok` + items_kept > 0 → resets consecutive_failures, recovers from
 *                            degraded/inactive to active
 *   - `failed`              → increments consecutive_failures;
 *                            ≥5 → degraded, ≥20 → error
 *   - `ok` + items_kept = 0 → checks for inactive transition (>30d no useful)
 *   - other statuses        → no lifecycle change (surface only in agent_runs)
 */
export async function updateAgentLifecycleState(
  agentId: string,
  status: AgentRunStatus,
  itemsKept: number,
): Promise<void> {
  if (!agentId) throw new Error("updateAgentLifecycleState: agentId is required");

  const { error } = await (supabaseAdmin as any).rpc("update_agent_lifecycle_state", {
    p_agent_id: agentId,
    p_status: status,
    p_items_kept: itemsKept,
  });
  if (error) {
    throw new Error(`update_agent_lifecycle_state RPC failed: ${error.message}`);
  }
}

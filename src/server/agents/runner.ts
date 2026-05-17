/**
 * Phase 3.0 agent runtime — generic AgentRunner.
 *
 * Implements the 8-step lifecycle from docs/16 §9 + docs/13 §3:
 *
 *   1. Insert agent_runs row as 'running' (durability — a crash now still
 *      leaves an audit row that the stuck-run sweep can finalize).
 *   2. Preflight budget check (checkBudget without accumulated cost).
 *   3. Broker assembles a system-prompt fragment for the template's
 *      categories at the agent's badge tier.
 *   4. template.fetch() yields raw items (bounded by
 *      budget.maxItemsConsideredPerRun).
 *   5. Dedupe vs agent_state (loaded once at run start).
 *   6. Score + filter via template.score(); keep items >= config.minScore.
 *   7. For each kept item: mid-run budget check → template.summarise() →
 *      persist finding (unique-constrained on dedupe_key).
 *   8. Finalize: update agent_runs row, release the lease, transition
 *      lifecycle state. Runs in `finally` so every path finalizes,
 *      including thrown exceptions.
 *
 * **Invariant — handler vs runtime separation (docs/16 §22 #7):** the
 * runner type-bounds templates at `AgentTemplate<unknown, unknown>` and
 * never inspects `agent.template_id` for behavioral branching. The only
 * place template_id is read is the resolveTemplate lookup. Anti-patterns
 * to grep-reject in review:
 *   - `if (agent.template_id === ...)` anywhere in this file
 *   - reading template-specific config keys directly from agent.config
 *     (config is opaque; only the template knows its shape)
 *   - casting `template` to a concrete type
 *
 * **Dependency injection:** all external dependencies (template lookup,
 * broker assembly, clock) come in via the `deps` arg. Production
 * (PR3c's cron wiring) passes real deps; tests pass mocks. The runner
 * itself imports zero concrete templates — the registry lives in PR3b
 * but the runner doesn't depend on it existing.
 *
 * **Cost durability invariant (docs/16 §11):** the runner accumulates
 * per-summarise `_costMicroUsd` for the budget check and the final
 * `agent_runs.cost_usd` write. Actual inference_usage row writes
 * (per-LLM-hop ledger entries) are the template's responsibility,
 * since only the template has provider-level info (badge, provider,
 * model, tokens). Templates use `recordCost()` from budget.ts inline
 * per hop; this keeps cost in the ledger even if the runner crashes
 * between summarise and persist.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type {
  AgentRow,
  AgentRunRow,
  AgentRunStatus,
  AgentTemplate,
  BrokerContext,
  FindingDraft,
} from "./types";
import { checkBudget } from "./budget";
import { releaseAgentLease, updateAgentLifecycleState } from "./queue";
import { scrubErrorMessage } from "./error-scrub";

const MICRO_PER_USD = 1_000_000;

/**
 * The runner reads `agent.config` opaquely except for a single optional
 * field that gates per-item summarisation. Templates declare their own
 * config schemas; this lone shared knob is the score-filter threshold
 * the runner uses to decide whether an item is worth summarising.
 */
const DEFAULT_MIN_SCORE = 0.5;

function getMinScore(config: Record<string, unknown>): number {
  const raw = (config as { minScore?: unknown }).minScore;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return raw;
  }
  return DEFAULT_MIN_SCORE;
}

// ─── Dependencies ─────────────────────────────────────────────────────────

/**
 * Injectable surface — every non-pure dependency the runner touches.
 * Production wiring (PR3c cron) constructs this; tests pass mocks.
 *
 * Keeping these explicit rather than hidden behind global imports means:
 *   - Tests don't have to mock supabase modules just to swap a broker.
 *   - Future evolutions (e.g., a "dry-run" mode that records but doesn't
 *     persist) become argument changes, not module-level toggles.
 */
export type RunnerDeps = {
  /**
   * Returns the template matching `templateId`, or undefined if not
   * registered. The runner converts undefined → status='failed' with
   * an error message naming the template_id (no user content).
   */
  resolveTemplate: (templateId: string) => AgentTemplate<unknown, unknown> | undefined;
  /**
   * Builds the broker context for the agent's needs. Production passes
   * a wrapper around `assembleSystemPrompt` from
   * `src/server/context-broker.ts`. Tests can return a fixed fragment.
   *
   * The runner only forwards this opaquely to template methods; it
   * never inspects the fragment text. Templates also MUST treat it as
   * opaque (no parsing of category hints, no key extraction).
   */
  assembleBroker: (args: {
    userId: string;
    badge: AgentRow["badge"];
    /** Optional template-provided query string. Falls back to display_name. */
    query: string;
  }) => Promise<BrokerContext>;
  /** Clock injection for deterministic tests. Production omits. */
  now?: () => Date;
};

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Execute one claimed agent. Returns the finalized agent_runs row.
 *
 * Caller (batch.ts) is responsible for:
 *   - Having claimed the agent first via `claimDueAgents` (we trust the
 *     lease is held; we do not re-check eligibility here).
 *   - Calling this exactly once per claim. The 8-step finalize releases
 *     the lease + transitions lifecycle; a second call would be a
 *     no-op for the lease but would create a duplicate agent_runs row.
 *
 * Never throws to the caller — all template errors, broker errors, and
 * network failures are caught and recorded as `status='failed'` with a
 * scrubbed error message. The only way this function throws is if the
 * final lifecycle/lease update RPC itself errors after we've already
 * written the run row; that's a Supabase-side failure the caller should
 * surface (we log it but re-raise so the operator notices).
 */
export async function execute(
  agent: AgentRow,
  deps: RunnerDeps,
): Promise<AgentRunRow> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const runId = crypto.randomUUID();

  let status: AgentRunStatus = "running";
  let itemsFetched = 0;
  let itemsKept = 0;
  let llmHops = 0;
  let costMicroUsd = 0;
  let error: string | null = null;

  // STEP 1 — Insert the run row as 'running'. This makes the run visible
  // to the inbox UI immediately and lets the stuck-run sweep finalize
  // it if we crash before reaching the finalize block below.
  {
    const { error: insertError } = await (supabaseAdmin as any)
      .from("agent_runs")
      .insert({
        id: runId,
        agent_id: agent.id,
        user_id: agent.user_id,
        started_at: startedAt.toISOString(),
        status: "running",
      });
    if (insertError) {
      // We don't even have a run row, so the lease will stay held until
      // expiry (30 min). Release it explicitly so the next cron can
      // re-claim without waiting. Re-raise so batch.ts logs it.
      await releaseAgentLeaseSafe(agent.id);
      throw new Error(`agent_runs insert failed: ${insertError.message}`);
    }
  }

  try {
    // STEP 2 — Resolve template. Failure to resolve is a 'failed' run
    // (template_id is on the agent row but the registry doesn't know
    // it — e.g., deprecated template). No template-specific behavior
    // beyond the resolve itself; the runner stays generic.
    const template = deps.resolveTemplate(agent.template_id);
    if (!template) {
      status = "failed";
      error = `unknown template_id: ${agent.template_id}`;
      return await finalize();
    }

    // STEP 3 — Preflight budget check (no accumulated cost yet).
    const preflight = await checkBudget({
      userId: agent.user_id,
      agentId: agent.id,
      perAgentBudget: agent.budget,
      now: startedAt,
    });
    if (!preflight.ok) {
      // BOTH per_agent_runs and cpaud_ceiling preflight failures map to
      // `skipped_budget_exceeded` per docs/16 §11.1 — the user-visible
      // distinction is conveyed by the reason string, not the status.
      status = "skipped_budget_exceeded";
      error = preflight.reason;
      return await finalize();
    }

    // STEP 4 — Assemble broker context. Templates that don't need a
    // broker fragment still get an empty one; they're free to ignore.
    const broker = await deps.assembleBroker({
      userId: agent.user_id,
      badge: agent.badge,
      query: agent.display_name,
    });

    // STEP 5 — Fetch items. Bounded by budget.maxItemsConsideredPerRun.
    // We iterate the async iterable, breaking early at the limit so a
    // misbehaving template that yields unbounded doesn't run away.
    //
    // The template call context is constructed once and reused across
    // fetch/score/summarise. The `run` sub-object (PR3b.1) carries the
    // bare minimum a template needs for cost attribution via recordCost.
    const ctx = {
      config: agent.config,
      broker,
      run: { id: runId, userId: agent.user_id, badge: agent.badge },
    };
    const items: unknown[] = [];
    const cap = Math.max(0, agent.budget.maxItemsConsideredPerRun);
    for await (const item of template.fetch(ctx)) {
      items.push(item);
      itemsFetched++;
      if (itemsFetched >= cap) break;
    }

    // STEP 6 — Dedupe vs prior runs. agent_state.value stores an array
    // of dedupe keys seen across all runs for this agent. Falls back to
    // an empty set if the row doesn't exist (first run, or template
    // hasn't started using agent_state yet).
    const seen = await loadSeenKeys(agent.id);

    // STEP 7 — Score, filter, summarise, persist. Mid-run budget check
    // runs BEFORE each summarise() so a CPAUD breach on item N stops
    // before spending hop N+1, not after.
    const minScore = getMinScore(agent.config);
    const newKeysToRemember: string[] = [];

    for (const item of items) {
      const dedupeKey = template.dedupeKey(item);
      if (seen.has(dedupeKey)) continue;

      const score = await template.score(item, ctx);
      if (score < minScore) {
        // Remember it anyway — re-scoring next run wastes budget.
        newKeysToRemember.push(dedupeKey);
        continue;
      }

      // Mid-run CPAUD check. If we're already at the ceiling, bail with
      // partial_success — keeps whatever findings we already persisted
      // and the cost they incurred, but doesn't spend more.
      const midRunBudget = await checkBudget({
        userId: agent.user_id,
        agentId: agent.id,
        perAgentBudget: agent.budget,
        accumulatedCostMicroUsd: costMicroUsd,
        now: startedAt,
      });
      if (!midRunBudget.ok) {
        // Per docs/16 §11.1: mid-run failure → partial_success (some
        // findings persisted) UNLESS no findings persisted yet, in
        // which case we treat it as skipped (no useful output, no
        // surprise to the user).
        status = itemsKept > 0 ? "partial_success" : "skipped_budget_exceeded";
        error = `mid-run: ${midRunBudget.reason}`;
        break;
      }

      let draft: FindingDraft;
      try {
        draft = await template.summarise(item, ctx);
      } catch (e) {
        // Per-item summarise failure shouldn't take down the whole run;
        // skip the item but keep going. Templates that want hard-stop
        // semantics can re-throw a typed error which the outer catch
        // will surface. For now: log, count toward llmHops if the
        // template indicated any, and continue.
        console.error(
          `[runner] template.summarise failed for agent ${agent.id} run ${runId}:`,
          scrubErrorMessage(e),
        );
        continue;
      }

      llmHops += draft._llmHops;
      costMicroUsd += draft._costMicroUsd;

      // Persist. Unique constraint on (agent_id, dedupe_key) makes the
      // insert idempotent — a concurrent run that already wrote this
      // key gets ignored without error.
      const { error: insertErr } = await (supabaseAdmin as any)
        .from("agent_findings")
        .insert(
          {
            agent_id: agent.id,
            user_id: agent.user_id,
            run_id: runId,
            dedupe_key: dedupeKey,
            title: draft.title,
            summary: draft.summary,
            source_url:
              typeof (draft.payload as { url?: unknown }).url === "string"
                ? ((draft.payload as { url: string }).url)
                : null,
            payload: draft.payload,
            score,
            urgency: draft.urgency,
            state: "new",
          },
          { onConflict: "agent_id,dedupe_key", ignoreDuplicates: true },
        );

      if (insertErr) {
        // Persistence error on a single finding is bad but not fatal —
        // record and continue. Worst case: the user doesn't see that
        // specific finding; cost was already incurred (template called
        // recordCost during summarise).
        //
        // The dedupe_key (often a URL) is deliberately NOT included in
        // the log — that's user content per the no-content invariant.
        // The error message itself goes through scrubErrorMessage in
        // case Supabase echoes the conflicting key value back.
        console.error(
          `[runner] agent_findings insert failed for run ${runId}:`,
          scrubErrorMessage(insertErr.message),
        );
        continue;
      }

      itemsKept++;
      newKeysToRemember.push(dedupeKey);
    }

    // STEP 8a — Update agent_state with the newly-seen keys. Best-effort;
    // a failure here just means slightly more re-scoring next run. The
    // unique constraint on agent_findings is the durable dedupe guard.
    if (newKeysToRemember.length > 0) {
      await saveSeenKeys(agent.id, agent.user_id, seen, newKeysToRemember);
    }

    // If we got here without changing `status`, the run completed
    // normally. Even items_kept === 0 is 'ok' — drives the inactive
    // transition via the lifecycle RPC.
    if (status === "running") status = "ok";
  } catch (e) {
    // STEP 7-error catch — any throw from broker, fetch, or score
    // (summarise has its own per-item catch). Scrub before persisting.
    status = "failed";
    error = scrubErrorMessage(e);
  }

  // STEP 8 — Finalize. Runs in BOTH the success path (try-block
  // explicit return) and the failure paths (status set, fall through).
  return await finalize();

  async function finalize(): Promise<AgentRunRow> {
    const finishedAt = now();
    const costUsd = costMicroUsd / MICRO_PER_USD;

    // 8a — Update the run row with terminal status + metrics.
    const { error: updateErr } = await (supabaseAdmin as any)
      .from("agent_runs")
      .update({
        finished_at: finishedAt.toISOString(),
        status,
        items_fetched: itemsFetched,
        items_kept: itemsKept,
        llm_hops: llmHops,
        cost_usd: costUsd,
        error,
      })
      .eq("id", runId);
    if (updateErr) {
      console.error(
        `[runner] agent_runs update failed for run ${runId}:`,
        scrubErrorMessage(updateErr.message),
      );
    }

    // 8b — Release the lease. Bumps last_completed_at + last_useful_at.
    await releaseAgentLeaseSafe(agent.id, itemsKept);

    // 8c — Transition lifecycle state. Idempotent on the SQL side.
    try {
      await updateAgentLifecycleState(agent.id, status, itemsKept);
    } catch (e) {
      console.error(
        `[runner] updateAgentLifecycleState failed for agent ${agent.id}:`,
        scrubErrorMessage(e),
      );
    }

    return {
      id: runId,
      agent_id: agent.id,
      user_id: agent.user_id,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      status,
      items_fetched: itemsFetched,
      items_kept: itemsKept,
      llm_hops: llmHops,
      cost_usd: costUsd,
      error,
    };
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────

/**
 * Best-effort lease release. We never want to fail the finalize path
 * because of a lease-release error — the lease auto-expires in 30 min
 * regardless.
 */
async function releaseAgentLeaseSafe(agentId: string, itemsKept = 0): Promise<void> {
  try {
    await releaseAgentLease(agentId, itemsKept);
  } catch (e) {
    console.error(
      `[runner] releaseAgentLease failed for agent ${agentId}:`,
      scrubErrorMessage(e),
    );
  }
}

/**
 * Load the dedupe-key set for an agent. Stored as a single agent_state
 * row with key='seen_dedupe_keys' and value=string[]. Empty set on
 * first run or missing row.
 */
async function loadSeenKeys(agentId: string): Promise<Set<string>> {
  const { data, error } = await (supabaseAdmin as any)
    .from("agent_state")
    .select("value")
    .eq("agent_id", agentId)
    .eq("key", "seen_dedupe_keys")
    .maybeSingle();

  if (error || !data) return new Set();
  const raw = (data as { value: unknown }).value;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((k): k is string => typeof k === "string"));
}

/**
 * Persist the union of `existing` and `newKeys` back to agent_state.
 * Caps the stored list at SEEN_KEYS_CAP entries (oldest dropped first
 * by relying on insertion order) so an agent that's been running for
 * months doesn't grow the row unboundedly.
 *
 * Best-effort; logs on failure but doesn't raise. The dedupe constraint
 * on agent_findings is the durable guard against actual duplicate rows.
 */
const SEEN_KEYS_CAP = 5000;

async function saveSeenKeys(
  agentId: string,
  userId: string,
  existing: Set<string>,
  newKeys: string[],
): Promise<void> {
  // Deterministic order: existing keys first (preserving their order),
  // then new keys. If we cap, oldest get dropped — same intuition as
  // an LRU but without per-key access tracking.
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const k of existing) {
    if (!seen.has(k)) {
      merged.push(k);
      seen.add(k);
    }
  }
  for (const k of newKeys) {
    if (!seen.has(k)) {
      merged.push(k);
      seen.add(k);
    }
  }
  const trimmed = merged.length > SEEN_KEYS_CAP
    ? merged.slice(merged.length - SEEN_KEYS_CAP)
    : merged;

  const { error } = await (supabaseAdmin as any)
    .from("agent_state")
    .upsert(
      {
        agent_id: agentId,
        user_id: userId,
        key: "seen_dedupe_keys",
        value: trimmed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id,key" },
    );

  if (error) {
    console.error(
      `[runner] agent_state upsert failed for agent ${agentId}:`,
      scrubErrorMessage(error.message),
    );
  }
}

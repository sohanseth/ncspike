# Spec — Phase 3.0: Agent runtime (MVP)

**Status:** v1 design — LOCKED 2026-05-17. Ready to build.
**Owner:** main agent.
**Parent spec:** [docs/13-spec-phase-3-agent-runtime.md](./13-spec-phase-3-agent-runtime.md) — the full Phase 3.0–3.5 design. This sub-spec scopes specifically what 3.0 ships.
**Parent decisions:** [docs/09](./09-spec-phase-3-agentic-vision.md) §9 (v1 LOCKED) and [docs/13](./13-spec-phase-3-agent-runtime.md) §18 (v1 LOCKED) — read those first if you haven't.
**Branch base:** `native/bootstrap` (or whatever `main` looks like after that merges).

---

## 1. Why this sub-spec exists

docs/13 is the canonical multi-phase Phase 3 design — it covers everything from 3.0 runtime through 3.5 write-actions. **This file is the build-ready breakdown for 3.0 only**, the foundation that the rest of Phase 3 sits on. Everything in 3.1+ depends on 3.0 shipping.

This file MVP-scopes 3.0 specifically. The design decisions below are explicit cuts versus the parent spec, chosen so a single developer can ship 3.0 in ~1.5–2 weeks (vs. the parent spec's 2–3 weeks production estimate).

---

## 2. Goals & non-goals

### Goals
- Schema, runtime, scheduling, budget enforcement, lifecycle states, and one working template (ResearchDigest) — enough end-to-end to validate the whole runtime architecture before 3.1 JobAgent ships.
- One user-visible surface: agent findings in `/workspace/inbox`.
- GDPR coverage from day one (no "we'll add it later").
- All locked decisions from docs/09 §9 and docs/13 §18 enforced in the runtime as guardrails (not just documented).

### Non-goals (deferred)
- **JobAgent / ShoppingAgent / DealWatcher templates** → 3.1 / 3.2.
- **Natural-language agent configuration** → 3.4 (gated on the AST design sprint per docs/13 §18.6).
- **Write-actions of any kind** → 3.5. ResearchDigest is read-only.
- **Notification delivery** (web push, email digest, native push) → 3.1. 3.0 surfaces findings in Inbox only; no out-of-app notification.
- **Marketplace UI for agent templates** → 3.1. In 3.0 the only template available is ResearchDigest, created via a single hard-coded "Create research agent" button.
- **Per-skill trust gate** (docs/09 §7.4) → applies to write-actions only, so deferred to 3.5.
- **Trait sheet promotion** (docs/13 §18.4) → 3.5; 3.0's `agent_state` is strictly siloed.

---

## 3. Scope summary (8 deliverables, dependency-ordered)

| # | Deliverable | File(s) | Estimate |
|---|---|---|---|
| 1 | Schema migration: `agents`, `agent_runs`, `agent_findings`, `agent_state` | `supabase/migrations/20260601000000_phase30_agent_runtime.sql` | 0.5 day |
| 2 | GDPR wiring: `delete_user_data()` extension + `EXPORT_TABLES` update | `supabase/migrations/20260601000001_phase30_gdpr_agents.sql` + `src/lib/gdpr.functions.ts` | 0.5 day |
| 3 | TypeScript types: `AgentTemplate`, `AgentBudget`, `AgentState`, `Finding`, contexts | `src/server/agents/types.ts` | 0.5 day |
| 4 | `claimDueAgents(limit)` query helper | `src/server/agents/queue.ts` | 0.5 day |
| 5 | `AgentRunner.execute()` — the 8 steps from docs/13 §3 | `src/server/agents/runner.ts` | 2 days |
| 6 | Budget enforcement (per-agent + unified CPAUD check) | `src/server/agents/budget.ts` | 0.5 day |
| 7 | ResearchDigest template + cron entry point | `src/server/agents/templates/research-digest.ts` + `src/worker.ts` cron dispatch | 1.5 days |
| 8 | Inbox surface for agent findings | `src/routes/workspace.inbox.tsx` (extend) + `src/lib/agents.functions.ts` (new) | 1 day |

**Total: ~7 working days end-to-end.** Buffer for testing + debugging brings the calendar estimate to **1.5–2 weeks**.

---

## 4. MVP simplifications (vs. parent spec docs/13)

These are explicit cuts. The locked-decisions rationale is in §18 of docs/13; the *implementation-level* simplification is here.

### 4.1 Cut: Durable Objects

3.0 uses a stateless cron-triggered runner. **Durable Objects are deferred until agents require persistent leases, long-running write actions, or stateful orchestration beyond a single cron invocation.**

When this gets reconsidered:
- 3.5 write-actions need claim leases longer than one cron tick → may revisit.
- Multi-agent coordination (one finding triggers another agent) → may revisit.
- WebSocket-driven user-triggered "watch this agent run live" UX → may revisit.

Until then: Cloudflare Workers scheduled invocations have a 15-minute wall-clock budget, more than enough for a serial cron pass over a batch of due agents.

### 4.2 Cut: separate work queue infrastructure

3.0 does NOT have a dedicated queue table, queue service, or message broker. **But the queue-shaped boundary stays** — wrapped behind `claimDueAgents(limit)`. See §8 for the contract.

When this gets reconsidered:
- If runs need priority lanes (urgent finding processing) → add a `priority` column, no queue infra change.
- If runs need retries with exponential backoff → add `next_retry_at` to `agent_runs`, runner respects it.
- If runs need leases that survive a Worker invocation crash → introduce DO or a dedicated lease table.

Each evolution slots behind `claimDueAgents()` without touching the runner.

### 4.3 Cut: OpenTelemetry / CPAUD viewer extension

3.0 ships **structured JSON logging only**. Each agent run emits a single structured log line. Schema in §11. The `agent_runs` table is the durable source of truth for run history + cost; logs are for live debugging.

The CPAUD viewer extension (a per-agent infra-cost column) is deferred. Existing CPAUD viewer already tracks `agent_runs.cost_usd` via the unified ledger (§9), so the viewer continues to surface total $/user/day correctly without code changes.

---

## 5. Architecture overview

```
                                ┌─────────────────────────────────────────┐
                                │ Cloudflare Worker (existing src/worker) │
                                │                                         │
  Wrangler cron triggers ──────▶│ scheduled(event)                        │
   "7 3 * * *" (nightly)        │  │                                      │
   "*/30 * * * *" (every 30m)   │  │  switch (event.cron):                │
                                │  │    nightly  → runResearchBatch...    │
                                │  │    every-30 → runAgentBatch()        │
                                │  ▼                                      │
                                │ runAgentBatch(): claimDueAgents(N)      │
                                │   ▼                                     │
                                │  for each agent:                        │
                                │    AgentRunner.execute(agent)           │
                                └────────────────┬────────────────────────┘
                                                 │
                                                 │  (server-side fetches +
                                                 │   broker.assemble +
                                                 │   LLM calls via Supabase
                                                 │   service-role context)
                                                 │
              ┌──────────────────────────────────▼──────────────────────────────────┐
              │                                                                     │
              ▼                                                                     ▼
       ┌──────────────┐  ┌────────────┐  ┌───────────────┐  ┌─────────────┐  ┌─────────────────┐
       │  agents      │  │ agent_runs │  │agent_findings │  │ agent_state │  │ cpaud_aggregate │
       │  (state, FK) │  │ (history)  │  │ (per-finding) │  │ (per-agent  │  │ (existing       │
       │              │  │            │  │               │  │  KV cursors)│  │  ledger)        │
       └──────────────┘  └────────────┘  └───────┬───────┘  └─────────────┘  └─────────────────┘
                                                 │
                                                 ▼
                        ┌──────────────────────────────────────────────┐
                        │ /workspace/inbox  (existing route, extended) │
                        │   — renders agent_findings alongside Gmail   │
                        │     inbox items already there                │
                        └──────────────────────────────────────────────┘
```

Notes on this topology:

- **One cron entrypoint, two schedules.** Wrangler supports multiple crons; `event.cron` (the trigger pattern string) tells the handler which one fired. The existing `7 3 * * *` nightly research cron stays untouched. The new `*/30 * * * *` (every 30 minutes) drives the agent batch.

- **Serial batch per invocation.** Each 30-min invocation calls `claimDueAgents(N)` with a small `N` (default 10), then runs them serially via `AgentRunner.execute()` one at a time. No fan-out, no Worker subrequests beyond the LLM/source fetches the templates themselves do.

- **Row-level locking via `FOR UPDATE SKIP LOCKED`.** Two concurrent Worker invocations can't double-claim the same agent. SKIP LOCKED means a Worker doesn't block waiting on rows another Worker holds.

---

## 6. Data model

Use docs/13 §5 SQL as the starting point, with the timestamp-and-lease correction below (added 2026-05-17 per Sneha's invariant review). Migration file:

```
supabase/migrations/20260601000000_phase30_agent_runtime.sql
```

### 6.1 Timestamp + lease schema (overrides docs/13 §5)

`docs/13` §5 has a single `last_run_at` column that conflates "when was this agent last claimed by a runner?" with "when did the last run complete?". This breaks the cadence semantics — a crashed runner that never finalizes leaves the timestamp ambiguous, and we'd need a separate lease mechanism for stuck-claim recovery anyway. The clean shape:

| Column | Set by | Meaning |
|---|---|---|
| `last_claimed_at` | `claim_due_agents()` SQL function, at claim time | When the most recent runner picked this agent up. Diagnostic only — never read by scheduling. |
| `last_completed_at` | `release_agent_lease()` SQL function, at finalize | When the most recent run reached its end (any status). **Drives cadence:** an agent is due when `now() - last_completed_at > cadence_hours`. |
| `last_useful_at` | `release_agent_lease()` SQL function, if items_kept > 0 | When the most recent run produced ≥ 1 finding. **Drives inactive transition** (30 days no useful run → `inactive`). |
| `claim_expires_at` | `claim_due_agents()` at claim; `release_agent_lease()` at finalize | Lease TTL. **DB-backed lease, no Durable Object needed.** If set + in future, agent is currently claimed and not eligible for re-claim. NULL = available. |

**Lease semantics:**
- TTL = 30 minutes (matches cron cadence + buffer; tunable constant in the claim function).
- Set to `now() + 30 min` inside `claim_due_agents()` transaction (atomic with the SELECT FOR UPDATE).
- Cleared (set NULL) by `release_agent_lease()` at finalize.
- If runner crashes: lease auto-expires 30 min later; subsequent `claim_due_agents()` call treats the agent as available (lease check: `claim_expires_at IS NULL OR claim_expires_at < now()`).
- Stuck-run sweep (§10) independently marks orphan `agent_runs` rows (status `running` for > 30 min) as `timeout` — that's about audit trail for the run, not about lease release.

**Cadence is checked on `last_completed_at`**, not `last_claimed_at`. This means:
- A successful run at T0 → next run eligible at T0 + cadence_hours (correct).
- A crashed run claimed at T0 → `last_completed_at` not updated → next run eligible as soon as the lease expires (T0 + 30 min) AND cadence_hours since previous completion has passed. For agents that have NEVER completed, this means crash → 30 min recovery. Acceptable behavior — crashes are rare.

### 6.2 Idempotency

Per [replit.md](../replit.md) preferences:
- `create type` / `create table` blocks wrapped in `do $$ ... end $$` with existence checks.
- Indexes use `create index if not exists`.
- Policies use `drop policy if exists` before `create policy`.
- Trigger function `tg_set_updated_at` already exists; just add the `agents_set_updated` trigger.

Test the migration against a fresh project AND against the actual production project (which already has chat tables, trait sheet, etc.) — it must run cleanly on both.

---

## 7. GDPR wiring

GDPR is a **PR1 blocker** — no runtime code lands until deletion + export are testable. Per Sneha's invariant: agents produce several classes of data with different lifecycles. Each must be explicit.

### 7.1 Data-class matrix

| Data class | Where it lives | On `delete_user_data()` | On `export_user_data()` | Notes |
|---|---|---|---|---|
| Agent definition + config | `agents` row | **DELETED** | EXPORTED | User-owned config; full delete |
| Agent run metadata (status, duration, cost, error) | `agent_runs` row | **DELETED** | EXPORTED | Including `error` (already PII-scrubbed) |
| Generated findings (digest content, summaries) | `agent_findings` row | **DELETED** | EXPORTED | Output content; full delete |
| Per-agent state (cursors, dedupe keys) | `agent_state` row | **DELETED** | EXPORTED | Opaque KV; full delete |
| Per-hop cost events tied to LLM calls during runs | `inference_usage` row (existing table, already wired through GDPR) | **DELETED** (already covered by existing delete_user_data) | EXPORTED (already in EXPORT_TABLES) | No new wiring needed; agent LLM hops use the existing inference_usage path the same way chat does. |
| Daily aggregate of inference usage | `inference_usage_daily` row | **DELETED** (existing) | EXPORTED (existing) | Same |
| Structured Worker logs (`console.log` JSON) | Cloudflare Workers log retention | **NOT DELETED** in 3.0 | NOT EXPORTED | CF Workers logs retained per CF policy (~24h on free tier, longer on paid). **Logs MUST contain only opaque IDs + metrics — no user content, no PII, no titles, no URLs, no summaries.** See §15 for the invariant. |
| Provider traces (Anthropic / OpenAI / Groq side) | Provider's own infra | **NOT DELETED** | NOT EXPORTED | Each provider has its own retention + deletion policy. Documented in the privacy-posture page (Phase 3.9); user can request provider-side deletion via the broker's per-provider opt-out controls. |

**Why the structured-logs row says "NOT DELETED":** if the log invariant (no content, opaque IDs only) holds, there's nothing user-identifying to delete. The user's `user_id` IS in the log, but that's a UUID — it doesn't reveal anything once the DB rows are gone. The privacy-posture doc should be explicit that "agent run logs are retained as opaque debugging records and contain no content."

If the log invariant *breaks* (e.g., a debug commit accidentally logs a finding title), the spec must be revised to delete or anonymise logs on user delete. That's a future hardening item, not 3.0.

### 7.2 Migration

```
supabase/migrations/20260601000001_phase30_gdpr_agents.sql
```

Drops + recreates `delete_user_data()` with the four new tables in FK-safe order (cost events are already covered by the existing `inference_usage` delete — no new cost-table wiring needed):

```sql
-- inside delete_user_data(target_user_id uuid)
-- (... existing chat/trait/etc deletes first, including inference_usage ...)
-- NEW for Phase 3.0 — FK-safe order: children first, parent last.
delete from public.agent_findings where user_id = target_user_id;
delete from public.agent_state    where user_id = target_user_id;
delete from public.agent_runs     where user_id = target_user_id;
delete from public.agents         where user_id = target_user_id;
```

Adds four new return columns: `agents_deleted`, `agent_runs_deleted`, `agent_findings_deleted`, `agent_state_deleted`.

Client-side updates in [src/lib/gdpr.functions.ts](../src/lib/gdpr.functions.ts):
- `EXPORT_TABLES` adds `agents`, `agent_runs`, `agent_findings`, `agent_state`.
- `RPC_COLUMN_TO_TABLE` adds the four `*_deleted` keys.

[tests/leak-suite/gdpr-roundtrip-realdb.test.ts](../tests/leak-suite/gdpr-roundtrip-realdb.test.ts) — extend `seedUser()` to insert one row per agent table in FK order (agents → agent_runs → agent_findings + agent_state). Assert `delete_user_data` returns `agent_findings_deleted: 1, agent_state_deleted: 1, agent_runs_deleted: 1, agents_deleted: 1`.

---

## 8. The `claimDueAgents` queue boundary

**This is the deliberate boundary kept despite cutting queue infrastructure.** Behind this function: today, plain SQL. Tomorrow: priorities, retries, leases, write-action gates. The runner doesn't care.

```ts
// src/server/agents/queue.ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/admin-client";

/**
 * Returns up to `limit` agents that are due to run, claiming them
 * with FOR UPDATE SKIP LOCKED so concurrent runners don't double-claim.
 * Caller holds the rows for the duration of their transaction; release
 * happens implicitly when the transaction ends.
 *
 * Future evolutions (kept inside this boundary):
 *  - priority column → ORDER BY priority desc, last_run_at nulls first
 *  - exponential-backoff retries → add next_retry_at filter
 *  - write-action safety gate → add state filter excluding agents with
 *    write-actions pending user trust grant
 *  - leases that survive Worker crash → switch to lease-table + heartbeat
 */
export async function claimDueAgents(limit: number) {
  const { data, error } = await supabaseAdmin().rpc("claim_due_agents", {
    p_limit: limit,
  });
  if (error) throw new Error(`claim_due_agents failed: ${error.message}`);
  return data as AgentRow[];
}
```

The SQL function `claim_due_agents` (defined in the schema migration):

```sql
-- supabase/migrations/20260601000000_phase30_agent_runtime.sql (excerpt)
create or replace function public.claim_due_agents(p_limit int)
returns setof public.agents
language plpgsql
security definer
as $$
declare
  claimed_ids uuid[];
begin
  -- Step 1: claim due agents AND update last_run_at in the same transaction.
  -- The last_run_at update is critical for duplicate-run prevention: if the
  -- runner crashes after the claim but before finalize(), the next cron
  -- invocation still sees last_run_at = (recent) and skips this agent until
  -- cadence_hours passes. Without this update, a crashed runner leaves the
  -- agent claimable on the very next tick.
  with due as (
    select id
    from public.agents
    where state in ('active', 'degraded', 'inactive')
      and (
        last_run_at is null
        or last_run_at < now() - (cadence_hours * interval '1 hour')
      )
      -- inactive agents run at half cadence per docs/13 §4
      and (
        state <> 'inactive'
        or last_run_at < now() - (cadence_hours * 2 * interval '1 hour')
      )
    order by last_run_at nulls first
    limit p_limit
    for update skip locked
  )
  update public.agents a
  set last_run_at = now()
  from due
  where a.id = due.id
  returning a.id into claimed_ids;

  return query
    select * from public.agents where id = any(claimed_ids);
end;
$$;
```

**Invariant:** the call site relies on the fact that `last_run_at` is bumped *before* the runner starts work, not after. This means:

- A run that completes in 5 minutes leaves `last_run_at` accurate ± 5 min — fine for `cadence_hours` purposes.
- A run that crashes mid-flight still has `last_run_at` updated, preventing re-claim on the next 30-min cron until the full `cadence_hours` has passed.
- The trade-off: if the runner crashes immediately (before fetching anything useful), the user effectively skips this cadence cycle. Acceptable — better than re-running 5× in the next hour.

For "row was claimed but never finished" hygiene, see the stuck-run sweep in §10.

**Why a SECURITY DEFINER function instead of raw client-side SQL:**
- The runner runs with service-role credentials but the `claim_due_agents` function lets us version the "what is due?" logic centrally.
- Future evolutions (priority, retries) edit one SQL function, not every caller.

---

## 9. `AgentRunner.execute()` — the 8 steps

From [docs/13](./13-spec-phase-3-agent-runtime.md) §3 architecture diagram:

```
1. claim run lock
2. broker.assemble(scope)
3. template.fetch()
4. dedupe vs agent_state
5. template.score() + filter
6. persist findings
7. enqueue notifications  ← 3.0: skip (notifications are 3.1)
8. release lock + write run row
```

Skeleton implementation:

```ts
// src/server/agents/runner.ts
import { supabaseAdmin } from "@/integrations/supabase/admin-client";
import { assembleSystemPrompt } from "@/server/broker/assemble";
import { templates } from "./templates";
import { checkBudget, recordCost } from "./budget";
import { logRun } from "./logger";
import type { AgentRow, AgentRunRow } from "./types";

export async function execute(agent: AgentRow): Promise<AgentRunRow> {
  const startedAt = new Date();
  const runId = crypto.randomUUID();
  let status: AgentRunRow["status"] = "running";
  let itemsFetched = 0;
  let itemsKept = 0;
  let llmHops = 0;
  let costUsd = 0;
  let error: string | null = null;

  try {
    // STEP 1 — claim run lock (already held by FOR UPDATE on the agent row;
    // the run row itself is inserted as 'running' to surface in UI).
    await supabaseAdmin().from("agent_runs").insert({
      id: runId,
      agent_id: agent.id,
      user_id: agent.user_id,
      started_at: startedAt.toISOString(),
      status: "running",
    });

    const template = templates[agent.template_id];
    if (!template) throw new Error(`unknown template: ${agent.template_id}`);

    // STEP 1.5 — budget check (per-agent + unified CPAUD).
    const budgetOk = await checkBudget({
      userId: agent.user_id,
      agentId: agent.id,
      perAgentBudget: agent.budget,
    });
    if (!budgetOk.ok) {
      status = "budget_exceeded";
      error = budgetOk.reason;
      return await finalize();
    }

    // STEP 2 — broker assembles a system-prompt fragment for the agent's
    // category needs at its tier. PRIVATE → on-device LLM only.
    const broker = await assembleSystemPrompt({
      userId: agent.user_id,
      categories: template.brokerCategories,
      tier: badgeToTier(agent.badge),
    });

    // STEP 3 — template fetches raw items.
    const items: unknown[] = [];
    for await (const item of template.fetch({ config: agent.config, broker })) {
      items.push(item);
      itemsFetched++;
      if (itemsFetched >= agent.budget.maxItemsConsideredPerRun) break;
    }

    // STEP 4 — dedupe vs agent_state.
    const seen = await loadSeenKeys(agent.id);
    const fresh = items.filter((it) => !seen.has(template.dedupeKey(it)));

    // STEP 5 — score + filter.
    const scored: Array<{ item: unknown; score: number }> = [];
    for (const item of fresh) {
      const score = await template.score(item, { config: agent.config, broker });
      if (score >= (agent.config.minScore ?? 0.5)) {
        scored.push({ item, score });
      }
    }

    // STEP 6 — summarise + persist findings.
    // After EACH item: re-check budget. This is the partial_success path —
    // an agent that exhausts CPAUD mid-run stops persisting further findings
    // but keeps everything it produced so far. The invariant is: external
    // compute attempted = cost recorded, regardless of completion.
    for (const { item, score } of scored) {
      // Mid-run budget recheck. recordCost has already pushed any prior
      // hops into the CPAUD aggregate; if a previous summarise() pushed us
      // over the ceiling, abort with partial_success.
      const midRunBudget = await checkBudget({
        userId: agent.user_id,
        agentId: agent.id,
        perAgentBudget: agent.budget,
        accumulatedCostUsd: costUsd,
      });
      if (!midRunBudget.ok) {
        status = "partial_success";
        error = `mid-run: ${midRunBudget.reason}`;
        break;
      }

      const summary = await template.summarise(item, { config: agent.config, broker });
      llmHops += summary._llmHops ?? 0;
      costUsd += summary._costUsd ?? 0;
      await supabaseAdmin().from("agent_findings").insert({
        agent_id: agent.id,
        user_id: agent.user_id,
        run_id: runId,
        dedupe_key: template.dedupeKey(item),
        title: summary.title,
        summary: summary.summary,
        payload: summary.payload,
        score,
        urgency: summary.urgency,
        state: "new",
        source_url: summary.payload.url ?? null,
      }).onConflict("agent_id,dedupe_key").ignore();
      itemsKept++;

      // Record cost immediately, not at finalize() — so partial_success
      // runs that crash entirely still have their cost in the CPAUD ledger.
      if (summary._costUsd && summary._costUsd > 0) {
        await recordCost(agent.user_id, summary._costUsd, runId);
      }
    }

    // STEP 7 — notifications: SKIPPED in 3.0. Inbox surfaces findings; no push.

    // status stays "running" → "ok" only if we didn't break out into
    // partial_success above.
    if (status === "running") status = "ok";
  } catch (e) {
    status = "failed";
    // ALWAYS scrub before persisting. The invariant: no user content (email
    // subjects, search queries, finding payloads, prompt fragments) ever
    // reaches `agent_runs.error` or structured logs. scrubPii() strips
    // anything resembling PII or quoted content; truncates to 500 chars.
    // Tested in tests/leak-suite/agent-error-pii.test.ts (per docs/13 §16.2).
    error = scrubPii(String(e)).slice(0, 500);
  }

  // STEP 8 — finalize: update run row + agent row + record cost.
  return await finalize();

  async function finalize(): Promise<AgentRunRow> {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    await supabaseAdmin().from("agent_runs").update({
      finished_at: finishedAt.toISOString(),
      status,
      items_fetched: itemsFetched,
      items_kept: itemsKept,
      llm_hops: llmHops,
      cost_usd: costUsd,
      error,
    }).eq("id", runId);

    await updateAgentLifecycleState(agent, status, itemsKept);
    if (costUsd > 0) await recordCost(agent.user_id, costUsd, runId);

    logRun({
      run_id: runId,
      agent_id: agent.id,
      user_id: agent.user_id,
      agent_type: agent.template_id,
      status,
      duration_ms: durationMs,
      cost_usd: costUsd,
      error_code: error ? errorCodeFor(error) : null,
    });

    return { id: runId, status, items_fetched: itemsFetched, items_kept: itemsKept, llm_hops: llmHops, cost_usd: costUsd, error };
  }
}
```

Supporting functions (`updateAgentLifecycleState`, `loadSeenKeys`, `scrubPii`, `errorCodeFor`, `badgeToTier`) defined alongside. State transitions per [docs/13](./13-spec-phase-3-agent-runtime.md) §4:

- `status === 'ok'` && `items_kept > 0` → reset `consecutive_failures = 0`, set `last_useful_at = now()`.
- `status === 'ok'` && `items_kept === 0` → check `last_useful_at`: if > 30 days ago, transition to `inactive`.
- `status === 'failed'` → increment `consecutive_failures`. If ≥ 5, transition to `degraded`. If ≥ 20, transition to `error`.
- `status === 'budget_exceeded'` → no state change; user sees the surface in Inbox per §10.

---

## 10. Scheduling

`wrangler.jsonc` already has one cron (`7 3 * * *` for the existing nightly research batch). Add a second:

```jsonc
{
  // ... existing fields ...
  "triggers": {
    "crons": [
      "7 3 * * *",        // existing: nightly research batch
      "*/30 * * * *"      // NEW: agent runtime, every 30 minutes
    ]
  }
}
```

`src/worker.ts` dispatches on `event.cron`:

```ts
async scheduled(event: CfScheduledEvent, _env: unknown, ctx: CfExecutionContext) {
  if (event.cron === "*/30 * * * *") {
    ctx.waitUntil(
      runAgentBatch().catch((e) => console.error("[worker.scheduled] agent batch threw:", e))
    );
    return;
  }
  // existing nightly research path
  ctx.waitUntil(runResearchBatchAllUsers().catch(...));
}
```

`runAgentBatch()`:

```ts
// src/server/agents/batch.ts
const BATCH_LIMIT = 10;
const STUCK_RUN_THRESHOLD_MIN = 30; // matches the cron cadence; runs older
                                    // than this without finalize are stuck.

export async function runAgentBatch() {
  // 1. Stuck-run sweep — durable failure invariant. Any agent_runs row in
  // 'running' state older than the sweep threshold is marked 'timeout'.
  // Without this, a Worker that crashes between INSERT and UPDATE leaves
  // the row 'running' forever, making debug "did this ever run?" ambiguous.
  await sweepStuckRuns(STUCK_RUN_THRESHOLD_MIN);

  // 2. Claim due agents (also bumps last_run_at — see §8) + execute serially.
  const agents = await claimDueAgents(BATCH_LIMIT);
  for (const agent of agents) {
    try {
      await execute(agent);
    } catch (e) {
      // Outer crash guard: scrub before logging. Note that an inner
      // execute() catch would already have written the failure to
      // agent_runs; this outer catch is for crashes BEFORE the run row
      // was inserted at all (e.g., Supabase connection death mid-insert).
      console.error(`[agent ${agent.id}] crashed outside runner:`, scrubPii(String(e)));
    }
  }
}

async function sweepStuckRuns(thresholdMinutes: number) {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
  await supabaseAdmin()
    .from("agent_runs")
    .update({
      status: "timeout",
      finished_at: new Date().toISOString(),
      error: `runner did not finalize within ${thresholdMinutes} minutes`,
    })
    .eq("status", "running")
    .lt("started_at", cutoff);
}
```

**Hard batch limit:** `BATCH_LIMIT = 10` is the only knob for per-tick concurrency. With 30-min cron, theoretical max = 480 runs/day. Practical: most runs finish in <30s so a single tick can clear all due agents for current user counts. Bump the constant when load profile demands it; environment variable later.

> **Cron framing** (per Sneha's edit during the 3.0 lock conversation): cron fires every 30 minutes. Each invocation claims a bounded batch of due agents. Individual agent cadence is still controlled by `cadence_hours`; the cron just decides how quickly due work is noticed.

The 30-min cron means an agent due 35 minutes ago waits at most another 25 minutes (worst case: cron fires immediately *before* the agent becomes due, agent becomes due 1 min after, next cron is 29 min away). Acceptable for v1.

---

## 11. Budget enforcement

Two layers, checked **both pre-flight and mid-run**:

1. **Per-agent budget** (the `AgentBudget` JSONB on the `agents` row).
2. **Unified CPAUD ceiling** (existing cross-feature daily $/user limit, currently $1.50/day).

```ts
// src/server/agents/budget.ts
import { supabaseAdmin } from "@/integrations/supabase/admin-client";
import type { AgentBudget } from "./types";

export type BudgetCheckResult =
  | { ok: true }
  | { ok: false; reason: string; kind: "per_agent_runs" | "cpaud_ceiling" };

// Unit invariant (Sneha audit, 2026-05-17): all internal cost math is
// micro-USD. Dollars only appear in human-readable log strings. The dollar
// constant in cpaud.functions stays the source of truth for UI; we derive
// the integer micro form once at module load.
const MICRO_PER_USD = 1_000_000;
const CPAUD_CEILING_MICRO_USD = Math.round(CPAUD_CEILING_USD * MICRO_PER_USD);

export async function checkBudget(args: {
  userId: string;
  agentId: string;
  perAgentBudget: AgentBudget;
  /** Cost (MICRO-USD) accumulated within the current run, not yet visible
   *  in inference_usage_daily. Mid-run callers pass the running sum of
   *  `_costMicroUsd` from each `template.summarise()`. Preflight: pass 0. */
  accumulatedCostMicroUsd?: number;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}): Promise<BudgetCheckResult> {
  const accumulatedMicro = args.accumulatedCostMicroUsd ?? 0;
  const isPreflight = accumulatedMicro === 0;
  const now = args.now ?? new Date();

  // 1. Per-agent: count runs in the rolling 24h window (preflight only —
  // once a run has started this would always be ≥ 1 from its own row).
  if (isPreflight) {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabaseAdmin
      .from("agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", args.agentId)
      .gte("started_at", since);

    const runsToday = count ?? 0;
    if (runsToday >= args.perAgentBudget.maxRunsPerDay) {
      return {
        ok: false,
        kind: "per_agent_runs",
        reason: `per-agent maxRunsPerDay (${args.perAgentBudget.maxRunsPerDay}) reached`,
      };
    }
  }

  // 2. Unified CPAUD: sum micro-USD spend for today from the daily
  // aggregate, plus accumulated in-flight cost. The agent runtime reads
  // the aggregate (not raw inference_usage) because the 30-min cron
  // cadence doesn't need sub-day latency.
  const dayKey = now.toISOString().slice(0, 10);
  const { data } = await supabaseAdmin
    .from("inference_usage_daily")
    .select("cost_micro_usd_sum")
    .eq("user_id", args.userId)
    .eq("day", dayKey);

  const todaySpendMicro = (data ?? []).reduce(
    (acc, row) => acc + Number(row.cost_micro_usd_sum ?? 0),
    0,
  );
  const projectedMicro = todaySpendMicro + accumulatedMicro;

  if (projectedMicro >= CPAUD_CEILING_MICRO_USD) {
    return {
      ok: false,
      kind: "cpaud_ceiling",
      reason: `user CPAUD ceiling ($${CPAUD_CEILING_USD.toFixed(2)}) reached`,
    };
  }
  return { ok: true };
}

/** Push a single LLM-hop cost via the existing inference_usage path.
 *  Called inline during the run (per LLM hop), NOT batched at finalize.
 *  This is the invariant: *if external compute is attempted, cost is
 *  recorded — even if the run fails before persisting any finding*.
 *
 *  Reuses the existing inference_usage table (same shape chat uses via
 *  src/server/inference/chat.ts:writeUsage). agent_run_id is tagged in
 *  the `metadata` JSONB column (added 20260517000200_phase29b) so CPAUD
 *  breakdowns can attribute spend to agents vs chat without a new column.
 *
 *  GDPR: inference_usage is already in EXPORT_TABLES and already wiped
 *  by delete_user_data; no new GDPR wiring for cost events. */
export async function recordCost(args: {
  userId: string;
  agentRunId: string;
  badge: Badge;
  providerChain: string[];
  providerUsed: string;
  modelUsed: string | null;
  fallbackDepth: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Micro-USD per the unit invariant above. */
  costMicroUsd: number;
  latencyMs: number;
  status: "ok" | "rate_limited" | "error" | "user_abort" | "cap_exceeded";
  errorClass?: string;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("inference_usage").insert({
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
    metadata: { agent_run_id: args.agentRunId },  // ← the agent tag
  });
  // Cap fail-open invariant inherited from chat's writeUsage: insert errors
  // are logged but NEVER thrown — raising here would cancel an agent
  // finding that already completed. Fix lands with the atomic ledger.
  if (error) {
    console.error(
      `[inference_usage] CAP-CRITICAL agent recordCost failure (status=${args.status}, run=${args.agentRunId}):`,
      error.message,
    );
  }
}
```

**Implementation reference:** the live code matching this example is in
[`src/server/agents/budget.ts`](../src/server/agents/budget.ts) and
[`tests/leak-suite/phase30-budget.test.ts`](../tests/leak-suite/phase30-budget.test.ts).
The two earlier sketches in this section (pre-PR2) referenced
`source` / `source_id` / `cost_usd` columns that don't exist on
`inference_usage` — superseded.

### 11.1 Run-status enum

`agent_runs.status` is a CHECK-constrained text column (or PG enum — implementer's choice) with these values:

| Status | When | External compute may have been spent? |
|---|---|---|
| `running` | Row inserted at run start, before any work | No |
| `ok` | Run completed; at least one finding persisted, no budget hit | Possibly |
| `failed` | Runner threw an exception (template error, broker error, network) | Possibly — cost still recorded via `recordCost` |
| `partial_success` | Mid-run budget check failed; some findings persisted before abort | Yes — partial cost recorded |
| `skipped_budget_exceeded` | Preflight budget check failed; no external work attempted | No |
| `skipped_disabled` | Agent state changed to `paused` / `archived` / `error` between claim and execute (rare) | No |
| `timeout` | Sweep marked it — runner never reached finalize within the threshold | Possibly — last recorded cost in `inference_usage` (filtered by `metadata->>'agent_run_id' = run.id`) is authoritative |
| `cancelled` | User-initiated cancellation. **Not used in 3.0** (no cancel UI yet); reserved for 3.5+ | Possibly |

**Invariant — cost durability:** for every status except `running`, `agent_runs.cost_usd` reflects the total of `inference_usage` rows filtered by `metadata->>'agent_run_id' = run.id`. The sweep and partial_success paths preserve this — `recordCost` runs inline per LLM hop, so even a runner crash post-LLM-hop leaves the cost in the ledger.

### 11.2 Free-tier ceiling enforcement (3.0 vs 3.1)

The locked free-tier numbers (docs/09 §7.5 — 8/day public floor + 12/day beta default):

- 3.0 reads the per-agent `maxRunsPerDay` from each `agents` row, not from a global config. The free-tier *cross-agent* ceiling (sum of runs across all agents owned by one user) is a **3.1 deliverable** — for 3.0, the only template is ResearchDigest with `maxRunsPerDay: 1` default, so a user with even 10 active research agents tops out at 10 runs/day, comfortably under 12.
- When 3.1 ships JobAgent + ShoppingAgent (each with higher per-agent budgets), the cross-agent daily-runs-per-user ceiling becomes load-bearing. Spec'd then, not now.

---

## 12. Lifecycle state machine

Use [docs/13](./13-spec-phase-3-agent-runtime.md) §4 as-is. State transitions implemented in `updateAgentLifecycleState()`. The eight states all valid in 3.0; the user-attention states (`needs_user_attention`, `inactive` with "Keep or archive?" prompt) need UI surfaces in Inbox (see §13).

---

## 13. ResearchDigest template

Per [docs/13](./13-spec-phase-3-agent-runtime.md) §7.1. Full implementation in `src/server/agents/templates/research-digest.ts`.

**Invariant — handler vs runtime separation:** `AgentRunner.execute()` MUST NOT contain ResearchDigest-specific code. All template-specific logic lives in the `AgentTemplate` implementation. The runner dispatches purely through the four interface methods (`fetch`, `dedupeKey`, `score`, `summarise`) plus the registry lookup. Anti-patterns to grep-reject in review:

- `if (agent.template_id === 'research_digest') { ... }` anywhere in `runner.ts`, `batch.ts`, `queue.ts`, or `budget.ts`.
- Reading template-specific config keys from `agent.config` in the runner.
- Casting `template` to a concrete type instead of `AgentTemplate<unknown, unknown>` in the runner.

The runner accepts that 3.0 ships with one template; 3.1 ships three more, 3.4 ships unlimited via the AST. If the runner is overfit to ResearchDigest, every subsequent template ships its own ad-hoc runner. Hard no.

```ts
// src/server/agents/templates/research-digest.ts
import { z } from "zod";
import { webSearch } from "@/lib/search.functions";
import { callLLM } from "@/server/inference/router";
import type { AgentTemplate } from "../types";

const ConfigSchema = z.object({
  topics: z.array(z.string()).min(1).max(5),
  lookbackHours: z.number().int().min(1).max(168).default(24),
  minScore: z.number().min(0).max(1).default(0.5),
});

type Config = z.infer<typeof ConfigSchema>;
type Item = { url: string; title: string; snippet: string; engine?: string };

export const ResearchDigest: AgentTemplate<Config, Item> = {
  id: "research_digest",
  displayName: "Research Digest",
  description: "Pulls relevant articles on your topics. Daily digest.",
  defaultBadge: "flash",
  defaultCadenceHours: 24,
  defaultBudget: {
    maxRunsPerDay: 1,
    maxItemsConsideredPerRun: 30,
    maxLLMHopsPerItem: 1,
    maxNotificationsPerDay: 1,
  },
  configSchema: ConfigSchema,
  brokerCategories: ["interests", "preferences"],

  async *fetch({ config }) {
    for (const topic of config.topics) {
      const res = await webSearch({ data: { query: topic } });
      for (const hit of res.results.slice(0, 30)) {
        yield {
          url: hit.url,
          title: hit.title,
          snippet: hit.snippet,
          engine: hit.engine,
        };
      }
    }
  },

  dedupeKey(item) {
    return canonicaliseUrl(item.url);
  },

  async score(item, { config, broker }) {
    const prompt = `Rate the relevance of this article to the topics ${config.topics.join(", ")} on a 0–1 scale. Article: "${item.title}". Snippet: "${item.snippet}". Respond with just the number.`;
    const reply = await callLLM({
      systemPromptFragment: broker.fragment,
      userMessage: prompt,
      badge: "flash",
      maxTokens: 8,
    });
    const n = parseFloat(reply.text);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  },

  async summarise(item, { config, broker }) {
    const prompt = `Summarise this article in 2 sentences for someone interested in ${config.topics.join(", ")}. Article title: "${item.title}". Snippet: "${item.snippet}".`;
    const reply = await callLLM({
      systemPromptFragment: broker.fragment,
      userMessage: prompt,
      badge: "flash",
      maxTokens: 120,
    });
    return {
      title: item.title,
      summary: reply.text,
      payload: { url: item.url, fetched_at: new Date().toISOString(), engine: item.engine },
      urgency: "normal",
      _llmHops: 1,
      _costUsd: reply.costUsd,
    };
  },
};
```

Template registry `src/server/agents/templates/index.ts`:

```ts
import { ResearchDigest } from "./research-digest";

export const templates = {
  research_digest: ResearchDigest,
} as const;
```

3.1 adds `job`, `shopping`, `deal_watcher` to this map.

---

## 14. Inbox surface — minimum viable UI

3.0 ships the runtime first; the UI is the minimum needed to validate it works end-to-end and to manage agents enough not to require DB access. **Anything beyond this list slides to 3.1.**

### 14.1 What 3.0 ships

1. **Create research agent** — single button on `/workspace/inbox`, opens a small form (topics + cadence), POSTs to a `createAgent` server fn.
2. **List agents** — a section on `/workspace/inbox` (or a lightweight `/workspace/agents` route, implementer's choice) showing each agent: display_name, template type, state badge, last_run_at, last_useful_at.
3. **See latest run output** — agent findings rendered read-only as cards: title (clickable → `source_url`), summary, agent that surfaced it. No accept/dismiss/snooze in 3.0.
4. **Pause / Delete agent** — two buttons per agent. Pause → state transition to `paused`. Delete → DELETE the `agents` row (cascade removes runs + findings + state per FKs).
5. **Basic error / degraded state visible** — state badge color: green active, yellow degraded, red error, gray paused/archived.

### 14.2 What 3.0 explicitly does NOT ship

- Accept / dismiss / snooze on findings → 3.1 (paired with notifications).
- Findings filtering by agent, by urgency, by date → 3.1.
- Read/unread tracking on findings → 3.1.
- Agent setup wizard, template marketplace, browse-templates UI → 3.1.
- Cadence reconfiguration UI → 3.3.
- "Run now" manual trigger → 3.3 (when parallel-3 user-triggered guardrails land per docs/13 §18.5).

### 14.3 Server functions (3.0 only)

`src/lib/agents.functions.ts`:

```ts
export const createAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    template_id: z.literal("research_digest"),  // 3.0: ResearchDigest only
    display_name: z.string().min(1).max(80),
    config: z.unknown(),  // template's configSchema validates inside the handler
  }))
  .handler(async ({ data, context }) => {
    const template = templates[data.template_id];
    if (!template) throw new Error("unknown template");
    const config = template.configSchema.parse(data.config);
    const { data: row, error } = await context.supabaseUser
      .from("agents")
      .insert({
        user_id: context.userId,
        template_id: data.template_id,
        display_name: data.display_name,
        config,
        badge: template.defaultBadge,
        state: "active",
        cadence_hours: template.defaultCadenceHours,
        budget: template.defaultBudget,
        notify: {},  // 3.1
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const listAgents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabaseUser
      .from("agents")
      .select("id, template_id, display_name, state, cadence_hours, last_run_at, last_useful_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    return { agents: data ?? [] };
  });

export const fetchAgentFindings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabaseUser
      .from("agent_findings")
      .select("id, agent_id, title, summary, source_url, urgency, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(50);
    return { findings: data ?? [] };
  });

export const pauseAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ id: z.string().uuid(), paused: z.boolean() }))
  .handler(async ({ data, context }) => {
    await context.supabaseUser
      .from("agents")
      .update({ state: data.paused ? "paused" : "active" })
      .eq("id", data.id)
      .eq("user_id", context.userId);
  });

export const deleteAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data, context }) => {
    // FK cascade handles agent_runs, agent_findings, agent_state.
    await context.supabaseUser
      .from("agents")
      .delete()
      .eq("id", data.id)
      .eq("user_id", context.userId);
  });
```

Note that 3.0 ships NO `setFindingState` server function. Findings are read-only display until 3.1.

---

## 15. Observability — structured logs

One log line per run, JSON. Use the existing `console.log` (CF Workers ships logs to wrangler tail and Logpush configured downstream).

```ts
// src/server/agents/logger.ts
export type AgentRunLog = {
  run_id: string;
  agent_id: string;
  user_id: string;
  agent_type: string;
  status: "ok" | "failed" | "partial_success" | "skipped_budget_exceeded" | "skipped_disabled" | "timeout" | "cancelled";
  duration_ms: number;
  cost_usd: number;
  error_code: string | null;  // structured code; NEVER the error message
};

export function logRun(entry: AgentRunLog): void {
  // Single structured log line. CF Workers logs are JSON-friendly.
  console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "agent_run", ...entry }));
}
```

### 15.1 Invariant — no content in logs

The log payload is **IDs + metrics only**. Concretely BANNED from any log line emitted by the agent runtime:

- Finding titles, summaries, payloads
- Source URLs (they can carry user-identifying query strings)
- User prompts, broker fragments, system prompts
- LLM response text
- Email subjects, calendar event titles, contact names
- Raw exception messages (they may contain any of the above)

What IS allowed:
- UUIDs: `run_id`, `agent_id`, `user_id`
- Enum values: `agent_type`, `status`
- Numeric metrics: `duration_ms`, `cost_usd`, `items_fetched`, `items_kept`, `llm_hops`
- **Structured `error_code`** — a short well-known string like `"broker_unavailable"` / `"template_fetch_timeout"` / `"llm_rate_limit"`. Defined in `src/server/agents/errors.ts` as a const enum. Generated by `errorCodeFor(error)` which maps raw exceptions to known codes; falls back to `"unknown"` if the exception doesn't match any pattern.

**Why this matters for GDPR (§7):** Cloudflare Workers logs are retained per CF's policy (typically 24h on free, longer on paid) and are NOT swept by `delete_user_data()`. The privacy posture (§7.1) holds only if logs contain no content. A debug commit that accidentally logs a finding title is a GDPR exposure that needs a separate sweep — easier to make the no-content rule a CI-enforceable invariant than to add log deletion infra.

CI check: a test in `tests/agents/log-contents.test.ts` instantiates the runner with adversarial template fixtures (titles like "USER_PII_TITLE_DO_NOT_LOG"), captures `console.log` output, and asserts none of those strings appear.

`agent_runs` table is the durable record for content-bearing fields (`error` after PII scrub, `payload` of findings). Logs are for live debugging via `wrangler tail` only.

---

## 16. Migrations to ship

| File | Purpose |
|---|---|
| `supabase/migrations/20260601000000_phase30_agent_runtime.sql` | 4 tables + `claim_due_agents` RPC + RLS + updated_at trigger |
| `supabase/migrations/20260601000001_phase30_gdpr_agents.sql` | Extends `delete_user_data()` + adds 4 *_deleted return columns |

Both idempotent per [replit.md](../replit.md) preferences. Both tested against fresh + existing project before merge.

---

## 17. File layout — new code locations

```
src/server/agents/
  types.ts              — AgentTemplate, AgentBudget, AgentRow, finding/run/state types, contexts
  queue.ts              — claimDueAgents(limit) wrapping the RPC
  runner.ts             — AgentRunner.execute(agent), the 8 steps
  budget.ts             — checkBudget(), recordCost()
  batch.ts              — runAgentBatch() for the cron entrypoint
  logger.ts             — logRun(entry) structured-log helper
  templates/
    index.ts            — template registry
    research-digest.ts  — ResearchDigest implementation
  __tests__/
    runner.test.ts      — unit tests
    research-digest.test.ts
    budget.test.ts

src/lib/agents.functions.ts   — client-side server fn wrappers (fetchAgentFindings, setFindingState)
src/routes/workspace.inbox.tsx — (extended) renders agent findings alongside existing inbox

src/worker.ts                  — (extended) cron dispatch on event.cron
wrangler.jsonc                 — (extended) add the */30 * * * * trigger
supabase/migrations/
  20260601000000_phase30_agent_runtime.sql
  20260601000001_phase30_gdpr_agents.sql
src/lib/gdpr.functions.ts     — (extended) EXPORT_TABLES + RPC_COLUMN_TO_TABLE
tests/leak-suite/
  gdpr-roundtrip-realdb.test.ts — (extended) seed 4 new tables
  agent-broker.test.ts (NEW) — broker leak coverage for agent prompts
```

Total new files: ~12. Modified files: ~5.

---

## 18. Test plan (3.0 subset)

From [docs/13](./13-spec-phase-3-agent-runtime.md) §16, the 3.0-relevant tests:

### 18.1 Unit (vitest)
- ResearchDigest `dedupeKey` is stable across runs for the same item (URL canonicalisation correctness).
- `claimDueAgents` respects `cadence_hours` (agent due 1h after `cadence_hours: 24` → not claimed; agent due 25h after → claimed).
- `checkBudget` returns `ok: false` at exactly the per-agent maxRunsPerDay (off-by-one paranoia).
- `updateAgentLifecycleState` transitions match the state machine — drive each transition with a fixture, assert the resulting row.

### 18.2 Leak suite extension
- New `tests/leak-suite/agent-broker.test.ts`: 100 synthetic agent configs × 4 badges × 4 tiers, assert the broker never injects identity / household / health categories into a ResearchDigest agent's prompt.

### 18.3 GDPR
- Per-user-table-coverage stays green automatically (it picks up new tables from `EXPORT_TABLES`).
- Real-DB roundtrip: seed 1 row per agent table per user, assert `delete_user_data` returns `agents_deleted: 1, agent_runs_deleted: 1, agent_findings_deleted: 1, agent_state_deleted: 1`.

### 18.4 Integration (mocked sources)
- ResearchDigest with `webSearch` stubbed to return 30 articles → 30 findings, 0 dupes on first run, 0 new findings on re-run with the same fixture (dedupe across runs).

### 18.5 NOT in 3.0
- Eval harness (precision@10, user approval rate, etc.) — those need real templates beyond ResearchDigest + actual user usage. Deferred to 3.1+.

---

## 19. Deferred (explicit cuts)

Re-iterating §2 for grep-ability. The following are EXPLICITLY NOT in 3.0:

| Deferred | Goes to |
|---|---|
| JobAgent / ShoppingAgent / DealWatcher templates | 3.1 / 3.2 |
| Agent setup UI / template marketplace | 3.1 |
| Notification delivery (web push, email digest, native push) | 3.1 + 3.5 |
| Cadence config UI / abandonment review prompts | 3.3 |
| Natural-language agent configuration (with AST design prelude) | 3.4 |
| Write-actions of any kind + per-skill trust gate | 3.5 |
| Trait sheet promotion (explicit + suggested-via-approval) | 3.5 |
| User-triggered "run all" with parallel-3 + budget warning | 3.3 (or earlier if user pain surfaces) |
| Durable Objects / lease tables | 3.5+ if needed |
| Eval harness (precision@10, abandonment metrics) | 3.1+ |
| CPAUD viewer "agent infra" column | when there's something to view |
| OpenTelemetry / distributed tracing | when distributed traces are painful enough to be worth the build |

---

## 20. Build sequence

Recommended PR-sized chunks:

1. **PR1 — schema + GDPR** (1 day): migrations + GDPR wiring + leak-suite seeding. Independent of any runner code; tests prove the schema is clean. Lands first.
2. **PR2 — types + queue + budget skeleton** (1 day): `types.ts`, `queue.ts`, `budget.ts` with unit tests. No runner yet — these are the primitives.
3. **PR3 — runner + ResearchDigest + cron wiring** (3 days): `runner.ts`, `templates/research-digest.ts`, `batch.ts`, `worker.ts` cron dispatch, `wrangler.jsonc` cron trigger. Integration test of the full pipeline (mocked search).
4. **PR4 — Inbox surface** (1 day): `agents.functions.ts`, extend `workspace.inbox.tsx`, "Create research agent" affordance.
5. **PR5 — observability + polish** (1 day): `logger.ts`, error scrubbing, lifecycle-transition edge cases, deployment to a Cloudflare Workers staging env to confirm the cron actually fires.

Total ~7 days; calendar 1.5–2 weeks with testing, breakage, and review buffer.

---

## 21. Known assumptions

Runtime assumptions worth making explicit even though each has an answer somewhere in the spec. If any of these changes mid-build, the spec needs revisiting before the code does.

| Assumption | Answer in 3.0 | Where |
|---|---|---|
| Worker invocation time budget | 15 min (CF Workers scheduled invocation hard limit). A single batch (10 agents serial, ~30s each typical) fits with margin. | §10 |
| Retry policy on transient failures (provider timeout, 429, etc.) | **None in 3.0.** Failed runs land in `agent_runs` with `status=failed`; next cron tick re-runs the agent if it's again due. 3.1 adds exponential-backoff retries via `agent_runs.next_retry_at`. | §11.1 + §19 |
| Max agents claimed per cron tick | `BATCH_LIMIT = 10`, hardcoded in `batch.ts`. Knob for later. | §10 |
| CPAUD budget exhausted mid-run | `partial_success` status; persisted findings kept; recorded cost retained; remaining items not fetched. | §11 |
| Skipped runs recorded? | **Yes for `skipped_disabled` and `partial_success`.** **No** explicit row for `skipped_not_due` — `claim_due_agents` filters them out before they reach the runner, so they never get a row. Preflight `skipped_budget_exceeded` DOES insert a row (the runner has already written `status='running'` before the check). | §11.1 |
| Degraded / inactive vs active scheduling | Same `claim_due_agents` query path. `inactive` runs at 2× the configured cadence_hours; `degraded` runs at 1× but has its `consecutive_failures` count visible in the UI. State transitions happen in `updateAgentLifecycleState()` after each run. | §8 (SQL) + §12 |
| Deletion behavior for agent output vs run metadata under GDPR | All deleted equally. Output (`agent_findings`), metadata (`agent_runs`), config (`agents`), cursors (`agent_state`), and per-run cost events (`inference_usage` rows, already covered by the existing user-id delete) all wiped in one `delete_user_data` call. Structured Worker logs NOT deleted; relies on no-content invariant. | §7.1 |
| Duplicate-run prevention if a cron overlaps a slow previous invocation | Two-layered: (1) `claim_due_agents` updates `last_run_at = now()` inside the claiming transaction, so the slow invocation's agent is invisible to subsequent ticks for `cadence_hours`. (2) `FOR UPDATE SKIP LOCKED` prevents two concurrent invocations from claiming the same row. (3) Stuck-run sweep marks `running` rows older than 30 min as `timeout` so the UI doesn't show "still running" forever. | §8 + §10 |

## 22. Invariant verification checklist (for PR1 review)

These are the seven invariants Sneha flagged. Each must be verifiable from the code + tests; not just "written down somewhere."

| # | Invariant | How it's enforced | How it's tested |
|---|---|---|---|
| 1 | No duplicate runs across overlapping crons | `claim_due_agents` bumps `last_run_at` in-transaction + `FOR UPDATE SKIP LOCKED` | Integration test: two concurrent `runAgentBatch()` calls against the same DB; assert each agent's run count = 1 in a 30-min window |
| 2 | No unbounded batches | `BATCH_LIMIT` constant, only knob | Unit test: `claimDueAgents(N)` never returns > N rows |
| 3 | No content in logs | `logRun()` schema is IDs + metrics only; `errorCodeFor()` maps raw exceptions to enum codes | CI test in `log-contents.test.ts` runs adversarial fixtures, greps log output for forbidden strings |
| 4 | Budget checked before AND after | `checkBudget()` called in two places: preflight (§9 step 1.5) and mid-run loop (§9 step 6) | Unit test: fixture where 3rd item pushes over CPAUD ceiling → `status=partial_success`, `items_kept=2`, cost recorded for hops 1–3 |
| 5 | Failures are durable | `agent_runs` row inserted as `running` at start; finalize always runs (in `finally` or via sweep) | Integration test: kill the Worker mid-run; next batch tick's sweep marks the row `timeout` |
| 6 | GDPR delete is complete | `delete_user_data` covers all 5 data classes (4 agent tables + `inference_usage` user-id delete, already covered pre-PR1); structured logs covered by no-content invariant | `gdpr-roundtrip-realdb.test.ts` extends seed + assert (per §7.2) |
| 7 | ResearchDigest not hardcoded | Runner uses only `AgentTemplate<unknown, unknown>` dispatch; no `if (template_id === ...)` branches anywhere | Code review grep + a "second template" smoke test in 3.1 (when JobAgent lands) — if the runner needed changes to host it, this invariant was broken |

PR1 ships the schema + GDPR per §20. PRs 2–5 each must demonstrate the relevant invariants are still upheld; reviewer should reject any PR that breaks one without an explicit spec revision.

---

## Appendix A — relevant locked decisions

For grep-ability when reading the code:

- **docs/09 §7.5 (LOCKED 2026-05-15):** Free-tier daily budget is 8/day public floor, 12/day beta default via remote config. Enforced via per-agent `maxRunsPerDay` summed across the user's agents — *cross-agent ceiling is a 3.1 deliverable*, not 3.0.
- **docs/13 §18.4 (LOCKED 2026-05-15):** Agent activity siloed in `agent_state` for 3.0–3.4. **No silent writes to trait sheet.** `agent_state` table has no FK to the trait sheet; promotion logic ships in 3.5.
- **docs/13 §18.5 (LOCKED 2026-05-15):** Serial scheduled runs in 3.0. User-triggered "run all" with parallel-3 + guardrails ships later.
- **docs/13 §18.6 (LOCKED 2026-05-15):** Generative-agent AST is a 3.4 concern. 3.0's per-agent `config` field is template-specific JSON validated by the template's `configSchema` — no AST machinery yet.

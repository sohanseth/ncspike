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

**Use docs/13 §5 SQL as-is.** All four tables. No changes for 3.0. Migration file:

```
supabase/migrations/20260601000000_phase30_agent_runtime.sql
```

Make it idempotent per [replit.md](../replit.md) preferences:
- `create type` / `create table` blocks wrapped in `do $$ ... end $$` with existence checks.
- Indexes use `create index if not exists`.
- Policies use `drop policy if exists` before `create policy`.
- Trigger function `tg_set_updated_at` already exists; just add the `agents_set_updated` trigger.

Test the migration against a fresh project AND against the actual production project (which already has chat tables, trait sheet, etc.) — it must run cleanly on both.

---

## 7. GDPR wiring

**Use docs/13 §15 as-is.** Migration file:

```
supabase/migrations/20260601000001_phase30_gdpr_agents.sql
```

Drops + recreates `delete_user_data()` with the four new tables in FK-safe order:

```sql
-- inside delete_user_data(target_user_id uuid)
-- (... existing chat/trait/etc deletes first ...)
agent_findings_deleted := (delete from public.agent_findings where user_id = target_user_id);
agent_state_deleted    := (delete from public.agent_state    where user_id = target_user_id);
agent_runs_deleted     := (delete from public.agent_runs     where user_id = target_user_id);
agents_deleted         := (delete from public.agents         where user_id = target_user_id);
```

Adds four new return columns: `agents_deleted`, `agent_runs_deleted`, `agent_findings_deleted`, `agent_state_deleted`.

Client-side updates in [src/lib/gdpr.functions.ts](../src/lib/gdpr.functions.ts):
- `EXPORT_TABLES` adds `agents`, `agent_runs`, `agent_findings`, `agent_state`.
- `RPC_COLUMN_TO_TABLE` adds the four `*_deleted` keys.

[tests/leak-suite/gdpr-roundtrip-realdb.test.ts](../tests/leak-suite/gdpr-roundtrip-realdb.test.ts) — extend `seedUser()` to insert one row per agent table in FK order (agents → agent_runs → agent_findings + agent_state). The per-user-table-coverage test picks the new tables up automatically.

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
begin
  return query
    select *
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
    for update skip locked;
end;
$$;
```

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
    for (const { item, score } of scored) {
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
    }

    // STEP 7 — notifications: SKIPPED in 3.0. Inbox surfaces findings; no push.

    status = "ok";
  } catch (e) {
    status = "failed";
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

export async function runAgentBatch() {
  const agents = await claimDueAgents(BATCH_LIMIT);
  for (const agent of agents) {
    try {
      await execute(agent);
    } catch (e) {
      console.error(`[agent ${agent.id}] crashed outside runner:`, e);
    }
  }
}
```

> **Cron framing** (per Sneha's edit during the 3.0 lock conversation): cron fires every 30 minutes. Each invocation claims a bounded batch of due agents. Individual agent cadence is still controlled by `cadence_hours`; the cron just decides how quickly due work is noticed.

The 30-min cron means an agent due 35 minutes ago waits at most another 25 minutes (worst case: cron fires immediately *before* the agent becomes due, agent becomes due 1 min after, next cron is 29 min away). Acceptable for v1.

---

## 11. Budget enforcement

Two layers:
1. **Per-agent budget** (the `AgentBudget` JSONB on the `agents` row).
2. **Unified CPAUD ceiling** (existing cross-feature daily $/user limit, currently $1.50/day).

```ts
// src/server/agents/budget.ts
import { supabaseAdmin } from "@/integrations/supabase/admin-client";
import type { AgentBudget } from "./types";

export type BudgetCheckResult = { ok: true } | { ok: false; reason: string };

const CPAUD_DAILY_CEILING_USD = 1.50;

export async function checkBudget(args: {
  userId: string;
  agentId: string;
  perAgentBudget: AgentBudget;
}): Promise<BudgetCheckResult> {
  // 1. Per-agent: count runs in the rolling 24h window.
  const { count: runsToday } = await supabaseAdmin()
    .from("agent_runs")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", args.agentId)
    .gte("started_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

  if ((runsToday ?? 0) >= args.perAgentBudget.maxRunsPerDay) {
    return { ok: false, reason: `per-agent maxRunsPerDay (${args.perAgentBudget.maxRunsPerDay}) reached` };
  }

  // 2. Unified CPAUD: sum cost across all user spend today.
  const { data: spend } = await supabaseAdmin()
    .from("cpaud_aggregate")  // existing materialised view, includes chat_messages.cost_usd + image-out + agent_runs.cost_usd
    .select("total_usd")
    .eq("user_id", args.userId)
    .eq("day", new Date().toISOString().slice(0, 10))
    .single();

  if ((spend?.total_usd ?? 0) >= CPAUD_DAILY_CEILING_USD) {
    return { ok: false, reason: `user CPAUD ceiling ($${CPAUD_DAILY_CEILING_USD}) reached` };
  }

  return { ok: true };
}

export async function recordCost(userId: string, costUsd: number, runId: string) {
  // No-op for now: `agent_runs.cost_usd` is the durable record, and the existing
  // CPAUD aggregation already pulls from agent_runs. This function is the seam
  // for any future double-entry bookkeeping that doesn't fit in agent_runs alone.
}
```

The locked free-tier numbers (docs/09 §7.5 — 8/day public floor + 12/day beta default):
- 3.0 reads the per-agent `maxRunsPerDay` from each `agents` row, not from a global config. The free-tier ceiling enforcement (sum across all agents owned by one user) is a **3.1 deliverable** — for 3.0, the only template is ResearchDigest with `maxRunsPerDay: 1` per default, so a user with even 10 active research agents tops out at 10 runs/day, comfortably under 12.

When 3.1 ships JobAgent + ShoppingAgent, the cross-agent daily-runs-per-user ceiling becomes load-bearing. Spec'd then, not now.

---

## 12. Lifecycle state machine

Use [docs/13](./13-spec-phase-3-agent-runtime.md) §4 as-is. State transitions implemented in `updateAgentLifecycleState()`. The eight states all valid in 3.0; the user-attention states (`needs_user_attention`, `inactive` with "Keep or archive?" prompt) need UI surfaces in Inbox (see §13).

---

## 13. ResearchDigest template

Per [docs/13](./13-spec-phase-3-agent-runtime.md) §7.1. Full implementation in `src/server/agents/templates/research-digest.ts`:

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

## 14. Inbox surface

`/workspace/inbox` route already exists ([src/routes/workspace.index.tsx](../src/routes/workspace.index.tsx) or its inbox tab — confirm during implementation). 3.0 extends it to render `agent_findings` rows alongside the existing Gmail-derived items.

New server function `src/lib/agents.functions.ts`:

```ts
export const fetchAgentFindings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabaseUser
      .from("agent_findings")
      .select("id, agent_id, title, summary, source_url, urgency, score, state, created_at, payload")
      .eq("user_id", context.userId)
      .in("state", ["new", "seen"])
      .order("created_at", { ascending: false })
      .limit(50);
    return { findings: data ?? [] };
  });

export const setFindingState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ id: z.string().uuid(), state: z.enum(["seen", "accepted", "dismissed", "snoozed", "archived"]) }))
  .handler(async ({ data, context }) => {
    await context.supabaseUser
      .from("agent_findings")
      .update({ state: data.state, acted_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("user_id", context.userId);
  });
```

UI: a new section in the inbox view titled "From your agents" (or similar), rendering each finding as a card with:
- Title (clickable, opens `source_url`)
- Summary (2-3 lines, truncated)
- "Accept" / "Dismiss" / "Snooze" actions → call `setFindingState`
- Tiny tag showing which agent surfaced it
- `urgent` findings get a visual badge (red dot or "urgent" pill)

Empty state: "No agent findings yet. Create your first agent in [Agents]." (Agents page is a 3.1 deliverable; for 3.0, the link can be a placeholder or hidden.)

**3.0 also needs ONE way to create a ResearchDigest agent** — without it the runner has nothing to run. Simplest: a hidden dev affordance behind a feature flag, or a single hard-coded "Create research agent" button in `/workspace/inbox` that pops a small form (topics + cadence). Implementation choice for the dev; doesn't need to be marketplace-quality.

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
  status: "ok" | "failed" | "budget_exceeded" | "cancelled" | "skipped";
  duration_ms: number;
  cost_usd: number;
  error_code: string | null;
};

export function logRun(entry: AgentRunLog): void {
  // Single structured log line. CF Workers logs are JSON-friendly.
  console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "agent_run", ...entry }));
}
```

Schema (per Sneha's spec):

```json
{
  "run_id": "...",
  "agent_id": "...",
  "user_id": "...",
  "agent_type": "...",
  "status": "success|error|skipped",
  "duration_ms": 1234,
  "cost_usd": 0.012,
  "error_code": null
}
```

(Implementation note: `status` uses `ok` / `failed` / `budget_exceeded` / `cancelled` / `skipped` to match the DB enum; "success" in the spec maps to "ok". Same shape, slightly different label.)

`agent_runs` table is the durable record. Logs are for live debugging via `wrangler tail`. No log-ingestion service needed for 3.0.

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

## 21. Open questions

None blocking. All locked decisions from docs/09 §9 and docs/13 §18 have been encoded. Any new questions that surface during implementation get filed against the runner code, not this spec.

---

## Appendix A — relevant locked decisions

For grep-ability when reading the code:

- **docs/09 §7.5 (LOCKED 2026-05-15):** Free-tier daily budget is 8/day public floor, 12/day beta default via remote config. Enforced via per-agent `maxRunsPerDay` summed across the user's agents — *cross-agent ceiling is a 3.1 deliverable*, not 3.0.
- **docs/13 §18.4 (LOCKED 2026-05-15):** Agent activity siloed in `agent_state` for 3.0–3.4. **No silent writes to trait sheet.** `agent_state` table has no FK to the trait sheet; promotion logic ships in 3.5.
- **docs/13 §18.5 (LOCKED 2026-05-15):** Serial scheduled runs in 3.0. User-triggered "run all" with parallel-3 + guardrails ships later.
- **docs/13 §18.6 (LOCKED 2026-05-15):** Generative-agent AST is a 3.4 concern. 3.0's per-agent `config` field is template-specific JSON validated by the template's `configSchema` — no AST machinery yet.

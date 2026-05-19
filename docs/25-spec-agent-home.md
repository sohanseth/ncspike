# docs/25 — Agent Home (persistent agent workspace)

**Status:** SPEC IN REVIEW — 2026-05-18 (Sneha)
**Owner:** Sneha
**Implementation PR:** TBD (next PR after this merge)
**Depends on:** docs/19 (briefing-first architecture), docs/20 (ResearchDigest v2 instance)
**Relates to:** docs/22 (Run Now — queued), docs/23 (Findings library / favourites — queued)

---

## Problem statement

PRs #26 + #27 shipped the briefing-first inbox and the prompt-specificity contract. The structure works; the prose is finally specific. But browser-verification (2026-05-18) revealed a deeper gap: even with concrete takeaways, the inbox still feels like a **decorated search-results page**. The product NC wants is a **standing personal agent that reports back over time**, not a document generator.

Two architecture corrections, in order:

1. **The unit of output was wrong.** PR #26 fixed this — briefing-first beats card-list.
2. **The unit of PRESENCE is wrong now.** A briefing is a one-shot artifact. The agent needs a HOME — a persistent surface where its understanding compounds. The inbox-of-briefings model treats each run as a disposable document; the user can't see the agent as an ongoing entity that has a STATE.

This spec fixes that by introducing the agent home.

> **The agent should have a home, not just a thread and not just a document.**
> The thread is the activity log. The living state is the current synthesis. Neither dominates alone.

---

## The product model (revised)

| Concept | Meaning |
|---|---|
| **Agent** | Ongoing watcher of a topic |
| **Run** | One observation cycle |
| **Message** | One report from a run (the briefing as a chronological entry) |
| **State** | The agent's accumulated understanding — always-current synthesis |
| **Branch** | Durable interest/topic structure (emerging sub-topics) — Phase 3 |
| **Source map** | Which sources have shown up, with usefulness signal |
| **Artifact** | Optional export (report, mind map, deck) generated FROM the home, never the primary surface — Phase 4 |

The user's mental model becomes "my agent has a home page; visit it to see where it is right now and what it's been doing." Not "I have an inbox of cards." Not "I have a chat with a bot."

---

## Two anchor primitives

Every run updates both:

1. **Activity log** — a new message in the agent's timeline (this run's briefing)
2. **Living state** — the agent's accumulated understanding, refreshed with what this run learned

The agent home page surfaces both. State at the top (where the agent IS right now). Timeline below (what it's been doing). Neither one alone is the product.

This is the correction to the earlier Agent-Messages-only framing: pure thread is good for chronology, weak for accumulated understanding. Pure living document is good for synthesis, weak for interaction and cadence. The home page IS the hybrid.

---

## The inbox transformation

### Before (today, post PR #26)
Inbox = flat list of finding cards or briefing-rendered blocks per agent. Every refresh = re-render of the same one-shot state. No sense of ongoing relationship.

### After (Phase 1)
Inbox = list of **agent home rows**. Each row is a status-like signal, not a content dump:

```
AI Safety
Updated today · 2 useful changes · 1 branch growing

Kids weekend activities
Updated yesterday · 4 new events · 2 good matches · 1 needs booking

Postgres extensions
No meaningful change · repeated sources only
```

Clicking opens the agent's home page. The inbox-level row is a glanceable status — not the artifact itself.

---

## The Agent Home page

Layout (top to bottom):

```
┌────────────────────────────────────────────────────────────┐
│  [Agent name]                              [• live status] │
│  [topics / cadence / last-updated meta]                    │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  LATEST BRIEF                                              │
│  ┌──────────────────────────────────────────────────┐      │
│  │ [v2 briefing render component — the most recent  │      │
│  │  successful run's briefing in full]              │      │
│  │ headline + synthesis + delta + takeaways +       │      │
│  │ readFirst + skip + nextSearchSuggestions         │      │
│  │ + sources <details>                              │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  LIVING STATE                                              │
│  ┌──────────────────────────────────────────────────┐      │
│  │ Source map: which domains have appeared, with    │      │
│  │ usefulness signal (kept / collapsed / skipped)   │      │
│  │                                                   │      │
│  │ [Phase 3]: emerging branches, themes             │      │
│  │ [Phase 2]: standing user preferences for         │      │
│  │            this agent                             │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  RUN TIMELINE                                              │
│  ┌──────────────────────────────────────────────────┐      │
│  │ ▸ Today    "Red teaming for LLM safety advances" │      │
│  │ ▸ Yesterday "Mostly introductory batch"          │      │
│  │ ▸ 16 May    "First check — defining the field"   │      │
│  │ … (collapsible per entry)                        │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ACTIONS / INSTRUCTIONS   [Phase 2 — deferred]             │
│  ┌──────────────────────────────────────────────────┐      │
│  │ "Track red-teaming separately"                   │      │
│  │ "Only show me expert or institutional sources"   │      │
│  │ [reply input]                                    │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  DERIVED ARTIFACTS   [Phase 4 — deferred]                  │
│  ┌──────────────────────────────────────────────────┐      │
│  │ Generate: report · mind map · deck               │      │
│  └──────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
```

### Section semantics

- **Latest brief**: the v2 briefing render component from PRs #26 + #27. Reused unchanged. Represents this run's report.
- **Living state**: the agent's accumulated understanding. Phase 1 = source map only. Phase 2 adds user preferences. Phase 3 adds themes + emerging branches.
- **Run timeline**: chronological list of past runs, each entry expandable to that run's briefing. Acts as the agent's activity log.
- **Actions / instructions**: deferred to Phase 2 (see below).
- **Derived artifacts**: deferred to Phase 4 (see below).

---

## Data model

### New table — `agent_messages`

The chronological record of agent reports. One row per successful agent run.

```sql
create table public.agent_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  agent_run_id    uuid references public.agent_runs(id) on delete set null,
  role            text not null check (role in ('agent', 'user', 'system')),
  message_type    text not null check (message_type in (
                    'run_briefing',
                    'user_instruction',
                    'system_status',
                    'derived_report'
                  )),
  body_json       jsonb,
  body_text       text,
  created_at      timestamptz not null default now()
);

create index agent_messages_thread_idx
  on public.agent_messages (user_id, agent_id, created_at desc);

alter table public.agent_messages enable row level security;
create policy agent_messages_owner_all on public.agent_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

**For Phase 1, only `role='agent'` + `message_type='run_briefing'` is used.** Other types are reserved for later phases.

### Body shape — `message_type='run_briefing'`

The body_json is the v2 briefing JSON (same shape as `agent_runs.briefing`, ResearchDigestBriefingV2). This is denormalized for thread queries but agent_runs.briefing remains the source of truth.

### Existing — `agent_runs.briefing` stays
Unchanged. Per-run synthesis still lives there. agent_messages.body_json is a denormalized copy for the threaded view. On run finalize, the runner inserts both.

### Living state — computed-on-read

The "living state" section is **derived**, not stored. Computed by aggregating agent_messages + agent_findings for the agent on read. Phase 1 only needs:

- **Source map** — group agent_findings by URL host. For each host: count, average score, fraction that were read-first picks across recent briefings, fraction collapsed-as-skip. Sort by total count + usefulness signal.

No new tables for living state in Phase 1. If query performance demands a denormalized cache later, that's a Phase 5 concern.

---

## Phased delivery

### Phase 1 (this spec's implementation PR scope)

Goal: ship the home-page hybrid. Inbox becomes agent-home list. Each agent has a home page with latest brief + run timeline + source map.

**In scope:**
- `agent_messages` table migration
- Runner inserts a `run_briefing` message on every successful run (1 line in finalize)
- Backfill: one-off migration script that inserts agent_messages for all existing v2 briefings (so existing data renders correctly)
- New serverFn: `getAgentHome(agentId)` → returns latest brief + recent messages + computed source map
- New route: `/workspace/agents/$agentId` (the home page) — keep `/workspace/inbox` as the home-list landing
- Inbox rewrite: list of agent-home rows with status-like signals
- Agent Home page render: latest brief (v2 render component) + timeline + source map

**Out of scope (deferred to Phases 2-4):**
- Reply / instruction input
- Branch detection
- Themes computed across runs
- Read/unread state
- Derived artifacts (report, mind map, deck, living document export)

### Phase 2 (deferred — separate spec)

- `message_type='user_instruction'` messages
- Reply UI on agent home (chat-style or form-style — TBD)
- Next run's briefing prompt includes recent user_instructions as adaptation context
- Some replies trigger config changes ("make this weekly")
- Read/unread state per message

### Phase 3 (deferred — separate spec)

- Branch detection: agent notices emerging sub-topics in its corpus + suggests spawning a sub-agent
- Themes computed and rendered in living state
- Source map usefulness scoring shows up explicitly
- Inbox row signals get richer ("1 branch growing")

### Phase 4 (deferred — separate spec)

- Derived artifacts: generate report / mind map / deck FROM the agent home
- Living document EXPORT (the NotebookLM-style artifact) — generated from accumulated state, not the primary surface
- Multi-format export options

**A living briefing/report is a derived artifact from the agent home, not the primary surface.** This rule is load-bearing — it keeps the product from drifting into documentware.

---

## Migration / backward compat

**Backfill needed.** Existing v2 briefings (PRs #26 + #27) and v1 briefings (PR #22-era) live in `agent_runs.briefing` but have no corresponding agent_messages row. The Phase 1 implementation PR includes a one-off backfill:

```sql
-- For each agent_runs row with non-null briefing,
-- INSERT one agent_messages row with role='agent',
-- message_type='run_briefing', body_json = the briefing.
insert into public.agent_messages (
  user_id, agent_id, agent_run_id, role, message_type, body_json, created_at
)
select
  user_id, agent_id, id, 'agent', 'run_briefing', briefing, started_at
from public.agent_runs
where briefing is not null
on conflict do nothing;
```

Run once at deploy time. After backfill, the home-page timeline renders all historical briefings as messages. The legacy flat-render path (PR #24) can be retired in Phase 1's PR or kept as a safety net.

**Pre-PR-22 NULL briefings** (raw findings only) stay queryable via agent_findings; they don't get backfilled as messages but appear in the source map's running totals.

---

## Inbox row content (the status-line)

Each agent's row in the home-list shows a short status sentence derived from the latest run. Phase 1 implementation:

```
[agent name]
Updated [relative-time] · [items_kept signal] · [optional branch/source signal]
```

Examples (Phase 1):
- `Updated today · 2 useful changes · sources mostly familiar`
- `Updated 2h ago · 5 new findings · 1 high-relevance pick`
- `Updated yesterday · no new findings worth keeping`
- `Updated 3 days ago · check overdue` (when next-due timestamp passed without a run)

The exact copy is a Phase 1 implementation detail; what's locked in this spec is:
- One sentence
- Glanceable
- NOT a content dump
- Time-relative (no absolute timestamps in the row)
- Reflects accumulated state when meaningful, not just count-of-findings

Phase 3 adds richer signals ("1 branch growing", "2 sources stopped appearing this week").

---

## Implementation surface (Phase 1 — next code PR is bounded to these files)

| File | Change |
|---|---|
| `supabase/migrations/[date]_agent_messages.sql` | New table + RLS + index + backfill INSERT |
| `src/server/agents/runner.ts` | One INSERT into agent_messages on successful run finalize |
| `src/lib/agent-home.functions.ts` + `.server.ts` | New `getAgentHome(agentId)` serverFn returning brief + timeline + source map |
| `src/lib/findings.functions.ts` + `.server.ts` | New `listAgentHomes()` serverFn for the inbox row list; existing listFindings stays as a sub-query inside the home page |
| `src/routes/workspace.inbox.tsx` | Rewrite as agent-home list (rows with status signals) |
| `src/routes/workspace.agents.$agentId.tsx` | New — the home page |
| `tests/agent-home/*` | New test suite |
| `tests/findings/list.test.ts` | Extended for new listAgentHomes coverage |
| `tests/leak-suite/phase30-research-digest.test.ts` | Extended for runner's message-insert |

Anything outside this surface is scope drift. Reviewer should bounce.

---

## Non-goals for Phase 1

- Reply UI / user_instruction messages (Phase 2)
- Branch detection (Phase 3)
- Themes computed across messages (Phase 3)
- Derived artifacts: reports / mind maps / decks / living document export (Phase 4)
- Read/unread state (Phase 2)
- Notifications (later, separate spec)
- The chat thread metaphor — explicitly avoided. The home page is the primary surface; the timeline section is just one of its sections, not the whole thing.

---

## Open questions

1. **Route shape.** `/workspace/agents/$agentId` (the home page) coexists with `/workspace/inbox` (the home-list). Should the inbox be renamed (e.g. `/workspace/agents` or `/workspace/home`)? Spec position: keep `/workspace/inbox` for back-compat with bookmarks; the inbox just renders different content now.

2. **Backfill timing.** Run at migration time, or lazy on first read? Spec position: at migration time. The backfill is idempotent (ON CONFLICT DO NOTHING) and bounded by existing v2 briefings.

3. **Timeline sort order.** Newest first (default chat convention) or oldest first (lets the user follow the agent's evolution)? Spec position: newest first by default, with a "Show evolution from start" toggle as a Phase 2 nicety.

4. **Source map "usefulness signal".** Phase 1 keeps this simple — just count + fraction-kept. Phase 3 adds richer signal. Spec position: don't over-design Phase 1.

5. **What about agents with no runs yet?** Empty state for both inbox row and home page. Phase 1 position: "Waiting for first run — next check in [time]". No special UI needed.

6. **Living state when no v2 briefings exist for an agent.** Old v1-only agents. Phase 1 position: source map still works (computed from agent_findings); timeline shows v1 briefings via legacy render or backfilled messages. The home page works regardless of which briefing version the agent has produced.

---

## Acceptance criteria for Phase 1 implementation PR

- [ ] `agent_messages` table migration applies cleanly
- [ ] Backfill query inserts one message per existing v2 (and optionally v1) briefing
- [ ] Runner inserts one `run_briefing` message per successful run
- [ ] `/workspace/inbox` renders as the agent-home list (one row per non-archived agent)
- [ ] Each inbox row shows agent name + status line + relative timestamp
- [ ] Clicking an inbox row navigates to `/workspace/agents/$id`
- [ ] Agent Home page renders: latest brief (v2 component) + timeline + source map
- [ ] Timeline shows last N messages with expandable detail
- [ ] Source map shows top hosts with count + fraction-kept
- [ ] tsc clean on touched files
- [ ] Tests for runner-side message insert, getAgentHome serverFn, source map computation
- [ ] One real run via `scripts/run-one-agent.ts` produces a new message; opening the home page shows it

Operational verification gate: after the implementation PR ships, kick the safety agent's force-run, open `/workspace/agents/d0ce1f55-...`, and confirm:
- Latest brief renders at top (the existing v2 briefing component)
- Timeline shows the prior 2-3 runs as collapsible entries
- Source map lists Microsoft, Palo Alto, CSET, etc. with counts

If that reads as "the agent's home page" rather than "another document NotebookLM-style," Phase 1 is done.

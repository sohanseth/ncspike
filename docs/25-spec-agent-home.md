# docs/25 — Agent Home (persistent agent workspace)

**Status:** SPEC LOCKED — 2026-05-18 (Sneha)
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
2. **Latest briefing + sources observed** — the agent's most recent report and the supporting evidence map

The agent home page surfaces both. Latest briefing at the top (what the agent just reported). Timeline below (what it's been doing). Neither one alone is the product.

### Important: Latest briefing ≠ accumulated state

Phase 1 does NOT have "accumulated state" in the strong sense. Calling the top section "Latest State" would over-promise — the LLM hasn't synthesized across multiple runs yet. What Phase 1 surfaces is **the most recent run's briefing** + **a descriptive count of sources that have appeared**.

True accumulated state — themes that have emerged over many runs, durable branches, agent-level synthesis across the corpus — is Phase 3. The Phase 1 home uses honest names:

- **"Latest briefing"** — the most recent run's report. Same render component as PR #26.
- **"Sources observed"** — descriptive count of which domains have shown up. No usefulness scoring, no semantic clustering. Just "Microsoft: 4, Palo Alto: 2, CSET: 1." Hidden if empty.
- **"Activity timeline"** — chronological list of past runs. The agent's work log.

We can graduate the top-section label to "Current state" or "Current read" in Phase 3 once cross-run synthesis is real.

This is the correction to the earlier Agent-Messages-only framing: pure thread is good for chronology, weak for accumulated understanding. Pure living document is good for synthesis, weak for interaction and cadence. The home page IS the hybrid — but it doesn't pretend the accumulated synthesis exists yet.

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

Phase 1 layout (top to bottom):

```
┌────────────────────────────────────────────────────────────┐
│  HEADER                                                    │
│  [Agent name]                                              │
│  Topics · Cadence · Status · Last run: [relative time]     │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  LATEST BRIEFING                                           │
│  ┌──────────────────────────────────────────────────┐      │
│  │ [v2 briefing render component — the most recent  │      │
│  │  successful run's briefing in full]              │      │
│  │ headline + synthesis + delta + takeaways +       │      │
│  │ readFirst + skip + nextSearchSuggestions         │      │
│  │ + sources <details>                              │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  SOURCES OBSERVED  (hidden if empty)                       │
│  ┌──────────────────────────────────────────────────┐      │
│  │ Microsoft: 4                                      │      │
│  │ Palo Alto Networks: 2                            │      │
│  │ CSET: 1                                           │      │
│  │ Varonis: 1                                        │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ACTIVITY TIMELINE  (newest first; latest expanded)        │
│  ┌──────────────────────────────────────────────────┐      │
│  │ ▼ Today, 14:22  [ok]                              │      │
│  │   "Red teaming for LLM safety advances"          │      │
│  │   2 useful changes · 7 findings                  │      │
│  │   [expandable: full run briefing + findings]      │      │
│  │                                                   │      │
│  │ ▸ Yesterday, 09:11  [ok]                          │      │
│  │   "Mostly introductory batch"                    │      │
│  │   1 useful change · 5 findings                   │      │
│  │                                                   │      │
│  │ ▸ 16 May, 23:17  [ok]                             │      │
│  │   "First check — defining the field"             │      │
│  │   5 useful findings                              │      │
│  └──────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘

(Phase 2 will add an Actions/Instructions section between Timeline
and the page bottom. Phase 4 will add a Derived Artifacts section
at the bottom. Neither is rendered in Phase 1 — no placeholder UI.)
```

### Section semantics

- **Header**: agent name, topics summary, cadence, lifecycle status, last-run-time as a relative timestamp. The "alive" signals live here. Don't make this look like a static document header.
- **Latest briefing**: the v2 briefing render component from PRs #26 + #27. Reused unchanged. Represents this run's report.
- **Sources observed**: simple host:count pairs. Hidden entirely if empty. NO usefulness scoring, NO confidence indicators, NO clustering — Phase 1 is descriptive only. Renamed from earlier draft's "Living state" / "Source map" for honesty.
- **Activity timeline**: chronological list of past runs, **newest first**, **latest expanded by default, older runs collapsed**. Initial display: 10 most recent. No pagination in Phase 1. Each row shows run status badge + timestamp + the briefing's headline (or fallback copy per §11). Expanding shows the full briefing for that run.
- **Actions / instructions**: NOT rendered in Phase 1 (no placeholder UI either — no "Reply" affordance, no "Coming soon" copy).
- **Derived artifacts**: NOT rendered in Phase 1. No "Generate report" button. No links to mind-maps/decks/etc.

### Phase 1 must NOT do

To prevent the surface from drifting into Phase 2/3/4 territory before those land:

- **No reply input.** Phase 2 only.
- **No "branches" UI element**, even as a placeholder. Phase 3 only.
- **No "themes" derived from cross-run synthesis.** Phase 3 only.
- **No "Generate report" / "Generate mind map" buttons.** Phase 4 only.
- **No "accumulated state" or "current read" labels.** Latest briefing isn't state.
- **No "Run Now" button.** Separate spec (docs/22).
- **No notifications/unread state.** Phase 2 nicety.

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

**Backfill is DEFERRED (Q2 locked).** Phase 1 does NOT run a data-migration job to populate `agent_messages` from pre-existing `agent_runs.briefing` rows. Historical runs render directly from `agent_runs.briefing` via the fallback chain in §11.

What the migration PR does include:
- Create `agent_messages` table + index + RLS policy
- Runner-side INSERT on successful run finalize (one new line)

What it does NOT include:
- Backfill SQL for old runs
- Schema changes to `agent_runs`, `agent_findings`, or `agents`
- Any cleanup of pre-existing briefing data

**Why defer:** the backfill is tempting but turns a narrow UI PR into a data-correctness migration. The home page works just as well by reading directly from `agent_runs.briefing` for the latest-briefing section and computing the timeline from `agent_runs` rows. The `agent_messages` table starts populating with new runs only; if the Phase 2/3/4 work actually needs the denormalized message view for legacy data, a backfill can land then.

Legacy renderers (PR #24's flat path, plus the new degraded-mode entries from §11) coexist indefinitely until the sunset condition from docs/19 §6 is met.

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

## Resolved decisions (was: open questions) — LOCKED 2026-05-18

### Q1 — Route shape
**`/workspace/agents/$agentId` (plural).** Matches the collection convention; future nested routes stay natural:

```
/workspace/agents                       — list (the home-list)
/workspace/agents/$agentId              — agent home (this spec)
/workspace/agents/$agentId/runs/$runId  — single-run detail (future, if needed)
```

`/workspace/inbox` stays as a bookmark-compat alias that redirects to `/workspace/agents`. Both URLs render the home-list.

### Q2 — Backfill timing
**Defer the data backfill.** Phase 1 should not become a data-correctness migration. Old runs render in **degraded mode** using whatever exists in `agent_runs.briefing` (see Q6's fallback order). Backfill only after the Agent Home UI proves the shape is right — could be a Phase 1.5 or Phase 2 chore.

### Q3 — Timeline sort order
**Newest first.** Agent Home is operational, not narrative. The user wants to know what the agent just saw, what changed, and whether the agent is alive. Oldest-first would be better for "story / report reading" but that's not the Phase 1 job. The latest run is expanded by default; older runs collapsed. "View full history" / day-grouping is a Phase 2 nicety, not Phase 1.

### Q4 — Sources-observed signal richness
**Simple label + count only.** No confidence scores, no semantic clustering, no provider weighting, no source-health system. Render as flat key:value list:

```
Microsoft: 4
Palo Alto: 2
CSET: 1
```

Hidden entirely if empty. Phase 1 answers "where did this agent's briefings come from?" — NOT "how should I rank the evidence?" Phase 3 can add usefulness signal once accumulated state is real.

### Q5 — Empty state for agents with no runs yet
**Calm operational copy. No CTA.** Suggested wording:

> "No runs yet.
>
> This agent has been created but has not completed an observation cycle. Once it runs, its latest briefing and activity timeline will appear here."

Don't make it sound broken. Don't add a "Run Now" button (separate spec). Don't bloat with marketing copy.

### Q6 — Legacy v1 / NULL-briefing agents
**Render the shell anyway. Degraded gracefully. No fake state.**

The page renders for every non-archived agent, regardless of briefing version. Sections degrade independently:

- **Latest briefing section** uses a fallback render chain (see §11 below).
- **Sources observed** still works — it's computed from agent_findings regardless of briefing version.
- **Activity timeline** shows past runs with whatever each run has; v1 briefings render via PR #24's legacy flat path; NULL-briefing runs show a "Briefing unavailable for this run" entry with the run's status + timestamp + findings count.

The page never shows fabricated synthesis derived from findings inside the UI. If we don't have a briefing, we say so.

---

## §11 — Data contract + fallback rendering

### What `agent_runs.briefing` can hold

| Briefing payload | Source | Render path |
|---|---|---|
| `version: 2, kind: 'research'` | PRs #26 + #27 | v2 render component (Phase 1's primary path) |
| `version: 2, kind: 'research', failureClass: <set>` | v2 failure briefing | v2 render component in muted styling (existing PR #26 behaviour) |
| `version: 1` | PR #22-era | PR #24's legacy flat render (existing) |
| `NULL` | Pre-PR-22 OR mid-flight crash | New degraded entry — see fallback chain below |

### Latest-briefing fallback chain (top-of-page)

The "Latest briefing" section uses the FIRST one that works:

1. **v2 briefing** (`briefing.version === 2` from the latest successful run) → v2 render component
2. **v1 briefing** → PR #24's legacy flat render component
3. **No briefing, but the run completed** (`status='ok'` and `briefing IS NULL`) → degraded entry:
   > "No briefing available for the latest run.
   > Completed at [timestamp] · [items_kept count] findings persisted."
4. **No briefing, run failed** (`status='failed'`) → degraded entry:
   > "Latest run did not complete.
   > Failed at [timestamp] · Reason: [scrubbed error class]."
5. **No runs at all** → empty state (Q5).

The renderer dispatches on what's present, not on what's missing. No fabricated synthesis.

### Run-status surface

`agent_runs.status` distinguishes the relevant states already:

| Status | Meaning | Header / timeline rendering |
|---|---|---|
| `running` | Insert happened, finalize hasn't | Show "Running…" in header. Timeline entry shows pulse indicator. |
| `ok` | Finalize succeeded, briefing may or may not be populated | Standard render path |
| `failed` | Runner caught a throw | Show failure copy in degraded mode (chain step 4 above) |
| `timeout` | Stuck-run sweep finalised it | Same as `failed` |
| `skipped_budget_exceeded` | Budget pre-flight blocked it | Header: "Skipped this cycle (budget limit)." Timeline shows the row but no briefing. |

Phase 1 must render all five status values without crashing. No new status values are introduced.

---

## §12 — Additional product-semantic locks

These came out of the 2026-05-18 self-critique pass:

### What the top section is CALLED
**"Latest briefing."** NOT "Latest State," NOT "Current state," NOT "Current read." Naming honesty: it's the most recent run's briefing, not accumulated synthesis. Graduate to a state-flavoured name only when Phase 3 ships actual cross-run synthesis.

### What makes an Agent Home "healthy"
Three minimum signals in the header:
1. Last run timestamp (relative, e.g. "Updated 2h ago")
2. Last run status (ok / failed / running / skipped)
3. Whether the latest run produced a briefing (yes/no/degraded)

Without these, the page looks like a static document. The agent must feel alive.

### Finding vs. timeline entry
**These are different objects. Do not visually merge them.**

- A **finding** is evidence: title + URL + snippet + score, persisted to `agent_findings`. It's content the agent extracted from the world.
- A **timeline entry** is the agent's work/action record: "I ran at time X with status Y, here's the briefing." Persisted to `agent_runs` (and Phase 1 also to `agent_messages`).

In the home page: findings appear as expandable supporting evidence INSIDE the latest briefing's `<details>` block and inside each expanded timeline entry. They do NOT appear as standalone top-level rows.

---

## §13 — UI behaviour locks

- **Timeline initial display:** latest 10 runs. No pagination in Phase 1. "Show older" is a Phase 2 nicety if needed.
- **Default expansion:** latest run expanded, older runs collapsed.
- **Section order:** Header → Latest briefing → Sources observed → Activity timeline.
- **Section hide rules:** Sources observed is hidden when empty. Timeline shows even if empty (with the Q5 empty-state copy).
- **Status badges:** ok / failed / running / timeout / skipped — same five values used everywhere on the page.

---

## §14 — Scope guards (the "boring PR" rule)

> The concept is ambitious. The implementation should be disciplined, almost plain.
> The win is not fancy UI; the win is proving an agent deserves a persistent home.

If the implementation PR ships any of the following, the PR scope drifted and review should bounce:

- Branches UI (placeholder OR active) — Phase 3
- Themes UI — Phase 3
- Reply / instruction input — Phase 2
- "Generate report / mind map / deck" buttons — Phase 4
- Backfill SQL beyond the inserts captured in the existing migration
- Schema migrations to `agent_findings`, `agent_runs`, or `agents`
- New tables beyond `agent_messages`
- "Run Now" button — docs/22
- Per-run shareable URL — Phase 2 nicety
- Notification surface — separate spec
- Cross-agent synthesis — Phase 3 at earliest

---

## Acceptance criteria for Phase 1 implementation PR

Schema + runtime
- [ ] `agent_messages` table migration applies cleanly (table + index + RLS only — no backfill)
- [ ] Runner inserts one `run_briefing` message per successful run (one new line in finalize)

Inbox row list (`/workspace/agents`)
- [ ] Renders one row per non-archived agent
- [ ] Each row: agent name + relative timestamp + glanceable status sentence (per §10 in the inbox-row spec)
- [ ] `/workspace/inbox` redirects to `/workspace/agents` for bookmark compat
- [ ] Empty inbox (no agents) shows the existing "create your first agent" copy unchanged

Agent Home page (`/workspace/agents/$agentId`)
- [ ] Header shows: agent name + topics + cadence + last-run-status + relative last-run-time
- [ ] **Top section is labelled "Latest briefing"** (NOT "Latest State" or "Current state")
- [ ] Latest briefing renders the v2 component for v2 briefings; PR #24 legacy flat path for v1; degraded entry per §11 for NULL/failure/skipped
- [ ] Sources observed section renders host:count pairs, hidden if empty
- [ ] Activity timeline shows latest 10 runs newest-first; latest expanded; older collapsed
- [ ] Status badges render for all 5 status values (ok / failed / running / timeout / skipped) without crashing
- [ ] Empty state copy (no runs yet) matches §Q5 verbatim or close
- [ ] Phase 1 must-not-do rules from §"Phase 1 must NOT do" hold — no reply input, no branches, no themes, no Generate-X buttons, no Run-Now button

Non-functional
- [ ] tsc clean on touched files
- [ ] Tests for: runner message insert, agent-home serverFn shape, fallback chain for v1/NULL/failure, sources-observed aggregation, status-badge rendering for all 5 status values
- [ ] Bounded to the implementation surface in §"Implementation surface" — review bounces wider scope

Operational verification gate
After deploy, kick the safety agent's force-run and open `/workspace/agents/d0ce1f55-...`:
- Header shows "Updated [seconds] ago · ok" with the actual relative time
- "Latest briefing" renders the v2 component
- "Sources observed" lists the actual hosts (Microsoft, Palo Alto, CSET, etc.) with counts
- "Activity timeline" shows the prior runs as collapsible entries, newest first
- Older runs render via degraded mode or v1 legacy path without crashing the page

If it reads as **"the agent's home page"** rather than "another NotebookLM document," Phase 1 ships.

# docs/25 — Agent Home (Phase 1: read-only IA + persistence)

**Status:** SPEC LOCKED — 2026-05-19 (Sneha)
**Owner:** Sneha
**Implementation PR:** TBD (next PR after merge)
**Depends on:** docs/19 (briefing-first architecture), docs/20 (ResearchDigest v2)
**Roadmap (beyond Phase 1):** `docs/agent-home-roadmap.md` (paired supporting doc)
**Relates to:** docs/22 (Run Now — queued), docs/26 (Personalized briefing v3 — queued; THE content-quality track)

---

## Important framing — what this spec IS and ISN'T

Agent Home Phase 1 fixes the **surface** problem: agents feel disposable because each run is wrapped in a one-shot card view. After Phase 1, every active agent has a persistent home page where the latest report, the activity timeline, and source coverage are all visible.

**It does NOT fix the INTELLIGENCE problem.** Briefing quality — synthesis depth, personalization, trend memory, "why this matters to me" — is the parallel track owned by **docs/26 (Personalized briefing v3)**. Do not ship Phase 1 framed as "this improves what the agent says." It improves *where the agent lives*.

This split is deliberate:
- **Track A (this spec)**: the container — persistence, timeline, status, source visibility
- **Track B (docs/26)**: the content — broker integration, what-changed framing, why-this-matters

Phase 1 is Track A only. If a reviewer is reading the implementation PR and expects content quality to improve, the spec or the PR copy is misleading them. Fix the copy.

---

## 1. Goal

Give every active agent a persistent home page at `/workspace/agents/$agentId` that surfaces, in this order:

1. **Header** with agent identity + alive signals
2. **Latest briefing** (existing v2 render component, unchanged)
3. **Source coverage** (10-run aggregate over `agent_findings`)
4. **Activity timeline** (last 10 runs, newest first)

The page reads from existing tables. No new tables. No new writes other than via existing runner paths.

---

## 2. Non-goals (Phase 1)

- No new tables (the `agent_messages` table from earlier drafts is **deferred to Phase 2**)
- No reply / instruction input
- No "themes" or "branches" or "topics" UI (Phase 3)
- No Generate-X buttons (report, mind map, deck — Phase 4)
- No notifications, share URLs, read/unread state
- No improvements to briefing content or synthesis (that's **docs/26 / Track B**)
- No "Run Now" trigger (docs/22)
- No backfill SQL or schema migrations

---

## 3. Route

| Path | Behaviour |
|---|---|
| `/workspace/agents/$agentId` | The agent home page (this spec's primary surface) |
| `/workspace/agents` | Agent list — the home-list (restyled inbox content) |
| `/workspace/inbox` | Redirect to `/workspace/agents` for bookmark compat |

Singular IDs go after the plural collection root. Future nested routes stay natural (`/workspace/agents/$agentId/runs/$runId` if ever needed).

---

## 4. Data sources

**Read-only over existing tables.** No writes. No new columns.

| Section | Source |
|---|---|
| Header (name, topics, cadence) | `agents` |
| Header (last run time + status) | `agent_runs` newest by `agent_id` |
| Latest briefing | `agent_runs.briefing` newest where `status IN ('ok','partial_success')` AND `briefing IS NOT NULL` |
| Source coverage | `agent_findings` filtered to latest 10 runs — see §6 |
| Activity timeline | `agent_runs` latest 10 by `started_at` |

The implementation may add one new server function (e.g. `getAgentHome(agentId)`) that returns this aggregate in a single round-trip. It MUST NOT add columns, tables, RLS policies, or RPCs.

---

## 5. Page layout

```
┌────────────────────────────────────────────────────────────┐
│  HEADER                                                    │
│  [Agent name]                                              │
│  Topics · Cadence · Status · Last run: [relative time]     │
├────────────────────────────────────────────────────────────┤
│  LATEST BRIEFING                                           │
│  [v2 briefing render component — reused unchanged]         │
│  (falls back to degraded copy per §7 if not available)     │
├────────────────────────────────────────────────────────────┤
│  SOURCE COVERAGE  (hidden if empty)                        │
│  Microsoft: 4                                              │
│  Palo Alto Networks: 2                                     │
│  CSET: 1                                                   │
├────────────────────────────────────────────────────────────┤
│  ACTIVITY TIMELINE  (newest first; latest expanded)        │
│  ▼ Today, 14:22  [ok]                                       │
│    "Red teaming for LLM safety advances"                   │
│    [expandable: full briefing for that run]                 │
│  ▸ Yesterday, 09:11  [ok]                                   │
│  ▸ 16 May, 23:17  [ok]                                      │
└────────────────────────────────────────────────────────────┘
```

### Section semantics

- **Header**: surfaces "is this agent alive" signals (last run time as relative timestamp, status badge, briefing-produced-y/n implicit via the next section). Without these the page reads as a static document.
- **Latest briefing**: the v2 component from PR #26. Reused, NOT modified. Top section is labelled exactly **"Latest briefing"** — not "Latest State," not "Current state."
- **Source coverage**: descriptive host:count list. See §6 for the locked rules. Hidden entirely when empty.
- **Activity timeline**: chronological run list. See §8 status-taxonomy for which statuses appear and how.

---

## 6. Source coverage — locked rules

Sneha review 2026-05-19. Implementation deviation from these = scope drift:

- **Scope**: latest 10 runs for this agent (by `agent_runs.started_at` desc, then `agent_findings` joined on `agent_run_id`)
- **Include**: findings with `score >= agent.config.minScore` (the existing keep threshold)
- **Group by**: normalized host of `source_url` (lowercase, trailing slash stripped, no `www.` prefix)
- **Sort**: count desc, then alphabetical
- **Cap**: top 8 hosts
- **Empty**: hide the entire section
- **Label**: "Source coverage" (not "Sources observed," not "Evidence map," not "Source map")
- **Format**: flat `Host: count` lines, one per line

If implementation finds these rules infeasible within the bounded files, **cut the section entirely** rather than ship a vague version. A vague source map is worse than no source map.

---

## 7. Empty / degraded states

### Agent has no runs yet
Render the shell. Header shows "No runs yet." Latest briefing section shows:

> No runs yet.
>
> This agent has been created but hasn't completed an observation cycle. Once it runs, its latest briefing and activity timeline will appear here.

Source coverage hidden. Timeline shows "No runs yet" placeholder.

### Latest run exists but `briefing IS NULL`
Header shows last run time + status. Latest briefing section shows:

> No briefing available for the latest run.
> Completed at [timestamp] · [items_kept count] findings persisted.

Source coverage still computed from `agent_findings` (works regardless of briefing). Timeline still works.

### Latest run failed (`status='failed'` or `'timeout'`)
Header surfaces the failure status badge clearly. Latest briefing section shows:

> Latest run did not complete.
> [Status badge] at [timestamp] · Reason: [scrubbed error class].

The previous successful briefing — if any — is NOT auto-promoted to the top. The user sees that the latest attempt didn't work. To find the last successful briefing they expand the corresponding timeline entry.

### Latest run skipped (`status='skipped_budget_exceeded'`)
Header shows "Skipped this cycle (budget cap)." Latest briefing section blank/hidden. Timeline shows the skip row.

---

## 8. Status taxonomy — locked

Five terminal/in-flight `agent_runs.status` values. Phase 1 must render all of them without crashing.

| Status | Updates Latest Briefing? | Appears in Activity Timeline? | Header treatment |
|---|---|---|---|
| `ok` + briefing populated | ✅ yes | ✅ yes | "Updated [rel-time] · ok" |
| `ok` + briefing NULL | ❌ no (show degraded latest §7) | ✅ yes | "Updated [rel-time] · ok · no briefing" |
| `partial_success` + briefing populated | ✅ yes | ✅ yes | Same as `ok` |
| `failed` | ❌ no | ✅ yes | "Last attempt failed [rel-time]" |
| `timeout` | ❌ no | ✅ yes | Same as `failed` |
| `skipped_budget_exceeded` | ❌ no | ✅ yes | "Skipped — budget cap [rel-time]" |
| `running` (in-flight) | ❌ no (yet) | ✅ yes (with pulse) | "Running now…" |

**Load-bearing product rule (Sneha review 2026-05-19):**

> A terminal run can appear in the Activity Timeline WITHOUT updating Latest Briefing.

This separates "what the agent attempted" from "what the agent successfully reported." Failed/timeout/skipped runs are visible (you can see the agent is alive) without polluting the latest briefing surface.

---

## 9. Acceptance criteria

### Schema + runtime
- [ ] No new tables, columns, RLS policies, or RPCs
- [ ] No new runner writes; the existing runner is unchanged
- [ ] Exactly one new server function (`getAgentHome(agentId)`) that reads existing data

### Route + redirect
- [ ] `/workspace/agents/$agentId` renders the home page
- [ ] `/workspace/agents` renders the agent list with restyled rows (status-line content per §10 below)
- [ ] `/workspace/inbox` redirects (or aliases) to `/workspace/agents`

### Page rendering
- [ ] Header shows agent name + topics + cadence + last-run-status + relative last-run-time
- [ ] Top section is labelled exactly **"Latest briefing"** (asserted by test — strings must match)
- [ ] Latest briefing renders v2 component for v2 briefings; PR #24 legacy flat path for v1; degraded copy per §7 otherwise
- [ ] Source coverage renders per §6 rules; hidden when empty
- [ ] Timeline shows latest 10 runs, newest first, latest expanded, older collapsed
- [ ] All 6 status values from §8 render without crashing

### Accessibility (minimum)
- [ ] Status badges include readable text label, NOT color alone (e.g. "Failed" not just a red dot)
- [ ] Timeline expand/collapse controls reachable via keyboard (`<details>` element or equivalent)
- [ ] Empty / degraded states are plain text, NOT icon-only

### Mobile (minimum)
- [ ] Layout readable on 375px width without horizontal scroll
- [ ] All four page sections render at mobile width

### Non-functional
- [ ] tsc clean on touched files
- [ ] Tests for: getAgentHome shape, source-coverage aggregation rules, fallback chain across §7 states, all 6 status values from §8

### Operational verification gate
After deploy, open any agent with at least one completed run at `/workspace/agents/<agentId>`. Confirm:
- Header shows the relative timestamp and status badge
- Latest briefing renders the v2 component (or degraded copy if the agent only has v1 / NULL briefings)
- Source coverage either renders the host:count list or is hidden
- Timeline shows the recent runs with latest expanded

If the page reads as "the agent's home" — alive, persistent, inspectable — Phase 1 ships.

---

## 10. Agent list row status line

When the inbox renders the agent list (`/workspace/agents`), each row shows:

```
[Agent name]
[relative-time] · [status] · [optional short signal]
```

Phase 1 examples:
- `Updated today · ok · 2 new findings`
- `Updated 2h ago · ok · no briefing yet`
- `Updated yesterday · failed`
- `Updated 3 days ago · check overdue`
- `No runs yet`

Rules:
- ONE short line
- Relative time, never absolute
- Status word always visible (no color-only)
- Phase 1 does NOT include "themes," "branches," or "compounding insight" indicators — those are Phase 3

---

## 11. Explicitly deferred (not Phase 1)

All of these go into the next-spec queue, NOT this implementation PR:

| Item | Phase | Spec |
|---|---|---|
| `agent_messages` table + writes | Phase 2 | (in roadmap) |
| User instructions / reply input | Phase 2 | (in roadmap) |
| Manual user-created threads | Phase 2 | (in roadmap) |
| Detected durable themes | Phase 3 | (in roadmap) |
| Source coverage usefulness scoring | Phase 3 | (in roadmap) |
| Derived artifacts (report, mind map, deck) | Phase 4 | (in roadmap) |
| Living document export | Phase 4 | (in roadmap) |
| Content-quality / personalization | **Track B** | **docs/26** |
| Run Now trigger | parallel | docs/22 |

> **The agent should have a home, not just a thread and not just a document.** The home page is the container. Better content is a separate track. Don't conflate.

---

## Appendix: scope-drift checklist for the implementation PR reviewer

The PR ships only if NONE of these are present. If any are: bounce.

- [ ] No new tables — including `agent_messages`
- [ ] No reply / instruction input UI
- [ ] No "Generate report/mind map/deck" buttons
- [ ] No themes/branches UI (placeholder or active)
- [ ] No "Run Now" button
- [ ] No notifications / share URLs / read-unread state
- [ ] No changes to the briefing prompt (Track B)
- [ ] No backfill SQL
- [ ] No new runner writes
- [ ] No agent_findings or agent_runs schema changes
- [ ] No accessibility-only-via-color
- [ ] No desktop-only layout
- [ ] Top section is labelled "Latest briefing," not "Latest State"
- [ ] Source coverage either follows §6 rules exactly or is omitted entirely

If all pass: ship it. Track B (docs/26) follows immediately.

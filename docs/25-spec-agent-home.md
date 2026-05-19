# docs/25 — Agent Home: prose briefing + visual differentiators (next PR)

**Status:** SPEC LOCKED — 2026-05-19 (Sneha, revised scope)
**Owner:** Sneha
**Implementation PR:** TBD (next code PR after merge)
**Depends on:** docs/19 (briefing-first architecture), docs/20 (ResearchDigest template — gets v3 update inside this spec)
**Roadmap (beyond this PR):** `docs/agent-home-roadmap.md`
**Relates to:** docs/22 (Run Now — queued, separate), mind-map follow-up PR (queued)

---

## Important framing — what changed since yesterday's lock

The earlier docs/25 framed Phase 1 as **read-only IA wrapper only** (Track A) and deferred all content-quality work to docs/26 (Track B). After review (Sneha 2026-05-19), that split is **retired**. The wrapper alone delivers none of the five user-stated needs:

> "ChatGPT-style prose, how the information connects to user context, mind map to easily memorise, changing landscape highlighted in a different colour, important stuff to keep in mind."

Shipping just the wrapper would leave the SAME bland content inside a new page — exactly the failure mode of every prior fix. So Track A and Track B collapse: one PR ships both the home page surface AND the new content shape.

**Mind map is split off into its own follow-up PR** — it deserves its own design treatment and would either land badly here or push this PR too wide. Features 1-7 (everything except mind map) ship together.

---

## 1. Goal

Make the agents inbox stop feeling like Google results, decorated cards, or a NotebookLM document. After this PR, opening any agent should feel like a knowledgeable peer reporting back, in prose, with the things they think the user should remember, marked clearly where the world has shifted.

Cognitive-load reduction is the load-bearing test. If a user can scan the home page in 30 seconds and walk away with three retained ideas, the PR succeeded.

---

## 2. Non-goals

- Mind map visualization — **next PR after this**
- Reply / instruction input — Phase 2
- Detected themes across runs — Phase 3 (requires accumulated state, doesn't exist yet)
- Generate-X buttons (report / deck / export) — Phase 4
- Run Now trigger — separate spec (docs/22)
- New tables, RPCs, RLS policies — none in this PR
- Schema migrations to `agents`, `agent_runs`, `agent_findings` — none
- Source coverage section from yesterday's lock — dropped (not in the user-stated needs; redundant with sources-collapsed)
- Activity strip visualization — dropped from this PR; the textual timeline is enough

---

## 3. Features the next PR delivers

### 3.1 Agent home page at `/workspace/agents/$agentId`
Inbox stops being a card-list. Each agent gets its own page. The inbox `/workspace/agents` becomes a list of agent rows that link to homes. `/workspace/inbox` redirects.

### 3.2 Conversational briefing (ChatGPT-prose style)
**2-3 short paragraphs** of prose in the agent's voice. First-person ("I checked the LLM-safety beat this week…"). Reads like a peer reporting back — not a JSON-rendered-to-HTML document.

The prose absorbs what v2 split across `memorableTakeaways`, `readFirst`, `skipOrCollapse`, `distinctIdeas`. Source references happen inline, expandable.

### 3.3 Personal-relevance frame (broker-driven)
A short paragraph (≤200 chars) that uses the **trait broker** (already wired into chat) to angle the briefing at the user specifically. This is NC's differentiator over ChatGPT — ChatGPT doesn't carry user context between sessions; NC does.

> Example: "Given that you've been asking about prompt-injection in chat lately, the Palo Alto methodology is the angle worth your time — the others are pitched at researchers, not founders making vendor decisions."

### 3.4 What's new — highlighted callout
A small visually-distinct callout (color band, not just a label) that surfaces what's NEW since the prior run. Renders only when a prior briefing exists and there is something genuinely new. Uses the existing `provenance: 'new'` mechanic. Empty / first-run case: callout hidden.

Where appropriate, the prose body ALSO marks sentences about new items with a left-border accent (small, not loud). The user can see at a glance which sentences are about shifts vs. continuing context.

### 3.5 Three things to keep in mind (LOCKED — exactly 3)
A fixed list of **exactly three** imperative statements at the top of the page (above the prose). Compression discipline: the LLM cannot produce 0, 1, 2, 4, or 5 items. Always three.

> Example:
> 1. Red teaming ≠ systematic measurement. Use both.
> 2. Palo Alto piece is the only one with methodology this week.
> 3. Watch for automation tooling — that's where the field heads next.

Position: at the TOP of the briefing for skim-mode users. Below the header but above the prose body. Items tagged `new` get visual treatment (color band or new-badge).

The three are derived by the LLM during briefing generation — see §5 for prompt direction.

### 3.6 Sources collapsed
`<details>` block at the very bottom of the briefing. Default closed. Shows the list of sources the agent consulted with title + domain + clickable URL. Inline references in the prose anchor here.

### 3.7 Status header
Agent name + topics + cadence + last-run-status (text + dot, never color alone) + relative timestamp ("Updated 2h ago"). The "agent is alive" signals.

---

## 4. Page layout

```
┌────────────────────────────────────────────────────────────┐
│  HEADER                                                    │
│  [Agent name]  · [topics]  · [cadence]                     │
│  Updated [rel-time] · [● ok / failed / running / skipped]  │
├────────────────────────────────────────────────────────────┤
│  THREE THINGS TO KEEP IN MIND  (exactly 3, always)         │
│  1. [imperative] [optional NEW badge]                       │
│  2. [imperative]                                            │
│  3. [imperative] [optional NEW badge]                       │
├────────────────────────────────────────────────────────────┤
│  WHAT'S NEW THIS WEEK  (highlighted callout, hidden if     │
│                          first run or no genuine change)    │
│  [one-sentence delta]                                       │
├────────────────────────────────────────────────────────────┤
│  THE READ                                                  │
│  [2-3 paragraphs of prose in agent voice, first-person.    │
│   Inline source references. Sentences about new items      │
│   get a small left-border accent.]                          │
├────────────────────────────────────────────────────────────┤
│  WHY THIS MATTERS TO YOU  (broker-driven, hidden if no     │
│                             broker context available)      │
│  [one short paragraph]                                      │
├────────────────────────────────────────────────────────────┤
│  ▸ Sources checked: [N]  (collapsed by default)            │
└────────────────────────────────────────────────────────────┘
```

(After Phase 2: a reply input appears at the bottom. After mind-map PR: a small "View mind map" link near the top. Neither is in this PR.)

---

## 5. Briefing schema — v3 (replaces v2 in research-digest template)

The structured v2 schema (`memorableTakeaways[]`, `readFirst[]`, etc.) is replaced for new runs. v2 stays as a render-fallback for legacy data.

```ts
type ResearchDigestBriefingV3 = {
  version: 3;
  kind: 'research';

  /** Exactly 3 imperative statements. The LLM MUST produce three —
   *  not 0-3, not up to 3. If the batch is too thin for three real
   *  imperatives, the LLM must say so honestly in the prose body
   *  AND in qualityNote, but still emit three items (the third
   *  may be a forward-looking "watch for X" rather than an
   *  insight from THIS batch). */
  keepInMind: Array<{
    text: string;                              // imperative, ≤120 chars
    provenance: 'new' | 'continuing' | 'recurring';
  }>;

  /** 2-3 short paragraphs of prose in first-person agent voice.
   *  Inline source references using [n] anchors that match the
   *  index in the sources[] array below. */
  proseBody: string;                           // ~400-700 chars total

  /** Optional broker-driven angle. Null when no broker context
   *  is available (or when broker provides nothing useful for
   *  this topic — must not fabricate relevance). */
  personalRelevance: string | null;            // ≤300 chars

  /** Optional change callout. Null on first run for this agent
   *  OR when the new batch is genuinely indistinguishable from
   *  prior briefings. */
  whatsNew: string | null;                     // ≤200 chars

  /** Optional batch caveat. NOT for surfacing system failures
   *  (those go in failureClass). */
  qualityNote: string | null;                  // ≤200 chars

  /** Sources the agent consulted this run, in the order they're
   *  referenced inline in proseBody ([1], [2], etc.). */
  sources: Array<{
    dedupeKey: string;
    title: string;
    url: string;
    domain: string;                            // normalized host
  }>;

  /** Failure marker — carries forward from v2 fix. Present only
   *  on failure briefings; fetchPriorBriefing filters these out
   *  as prior context. */
  failureClass?: 'rate_limited' | 'chain_exhausted' | 'malformed' | 'generic';
};
```

### Render dispatch (briefing.version)

| Version | Path | Notes |
|---|---|---|
| `version: 3` | New v3 render — see §4 layout | This PR |
| `version: 2` | Existing v2 render component | PR #26 |
| `version: 1` | PR #24 legacy flat path | Sunset condition per docs/19 §6 |
| `NULL` | Degraded state — see §7 | Per docs/19 §6 |

All four paths must coexist; the inbox dispatches on the field.

---

## 6. Prompt direction (for the implementation PR)

The v3 briefing prompt produces prose, not fields. Key prompt constraints (full prompt lands in the implementation PR):

- **Agent voice**: first-person, peer-register, direct. Not friendly-bot, not stiffly-academic. Hedges only when honesty requires it; otherwise opinionated.
- **Open by getting to the point**: no "Hello! I have checked this batch for you." The agent opens at the substance: "Mostly explainer pieces this week, except one — Palo Alto's piece on adversarial testing methodology…"
- **Use broker fragment**: when generating `personalRelevance`, the prompt receives the broker fragment and is instructed to angle the briefing at this user. If broker context is absent or unrelated to the topic, return `null` — do NOT fabricate relevance.
- **Exactly 3 keep-in-mind items**: enforce in the prompt instruction AND in Zod validation. A returned 2-item or 4-item array fails parse → falls to failure briefing path.
- **Source references inline**: prose uses `[1]`, `[2]` notation matching `sources[]` indices. Easy to render as clickable footnotes.
- **Specificity contract from PR #27 carries forward**: ban platitudes, require concrete claims, prefer "skip the rest" over "they're all useful."
- **Epistemic hedging from PR #22 carries forward**: no broad absence claims, no definitive-best claims, scope to "this batch."

Voice exemplars (anchor for the LLM):

> GOOD: "Mostly explainer pieces this week, except one. Palo Alto's piece on adversarial testing methodology is the only thing here that adds something — the others restate the same definition in different words. The interesting tension: Microsoft's docs argue red-teaming shouldn't replace systematic measurement [1], while the WEF piece treats it as the path forward [3]. If your week is tight, skip everything except [2]."
>
> BAD: "Hello! I have analyzed five sources this week on red teaming. Red teaming is a crucial practice for AI safety. Here are the key takeaways I found…"

---

## 7. Empty / degraded states

| Case | Header treatment | Body |
|---|---|---|
| No runs yet | "No runs yet" | "This agent has been created but hasn't completed an observation cycle. Once it runs, its briefing and activity will appear here." |
| Latest run `status='ok'` + briefing NULL | "Updated [rel-time] · ok · no briefing" | "No briefing available for the latest run. [items_kept count] findings persisted; expand sources to see them." |
| Latest run `failed` / `timeout` | "Last attempt failed [rel-time]" | "Latest run did not complete. Reason: [scrubbed error class]. The previous successful briefing remains in the timeline." |
| Latest run `skipped_budget_exceeded` | "Skipped — budget cap [rel-time]" | "Skipped this cycle (daily run budget reached). Next attempt in [time]." |
| `version: 2` briefing exists (legacy) | Header normal | v2 render component (PR #26) used inline. No prose-style render. |
| `version: 1` / NULL (very old) | Header normal | PR #24 legacy flat render. No prose-style render. |

**Load-bearing rule** (carried from yesterday's lock): a terminal run appears in the activity timeline WITHOUT updating the prose briefing surface. Failed/timeout/skipped runs are visible (the agent feels alive) without polluting the latest report.

---

## 8. Status taxonomy

Five terminal/in-flight `agent_runs.status` values (unchanged from yesterday's lock):

| Status | Updates page briefing? | Header treatment |
|---|---|---|
| `ok` + briefing populated | ✅ yes | "Updated [rel-time] · ok" |
| `ok` + briefing NULL | ❌ degraded copy | "Updated [rel-time] · ok · no briefing" |
| `partial_success` + briefing | ✅ yes | same as `ok` |
| `failed` | ❌ no | "Last attempt failed [rel-time]" |
| `timeout` | ❌ no | same as `failed` |
| `skipped_budget_exceeded` | ❌ no | "Skipped — budget cap [rel-time]" |
| `running` (in-flight) | ❌ pulse | "Running now…" |

All seven must render without crashing.

---

## 9. Acceptance criteria

### Schema + runtime
- [ ] `ResearchDigestBriefingV3` Zod schema added; v2 schema kept for legacy renders
- [ ] Briefing prompt rewritten to produce v3 output; `summarise()` remains a no-op pass-through (no per-item LLM)
- [ ] `keepInMind` array length === 3 enforced by Zod; non-three counts → Zod fails → failure briefing path
- [ ] Broker fragment threaded into briefing prompt when generating `personalRelevance` (returns null if broker context is absent/irrelevant)
- [ ] `whatsNew` and `personalRelevance` are both optional — `null` is valid

### Route + page
- [ ] `/workspace/agents/$agentId` renders the home page
- [ ] `/workspace/agents` renders the agent list with restyled rows
- [ ] `/workspace/inbox` redirects (or aliases) to `/workspace/agents`

### Page rendering
- [ ] Header shows agent name + topics + cadence + status word + status dot + relative timestamp
- [ ] **"Three things to keep in mind"** renders exactly 3 items; items tagged `new` get visual treatment
- [ ] **"What's new this week"** callout renders only when `whatsNew !== null`; visually distinct (color band)
- [ ] **Prose body** renders v3 `proseBody` as paragraphs; sentences referencing `[n]` anchor to sources
- [ ] **"Why this matters to you"** section renders only when `personalRelevance !== null`
- [ ] **Sources collapsed** — `<details>` block at the bottom; closed by default; click expands to source list
- [ ] **Render dispatch**: v3 → new prose render; v2 → existing v2 component; v1/NULL → PR #24 legacy

### Failure + degraded
- [ ] All §7 degraded states render correctly
- [ ] All §8 status values render without crashing
- [ ] Briefing failure persists a `failureClass`-marked v3 briefing; fetchPriorBriefing skips it next run

### Accessibility (minimum)
- [ ] Status badges include readable text label (not color alone)
- [ ] `<details>` for sources is keyboard-accessible
- [ ] "What's new" highlight uses both color AND a text/badge marker (not color alone)
- [ ] Empty / degraded states are plain text (not icon-only)

### Mobile (minimum)
- [ ] Layout readable at 375px width without horizontal scroll
- [ ] Header collapses status meta to a second line on mobile
- [ ] All 7 page sections render at mobile width

### Non-functional
- [ ] tsc clean on touched files
- [ ] Tests for: v3 Zod validation (incl. exactly-3 rule), prose rendering, render dispatch by version, broker integration in prompt, all degraded states, all status values
- [ ] One real run via `scripts/run-one-agent.ts` produces a v3 briefing; opening the home page reads as "the agent reported back" (subjective check, but the structured tests above pin the shape)

### Bounded surface
The implementation PR touches only:
- `src/server/agents/templates/research-digest.ts` (v3 schema + prompt rewrite + briefing function update)
- `src/lib/agent-home.functions.ts` + `.server.ts` (new — getAgentHome serverFn)
- `src/lib/findings.functions.ts` + `.server.ts` (new listAgentRows for the inbox)
- `src/routes/workspace.inbox.tsx` (rewrite as agent list)
- `src/routes/workspace.agents.$agentId.tsx` (new — the home page)
- `src/components/AgentHomeBriefing.tsx` (new — the v3 prose render component)
- `tests/leak-suite/phase30-research-digest.test.ts` (extended for v3)
- `tests/agent-home/*` (new)

Anything outside = scope drift, review bounces.

---

## 10. Explicitly deferred to follow-up PRs

| Item | When |
|---|---|
| **Mind map visualization** | Next PR after this one |
| Reply / instruction input | Phase 2 |
| Detected themes across runs | Phase 3 |
| Source-coverage / Activity-strip visuals | Phase 3 or later (skipped from this PR) |
| Generate-X artifacts (report / mind-map export / deck) | Phase 4 |
| Run Now button | docs/22 |
| Read/unread state | Phase 2 nicety |

> "The agent should have a home, not just a thread and not just a document. The home page is the container; the prose IS the content; the mind map is the visual; nothing is the document." — combined Sneha review 2026-05-18 + 2026-05-19

---

## Appendix: scope-drift checklist for the implementation reviewer

The PR ships only if NONE of these are present. Bounce if any are:

- [ ] No new tables (no `agent_messages`, no anything else)
- [ ] No backfill SQL
- [ ] No schema changes to `agents` / `agent_runs` / `agent_findings`
- [ ] No mind map visualization (placeholder OR active)
- [ ] No reply / instruction input UI
- [ ] No "Generate report / mind map / deck" buttons
- [ ] No themes / branches UI (placeholder or active)
- [ ] No "Run Now" button
- [ ] No notifications / share URLs / read-unread state
- [ ] No new runner writes
- [ ] No `keepInMind.length !== 3` cases passing validation
- [ ] No color-only status indicators
- [ ] No desktop-only layout
- [ ] Top "Three things" section uses the exact label (string-asserted in tests)

If all clear: ship it. Mind-map PR follows immediately.

# docs/19 — Briefing-First Agent Architecture (template-agnostic)

**Status:** SPEC LOCKED — 2026-05-18 (Sneha)
**Owner:** Sneha
**Implementation PRs:** none directly; this is the architecture layer.
Concrete template instances live in sibling docs (docs/20+).
**Relates to:** docs/13 (Phase 3 agent runtime), docs/16 (Phase 3.0 runtime),
docs/18 (search provider). Supersedes the per-template draft this doc
previously held (lifted into docs/20).

---

## Problem statement

Phase 3.0 shipped agents whose output unit is a card-per-finding list with
optional briefing decoration. The 2026-05-18 PR #22-#24 verification made
two failures visible:

1. **The unit of output was wrong.** 16 sources × 80-word summaries forces
   the user to do the cluster-dedupe-extract work the agent was supposed to
   do. The briefing was a decoration, not the product.
2. **Each run was a one-shot.** Agents have no notion of prior runs.
   They can't say "5 new things this week on top of 12 from last time"
   — the URL dedupe just makes prior-seen items disappear silently.

The right architectural reframe: **agents are corpus-builders, not batch
summarisers.** Each run incrementally updates a curated body of knowledge
on a topic. The briefing is the user-facing view of that corpus, refreshed
as the corpus grows, with new items called out as new.

This doc defines the architecture for ALL agent types. The specific shape
for any one agent type (research papers, outfits, product watches) lives in
a sibling spec — see Roadmap.

---

## The architectural shifts in three sentences

> The briefing is the product. Findings are evidence.
> Each run is a delta against the prior run's briefing, not a fresh start.
> Failures are visible; nothing is silently masked with canned scaffolding.

---

## Load-bearing principle

> **The agent's job is to reduce repeated cognition across time, not to
> summarise every source in the current batch.**

This is the prevention rule against regressing back into expanded-Google-
results. Any future change to a template, prompt, or render component that
expands the user's per-run reading load is a violation of this principle
and should be questioned in review. Cognitive load should monotonically
trend DOWN over runs as the corpus stabilises, not up.

The principle implies, concretely:
- Per-source paragraphs in the user surface are forbidden by default.
- Repetition across runs MUST be acknowledged ("still true") and
  collapsed, not re-presented as new.
- New items that genuinely add to the corpus get explicit attention
  (the `provenance: 'new'` tag + `[NEW]` badge); everything else
  fades into the sources disclosure.
- The briefing's job is to make the user fluent in their watched topics
  with the minimum re-reading possible.

---

## 1. Briefing-first contract (universal shell)

All briefings, regardless of template, share a common shell:

```ts
type AgentBriefingShell = {
  /** Schema version. v2 = this architecture. v1 = pre-architecture PR #22 layer. */
  version: 2;

  /** Template kind. Inbox dispatches the render component on this field.
   *  Existing kinds: 'research'. Future: 'outfit', 'product_watch', etc. */
  kind: string;

  /** One-line opinionated framing of THIS run, ≤140 chars. Specific, not
   *  "N items found." */
  headline: string;

  /** 1-2 short sentences, ≤300 chars total. The "what to remember in a
   *  week" sentence. */
  synthesis: string;

  /** Cross-run continuity context — what's NEW since last run, what's
   *  CONTINUING, what (rarely) has CHANGED. Optional only on the first
   *  run; required when a prior run for the same agent exists. */
  delta?: BriefingDelta;

  /** Source quality / batch-level caveat. NOT for surfacing internal
   *  system failure modes ("LLM was unavailable" stays in the failure
   *  surface, not here). */
  qualityNote?: string;
};

type BriefingDelta = {
  /** Short paragraph framing what changed vs prior run. ≤300 chars. */
  whatsNew: string;
  /** Short paragraph framing what's still true / unchanged. ≤200 chars. */
  whatsContinuing?: string;
  /** Rare — only when the agent observes a topic LOSING salience. ≤200 chars. */
  whatsChanged?: string;
};
```

Template-specific payloads extend the shell with their own fields (see
template specs). Validation is done per template via Zod schemas that
include both the shell and the template-specific extension.

**The inbox render contract:** every template's briefing is renderable as
"headline + synthesis + delta + sources collapsed." Template-specific
content (memorable takeaways for research, curated grid for outfits, etc.)
slots between the synthesis and the sources disclosure.

---

## 2. Cross-run continuity (briefing-as-delta)

Every recurring agent's briefing reasons about its prior run.

### Mechanics

At briefing-generation time, the template:
1. Queries `agent_runs.briefing` for the most recent prior run of the same
   agent where `briefing IS NOT NULL` AND `version === 2`.
2. If one exists: includes its `headline + synthesis + delta + the
   template's content fields` in the briefing prompt as "what you said
   last time."
3. The LLM produces this run's briefing framed as a delta — new takeaways
   marked as new, continuing themes acknowledged, dropped themes noted.

### Per-item provenance

Template-specific item arrays (e.g. research's `memorableTakeaways`,
outfit's `picks`) include a `provenance` field per item:

```ts
provenance: 'new' | 'continuing' | 'recurring'
```

- `new` — item not in any prior run's briefing
- `continuing` — item appeared in the most recent prior briefing and
  is still relevant
- `recurring` — item appeared 2+ runs ago, hasn't appeared in the most
  recent one, but the agent thinks it's worth re-surfacing

The inbox renders a small "NEW" badge on items tagged `new`. `continuing`
gets no badge (the default). `recurring` gets a small "RESURFACED" badge.

### First-run case

If no prior briefing exists, `delta` is omitted entirely and all items
are `provenance: 'new'` by default. The render path treats first-run
sections normally (the "NEW" badges on every item are not noise — they
correctly say "this is the first time I've shown you this").

### Cost implication

The prior briefing adds ~400 tokens to the briefing prompt input. Cheap.
No extra LLM call.

---

## 3. Failure handling (universal)

Every template's briefing function must:

1. Catch LLM throws.
2. Catch JSON parse / Zod validation failures.
3. **Never silently return canned scaffolding that looks like real output.**
4. On failure: persist a `version: 2` briefing with:
   - `headline = "Briefing could not be generated for this run."`
     (or template-appropriate equivalent)
   - `synthesis` = a one-sentence honest description of the failure
   - All template-specific arrays empty
   - `qualityNote` populated with the failure mode

The inbox renders failure briefings in a visually-distinct style (muted
border, no glow) so the user can't mistake them for real synthesis.
Sources stay accessible (the failure briefing still has the source list
collapsed-by-default underneath).

`items_kept === 0` is NOT a failure. The briefing in that case is real
synthesis of "nothing matched today" — see template specs for exact copy.

---

## 4. Inbox rendering (abstract layout)

```
┌────────────────────────────────────────────────────────────┐
│  [Agent name]                                              │
├────────────────────────────────────────────────────────────┤
│  [headline]                                                │
│  [synthesis]                                               │
│                                                             │
│  WHAT'S NEW THIS RUN                                       │   ← delta.whatsNew
│  [paragraph]                                               │
│                                                             │
│  [template-specific content slot]                          │   ← e.g. takeaways,
│  ┌──────────────────────────────────────────────────┐      │      outfit grid,
│  │  Template's main content (varies by kind)         │      │      product list
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ▸ Sources checked: N                                      │   ← collapsed
└────────────────────────────────────────────────────────────┘
```

Components in the abstract:
- **Header** — agent name + finding count (existing, unchanged)
- **Headline** — large, bold
- **Synthesis** — muted, leading-relaxed
- **Delta block** — only if `delta` populated; visually distinct
  (e.g. left border, "WHAT'S NEW THIS RUN" heading)
- **Template-specific content** — the inbox dispatches on `kind` to
  render the right component
- **Sources disclosure** — `<details>` element, closed by default,
  shows link list (title + domain only — no summaries, no badges)

Failure-briefing variant uses muted styling throughout; template-specific
content slot is replaced with a "Sources only" indicator pointing at
the disclosure.

---

## 5. Template extension points

To add a new agent type, the template must:

1. **Declare its `kind`** in its briefing payload (`research`, `outfit`,
   `product_watch`, etc.).
2. **Implement the briefing shell** (`headline`, `synthesis`, optional
   `delta`, optional `qualityNote`).
3. **Define + validate its own template-specific payload extension** via
   Zod, including per-item arrays with `provenance` tags.
4. **Define its source-record shape** — what gets persisted in
   `agent_findings` (minimum: title, URL, dedupe key, score; nothing
   user-visible-paragraph-shaped).
5. **Define its inbox render component** — a React component that takes
   the template-specific extension + the source list and renders the
   template-specific content slot.
6. **Provide eval examples** — at minimum: first-run / cross-run-with-delta
   / all-redundant / `items_kept===0` / failure.

The runtime, batch, queue, lease, budget, search, and inference layers do
NOT need to change to add new templates. The runtime is already template-
agnostic per PR #2's invariant; this architecture extends that to the
briefing + render surface.

---

## 6. Legacy fallback rendering

Existing data:
- `briefing IS NULL` (pre-PR-22 runs OR `items_kept === 0` v1 runs)
- `briefing.version === 1` (PR #22-era runs, including their fallback briefings)

These are rendered via PR #24's flat findings list (no fabricated badges,
no fake briefing block, just title + summary + timestamp).

**Sunset condition (LOCKED by Sneha 2026-05-18):**

> Keep the v1 legacy render path until all beta-created ResearchDigest
> runs produce `briefing.version >= 2` for two consecutive weeks.

No migration, no cleanup until that condition is met. The check is a
simple SQL query against `agent_runs.briefing->>'version'` ordered by
`started_at desc`; can be wired into the CI dashboard or just run
manually before any sunset PR opens.

---

## 7. Roadmap of sibling specs

Order LOCKED by Sneha 2026-05-18 — "Run now" promoted ahead of OutfitDigest
because it improves every existing agent immediately, while the second
template instance can wait until the core loop feels usable.

| Order | Doc | Scope | Notes |
|---|---|---|---|
| 1 | docs/20 | ResearchDigest v2 template instance | In review (this PR). The load-bearing first instantiation. |
| 2 | docs/22 | Agent on-demand trigger ("Run now") | Small. Button + serverFn wrapping the existing claim+execute. Closes the operational gap of "no way to trigger a run" — useful for every agent regardless of template. |
| 3 | docs/21 | OutfitDigest / ProductWatcher template (sketch) | Second template instance to validate the architecture's extensibility. Sketch first, full spec when implementation interest justifies it. |
| 4 | docs/23 | Findings library / favourites + save / dismiss | "Save" / "Dismiss" actions, Library view, favourites + dismissals feed back into briefings as positive/negative examples. |
| 5 | docs/24 | Suggested draft agents from observed patterns | Phase 3.5 scope. See §7.1 — strict draft-only boundary. |

### 7.1 Hard boundary on agent auto-creation

LOCKED by Sneha 2026-05-18 — trust boundary, do not relax in implementation.

> **The system may suggest DRAFT agents based on observed patterns. It
> must NOT silently create active recurring agents without user
> confirmation.**

Allowed flow:
```
detected topic → draft suggestion → user confirms → active agent
```

Forbidden flow:
```
detected topic → active agent starts running overnight (no confirmation)
```

This applies to docs/24 specifically but is recorded here as an
architecture-level constraint because it governs WHAT the agent runtime
is allowed to do on the user's behalf without explicit consent.
Implementation must surface drafts in a clearly distinguishable UI state
("Suggested for you — confirm to activate") and never auto-promote them.

---

## 8. Implementation guardrail

The implementation PR that follows docs/19 + docs/20 merge must touch
ResearchDigest v2 ONLY:

- No runtime changes (batch, queue, lease, budget, cron untouched).
- No new schema unless explicitly justified in docs/20.
- No new product route.
- No favourites or save/dismiss (docs/23).
- No auto-agent suggestions (docs/24).
- No outfit / product template (docs/21).
- No "Run now" trigger (docs/22 — separate PR).

The next code PR proves the new architecture with one template. Scope
discipline is enforced by the bounded-files list in docs/20 §10; review
should bounce any PR that touches files outside it.

---

## 9. Non-goals for this architecture spec

- Defining specific output shape for ANY single template (that's the
  template's spec)
- Defining specific prompts (per-template)
- Defining specific UI components beyond the abstract layout (per-template
  render component)
- Touching the runtime, batch, queue, lease, budget, search, inference,
  or cron layers
- Schema migrations
- Cross-AGENT synthesis (multi-agent briefings)
- User-feedback ingestion into briefings (favourites is docs/23)
- Persistent topic models / corpus-level summary tables (the corpus IS
  the agent_runs + agent_findings rows; we don't need a new table for it)

---

## 10. Resolved decisions (was: open questions)

All six open questions from the original draft were resolved by Sneha
2026-05-18 before this doc was locked. Reproduced here so the
implementation PR has authoritative answers.

### 10.1 — Persist a v2 briefing on `items_kept === 0`?

**YES.** Locked as a three-state behaviour:

```
items_kept > 0
  → normal v2 briefing

items_kept === 0  AND  provider/search succeeded
  → empty-batch v2 briefing (template-specific honest copy)

provider/search failed (chain exhausted, network down, etc.)
  → visible failure briefing (per §3)
```

No fake insight. The empty-batch case must be useful and honest. Template-
specific copy lives in the template spec (e.g. docs/20 §6 for research).
The architecture mandates only: NEVER silently leave briefing NULL on a
successful-but-empty run; ALWAYS distinguish empty-but-OK from failure.

### 10.2 — Token-budget cap on briefing input

**Cap at 20 sources, sorted by score desc, top 20 win.**

For v2 ship: simple `sort(score desc).slice(0, 20)`. If hit, set
template-specific `qualityNote` flagging the cap (e.g. "Capped at 20
of N sources by relevance score.").

Diversification (by domain or idea cluster) is deferred until simple
top-20 demonstrably underperforms in practice. Out of scope for ship.

### 10.3 — Sunset condition for v1 legacy render path

**Condition, not date.** See §6.

### 10.4 — Failure-mode copy voice

**Human copy in the inbox; no error codes in the user surface.**

Failure-mode briefings render with human-language synthesis. Example:

> "I couldn't complete this check because the search provider was rate-
> limited. I'll try again on the next run."

Diagnostics (HTTP codes, provider names, retry counts) belong in run
history / debug, never in the user-facing briefing. Templates own the
exact copy for each failure mode — see docs/20 §6 for ResearchDigest's
table.

### 10.5 — Provenance taxonomy

**Ship with three values (`new` / `continuing` / `recurring`).**
Revisit after the first 4 weeks of real usage. If the LLM never produces
`recurring` in practice, collapse to two values then.

### 10.6 — Cross-run window

**Just the most recent prior briefing.** No look-back beyond 1.
Revisit only if observed delta quality is poor.

---

## Acceptance criteria for this spec doc

This doc is mergeable when:

- [x] Architectural shift (briefing-first + corpus-centric + visible-failure) confirmed by Sneha
- [x] All 6 open questions resolved with locked answers (§10)
- [x] Load-bearing principle recorded as a regression guard
- [x] Roadmap of sibling specs ordered per Sneha (Run now ahead of OutfitDigest)
- [x] Auto-agent-creation boundary locked (§7.1, draft-only)
- [x] Implementation guardrail locked (§8, ResearchDigest v2 only)
- [x] docs/20 reviewable as the first concrete instantiation

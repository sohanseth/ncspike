# docs/19 — Briefing-First Agent Architecture (template-agnostic)

**Status:** SPEC IN REVIEW — 2026-05-18 (Sneha)
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
no fake briefing block, just title + summary + timestamp). That code path
stays as-is indefinitely. Sunset condition is TBD (open question 3).

---

## 7. Roadmap of sibling specs

| Doc | Scope | Status | Notes |
|---|---|---|---|
| docs/20 | ResearchDigest v2 template instance | In review (this PR) | Was previously in this doc; lifted out. |
| docs/21 | OutfitDigest template (sketch) | Queued | Visual-grid agent; sibling template instance to validate the architecture's extensibility. |
| docs/22 | Agent on-demand trigger ("Run now") | Queued | Small. Just a button + serverFn wrapping the existing claim+execute. |
| docs/23 | Agent auto-creation from user behaviour | Queued | Phase 3.5 scope. User search/chat signal → topic extraction → propose-an-agent flow. |
| docs/24 | Findings library / favourites | Queued | "Save" action, Library view, favourites feed back into briefing as positive examples. |

Order of operations (recommendation, not commitment):
1. Merge docs/19 + docs/20 (this PR).
2. Implement docs/20 (ResearchDigest v2). This is the load-bearing
   implementation that validates the architecture on a real template.
3. Implement docs/22 (Run now) as a small parallel PR — useful regardless
   of v2 timing; closes the operational gap of "no way to trigger a run."
4. Sketch docs/21 (OutfitDigest) once docs/20 ships. This is the
   architecture's second customer; if anything painful surfaces, fix it
   in the architecture, not the template.
5. docs/24 (favourites) and docs/23 (auto-creation) on their own cycles.

---

## 8. Non-goals for this architecture spec

- Defining specific output shape for ANY single template (that's the
  template's spec)
- Defining specific prompts (per-template)
- Defining specific UI components beyond the abstract layout (per-template
  render component)
- Touching the runtime, batch, queue, lease, budget, search, inference,
  or cron layers
- Schema migrations
- Cross-AGENT synthesis (multi-agent briefings)
- User-feedback ingestion into briefings (favourites is docs/24)
- Persistent topic models / corpus-level summary tables (the corpus IS
  the agent_runs + agent_findings rows; we don't need a new table for it)

---

## 9. Open questions

1. **Persist a v2 briefing even when `items_kept === 0`?** Default
   position: yes, with template-specific "nothing matched" synthesis.
   Alternative: leave NULL and let legacy path render. Sneha to confirm.

2. **Token-budget cap on briefing input.** Including the prior run's
   briefing adds ~400 tokens, and the source bundles can be 6k+. Default
   position: cap kept-source input at 20 items (highest score wins); flag
   in `qualityNote` if hit. Sneha to confirm.

3. **Sunset date / condition for the v1 legacy render path.** Default
   position: kept indefinitely. Sunset only after 90+ days with no v1
   briefings in any user's inbox. Sneha to confirm.

4. **Exact failure-mode copy.** Voice / tone of the "Briefing could not
   be generated" wording. Proposed in implementation PR for review.

5. **Provenance taxonomy.** Three values (`new` / `continuing` /
   `recurring`) feels right but is untested. Could be just two
   (`new` / `existing`). Revisit after first template instance ships.

6. **Cross-run window.** "Most recent prior briefing" is the default.
   Could be "the last 3" for richer delta context, but adds prompt tokens.
   Default position: just the most recent. Revisit after observed
   behaviour.

---

## Acceptance criteria for this spec doc

This doc is mergeable when:

- [ ] Sneha confirms the architectural shift (briefing-first +
  corpus-centric + visible-failure) is what she's signing up for
- [ ] The 6 open questions have defaults that are either accepted or
  overridden
- [ ] The roadmap of sibling specs reflects the order Sneha wants
- [ ] docs/20 (in this same PR) is reviewable as the first concrete
  instantiation

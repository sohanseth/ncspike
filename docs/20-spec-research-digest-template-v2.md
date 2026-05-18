# docs/20 — ResearchDigest Template v2 (briefing-first instance)

**Status:** SPEC LOCKED — 2026-05-18 (Sneha)
**Owner:** Sneha
**Implementation PR:** TBD (next PR after this + docs/19 merge; must reference both)
**Depends on:** docs/19 (architecture)
**Relates to:** docs/13, docs/16, docs/18

The first concrete template instance under the docs/19 briefing-first
architecture. This doc is a non-blocking shape spec for the ResearchDigest
agent (the existing search-and-summarise type). Other template instances
(OutfitDigest, ProductWatch) live in their own docs.

---

## 1. Inputs / outputs

**Inputs (per run):**
- `config.topics: string[]` — user-defined search topics
- `config.minScore: number` — keep-threshold for scored items
- `config.lookbackHours: number` — search recency window
- Search-provider results for each topic (Tavily / SearXNG, dispatched per
  docs/18) — each result already includes a snippet (~200-400 chars)
- The PRIOR run's briefing for this agent (if any), per docs/19 §2

**Outputs:**
- One `agent_runs.briefing` JSONB payload conforming to
  `ResearchDigestBriefingV2` (schema below)
- Per-source rows in `agent_findings` with minimal data (no per-source
  paragraph summary)

---

## 2. Briefing payload — `ResearchDigestBriefingV2`

Extends the architecture's shell (docs/19 §1) with research-specific fields:

```ts
type ResearchDigestBriefingV2 = {
  // ─── Shell (per docs/19) ──────────────────────────────────────────────
  version: 2;
  kind: 'research';
  headline: string;            // ≤140 chars
  synthesis: string;           // ≤300 chars
  delta?: BriefingDelta;       // present from run 2+
  qualityNote?: string;        // ≤200 chars

  // ─── Research-specific content ────────────────────────────────────────

  /** 1-5 takeaways, most-important first. Each is one concrete claim,
   *  ≤140 chars, with the source keys that support it AND a provenance
   *  tag per docs/19 §2. */
  memorableTakeaways: Array<{
    text: string;
    supportSourceKeys: string[];        // subset of run's kept dedupe_keys
    provenance: 'new' | 'continuing' | 'recurring';
  }>;

  /** 0-3 sources to actually open. Empty array valid. */
  readFirst: Array<{
    sourceKey: string;
    reason: string;                     // ≤200 chars
    provenance: 'new' | 'continuing' | 'recurring';
  }>;

  /** 0-N redundancy classes. Each entry collapses a group of
   *  sources that say the same thing. */
  skipOrCollapse: Array<{
    reason: string;                     // e.g. "Beginner definition of red teaming"
    sourceKeys: string[];
  }>;

  /** 0-N distinct themes surfaced by this batch. Different from
   *  memorableTakeaways — taxonomic, not memorable. May overlap. */
  distinctIdeas: Array<{
    label: string;
    summary: string;                    // one sentence
    sourceKeys: string[];
  }>;

  /** 0-3 follow-up questions the next run could investigate. */
  nextSearchSuggestions: string[];
};
```

**Validation:**
- Zod schema in `src/server/agents/templates/research-digest.ts`.
- All `sourceKeys` referenced in any field MUST be a subset of the run's
  kept-finding `dedupe_key`s. Invalid keys → see §6 failure handling.
- `provenance` of `new` / `continuing` / `recurring` per docs/19 §2;
  first-run case: `delta` omitted, all provenance defaults to `new`.

---

## 3. Per-source data (what gets persisted to `agent_findings`)

Schema unchanged at the DB level. What changes is what v2 writes:

| Column | v2 value |
|---|---|
| `title` | from search result |
| `source_url` | canonicalized URL |
| `dedupe_key` | canonicalized URL |
| `score` | LLM relevance score 0-1 (unchanged from v1's score step) |
| `summary` | **NULL** (v2 emits no per-source paragraphs) |
| `urgency` | template default (`'normal'`) |
| `payload` | provider snippet (already populated; the briefing reads it from here) |

The Tavily / SearXNG snippet in `agent_findings.payload` IS the briefing's
scratch material. No separate `summarise()` LLM call is needed or made.

---

## 4. Prompt objective + structure

The briefing prompt asks one question, once:

> Given these N sources on these M topics, and the prior run's briefing
> (if any), produce a memory-oriented briefing.

Structured around five sub-questions:

1. What 1-5 things should the user remember from this batch (and, if a
   prior briefing exists, framed as a delta against it)?
2. Which sources are redundant — say the same thing as which others?
3. Which 0-3 sources are worth actually opening?
4. What can be skipped or collapsed?
5. What question should the next run ask?

**Prompt input bundle:**
- Topic list (`config.topics`)
- Per-source bundle, one block per kept source:
  - `[N] dedupeKey=<key>`
  - `title: <title>`
  - `domain: <domain>`
  - `score: <0.XX>`
  - `snippet: <Tavily snippet, ≤400 chars>`
- Prior briefing (if any): `headline + synthesis + memorableTakeaways +
  readFirst.reason` (compact form, ≤1000 tokens)

**Hard rules (carried from PR #22, tightened):**
- Output is strict JSON matching `ResearchDigestBriefingV2`. No markdown.
- All `sourceKeys` must exist in the input bundle.
- Epistemic hedging from PR #22 carries verbatim: no broad-world absence
  claims, no definitive-best claims, "From this batch, X" framing.
- Prefer "skip the rest" over "they're all useful." Honest redundancy
  framing is the point.
- When prior briefing exists: explicitly flag new vs continuing items via
  `provenance`. Don't pad with `new` items that aren't actually new.

**Cost:** one LLM call per run (was 16 for v1's 15-summarise + 1-briefing).
~16× reduction.

---

## 5. Cross-run continuity (briefing-as-delta)

Per docs/19 §2 — the template's `briefing()` function:

1. Queries `agent_runs.briefing` for the most-recent prior run where
   `agent_id = current.agent_id` AND `briefing IS NOT NULL` AND
   `briefing->>'version' = '2'`.
2. If found: passes a compacted form of that prior briefing into the
   prompt input. Tells the LLM "this is what you said last time; now tell
   me what's new and what's still true."
3. If not found: omits `delta` from the output; all items are
   `provenance: 'new'`.

**SQL query** (read-only, no schema change):
```sql
select briefing from public.agent_runs
where agent_id = $1
  and user_id = $2
  and briefing is not null
  and briefing->>'version' = '2'
  and started_at < $3
order by started_at desc
limit 1;
```

**Owner scope:** the `user_id` filter is load-bearing — the admin client
bypasses RLS, same discipline as `listFindingsFor` / `listBriefingsFor`.

---

## 6. Failure handling

Per docs/19 §3 — failures are visible, never silently masked.

| Failure mode | Behaviour | User sees |
|---|---|---|
| LLM throws (429, 5xx, chain exhausted) | One retry; if retry fails, persist a failure briefing | Human copy per below + sources uncollapsed |
| LLM returns malformed JSON | One retry; if retry fails, persist a failure briefing | Same as above |
| LLM returns valid JSON, invalid sourceKeys | Strip invalid sourceKeys; if any takeaway loses all its support, drop it; if all takeaways drop, treat as malformed | Best-effort render: surviving valid content shows |
| Prior-briefing fetch fails | Log + scrub + treat as first-run (omit `delta`) | First-run render; no banner |
| `items_kept === 0` | NO LLM call. Persist empty-batch briefing per below | Empty-batch briefing, no sources disclosure |
| Run crashes mid-flight | `briefing IS NULL`, `agent_runs.status='failed'`. Inbox uses legacy flat path for this section. | Legacy flat list (PR #24) |

**Failure-mode briefing copy (LOCKED by Sneha 2026-05-18).** Human voice,
no HTTP codes or provider names in the user surface. Diagnostics go to
run-history / debug only (`agent_runs.error` already carries the scrubbed
reason).

| Failure class | `headline` | `synthesis` |
|---|---|---|
| Provider 429 / rate-limited | `"I couldn't complete this check — the search provider was rate-limited."` | `"I'll try again on the next run. Raw sources are below if you want to scan them yourself."` |
| Chain exhausted (all providers failed) | `"I couldn't complete this check — none of my LLM providers were available."` | `"This usually clears within an hour. Raw sources are below."` |
| Malformed JSON / Zod validation | `"I couldn't complete this check — my synthesis step produced unusable output."` | `"Raw sources are below if you want to scan them yourself."` |
| Generic / unclassified | `"I couldn't complete this check for this run."` | `"I'll try again on the next run. Raw sources are below."` |

`qualityNote` is omitted on failure briefings (the failure IS the message,
nothing to add). The classification of failure → headline is done in the
template's catch block by inspecting `e.errorClass` from `InferenceError`.

**Empty-batch briefing copy (`items_kept === 0`, LOCKED).**

- `headline`: `"Nothing worth keeping in today's check."`
- `synthesis`: `"I checked this topic, but this run did not find anything
  worth keeping. Try narrowing the topic or changing the search angle."`
- All template-specific arrays empty.
- `delta` populated only if a prior briefing exists, with
  `whatsNew: "Nothing relevant this run."`

---

## 7. Inbox rendering (research-specific render component)

The architecture's abstract layout (docs/19 §4) instantiates for research
as:

```
┌────────────────────────────────────────────────────────────┐
│  AI research agent on Safety and Security                  │   ← agent name
├────────────────────────────────────────────────────────────┤
│  [headline]                                                │
│  [synthesis]                                               │
│                                                             │
│  WHAT'S NEW THIS RUN                          (if delta)   │
│  [delta.whatsNew]                                          │
│  [delta.whatsContinuing — small/muted, optional]           │
│                                                             │
│  WHAT TO REMEMBER                                          │
│  • [takeaway 1]      [NEW]            (3 sources)          │
│  • [takeaway 2]                       (1 source)           │
│  • [takeaway 3]      [RESURFACED]     (5 sources)          │
│                                                             │
│  READ FIRST                                                │
│  ★ [title]  ↗  [NEW]                                       │
│    [reason — small, muted]                                 │
│                                                             │
│  SKIP                                                      │
│  • [reason] (4 sources)                                    │
│  • [reason] (2 sources)                                    │
│                                                             │
│  NEXT RUN COULD CHECK                                      │
│  • [suggestion 1]                                          │
│  • [suggestion 2]                                          │
│                                                             │
│  [qualityNote — small italic, if present]                  │
│                                                             │
│  ▸ Sources checked: 16                                     │
└────────────────────────────────────────────────────────────┘
```

**Rendering rules specific to research:**
- `memorableTakeaways` → bullet list. `[NEW]` / `[RESURFACED]` badges
  derived from `provenance`. Source count shown muted at right.
- `readFirst` → star icon + title + link + provenance badge + reason.
  Empty array → section omitted.
- `skipOrCollapse` → muted list, reason + count. Empty → section omitted.
- `distinctIdeas` → rendered ONLY when `memorableTakeaways` is empty
  (taxonomic fallback when no memorable claims surfaced).
- `nextSearchSuggestions` → muted list under heading. Empty → section
  omitted.
- `qualityNote` → small italic, ≤200 chars rendered.
- **Sources** → `<details>` element, closed by default. Open shows link
  list (title + domain only). No summary, no badges, no score.

---

## 8. Eval examples

Manual review checklist for the implementation PR + ongoing operational
verification via `scripts/run-one-agent.ts`.

### Example A — First-run, all-redundant batch (the 2026-05-18 case)

**Input:** 16 sources on "LLM Safety" + "red teaming", all explainer
content. One source (Sprocket Security) goes deeper into methodology.
**No prior briefing.**

**Expected output (key shape):**
```json
{
  "version": 2, "kind": "research",
  "headline": "Today's red teaming batch was all explainer content — one piece adds methodology.",
  "synthesis": "From this batch the sources agreed on the basics: red teaming = simulated adversarial testing of LLMs. Only one source added methodology specifics.",
  "memorableTakeaways": [
    { "text": "Red teaming = simulated adversarial testing to expose LLM weaknesses before deployment.",
      "supportSourceKeys": ["<k1>","<k2>","<k3>","<k4>"], "provenance": "new" },
    { "text": "Sprocket Security adds methodology specifics worth reading.",
      "supportSourceKeys": ["<k5>"], "provenance": "new" }
  ],
  "readFirst": [{ "sourceKey": "<k5>", "reason": "Only source with concrete methodology — the rest define the term.", "provenance": "new" }],
  "skipOrCollapse": [{ "reason": "Repeats the basic definition.", "sourceKeys": ["<k1>","<k2>","<k3>","<k4>","..."] }],
  "distinctIdeas": [],
  "nextSearchSuggestions": ["Recent published red-teaming results on frontier models", "Tools or frameworks for automated red teaming"],
  "qualityNote": "Batch was heavy on beginner-level explainer content."
}
```

### Example B — Second-run continuity

**Input:** same agent, 1 week later. Search returns 12 new sources (4 are
duplicates of prior week's, deduped at fetch by `seen_keys`; 8 new URLs
kept). Of the 8, 2 are new methodology papers, 3 are more beginner
explainers, 3 are off-topic (LLM safety more broadly, not red teaming).
Prior briefing = Example A.

**Expected output:**
- `delta.whatsNew`: "Two new methodology papers appeared this week."
- `delta.whatsContinuing`: "Sources are still predominantly explainer-level."
- `memorableTakeaways[0]`: `provenance: 'continuing'` (red teaming definition)
- `memorableTakeaways[1]`: `provenance: 'new'` ("Two new methodology
  papers cover X and Y")
- `readFirst`: the 2 methodology papers, both `provenance: 'new'`
- `skipOrCollapse`: the 3 new explainers grouped + the 3 off-topic grouped
  separately

### Example C — High-signal batch

**Input:** 8 sources on "frontier model evaluations": 2 papers, 3 lab blog
posts, 2 podcast transcripts, 1 news article on a new benchmark. Prior
briefing exists.

**Expected output:** populated `memorableTakeaways` (3-5), populated
`readFirst` (2-3), populated `distinctIdeas` (3-4), short `skipOrCollapse`.
Headline asserts a specific claim. Several items tagged `new` if the new
benchmark wasn't in prior briefing.

### Example D — `items_kept === 0`

**Input:** 12 sources fetched, all scored below `minScore`.

**Expected output:** No LLM call. Briefing persisted with all arrays empty,
synthesis = "I checked 12 sources today and nothing matched your topics
above the relevance threshold." `delta` populated only if a prior briefing
exists (`whatsNew: "Nothing relevant this run."`).

### Example E — Failure

**Input:** Provider chain exhausts (429 → 429 → 429). Retry also exhausts.

**Expected output:** Failure briefing per §6. Sources `<details>` block
defaults to OPEN (so user can scan titles even without synthesis).

---

## 9. Acceptance criteria for ResearchDigest v2 implementation PR

The PR is mergeable when:

- [ ] `ResearchDigestBriefingV2` Zod schema in `research-digest.ts`,
  imported into the briefing function for validation
- [ ] `briefing()` emits v2 shape; never emits v1
- [ ] All `sourceKeys` validated to exist in the run's kept findings
- [ ] `agent_findings.summary` is NULL on all v2-run rows
- [ ] `summarise()` is not called during the score-keep loop (or is kept
  but unused — `@deprecated` JSDoc tag with a TODO referencing legacy
  column cleanup)
- [ ] Prior-briefing fetch implemented (read-only, user-scoped)
- [ ] Inbox dispatches on `briefing.version === 2` AND
  `briefing.kind === 'research'` to the new render component
- [ ] PR #24's flat path stays as the legacy fallback (`version !== 2`)
- [ ] Failure modes produce visible failure briefings per §6
- [ ] Sources `<details>` closed by default for successful briefings,
  open by default for failure briefings
- [ ] Tests cover Examples A, B, D, E (C is operational-verification only)
- [ ] tsc clean on touched files
- [ ] One run via `scripts/run-one-agent.ts` against deployed Supabase
  produces a v2 briefing matching Example A's shape (verification gate)
- [ ] One second run (24h+ later, or via force-due) produces a v2 briefing
  with `delta` populated and at least one `provenance: 'continuing'`
  item (cross-run-continuity gate)

---

## 10. Implementation surface (the next code PR is bounded to these files)

| File | Change |
|---|---|
| `src/server/agents/templates/research-digest.ts` | New `ResearchDigestBriefingV2` schema, new prompt builder, briefing function rewritten to emit v2 + read prior briefing, summarise function deprecated-but-kept |
| `src/routes/workspace.inbox.tsx` | New v2-research render component + dispatch on version + kind |
| `tests/leak-suite/phase30-research-digest.test.ts` | Replace v1 briefing tests with v2 equivalents (Examples A, B, D, E) |

Any other file touched = scope drift; review should bounce.

---

## 11. Resolved decisions (was: open questions)

All inherited questions from docs/19 are LOCKED by Sneha 2026-05-18.

1. **Empty-batch briefing:** YES. Three-state behaviour per docs/19 §10.1.
   Empty-batch copy locked in §6 above.

2. **Token-budget cap:** 20 sources, score desc, top 20 win. Per
   docs/19 §10.2. If hit, set `qualityNote = "Capped at 20 of N sources
   by relevance score."` Diversification deferred until simple top-20
   demonstrably underperforms.

3. **Provenance taxonomy:** ship with all three values (`new` /
   `continuing` / `recurring`) per docs/19 §10.5. Revisit after first
   4 weeks of real usage.

4. **Failure copy:** human voice, no HTTP codes in user surface.
   Locked table in §6 above (classified by `InferenceError.errorClass`).
   Per docs/19 §10.4.

5. **Cross-run window:** most-recent prior briefing only. Per docs/19 §10.6.

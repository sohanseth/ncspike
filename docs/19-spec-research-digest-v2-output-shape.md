# docs/19 — ResearchDigest v2 Output Shape

**Status:** SPEC LOCKED — 2026-05-18 (Sneha)
**Owner:** Sneha
**Implementation PR:** TBD (must reference this doc; spec frozen before code)
**Relates to:** docs/13 (Phase 3 agent runtime), docs/16 (Phase 3.0 runtime), docs/18 (search provider)

---

## Problem statement

PR #22 shipped a briefing layer on top of the existing per-finding card list.
PRs #23 / #24 made the runtime resilient and the rendering honest. The
verification screenshot (2026-05-18) made one thing unambiguous: the unit of
output is wrong.

Today the agent emits **16 cards × ~80-word summary each ≈ 1300 words** for
the user to read, then asks them to mentally cluster, deduplicate, and extract
takeaways. That's the work the agent was supposed to do.

The screenshot's first four findings were "What is Red Teaming - Core
Security," "What is Red Teaming? | CrowdStrike," "Red Teaming - TryHackMe,"
"Sprocket Security | Red Teaming." **Four sources, one idea.** The agent kept
all four and gave each a paragraph.

The fix is not styling. It's the contract between template and inbox.

---

## The shift in one sentence

> The agent stops saying "Here are 16 articles" and starts saying "I checked
> 16 sources. There are 3 distinct ideas. One is worth reading."

The briefing becomes the product. Findings become evidence. The page inverts.

---

## 1. New output contract (`ResearchDigestBriefingV2`)

The existing `agent_runs.briefing` JSONB column is preserved as-is. v2 is a
new payload shape distinguished by `version: 2`. **No schema migration.**

```ts
type ResearchDigestBriefingV2 = {
  version: 2;

  /** One-line opinionated framing, ≤140 chars. Specific, not "N items found
   *  for M topics." Bad: "16 articles on red teaming." Good: "Today's red
   *  teaming batch was all explainer content — one piece adds methodology." */
  headline: string;

  /** 1-2 short sentences, ≤300 chars total. The synthesis paragraph. This is
   *  the "what to remember in a week" sentence. Memorable, not exhaustive. */
  synthesis: string;

  /** 1-5 takeaways, ordered most-important first. Each takeaway is a single
   *  concrete claim, ≤140 chars, with the source keys that support it.
   *  Empty array allowed if the batch produced no memorable claims. */
  memorableTakeaways: Array<{
    text: string;
    supportSourceKeys: string[]; // dedupeKey values from agent_findings
  }>;

  /** 0-3 sources to actually open. Empty array is valid — if nothing in the
   *  batch is worth opening, say so honestly. */
  readFirst: Array<{
    sourceKey: string;
    reason: string; // why this one, ≤200 chars
  }>;

  /** 0-N skip groupings. Each entry collapses a redundancy class. */
  skipOrCollapse: Array<{
    reason: string; // e.g. "Beginner definition of red teaming"
    sourceKeys: string[];
  }>;

  /** 0-N distinct ideas surfaced by the batch. Different from
   *  memorableTakeaways — this is taxonomic ("what topics did this cover")
   *  rather than memorable ("what should you remember"). May overlap. */
  distinctIdeas: Array<{
    label: string;
    summary: string; // one sentence
    sourceKeys: string[];
  }>;

  /** 0-3 questions the next run could investigate. The agent saying "I
   *  noticed this batch missed X — want me to look there next?" Optional
   *  but high-leverage for closing the loop. */
  nextSearchSuggestions: string[];

  /** Optional caveat. Used for "this batch was all introductory" /
   *  "sources were thin" — NOT for surfacing internal failure modes
   *  (no "LLM synthesis was unavailable" leakage to the user). */
  sourceQualityNote?: string;
};
```

**Validation:** Zod schema in `src/server/agents/templates/research-digest.ts`
mirroring `ResearchDigestBriefingSchema` (v1). All `sourceKeys` MUST be a
subset of the run's kept-finding `dedupe_key`s — validated server-side before
persistence. An invalid sourceKey means the LLM hallucinated; fall back per §7.

---

## 2. Source records (minimal)

The persisted `agent_findings` row shape is **unchanged** at the database
level (no migration). What changes is what v2 WRITES to it:

| Column | v1 behaviour | v2 behaviour |
|---|---|---|
| `title` | from search result | from search result (unchanged) |
| `source_url` | canonicalized URL | canonicalized URL (unchanged) |
| `dedupe_key` | canonicalized URL | canonicalized URL (unchanged) |
| `score` | LLM relevance score 0-1 | LLM relevance score 0-1 (unchanged) |
| `summary` | 80-word LLM summary | **NULL** (v2 doesn't persist per-source paragraphs) |
| `urgency` | template-defined | template-defined (unchanged) |
| `payload` | provider snippet | provider snippet (unchanged — used by briefing as scratch) |

`agent_findings.summary` becomes column-level dead weight for v2 rows. We
leave it NULL rather than dropping the column — v1 legacy rows still need it,
and a schema drop is out of scope. A follow-up could deprecate the column
after legacy rendering is sunset.

**The user-visible per-source paragraph is gone.** Per Sneha's adjustment,
the template MAY keep a short internal scratch summary during briefing
generation (the Tavily snippet from `payload` is already this — no extra LLM
call needed). The rule is:

> **No user-visible per-source paragraphs by default.**

---

## 3. Prompt objective

The current v1 prompt asks the LLM to "summarise this article" 16 times
independently. v2 asks **one question, once**:

> Given these N sources on these M topics, produce a memory-oriented briefing.

The prompt is structured around five questions, exactly the framing Sneha
articulated:

1. What 1-5 things should the user remember from this batch?
2. What is repetitive — which sources say the same thing as which others?
3. What's worth opening — which 0-3 sources deserve the click?
4. What can be skipped or collapsed?
5. What question should the next run ask?

**Input to the prompt:**
- Topic list (config-trust, same as v1)
- Per-source bundle: `dedupeKey`, `title`, `domain`, `score`, **Tavily snippet** (200-400 char raw text from search provider — no separate summarise hop)

**Hard rules (kept from v1, tightened):**
- Output is strict JSON matching `ResearchDigestBriefingV2` schema. No markdown.
- All `sourceKeys` referenced MUST exist in the input set.
- Epistemic hedging rules from PR #22 carry over verbatim: no broad-world
  absence claims, no definitive-best claims, "From this batch, X" framing.
- **NEW**: prefer "skip the rest" over "they're all useful." Honest framing
  of redundancy is the point of v2.

**Cost:** one LLM call per run (was 1-per-item + 1 briefing in v1).
For a 15-kept-item run: was 16 hops, now 1 hop. ~16× LLM cost reduction.

---

## 4. Clustering strategy

**The LLM is the clustering step.** No embeddings, no hand-rolled similarity.

Rationale:
- The whole batch fits in one prompt (15 sources × 400 chars = ~6k tokens, well under Groq's context window).
- Embedding-based clustering needs its own threshold tuning, a new RPC, and a vector store, none of which exists today.
- The LLM is the right tool for "are these saying the same thing in different
  words" — much better than cosine similarity on short snippets.
- This is the "without significant changes" constraint expressed correctly:
  we already had the LLM in the loop; we use it once for the right job.

If LLM clustering proves unreliable in production (e.g., 3+ runs in a row
that obviously fail to group duplicates), revisit with embeddings as Phase 2
work. Out of scope for v2 ship.

---

## 5. Inbox rendering rules

The inbox dispatches on `briefing.version`:

```
if (briefing?.version === 2)  → render v2 briefing-first layout
else if (briefing?.version === 1)  → render legacy (PR #24's flat path)
else (briefing IS NULL)  → render legacy (PR #24's flat path)
```

### v2 layout (one agent section)

```
┌────────────────────────────────────────────────────────────┐
│  AI research agent on Safety and Security                  │   ← agent name (existing)
├────────────────────────────────────────────────────────────┤
│  [headline — large, bold]                                  │
│  [synthesis — 1-2 sentences, muted]                        │
│                                                             │
│  WHAT TO REMEMBER                                          │
│  • [takeaway 1]            (3 sources)                     │
│  • [takeaway 2]            (1 source)                      │
│  • [takeaway 3]            (5 sources)                     │
│                                                             │
│  READ FIRST                                                │
│  ★ [title]  ↗                                              │
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
│  ▸ Sources checked: 16                                     │   ← collapsed by default
└────────────────────────────────────────────────────────────┘
```

### Rendering rules

- **Briefing is always rendered** when v2 payload exists. No conditional
  hide for "empty" briefings; the briefing IS the page.
- **`memorableTakeaways`**: render as bullet list. Per-bullet support count
  shown as small muted text (e.g. "3 sources"). Click expands to source links.
- **`readFirst`**: render with star icon + reason. If empty, omit section
  entirely (not "no read-first picks" placeholder text).
- **`skipOrCollapse`**: render with neutral styling (muted, no badge).
  Per-group source count visible.
- **`distinctIdeas`**: rendered ONLY if `memorableTakeaways` is empty (it's
  the lower-confidence sibling). If both populated, takeaways win.
- **`nextSearchSuggestions`**: render as muted list under "NEXT RUN COULD
  CHECK" heading. Omit section if empty.
- **`sourceQualityNote`**: render as small italic text under the synthesis,
  ONLY if present and ≤ 200 chars.
- **Sources disclosure**: `<details>` element, closed by default. Open
  shows the link list — title + domain + URL. **No summary, no badges,
  no score, no timestamp per source.** Just clickable links.

### What's NOT in the v2 render

- No "Useful" / "Background" / "Low priority" priority groups
- No per-finding cards with summary paragraphs
- No source-type badges (Expert/Company/etc.)
- No relevance score footers
- No "READ FIRST · N" header above a duplicated picks list (the takeaways
  ARE the synthesis; readFirst is the action list)

---

## 6. Legacy fallback rendering

Existing data on the deployed Supabase (pre-v2 ship):
- `briefing IS NULL` rows (any run before PR #22 ship)
- `briefing.version === 1` rows (PR #22-era runs, including the fallback ones)

Per Sneha: **do not migrate.** Treat them as legacy.

Legacy render path is **exactly what PR #24 already ships** — flat findings
list, no fabricated badges, no fake briefing block. That code stays as-is
and handles all `version !== 2` cases.

Future cleanup (out of scope for v2): when no agent has produced a v1
briefing or NULL-briefing run in 90+ days, the legacy render path can be
dropped. Until then, both paths coexist.

---

## 7. What happens when briefing fails

PR #22's silent deterministic-fallback approach was wrong. The user couldn't
distinguish "AI synthesized this batch" from "the LLM crashed, here's
canned text." v2 inverts that:

> **Briefing failure is visible. It is not silently masked with scaffolding text.**

### Failure modes and behaviour

| Failure | What happens | What user sees |
|---|---|---|
| LLM call throws (429, 5xx, chain exhausted) | Persist `briefing.version === 2` with `headline`, `synthesis` set to a clear failure message; ALL other fields empty arrays; `sourceQualityNote` = "Briefing could not be generated for this run." | Briefing block renders with the failure message + the sources disclosure (uncollapsed, since there's no synthesis to read). User can still scan titles. |
| LLM returns malformed JSON | Same as above (one retry first; if retry fails, failure briefing). | Same. |
| LLM returns valid JSON but invalid `sourceKeys` | Strip invalid sourceKeys; if any takeaway loses all its supportSourceKeys, drop the takeaway; if all takeaways drop, treat as malformed (above). | Best-effort render — surviving valid content shows. |
| `items_kept === 0` | Don't call briefing LLM at all. Persist `briefing.version === 2` with empty arrays and a synthesis = "I checked N sources today and nothing matched your topics above the relevance threshold." | Briefing block renders with the empty-batch message. No sources disclosure. |
| Run fails mid-flight (the score-loop crash mode) | `briefing` stays NULL — `agent_runs.status='failed'`. Inbox falls back to legacy render path for that section. | Legacy flat list. |

The principle: **the user always knows whether what they're reading is real
LLM synthesis or a system fallback.** No more "is this real or canned"
ambiguity. The fallback says so plainly.

---

## 8. Evaluation examples

These are the prompt's acceptance tests. Each describes inputs the briefing
prompt should be able to handle and the expected output shape. **An eval
harness is out of scope for the v2 ship PR**; these examples are the
manual-review checklist used during PR review and ad-hoc verification via
`scripts/run-one-agent.ts`.

### Example A — All-redundant batch (the actual 2026-05-18 case)

**Input:** 16 sources on "LLM Safety" + "red teaming," all explainer content
defining what red teaming is. One source (Sprocket Security) goes deeper into
methodology.

**Expected output shape:**
```json
{
  "version": 2,
  "headline": "Today's red teaming batch was all explainer content — one piece adds methodology.",
  "synthesis": "From this batch the sources agreed on the basics: red teaming means simulated adversarial testing of LLMs to expose weaknesses before real attackers do. Only one source added methodology specifics.",
  "memorableTakeaways": [
    { "text": "Red teaming = simulated adversarial testing to expose LLM weaknesses before deployment.", "supportSourceKeys": ["<key1>", "<key2>", "<key3>", "<key4>"] },
    { "text": "Sprocket Security adds methodology specifics worth reading.", "supportSourceKeys": ["<key5>"] }
  ],
  "readFirst": [
    { "sourceKey": "<key5>", "reason": "Only source in this batch with concrete methodology — the rest define the term." }
  ],
  "skipOrCollapse": [
    { "reason": "Repeats the basic definition of red teaming.", "sourceKeys": ["<key1>", "<key2>", "<key3>", "<key4>", "..."] }
  ],
  "distinctIdeas": [],
  "nextSearchSuggestions": [
    "Recent published red-teaming results on frontier models",
    "Tools or frameworks for automated red teaming"
  ],
  "sourceQualityNote": "Batch was heavy on beginner-level explainer content."
}
```

### Example B — High-signal batch

**Input:** 8 sources on "frontier model evaluations," including 2 papers,
3 blog posts from labs (Anthropic / OpenAI / DeepMind), 2 podcast
transcripts, 1 news article about a new benchmark.

**Expected output shape:** populated `memorableTakeaways` (3-5), populated
`readFirst` (2-3), populated `distinctIdeas` (3-4 distinct themes), short
or empty `skipOrCollapse`. Headline asserts a specific claim from the batch.

### Example C — Mixed batch with low-quality items

**Input:** 12 sources on "AI alignment," mix of 3 substantive (Anthropic
paper + EA Forum essay + interview), 6 generic news roundups, 3 SEO-spam
"top 10 AI safety companies" listicles.

**Expected output shape:** 1-2 `memorableTakeaways` from the 3 substantive
sources. `readFirst` points at the substantive sources only. The 6 news
roundups go into one `skipOrCollapse` group. The 3 listicles go into
another `skipOrCollapse` group with `reason` calling out the quality.
`sourceQualityNote` flags the quality dilution.

### Example D — Empty-after-dedup batch

**Input:** 5 sources on a niche topic, all the same content on different
domains (e.g., 5 mirror sites of one Wikipedia article).

**Expected output shape:** 1 `memorableTakeaway`, 1 `readFirst` (the
canonical source), 1 `skipOrCollapse` group containing the 4 duplicates.
Honest headline noting the redundancy.

### Example E — `items_kept === 0`

**Input:** 12 sources fetched, all scored below `minScore`. None kept.

**Expected output shape:** No LLM call. Briefing persisted with empty
arrays, synthesis = "I checked 12 sources today and nothing matched your
topics above the relevance threshold."

---

## Non-goals (explicitly out of scope for v2 ship PR)

- Embedding-based clustering (LLM-clustering ships first; revisit only if it fails in production)
- Eval harness automation (the examples above are manual review checklist)
- Sunsetting the v1 legacy render path (kept indefinitely for back-compat)
- Schema migration (the `agent_findings.summary` column stays; v2 leaves it NULL)
- Touching the agent runtime, batch, claim, lease, or budget surfaces
- Touching the inference dispatcher (PR #23 chain logic stays as-is)
- Changing the search provider layer
- Multi-agent briefings (each agent still produces its own briefing per run)
- Persisting the per-source Tavily snippet anywhere it isn't already (it's already in `agent_findings.payload`; v2 reads it from there)
- Cross-run synthesis ("compare this batch to last week's") — interesting, but a separate spec

---

## Implementation surface (for the next PR)

The next PR should touch only these files. If it touches anything else,
the PR scope is wrong and review should bounce it.

| File | Change |
|---|---|
| `src/server/agents/templates/research-digest.ts` | New v2 Zod schema, new prompt builder, briefing function rewritten to emit v2 shape, summarise function removed from call path (or left unused with a `@deprecated` JSDoc tag for the legacy column). The score loop is **untouched**. |
| `src/routes/workspace.inbox.tsx` | New v2 render branch in the agent-section loop. Existing legacy render stays as-is for `version !== 2`. |
| `tests/leak-suite/phase30-research-digest.test.ts` | Replace the v1 briefing-layer tests with v2 equivalents (happy path, malformed JSON, LLM throws, invalid sourceKeys stripped, `items_kept === 0` skip). The v1 tests can be deleted — no agent currently relying on v1 generation. |

**No migration. No new tables. No new RPCs. No new env vars.**

---

## Open questions (resolve before implementation PR)

1. **Should v2 briefing be persisted even on `items_kept === 0`?** This spec
   says yes (with the explicit "nothing matched" synthesis). Alternative:
   leave briefing NULL for empty runs and let the legacy path render
   "no findings." Sneha to confirm.

2. **Token budget cap on briefing input.** Spec assumes 15 sources × 400
   chars ≈ 6k tokens, comfortable. If runs ever return 30+ sources, do we
   truncate, summarise-then-cluster (re-introducing per-item LLM calls), or
   cap kept_items lower? Default position: cap input at 20 sources (highest
   score wins); flag if hit in `sourceQualityNote`.

3. **Should the legacy render path eventually be dropped?** Spec says kept
   indefinitely for back-compat. Sneha could pick a date / condition for
   sunset.

4. **What's the failure-mode message wording?** The "Briefing could not be
   generated" copy needs human voice, not engineering voice. The
   implementation PR should propose the exact copy for review.

---

## Acceptance criteria for v2 ship PR

The PR is mergeable when:

- [ ] `ResearchDigestBriefingV2` Zod schema exists + is validated server-side before persistence
- [ ] `briefing()` function emits v2 shape; never emits v1
- [ ] All `sourceKeys` are validated to exist in the run's kept findings
- [ ] `agent_findings.summary` is NULL on all v2-run rows
- [ ] Per-item `summarise()` is no longer called during the score/keep loop
- [ ] Inbox renders v2 briefing-first when `briefing.version === 2`
- [ ] Inbox renders PR-#24 legacy flat path when `briefing.version === 1` OR `briefing IS NULL`
- [ ] Failure modes produce visible-failure briefings, not silent scaffolding
- [ ] Sources `<details>` block is closed by default
- [ ] Tests cover: happy path, malformed JSON, invalid sourceKeys, LLM throws, `items_kept === 0`
- [ ] tsc clean on touched files
- [ ] One run via `scripts/run-one-agent.ts` against deployed Supabase produces a v2 briefing matching Example A or B shape (the verification gate)

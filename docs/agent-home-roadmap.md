# Agent Home — Roadmap & Design Rationale (supporting material)

**Status:** Reference / supporting doc (un-numbered intentionally — this is NOT an implementation spec)
**Paired with:** `docs/25-spec-agent-home.md` (the slim Phase 1 implementation spec)
**Last updated:** 2026-05-19

This doc holds the deferred phases, the broader product model, and the design history of the Agent Home decision. It exists so the implementer of docs/25 isn't drowned by philosophy, but the rationale is still accessible for future readers and for the next-phase specs.

If you are implementing Phase 1: **stop reading after the "Phase boundaries" section below.** The rest is for context only.

---

## Why this doc exists

The docs/25 implementation spec was trimmed from ~530 lines to ~250 (Sneha review 2026-05-19) after the observation that "a 500-line spec for a boring PR is a smell." The trimmed-out content lives here. The slim spec stays implementation-focused; this doc carries the why.

---

## The product model

| Concept | Meaning |
|---|---|
| **Agent** | Ongoing watcher of a topic |
| **Run** | One observation cycle |
| **Message** | One agent report from a run (a future durable record — Phase 2) |
| **Latest briefing** | The most recent run's report. NOT the same as accumulated state. (Phase 1 surface) |
| **Accumulated state** | Cross-run synthesis: durable themes, source-usefulness, "what we know about this topic." NOT in Phase 1. (Phase 3) |
| **Theme** | A durable cross-run synthesis cluster — detected by the agent over time (Phase 3) |
| **Manual thread** | A user-initiated sub-conversation or sub-watch under an agent (Phase 2) |
| **Artifact** | An optional export: report, mind map, deck, living-document. Generated FROM the home, never replacing it (Phase 4) |

Note the disambiguation: "branch" was used loosely in earlier drafts. Going forward we use **"manual thread"** for the user-driven sub-watch (Phase 2) and **"theme"** for the system-detected durable cross-run cluster (Phase 3). Do not collapse them under a single "branch" label until the product object actually exists.

---

## Important: Latest briefing ≠ accumulated state

This is load-bearing. Phase 1 surfaces "the latest run's report" + "a count of which hosts have appeared." Neither is cross-run synthesis. Calling the top section "Latest State" would over-promise.

True accumulated state — themes that emerged across runs, source-usefulness, durable interest detection, "what we know" synthesis — is Phase 3 work. The Phase 1 home is honest about being a wrapper, not synthesised intelligence.

We can graduate labels ("Current state" / "Current read") only when Phase 3 actually ships.

---

## Two anchor primitives

Every run updates BOTH:
- **Activity log** — a new entry in the timeline (this run's briefing)
- **Latest briefing surface** — refreshed if the run produced one

Phase 1 surfaces both. Neither alone is the product.

This was the core correction over earlier drafts:
- **"Agent Messages" framing was rejected** — risk of drifting into chatbot territory
- **"Living Document" framing was rejected** — risk of drifting into NotebookLM territory
- **Agent Home is the hybrid** — state-at-top, activity-below, neither dominates

---

## Track A vs Track B (parallel work streams)

**Track A — Container** (docs/25, this doc's primary subject)
- Persistence, timeline, status, source visibility
- Phase 1 in progress; Phases 2-4 sequenced below
- Outcome: agents feel persistent, not disposable

**Track B — Content** (docs/26 — queued)
- Synthesis depth: full-article fetch via Tavily `include_raw_content`
- Personalization: broker context fed into the briefing prompt
- Cross-run framing: "what changed" / "what matters to me" / "what to watch next"
- Outcome: agents say something memorable, not just specific

Phase 1 ships the wrapper; Track B ships the content. They are sequenced together but specced separately so progress on one doesn't gate the other.

---

## Phase boundaries

### Phase 1 — Read-only IA + persistence (docs/25)
- Route: `/workspace/agents/$agentId`
- Header + Latest briefing + Source coverage + Activity timeline
- Pure read-side UI over existing tables
- NO new tables, NO new writes
- See `docs/25-spec-agent-home.md` for the implementation spec.

### Phase 2 — User instructions and manual threads
- Introduces `agent_messages` table (deferred from earlier drafts; held until there's a real consumer)
- User can reply on the home page; replies stored as `user_instruction` messages
- Next run's briefing prompt picks up recent user instructions as adaptation context
- Some replies trigger config changes ("make this weekly", "ignore vendor blogs")
- Manual threads: user can say "track red-teaming separately under this agent"
- Read/unread state per timeline entry
- Open question: does each manual thread become its own sub-agent, or stay as a tag inside the parent agent's runs?

### Phase 3 — Detected durable themes
- Agent notices recurring sub-topics in its corpus over many runs
- Themes surface in the header signals (the "1 theme growing" copy from earlier draft examples)
- Source coverage gets a usefulness signal (which hosts have been consistently informative vs. always-skipped)
- The "Latest briefing" label may graduate to "Current state" or "Current read" here
- This is the phase where "accumulated state" actually exists

### Phase 4 — Derived artifacts
- Generate-X buttons on the agent home: report / mind map / deck / living-document export
- Outputs are GENERATED FROM the home, NEVER replace the primary surface
- This is where the NotebookLM-style multi-format menu fits — once we've earned it
- Load-bearing rule: artifacts are derivatives, not the home itself

---

## The agent_messages data model (deferred from Phase 1)

For when Phase 2 lifts this back in:

```sql
create table public.agent_messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  agent_run_id    uuid references public.agent_runs(id) on delete set null,
  role            text not null check (role in ('agent', 'user', 'system')),
  message_type    text not null check (message_type in (
                    'run_briefing',        -- agent's report from a run
                    'user_instruction',    -- user reply on the home page
                    'system_status',       -- agent lifecycle events
                    'derived_report'       -- Phase 4 generated artifact
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

Phase 2's first concrete need: `user_instruction` rows. Phase 4 reuses for `derived_report`. Phase 1 has no consumer, so no table.

---

## Data contract — fallback rendering (Phase 1 simplified version)

The full fallback chain from earlier drafts has been simplified into docs/25 §7 / §8 (Empty/degraded states + Status taxonomy). The earlier draft's 5-step rendering chain was overengineered; Phase 1 only needs the 4 degraded states actually rendered:

1. **No runs yet** → empty-state copy
2. **`status='ok'` + briefing populated** → render v2 (or legacy v1 fallback to PR #24 path)
3. **`status='ok'` + briefing NULL** → "No briefing available for the latest run"
4. **`status='failed'|'timeout'|'skipped_*'`** → status-specific degraded copy

That's the contract. See docs/25 §7 + §8 for the exact rules.

---

## Why not chat, why not document

### Why not "Agent Messages" (chat thread per agent)
Rejected 2026-05-18. Risks:
- Implementation drifts toward chatbot UI ("AI Safety Agent — message — message — reply box")
- That violates NC's product thesis (cognitive-load reducer, not another chatbot)
- A pure thread is good for chronology, weak for accumulated understanding

### Why not "Living Briefing" (evolving document)
Rejected 2026-05-18. Risks:
- Drifts toward NotebookLM-style documentware
- Pulled into diff UI / versioning / editing / export
- Loses the "persistent agent" framing — feels like editing a doc, not having an agent
- A pure document is good for synthesis, weak for interaction and cadence

### What Agent Home is instead
A hybrid surface where the agent has a home — state on top, activity log below, neither dominates. The agent feels persistent. The activity is inspectable. The content fits its right shape (latest briefing) without becoming the whole product.

---

## What this isn't fixing — be honest

Phase 1 of Agent Home **does not fix**:
- Weak synthesis (Track B)
- Weak personalization (Track B)
- No cross-run trend memory (Phase 3)
- "Why this matters to me" (Track B)
- No durable-interest detection (Phase 3)
- No compounding insight surface (Phase 3 + Track B)

If a user opens Phase 1 Agent Home expecting "I learned something new from this," they will be disappointed, because the content underneath is the same v2 briefing PR #26+27 produced. The improvement is IA, not intelligence.

That's why the strict sequencing is:
1. Ship Agent Home Phase 1 (this spec)
2. **Immediately** open docs/26 (Personalized briefing v3 — Track B)
3. Don't open Phase 2 of Agent Home until Track B has produced content worth wrapping

---

## History — how we got here

| Date | Step | Outcome |
|---|---|---|
| 2026-05-18 | Sneha critiqued post-PR-#27 inbox as "still bland — I learned nothing" | Refocused on artifact shape, not prompt |
| 2026-05-18 | First brainstorm: chat-vs-code, then 12 NC-native artifact types | Selected: "Agent Messages" thread-per-agent |
| 2026-05-18 | Self-critique: thread-per-agent risked chatbot drift | Re-pivoted to "Agent Home" hybrid |
| 2026-05-18 | First draft of docs/25 (530 lines, 14 sections, agent_messages table in Phase 1) | Sneha review: too sprawling; agent_messages vestigial |
| 2026-05-19 | Trimmed to ~250-line implementation spec + this roadmap doc | Phase 1 reads existing tables only |
| 2026-05-19 | Locked: spec is Track A only; Track B (content quality) sequenced separately as docs/26 | Honest framing in place |

---

## Open product questions (beyond Phase 1)

These don't block Phase 1 ship but should be resolved before the corresponding later phase:

1. **Phase 2 manual threads**: separate sub-agents or tags inside the parent agent?
2. **Phase 3 theme detection**: LLM-driven (one extra call per run) or embedding-clustering (separate infra)?
3. **Phase 3 graduation of "Latest briefing" label**: at what point does it become "Current state"? (Criteria: ≥3 detected themes with ≥4 runs of evidence?)
4. **Phase 4 artifact priorities**: which format ships first — report, mind map, deck, or living-document export?
5. **Track B priorities**: personalization vs full-article fetch vs cross-run framing — which first?

Each of these gets resolved in the corresponding phase/track's own spec, not here.

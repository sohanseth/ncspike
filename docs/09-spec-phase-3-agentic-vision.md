# Spec — Phase 3: The Agentic Layer (vision draft)

*Status: **Draft v0** — discussion document, not yet locked · Owner: Sneha · Depends on: Phase 2.7 D8 (trait sheet + context broker), Phase 2.8 (voice), Phase 2.6 (chat) · Target: 4-6 weeks of focused build after Phase 2 lands · Pairs with: future docs/10 (extension spec), docs/11 (morning-surface spec)*

> **Why this exists.** Phase 2 builds a privacy-respecting AI chatbot. The user's actual vision is bigger: an agent that *lives with you*, watches your behaviour across the surfaces you let it into, and *acts on its own* — researching things you'd care about overnight, organising what it finds, and reshaping the product around how *you specifically* use it. Phase 3 is that pivot from "tool" to "agent." This document is the v0 framing — enough to align on what we're building before we write the engineering spec.

---

## 1. The vision in one paragraph

NeuralConnexions becomes the user's **always-on personal staff**. While the user sleeps, an agent reads what's new in their watched surfaces (browsing, calendar, email subjects, voice notes, shopping carts), notices the things that match what they care about, *does the legwork* — researching products, comparing options, drafting summaries, queueing decisions — and surfaces the result as a morning briefing the user reviews over coffee. Each user's home screen is rearranged by the system to surface what *that user* engages with most. Two NeuralConnexions accounts feel like two different products.

---

## 2. Goal & non-goals

**Goal.** Ship the four shifts that turn the v2 product from "AI chat with memory" into "personal AI agent":

1. **Behavioural ingestion.** A first-party browser extension + opt-in importers (calendar, contacts, email metadata) feed structured signal into the existing memory store the Phase 2.7 broker reads from.
2. **Proactive overnight agent.** The 03:00 research-cron grows from "extract trait sheet" to "schedule and execute a queue of research tasks the user would want done."
3. **Morning surface.** A new home screen — the **Inbox** — replaces ChatPanel as the default route. The Inbox is the agent's outbox: completed research, suggested actions, things to bookmark.
4. **Adaptive UI.** The home layout, sidebar shelves, and quick actions reorganize per user based on engagement signal. Cookware-engaged users get a Recipes shelf; deal-hunters get a Deals shelf. *No two installs look identical after a month of use.*

**Non-goals (explicit).**
- **No new model providers.** Phase 3 reuses the Phase 2.6 Fast/Pro/Genius/Private chain. Agents pick a badge per task; routing logic doesn't change.
- **No multi-agent / agent-spawning-agent.** Phase 3 is a *single* agent operating on a queue, with hand-coded skills (Research, Compare, Summarise, Notify). LangChain-style autonomous planning loops are explicitly Phase 4.
- **No write-actions to third-party services.** The agent reads from connected services and produces *suggestions* the user reviews and accepts. It never sends an email, never posts to a calendar, never adds-to-cart on the user's behalf in v3.0. Acting on the user's behalf is Phase 3.5+ once trust is established.
- **No real-time UI adaptation.** Layout reshuffles happen overnight on the same cron, not mid-session. Adapting the UI as the user types is Phase 4.
- **No mobile native shell yet.** Phase 3 ships web + PWA. Native shell agentic surfaces wait until Phase 2.5's runbook is complete.

---

## 3. Architecture sketch (v0)

```
┌──────────────────────────────────────────────────────────────────┐
│                      User-facing surfaces                         │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ Inbox   │  │ Library  │  │ ChatPanel  │  │ Adaptive Shelves │ │
│  │ (home)  │  │(bookmark)│  │ (existing) │  │ (sidebar/grid)   │ │
│  └────┬────┘  └────┬─────┘  └─────┬──────┘  └────────┬─────────┘ │
└───────┼────────────┼──────────────┼──────────────────┼───────────┘
        │            │              │                  │
        ▼            ▼              ▼                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     server (TanStack Start)                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  ┌─────────┐ │
│  │ inbox.fns  │  │library.fns │  │chat.fns(broker)│  │layout.fn│ │
│  └─────┬──────┘  └─────┬──────┘  └────────┬───────┘  └────┬────┘ │
│        │               │                  │               │      │
│        ▼               ▼                  ▼               ▼      │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │       Trait Sheet  +  Memory Store  +  Engagement Log    │    │
│  │              (the brain — Phase 2.7 + Phase 3)            │    │
│  └────┬───────────────────────┬──────────────────────────────┘    │
└───────┼───────────────────────┼───────────────────────────────────┘
        │                       │
        ▼                       ▼
┌────────────────┐    ┌──────────────────────────────────────────┐
│ Cloudflare cron│    │ Behavioural ingestion (Phase 3 NEW)      │
│ (existing)     │    │ ┌──────────────┐ ┌─────────────────────┐ │
│                │    │ │ NC Extension │ │ Calendar / Contacts │ │
│ Trait extract  │    │ │ (Chrome/FF)  │ │ Email importers     │ │
│ AGENT QUEUE ▼  │    │ └──────┬───────┘ └──────────┬──────────┘ │
│ (Phase 3 NEW)  │    │        ▼                    ▼            │
│                │    │      [user_signal_events table]          │
└────────────────┘    └──────────────────────────────────────────┘
```

The **brain stem is already built** (Phase 2.7 trait sheet + memory store). Phase 3 adds three new boxes around it: ingestion (left), agent queue runner (top-left, extending the cron), and four new user surfaces (top).

---

## 4. The four shifts in detail

### 4.1. Behavioural ingestion

**What:** A first-party browser extension that, with explicit per-domain user permission, captures URL, page title, time-on-page, and (opt-in, off by default) selected text. Plus opt-in importers for Google/Outlook calendar, contacts, and email subject metadata (never bodies in v3).

**Where the data goes:** A new `user_signal_events` table — append-only, partitioned by week, cleaned up at 90 days unless promoted to a memory or a bookmark by the user or the agent. Schema is intentionally narrow: `user_id, source, event_type, url_or_id, title, occurred_at, raw_payload jsonb`.

**Privacy posture:** The extension defaults to *off* on every domain — user opts each domain in individually, with one-tap revoke. Banking/medical domains are on a hard blocklist. The extension never sends raw page HTML. All ingested signal flows through the same Phase 2.7 trait extractor + scrub layer before it touches any prompt.

**What it unlocks:** the agent finally knows the user's *interests as expressed by what they actually do*, not just what they type into chat.

**Build effort:** ~2 weeks (extension is most of it; importers reuse OAuth flows the platform already needs for calendar/email).

---

### 4.2. Proactive overnight agent

**What:** The existing 03:00-local research-cron gets a second job: drain an **agent task queue**. Tasks are seeded from three sources:

- **From signal.** "User looked at 5 espresso machines this week and bookmarked one. Queue: research the bookmarked one + 3 alternatives, draft a comparison."
- **From traits.** "Trait sheet says user has a child in the 6-9 age band, sport=football. Queue: weekly check for relevant football events / kit deals in their region."
- **From explicit asks.** "User said 'remind me to look at flights to Tokyo next month.' Queue it for 30 days out."

Tasks are typed (a small set of skills: `research`, `compare`, `summarise`, `watch`, `remind`). Each skill is a hand-coded function that uses the existing chat infrastructure under the hood — same providers, same broker, same scrub. *The agent doesn't get to invent its own tools in v3.* Every skill produces an **inbox item**: a structured artifact the user reviews next morning.

**What it does NOT do:** the agent never acts on the user's behalf in v3. It produces drafts, suggestions, comparisons. The user clicks "do this" or "ignore." Trust gate: until the user has accepted >50 inbox items, "do this" buttons that touch external services are disabled.

**Build effort:** ~2 weeks (queue runner + 5 skills + inbox-item schema).

---

### 4.3. The Inbox (morning surface)

**What:** New route `/inbox`, becomes the default landing page after login (replacing direct-to-chat). Card-based feed. Each card is one inbox item: research summary, comparison table, deal alert, draft note, etc. Three actions per card: **Save** (sends to Library), **Dismiss**, **Tell me more** (opens a chat thread pre-loaded with the item as context).

**Why this is the right home screen:** chat is reactive. The Inbox is what the agent *did for you* while you were away. That's the product's promise made visible every morning. Chat becomes a sub-surface accessed when the user wants to dig into a specific item.

**Build effort:** ~1 week (route + card components + the Save→Library flow).

---

### 4.4. Adaptive UI (v0 — earned shelves)

**What:** The home grid below the Inbox shows **shelves** — themed sections (Recipes, Deals, Travel, Reading List, etc.). Shelves are *earned*: a shelf appears for a user when their engagement crosses a threshold for that theme (e.g. 10+ saved recipe cards in 30 days unlocks a Recipes shelf; 5+ flight searches unlocks a Travel shelf). Shelves disappear when engagement decays.

**Why it's "v0":** the v3 implementation is **nightly recompute** of "which shelves exist for this user, in what order." No live ML, no real-time personalisation, no per-component A/B. That's plenty to make two installs feel different without taking on the model-debt of true real-time adaptation.

**Build effort:** ~1 week (shelf registry + nightly engagement-scoring job + the home grid component).

---

## 5. What this means for Phase 2.7 (the work I'm on right now)

**Phase 2.7 D8 stands as designed.** The Context Broker is the prerequisite for everything in Phase 3 — the agent needs the trait sheet to know what to research, and it needs the broker to talk to LLMs without leaking. Nothing about Phase 3 changes the D8 spec.

**Two small forward-compatibility notes** I'll keep in mind through D8 Days 2-7 so we don't have to rip up D8 work in Phase 3:

1. **`source_memory_ids` should be source-typed, not bare UUIDs.** Phase 3 ingests browsing events, not just "memories." The trait extractor should accept `{kind: 'memory'|'signal'|'calendar'|...; id: uuid}` instead of bare UUID strings, so Phase 3 can feed signal events through the same extractor without a schema migration. **Action: I'll widen the schema in D8 Day 2 when I write the extractor — no cost now, big cost later.**
2. **The broker should be cheap to call from non-chat surfaces.** Currently `assembleSystemPrompt({userId, query, badge, strictestTierInChain})` assumes a chat context. Phase 3 agent skills will want personalisation too ("research espresso machines that match this user's preferences"). The function shape already works for that — `query` can be the agent's research prompt, `badge` is whatever badge the skill picked. **No change needed in D8.** Just calling it out so I don't accidentally couple it to ChatPanel during Day 4 wiring.

---

## 6. Phase 3 build sequence (rough order, not yet locked)

| Order | Slice | Dependencies | Effort |
|---|---|---|---|
| **3.0** | `user_signal_events` schema + ingestion API endpoints | Phase 2.7 lands | 2 days |
| **3.1** | Browser extension v1 (Chrome MV3) — domain opt-in, URL+title only | 3.0 | 8 days |
| **3.2** | Calendar + Contacts importers via existing OAuth | 3.0 | 3 days |
| **3.3** | Agent task queue + first 2 skills (research, summarise) | Phase 2.7 + 3.0 | 5 days |
| **3.4** | Inbox UI + inbox-item schema + Save flow | 3.3 | 5 days |
| **3.5** | Library (bookmarks) | 3.4 | 3 days |
| **3.6** | Remaining 3 skills (compare, watch, remind) | 3.3 | 4 days |
| **3.7** | Adaptive shelves v0 (engagement scoring + nightly recompute + home grid) | 3.4 + 3.5 | 5 days |
| **3.8** | Onboarding flow that introduces the agent paradigm | 3.4 | 3 days |
| **3.9** | Privacy-posture docs + per-source revoke UI + signal-data export | all above | 3 days |

**Total: ~41 working days = 8-9 weeks at single-track pace, 5-6 weeks if Lovable runs UI surfaces in parallel.**

---

## 7. Open questions for the user (Sneha) before locking v1

These are the calls I can't make alone — they're product decisions, not engineering ones:

1. **Browser support priority.** Chrome only at launch, or Chrome + Firefox? (Chrome alone covers ~65% of desktop; Firefox adds ~3% but doubles extension maintenance.)
2. **Importers list.** Beyond calendar + contacts, what's table-stakes? Email metadata? Banking-transaction CSVs (manual upload)? Spotify/YouTube history?
3. **Bookmark / Library ergonomics.** Is the Library a flat list, folders, or auto-organised by the agent? My instinct: auto-organised with manual override.
4. **Trust gate threshold.** I proposed "50 accepted inbox items before write-actions unlock." Is that the right shape, or should it be time-based ("30 days of use") or removed entirely?
5. **Pricing model implication.** An overnight agent burns provider credits even when the user is asleep. Free tier needs a daily task budget. Worth specifying now, before billing lands.
6. **Public stance on "the agent watches your browsing."** Marketing copy needs to be unambiguous. Suggested framing: *"NeuralConnexions watches only what you let it. You name every domain, you can revoke any of them in one tap, and your raw browsing never leaves your device — only the patterns the agent learned from it."* Lock this language now or in Phase 3.9?

---

## 8. What this changes about how I work over the next 2 weeks

**Nothing immediately.** D8 continues as planned. I'll keep this doc open in a tab and revise it after each D8 day with anything I learn that shifts the Phase 3 picture. By the time D8 lands (~6 working days from now), this doc should be ready to upgrade from v0 → v1 (locked enough to start building from), and we'll have the answers to Section 7 from you.

**Concrete asks of you (Sneha):**
- Skim this doc when you have 15 minutes, push back on any framing that doesn't match what you actually want.
- Answer Section 7 questions in your own time over the next week.
- Tell Lovable about Phase 3 framing so they're not surprised when the home screen pivots from ChatPanel to Inbox.

---

## 9. v1 lock proposals (drafted 2026-05-08, post Phase 2.7 D8)

D8 has landed. Phase 2.6 architect review (2026-05-09 tightening pass) came
back APPROVED clean — no severe findings on the shipped surface; the known
cap-atomicity TOCTOU is tracked under Tasks #8 / #15. Phase 2.7 architect
review (same pass) flagged two severe fail-OPEN paths against the "no
silent fallbacks" rule in `replit.md`:

1. `resolveBadgeForUser()` returned the requested HOSTED badge on a
   `user_settings` lookup error — a Strict-mode user could be silently
   routed to OpenAI/Anthropic during a Supabase hiccup.
2. Broker blocklist loaders (`loadTraitBlocks`, `loadProviderCategoryBlocks`)
   returned empty sets on DB error — user-explicit exclusions could be
   silently bypassed.

Both fixed in-session: the badge resolver now coerces to PRIVATE on DB
failure (with a distinct `coercedFromDbFailure` telemetry flag), and the
broker now throws `BlockListUnavailableError` which `assembleSystemPrompt`
catches as `scrubBlocked: true` (empty fragment, `blocklist_unavailable`
audit row). New regression suite `tests/leak-suite/fail-closed-blocklist.test.ts`
pins both behaviours; vitest baseline is now 122/122 + 3 skipped real-DB.
Architect re-review: APPROVED. CPAUD viewer remains up at
`/workspace/internal/cpaud`.

The §7 questions are listed below with my **proposed answer** (so you can
reply with one round of "yes / no / change to X" instead of writing them
from scratch). Anything marked **NEEDS YOU** is a genuinely product call
I can't make alone; everything else I'm willing to lock if you just say
"agree."

### 7.1 Browser support priority

**Proposal: Chrome MV3 only at launch.**

Rationale: Firefox MV3 support landed but is materially behind on the
declarative-net-request and content-script lifecycle bits we need; the
~3% audience does not pay for the maintenance second-axis. We can revisit
once Phase 3.7 is shipped and we have actual user telemetry on browser mix.

**Locks if you agree.** No further input needed.

### 7.2 Importers list

**Proposal for v1 (Phase 3.2 + 3.6 spillover):**

| Importer | Why | Effort | Phase |
| --- | --- | --- | --- |
| Calendar (Google) | already have OAuth | S | 3.2 |
| Contacts (Google) | already have OAuth | S | 3.2 |
| Email metadata (Gmail, headers + label only — no bodies) | high-signal for "what is this person to me" | M | 3.2 stretch |
| Manual CSV uploads (banking, fitness, etc.) | covers the long tail without per-vendor OAuth | M | 3.6 |

**Explicitly out for v1**: Spotify, YouTube history, banking-API
integrations (Plaid-class). They're either privacy-spicy (bank), low
trait-density (Spotify play history rarely changes a recommendation), or
require a vendor relationship we don't have (YouTube watch history is
not a public API).

**NEEDS YOU**: confirm "email metadata, headers + label only, never bodies"
is the right floor. The risk is users will *want* the agent to read their
inbox, but that crosses the broker's T3-blocked-content line and would
need a separate spec.

### 7.3 Bookmark / Library ergonomics

**Proposal: auto-organised with manual override.**

- Default view is "Recently saved" (flat reverse-chronological).
- Agent runs a nightly clusterer (cheap embedding-based, T0 only) that
  proposes 3-7 collections per ~50 saved items. The user accepts/rejects
  each suggestion.
- Manual folders are always allowed and never auto-mutated.
- No tag system in v1 — too much UI surface area for unproven value.

**Locks if you agree.** Rejection means I default to flat list + manual
folders, no auto-organisation, which is shippable in half the time.

### 7.4 Trust gate threshold for write-actions

**Proposal: behaviour-based, not count-based, with an explicit on/off.**

Replacing the original "50 accepted inbox items" with:

- Write-actions (compose draft, set calendar event, send email) are
  **opt-in per skill**, off by default.
- The first time a skill wants to write, the inbox surfaces a one-time
  "always allow this skill to write?" toggle.
- No global threshold. Counts are gameable and time-based gates feel
  arbitrary; per-skill explicit consent is what users will actually
  trust.

**Locks if you agree.** This also simplifies the Phase 3.3 task-queue
spec — no per-user trust-score column.

### 7.5 Pricing model implication (overnight agent budget)

**Proposal for free tier:**

- Daily agent-task budget = **8 task-runs/day**, with at most **2 of
  those at PRO badge** (the rest must complete on FLASH or PRIVATE).
- Hard kill at the budget — no fallback to a lower tier, the task just
  defers to tomorrow with an inbox notice.
- CPAUD ceiling stays $1.50/user/day per Phase 2.6 §2; agent runs count
  the same as user-initiated runs.

Justification: 8 tasks × ~$0.04 (PRO median) = $0.32 if everything went
PRO; with the 2-PRO cap it's ~$0.20/day worst case for an idle user the
agent runs jobs for. Comfortably under target.

**NEEDS YOU**: confirm 8 is the right number, or pick another. I'd argue
against any number > 12 (CPAUD risk) and against any number < 5 (agent
becomes useless).

### 7.6 Public stance on "the agent watches your browsing"

**Proposal: lock the language now, in this doc, exactly as drafted in §7.**

Reproduced for clarity:

> **NeuralConnexions watches only what you let it. You name every
> domain, you can revoke any of them in one tap, and your raw browsing
> never leaves your device — only the patterns the agent learned from
> it.**

This becomes the canonical copy used in: the browser-extension install
screen, the Phase 3.9 privacy-posture doc, the App Store description,
and the marketing site. Locking it now means Lovable's onboarding work
in 3.8 cites a single source of truth.

**Locks if you agree.** Edits welcome.

### Summary of what I need from you to lock v1

You can answer in one round:

1. §7.1 Chrome-only? **(default: yes)**
2. §7.2 importers list as above + "email headers only, never bodies" floor? **(NEEDS YOU)**
3. §7.3 auto-organised Library? **(default: yes)**
4. §7.4 per-skill opt-in trust gate? **(default: yes)**
5. §7.5 free-tier agent budget = 8/day with 2 PRO max? **(NEEDS YOU on the number)**
6. §7.6 lock the marketing language as written? **(default: yes)**

Any "yes" or silence on a default-yes line will be taken as approval and
locked into v1. The two NEEDS YOU items genuinely block v1.

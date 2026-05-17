# Spec — Phase 3.0–3.5: Agent runtime + curated template marketplace

**Status:** **v1 LOCKED — 2026-05-15.** Open questions in §18 closed in
coordination with Sneha; decisions are now binding for implementation.
Supersedes docs/09 §4.2 (the single overnight agent) with a multi-agent
runtime; the rest of docs/09 (Inbox, adaptive UI, behavioural ingestion)
stays as written.
**Owner:** main agent (runtime, scheduling, broker integration,
GDPR wiring, template framework, JobAgent + ResearchDigest); native
dev for the iOS background-fetch hooks if/when 3.x adds them.
**Lovable-lane note:** this phase touches the chat pipeline, broker,
trait-sheet read path, and adds new per-user tables — all out of
Lovable's lane. No voice/converse surface changes.
**Depends on:** Phase 2.7 (broker + trait sheet), Phase 2.8 (voice —
not blocking, but agents reuse the converse surface for spoken
digest), Phase 2.9 (image-out — used by ShoppingAgent for product
thumbnails on capable devices).

> **Frame.** docs/09 painted Phase 3 as one system-owned overnight
> agent. The user's actual intent is a generalisation of that:
> instead of one system-owned proactive agent, we support **many
> user-owned watchers**, each scoped to one stated concern (job
> search, outfit hunt, deal alerts, weekly research digest). Each
> watcher is durable, deduped over time, and surfaces only the
> genuinely new. The product is "personal AI staff," not "AI chat
> with extras."

---

## 1. Why this phase exists

Two things the chat surface can't do today no matter how good
PRIVATE / FLASH / PRO / Genius are:

1. **Persistence.** A user job-searching for three months currently
   has to re-explain context every conversation. The trait sheet
   helps, but it can't *act between sessions*. A watcher does.
2. **Patience.** Deep research at chat speed costs the user 60–120 s
   of attention per turn. A watcher works in the background and
   surfaces a finished result in the morning.

Together, persistence + patience + dedupe is the difference between
"AI chatbot" and "personal staff."

---

## 2. Goal & non-goals

**Goal.** Ship a **per-user agent runtime** + a **curated template
marketplace** of ≥ 3 templates that demonstrate the runtime is real,
plus the read-only Inbox surface that displays findings. By the end
of Phase 3.5, trusted templates can produce *drafts* of write-actions
(email replies, cart contents) that the user reviews and accepts —
they cannot send/buy on the user's behalf.

**Non-goals (explicit).**
- **No generative agents.** Users do not author tool-calling DSL in
  v1. They pick a template and configure it in plain English; the
  template's tools are hand-coded and security-reviewed. Generative
  agents are Phase 4+.
- **No scraping of locked-down platforms.** LinkedIn, Indeed,
  Glassdoor, and any retailer that explicitly blocks crawlers are
  out of scope at every phase. Adding a new data source requires
  legal review against the source-policy matrix in §10.
- **No autonomous write-actions in 3.0–3.4.** The agent suggests; the
  user accepts. 3.5 adds *draft-only* write-actions (email drafts in
  the user's outbox, populated cart not checked out). Sending,
  purchasing, calendar-writing on the user's behalf is Phase 4+.
- **No multi-agent coordination.** Each watcher is independent.
  Agents do not call each other, share queues, or depend on each
  other's output. Cross-agent synthesis (e.g. "JobAgent feeds
  ResumeAgent feeds InterviewPrepAgent") is Phase 4+.
- **No real-time streaming.** Agents run on a schedule
  (FLASH/PRO/Genius via Cloudflare cron, PRIVATE on app open). They
  do not push live updates to the chat surface.
- **No native mobile background execution beyond what the OS gives
  us for free.** iOS background-fetch is throttled and
  unreliable; we ship "runs when open" for PRIVATE and document
  the trade-off rather than fight the OS.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  User browser / native shell                                          │
│  ┌────────────────────────────┐   ┌──────────────────────────────┐    │
│  │ /workspace/inbox (home)    │   │ /workspace/agents (manage)   │    │
│  │ — agent findings           │   │ — list, create from template,│    │
│  │ — accept / dismiss / archive│   │   pause, archive             │    │
│  └────────────┬───────────────┘   └──────────────┬───────────────┘    │
│               │                                  │                    │
│               │   server fns                     │                    │
└───────────────┼──────────────────────────────────┼────────────────────┘
                │                                  │
┌───────────────▼──────────────────────────────────▼────────────────────┐
│  Supabase                                                              │
│  ┌──────────────┐ ┌──────────────────┐ ┌─────────────────────────┐    │
│  │ agents       │ │ agent_runs       │ │ agent_findings          │    │
│  │ (definition) │ │ (run history)    │ │ (per-finding state)     │    │
│  └──────────────┘ └──────────────────┘ └─────────────────────────┘    │
│  ┌──────────────────────────────┐                                      │
│  │ agent_state                  │  per-agent KV for dedupe / cursors  │
│  └──────────────────────────────┘                                      │
└─────────────────────────────────────┬──────────────────────────────────┘
                                      │
        ┌─────────────────────────────┴────────────────────────────┐
        │                                                          │
┌───────▼──────────────┐                                ┌──────────▼─────────┐
│ Cloudflare cron      │                                │ Client-side runner │
│ + Durable Objects    │                                │ (PRIVATE only,     │
│ — fires every ≥ 1 h  │                                │  on app launch)    │
│ — for FLASH/PRO/     │                                │ — for PRIVATE      │
│   Genius agents      │                                │   agents           │
└───────┬──────────────┘                                └──────────┬─────────┘
        │                                                          │
        └────────────────────────┬─────────────────────────────────┘
                                 │
                  ┌──────────────▼──────────────────┐
                  │ AgentRunner.execute(agent)      │
                  │  1. claim run lock              │
                  │  2. broker.assemble(scope)      │
                  │  3. template.fetch()            │
                  │  4. dedupe vs agent_state       │
                  │  5. template.score() + filter   │
                  │  6. persist findings            │
                  │  7. enqueue notifications       │
                  │  8. release lock + write run row│
                  └─────────────────────────────────┘
```

The runner is the same code on both sides — `AgentRunner.execute()`
is platform-agnostic, with adapters for "fetch via server-side fetch
in Cloudflare" vs "fetch via client-side fetch in the browser." Tier
policy enforced by the existing broker: PRIVATE agents only call
on-device LLM hops, never reach a hosted provider.

---

## 4. Agent lifecycle states

Every agent is in exactly one state. Transitions are explicit and
logged.

| State | Meaning | Runner behavior | UI affordance |
| --- | --- | --- | --- |
| `draft` | User is configuring; not yet activated | skip | "Finish setup" |
| `active` | Running on schedule | run | normal |
| `paused` | User explicitly paused | skip | "Resume" |
| `degraded` | ≥ N consecutive run failures (default 5) | run with backoff | yellow badge |
| `inactive` | Has not produced a useful finding in M days (default 30) | run at half cadence | "Keep or archive?" prompt |
| `error` | Hard failure (template removed, source permanently gone) | skip | "Investigate" |
| `needs_user_attention` | Run produced a finding marked urgent OR the agent needs reconfiguration (e.g. source moved) | next run waits for user | top of Inbox |
| `archived` | User archived; data retained per retention policy | skip | hidden by default, restorable |

State transitions:

```
draft        → active (user clicks "Activate")
active       → paused (user clicks "Pause")
active       → degraded (5 consecutive failed runs)
active       → inactive (30 days no useful findings)
active       → error (template deprecated or hard failure)
active       → needs_user_attention (urgent finding OR reconfig needed)
paused       → active (user clicks "Resume")
degraded     → active (one successful run)
degraded     → error (20 consecutive failed runs)
inactive     → active (user accepts "Keep" prompt)
inactive     → archived (user accepts "Archive" prompt OR no
                          interaction in 30 more days)
needs_user_attention → active (user resolves)
any          → archived (user clicks "Archive")
archived     → active (user restores)
```

The `inactive` → `archived` auto-transition is the abandonment
guardrail — without it the trait sheet bloats and the broker loses
focus on what the user actually cares about.

---

## 5. Data model

Four new tables. All per-user, all wired into GDPR export + delete
RPC (see §15 — `delete_user_data()` gets a new migration).

### 5.1 `agents`

```sql
create table public.agents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  template_id     text not null,                -- 'job', 'research_digest', 'shopping', 'deal_watcher'
  display_name    text not null,                -- user-facing name, e.g. "Senior backend roles SF"
  config          jsonb not null,               -- template-specific config (see §7)
  badge           text not null,                -- 'private' | 'flash' | 'pro' | 'genius'
  state           text not null default 'draft',-- §4 state machine
  cadence_hours   int  not null default 24,     -- minimum hours between runs
  budget          jsonb not null,               -- §11 agentBudget shape
  notify          jsonb not null,               -- §13 notification preferences
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_run_at     timestamptz,
  last_useful_at  timestamptz,                  -- last run that produced ≥ 1 accepted finding
  consecutive_failures int not null default 0
);

create index agents_user_state_idx on public.agents (user_id, state);
create index agents_due_idx on public.agents (state, last_run_at) where state in ('active', 'degraded', 'inactive');

alter table public.agents enable row level security;
create policy agents_owner_all on public.agents
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
```

### 5.2 `agent_runs`

```sql
create table public.agent_runs (
  id            uuid primary key default gen_random_uuid(),
  agent_id      uuid not null references public.agents(id) on delete cascade,
  user_id       uuid not null,                  -- denormalised for RLS + per-user retention
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null,                  -- 'running' | 'ok' | 'failed' | 'cancelled' | 'budget_exceeded'
  items_fetched int not null default 0,
  items_kept    int not null default 0,         -- post-dedupe, post-filter
  llm_hops      int not null default 0,
  cost_usd      numeric(10,6) not null default 0,
  error         text                            -- truncated to 500 chars; never includes user PII
);

create index agent_runs_agent_started_idx on public.agent_runs (agent_id, started_at desc);
alter table public.agent_runs enable row level security;
create policy agent_runs_owner_all on public.agent_runs
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
```

### 5.3 `agent_findings`

```sql
create table public.agent_findings (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  user_id         uuid not null,
  run_id          uuid not null references public.agent_runs(id) on delete cascade,
  dedupe_key      text not null,                -- template-defined; see §8
  title           text not null,
  summary         text,                         -- agent-written short summary
  source_url      text,
  payload         jsonb not null,               -- template-defined, see §7
  score           numeric(4,3) not null,        -- 0..1, template's relevance score
  state           text not null default 'new',  -- 'new' | 'seen' | 'accepted' | 'dismissed' | 'snoozed' | 'archived'
  urgency         text not null default 'normal',-- 'normal' | 'urgent'
  user_feedback   text,                         -- optional free-text from user
  created_at      timestamptz not null default now(),
  acted_at        timestamptz,
  unique (agent_id, dedupe_key)                 -- hard dedupe at the DB level
);

create index agent_findings_user_state_idx on public.agent_findings (user_id, state, created_at desc);
create index agent_findings_agent_created_idx on public.agent_findings (agent_id, created_at desc);

alter table public.agent_findings enable row level security;
create policy agent_findings_owner_all on public.agent_findings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
```

### 5.4 `agent_state`

Free-form per-agent KV for cursors, fetched-IDs, embeddings caches.
Templates use it however they need; the runtime treats it as opaque.

```sql
create table public.agent_state (
  agent_id   uuid not null references public.agents(id) on delete cascade,
  user_id    uuid not null,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (agent_id, key)
);

alter table public.agent_state enable row level security;
create policy agent_state_owner_all on public.agent_state
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
```

All four tables go in one idempotent migration
`supabase/migrations/20260601000000_phase30_agent_runtime.sql`
(in main agent's namespace per replit.md).

---

## 6. The runner contract

```ts
// src/server/agents/runner.ts
export interface AgentTemplate<TConfig, TItem> {
  id: string;                              // 'job' | 'research_digest' | ...
  displayName: string;
  description: string;                     // shown in marketplace card
  defaultBadge: BadgeId;                   // recommended badge
  defaultCadenceHours: number;
  defaultBudget: AgentBudget;
  configSchema: z.ZodType<TConfig>;        // user-facing config

  /** Template defines which broker categories it needs. The runner
   *  passes those + the strictest tier in chain to assembleSystemPrompt. */
  brokerCategories: TraitCategory[];

  /** Fetch raw candidate items from sources. Pure I/O. Pure means
   *  no LLM calls, no DB writes — the runner handles those. */
  fetch(ctx: FetchCtx<TConfig>): AsyncIterable<TItem>;

  /** Returns a stable key for dedupe. Same item across runs → same key. */
  dedupeKey(item: TItem): string;

  /** Score 0..1. The runner drops items below config.minScore. */
  score(item: TItem, ctx: ScoreCtx<TConfig>): Promise<number>;

  /** Convert a kept item into a Finding payload. Allowed to use
   *  the LLM (counted toward budget.maxLLMHopsPerItem). */
  summarise(item: TItem, ctx: SummariseCtx<TConfig>): Promise<{
    title: string;
    summary: string;
    payload: Record<string, unknown>;
    urgency: 'normal' | 'urgent';
  }>;
}

export interface AgentBudget {
  maxRunsPerDay: number;
  maxItemsConsideredPerRun: number;
  maxLLMHopsPerItem: number;
  maxNotificationsPerDay: number;
}
```

The runner enforces all four budget caps and aborts the run with
`status = 'budget_exceeded'` rather than going over. The user sees
an Inbox card "Agent X hit its daily budget — raise it or accept the
results so far?" — never silent overspend.

---

## 7. v1 templates

Four templates ship in 3.0–3.2. JobAgent is the **hero launch
template** because the user value is immediately legible
("backend jobs in SF I haven't seen, scored against my profile").
ResearchDigest is the **runtime validation template** — easiest to
build, validates the runner end-to-end before we commit to a
data-source-heavy template.

### 7.1 ResearchDigest *(runtime validation, ships first)*

| | |
| --- | --- |
| Config | `{ topics: string[]; lookbackHours: number }` |
| Default cadence | 24 h |
| Default badge | FLASH |
| Sources | Existing web-search adapter (already in stack) |
| Dedupe key | SHA-256(canonical URL) |
| Score | LLM rates relevance to user's topics + trait sheet style preferences (1 hop) |
| Output `payload` | `{ url, fetched_at, top_quotes: string[] }` |
| Notification default | Daily digest, 1 notification regardless of finding count |

Internal positioning: "this proves the runtime works." Not the hero
launch template.

### 7.2 JobAgent *(hero launch template)*

| | |
| --- | --- |
| Config | `{ roles: string[]; locations: string[]; remoteOk: boolean; salaryMin?: number; mustHave: string[]; niceHave: string[] }` |
| Default cadence | 12 h |
| Default badge | PRO (good summarisation matters) |
| Sources | Greenhouse public boards, Lever public boards, Ashby public boards (the three v1 ATS providers — see §10) |
| Dedupe key | SHA-256(`${ats}:${board_token}:${job_id}`) |
| Score | LLM rates 0–1 against `mustHave` (hard) + `niceHave` (soft); items < 0.5 dropped (1 hop) |
| Output `payload` | `{ ats, company, role, location, salary, posted_at, job_url, mustHave_hits, niceHave_hits }` |
| Side action | If `score ≥ 0.85`, generate a tailored resume bullet rewrite proposal in the finding's payload (1 extra hop, gated by budget) |
| Notification default | Daily digest at user-chosen hour; immediate notification only for `score ≥ 0.95` AND `posted_at` within last 6 h (the "closes-soon outlier" rule) |

The "tailored resume bullet" feature is what makes JobAgent
qualitatively different from a Google Alert. It is an LLM hop and
counts against budget; users can disable it in config to save cost.

### 7.3 ShoppingAgent

| | |
| --- | --- |
| Config | `{ items: { description: string; maxPrice?: number; sizeOrSpec?: string }[]; preferredRetailers?: string[] }` |
| Default cadence | 24 h |
| Default badge | FLASH |
| Sources | Affiliate networks: Skimlinks (or Rakuten — pick one for v1, see §17 Q3) |
| Dedupe key | SHA-256(`${retailer_sku}`) |
| Score | LLM rates description match + price vs. `maxPrice` |
| Output `payload` | `{ retailer, sku, title, price, currency, image_url, product_url, in_stock }` |
| Image handling | If badge is PRIVATE-capable for image-out (docs/12 §5), thumbnail is generated locally; otherwise retailer's own image_url is used (no model inference on image needed) |

### 7.4 DealWatcher

| | |
| --- | --- |
| Config | `{ skus: string[] }` (user pastes product URLs, agent extracts SKUs) |
| Default cadence | 6 h |
| Default badge | FLASH |
| Sources | Same affiliate feed as ShoppingAgent, scoped to specific SKUs |
| Dedupe key | SHA-256(`${sku}:${price_drop_event_id}`) — same SKU triggers a new finding only on a fresh price drop |
| Score | Always 1.0 (price-drop is binary) |
| Output `payload` | `{ sku, title, prev_price, new_price, drop_pct, retailer, product_url }` |
| Notification default | Immediate for drops ≥ 15% off baseline; daily digest otherwise |

---

## 8. Dedupe and memory model

Every template defines a `dedupeKey(item) → string`. The unique
constraint on `agent_findings(agent_id, dedupe_key)` enforces that
the same item never produces two findings for the same agent. This
is the core of why the system isn't a spam machine.

Templates also write to `agent_state` to track:
- `last_cursor` per source (e.g. "fetched up to job_id X from Lever")
- `seen_dedupe_keys` (rolling window, defaults to 90 d) — used to
  short-circuit dedupe checks before hitting the unique constraint
- `embedding_cache` if the template uses semantic dedupe
  (ResearchDigest uses this for "similar article")
- `last_error_class` for degraded-state detection
- `confidence_threshold_overrides` (user can teach the agent that a
  particular pattern of findings is always relevant)

`agent_state` is opaque to the runtime; the template owns the
schema. RLS keeps it per-user; GDPR delete cascades via the
`agent_id` FK.

---

## 9. Scheduling

Two engines, picked by badge.

### 9.1 Cloud cron (FLASH / PRO / Genius agents)

Cloudflare Worker with Cron Triggers fires every 15 minutes,
iterates all agents in `('active', 'degraded', 'inactive')` whose
`last_run_at + cadence_hours < now()`, claims a Durable Object
lock per `agent_id`, and runs.

- Per-user concurrency cap: 1 agent at a time per user (avoids
  bursty cost spikes; agents run sequentially within a user).
- Per-cron-tick global cap: 200 agent runs (back-pressure). Agents
  past their cadence wait for the next tick.
- Crash recovery: a run that doesn't post a `finished_at` within 10
  minutes is reclaimed and marked `failed`.

### 9.2 Client-side runner (PRIVATE agents)

PRIVATE agents run **only when the app is open** — no background
execution. On app launch, after a 30 s idle (so we don't compete
with the user's first-paint), the client iterates the user's
`active` PRIVATE agents whose cadence is due and runs them
sequentially. UI surfaces this honestly during agent setup:

> "PRIVATE agents run only when you open the app. To monitor in the
> background, switch this agent to FLASH, PRO, or Genius."

This is the same fail-closed-with-honest-copy posture as docs/11 §9
and docs/12 §11.

The runner code is identical for both engines; only the I/O
adapters and the trigger differ.

---

## 10. Data-source policy (allowlist + matrix)

**Hard rule:** any new source goes through legal/product review
against this matrix before it can ship in a template. No exceptions.

| Source class | Allowed | Allowed when | Out of scope at every phase |
| --- | --- | --- | --- |
| Public ATS boards (Greenhouse, Lever, Ashby) | ✅ v1 | always | — |
| Affiliate product feeds (Skimlinks, Rakuten, Awin) | ✅ v1 | once one network is contracted | — |
| Public RSS / Atom feeds | ✅ v1 | feed is publicly listed by source | — |
| Web-search via existing adapter | ✅ v1 | always (it's the user's own search) | — |
| Individual company careers pages | ⚠️ case-by-case | (a) source allowlist entry approved (b) robots.txt + ToS audited (c) listed in `docs/13/data-sources.md` with audit notes | unlisted scraping |
| User-provided URLs (one-off fetch) | ⚠️ allowed with safety | (a) URL passes SSRF filter (b) robots.txt respected (c) no auth header injection | private network ranges, file:// |
| LinkedIn | ❌ never | — | scraping, unofficial APIs, partner API too |
| Indeed, Glassdoor, ZipRecruiter | ❌ never | — | scraping, anti-bot bypass |
| Retailer scraping (Amazon, Target, Walmart product pages) | ❌ never | — | always; use affiliate feeds instead |
| Email, calendar, contacts | ❌ this phase | Phase 3 §4.1 (behavioural ingestion) — separate spec, requires Google/Microsoft OAuth + the existing connection flow | unauthenticated reads |
| Social (X, Reddit, Bluesky) | ⚠️ case-by-case Phase 3.5+ | only via official APIs with rate-limit + auth | scraping |

The **case-by-case** rows require a one-pager in
`docs/13/data-sources.md` (path TBD) per source, listing legal
posture, ToS link, robots.txt date-of-audit, contact email for
takedown, and an owner. No source ships without that one-pager.

---

## 11. Per-agent budget

Every agent has a `budget` JSONB on the `agents` row, validated
against:

```ts
const AgentBudget = z.object({
  maxRunsPerDay: z.number().int().min(1).max(48),
  maxItemsConsideredPerRun: z.number().int().min(1).max(500),
  maxLLMHopsPerItem: z.number().int().min(1).max(8),
  maxNotificationsPerDay: z.number().int().min(0).max(20),
});
```

Defaults per template (overridable in config UI):

| Template | runs/day | items/run | hops/item | notifs/day |
| --- | --- | --- | --- | --- |
| ResearchDigest | 1 | 30 | 1 | 1 |
| JobAgent | 2 | 100 | 2 | 1 (+ urgent override) |
| ShoppingAgent | 1 | 50 | 1 | 1 |
| DealWatcher | 4 | 200 | 0 (no LLM, just price diff) | 5 |

Worst-case cost per agent at default budget on FLASH:

- ResearchDigest: 30 items × 1 hop ≈ $0.006/day
- JobAgent (PRO baseline): 100 items × 2 hops ≈ $0.040/day
- ShoppingAgent: 50 items × 1 hop ≈ $0.010/day
- DealWatcher: 0 hops (just price comparison) ≈ $0.001/day

Three active agents (typical) → ~$0.05/user/day on cloud tiers,
$0/day on PRIVATE. Within the docs/05 §2 CPAUD ceiling ($1.50)
with margin for chat + image-out costs.

**Costs intentionally not in this model** (these are infra-line, not
per-agent):
- Cloudflare Worker invocation, Durable Object storage
- Supabase row storage (~negligible at expected scale)
- Notification delivery (web push, email digest)
- Observability log retention
- Affiliate network commission (negative cost — we earn on accepted
  cart items at 3.5+ if affiliate program is contracted)

These are tracked in a separate "infra cost per active user" line
in the CPAUD viewer (CPAUD viewer already shipped — needs an
"agent infra" column added in 3.0).

---

## 12. Failure handling

Rules in priority order:

1. **Source failures are normal — ride through them.** A 5xx from
   Greenhouse on one run does not transition the agent to
   `degraded`. The runner records the run as `failed`, increments
   `consecutive_failures`, and tries again next cadence.
2. **5 consecutive failures → `degraded`.** Cadence doubles
   (slows down). Next successful run resets `consecutive_failures`
   and transitions back to `active`.
3. **20 consecutive failures → `error`.** Runner stops scheduling
   the agent. Inbox surfaces a card: "JobAgent has been failing for
   10 days. Source [Lever] has been unreachable. Reconfigure or
   archive?"
4. **Source permanently unavailable → `error` + clear copy.** If a
   data-source allowlist entry is removed (legal review reverses,
   API shut down), agents using only that source transition to
   `error` with copy "Source no longer supported."
5. **Routine failures do not notify.** Only state transitions to
   `error` or `needs_user_attention` produce a notification. Users
   should never get pinged about routine retries.
6. **PII never enters error messages.** The `error` column on
   `agent_runs` is truncated to 500 chars and stripped through the
   existing `pii_scrub_events` redaction pipeline before write.
7. **Budget-exceeded ≠ failure.** A run that hit its budget cap
   returns `status = 'budget_exceeded'`, posts whatever findings it
   produced, and surfaces a calm Inbox card "Agent hit its budget;
   raise the cap if you want more coverage." Does not increment
   `consecutive_failures`.

---

## 13. Notification budget (cross-agent)

Per-user daily notification budget that all agents compete for.
Default: **3 notifications per day** (one digest + two urgent
slots). User-adjustable 1–10 in settings.

Selection algorithm when multiple agents have notifications queued:

1. Urgent findings always win over normal — up to the user's daily
   urgent quota (default 2).
2. After urgent quota is full, additional urgent findings get
   downgraded to "in tomorrow's digest with a [was urgent] tag."
3. Normal-cadence digest is one notification at the user's chosen
   hour aggregating all agents.
4. If no findings, no notification is sent (no "we have nothing to
   tell you" pings).

The principle, stated as a product line:

> Each user has a daily notification budget. Agents compete for it
> based on urgency, confidence, and user preference. **Default
> behaviour is digest-first, interruption-last.**

---

## 14. UI surfaces

### 14.1 Inbox (`/workspace/inbox`)

The home for findings. Three sections:

1. **Needs you** — `state = needs_user_attention` findings + agents
   in `error` state. Empty by default; surfaces only when the agent
   genuinely needs a human call.
2. **New today** — `agent_findings` with `state = 'new'`, ordered
   by score × urgency. Each card has Accept / Dismiss / Snooze /
   Archive actions.
3. **Recent activity** — last 7 days of accepted/dismissed/archived
   findings, for context.

Findings post **only** to the Inbox by default. Per-agent setting
"also notify in chat" is opt-in, off by default. (Answers decision
3 from the prior memo: Inbox is the calm operational surface;
chat stays conversational.)

### 14.2 Agents page (`/workspace/agents`)

Lists the user's agents grouped by state. Per-agent card shows:
- Last run time + status
- Findings produced in the last 30 days (sparkline)
- Acceptance rate (a finding is "useful" if accepted or acted on)
- Cost spent in the last 30 days
- "Configure" / "Pause" / "Archive" actions

A "Create from template" CTA opens the template marketplace
(modal listing the 4 v1 templates with concrete examples).

### 14.3 Template marketplace

Each template card shows: name, one-line description, **a concrete
example finding** ("e.g. 'Senior backend role at Stripe — $$$,
remote-OK, mustHave Python ✓ Postgres ✓ niceHave Rust ✓'"),
default cadence, default cost/day estimate, badge recommendation.
Clicking opens a config form generated from the template's
`configSchema` (Zod → form, same approach the existing
personalization page uses).

---

## 15. GDPR coverage

Four new per-user tables, all wired through both surfaces:

```sql
-- supabase/migrations/20260601000001_phase30_gdpr_agents.sql
-- Drops + recreates delete_user_data() with the new agent tables
-- inserted in FK-safe order (children first).
-- Adds new return columns for each.
```

Specifically: `agent_findings` and `agent_state` first (children),
then `agent_runs`, then `agents` (parent). All four guarded with
`to_regclass` per the idempotency rule in replit.md.

`src/lib/gdpr.functions.ts` updates:
- `EXPORT_TABLES` adds `agents`, `agent_runs`, `agent_findings`,
  `agent_state`
- `RPC_COLUMN_TO_TABLE` adds the four `*_deleted` columns

`tests/leak-suite/gdpr-roundtrip-realdb.test.ts` adds SEEDS for
all four tables and seeds them in `seedUser()` in FK order
(agents → agent_runs → agent_findings + agent_state).

`tests/gdpr/per-user-table-coverage.test.ts` automatically picks
up the new tables — no test code change needed if EXPORT_TABLES
and the migration body are both updated.

---

## 16. Test plan

### 16.1 Unit (vitest)

- Template `dedupeKey` is stable across runs for the same item
  (50-item fixture per template)
- `score()` returns valid `[0, 1]` for adversarial inputs
- Budget enforcement aborts at exactly the cap, not over
- State machine transitions are exhaustive and one-way where
  required (no skipping states)

### 16.2 Leak suite (extension)

- New `tests/leak-suite/agent-broker.test.ts`: 200 synthetic agent
  configs × 4 badges × 4 tiers, assert the broker never injects
  identity / household / health categories into an agent's prompt.
  PRIVATE agents must reach 0 outbound network calls during the
  prompt-assembly phase.
- New `tests/leak-suite/agent-error-pii.test.ts`: deliberately
  inject PII into source response bodies, assert no PII reaches
  `agent_runs.error` after scrubbing.

### 16.3 GDPR

- Per-user-table-coverage stays green automatically.
- Real-DB roundtrip seeds all four agent tables and verifies
  delete count = 4 × 1 (one row per table per seeded user).

### 16.4 Integration (mocked sources)

- ResearchDigest: stubbed web-search returns 30 articles, agent
  produces 1 finding per unique URL, dedupe across runs works.
- JobAgent: stubbed Greenhouse + Lever + Ashby JSON, full pipeline
  run end-to-end → DB → Inbox UI.
- DealWatcher: same SKU at 3 prices across 3 runs → 1 finding for
  the price drop, 0 for the no-change runs.

### 16.5 Evaluation criteria (per template, before shipping)

Targets, measured on a curated 100-finding eval set:

- **Precision@10**: ≥ 0.7 (of the top 10 findings, ≥ 7 are
  judged genuinely useful by a reviewer)
- **Dedupe accuracy**: 100% (zero duplicate findings for the same
  underlying item across runs)
- **User approval rate** (production): ≥ 25% of new findings get
  accepted within 7 days of surfacing
- **Mute / archive rate** (production): < 30% of agents archived
  within 30 days of creation (above this means template UX is bad)
- **Notification open rate** (production): ≥ 40%
- **False urgency rate**: < 5% of urgent notifications dismissed
  without acceptance
- **Cost per active agent**: stays within the budget defaults in
  §11
- **30-day abandonment rate**: < 50% of created agents become
  `inactive` within 30 days

These are tracked in the existing CPAUD viewer (extended with an
"agent metrics" tab in 3.0).

---

## 17. Phasing & sequence

Honest estimates as production-ready work, not prototype timelines.

| Phase | Scope | Estimate |
| --- | --- | --- |
| 3.0 | Agent runtime (Cloudflare cron + Durable Objects + per-user queue), schema migration, GDPR wiring, budget enforcement, lifecycle state machine, ResearchDigest as runtime validation, basic Inbox surface, observability hooks | **2–3 weeks** |
| 3.1 | JobAgent template (Greenhouse + Lever + Ashby), agent setup UI, template marketplace, daily-digest notification path, evaluation harness | **3–4 weeks** |
| 3.2 | ShoppingAgent + DealWatcher (one affiliate network contracted; if contract slips, this phase slips) | **2–3 weeks** |
| 3.3 | Cadence config UI, inactive-agent review prompts, notification budget enforcement, abandonment guardrails | **1–2 weeks** |
| 3.4 | Natural-language template configuration (LLM picks among existing templates and fills config from a free-text description) | **1–2 weeks** |
| 3.5 | Draft-only write-actions: email reply drafts, populated cart not checked out, calendar event drafts. Per-action confirmation gradient (decays to "trusted" after N approvals on same skill type). | **3–4 weeks** |

Total: **12–18 weeks** for production-quality 3.0 → 3.5. Cuts that
roughly halve the estimate (scoped to MVP, single-user beta, no
formal eval harness): possible but should be labelled as MVP
explicitly so we don't accidentally ship a science project as v1.

3.2 is the only phase with an external dependency that could slip
the schedule independent of engineering effort — the affiliate
network contract.

---

## 18. Locked decisions (v1, 2026-05-15)

Closed in coordination with Sneha on 2026-05-15. Each item was an open
question in the draft spec; the answer below is binding for v1
implementation per §17.

### 18.1 Affiliate network — LOCKED: Skimlinks for v1

Skimlinks at v1 launch. Re-evaluate a Rakuten swap when monthly
affiliate gross margin exceeds **a TBD business threshold** —
product/finance to set the actual figure before Phase 3.2 ships. Do
not leave a vague placeholder in the implementation tickets; either
a concrete number (e.g. £500/mo gross margin) or an explicit "TBD —
business decision blocking 3.2 swap evaluation."

Rationale: Skimlinks is broadest catalogue + fastest onboarding.
Rakuten's premium retailer list may capture more value per impression
for NC's affluent audience, but onboarding delay (~3 months) doesn't
fit a v1 launch. Lock Skimlinks; track affiliate revenue; swap if
Rakuten justifies it.

### 18.2 JobAgent freelance support — LOCKED: permanent only

Permanent roles only in Phase 3.1.

Freelance support requires user-provided credentials, not public API
(Upwork has no usable board API; Toptal is invitation-only; Fiverr's
gig API is limited). Designed separately as Phase 3.6 if user demand
materialises — do not couple to 3.1 JobAgent.

### 18.3 Notification channels — LOCKED: email digest + web push for v1; native push to 3.5

**Email digest + web push for v1.**

- **Email digest:** morning briefing delivery. Reliable, no permission
  grant, universal. Base channel for all users.
- **Web push:** mid-day discovery alerts (deal found, job match) for
  users who grant permission. Higher urgency than email; instant on
  desktop, weak on iOS Safari (PWA push only landed in iOS 16.4 and is
  throttled — accept as known limitation for v1).
- **In-app inbox:** "agent finished overnight" lands here, surfaced on
  next device interaction.

**Native push (FCM/APNs) deferred to Phase 3.5**, explicitly gated on:
- TestFlight readiness (currently in flight via `native/bootstrap`
  branch — iOS shell exists, signing works, Capacitor keyboard + status
  bar wired).
- Firebase service-account wiring (per `docs/04` Day 3 push spec).

### 18.4 Cross-agent trait sheet pollution — LOCKED: siloed + suggested-promotion

Agent activity siloed in `agent_state` for Phase 3.0–3.4. **No silent
writes to the trait sheet from agent behavior.**

Phase 3.5 introduces promotion via two paths:

- **Explicit:** user clicks "promote this finding" on an individual
  `agent_findings` row.
- **Suggested:** 3+ accepted findings in a single category over a
  rolling 30-day window generates a **user-reviewable promotion
  suggestion** in the inbox. User approves or dismisses — **not a
  silent write.**

Rationale: Trait sheet is too privacy-sensitive for behavioral inference
to write without user awareness. Suggested-via-approval preserves the
user's mental model of "I know what's in my trait sheet" while still
capturing implicit signal.

### 18.5 Per-user concurrency cap — LOCKED: serial scheduled, parallel-3 user-triggered with guardrails

**Scheduled runs:** serial per user (concurrency = 1). 10pm–3am window
has time. §9.1 stays as written.

**User-triggered "run all":** may run up to 3 concurrently, **only**
when ALL of the following hold:

1. All agents in the batch are read-only (no write-action races between
   parallel runs).
2. The user is under their daily task budget.
3. The user is shown a clear cost/latency warning when the batch would
   consume most of the remaining daily allowance.

Rationale: Concurrency is not just cost — provider failure modes,
duplicate discoveries, and rate-limit complexity compound with parallel
runs. Read-only constraint is the safety floor; budget gate prevents
runaway spend; warning preserves user agency. Different code paths,
different constraints.

### 18.6 Generative agent AST — LOCKED: structured AST + 1-week design prelude

Phase 3.4's parsed natural-language config is stored as a **structured
AST**, not template_id + opaque blob. Phase 4 generative agents will
read and modify existing agent definitions; that requires a stable,
composable representation.

**Pre-implementation milestone:** explicit **1-week AST schema design
sprint** BEFORE Phase 3.4 implementation begins. Deliverables:

- AST grammar definition (nodes: tools, sources, schedule, write-actions,
  budget constraints; edges: conditional flows).
- Validation rules: which tools / sources / write-actions are reachable
  from any node; safety floor for generated ASTs.
- Migration story for schema evolution (so Phase 4.x can extend the AST
  rather than replacing it).

Do not start 3.4 implementation until this design milestone lands.

### Locked-decision summary (v1, 2026-05-15)

| § | Locked answer |
| --- | --- |
| 18.1 | Skimlinks for v1; Rakuten swap on a concrete (not vague) revenue trigger |
| 18.2 | Permanent JobAgent only; freelance is 3.6+ with user-provided credentials |
| 18.3 | Email digest + web push for v1; native push deferred to 3.5 (gated on TestFlight + Firebase) |
| 18.4 | Siloed `agent_state` for 3.0–3.4; suggested-via-approval promotion at 3.5; **no silent trait-sheet writes** |
| 18.5 | Serial scheduled; parallel-3 user-triggered ONLY if read-only + under budget + with cost/latency warning |
| 18.6 | Structured AST in 3.4; 1-week AST schema design sprint as pre-implementation milestone |

Implementation work in §17 is now unblocked.

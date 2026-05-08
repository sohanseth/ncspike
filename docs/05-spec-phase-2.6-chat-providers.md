# Spec — Phase 2.6: Chat Wiring & Multi-Provider Smart Routing

*Status: Draft v2 (architect-revised) · Owner: Sneha · Depends on: Phase 2.5 (concurrent OK) · Target: 4 days · Pairs with: D8 (Context Broker)*

> **Architect review note (2026-05-08, v1 → v2):** v1 failed review on three D7-relevant points: (a) proposed `create table chat_messages` but the table already exists (migration `20260505150657_…`) with FK to `chat_threads`, role as `public.message_role` enum, and `metadata jsonb`; (b) the per-request broker contract (D8) didn't account for D7's multi-tier fallback chains, which would let context assembled for a permissive tier leak if the request fell through to a stricter provider; (c) the 3-day target was tight given the existing-schema reconciliation. v2 rewrites C5 as ALTER + add-tables, introduces a new C4-bis "broker tier contract" (worst tier across the chain), and bumps the target to 4 days. Product decisions (C0–C3, C6, C7, C9, C10) unchanged.

> **Framing.** The Chat panel in `MainApp.tsx` is currently a visual mock — hardcoded `CHAT_MSGS` array, no `onClick` on the send button, model badges are local React state that nothing reads. The inference layer (`src/server/inference/`) only knows two providers (`lovable`, `cloudflare`) and selects them globally via the `INFERENCE_PROVIDER` env var. This spec wires the chat end-to-end and turns the four UI badges into real, intent-based routing across 4–6 providers, with platform-paid free-tier economics for non-technical users. **No BYOK / paste-key UX** — that pattern is rejected for this audience (see C0).

---

## 1. Goal & non-goals

**Goal.** Ship a working chat that:
- Accepts user input, streams a response back, persists conversation history per user.
- Routes each request to the right provider based on a user-selected **intent** (the four badges), not a user-selected model name.
- Caps free-tier usage per user per day at the server boundary so a runaway loop or a chatty user can never blow the AI budget.
- Adds 4 new provider adapters (Groq, Google, OpenAI, Anthropic) alongside the existing two (Lovable, Cloudflare).
- Emits per-request telemetry sufficient to answer "where did our AI spend go this week?" without storing the prompts themselves.

**Non-goals (explicit).**
- **No user context injection.** That is D8's job. Phase 2.6 ships an *un-personalized* chat. Every user gets the same baseline answers. This is deliberate — it keeps the surface area small and lets us regression-test the routing layer in isolation before any privacy-sensitive payload assembly is bolted on.
- **No BYOK, no paste-API-key UI.** Audience cannot find or generate API keys.
- **No paid tier billing integration.** A paid-tier flag exists on the user row (boolean, default false), gated to admin in 2.6. Stripe wiring lives in a later phase.
- **No on-device inference.** That's Phase 3.
- **No tool-calling / function-calling / MCP.** Plain chat completions only in 2.6.
- **No image / audio / file inputs.** Text in, text out.
- **No conversation branching / regenerate / edit-and-resend.** Linear thread, append-only.
- **No multi-turn streaming with backpressure across the WebSocket.** Server-Sent Events over a fetch, single direction.

---

## 2. The one metric

**Cost-per-active-user-per-day (CPAUD):** total provider $ spend, divided by daily-active users with ≥1 chat send.

- **Target for V1:** ≤ **$0.30/user/day** at the median of the beta cohort over a 14-day window.
- **Hard ceiling (kill switch):** $1.50/user/day. Above this, the smart-routing layer is misclassifying intents to expensive providers — pause traffic on the affected badges.
- Computed from the new `inference_usage` table (C5), no provider-side reporting required.

Latency, model "quality," and throughput are guardrails — they get budgets but they're not the metric. CPAUD is the only number that decides whether the routing strategy is working. Beneath it: open-source providers should account for ≥ 65% of total request volume (the OSS share guardrail).

---

## 3. Decisions

### C0. BYOK pattern (explicitly rejected for this phase)
**Decision:** **No** "paste your OpenAI API key" flow. **No** per-user provider-key vault in 2.6. The platform holds all keys. End user never sees a provider name in any settings UI.
**Why:** the audience is non-technical. Asking for an OpenAI / Anthropic / Google key would gate ~95% of users out of any provider-switching value. The whole "free tokens from providers" framing was wrong because those free tiers are operator-side (per API key), not consumer-side.
**Forecloses:** the `user_provider_keys` table from earlier conversation drafts. The OpenRouter OAuth path stays available as a future power-user opt-in (Phase 3+, settings-only, not on the chat surface).

### C1. Provider roster (locked)
**Decision:** Six providers wired in 2.6. All keys held by the platform.

| Provider id | Default model | Pricing tier | OSS weights? | Auth env vars |
| --- | --- | --- | --- | --- |
| `groq` | `llama-3.1-70b-versatile` | Free tier (30 RPM, 14.4K req/day shared) | ✅ | `GROQ_API_KEY` |
| `google` | `gemini-1.5-flash-latest` | Free tier (15 RPM, 1M tok/day shared) | ❌ (closed weights, hosted) | `GOOGLE_AI_API_KEY` |
| `cloudflare` | `@cf/meta/llama-3.1-8b-instruct` | Workers AI free quota (10K neurons/day shared) | ✅ | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (already present) |
| `openai` | `gpt-4o-mini` | Paid (~$0.15/M input) | ❌ | `OPENAI_API_KEY` |
| `anthropic` | `claude-3-5-haiku-latest` | Paid (~$1/M input) | ❌ | `ANTHROPIC_API_KEY` |
| `lovable` | `google/gemini-3-flash-preview` | Platform credits (already wired) | ❌ (closed weights, hosted) | `LOVABLE_API_KEY` (already present) |

**Why this set:** Groq + Google + Cloudflare cover the free-tier substrate (the 65% OSS share target lives mostly here). OpenAI + Anthropic cover the paid premium tier. Lovable stays as the always-available zero-config fallback for any provider failure mode (its credit budget is the ultimate safety net for development).

**Forecloses:** Mistral, Together, Fireworks, OpenRouter direct, Perplexity in 2.6. Each is a 2–3 hour adapter; defer until a clear product reason emerges. No multiple models per provider in 2.6 (one model id per provider, hardcoded in the adapter).

### C2. Badge → provider mapping (the routing matrix)
**Decision:** The four UI badges become **intent profiles**. The user picks intent; we pick provider. The mapping is hardcoded in 2.6 (no learned routing yet).

| Badge | UI label | Primary provider | Fallback chain | Tier gate |
| --- | --- | --- | --- | --- |
| **FLASH** | "Fast answer" | `groq` | → `google` → `cloudflare` → `lovable` | Free + Paid |
| **PRO** | "Best for the task" | `anthropic` (Haiku) | → `openai` (4o-mini) → `groq` → `lovable` | Free + Paid (with daily cap) |
| **GPT-5** | "Smartest model" | `openai` (4o-mini in 2.6; upgrades to `gpt-5` model id when available) | → `anthropic` (Sonnet equivalent) → `lovable` | **Paid only** (free users see upsell) |
| **PRIVATE** | "Stays on safe rails" | `cloudflare` | → no fallback (fail-closed; user explicitly chose privacy) | Free + Paid |

**Why this shape:** intent is what users actually want to express ("quick" vs "smart" vs "private"). Provider names mean nothing to them. The fallback chain handles 429/5xx without surfacing a model error to the user; PRIVATE deliberately has no fallback because falling back would silently weaken the privacy claim.

**Forecloses:** per-user remapping of badges in 2.6. Tool-driven routing (e.g. "if query mentions code → OpenAI") in 2.6 — that's D8/D9 territory.

### C3. Free-tier daily caps (the cost guardrail)
**Decision:** Per-user, per-badge, per-UTC-day counters. Enforced server-side in `chatGenerate` before any provider is called. Locked at:

- Free tier: **20 FLASH/day**, **10 PRO/day**, **0 GPT-5/day** (badge disabled, upsell shown), **20 PRIVATE/day**.
- Paid tier: **200 FLASH/day**, **100 PRO/day**, **50 GPT-5/day**, **100 PRIVATE/day**.

Caps are *count of completed responses*, not tokens — easier to reason about for the user, easier to display ("14/20 FLASH left today"). Token-level cost is captured separately in `inference_usage` for CPAUD calculation.

**Reset:** UTC midnight, by virtue of `count(*) where started_at::date = current_date` queries. No background job needed.

**Why these numbers:** at the C1 free-tier providers' costs, a free user maxing every cap costs ≈ $0.04/day (≈ $1.20/month). 100× that is the kill ceiling. Paid users at full cap cost ≈ $0.85/day (≈ $25/month) — a $20-25/mo paid tier breaks even on fully-engaged users and profits on average users.

**Forecloses:** per-message billing, token-bucket rate limiting at the request level (we use the existing `rate-limit.server.ts` for that — global 60/min). Per-conversation caps. Rollover of unused daily allowance.

### C4. Fallback semantics
**Decision:** A request falls through the C2 chain on:
- HTTP 429 (rate limit)
- HTTP 5xx (provider error)
- Network timeout (15s wall-clock per provider attempt)
- `InferenceError` raised by the adapter

A request **does not** fall through on:
- HTTP 4xx other than 429 (these are bugs in our request — surface the error)
- Empty response (surface the error; falling back here masks adapter bugs)
- User-initiated abort (cancel the chain entirely)

The fallback is **transparent to the user** — the response carries `{ provider_used, model_used, fallback_depth }` for telemetry but the chat bubble doesn't show it. Exception: the **PRIVATE** badge has `fallback_depth: 0` enforced; if Cloudflare fails, the user sees a friendly "PRIVATE provider unavailable, try again or switch to FLASH" message and **no other provider is called.**

**Why fail-closed on PRIVATE:** if a user picked PRIVATE explicitly, silently routing to Groq (which retains logs) is a privacy regression worse than the error. The whole badge value is "you can trust this label." Falling through breaks the trust.

**Forecloses:** circuit-breaker patterns in 2.6 (retry attempts > 0 within a single provider). Concurrent racing of providers ("first to respond wins"). Both are valid optimizations but premature.

### C4-bis. Broker tier contract for fallback chains (NEW in v2)
**Decision:** When the broker (D8) assembles a system prompt for a request, it does so **against the strictest privacy tier present in the entire fallback chain** for the chosen badge — not against the primary provider's tier. The same assembled fragment is used at every fallback depth without re-assembly.

Example: FLASH chain is `groq (T1) → google (T2) → cloudflare (T0) → lovable (T2)`. The strictest tier in this chain is **T2**, so the broker assembles a T2-compliant fragment. That fragment is safe to send to *any* provider in the chain.

PRIVATE chain is `cloudflare (T0)` only — strictest = T0 = full sheet allowed.

**Why "worst-tier" not "per-attempt re-assembly":** re-assembly per attempt doubles broker latency on fallback (additional embedding + selection + scrub call) and creates an asymmetry between "first try" and "fallback" responses where the same user query could see different traits. Worst-tier assembly is **one decision per request**, locked at the start, with one set of traits used regardless of which provider answered. The cost is a slight personalization downgrade for badges with mixed-tier chains; the win is provable correctness — there is no execution path where context assembled for tier N can leak to a stricter tier provider.

**Implication for D8:** the broker signature changes from `assembleSystemPrompt({ userId, query, badge, providerTier })` to `assembleSystemPrompt({ userId, query, badge, strictestTierInChain })`. D7's chain resolver computes `strictestTier = max(chain.map(p => p.privacyTier))` (higher tier number = stricter restrictions) and passes that to the broker before any provider call.

**Forecloses:** per-provider context tailoring within one request. Streaming-mid-fallback context updates. Re-running the scrub on each fallback attempt.

### C5. Database schema
**Decision:** Reuse the existing `public.chat_threads` and `public.chat_messages` tables (created in migration `20260505150657_…`). **ALTER** `chat_messages` to add the columns this spec needs; **CREATE** only the new `inference_usage` table. Migration filename: `20260509000000_phase26_chat.sql`.

Existing shape (do not redefine):
- `chat_threads (id, user_id, title, model, created_at, updated_at)` — RLS already in place.
- `chat_messages (id, thread_id → chat_threads, user_id, role public.message_role, content, metadata jsonb, created_at)` — RLS already in place.
- The `public.message_role` enum already includes `user | assistant | system` (verified in `supabase/migrations/20260505150657_…`).

```sql
-- Extend the existing chat_messages table with badge / provider / model.
-- Stored as columns (not in metadata jsonb) so they're indexable and queryable for CPAUD.
alter table public.chat_messages
  add column if not exists badge       text check (badge in ('flash','pro','gpt5','private')),
  add column if not exists provider    text,
  add column if not exists model       text,
  add column if not exists fallback_depth int;

-- NOTE: do NOT add a (thread_id, created_at) index here — the base migration
-- 20260505150657_… already created `chat_messages(thread_id, created_at)`. Verified.

-- Decision: do NOT alter chat_threads in 2.6. Badge is a per-message property (C2 lets the user
-- switch badges mid-thread). Existing `chat_threads.model` stays as-is for now.

-- Per-request usage telemetry. NEVER stores prompt or response content.
create table inference_usage (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  thread_id       uuid,
  badge           text not null,
  provider_chain  text[] not null,    -- ordered providers attempted, e.g. {'groq','google'}
  provider_used   text not null,      -- provider that succeeded (or 'failed')
  model_used      text,
  fallback_depth  int  not null default 0,
  input_tokens    int,
  output_tokens   int,
  cost_micro_usd  bigint,             -- estimated cost ×10⁶, computed from C7 price table
  latency_ms      int,
  status          text not null check (status in ('ok','rate_limited','error','user_abort')),
  error_class     text,               -- never the error message itself (could leak prompt)
  started_at      timestamptz not null default now()
);
create index inference_usage_user_day_idx on inference_usage(user_id, started_at);
create index inference_usage_user_badge_day_idx on inference_usage(user_id, badge, started_at);

-- Explicit RLS for the new table (mirrors existing chat_messages / chat_threads policy shape).
alter table inference_usage enable row level security;
create policy "own usage select" on inference_usage
  for select using (auth.uid() = user_id);
-- No insert/update/delete policies → all writes are service-role only via chatGenerate.
```

RLS on `inference_usage`: user can `select` their own rows; no client `insert/update/delete` (no policies granted, service role bypasses RLS). The new ALTERed columns on `chat_messages` inherit the existing RLS policy (`auth.uid() = user_id`) — confirmed safe because the policy is row-level, not column-level. Both tables written exclusively by `chatGenerate` under service role.

Retention: `chat_messages` kept indefinitely until user-initiated delete (Phase 2.7 wires the UI). `inference_usage` aggregated to daily rollups after 90 days via an extension of `cleanup_phase2_retention()` (decision: keep raw rows for 30 days, then per-user-per-day aggregates only for the next 60 days, then delete).

**Forecloses:** storing prompts in `inference_usage` (ever). Cross-user analytics tables in 2.6. Conversation summaries / titles (Phase 2.7 with the broker). Schema redefinition of `chat_messages` or `chat_threads` — they stay where they are.

### C6. Server fn shape
**Decision:** One new server fn `chatGenerate` in `src/server/chat.functions.ts`. Streaming-capable via Server-Sent Events.

```ts
// Request
type ChatGenerateInput = {
  threadId: string;          // client-generated UUID, persisted as-is
  userMessage: string;       // ≤ 8000 chars (server-clamped)
  badge: 'flash' | 'pro' | 'gpt5' | 'private';
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;  // ≤ last 20, server-clamped
};

// Response (SSE stream)
// event: chunk     data: { delta: string }
// event: meta      data: { provider, model, fallback_depth, input_tokens?, output_tokens? }
// event: error     data: { class: string, retriable: boolean }
// event: done      data: { message_id: string }
```

Server-side flow:
1. Auth check (Supabase `auth.uid()` required; throw 401 if missing).
2. Rate-limit check (existing `rate-limit.server.ts`, 60/min per user).
3. Cap check against `inference_usage` for today. If exceeded → emit `error` with `class: 'daily_cap_exceeded'` and message in plain language.
4. Persist user message row to `chat_messages` (status: pending row).
5. Resolve provider chain from C2.
6. For each provider: try `provider.generateStream(req)` with 15s timeout. On success → start streaming `chunk` events to client + buffer for the assistant row. On retriable failure → next provider. On terminal failure → `error` event, write `inference_usage` row with `status: error`.
7. On successful completion: write assistant `chat_messages` row, write `inference_usage` row with `status: ok`, emit `done`.
8. On user disconnect mid-stream: write partial assistant row with `[interrupted]` suffix, `inference_usage.status = 'user_abort'`, log the partial output tokens.

**Why server fn (not Edge Function, not Worker):** the existing TanStack Start server-fn pattern matches every other backend call in the project (`native.functions.ts`, `voice-drafts.functions.ts`, etc). One pattern, one auth path, one observability story.

**Forecloses:** WebSocket transport in 2.6. GraphQL subscription in 2.6. Edge-function deployment of inference (Workers AI is the only adapter that *could* run at the edge; not worth the deployment-target split for one provider).

### C7. Cost telemetry & price table
**Decision:** Hardcoded price table in `src/server/inference/pricing.ts`, used to compute `cost_micro_usd` after each request from the provider's reported token counts (or our estimate via `tiktoken` for providers that don't report them: Cloudflare, Groq).

```ts
// Prices in micro-USD per 1M tokens (USD × 10⁶).
// Reviewed quarterly. Out-of-date pricing causes CPAUD drift, not crashes.
export const PRICING = {
  groq: { input: 590_000,  output: 790_000 },     // Llama 3.1 70B
  google: { input: 75_000,  output: 300_000 },    // Gemini 1.5 Flash
  cloudflare: { input: 110_000, output: 110_000 },// rough Workers AI estimate
  openai: { input: 150_000, output: 600_000 },    // GPT-4o-mini
  anthropic: { input: 1_000_000, output: 5_000_000 }, // Claude 3.5 Haiku
  lovable: { input: 75_000, output: 300_000 },    // mirrors Gemini Flash
} as const;
```

**Why micro-USD as bigint:** float drift on accumulator queries is real. `bigint` keeps `sum(cost_micro_usd)` exact regardless of row count.

**Forecloses:** real-time price discovery from provider APIs in 2.6. Per-region pricing variance. Cached-prompt discounts (Anthropic / OpenAI cache pricing).

### C8. Streaming for V1
**Decision:** **Yes, streaming.** SSE over fetch (`fetch-event-source`-style, native `EventSource` won't work because we need to POST). Each provider adapter implements both `generate()` and `generateStream()`; the chat surface only uses `generateStream()`.

**Why streaming-from-day-one:** retrofitting streaming after the fact requires changing the server-fn return type, the client transport, the persistence model (partial rows), and the abort semantics. Cheaper to pay the design cost once now.

**Caveat:** Cloudflare Workers AI streaming format is non-standard (NDJSON, not SSE). The adapter normalises to a common iterator interface. Lovable, OpenAI, Anthropic, Groq, Google all speak SSE chat-completions natively.

**Forecloses:** non-streaming `chatGenerate`. Background "send-and-poll" mode.

### C9. History window
**Decision:** Last **20 messages** of the thread are sent to the provider on each turn, server-clamped. No summarization in 2.6. Threads beyond 20 messages keep working (older messages persist in `chat_messages`, just don't ride along). System prompts in 2.6 are a one-line stub; D8 replaces them with the context broker output.

**Why 20:** covers ~90% of real chat sessions per industry data. Avoids token bloat on the cheap providers (Groq context window is 128K but their *free tier RPM cap* hits us first). Summarization is real engineering and gates better on D8 having a trait sheet to lean on.

**Forecloses:** infinite context. Sliding window summarization. Per-badge history-window tuning.

### C10. Telemetry without prompts
**Decision:** `inference_usage.error_class` is a closed enum (`provider_429`, `provider_5xx`, `timeout`, `network`, `cap_exceeded`, `bad_response_shape`, `user_abort`, `unknown`). The provider's actual error message is never persisted (it commonly contains the prompt prefix on 4xx). On `bad_response_shape`, the *response shape* is logged (e.g. `{ choices: [], finish_reason: 'length' }`) but not the content.

**Forecloses:** raw prompt/response storage anywhere except `chat_messages` (which is RLS-locked to the user). No analytics dashboards on prompt content. No Sentry integration that captures request bodies.

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  ChatPanel.tsx (client)                                      │
│  - reads thread from chat_messages via Supabase realtime     │
│  - on send: POST to chatGenerate via fetch + SSE parser      │
│  - badge picker writes a per-thread state.badge              │
└────────────────┬─────────────────────────────────────────────┘
                 │ SSE
┌────────────────▼─────────────────────────────────────────────┐
│  chatGenerate server fn (src/server/chat.functions.ts)       │
│  1. auth + rate-limit + cap check                            │
│  2. persist user row                                         │
│  3. resolve provider chain by badge (C2)                     │
│  4. for each provider: try generateStream()                  │
│  5. stream chunks back, buffer for persistence               │
│  6. write assistant row + usage row                          │
└────────────────┬─────────────────────────────────────────────┘
                 │ provider.generateStream(req)
┌────────────────▼─────────────────────────────────────────────┐
│  src/server/inference/index.ts (dispatcher)                  │
│  - PROVIDER_LOADERS registry (lazy)                          │
│  - getProvider(id) instead of getProvider() (env-based)      │
└─┬───┬──────┬──────┬──────┬──────┬───────────────────────────┘
  │   │      │      │      │      │
  ▼   ▼      ▼      ▼      ▼      ▼
groq google cloudflare openai anthropic lovable
                                          (each: src/server/inference/<id>.ts)
```

Existing dispatcher (`src/server/inference/index.ts`) keeps its lazy-load shape; the change is `getProvider()` becomes `getProvider(id: string)` and the env-var default goes away. Each adapter implements:

```ts
type InferenceProvider = {
  id: string;
  generate(req: InferenceRequest): Promise<InferenceResult>;
  generateStream(req: InferenceRequest): AsyncIterable<InferenceChunk>;
};
type InferenceChunk = { delta: string } | { meta: { input_tokens?: number; output_tokens?: number } };
```

The existing `lovable` and `cloudflare` adapters get `generateStream()` added. Four new adapters from scratch.

---

## 5. Files touched

**New:**
- `supabase/migrations/20260509000000_phase26_chat.sql` — C5 schema
- `src/server/chat.functions.ts` — C6 server fn
- `src/server/inference/groq.ts` — adapter
- `src/server/inference/google.ts` — adapter
- `src/server/inference/openai.ts` — adapter
- `src/server/inference/anthropic.ts` — adapter
- `src/server/inference/pricing.ts` — C7 price table
- `src/server/inference/router.ts` — C2 badge → chain resolver
- `src/lib/chat-stream.ts` — client-side SSE parser + EventSource-over-fetch helper
- `src/hooks/useChatThread.ts` — Supabase realtime subscription + send action

**Modified:**
- `src/components/workspace/MainApp.tsx` — `ChatPanel` becomes real (delete `CHAT_MSGS`, wire badges to `state.badge`, wire send button to `useChatThread().send()`, wire input)
- `src/server/inference/index.ts` — `getProvider(id)` + extended `PROVIDER_LOADERS`
- `src/server/inference/types.ts` — add `generateStream` to `InferenceProvider`, add `InferenceChunk`
- `src/server/inference/lovable.ts`, `cloudflare.ts` — implement `generateStream()`
- `supabase/migrations/<existing-cleanup>.sql` — extend `cleanup_phase2_retention()` to roll up `inference_usage` after 90 days

**Touched indirectly (config / docs):**
- `replit.md` — add the new env vars to required-secrets section
- `docs/01-decision-doc-phase-2.md` — append a "Phase 2.6 addendum" line referencing this spec

---

## 6. Sequencing (4 days)

### Day 1 — Schema reconciliation + backend foundations
- Migration `20260509000000_phase26_chat.sql` applied; ALTER on `chat_messages` verified non-destructive against existing rows (`select count(*) from chat_messages` before/after — should match). RLS verified via `select` from a non-owner row returns empty. New `inference_usage` RLS verified.
- Regenerate `src/integrations/supabase/types.ts` to pick up the new columns.
- `pricing.ts`, `router.ts`, `types.ts` updated. `tiers.ts` skeleton (consumed by D8 but D7 needs `provider.privacyTier` for C4-bis chain-strictest computation).
- Four new adapters with non-streaming `generate()` only (streaming on Day 2). Smoke test each from a `tsx` script with a single "say hi" prompt.

### Day 2 — Server fn + fallback wiring
- `chatGenerate` server fn skeleton: auth, rate-limit, cap check, **strictest-tier computation per C4-bis**, fallback chain, persistence. Non-streaming response. Manual cURL test against each badge, including a forced 429 on the primary to verify chain traversal.
- `inference_usage` writes with correct `provider_chain`, `provider_used`, `fallback_depth`, `cost_micro_usd`.

### Day 3 — Streaming + client
- Add `generateStream()` to all six adapters. Normalise output via `InferenceChunk` iterator.
- `chatGenerate` switches to SSE response. `chat-stream.ts` client helper.
- `useChatThread` hook: load existing thread from Supabase, subscribe to realtime inserts on `chat_messages`, expose `send(badge, content)` that opens the SSE.
- Wire `ChatPanel` to the hook. Delete `CHAT_MSGS`. Badges become real (each one calls `send` with that badge id). Send button gets `onClick`. Disabled state when streaming.

### Day 4 — Polish, caps, telemetry, review
- Friendly cap-exceeded toast / inline message. GPT-5 badge in disabled state for free users with upsell tooltip. Loading skeletons on chunks.
- `inference_usage` rollup logic in `cleanup_phase2_retention()`.
- Architect review pass — fix anything critical before merge.
- Update `docs/01-decision-doc-phase-2.md` addendum, `replit.md` secrets section.

Buffer of ~half a day on Day 4 because adapter quirks always eat more time than estimated (Anthropic's `max_tokens` is required, OpenAI streaming ends with `[DONE]` not a JSON, Cloudflare is NDJSON not SSE, Google's response shape is `candidates[0].content.parts[0].text`, Groq is OpenAI-compatible but rate-limit headers differ).

---

## 7. Decisions to lock before build (gates)

| Gate | Question | Default if no answer |
| --- | --- | --- |
| **G1** | All 4 new API keys (`GROQ_API_KEY`, `GOOGLE_AI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) provisioned and added to Replit Secrets before Day 1? | Block Day 1 — no fakes, no missing keys. |
| **G2** | Free-tier daily caps as locked in C3 (20/10/0/20)? Or different starting numbers? | Ship the C3 numbers; revisit after 14 days of CPAUD data. |
| **G3** | "GPT-5" badge label — keep verbatim, or rename to "Smart" / "Genius" / "Advanced"? | **LOCKED 2026-05-08: rename to "Genius".** Vendor model names age badly; intent labels age well. The other three badges (Fast / Pro / Private) are intent labels — Genius matches the pattern. |
| **G4** | Paid-tier flag wiring — admin-set boolean only in 2.6, with no Stripe integration? Or stub a `subscription_tier` enum for Stripe later? | Boolean-only in 2.6. Enum migration is a one-line change later. |
| **G5** | History window — 20 messages, or also a token-budget cap (e.g. 4000 tokens)? | Message-count only in 2.6. Token cap is D8 once the broker exists. |
| **G6** | PRIVATE badge fail-closed semantics — confirm we'd rather show an error than silently route to a non-private provider? | Fail-closed (per C4). Silent fallback would invalidate the badge's whole meaning. |

---

## 8. Test plan

**Unit:**
- `router.test.ts` — every badge resolves to the right primary + chain; PRIVATE chain length is exactly 1.
- `pricing.test.ts` — cost computation is exact for a synthetic 1000/500 token request across all six providers.
- `chat-stream.test.ts` — SSE parser handles split chunks, multi-byte UTF-8 boundaries, mid-message disconnect.

**Integration (against real provider sandbox endpoints with throwaway "say one word" prompts):**
- Each adapter returns a non-empty `text` and reports plausible token counts (where supported).
- Streaming yields ≥ 2 chunks for a 50-word prompt response.
- 429 simulation (intercept fetch in test): triggers fallback; final response carries `provider_used = fallback`, `fallback_depth = 1`.

**E2E:**
- A signed-in user sends 21 FLASH messages; the 21st returns the cap-exceeded message and writes no `inference_usage` row.
- A signed-in free user clicks GPT-5: badge is disabled, click shows upsell tooltip, no request is made.
- PRIVATE badge with Cloudflare account ID temporarily wrong → user sees "PRIVATE provider unavailable" and **no** other provider in `inference_usage`.

**Cost regression:**
- A nightly script computes CPAUD from `inference_usage` for the prior day. If above $0.30 → Slack alert. If above $1.50 → page.

---

## 9. PII / privacy invariants

In 2.6 (no broker yet), the only personal data crossing to a third-party provider is:
1. The user's typed message (verbatim).
2. The last 20 messages of conversation history (verbatim).
3. A one-line system prompt: `"You are NeuralConnexions, a helpful assistant. Be concise."` (no user data).

This is the **same exposure surface as ChatGPT itself** — no worse, no better. D8 introduces the trait sheet and brings exposure *down* by adding redaction at the broker layer. Until then, no false claims about personalization or privacy in the chat UI copy.

**Hard invariants (enforced in code, not just policy):**
- `inference_usage` never contains prompt or response text.
- `error_class` is a closed enum.
- Service-role Supabase keys never reach the client (existing pattern).
- Chat history is RLS-scoped per user; no cross-user reads possible even with a forged client.

---

## 10. Rollout

- Behind a feature flag `chat_v1_enabled` on the user row, default `true` for the beta cohort, `false` for any new user pre-2.7. Mock UI continues to render for off-flag users until D8 ships.
- No data migration needed (new tables only).
- Reversible by setting flag false; the mock UI is preserved as a code path for one phase before deletion.

---

## 11. What this unlocks for D8

D8 (`06-spec-phase-2.7-context-broker.md`) bolts onto `chatGenerate` at exactly two points. The **canonical numbered flow** below is the contract — D8 Section 4 mirrors these step IDs verbatim. Any drift between this list and D8 Section 4 is a spec bug, not an implementation choice.

| Step | Owner | Action |
| --- | --- | --- |
| 1 | D7 | Auth + rate-limit + per-badge-per-day cap check |
| 2 | D7 | Persist USER message row to `chat_messages` |
| 3 | D7 | Resolve provider chain by badge (C2) |
| 4 | D7 | Compute `strictestTierInChain = max(chain.map(p => p.privacyTier))` (C4-bis) |
| **5** | **D8** | **`broker.assembleSystemPrompt({ userId, query, badge, strictestTierInChain })` → `{ fragment, traitsUsed, scrubBlocked }`** |
| 6 | D7 | Prepend `fragment` as system prompt to the messages array |
| 7 | D7 | For each provider in chain: `generateStream`, on retriable failure → next |
| 8 | D7 | Persist ASSISTANT message row + `inference_usage` row |
| **8a** | **D8** | **Write `chat_context_log` row with `message_id = assistant_row.id`, `categories_used = traitsUsed`, `strictest_tier`, `scrub_blocked`, `trait_sheet_version`** |
| **8b** | **D8** | **UPDATE assistant `chat_messages` row: set `context_used = traitsUsed`, `trait_sheet_version`** |

**Why step 5 is after step 4, not before step 3:** the broker needs the *resolved chain's* strictest tier, not the primary provider's tier. Calling the broker before chain resolution would re-introduce the v1 bypass class.

**Why step 8a is after step 8, not at step 6:** `chat_context_log.message_id` has a `not null` FK to `chat_messages.id`. The assistant row must exist before the log row can be inserted.

**Nothing else in 2.6's design needs to change** to accommodate D8. The eleven-row table above is the entire interface.

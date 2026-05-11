# NeuralConnexions (NC)

## Project overview

NeuralConnexions is a local-first, life-aware Progressive Web App. It gives
each user a personalized assistant that draws on their own durable context
(notes, calendar, voice drafts, search history, contacts) without ever
shipping that raw context to third-party model providers.

The architectural rule that everything else hangs off:

> **Never inject raw memory into prompts.** Distil raw memory into a
> structured, identifier-free **trait sheet**, then per request let a
> **context broker** select 2–4 relevant trait categories, redact according
> to the chosen provider's privacy tier, and emit a tight system-prompt
> fragment. The user sees a footer disclosing which traits were used.

### Tech stack

- TanStack Start v1 (file-based routing, server functions, SSE)
- React 19 + Tailwind v4
- Vite 7
- Supabase (Postgres + RLS + Auth) — schema lives in `supabase/migrations/`
- Cloudflare Workers (privacy-tier inference + edge fns)
- Six chat providers behind a unified router: Lovable, Cloudflare,
  Groq, Google, OpenAI, Anthropic
- Vitest 2 + fast-check 3 for the leak suite

### Top-level layout

| Path | What lives there |
| --- | --- |
| `src/routes/` | TanStack Start file-based routes |
| `src/components/workspace/` | The main chat / converse / personalization / privacy surfaces |
| `src/lib/` | Client-side helpers — `chat.functions.ts`, `chat-stream.ts`, `gdpr.functions.ts`, `trait-schema.ts` |
| `src/server/inference/` | Provider adapters, router, tier resolution, chain runner |
| `src/server/broker/` | Phase 2.7 context broker — assembly + scrub + log |
| `supabase/migrations/` | Versioned SQL — namespace `20260513_*..20260517_*` is main-agent's |
| `tests/leak-suite/` | Phase 2.7 broker leak suite (zero-PII assertions) |
| `tests/gdpr/` | Per-user-table coverage drift detector |
| `docs/` | Phase specs (`05` = 2.6, `06` = 2.7, `07` = 2.8, `08` = Lovable handoff) |

### Phase status

- **2.5** Native shell — done
- **2.6** Chat wiring & multi-provider routing — done (4 days, all polish merged)
- **2.7** Context broker & trait sheet — done (7 days, all follow-ups merged)
- **2.8** Voice / Converse surface — in progress, **owned by Lovable**

### Lovable lane (do not touch)

Phase 2.8 voice work is implemented in parallel by the Lovable agent.
Per `docs/08-lovable-handoff-2.8.md`, the following files are
Lovable-owned — main agent must not edit them:

- `src/components/workspace/ConverseInput.tsx`, `StatusPill.tsx`,
  `IconRail.tsx`, `Sidebar.tsx`
- `src/server/voice-*`, `src/routes/api.stt.*`, `src/routes/api.tts.*`
- Any migration in the `20260520_*+` namespace
- The `prefer_local_audio` setting + audio adapters

The reciprocal "do not touch" list (chat pipeline, adapters, broker,
migrations `20260513_*..20260517_*`) is enforced on Lovable's side.

## Required secrets

The app expects these to be present in Replit Secrets. Never log,
print, or commit their values.

| Secret | Used by |
| --- | --- |
| `SUPABASE_URL` | Server + client (public) |
| `SUPABASE_PUBLISHABLE_KEY` | Browser Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only — RPC calls, GDPR wipe, retention cron |
| `SUPABASE_DB_URL` | Real-DB CI test (`tests/leak-suite/gdpr-roundtrip-realdb.test.ts`) when `GDPR_REAL_DB_URL` is exported |
| `GROQ_API_KEY` | FLASH badge primary (Groq llama-3.1-8b-instant) |
| `GOOGLE_AI_API_KEY` | PRO badge primary (Gemini 2.0 Flash) |
| `OPENAI_API_KEY` | Genius badge primary (GPT-4o family); also embeddings fallback |
| `ANTHROPIC_API_KEY` | PRO badge fallback (Claude 3.5 Haiku) |
| `CLOUDFLARE_ACCOUNT_ID` | PRIVATE badge — Workers AI llama-3.1-8b |
| `CLOUDFLARE_API_TOKEN` | Same — auth for Cloudflare Workers AI |
| `GOOGLE_OAUTH_CLIENT_ID` | Google sign-in (Supabase Auth provider) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Same |
| `ANTHROPIC_API_KEY` | (also) leak-suite synthetic-user judge in some tests |
| `IMAGE_BLOCKED_ALERT_THRESHOLDS` | Task #50 — per-adapter rolling-24h refusal thresholds, e.g. `webgpu-sd-turbo=20,coreml-sd=10`. Adapters not listed never alert unless `IMAGE_BLOCKED_ALERT_DEFAULT_THRESHOLD` is set. |
| `IMAGE_BLOCKED_ALERT_DEFAULT_THRESHOLD` | Optional fallback threshold for unlisted adapters in the same alert. |
| `OPS_ALERT_WEBHOOK_URL` | Slack-compatible incoming webhook for the image-refusal spike alert. If unset, the cron computes alerts and logs them but performs no network call. |

The Genius badge is currently rendered as locked for all users
(`FREE_TIER_CAPS.genius = 0` in `src/server/inference/router.ts`);
its key is provisioned so the path is testable when paid-tier wiring
lands.

## User preferences

- **Voice & tone:** plain language, no jargon unless I show I want it,
  no emojis unless I ask.
- **Push & merge ops:** never force-push, never run `git rebase` or
  `git reset` on `main` from the agent shell. Destructive git ops go
  through a project task.
- **Migrations:** every new migration must be idempotent (re-runnable
  on a fresh DB and on the user's existing DB). Use `if not exists`,
  `to_regclass(...)` guards, and `drop function if exists` before
  `create or replace function` when the return signature changes.
- **GDPR migration order:** in
  `supabase/migrations/20260514000000_phase27_gdpr_and_retention.sql`,
  `delete_user_data()` must appear before `cleanup_phase2_retention()`
  — the offline GDPR roundtrip test parses the first
  function-return-signature block as the delete RPC.
- **Don't touch Lovable's lane** (see list above).
- **No silent fallbacks.** The PRIVATE badge fails closed; the broker
  refuses to assemble at higher tier than the strictest in the chain;
  cap-exceeded surfaces a real toast, not a swallowed error.
- **Tests are part of done.** A feature isn't shipped until
  `npx vitest run` is green (currently 94/94 + 3 skipped real-DB).

# NC — Product Vision

*A local-first, life-aware operating layer for your digital existence.*

---

## 1. The problem

Modern life is fragmented across inboxes, calendars, chats, school apps, recruiters, banks, and shopping sites. Existing AI assistants either:

- **Send everything to the cloud** (privacy nightmare, especially for email, family, finance), or
- **Stay siloed inside a single app** (Gmail's Gemini knows nothing about your kid's school WhatsApp group).

What's missing is a **personal intelligence layer** that sees across all of your life domains, builds a private memory of what matters, and acts on your behalf — without leaking your data to a third-party LLM.

## 2. The vision

NC is a calm, glassmorphic workspace that:

1. **Pulls signal** from your communication channels (Gmail today; Calendar, WhatsApp, iMessage, Slack, school apps next).
2. **Triages locally** using a deterministic rules engine, falling back to on-device AI for ambiguous cases.
3. **Builds a memory graph** across five life domains — Professional, Family, Social, Learning, Personal.
4. **Surfaces what matters today** — urgent replies, deadlines, kids' activities, recruiter threads — and hides the noise.
5. **Acts overnight** — drafts replies, researches purchases, plans trips, summarises learning — while you sleep.

The north star: a user opens NC in the morning and sees *exactly* the 5–10 things that matter, with proposed actions ready to approve in one tap. Their data never leaves their devices.

## 3. Audience

- **Primary**: privacy-conscious knowledge workers and parents juggling work + family + job search + learning. Average hardware (modern phone or laptop), non-technical.
- **Secondary**: founders, researchers, and anyone whose inbox/calendar load exceeds working memory.

## 4. Principles

| Principle | What it means in practice |
|---|---|
| **Local-first** | Email bodies, contacts, family details never touch an external LLM by default. |
| **Deterministic before stochastic** | Rules first; AI only for genuine ambiguity; LLM only when explicitly opted-in. |
| **Calm interface** | Glassmorphic dark UI, deep violet-black background, radial cyan/violet glows. No notification spam. |
| **One-tap consent** | Every agent action is proposed; the user approves before anything is sent. |
| **Cross-domain memory** | A school WhatsApp group can connect Family + Social. A LinkedIn post can connect Learning + Professional. |

---

## 5. Product surface

### 5.1 Workspace shell
- **Sidebar** — Home, Mindmap, Memory, Signals, Tasks, Connections.
- **Top bar** — greeting, date, model indicator, profile.
- **Home canvas** — bento grid of 5 domain cards (Professional, Family, Social, Learning, Personal) ordered by live activity, plus a live Inbox queue at the top.

### 5.2 Inbox queue (live)
- Pulled from connected Gmail account(s).
- Each item shows category (`Urgent`, `Today`, `Proactive`, `Review`, hidden if `Ignore`), domain, sender, reason.
- Tag `classified_by`: `rules` (green confidence), `llm` (amber, only if user opted into fallback).

### 5.3 Domain cards
- Each life domain shows top items, urgency dots, weekly trend label, and connected sources.
- Items merge live email signal with manually-entered tasks.

### 5.4 Mindmap
- 2D node-link view of cross-domain connections (e.g. *AI Agents Course → LinkedIn draft → recruiter thread*).
- Edges marked `cross: true` highlight serendipitous bridges across domains.

### 5.5 Memory page
- Interactive graph (`@xyflow/react`) of beliefs the system holds about you, plus a list view.
- Categories: People, Projects, Preferences, Deadlines, Writing style, Recurring patterns.
- Each belief is sourced and timestamped; user can edit, downvote, or forget any item.

### 5.6 Signals
- Emergent themes detected across domains (e.g. *"data sovereignty"* appears in your reading, drafts, and prospect calls).
- Each signal shows momentum (rising / stable / fading), evidence count, and a suggested action.

### 5.7 Tasks (overnight agent)
- Long-running deep-research jobs queued at night ("Find a dress for Maya's wedding, £200, mid-June").
- Status flow: `queued → running → done`.
- Result includes summary, ranked options, and step-by-step reasoning.

### 5.8 Compose
- One-click draft replies in your voice (learned from sent folder samples).
- Tones: Professional, Warm, Concise, Persuasive, Casual. Channels: Email, Slack, WhatsApp, Doc, LinkedIn.

### 5.9 Connections
- Per-user OAuth to Gmail, Google Calendar, etc. End-user owns their tokens; tokens encrypted at rest.

---

## 6. The categorization engine

A four-layer pipeline, **most-private-first**:

### Layer 1 — Sender-domain rules (free, instant)
Lookup table of ~80 known senders mapped to (domain, category):
- ATS / recruiting: `greenhouse.io`, `ashbyhq.com`, `lever.co`, `workday.com`, `linkedin.com` → Professional / Proactive
- Banking / finance: `stripe.com`, `paypal.com`, `revolut.com` → Personal / Ignore
- Travel: `booking.com`, `airbnb.com`, `delta.com` → Personal / Ignore
- Learning: `substack.com`, `coursera.org`, `arxiv.org` → Learning / Proactive
- Social: `facebook.com`, `instagram.com`, `meetup.com` → Social / Ignore
- Calendar: `calendly.com`, `cal.com` → Professional / Today

### Layer 2 — Subject-keyword rules (free, instant)
Override sender categorization when high-signal patterns match:
- **Urgent**: `interview`, `phone screen`, `offer letter`, security alerts, 2FA codes
- **Family**: school, teacher, PTA, ballet, swimming lesson, pickup, permission slip, P1–P7 year groups, well-known UK kids' clubs (La Jolie Ronde, Stagecoach, Brownies, Cubs)
- **Job/recruiter threads**: requisition IDs (`R12345`), `[External]` prefixes, role + remote/hybrid combos
- **Known employer mentions**: a curated list (Nearform, CrowdStrike, Stripe, Datadog, Cloudflare, Google, Microsoft, Anthropic, OpenAI, Salesforce, etc.) catches forwarded threads where only the company name appears in the subject
- **Ignore**: `unsubscribe`, `% off`, `sale ends`, `Black Friday`

### Layer 3 — On-device LLM (Phase 2)
For everything still tagged `needs_review`:
- **WebLLM** (Llama 3.2 1B q4, ~700MB) downloaded once into the browser via WebGPU.
- Runs entirely in the user's tab — no network call, no cloud.
- First-load shows a progress bar with a one-time consent screen.
- Fallback chain: rules → WebLLM → still-needs-review bucket.

### Layer 4 — Cloud LLM (opt-in only)
- Gated behind `ENABLE_LLM_FALLBACK=true` (off by default).
- Only ambiguous emails are sent, never the full mailbox.
- When used, items are tagged `classified_by: llm` so the user can audit.

Every classification stores `{ category, domain, reason, classified_by }` so the user always knows *how* a decision was made.

---

## 7. Architecture

### 7.1 Today (Phase 0–1, shipping)
- **Frontend**: TanStack Start v1 (React 19, Vite 7), Tailwind v4 with semantic tokens in `src/styles.css`, shadcn/ui, Framer Motion, `@xyflow/react` for the memory graph.
- **Server runtime**: Cloudflare Workers (via TanStack Start server functions and `/api/public/*` routes for webhooks).
- **Database**: Postgres via Lovable Cloud. Tables: `connections`, `memory_nodes`, `memory_edges`, `chat_threads`, `chat_messages`, `profiles`, `user_settings`, `user_endpoints`, `watchers`. RLS on every table — `auth.uid() = user_id`.
- **Auth**: Lovable Cloud auth (email + Google). Per-user Gmail OAuth stored in `connections` with encrypted access/refresh tokens.
- **Triage pipeline**: deterministic rules engine in `src/server/email-rules.server.ts`. Cloud LLM disabled by default.
- **AI gateway**: Lovable AI Gateway (`gemini-3-flash-preview`) — currently used only for opt-in fallback and chat threads.

### 7.2 Phase 2 — On-device intelligence
- **WebLLM** (`@mlc-ai/web-llm`) for in-browser inference.
- Move ambiguous-email classification entirely client-side. Browser POSTs the result back to update `memory_nodes`.
- WebGPU compatibility check + graceful fallback to "needs review" bucket.

### 7.3 Phase 3 — Deep-research agent
- **Tavily** for web search (runtime secret).
- Pipeline: WebLLM decomposes the user's request → **anonymises** queries client-side → calls Tavily → results synthesized locally by WebLLM.
- **Orama** (pure-JS vector search) for retrieval over the user's own memory store — no WebGPU needed for embeddings.
- Enables overnight jobs like *"Find me running shoes that match my 8 prior searches"* without ever sending the user's search history to a third party.

### 7.4 Phase 4 — Native shell (mobile)
- **Capacitor** wrap of the PWA → ship to App Store + Play Store.
- **Background execution**: BackgroundFetch (iOS), Foreground Service (Android), Insomnia plugin to keep deep-research jobs alive.
- **Apple Foundation Models** via a Swift bridge (iPhone 15 Pro+, iOS 18+) for users on Apple silicon — fastest, most private path. Not available to Safari/PWA, hence Capacitor.
- **Why native**: more reliable handling of multi-GB model files, App Store presence builds trust for sensitive tasks, true background processing.

### 7.5 Storage modes
A future user setting (`user_settings.storage_mode`) will let users pick:
- **Standard** (today): memory_nodes in Postgres, encrypted at rest, RLS-enforced.
- **Local-only** (Phase 2+): memory in IndexedDB / OPFS, server holds nothing but auth + connection tokens.
- **Hybrid**: metadata server-side, content client-side.

---

## 8. Data model

| Table | Purpose |
|---|---|
| `profiles` | display_name, avatar_url |
| `connections` | per-provider OAuth tokens (encrypted), scopes, account_label |
| `memory_nodes` | atomic facts/threads/items (`node_type`, `label`, `data`, `source`, `importance`) |
| `memory_edges` | cross-domain links (`from_node`, `to_node`, `relation`) |
| `chat_threads` / `chat_messages` | conversational interface to the agent |
| `watchers` | rules that monitor inbox/calendar for matching patterns |
| `user_settings` | `storage_mode`, `ai_mode`, `preferred_model` |
| `user_endpoints` | optional self-hosted DB / model endpoints |

All tables: RLS `auth.uid() = user_id`. No service-role data exposed to the client.

## 9. Security & privacy posture

- **Tokens**: Gmail access/refresh tokens encrypted at rest (`crypto.server.ts`), never returned to the client.
- **No external LLM by default**: feature flag `ENABLE_LLM_FALLBACK` is off; rules handle ~90% of typical inboxes.
- **Webhook endpoints**: HMAC-verified before any payload processing.
- **Row-level security**: every table enforces `auth.uid() = user_id`.
- **Audit trail**: every memory node carries `classified_by` so users can see whether a decision came from rules or an LLM.
- **Right to forget**: users can disconnect any provider and purge associated `memory_nodes` in one action.

## 10. Roadmap

| Phase | Status | Scope |
|---|---|---|
| **0 — Foundation** | ✅ Shipped | Workspace shell, glassmorphic design system, auth, Gmail OAuth, memory graph UI, signals, overnight task UX (mock data). |
| **1 — Rules-first triage** | ✅ Shipped | Deterministic email categorizer in the Worker. Sender-domain map, subject-keyword overrides, job/recruiter rules, family/school rules, known-employer rules. Cloud LLM gated off by default. |
| **2 — On-device LLM** | 🔜 Next | WebLLM (Llama 3.2 1B q4) for `needs_review` items. WebGPU detection. Local memory persistence in IndexedDB. |
| **3 — Deep research agent** | Planned | Tavily search + Orama local vector store. Anonymized query pipeline. Overnight job runner. |
| **4 — Native shell** | Planned | Capacitor wrap, App Store / Play Store, background execution, Apple Foundation Models bridge. |
| **5 — Multi-source ingestion** | Planned | Google Calendar (scheduled), WhatsApp Business API, iMessage (via Mac bridge), Slack, school apps. |
| **6 — Compose & act** | Planned | One-click reply drafting in user's voice, calendar holds, RSVP automation. |

## 11. Success metrics

- **Quality**: % of inbox correctly categorized by rules alone (target: 90%+).
- **Trust**: % of users who keep `ENABLE_LLM_FALLBACK` off after first week.
- **Engagement**: number of overnight tasks the user approves vs. dismisses.
- **Retention**: weekly active users at 4 weeks; sessions per week.
- **Privacy proof**: zero email bodies sent to external LLMs for users on default settings — measurable and auditable.

## 12. What NC is *not*

- Not an email client. NC reads Gmail; users still send and search inside Gmail.
- Not a chatbot. The conversational layer exists, but the product is a *workspace*, not a prompt box.
- Not a productivity-porn tool. No streaks, no badges, no gamification. Calm by design.
- Not a cloud-AI wrapper. If we can do it locally, we do it locally.

---

*Living document. Phases 0 and 1 are live; Phase 2 is the next build.*

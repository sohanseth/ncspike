# Phase 2 Decision Doc

*Status: Draft for review · Owner: Sneha · Last updated: 2026-05-07*

Six decisions that resolve the open questions from the Vision review and unblock the Slice B spec. Each decision names what it forecloses so we can revisit consciously, not by drift.

---

## D1. Default tier of intelligence

**Decision:** Tier A (rules + a tiny on-device classifier) is the default experience for every user. WebLLM is an opt-in upgrade, not the primary brain.

**Tiny classifier choice:** A distilled text-classification model exported to ONNX (~25–80MB), running via `onnxruntime-web` with WASM backend. WebGPU is *not* required for Tier A. Concrete first candidate: `Xenova/distilbert-base-uncased-finetuned-sst-2-english` style architecture, fine-tuned on our own labelled corpus of email subjects + sender domains, output classes = our existing categories (`Urgent`, `Today`, `Proactive`, `Review`, `Ignore`).

**Why:** Works on every modern phone and laptop, no 2GB download, no WebGPU dependency, ships in days not months. Rules still run first — the classifier only sees `needs_review`.

**Forecloses:** We will *not* use WebLLM for classification in V1. We will *not* try to make a single 1B model do both classification and generation.

---

## D2. WebLLM positioning

**Decision:** WebLLM is shipped as a labelled "Power mode" upgrade, gated behind an explicit consent screen that surfaces: model size, download time, WebGPU requirement, expected battery impact. Default = off. No automatic download.

**Why:** Honest with users about cost. Avoids the "downloaded 2GB on cellular and uninstalled" failure mode. Keeps WebLLM as a real differentiator for the users who *want* it, without taxing the rest.

**Forecloses:** We will not use WebLLM as the silent fallback for `needs_review`. We will not advertise WebLLM in onboarding for the average user.

---

## D3. Deep research host

**Decision:** For V1, deep research runs server-side in a privacy-preserving sandbox: ephemeral Cloudflare Worker invocations, no logs of inputs/outputs, query content scrubbed of direct identifiers before it reaches Tavily. The "overnight, keep tab open" PWA path is killed.

**Why:** The "keep your tab open overnight" UX will not survive contact with real users. A small server-side compromise — clearly disclosed — buys a working product. We can migrate the heavy lifting to the native shell later (D4) without changing the user-facing contract.

**Forecloses:** We will not promise "your deep-research query never leaves your device" in V1. We *will* promise "your query is sent without identifiers, processed without logs, and the result is stored only on your device."

---

## D4. Capacitor timing

**Decision:** Native shell moves up the roadmap. Target: Phase 2.5, immediately after Slice B ships. Scope of Phase 2.5 is *only* iOS + Android wrappers with background execution + push notifications — no Apple Foundation Models bridge yet (that stays Phase 4).

**Why:** Background execution is the unlock for the deep-research agent (Phase 3) to feel native, and push notifications are the unlock for daily retention. Apple Foundation Models is a 12–18 month addressable-market bet and shouldn't block anything.

**Forecloses:** No App Store launch in Phase 2. No Apple Foundation Models in Phase 2.5.

---

## D5. Phase 2 hero feature

**Decision:** Voice-Profile Drafts (Slice B) is the Phase 2 hero. Local semantic memory (Slice C) is deferred to Phase 3. The tiny on-device classifier (Slice A) ships *alongside* Slice B as plumbing, not as a marketed feature.

**Why:** Slice B is the only one a user shows a friend. It reuses Gmail OAuth, the existing Compose surface, and the `memory_nodes` schema. It also forces us to solve sent-folder ingestion and the per-user model-artifact storage question — both prerequisites for Phase 3.

**V1 scope guardrail:** 3–5 high-confidence reply templates (Acknowledge, Decline politely, Schedule, Ask for more info, Confirm) personalized with the user's sign-off, sentence rhythm, and characteristic phrases. *Not* free-form generation. Free-form is Phase 3.

**Forecloses:** No free-form draft generation in V1. No multi-turn email threads in V1. No tone selector in V1 (the voice profile *is* the tone).

---

## D6. Sidebar surface for V1

**Decision:** Drop Mindmap and Signals from the top-level sidebar for the next release. Move Mindmap inside Memory as a tab. Hide Signals behind a "Labs" toggle in Settings until we have evidence users return for it. Promote a new top-level surface: **Drafts** (the Slice B output queue).

**Why:** Sidebar real estate is the single most valuable UI asset. Mindmap and Signals are admired-on-first-visit, ignored-on-second. Drafts is what users will return for daily.

**Forecloses:** Mindmap is no longer a marketing screenshot in V1. Signals does not appear in onboarding.

---

## Summary table

| # | Decision | What it forecloses |
|---|---|---|
| D1 | Tier A (rules + tiny ONNX classifier) is the default. WebLLM is opt-in. | WebLLM as silent fallback. 2GB default download. |
| D2 | WebLLM gated behind explicit "Power mode" consent. | WebLLM in onboarding for avg user. |
| D3 | Deep research runs server-side, no-logs, identifier-scrubbed. | "Never leaves your device" promise for deep research in V1. |
| D4 | Capacitor wrap to Phase 2.5. Apple FM stays Phase 4. | App Store in Phase 2. Apple FM in Phase 2.5. |
| D5 | Voice-Profile Drafts (Slice B) is the Phase 2 hero. | Free-form generation, tone selector, multi-turn in V1. |
| D6 | Drop Mindmap/Signals from sidebar. Promote Drafts. | Mindmap/Signals as marketing screenshots in V1. |

---

## Implementation deltas (recorded 2026-05-07)

The following deviations from the original decisions were taken during build. Each is recorded so we can revisit consciously rather than discover by archaeology.

### A1. Slice A classifier — server-side substitution

The on-device ONNX classifier from D1 was **not** built in V1. The "rules first → low-confidence fallback" flow is implemented and shipped (categories: `urgent` / `today` / `proactive` / `ignore` / `needs_review`), but the fallback is a server-side LLM call (`google/gemini-3-flash-preview` via the Lovable AI Gateway) instead of a browser-side ONNX model. The fallback is gated behind `ENABLE_LLM_FALLBACK=true`; with the flag off, ambiguous emails stay `needs_review` and never leave the device.

**Why we deviated:** the rules engine handled enough of the corpus on its own that the on-device-classifier spike kept losing priority to Slice B and Slice C. Shipping a server-side opt-in fallback unblocked the Inbox UX without committing to a 25–80MB ONNX download we hadn't validated yet.

**What this forecloses (for now):** the "your inbox classification never leaves your device" claim. We can still make it true later by training a model against the `memory_nodes` rows we are already persisting (each row records `classified_by: 'rules' | 'llm'`, which is the labelled corpus we'll need).

**Revisit trigger:** when we have ≥10k labelled rows from real users, or when WebGPU support stabilises enough to make the larger-model variant viable.

---

## Phase 2.6 Day 4 addendum (2026-05-08)

Day 4 closes the D7 chat-providers slice with three UX polish items + one retention plumbing item, all tied back to spec `docs/05-spec-phase-2.6-chat-providers.md` §1 line 351 and §A1 lines 386–387:

1. **Friendly cap-exceeded toast.** ChatPanel now distinguishes `evt.type === "cap_exceeded"` from generic stream errors and surfaces a sonner toast (`Daily {BADGE} limit reached (used/cap today). Try a different badge, or upgrade for higher caps.`). Generic errors still render inline. Toast lives at the route root (`__root.tsx`) so every route gets it without per-page wiring.
2. **Loading skeleton, not "Thinking…".** While the assistant placeholder is empty (between user-send and first SSE delta), ChatPanel renders three pulse-skeleton bars inside the assistant bubble instead of a separate "Thinking…" row. Replaces the prior generic spinner block. Keeps the layout stable so the first delta doesn't reflow the conversation.
3. **Genius badge upsell.** The Genius (formerly GPT-5; G3 lock 2026-05-08) badge is rendered in a permanently-disabled state for free users, with a Lock icon, `cursor-not-allowed`, and a click-handler that fires an upsell toast. Free-tier is hardcoded today because `getPaidTier()` still returns false everywhere — the wiring will become real when subscription billing lands. The disabled treatment is the same shape we'll keep when paid users see Genius enabled, so no future visual churn.
4. **`inference_usage` retention rollup.** New migration `20260510000000_phase26_retention.sql` creates `inference_usage_daily` (per user × day × badge × provider, all status counts + token/cost sums) and extends `cleanup_phase2_retention()` with two new return columns (`inference_usage_rolled_up`, `inference_usage_daily_deleted`). Raw rows older than 30d fold into the daily table on each cron tick, then get deleted; daily aggregates older than 90d get deleted entirely. Matches spec C5 line 179 verbatim.

**What this forecloses:** per-thread cap toasts (we deliberately keep cap UX at the chat surface, not duplicated per-message); a "skeleton during long pauses mid-stream" treatment (we only show it before the first delta — once content streams, the user sees real text); a separate disabled treatment for paid users on Genius when they're at cap (paid cap-exceeded uses the same toast as 1).

**Sequencing note:** Day 4 deliberately does not touch the chat pipeline, the SSE format, or any adapter. All four items are UX/observability layers on top of the Day 3 streaming work. The next concrete chat-pipeline change is D8 (broker), spec `docs/06`.

## Questions resolved

- **Tiny classifier model:** decision deferred to a 1-day spike at the start of Slice A (week 5). Spike picks between a DistilBERT-class model (~80MB, more accurate) and a MiniLM-class model (~25MB, faster on low-end phones). Default bias: smaller wins ties.
- **Slice B generation provider:** Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`) for V1, accessed via a thin provider abstraction (`src/server/inference/`) that supports OpenAI/Anthropic/OpenRouter as drop-in alternates via env var. Lovable AI Gateway is dropped to remove that vendor dependency. On-device generation (WebLLM) is a Power-mode follow-up, not V1. Locked in spec §3.
- **Voice profile storage:** Postgres `voice_profiles` table, encrypted at rest with the same `crypto.server.ts` envelope as OAuth tokens (same key, same primitives, simpler ops). IndexedDB-only storage is a Phase 3 option once we ship a real local-only mode for the whole product.
- **Pricing / monetization:** out of scope for Phase 2. Revisit after the 50-user beta cohort returns EDTS data.

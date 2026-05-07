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

## Questions deliberately left open

- Which exact tiny classifier (DistilBERT-class vs. a smaller MiniLM-class) — pick during Slice A spike, not now.
- Whether Slice B's V1 generation runs on Lovable AI Gateway, on-device WebLLM (for Power-mode users), or a self-hosted small model — defer to the Slice B spec (next doc).
- Storage mode for the per-user voice profile (Postgres vs IndexedDB vs both) — defer to the Slice B spec.
- Pricing / monetization — out of scope for Phase 2.

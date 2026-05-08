# Lovable handoff — Phase 2.8 voice (parallel-safe)

*Author: main agent (NC core) · Date: 2026-05-08 · Valid through: 2.6 Day 4 + 2.7 D8 land (~10 working days)*

You scaffolded 2.8 voice (commit `b769871` and follow-ups). Thank you. This document is the contract for how to keep working on 2.8 **in parallel with** the main agent's work on 2.6 Day 4 and 2.7 D8 **without merge conflicts**.

---

## 1. The collision problem

The 2.8 spec has 2.8 depending on 2.6 + 2.7. Both of those are mid-flight on `main`:

- **2.6 Day 4** (main agent, this branch) — cap-exceeded toast, loading skeleton, GPT-5 disabled-badge upsell tile, retention rollup migration, docs addendum. Touches ChatPanel in `MainApp.tsx`, `chat-stream.ts`, a new migration, `docs/01` and `docs/05`.
- **2.7 D8** (main agent, next) — context broker, trait sheet, settings UI, leak suite. Touches new `src/server/broker/*`, `chat.ts` (one new arg), new routes, new migrations, new settings page.

If you edit ChatPanel, the chat pipeline, the `inference_usage` columns the broker writes, or any of the chat adapters, we will get hard conflicts. The rules below carve out a lane where you can keep shipping real voice work in parallel.

---

## 2. Hard "do not touch" list

If you change any file in this list, the merge will conflict and your work will be reverted.

- `src/components/workspace/MainApp.tsx` — main agent owns ChatPanel here. **Especially** lines ~2300–2410 (handleSend, streaming wire-up) and the panel's render tree.
- `src/lib/chat-stream.ts`
- `src/lib/chat.functions.ts`
- `src/server/inference/chat.ts`
- `src/server/inference/types.ts`
- `src/server/inference/sse-helpers.ts`
- `src/server/inference/router.ts`, `tiers.ts`
- All chat adapter files: `src/server/inference/{groq,openai,anthropic,google,cloudflare,lovable}.ts`
- `src/routes/api.chat.stream.ts`
- `src/integrations/supabase/auth-middleware.ts`, `client.server.ts`
- `supabase/migrations/20260509000000_phase26_chat.sql` (already merged; never edit a merged migration)
- `docs/01-decision-doc-phase-2.md`, `docs/05-spec-phase-2.6-chat-providers.md`, `docs/06-spec-phase-2.7-context-broker.md`

If you genuinely need to change one of these (e.g. you discover a bug in `chat-stream.ts` while wiring `ConverseInput`), **stop and post the request in the handoff thread** — we'll coordinate, then make the change in a single commit so you can rebase.

---

## 3. What you own

These files / namespaces are 100% yours for 2.8. Main agent will not touch them.

- `src/server/inference/stt/**` (all current files + any new ones, including new routes' server logic)
- `src/server/inference/tts/**`
- `src/server/inference/audio-pricing.ts`
- `src/lib/voice-types.ts`, `voice-resolver.ts`, `voice-preferences.ts`, `voice-capability.ts`
- `src/components/workspace/ConverseInput.tsx`, `StatusPill.tsx`, `SpeakingOrb.tsx`
- New API routes under `src/routes/api.stt.*.ts` and `src/routes/api.tts.*.ts`
- Any new test files under `tests/voice/**` or `src/server/inference/{stt,tts}/__tests__/**`
- `docs/07-spec-phase-2.8-voice.md` — owned by Sneha but you can append a "Day-N notes" section at the bottom

---

## 4. Migration namespace

We need to avoid both filename clashes and column-level conflicts on shared tables (`inference_usage`, `user_settings`).

- Main agent's Day 4 migration will use timestamp prefix **`20260510_*`**.
- Main agent's D8 (broker) migrations will use **`20260513_*` … `20260517_*`**.
- **You use timestamp prefix `20260520_*` and later** for all 2.8 migrations. This guarantees yours run after ours regardless of merge order.

Column-level rules on shared tables:

- `inference_usage` — main agent will add nothing in Day 4. D8 will add `broker_traits_used jsonb` and `broker_redaction_applied bool`. **You may add `audio_micro_usd numeric(10,6)`, `voice_turn_latency_ms int`, `stt_provider text`, `tts_provider text` in your own migration.** Use `alter table … add column if not exists` so partial-merge states stay valid.
- `user_settings` — D8 will add `broker_*` columns. **You may add `prefer_local_audio boolean default false not null`** in your own migration. Same `if not exists` rule.
- Never drop or rename a column on either table. Never alter a constraint or index that already exists.

---

## 5. Integration boundary for `ConverseInput`

You wired `ConverseInput` correctly with a `sendVoiceMessage` prop seam. **Keep that boundary.** Do NOT import `ChatPanel`, `MainApp`, `streamChatMessage`, or `chat.functions` from `ConverseInput` or any voice file.

When 2.7 lands, the main agent will:
1. Add a `<ConverseInput>` render slot inside ChatPanel (or replace the text input with it behind a feature flag).
2. Pass a `sendVoiceMessage` implementation that wraps the existing `streamChatMessage` pipeline.
3. Wire the LLM provider + fallback breadcrumb back through the resolver into your `StatusPill`.

Until that integration commit, `ConverseInput` is a standalone, dead-imported component. That's fine — it ships, just not yet rendered.

---

## 6. What you can safely build now (in dependency order)

These can all land in parallel without us; nothing on this list depends on 2.7 broker work.

**Day 1 (this week, real implementations):**
1. Real `groq-whisper` adapter: server route `POST /api/stt/groq` that accepts `multipart/form-data` audio, proxies to Groq Whisper, returns `{ text, latencyMs, model }`. Client `transcribe()` calls it. Audio bytes never persisted (no `chat_messages.audio_url`, no Supabase storage upload).
2. Real `elevenlabs-flash` TTS adapter: `POST /api/tts/elevenlabs` returns `audio/mpeg` blob; client builds an `ObjectURL`. Same persistence rule.
3. Migration `20260520_voice_columns.sql` adding the four `inference_usage` columns + `user_settings.prefer_local_audio` (per §4).
4. Settings UI toggle for `prefer_local_audio`. **Build it as a new page** `src/routes/workspace.voice-settings.tsx` (or similar). Do not touch any existing settings page until 2.7 lands a unified settings surface.

**Day 2:** *(revised 2026-05-08 after Option-2 decision — see Day 2 notes §11 below)*
5. ~~`whisper-cpp-wasm` (PRIVATE-tier STT). Bundle and lazy-load.~~ **Descoped to Phase 4 (native shell).** Web stub throws `NATIVE_ONLY_MSG`; resolver no longer routes any web badge to it.
6. ~~`piper-wasm` (PRIVATE/local TTS).~~ **Descoped to Phase 4.** Same stub treatment as above.
7. ~~Capability detection in `voice-capability.ts` actually probing for WASM…~~ **Replaced.** `voice-capability.ts` now probes `nativeShell`, `mediaDevices`, `audioContext`, `speechRecognition`, and forces `wasmSimd: false` on web. `isLocalAudioToggleAvailable()` returns `false` whenever `nativeShell === false`, which on web is always.

**Day 2 (replacement scope, what actually shipped):**
5a. PRIVATE-on-web pair = `browser-speech-recognition` + `text-only` in **both** toggle states. Resolver tables in `voice-resolver.ts` reflect this; the toggle-ON FLASH/PRO/Genius rows that still reference `piper-wasm` are unreachable on web (kept only for type-level exhaustiveness; will become live when the native shell ships).
5b. Capability probe surfaces `nativeShell`/`mediaDevices`/`audioContext`/`speechRecognition` and forces `wasmSimd=false` until `nativeShell === true`.
5c. Settings page (`src/routes/workspace.voice-settings.tsx`) renders an explainer card whenever the toggle isn't available (i.e. always on web today), naming the native app + Phase 4 milestone, with a Firefox-no-SpeechRecognition hint.
5d. `StatusPill` recognises the `(browser-speech-recognition, *, text-only)` shape and prefixes `LOCAL ·` plus renders `browser-speech` in place of the raw STT id.

No new runtime deps installed (no `onnxruntime-web`, no `@ffmpeg/*`, no model files).

**Day 3:**
8. Latency budget test harness (records timing marks from a fake mic-release through the resolver) and the leak suite (synthetic users, asserts no PII in `inference_usage` rows attributable to voice turns). Both can live under `tests/voice/` and run independently.
9. `audio-pricing.ts` real per-provider rates and a unit test.

**Stop-line:** do not write the chat-pipeline integration ("when user releases mic, call streamChatMessage with text"). That's the main agent's job at the integration commit, because it requires changes to ChatPanel and the streaming client that you cannot make conflict-free.

---

## 7. Dependencies / package.json

If you add a runtime dep:
- Add it via the standard npm install in your branch.
- Note the addition at the bottom of this file under "Dep additions" with a one-line justification.
- We expect lockfile conflicts to be resolvable by accepting both adds. If the dep is large (>2 MB shipped), flag it before installing.

Currently expected new deps for 2.8: none for Day 1 (use native `fetch` / `MediaRecorder` / `Audio`), `@ffmpeg/ffmpeg` or similar only if you need format conversion (please flag first), `onnxruntime-web` if you go that route for whisper-cpp-wasm (also flag first — it's ~30 MB).

---

## 8. PR / merge protocol

- One PR per "Day N" milestone above. Smaller is better.
- PR title format: `[2.8] Day N — <thing>`. Body must include: which files in §3 were touched, which migrations were added, any new env secrets needed.
- Run `npx tsc --noEmit` locally before opening. Pre-existing `IconRail.tsx` / `Sidebar.tsx` route-name errors are known and acceptable; everything else must be green.
- Do not run `git rebase` or `git merge main` with destructive flags. If your branch is behind, ask main agent to rebase you (we own the destructive git lane).

---

## 9. Communication

- Status updates go in the handoff thread (or `docs/08-lovable-handoff-2.8.md` "Day-N notes" section if no thread).
- Blockers that touch §2 files: stop and ask, do not work around.
- If the spec is ambiguous on something Day 1–3 needs, default to the most privacy-preserving interpretation and note it in the PR.

---

## 10. Dep additions

(append below as you add)

- *(none yet)*

---

## 10b. Open issues to resolve before integration (added 2026-05-08 by main agent)

These are flagged from the §6/§V8/§V9 revision pass. None block your Day 3 work; all must be resolved before main agent wires `ConverseInput` into ChatPanel.

1. **Migration namespace + default mismatch (resolved by corrective migration).** Your `20260508092849_*.sql` violated §4 in two ways: timestamp prefix (`20260508` instead of `20260520_*`) and `prefer_local_audio` default (`true` instead of `false`). Main agent has added `supabase/migrations/20260510000010_phase26_voice_default_correction.sql` which resets the default to `false` and normalises existing rows. **Action for you:** for any *future* 2.8 migration, please use the agreed `20260520_*` prefix.

2. **Resolver capability guard (already patched by main agent).** `resolveAudioPair()` now takes a third `nativeShell: boolean = false` argument and coerces `preferLocal=false` whenever `nativeShell !== true`. This is defense-in-depth so a stale `prefer_local_audio=true` value cannot route a web turn to the `piper-wasm` stub. **Action for you:** when you wire the resolver call from ConverseInput, pass `nativeShell` from the capability probe.

3. **Auth + rate limit on `/api/stt/groq` and `/api/tts/elevenlabs` — release blocker.** Both endpoints currently accept anonymous requests, which exposes the Groq and ElevenLabs API keys to cost-drain abuse. Mirror the auth/quota pattern used by `/api/chat/stream` (Supabase JWT verification + per-user daily token cap) before main agent enables the integration. Treat this as P0 for Day 3.

4. **Capability cache write path missing.** Spec §V9 says the probe result is cached in `user_settings.local_audio_capability` (jsonb). The probe runs and the column exists, but no code currently writes to it. Either add the write (your call — the capability file is in §3) or note in §11 that it's deferred and main agent will own it during integration.

---

## 11. Day 2 notes (2026-05-08)

**Decision: no WASM on web — defer Whisper.cpp / Piper to the Capacitor native shell (~Phase 4).**

Rationale: shipping `onnxruntime-web` (~12 MB gz / ~30 MB raw) plus Whisper tiny q5_1 (~31 MB) plus Piper en-US-amy-low ONNX (~30 MB) plus the espeak-ng phonemizer WASM (~5 MB) totals ~75–100 MB of cold first-PRIVATE-turn cost. `onnxruntime-web` can't be code-split out of the bundle graph either, so even users with `prefer_local_audio = false` would pay a parse cost on the worker. The roadmap memo already says PRIVATE is "scoped Q&A only until WebLLM 7B+ is realistic on phones," and Phase 4 = Capacitor native shell — which is the right runtime for these models.

**What ships on web today:**
- `PRIVATE` STT = `browser-speech-recognition` (Web Speech API). Real on Chromium + Safari 14.1+; returns empty in Firefox.
- `PRIVATE` TTS = `text-only` (resolver enum already supports it).
- Resolver `TOGGLE_OFF.PRIVATE` and `TOGGLE_ON.PRIVATE` both point at this pair on web.
- `whisper-cpp-wasm` and `piper-wasm` adapters stay registered but throw a clear "available in the native app (Phase 4)" error if ever resolved — defense in depth.

**Capability probe changes (`voice-capability.ts`):**
- New `nativeShell: boolean` field (detects Capacitor + UA marker).
- `wasmSimd` is forced to `false` whenever `!nativeShell`, so the "Prefer on-device audio" toggle stays hidden on web.
- Also exposes `mediaDevices`, `audioContext`, `speechRecognition` for honest telemetry.
- `isLocalAudioToggleAvailable()` returns `false` on web unconditionally.

**Settings page (`workspace.voice-settings.tsx`):**
- When `!toggleAvailable`, shows an "On-device audio" explainer card instead of the toggle, naming the native app + Phase 4. Detects "browser doesn't support SpeechRecognition" (Firefox) and adds a hint.
- "What this changes" PRIVATE row reflects the web vs native reality.

**StatusPill copy:**
- When `triple.stt === "browser-speech-recognition"` and `triple.tts === "text-only"` → prefixes the pill with `LOCAL` and renders `browser-speech` instead of the raw provider id, so the user sees `LOCAL · 🎙 browser-speech · 🧠 <model> · 🔊 text-only`.

**Deps NOT installed (deferred to native shell):**
- `onnxruntime-web` — ~30 MB raw, ~12 MB gz. Defer.
- Whisper.cpp tiny-q5_1 model (~31 MB). Defer.
- Piper en-US-amy-low ONNX + espeak-ng WASM (~35 MB combined). Defer.
- `@ffmpeg/ffmpeg` — not needed; Web Speech API consumes raw mic, no transcoding.

**Spec touch-up needed (main agent):** docs/07 spec §V8 "local-audio capability" should be updated to reflect the web vs native split. Suggested edit: clarify that `prefer_local_audio` toggle is gated on `nativeShell === true` until Phase 4. Will land alongside broker work — no Day-2 conflict expected.

**§6 of this doc:** Day 2 deliverables 5–7 (whisper-cpp-wasm, piper-wasm, full WASM capability probe) are explicitly descoped to the native shell milestone. The next contractor reading §6 should treat `browser-speech-recognition` + capability probe + settings gating + StatusPill copy as the actual Day 2 closure.

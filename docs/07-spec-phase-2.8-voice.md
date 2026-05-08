# Spec — Phase 2.8: Voice (STT + TTS) & Unified Converse Surface

*Status: Draft v1 · Owner: Sneha · Depends on: Phase 2.6 (chat providers), Phase 2.7 (context broker) · Target: 5 days · Pairs with: future Phase 3 (WebLLM on-device inference)*

> **Framing.** Phase 2.6 made chat real (badge-routed, capped, telemetered). Phase 2.7 makes it personalized via the broker. Phase 2.8 makes the same chat **bidirectionally voice-capable** — push-to-talk in, TTS out, with the same four badges deciding the inference path and a single new "Prefer on-device when possible" toggle deciding the audio path. **No new mental model for the user.** No "voice mode" vs "chat mode" — one Converse surface, voice is just an input/output modality.

> **What this is not.** Not a wake-word always-listening assistant. Not a phone-call replacement. Not a multi-speaker meeting transcriber. Not on-device LLM inference (that's Phase 3 / WebLLM). Not real-time barge-in interruption (mute-during-TTS for v1).

---

## 1. Goal & non-goals

**Goal.** Ship a Converse surface where:
- Holding the mic button (or Space on desktop) starts capture; releasing commits.
- Speech is transcribed via the badge-appropriate STT path, sent through the existing chat chain runner, and the assistant reply is read back via the badge-appropriate TTS path.
- Privacy claims are **honest at the pixel** — a status pill shows the actual STT/LLM/TTS providers in use for the current turn, not a marketing label.
- Audio bytes are **never persisted**, never POSTed to our backend. Hard contract enforced in adapters and asserted in tests.
- The four badges (FLASH/PRO/Genius/PRIVATE) and one new toggle ("Prefer on-device when possible") together determine the full (STT, LLM, TTS) triple.

**Non-goals (explicit).**
- **No second axis of user choice.** No "voice tier" picker. The badge × toggle product is the only fan-out.
- **No wake word.** Not even paid. Revisit after the native shell ships and OS-level mic permissioning matters.
- **No real-time barge-in.** Mic is muted during TTS playback in v1. Tap-to-interrupt on the speaking orb stops TTS and starts listening.
- **No speculative TTS streaming in v1.** Sentence-boundary commit-on-final only. Streaming arrives in v1.1 once we have telemetry on which engines users actually pick.
- **No persistence of raw audio anywhere.** Not for retry, not for "your voice memos." Voice memo as a separate feature is Phase 3+.
- **No multi-language detection in v1.** UI locale picks the STT/TTS language; one locale per user.
- **No voice cloning, no custom TTS voices in v1.** One voice per tier, pickable in settings if cloud TTS is enabled.

---

## 2. The one metric

**Voice-turn latency p50 (VTL):** time from mic button release → first audible TTS byte.

- **Target for v1:** ≤ **1200ms p50** with default settings (Balanced, toggle OFF).
- **Hard ceiling:** 2500ms p50. Above this, the user perceives lag and the surface feels broken — pause TTS streaming and degrade to text-only response with a "voice slow on your network" toast.
- Computed from client-side timing marks, sent up as a single `voice_turn_latency_ms` field on the existing `inference_usage` row.

Cost-per-active-user-per-day (CPAUD from 2.6) is the durable metric — voice piggybacks on the same telemetry. Voice-attributable spend is logged as `audio_micro_usd` on the same row. The combined CPAUD ceiling stays $1.50/user/day; voice gets ~$0.30 of that headroom.

---

## 3. Decisions

### V0. The product surface (locked)
**Decision:** **One Converse surface.** The existing ChatPanel becomes the Converse panel. A mic button sits to the left of the text input. Holding it (or holding Space when the panel is focused) records; releasing transcribes and sends. The assistant reply renders as text **and** plays as audio simultaneously. There is no "voice mode" toggle — every chat session can use voice and text interchangeably, turn by turn.

**Why:** the user has already learned the four badges from 2.6. Adding a "voice mode" with its own settings doubles the surface area for zero product win. Modality is per-turn, not per-session.

**Forecloses:** a separate "/voice" route, a hands-free always-on listening mode, dedicated voice settings beyond the on-device toggle and TTS voice pick.

### V1. The single new setting
**Decision:** Settings adds **exactly one** new control: a toggle labelled **"Prefer on-device audio when possible."** Default **OFF** (cloud STT/TTS for lower latency). Stored in `user_settings.prefer_local_audio` (boolean, default false), mirrored in `localStorage` for offline read on Converse mount.

**Why:** Phase 1 critique #2 — adding 3 privacy tiers as a second axis next to 4 intent badges creates decision fatigue. One toggle that fans out across STT/TTS/inference is the cleanest defensible product.

**Forecloses:** per-modality toggles (no "use cloud STT but local TTS" power-user knob in v1), per-thread voice settings, per-badge voice overrides.

### V2. Badge × toggle → (STT, LLM, TTS) resolution matrix
**Decision:** The Converse surface resolves the triple from `(badge, prefer_local_audio)`. Hardcoded in 2.8 — no learned policy.

**Toggle OFF (default — cloud-allowed, lower latency):**
| Badge | STT | LLM (from 2.6) | TTS |
| --- | --- | --- | --- |
| FLASH | `groq-whisper` | groq → google → cloudflare → lovable | `elevenlabs-flash` (cheap, 200ms) |
| PRO | `groq-whisper` | anthropic → openai → groq → lovable | `elevenlabs-flash` |
| Genius | `elevenlabs-scribe` (realtime) | openai → anthropic → lovable | `elevenlabs-multilingual-v2` (premium voice) |
| PRIVATE | `whisper-cpp-wasm` | cloudflare (fail-closed) | `piper-wasm` |

**Toggle ON ("prefer on-device"):**
| Badge | STT | LLM | TTS |
| --- | --- | --- | --- |
| FLASH | `groq-whisper`* | groq → google → cloudflare → lovable | `piper-wasm` |
| PRO | `groq-whisper`* | anthropic → openai → groq → lovable | `piper-wasm` |
| Genius | `groq-whisper` | openai → anthropic → lovable | `piper-wasm` |
| PRIVATE | `whisper-cpp-wasm` | cloudflare (fail-closed) | `piper-wasm` |

\* Toggle ON does not move STT to local for FLASH/PRO/Genius — `whisper.cpp` is too slow on mid-tier mobile (real-time factor 0.5–1.0 on Pixel 6a) for an "instant" badge. Local STT is reserved for PRIVATE, where the latency tradeoff is the point. The toggle's STT effect is "use on-device when it's the privacy story" — currently only PRIVATE.

**Why:** PRIVATE is the only badge where slower local STT is consistent with the user's stated intent. Forcing local STT on FLASH would make FLASH not flash. TTS is more forgiving — Piper is fast enough that local TTS works across all badges when the user opts in.

**Forecloses:** local STT on non-PRIVATE badges in v1 (revisit when WebGPU-accelerated browser STT lands), voice-tier picker, mixed STT/TTS overrides per badge.

### V3. The status pill (honesty at the pixel)
**Decision:** A small pill in the Converse input row shows the **actual** active path for the current turn, in this format: `🎙 groq · 🧠 anthropic · 🔊 piper`. Updates the moment the path resolves (before the LLM call returns), not after. On fallback, the pill updates live: `🎙 groq · 🧠 anthropic→openai · 🔊 piper`.

**Why:** privacy claims that don't match runtime behavior are worse than no claims. The pill is the single source of truth the user can verify. No marketing labels ("Balanced") in the pill — only provider ids.

**Privacy badge color logic (also enforced at the pixel):**
- 🟢 Green: every component in the triple is on-device. Currently only `(PRIVATE, toggle ON)`.
- 🟣 Violet: at least one cloud component, but no closed-weight LLM in the chain. (Most FLASH paths.)
- 🟡 Amber: closed-weight cloud LLM in the chain (PRO/Genius).

The badge color is computed per-turn from the resolved triple, not from the user's selected badge. A `(FLASH, toggle OFF)` turn that fell through to OpenAI gets amber for that one turn, then back to violet on the next FLASH turn that lands on Groq. **No persistent green claim built on cloud reality.**

### V4. Audio retention contract (hard rule, asserted in tests)
**Decision:** STT adapter contract requires:
```ts
type SttAdapter = {
  transcribe(audioBytes: Uint8Array, opts: SttOpts): Promise<SttResult>;
  privacyTier: PrivacyTier; // T0 (local) | T2 (cloud, zero-retention) | T3 (cloud, may retain)
  requiresNetwork: boolean;
}
```
The caller wraps every `transcribe()` in a `try/finally` that nulls the `audioBytes` reference after the call. The audio buffer is never written to IndexedDB, never POSTed to our backend, never put on a queue, never assigned to a longer-lived variable. A unit test in `src/server/inference/stt/__tests__/no-persistence.test.ts` greps the adapter sources for `localStorage|indexedDB|fetch.*audio|writeFile` and fails the build if any STT adapter touches storage primitives.

**Why:** the privacy story collapses if a single retry path quietly stashes the raw bytes. Make it impossible by contract + test, not by code review.

### V5. VAD & end-of-utterance
**Decision:** **Silero VAD WASM** (~2MB, lazy-loaded on first Converse open) detects end of speech. Hangover 200ms, end-of-utterance probability threshold 0.5. STT is invoked only after VAD signals end, not on every chunk. Mic button release is the override — it always commits whatever's been captured, even if VAD is mid-decision.

**Why:** relying on STT silence detection is laggy (300–500ms typical). VAD halves end-of-utterance latency and is the single biggest contributor to the 1200ms VTL target.

**Fallback:** if Silero fails to load (rare WASM init failure on old Android), fall back to fixed 800ms silence timer + button release. Status pill shows `vad: timer` instead of `vad: silero` so we can debug.

### V6. Push-to-talk only (v1)
**Decision:** Hold-to-talk on the mic button. Hold Space when Converse is focused (desktop). No wake word. No tap-to-toggle (avoids "is it listening?" anxiety). Visual: mic button pulses violet while held, has a 200ms grace period after release to capture trailing audio.

**Forecloses:** wake word in v1, "tap once to start, tap again to stop" mode, voice activity-triggered start.

### V7. Barge-in: muted-during-TTS (v1)
**Decision:** Mic is **disabled** while TTS is playing. The speaking orb (animated waveform around the assistant avatar) is tappable; tap stops TTS, unmutes the mic, and starts listening. This gets the "interrupt the assistant" feel without fighting browser AEC.

**Why:** Chrome's AEC is unreliable across versions and OEMs. A real barge-in path requires per-platform testing matrix we don't have time for in v1. The tap-to-interrupt affordance is one tap and ~200ms — fast enough to feel conversational.

**Revisit in v1.2:** browser AEC + native echo cancellation in the Tauri shell may make true full-duplex viable on desktop.

### V8. Per-tier fallback ladder (graceful degradation, surfaced in UI)
**Decision:** Each badge has a deterministic STT and TTS fallback chain. Status pill reflects the actual provider hit, never the intended one. **No silent downgrades.**

**STT chains:**
- PRIVATE: `whisper-cpp-wasm` → **no fallback** (show error: "Local STT unavailable on this device. Switch tier or grant mic permission.")
- FLASH: `groq-whisper` → `google-stt` → `browser-speech-recognition` (Safari only, on-device on Apple)
- PRO: `groq-whisper` → `deepgram-nova-2` → `google-stt`
- Genius: `elevenlabs-scribe` → `groq-whisper` → `google-stt`

**TTS chains:**
- PRIVATE: `piper-wasm` → **no fallback** (show: "Local TTS unavailable. Reply shown as text only.")
- FLASH/PRO (toggle OFF): `elevenlabs-flash` → `piper-wasm` → text-only
- Genius (toggle OFF): `elevenlabs-multilingual-v2` → `elevenlabs-flash` → `piper-wasm` → text-only
- All badges (toggle ON): `piper-wasm` → text-only

**Why:** users on cheap Android with no WebGPU, or iOS Safari with full storage, will hit fallbacks regularly. Hiding the fallback under a marketing label trains them to distrust the privacy claim. Surfacing it builds trust and gives us a bug report channel ("status pill said `piper→text-only` — fix it").

### V9. Local-tier capability probe & scoping
**Decision:** On first app open after 2.8 ships, run a one-time capability probe:
1. WebGPU available? (`navigator.gpu`)
2. OPFS quota ≥ 1.2GB? (StorageManager.estimate)
3. WASM SIMD support? (small feature-detect script)

Result is cached in `user_settings.local_audio_capability` (jsonb: `{webgpu: bool, opfsBytes: number, wasmSimd: bool, probedAt: iso}`). If any required capability is missing, the "Prefer on-device" toggle is **hidden, not disabled**. The PRIVATE badge stays available but its TTS falls back to text-only with an explainer.

**iOS Safari today:** OPFS cap is ~1GB per origin. WebLLM 3B model = 1.5GB. Probe will fail; toggle hidden on iPhone. PRIVATE badge still usable for text. Honest, not silently degraded.

**Local LLM scoping (re-stated for the spec):** The "Local 🟢" inference path that PRIVATE will eventually run via WebLLM (Phase 3) advertises only: "Answer questions about your data, summarize, recall." Drafting, scheduling, and multi-step actions show a chip in the input row: "Needs cloud — switch tier or allow once." The chip is added in 2.8 even though the WebLLM tier doesn't exist yet, so the affordance ships consistent.

### V10. Cold-start UX for local stack
**Decision:** First-use download UI is a real progress bar with bytes + ETA, not a spinner. Three downloadable assets:
- `silero-vad.wasm` (~2MB) — lazy-loaded on first Converse open
- `whisper-cpp-tiny.wasm` + tiny model (~75MB) — lazy-loaded on first PRIVATE turn
- `piper-en-US-amy-low.onnx` (~30MB) — lazy-loaded on first toggle-ON turn

All cached in OPFS with a versioned filename (`piper-en-US-amy-low-v3.onnx`) so model upgrades don't break offline. Total local stack footprint v1: **~107MB**, well under the iOS 1GB cap. WebLLM (Phase 3) is the asset that pushes us over.

### V11. Cost & telemetry
**Decision:** Every voice turn writes one row to the existing `inference_usage` table. New columns added in 2.8:
- `stt_provider TEXT` (nullable — text turns leave it null)
- `stt_model TEXT`
- `stt_latency_ms INT`
- `tts_provider TEXT`
- `tts_model TEXT`
- `tts_chars INT`
- `tts_latency_ms INT` (time-to-first-byte)
- `audio_micro_usd BIGINT DEFAULT 0` (STT + TTS combined)
- `vtl_ms INT` (total voice-turn latency, client-reported)

Pricing constants in `src/server/inference/audio-pricing.ts`:
- Groq Whisper-large-v3-turbo: $0.04/hr
- ElevenLabs Flash v2: $0.30/1K characters
- ElevenLabs Multilingual v2: $0.50/1K characters
- ElevenLabs Scribe realtime: $0.40/hr
- Piper / whisper.cpp: $0
- Deepgram Nova-2: $0.0043/min

A "Settings → Usage" page (added in 2.8) shows a monthly meter with a soft cap of $30/user/month, raisable in settings. Above the cap, the user gets a one-time "you've hit your monthly cap — raise it or stay on FLASH" modal, then continues without hard blocking. Same logic as 2.6 daily caps, separate ledger.

### V12. Optimistic UI & sentence-boundary TTS commit
**Decision:**
- User's transcribed message renders in the thread the moment STT returns final, before the LLM call.
- Live partial transcripts render in a **caption strip** above the input, never in the thread itself (saves Pixel-class re-render cost).
- TTS plays the assistant reply **after** the full reply text returns. No mid-stream TTS in v1.
- Sentence-boundary streaming TTS (the "60–80% perceived latency win" from the proposal) is deferred to v1.1 as honest scope. Building it correctly requires sentence detection that survives "Dr.", "1.5GB", code blocks, plus a tiered TTS engine adapter for streaming inputs. ~2 weeks of careful work.

**Why deferred:** committing on full reply is fine for sub-2s TTFT replies (FLASH, PRO with Groq). For Genius with cloud TTS, we'll feel the lack of streaming — but Genius is the slowest path anyway; users picked it for quality, not speed. The right time to build streaming TTS is when we have telemetry on which TTS engines users actually pick, not before.

---

## 4. Schema additions (one migration)

Migration: `supabase/migrations/20260530000000_phase28_voice.sql`

```sql
-- 1. Settings: the single new toggle + capability cache
ALTER TABLE public.user_settings
  ADD COLUMN prefer_local_audio BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN local_audio_capability JSONB;

-- 2. Voice telemetry on the existing chat row
ALTER TABLE public.inference_usage
  ADD COLUMN stt_provider TEXT,
  ADD COLUMN stt_model TEXT,
  ADD COLUMN stt_latency_ms INT,
  ADD COLUMN tts_provider TEXT,
  ADD COLUMN tts_model TEXT,
  ADD COLUMN tts_chars INT,
  ADD COLUMN tts_latency_ms INT,
  ADD COLUMN audio_micro_usd BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN vtl_ms INT;

-- No new tables. No new RLS policies (inherits from inference_usage).
-- No raw audio columns anywhere — by design.
```

**What this forecloses:** a `voice_sessions` table (no session concept — every turn is independent), a `voice_memos` table (separate Phase 3+ feature), per-utterance audio storage of any kind.

---

## 5. Code structure

```
src/server/inference/
  stt/
    index.ts            (STT adapter registry + tier metadata)
    types.ts            (SttAdapter, SttResult, PrivacyTier)
    groq-whisper.ts
    google-stt.ts
    elevenlabs-scribe.ts
    deepgram.ts
    browser-speech.ts   (Safari on-device only)
    whisper-cpp-wasm.ts (loads from OPFS)
    __tests__/no-persistence.test.ts  ← greps for storage primitives
  tts/
    index.ts
    types.ts
    elevenlabs-flash.ts
    elevenlabs-multilingual.ts
    piper-wasm.ts
  audio-pricing.ts      (cost constants + computeAudioCost)

src/lib/
  voice-preferences.ts  (single source of truth for prefer_local_audio,
                         localStorage + Supabase sync)
  voice-resolver.ts     (badge × toggle → (stt, llm, tts) triple)
  voice-capability.ts   (the one-time capability probe)

src/components/workspace/
  ConverseInput.tsx     (mic button + caption strip + status pill)
  StatusPill.tsx        (renders the live triple)
  SpeakingOrb.tsx       (animated waveform, tap-to-interrupt)

public/voice/           (lazy-loaded WASM assets — served from OPFS after first fetch)
  silero-vad.wasm
  whisper-cpp-tiny.wasm
  piper-en-US-amy-low.onnx
```

**No changes to:** `src/server/inference/chat.ts` (chain runner), `src/server/inference/router.ts` (badge chains), `src/lib/chat.functions.ts` (server functions). The voice work plugs into the chat path **before** the LLM call (STT → text) and **after** the LLM reply (text → TTS), without touching the existing chain logic.

---

## 6. Day-by-day target (5 days)

| Day | Deliverable |
| --- | --- |
| 1 | Migration + adapter contracts + STT adapters (groq, google, browser-speech) + no-persistence test green. Mic button captures, transcribes via Groq, posts text to existing `sendChatMessage`. No TTS yet. Status pill shows STT only. |
| 2 | TTS adapters (elevenlabs-flash, elevenlabs-multilingual). Reply plays back through cloud TTS. Audio pricing wired into `inference_usage`. Status pill shows full triple. |
| 3 | Local stack: Silero VAD WASM, Piper WASM TTS, capability probe, cold-start progress UI. Toggle ON path works for FLASH/PRO/Genius (Piper TTS) and PRIVATE (full local except STT). |
| 4 | whisper-cpp-wasm STT for PRIVATE. Speaking orb + tap-to-interrupt. Per-tier fallback ladders wired. Privacy color logic (green/violet/amber) per turn. |
| 5 | Settings → Usage meter ($30/mo soft cap). Local-LLM scoping chip ("needs cloud") on drafting/scheduling intents in PRIVATE. Architect review. |

**Architect review checkpoints:** after Day 2 (cloud path correct + telemetry sane), after Day 5 (full surface).

---

## 7. Out-of-scope explicit

- WebLLM on-device LLM inference (Phase 3, separate spec)
- Voice cloning / custom voices
- Multi-language switching mid-session
- Wake word
- Real-time barge-in with browser AEC
- Speculative sentence-boundary TTS streaming (v1.1)
- Voice memos / saved utterances
- Speaker diarization
- Translation (transcribe in one language, reply in another)
- Voice-driven tool calls beyond what the existing chat chain already does

---

## 8. Open questions (decide before Day 1)

1. **TTS voice picker UI.** Do we ship one default voice per tier (simpler) or let the user pick from a small curated list (better feel)? Default position: one voice per tier in v1, picker in v1.1.
2. **Caption strip persistence.** Does the live partial transcript stay visible after commit, or fade out? Default position: fade out 500ms after final.
3. **Mobile button placement.** Mic on left of input or as a floating action button? Default position: left of input, matches desktop.
4. **What happens when the user holds the mic but says nothing?** Default position: VAD never triggers, button release commits 0 bytes, no API call, no telemetry row. Silent no-op.

---

## 9. The honest summary

This spec ships a Converse surface where voice and chat are the same thing, the four badges still mean what they meant in 2.6, one new toggle decides on-device vs cloud audio, and the privacy story is enforced by adapter contracts + tests + a status pill that tells the truth turn by turn. It deliberately defers streaming TTS, barge-in, wake word, and on-device LLM inference because those are bigger commitments that earn their way in via telemetry, not vibes.

Five days. One migration. Nine adapters. Zero changes to the chat chain runner.

# Spec — Slice B: Voice-Profile Drafts (V1)

*Status: Draft for review · Owner: Sneha · Depends on: Decision Doc D1–D6 · Target: 4 weeks*

---

## 1. User story

> As a user with a connected Gmail account, when an email lands in my Inbox queue that needs a reply, I see a one-tap **"Draft reply"** action. Tapping it opens a draft written in *my* voice using one of 5 templates (Acknowledge · Decline · Schedule · Ask for info · Confirm). I can edit, send, or dismiss. The draft never leaves my device unless I explicitly hit Send.

### Acceptance criteria

1. Within 7 days of connecting Gmail, the system has built a "voice profile" from the user's last 200 sent messages (sign-off, average sentence length, characteristic openers/closers, formality score).
2. For any email categorised as `Urgent` or `Today`, a **Draft reply** button appears in the Inbox queue and on the email detail view.
3. Tapping Draft reply produces a reply in <3 seconds, choosing the most appropriate of the 5 templates based on the incoming email's intent.
4. The draft uses the user's actual sign-off (e.g. "Cheers, Sneha") and matches their typical sentence rhythm.
5. The user can: send (opens Gmail compose pre-filled), edit inline then send, regenerate (try a different template), or dismiss.
6. Every draft is logged in a new **Drafts** sidebar surface with status (`pending`, `sent`, `dismissed`, `edited_then_sent`) so we can measure the V1 metric.

---

## 2. The one metric

**Edit-distance-to-send (EDTS):** the % of drafts the user sends with ≤1 word edited.

- Target for V1 release: **≥35%** on a 50-user beta cohort.
- Below 25% = the voice model is bad; pause and iterate before scaling.
- Logged per draft as `chars_edited / chars_in_draft`. Aggregated weekly.

This is the only number we optimize for in Slice B. Latency and template-coverage are guardrails, not goals.

---

## 3. Scope

### In scope (V1)
- Sent-folder ingestion (last 200 messages, refreshed weekly).
- Voice profile extraction → stored as a structured JSON artifact, not a fine-tuned model.
- 5 fixed templates with slot-filling: Acknowledge, Decline politely, Schedule, Ask for more info, Confirm.
- Template selection via a small classifier (intent of incoming email → template).
- Generation via Lovable AI Gateway (`gemini-3-flash-preview`) with the voice profile + template + incoming email as the prompt context.
- New **Drafts** sidebar surface listing pending/sent/dismissed drafts.
- Edit + send opens Gmail web compose pre-filled (no Gmail-send API in V1 — keeps us out of the Gmail send-permission scope).

### Explicitly out of scope (V1)
- Free-form generation outside the 5 templates.
- Tone selector (the voice profile *is* the tone).
- Multi-turn email threads (only first-reply drafts).
- WebLLM-powered local generation (deferred to Power-mode in a later release).
- WhatsApp / Slack / iMessage drafting.
- Calendar-aware scheduling replies (e.g. "I'm free Tuesday 2pm" — Phase 3).
- Sending email *through* NC (we open Gmail compose; we don't relay).
- A/B testing UI or per-template metrics.

---

## 4. Privacy boundary

| Data | Where it lives | Crosses network? |
|---|---|---|
| Sent-folder messages (raw) | Fetched on-demand from Gmail; never persisted. | Gmail → Worker → derived profile only. Raw messages discarded after extraction. |
| Voice profile JSON | `voice_profiles` table, encrypted at rest. | Stored in our DB. Per D5, we'll revisit local-only storage in Phase 3. |
| Incoming email being replied to | Already in `memory_nodes` per Phase 1. | No new exposure. |
| Generated draft | `drafts` table, encrypted at rest. | Stored server-side until sent or dismissed. |
| Prompt sent to Lovable AI Gateway | Voice profile + template + incoming email subject/snippet. | **Yes — sent to Lovable AI Gateway.** This is the V1 trade-off. Disclosed in onboarding. |

**Disclosure copy (must appear in the consent screen):**
> To draft replies in your voice, NC sends the email you're replying to and a short summary of your writing style to our AI provider. Your full sent folder, contacts, and other emails are *not* sent. You can turn this off in Settings.

**Feature flag:** `ENABLE_VOICE_DRAFTS` — default off; enabled via the consent screen on first use.

---

## 5. Data model deltas

### New table: `voice_profiles`
```
id                   uuid pk
user_id              uuid fk → auth.users
sign_off             text       -- "Cheers, Sneha"
opener_phrases       text[]     -- ["Hope you're well", "Thanks for the note"]
avg_sentence_length  int
formality_score      numeric    -- 0.0 (casual) → 1.0 (formal)
characteristic_phrases text[]   -- top 20 n-grams unique to user
sample_count         int        -- how many sent messages it was built from
built_at             timestamptz
expires_at           timestamptz -- triggers weekly refresh
```
RLS: `auth.uid() = user_id`.

### New table: `drafts`
```
id                uuid pk
user_id           uuid fk
source_node_id    uuid fk → memory_nodes  -- the email being replied to
template          text       -- 'acknowledge' | 'decline' | 'schedule' | 'ask_info' | 'confirm'
body              text       -- generated reply
status            text       -- 'pending' | 'sent' | 'dismissed' | 'edited_then_sent'
chars_in_draft    int
chars_edited      int        -- populated on send
created_at        timestamptz
resolved_at       timestamptz
```
RLS: `auth.uid() = user_id`.

### `memory_nodes` — no schema change
But we'll add a derived virtual field `can_draft_reply: boolean` based on category ∈ {Urgent, Today}.

---

## 6. API surface

All new endpoints are TanStack Start server functions in `src/server/voice-drafts.functions.ts`.

```
buildVoiceProfile()          // pulls last 200 sent messages, extracts profile, upserts row. Idempotent. Returns profile summary.
getVoiceProfile()            // returns current profile or null.
draftReply(memoryNodeId)     // returns { draftId, body, template }. Generates via gateway.
regenerateDraft(draftId)     // re-runs with the next-best template.
markDraftSent(draftId, finalBody)   // diff vs. original → chars_edited; status → sent or edited_then_sent.
dismissDraft(draftId)        // status → dismissed.
listDrafts({status?, limit})  // for the Drafts sidebar surface.
```

Server-only helpers (in `src/server/voice-profile.server.ts`):
- `extractVoiceProfile(messages: SentMessage[]): VoiceProfile` — pure function, deterministic, no AI.
- `selectTemplate(incomingEmail): TemplateId` — small classifier (rules first, gateway fallback).
- `renderDraftPrompt(profile, template, incomingEmail): string`.

---

## 7. UX surfaces

### 7.1 Inbox queue — new affordance
On any item with `category ∈ {Urgent, Today}`, a small "✦ Draft reply" button appears next to the existing category tag. Tapping it spawns a draft inline (collapsible card under the email row).

### 7.2 New sidebar item — **Drafts**
Replaces Mindmap in the sidebar (per D6). Three tabs:
- **Pending** — drafts awaiting user action.
- **Sent** — sent drafts with edit-distance shown ("you edited 12% of this draft").
- **Dismissed** — for diagnostics.

### 7.3 Voice profile settings page
Read-only display of the extracted profile so the user can see what NC believes about their voice. Includes a **Rebuild profile** button and an **Off** toggle for the whole feature.

### 7.4 First-run consent screen
Shown the first time the user clicks Draft reply. Single screen, three bullets (what we send, what we don't, how to turn it off), one button: "Turn on Voice Drafts."

---

## 8. Sequencing (4 weeks)

| Week | Deliverable | Done = |
|---|---|---|
| 1 | Sent-folder ingestion + `extractVoiceProfile` (deterministic, no AI). Tests against 5 sample mailboxes. | Profile JSON visible in Settings; rebuild works. |
| 2 | `draftReply` endpoint + template prompts + gateway integration. Drafts table + RLS. | A draft renders in <3s for 10 test emails across the 5 templates. |
| 3 | Inbox-queue affordance + Drafts sidebar surface + consent screen + edit-distance tracking. | End-to-end: connect Gmail → first draft → send → metric logged. |
| 4 | Beta gate, telemetry dashboard for EDTS, polish, error states (no profile yet, gateway down, Gmail token expired). | 50-user beta cohort enabled; EDTS visible in an internal dashboard. |

---

## 9. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Voice profile sounds nothing like the user. | Med | Start with sign-off + sentence length + n-grams (deterministic, recognisable). Add formality score. Don't try to "be clever" in V1. |
| Template selector picks the wrong template. | Med | Always offer "Regenerate" → cycles through other templates. Track regenerate-rate as a secondary metric. |
| Gateway latency >3s under load. | Low | Pre-warm with a tiny "ping" prompt on Inbox load. Stream the response. |
| User feels surveilled by "we read your sent folder." | Med | The consent screen is the most important UI in this slice. Iterate copy with 5 real users before launch. |
| Gmail send permission scope feels invasive. | High (if we asked for it) | Avoided — V1 opens Gmail compose pre-filled, no send scope needed. |

---

## 10. Open questions to close before code

1. Do we ship Slice A (tiny ONNX classifier) inside this 4-week window, or sequence it as a Week 5–6 follow-up? *Recommendation: defer to weeks 5–6 — Slice B doesn't depend on it.*
2. Per-user voice profile encryption: same `crypto.server.ts` envelope as OAuth tokens, or a separate key? *Recommendation: same envelope, simpler.*
3. Do we expose the voice profile via a "share with a friend" diff for QA? *Out of scope V1.*

---

## 11. Definition of done

- [ ] All acceptance criteria in §1 verified on 3 real Gmail accounts (mine + 2 beta users).
- [ ] EDTS metric instrumented and visible in a dashboard.
- [ ] Consent screen reviewed by 5 non-technical users; ≥4/5 understand what is/isn't sent.
- [ ] Feature flag `ENABLE_VOICE_DRAFTS` works (off = no UI changes anywhere).
- [ ] One short Loom for the marketing site.

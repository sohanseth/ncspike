/**
 * Pre-draft "assistant brain" step. Looks at an incoming email and
 * decides:
 *   1. What kind of email this is (intent)
 *   2. Whether the assistant should ask the user 1-2 quick questions
 *      before drafting (e.g. for an interview: "how much prep time
 *      would you like?")
 *   3. A short "assistant note" — the assistant's read of the situation,
 *      surfaced to the user above the draft so they know why the draft
 *      proposes what it proposes.
 *
 * The model is asked for strict JSON; we parse leniently and fall back
 * to a no-questions / empty-note result on any failure so drafting is
 * never blocked by a flaky analyze step.
 */
import { generate, InferenceError } from "@/server/inference";
import type { IncomingEmail } from "@/server/voice-profile.server";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

export type EmailIntent =
  | "interview"
  | "meeting"
  | "decision"
  | "info_request"
  | "introduction"
  | "sales"
  | "casual"
  | "other";

export type AssistantQuestion = {
  /** Stable id used to attach the user's answer back to the prompt. */
  id: string;
  /** Question shown to the user. */
  question: string;
  /** Suggested placeholder for the input field. */
  placeholder: string;
};

/**
 * Optional one-click follow-up reminder the assistant can propose alongside the
 * draft. Surfaced in the draft panel as a single button that creates a calendar
 * event N days from now. `afterDays` is bounded server-side (1-60). Omit when
 * the email needs no follow-up (most casual chat, FYIs, completed threads).
 */
export type SuggestedFollowUp = {
  afterDays: number;
  /** Short summary used as the calendar event title, e.g. "Chase Maya re: vendor decision". */
  summary: string;
};

export type EmailAnalysis = {
  intent: EmailIntent;
  /** True if drafting benefits from user input first. */
  needsClarification: boolean;
  /** 0-2 questions to ask before drafting. Empty if none needed. */
  questions: AssistantQuestion[];
  /** 1-3 sentence read of the email + what the assistant would suggest. */
  assistantNote: string;
  /** Optional follow-up reminder proposal (one per draft). */
  followUp?: SuggestedFollowUp;
};

const EMPTY_ANALYSIS: EmailAnalysis = {
  intent: "other",
  needsClarification: false,
  questions: [],
  assistantNote: "",
};

const SYSTEM_PROMPT = `You are an assistant analyzing an incoming email to help your user reply thoughtfully. You decide (a) what kind of email this is, (b) whether you need to ask the user 1-2 quick clarifying questions before drafting a reply, and (c) what to whisper to the user about the situation.

Output STRICT JSON only. No prose before or after. Schema:
{
  "intent": "interview" | "meeting" | "decision" | "info_request" | "introduction" | "sales" | "casual" | "other",
  "needsClarification": boolean,
  "questions": [
    { "id": "string", "question": "string", "placeholder": "string" }
  ],
  "assistantNote": "string",
  "followUp": { "afterDays": number, "summary": "string" } | null
}

Rules:
- If intent is "interview", ALWAYS include a question with id "prep_time" like "How much prep time would you like for this one?" with a placeholder such as "2 days" or "1 week". Different roles need different prep — never assume a fixed buffer.
- If the email is asking the user to propose meeting times (intent "interview" or "meeting" where the sender wants the user's availability), include a question with id "availability" (EXACTLY that id) like "What times work for you?" with a placeholder such as "Thursday after 2pm, Friday all day". The UI will offer a one-click suggestion from the user's actual calendar for this question, so the id must match.
- If you'd need user context to draft well (e.g. "do you already know this person?"), include 1 more question with a descriptive id (e.g. "company_familiarity", "decision_lean").
- For straightforward emails (casual chat, simple acknowledgment), use needsClarification: false and questions: [].
- Maximum 2 questions. Each question must be answerable in a short free-text reply.
- assistantNote is 1-3 sentences in plain text — your honest read: what the email is, what's at stake, what you'd suggest. Address the user directly ("This looks like…", "I'd suggest…"). Do not write the draft itself here.
- followUp: include ONLY when the user would plausibly want a calendar reminder to come back to this thread (e.g. waiting on a decision, expecting a reply by a date, sales follow-through). Set afterDays between 1 and 14, and summary to a short imperative like "Chase Maya re: vendor pricing" or "Decide on the offer". Omit (or set null) for casual chat, FYIs, interview invites already covered by prep blocks, or anything that doesn't need a future nudge.
- Never invent facts not present in the email.`;

function buildUserPrompt(email: IncomingEmail): string {
  const sender = email.originalSender || email.from;
  const body = (email.body ?? email.snippet ?? "").trim();
  const truncated = body.length > 4000 ? body.slice(0, 4000) + "\n[...truncated]" : body;
  const lines = [
    `From: ${sender}`,
    email.originalSender && email.originalSender !== email.from
      ? `(Forwarded by: ${email.from})`
      : "",
    `Subject: ${email.subject}`,
    `Body:`,
    truncated,
  ].filter(Boolean);
  return lines.join("\n");
}

/** Pull the first balanced {...} block out of a possibly-noisy LLM response. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Map model-emitted variants of the "what times work for you" question to the
 * canonical id "availability" so the UI can rely on a stable contract for the
 * "Use my calendar" suggestion chip.
 */
function normalizeQuestionId(rawId: string, questionText: string): string {
  const id = rawId.trim().toLowerCase();
  if (id === "availability" || id === "prep_time") return id;
  // Common model variants we've seen: avail*, time_slots, times, slots,
  // when, when_free, schedule, available_times, meeting_times.
  if (/^(avail|time[_\s-]?slot|times?|slots?|when|schedule|available[_\s-]?times?|meeting[_\s-]?times?)$/i.test(id)) {
    return "availability";
  }
  // Fallback: if the question text strongly implies asking for free times,
  // snap to "availability". Conservative — must mention both time/slot AND
  // a verb of asking ("work", "available", "free").
  if (/\b(time|slot|when)\b/i.test(questionText) &&
      /\b(work|available|free|good|prefer)\b/i.test(questionText)) {
    return "availability";
  }
  return id;
}

function coerceAnalysis(raw: unknown): EmailAnalysis {
  if (!raw || typeof raw !== "object") return EMPTY_ANALYSIS;
  const r = raw as Record<string, unknown>;
  const intent = (typeof r.intent === "string" ? r.intent : "other") as EmailIntent;
  const validIntents: EmailIntent[] = [
    "interview", "meeting", "decision", "info_request",
    "introduction", "sales", "casual", "other",
  ];
  const safeIntent = validIntents.includes(intent) ? intent : "other";

  const rawQs = Array.isArray(r.questions) ? r.questions : [];
  const questions: AssistantQuestion[] = rawQs
    .slice(0, 2)
    .map((q): AssistantQuestion | null => {
      if (!q || typeof q !== "object") return null;
      const qq = q as Record<string, unknown>;
      const rawId = typeof qq.id === "string" ? qq.id : "";
      const question = typeof qq.question === "string" ? qq.question : "";
      const placeholder = typeof qq.placeholder === "string" ? qq.placeholder : "";
      if (!rawId || !question) return null;
      // Canonicalize the availability id so the UI's "Use my calendar" chip
      // detection isn't broken by model drift (avail / time_slots / when / etc).
      const id = normalizeQuestionId(rawId, question);
      return { id, question, placeholder };
    })
    .filter((q): q is AssistantQuestion => q !== null);

  // Safety: interviews must have a prep_time question. If the model omitted
  // it, inject a sensible default so the calendar buffer can be derived.
  if (safeIntent === "interview" && !questions.some((q) => q.id === "prep_time")) {
    questions.unshift({
      id: "prep_time",
      question: "How much prep time would you like for this one?",
      placeholder: "e.g. 2 days, 1 week",
    });
  }

  // Stable render order: prep_time → availability → everything else.
  // The UI's "Use my calendar" suggestion on the availability question depends
  // on prep_time being answered first, so prep_time must visually come first.
  const ORDER: Record<string, number> = { prep_time: 0, availability: 1 };
  questions.sort((a, b) => (ORDER[a.id] ?? 99) - (ORDER[b.id] ?? 99));

  // Coerce optional follow-up. We're strict about bounds (1-14 days, non-empty
  // summary) so a hallucinated `{afterDays: 9999}` doesn't slip through and
  // create a calendar event in the year 2050.
  let followUp: SuggestedFollowUp | undefined;
  if (r.followUp && typeof r.followUp === "object") {
    const f = r.followUp as Record<string, unknown>;
    const days = typeof f.afterDays === "number" ? Math.round(f.afterDays) : NaN;
    const summary = typeof f.summary === "string" ? f.summary.trim() : "";
    if (Number.isFinite(days) && days >= 1 && days <= 14 && summary) {
      followUp = { afterDays: days, summary: summary.slice(0, 120) };
    }
  }

  return {
    intent: safeIntent,
    needsClarification: questions.length > 0,
    questions,
    assistantNote:
      typeof r.assistantNote === "string" ? r.assistantNote.trim() : "",
    ...(followUp ? { followUp } : {}),
  };
}

export async function analyzeEmailForDraft(email: IncomingEmail): Promise<EmailAnalysis> {
  try {
    const result = await generate({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(email) },
      ],
      maxTokens: 400,
      temperature: 0.2,
    });
    const json = extractFirstJsonObject(result.text);
    if (!json) return EMPTY_ANALYSIS;
    return coerceAnalysis(JSON.parse(json));
  } catch (e) {
    if (e instanceof InferenceError) {
      console.warn("analyzeEmailForDraft: inference failed, skipping:", scrubErrorMessage(e.message));
    } else {
      console.warn("analyzeEmailForDraft: parse/other failure, skipping:", scrubErrorMessage(e));
    }
    return EMPTY_ANALYSIS;
  }
}

/**
 * Convert a free-text answer to a "prep time" question into hours of
 * calendar buffer. Used so proposeFreeSlots can skip enough time for the
 * user to actually prepare. Conservative on parse failure (returns the
 * default 2-hour buffer that proposeFreeSlots already uses).
 */
export function parsePrepTimeToHours(answer: string): number {
  const s = answer.toLowerCase().trim();
  if (!s) return 2;

  // "next week", "a week", "1 week"
  if (/\b(?:a\s+)?(week|wk)s?\b/.test(s)) {
    const m = s.match(/(\d+)\s*(?:week|wk)/);
    return (m ? Number(m[1]) : 1) * 7 * 24;
  }
  // "2 days", "a couple days", "few days"
  if (/\bdays?\b/.test(s)) {
    if (/\bcouple\b/.test(s)) return 2 * 24;
    if (/\bfew\b/.test(s)) return 3 * 24;
    const m = s.match(/(\d+)\s*days?/);
    return (m ? Number(m[1]) : 1) * 24;
  }
  // "tomorrow"
  if (/\btomorrow\b/.test(s)) return 24;
  // "48 hours", "12h"
  const hr = s.match(/(\d+)\s*(?:hours?|hrs?|h\b)/);
  if (hr) return Number(hr[1]);
  // "next month" — rare, but treat as 2 weeks
  if (/\bmonth\b/.test(s)) return 14 * 24;
  // bare number → assume hours
  const bare = s.match(/^(\d+)$/);
  if (bare) return Number(bare[1]);
  return 2;
}

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

export type EmailAnalysis = {
  intent: EmailIntent;
  /** True if drafting benefits from user input first. */
  needsClarification: boolean;
  /** 0-2 questions to ask before drafting. Empty if none needed. */
  questions: AssistantQuestion[];
  /** 1-3 sentence read of the email + what the assistant would suggest. */
  assistantNote: string;
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
  "assistantNote": "string"
}

Rules:
- If intent is "interview", ALWAYS include a question with id "prep_time" like "How much prep time would you like for this one?" with a placeholder such as "2 days" or "1 week". Different roles need different prep — never assume a fixed buffer.
- If you'd need user context to draft well (e.g. "do you already know this person?"), include 1 more question with a descriptive id (e.g. "company_familiarity", "decision_lean").
- For straightforward emails (casual chat, simple acknowledgment), use needsClarification: false and questions: [].
- Maximum 2 questions. Each question must be answerable in a short free-text reply.
- assistantNote is 1-3 sentences in plain text — your honest read: what the email is, what's at stake, what you'd suggest. Address the user directly ("This looks like…", "I'd suggest…"). Do not write the draft itself here.
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
      const id = typeof qq.id === "string" ? qq.id : "";
      const question = typeof qq.question === "string" ? qq.question : "";
      const placeholder = typeof qq.placeholder === "string" ? qq.placeholder : "";
      if (!id || !question) return null;
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

  return {
    intent: safeIntent,
    needsClarification: questions.length > 0,
    questions,
    assistantNote:
      typeof r.assistantNote === "string" ? r.assistantNote.trim() : "",
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
      console.warn("analyzeEmailForDraft: inference failed, skipping:", e.message);
    } else {
      console.warn("analyzeEmailForDraft: parse/other failure, skipping:", e);
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

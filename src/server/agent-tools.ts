/**
 * Agent Tools registry.
 *
 * The "smart actions" attached to drafts (block prep time, set follow-up
 * reminder, suggest availability) are also useful to other surfaces — a chat
 * assistant, a deep-research agent, or a future "/run" command palette — so we
 * model them as a small set of named tools that any feature can invoke.
 *
 * Each tool is a `{id, name, description, validateInput, execute}` record.
 * `execute` is a pure async function that takes a `userId` and a typed input;
 * auth + dispatch lives in the `runAgentTool` server fn (or in the existing
 * thin server-fn wrappers we keep for back-compat with the inbox UI).
 *
 * Adding a new tool:
 *   1. Define `<Name>Input` / `<Name>Output` types.
 *   2. Write `executeXxx(userId, input): Promise<Output>` (no middleware).
 *   3. Export an `xxxTool: AgentTool<...>` and add it to AGENT_TOOLS.
 *   4. (Optional) keep a thin `createServerFn` wrapper if a UI surface calls
 *      it directly — but new code should prefer `runAgentTool({toolId, input})`.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getValidGoogleAccessToken } from "@/server/gmail-auth.server";
import {
  proposeFreeSlots,
  createCalendarEvent,
  computePrepBlockSlot,
  computeFollowUpSlot,
  getUserCalendarTimezone,
  CalendarScopeError,
  type ProposedSlot,
} from "@/server/calendar.server";
import { parsePrepTimeToHours } from "@/server/email-intent.server";
import { generate, InferenceError } from "@/server/inference";

// ---------------------------------------------------------------------------
// Generic tool contract
// ---------------------------------------------------------------------------

export type AgentTool<I, O> = {
  /** Stable kebab-case id. Surfaced to LLM tool-use prompts and dispatchers. */
  id: string;
  /** Short human label for UI surfaces. */
  name: string;
  /** 1-2 sentences describing what the tool does and when to use it. */
  description: string;
  /** Plain-English description of the input shape (good enough for LLM prompts). */
  inputShape: string;
  /** Validate + coerce raw JSON into the typed input. Throws on invalid input. */
  validateInput: (raw: unknown) => I;
  /** Pure executor — auth happens in the dispatcher, not here. */
  execute: (userId: string, input: I) => Promise<O>;
};

// ---------------------------------------------------------------------------
// Tool: block_prep_time
// ---------------------------------------------------------------------------

export type BlockPrepTimeInput = {
  /** Draft this prep block is anchored to (used to look up the email subject). */
  draftId: string;
  /** ISO 8601 of the earliest proposed meeting slot — block goes before this. */
  beforeIso: string;
  /** Raw user answer to the prep_time question, e.g. "2 days". */
  prepTimeText: string;
};

export type BlockPrepTimeOutput =
  | { ok: true; eventId: string; htmlLink: string; startIso: string; endIso: string; human: string }
  | { ok: false; reason: "scope" | "no_calendar" | "create_failed"; message: string };

export async function executeBlockPrepTime(
  userId: string,
  input: BlockPrepTimeInput,
): Promise<BlockPrepTimeOutput> {
  // Verify the draft belongs to this user and resolve the email subject.
  const { data: draftRow, error: draftErr } = await supabaseAdmin
    .from("drafts")
    .select("id, source_node_id")
    .eq("user_id", userId)
    .eq("id", input.draftId)
    .maybeSingle();
  if (draftErr) throw draftErr;
  if (!draftRow?.source_node_id) {
    return { ok: false, reason: "create_failed", message: "Draft not found." };
  }

  // Look up the email subject directly from memory_nodes.label. Faster and
  // narrower than full loadIncomingEmail() — we don't need the body for the
  // event title.
  let subject = "interview";
  try {
    const { data: node } = await supabaseAdmin
      .from("memory_nodes")
      .select("label")
      .eq("user_id", userId)
      .eq("id", draftRow.source_node_id)
      .maybeSingle();
    const label = typeof node?.label === "string" ? node.label : "";
    // Strip common reply/forward prefixes. The previous regex required a
    // double-colon for "Re:" because both the group and the trailing literal
    // contained `:` — fixed by moving the colon outside the alternation.
    const cleaned = label.replace(/^(re|fwd?|fw):\s*/i, "").trim();
    if (cleaned) subject = cleaned;
  } catch {
    /* keep default subject */
  }

  const timezone = await getUserCalendarTimezone(userId);
  const prepHours = parsePrepTimeToHours(input.prepTimeText || "");
  const slot = computePrepBlockSlot(input.beforeIso, timezone, prepHours);

  try {
    const created = await createCalendarEvent(userId, {
      summary: `Prep: ${subject}`,
      description:
        "Auto-blocked by NeuralConnexions before your interview slot. " +
        "Adjust or delete if your plans change.",
      startIso: slot.startIso,
      endIso: slot.endIso,
      timezone,
    });
    return {
      ok: true,
      eventId: created.eventId,
      htmlLink: created.htmlLink,
      startIso: created.startIso,
      endIso: created.endIso,
      human: created.human,
    };
  } catch (e) {
    return mapCalendarError(e, "createPrepBlock");
  }
}

export const blockPrepTimeTool: AgentTool<BlockPrepTimeInput, BlockPrepTimeOutput> = {
  id: "block_prep_time",
  name: "Block prep time",
  description:
    "Place a 2-hour prep hold on the user's primary calendar before a given meeting time. Sized by the user's prep_time preference.",
  inputShape: '{ "draftId": "string", "beforeIso": "ISO8601", "prepTimeText": "e.g. 2 days" }',
  validateInput: (raw) => {
    if (!raw || typeof raw !== "object") throw new Error("block_prep_time: input must be an object");
    const r = raw as Record<string, unknown>;
    if (typeof r.draftId !== "string" || !r.draftId) throw new Error("block_prep_time: draftId required");
    if (typeof r.beforeIso !== "string" || !r.beforeIso) throw new Error("block_prep_time: beforeIso required");
    // Strict ISO-8601 parse — reject garbage like "tomorrow" or "" before we
    // hand it to computePrepBlockSlot, which would otherwise produce NaN dates.
    const t = Date.parse(r.beforeIso);
    if (!Number.isFinite(t)) throw new Error("block_prep_time: beforeIso must be a valid ISO-8601 timestamp");
    return {
      draftId: r.draftId,
      beforeIso: r.beforeIso,
      prepTimeText: typeof r.prepTimeText === "string" ? r.prepTimeText : "",
    };
  },
  execute: executeBlockPrepTime,
};

// ---------------------------------------------------------------------------
// Tool: set_followup_reminder
// ---------------------------------------------------------------------------

export type SetFollowUpReminderInput = {
  /** 1-60 days from now (clamped server-side via computeFollowUpSlot). */
  afterDays: number;
  /** Short human label, used as the calendar event title. ≤120 chars. */
  summary: string;
};

export type SetFollowUpReminderOutput = BlockPrepTimeOutput;

export async function executeSetFollowUpReminder(
  userId: string,
  input: SetFollowUpReminderInput,
): Promise<SetFollowUpReminderOutput> {
  const summary = (input.summary ?? "").trim().slice(0, 120);
  if (!summary) {
    return { ok: false, reason: "create_failed", message: "Reminder summary is required." };
  }
  const timezone = await getUserCalendarTimezone(userId);
  const slot = computeFollowUpSlot(input.afterDays, timezone);
  try {
    const created = await createCalendarEvent(userId, {
      summary: `Follow up: ${summary}`,
      description:
        "Auto-set by NeuralConnexions as a nudge to revisit this thread. " +
        "Adjust or delete if it's no longer needed.",
      startIso: slot.startIso,
      endIso: slot.endIso,
      timezone,
    });
    return {
      ok: true,
      eventId: created.eventId,
      htmlLink: created.htmlLink,
      startIso: created.startIso,
      endIso: created.endIso,
      human: created.human,
    };
  } catch (e) {
    return mapCalendarError(e, "createFollowUpReminder");
  }
}

export const setFollowUpReminderTool: AgentTool<SetFollowUpReminderInput, SetFollowUpReminderOutput> = {
  id: "set_followup_reminder",
  name: "Set follow-up reminder",
  description:
    "Create a 30-minute calendar hold N days from now (1-14 typical) at 09:00 in the user's timezone. Use to nudge the user back to a thread that needs follow-through.",
  inputShape: '{ "afterDays": 1-14, "summary": "short imperative, e.g. Chase Maya re: vendor" }',
  validateInput: (raw) => {
    if (!raw || typeof raw !== "object") throw new Error("set_followup_reminder: input must be an object");
    const r = raw as Record<string, unknown>;
    const days = typeof r.afterDays === "number" ? Math.round(r.afterDays) : NaN;
    // Bound 1-60 at the dispatcher boundary; computeFollowUpSlot also clamps,
    // but rejecting early gives callers a clearer error than silent clamping.
    if (!Number.isFinite(days) || days < 1 || days > 60) {
      throw new Error("set_followup_reminder: afterDays must be an integer between 1 and 60");
    }
    const summary = typeof r.summary === "string" ? r.summary.trim() : "";
    if (!summary) throw new Error("set_followup_reminder: summary required");
    return { afterDays: days, summary };
  },
  execute: executeSetFollowUpReminder,
};

// ---------------------------------------------------------------------------
// Tool: suggest_availability
// ---------------------------------------------------------------------------

export type SuggestAvailabilityInput = {
  /** Optional prep-time text to bias the start of the search window. */
  prepTimeText?: string;
};

export type SuggestAvailabilityOutput =
  | { status: "ok"; slots: ProposedSlot[]; answer: string }
  | { status: "empty" }
  | { status: "no_calendar" }
  | { status: "error"; message: string };

export async function executeSuggestAvailability(
  userId: string,
  input: SuggestAvailabilityInput,
): Promise<SuggestAvailabilityOutput> {
  // Probe for a usable calendar token first so we can distinguish
  // "not connected" from "no free slots in the next week" — both are
  // valid outcomes but require very different UX nudges.
  try {
    await getValidGoogleAccessToken(userId, "google_calendar");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not\s+connected|reconnect/i.test(msg)) return { status: "no_calendar" };
    return { status: "error", message: msg.slice(0, 200) };
  }

  const bufferHours = input.prepTimeText ? parsePrepTimeToHours(input.prepTimeText) : 2;
  let slots: ProposedSlot[] = [];
  try {
    slots = await proposeFreeSlots(userId, { bufferHours, throwOnError: true });
  } catch (e) {
    console.warn("suggest_availability: proposeFreeSlots failed:", e);
    return { status: "error", message: e instanceof Error ? e.message.slice(0, 200) : "calendar lookup failed" };
  }
  if (slots.length === 0) return { status: "empty" };
  return { status: "ok", slots, answer: slots.map((s) => s.human).join("; ") };
}

export const suggestAvailabilityTool: AgentTool<SuggestAvailabilityInput, SuggestAvailabilityOutput> = {
  id: "suggest_availability",
  name: "Suggest availability",
  description:
    "Look at the user's primary calendar for the next ~week and return concrete free 30-min slots that respect their prep-time buffer. Used to fill in 'when works for you?' replies.",
  inputShape: '{ "prepTimeText"?: "e.g. 2 days, 1 week" }',
  validateInput: (raw) => {
    if (raw == null) return {};
    if (typeof raw !== "object") throw new Error("suggest_availability: input must be an object");
    const r = raw as Record<string, unknown>;
    return { prepTimeText: typeof r.prepTimeText === "string" ? r.prepTimeText : undefined };
  },
  execute: executeSuggestAvailability,
};

// ---------------------------------------------------------------------------
// Tool: research_thread_context
// ---------------------------------------------------------------------------

/**
 * Cross-thread context research. Given a draft (or a sender directly), pulls
 * prior interactions with the same person from local memory and asks the LLM
 * to synthesize a short strategic brief — relationship history, recurring
 * topics, likely subtext. Designed to be the foundation for a richer
 * deep-research tool later (which would also pull web sources / docs).
 *
 * Local-first: uses only data already in `memory_nodes`; no external calls
 * beyond the LLM provider. Bounded LLM cost (≤200 tokens out, ≤10 prior
 * messages in).
 *
 * Reusable: a future chat agent can call with `{sender}` directly to answer
 * "what do I know about Maya?" without going through a draft.
 */
export type ResearchThreadContextInput = {
  /** Draft to derive the sender from. Mutually exclusive with `sender`. */
  draftId?: string;
  /** Explicit sender (raw "Name <email>" or bare email). Skips the draft lookup. */
  sender?: string;
  /** Max prior messages to feed the LLM. 1-25, default 10. */
  limit?: number;
};

export type ResearchThreadContextOutput =
  | {
      status: "ok";
      sender: string;
      brief: string;
      sourceCount: number;
      /** ISO 8601 of synthesis time, so the UI can show "Generated 2m ago". */
      generatedAt: string;
    }
  | { status: "no_history"; sender: string }
  | { status: "error"; message: string };

/** Pull bare email from "Name <email@host>" or "email@host". Empty string on garbage. */
function extractBareEmail(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  const addr = (m ? m[1] : raw).trim().toLowerCase();
  // Guard: must look like an email — protects the ILIKE pattern from
  // matching every row when the input is empty or malformed.
  return /.+@.+\..+/.test(addr) ? addr : "";
}

export async function executeResearchThreadContext(
  userId: string,
  input: ResearchThreadContextInput,
): Promise<ResearchThreadContextOutput> {
  const limit = Math.min(25, Math.max(1, input.limit ?? 10));

  // 1) Resolve sender + (optionally) the source-thread id to exclude from history.
  let senderRaw = input.sender ?? "";
  let excludeNodeId: string | null = null;
  if (!senderRaw && input.draftId) {
    const { data: draftRow, error: dErr } = await supabaseAdmin
      .from("drafts")
      .select("source_node_id")
      .eq("user_id", userId)
      .eq("id", input.draftId)
      .maybeSingle();
    if (dErr) return { status: "error", message: dErr.message };
    if (!draftRow?.source_node_id) {
      return { status: "error", message: "Draft has no source thread to research." };
    }
    excludeNodeId = draftRow.source_node_id;
    const { data: node, error: nErr } = await supabaseAdmin
      .from("memory_nodes")
      .select("data")
      .eq("user_id", userId)
      .eq("id", excludeNodeId)
      .maybeSingle();
    if (nErr) return { status: "error", message: nErr.message };
    const meta = (node?.data ?? {}) as { from?: string };
    senderRaw = meta.from ?? "";
  }

  const senderEmail = extractBareEmail(senderRaw);
  if (!senderEmail) {
    return { status: "error", message: "Could not resolve a valid sender email." };
  }

  // 2) Pull prior threads from this sender. Match against the bare email so
  //    "Maya <maya@x>" and "maya@x" both resolve. Newest first; bounded.
  //    Escape ILIKE wildcards (`%` `_` `\`) so a crafted sender can't broaden
  //    the match and pull in unrelated threads from the same account.
  const escapedEmail = senderEmail.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  let query = supabaseAdmin
    .from("memory_nodes")
    .select("id, label, created_at, data")
    .eq("user_id", userId)
    .eq("node_type", "thread")
    .ilike("data->>from", `%${escapedEmail}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (excludeNodeId) query = query.neq("id", excludeNodeId);

  const { data: rows, error: qErr } = await query;
  if (qErr) return { status: "error", message: qErr.message };
  if (!rows || rows.length === 0) {
    return { status: "no_history", sender: senderEmail };
  }

  // 3) Build a compact bulleted history for the LLM. Truncate snippets so a
  //    handful of newsletter blasts can't blow the context window.
  const lines = rows.map((r) => {
    const meta = (r.data ?? {}) as { snippet?: string; date?: string; category?: string; domain?: string };
    const date = (meta.date || r.created_at || "").slice(0, 10);
    const subj = (typeof r.label === "string" ? r.label : "(no subject)").slice(0, 120);
    const snippet = (meta.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    const tag = [meta.category, meta.domain].filter(Boolean).join("/");
    return `- [${date}] ${subj}${tag ? ` (${tag})` : ""}${snippet ? ` — ${snippet}` : ""}`;
  });

  const system =
    "You are a concise relationship analyst. Given a list of past email threads from one sender, produce a 2-3 sentence context brief that helps the user reply intelligently. Cover: who this person seems to be in the user's life, recurring topics, and any pattern worth flagging (cadence, tone shift, open loops). No bullet lists. No greetings. No advice — just the brief. Max 90 words.";
  const user = `Sender: ${senderEmail}\n\nPast threads (newest first):\n${lines.join("\n")}\n\nBrief:`;

  try {
    const result = await generate({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxTokens: 200,
      temperature: 0.3,
    });
    const brief = result.text.trim().slice(0, 800);
    if (!brief) return { status: "error", message: "Empty brief from inference." };
    return {
      status: "ok",
      sender: senderEmail,
      brief,
      sourceCount: rows.length,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    const msg = e instanceof InferenceError ? e.message : e instanceof Error ? e.message : String(e);
    return { status: "error", message: msg.slice(0, 200) };
  }
}

export const researchThreadContextTool: AgentTool<ResearchThreadContextInput, ResearchThreadContextOutput> = {
  id: "research_thread_context",
  name: "Research thread context",
  description:
    "Synthesize a 2-3 sentence strategic brief about the sender of a thread, drawing on prior interactions in local memory. Use before replying to a non-trivial email or when the user asks 'what do I know about X?'.",
  inputShape: '{ "draftId"?: "string", "sender"?: "Name <email>", "limit"?: "1-25, default 10" }',
  validateInput: (raw) => {
    if (!raw || typeof raw !== "object") throw new Error("research_thread_context: input must be an object");
    const r = raw as Record<string, unknown>;
    const draftId = typeof r.draftId === "string" && r.draftId ? r.draftId : undefined;
    const sender = typeof r.sender === "string" && r.sender ? r.sender : undefined;
    if (!draftId && !sender) {
      throw new Error("research_thread_context: provide draftId or sender");
    }
    // Mutually-exclusive contract — without this, sender silently wins and
    // bypasses the draft-derived sender resolution, which is surprising for
    // LLM callers that pass both "to be safe".
    if (draftId && sender) {
      throw new Error("research_thread_context: pass either draftId or sender, not both");
    }
    let limit: number | undefined;
    if (r.limit !== undefined) {
      const n = typeof r.limit === "number" ? Math.round(r.limit) : NaN;
      if (!Number.isFinite(n) || n < 1 || n > 25) {
        throw new Error("research_thread_context: limit must be an integer between 1 and 25");
      }
      limit = n;
    }
    return { draftId, sender, limit };
  },
  execute: executeResearchThreadContext,
};

// ---------------------------------------------------------------------------
// Registry + helpers
// ---------------------------------------------------------------------------

/**
 * Map a thrown calendar error into a typed `{ok: false, reason, message}` shape
 * shared by all calendar-event tools. Keeps the scope/no_calendar/create_failed
 * branching consistent across executors.
 */
function mapCalendarError(
  e: unknown,
  source: string,
): { ok: false; reason: "scope" | "no_calendar" | "create_failed"; message: string } {
  if (e instanceof CalendarScopeError) {
    return { ok: false, reason: "scope", message: e.message };
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/not\s+connected|reconnect/i.test(msg)) {
    return { ok: false, reason: "no_calendar", message: "Connect Google Calendar first." };
  }
  console.warn(`${source} failed:`, e);
  return { ok: false, reason: "create_failed", message: msg.slice(0, 200) };
}

/** All registered tools, keyed by id. Add new tools here. */
export const AGENT_TOOLS: Record<string, AgentTool<any, any>> = {
  [blockPrepTimeTool.id]: blockPrepTimeTool,
  [setFollowUpReminderTool.id]: setFollowUpReminderTool,
  [suggestAvailabilityTool.id]: suggestAvailabilityTool,
  [researchThreadContextTool.id]: researchThreadContextTool,
};

export type AgentToolId = keyof typeof AGENT_TOOLS;

/**
 * Lightweight tool catalog for LLM tool-use prompting. Trim to whatever subset
 * a particular feature needs (e.g. the inbox brain doesn't need research tools).
 */
export function getToolCatalog(ids?: string[]): {
  id: string;
  name: string;
  description: string;
  inputShape: string;
}[] {
  const all = Object.values(AGENT_TOOLS);
  const subset = ids ? all.filter((t) => ids.includes(t.id)) : all;
  return subset.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    inputShape: t.inputShape,
  }));
}

/**
 * Dispatch a tool by id with raw input. Validates input via the tool's own
 * `validateInput`, then runs `execute(userId, input)`. Throws on unknown tool
 * or invalid input. Used by `runAgentTool` server fn and any internal caller
 * that wants generic "execute the named tool the LLM picked" behavior.
 */
export async function dispatchAgentTool(
  userId: string,
  toolId: string,
  rawInput: unknown,
): Promise<unknown> {
  const tool = AGENT_TOOLS[toolId];
  if (!tool) throw new Error(`Unknown agent tool: ${toolId}`);
  const input = tool.validateInput(rawInput);
  return tool.execute(userId, input);
}

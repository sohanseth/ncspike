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

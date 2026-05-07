/**
 * Overnight research queue. Sits on top of the AGENT_TOOLS registry and turns
 * any tool into a deferred, batched, dedupe'd, cost-bounded background job.
 *
 * Lifecycle of a task:
 *   1. enqueueResearchTask  → inserts a row with status='pending'
 *   2. runResearchBatch     → claims pending rows (pending → running),
 *                             dispatches via AGENT_TOOLS, writes result
 *                             (running → done | error)
 *   3. listResearchTasks    → UI surfaces completed/unread items (briefing)
 *   4. markResearchTasksRead → user dismisses → read_at set
 *
 * Cancellation is allowed only while pending — once a task starts running
 * we let it finish so we don't orphan a half-applied side effect.
 *
 * NOTE on auto-identification: this module is the "run them overnight" half.
 * The "identify research tasks throughout the day" half is the responsibility
 * of feature code — e.g. when the inbox processes a draft and notices the
 * sender has 3+ prior threads, it can call enqueueResearchTask({tool_id:
 * 'research_thread_context', ..., source:'auto', scheduledFor:tonight03}).
 * Doing it from those features (rather than here) keeps the queue agnostic.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { dispatchAgentTool, AGENT_TOOLS } from "@/server/agent-tools";

const researchTasks = () => (supabaseAdmin as any).from("research_tasks");

export type EnqueueArgs = {
  toolId: string;
  input: Record<string, unknown>;
  /** Who/what is asking. 'auto' = inbox/heuristic, 'manual' = user button, 'system' = internal. */
  source?: "auto" | "manual" | "system";
  /** Free-text "why this is queued" — surfaced in the briefing list. */
  sourceContext?: string;
  /** Lower runs first. Default 100. Use 50 for user-initiated, 200 for opportunistic auto. */
  priority?: number;
  /** ISO timestamp; defaults to now() (eligible immediately). Set to overnight for deferred. */
  scheduledFor?: string;
};

export type EnqueueResult =
  | { status: "enqueued"; taskId: string }
  | { status: "duplicate"; existingTaskId: string }
  | { status: "error"; message: string };

/**
 * Stable key for dedupe. Recursively sorts object keys so `{a:1,b:2}` and
 * `{b:2,a:1}` collapse to the same string. Truncated to keep the unique
 * index narrow; collisions on truncation only happen for genuinely huge
 * inputs we wouldn't want to enqueue twice anyway.
 */
function canonicalKey(toolId: string, input: unknown): string {
  function norm(v: unknown): unknown {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(norm);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = norm((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return `${toolId}:${JSON.stringify(norm(input))}`.slice(0, 500);
}

export async function enqueueResearchTask(
  userId: string,
  args: EnqueueArgs,
): Promise<EnqueueResult> {
  const tool = AGENT_TOOLS[args.toolId];
  if (!tool) return { status: "error", message: `Unknown tool: ${args.toolId}` };
  // Gate on overnightSafe so we can't accidentally queue a side-effect-bearing
  // tool whose double-execution under the timeout-without-cancellation race
  // would mutate external systems twice. See AgentTool.overnightSafe docs.
  if (!tool.overnightSafe) {
    return { status: "error", message: `Tool '${args.toolId}' is not safe for the overnight queue.` };
  }

  // Validate input now so we never enqueue work guaranteed to fail at runtime.
  // The same validator runs again inside dispatchAgentTool; we pay the small
  // double-validation cost to keep bad rows out of the queue.
  try {
    tool.validateInput(args.input);
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }

  const inputKey = canonicalKey(args.toolId, args.input);

  const { data: existing } = await researchTasks()
    .select("id")
    .eq("user_id", userId)
    .eq("tool_id", args.toolId)
    .eq("input_key", inputKey)
    .in("status", ["pending", "running"])
    .maybeSingle();
  if (existing?.id) return { status: "duplicate", existingTaskId: existing.id };

  const { data, error } = await researchTasks()
    .insert({
      user_id: userId,
      tool_id: args.toolId,
      input: args.input as Json,
      input_key: inputKey,
      source: args.source ?? "manual",
      source_context: args.sourceContext ?? null,
      priority: args.priority ?? 100,
      scheduled_for: args.scheduledFor ?? new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    // Race: another caller inserted the same key between our SELECT and INSERT.
    // The unique partial index catches it; surface as duplicate, not error.
    if (error.code === "23505") {
      const { data: dup } = await researchTasks()
        .select("id")
        .eq("user_id", userId)
        .eq("tool_id", args.toolId)
        .eq("input_key", inputKey)
        .in("status", ["pending", "running"])
        .maybeSingle();
      if (dup?.id) return { status: "duplicate", existingTaskId: dup.id };
    }
    return { status: "error", message: error.message };
  }
  return { status: "enqueued", taskId: data.id };
}

export type TaskRow = {
  id: string;
  toolId: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  source: "auto" | "manual" | "system";
  sourceContext: string | null;
  scheduledFor: string;
  createdAt: string;
  completedAt: string | null;
  // Json (not unknown) so server-fn return-type serialization is happy.
  result: Json | null;
  error: string | null;
  readAt: string | null;
};

export async function listResearchTasks(
  userId: string,
  opts: { status?: TaskRow["status"][]; limit?: number; unreadOnly?: boolean } = {},
): Promise<TaskRow[]> {
  let q = researchTasks()
    .select("id, tool_id, status, source, source_context, scheduled_for, created_at, completed_at, result, error, read_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.min(100, Math.max(1, opts.limit ?? 50)));
  if (opts.status?.length) q = q.in("status", opts.status);
  if (opts.unreadOnly) q = q.is("read_at", null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({
    id: r.id,
    toolId: r.tool_id,
    status: r.status as TaskRow["status"],
    source: r.source as TaskRow["source"],
    sourceContext: r.source_context,
    scheduledFor: r.scheduled_for,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    result: r.result,
    error: r.error,
    readAt: r.read_at,
  }));
}

export async function markResearchTasksRead(
  userId: string,
  taskIds: string[],
): Promise<{ updated: number }> {
  if (taskIds.length === 0) return { updated: 0 };
  const { data, error } = await researchTasks()
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .in("id", taskIds)
    .is("read_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return { updated: data?.length ?? 0 };
}

export async function cancelResearchTask(
  userId: string,
  taskId: string,
): Promise<{ ok: boolean; message?: string }> {
  // Only `pending` is cancellable — once `running` we let the executor finish
  // so we never orphan a partially-applied side effect (e.g. a calendar event
  // already created by a tool mid-call).
  const { data, error } = await researchTasks()
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("id", taskId)
    .eq("status", "pending")
    .select("id");
  if (error) return { ok: false, message: error.message };
  if (!data || data.length === 0) return { ok: false, message: "Task not pending or not found." };
  return { ok: true };
}

export type RunBatchSummary = {
  attempted: number;
  succeeded: number;
  failed: number;
  results: { taskId: string; toolId: string; status: "done" | "error"; message?: string }[];
};

/** Hard ceiling on tasks per batch — bounds spend even if cron fires twice. */
const MAX_BATCH = 20;
/** Per-task wall clock cap — protects the runner from a hung LLM call. */
const PER_TASK_TIMEOUT_MS = 30_000;
/**
 * Lease ceiling for `running` rows. If a runner crashes between claim and
 * final update, the row would be stuck `running` forever and — because the
 * dedupe partial-unique index covers `running` — would permanently block
 * equivalent re-enqueues. We comfortably exceed PER_TASK_TIMEOUT_MS so an
 * actively-executing task is never reaped out from under the runner.
 */
const STUCK_RUNNING_AFTER_MS = 5 * 60_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        to = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (to) clearTimeout(to);
  }
}

/**
 * Run pending tasks for one user. Designed to be called by:
 *   - a Cloudflare Worker cron at ~03:00 (TODO: wire in workers/cron.ts)
 *   - the user's "Run pending now" button (manual fallback / testing)
 *   - the morning catchup on app open (opportunistic — best-effort)
 *
 * Tasks run serially. Each is wrapped in its own try/catch so one failure
 * doesn't poison the batch. We use an optimistic pending→running update as
 * a poor-man's lock so two concurrent runners (cron + manual) can't double-
 * execute the same row.
 */
export async function runResearchBatch(
  userId: string,
  opts: { limit?: number } = {},
): Promise<RunBatchSummary> {
  const limit = Math.min(MAX_BATCH, Math.max(1, opts.limit ?? 10));

  // Reaper pass: requeue stuck `running` rows whose lease expired. This frees
  // dedupe slots and gives the work another shot after a runner crash. Done
  // before the claim query so the reaped rows are eligible in this same batch.
  const reaperCutoff = new Date(Date.now() - STUCK_RUNNING_AFTER_MS).toISOString();
  await researchTasks()
    .update({ status: "pending", started_at: null })
    .eq("user_id", userId)
    .eq("status", "running")
    .lt("started_at", reaperCutoff);

  const { data: tasks, error } = await researchTasks()
    .select("id, tool_id, input")
    .eq("user_id", userId)
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const summary: RunBatchSummary = { attempted: 0, succeeded: 0, failed: 0, results: [] };
  for (const t of tasks ?? []) {
    // Optimistic claim. If another runner beat us to this row, skip it.
    const { data: claimed, error: claimErr } = await researchTasks()
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", t.id)
      .eq("user_id", userId)
      .eq("status", "pending")
      .select("id");
    if (claimErr || !claimed || claimed.length === 0) continue;

    summary.attempted++;
    try {
      const result = await withTimeout(
        dispatchAgentTool(userId, t.tool_id as string, t.input),
        PER_TASK_TIMEOUT_MS,
        `tool ${t.tool_id}`,
      );
      await researchTasks()
        .update({
          status: "done",
          completed_at: new Date().toISOString(),
          result: result as Json,
          error: null,
        })
        .eq("id", t.id);
      summary.succeeded++;
      summary.results.push({ taskId: t.id, toolId: t.tool_id as string, status: "done" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await researchTasks()
        .update({
          status: "error",
          completed_at: new Date().toISOString(),
          error: msg.slice(0, 500),
        })
        .eq("id", t.id);
      summary.failed++;
      summary.results.push({ taskId: t.id, toolId: t.tool_id as string, status: "error", message: msg.slice(0, 200) });
    }
  }
  return summary;
}

export async function getResearchQueueCounts(
  userId: string,
): Promise<{ pending: number; unreadDone: number }> {
  const [pendingRes, unreadRes] = await Promise.all([
    researchTasks()
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "pending"),
    researchTasks()
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "done")
      .is("read_at", null),
  ]);
  return { pending: pendingRes.count ?? 0, unreadDone: unreadRes.count ?? 0 };
}

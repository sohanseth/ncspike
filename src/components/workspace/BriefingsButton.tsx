/**
 * Topbar entry point for the overnight research queue. Surfaces:
 *   - a count badge for "completed but unread" briefings (the morning payoff)
 *   - a popover listing recent tasks across all states
 *   - manual "Run pending now" trigger so users can shortcut the cron during
 *     testing or when they want a brief immediately
 *
 * Self-contained so it doesn't bloat MainApp.tsx further. Polls counts every
 * 60s while mounted; refreshes the full list whenever the popover opens.
 */
import { useEffect, useRef, useState } from "react";
import { Library, Loader2, Play, Check, X, AlertCircle, Clock, Inbox } from "lucide-react";
import {
  getResearchQueueCountsFn,
  listResearchTasksFn,
  runResearchBatchFn,
  markResearchTasksReadFn,
  cancelResearchTaskFn,
} from "@/lib/voice-drafts.functions";

type Task = Awaited<ReturnType<typeof listResearchTasksFn>>[number];

export function BriefingsButton() {
  const [counts, setCounts] = useState<{ pending: number; unreadDone: number }>({ pending: 0, unreadDone: 0 });
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  async function refreshCounts() {
    try {
      const c = (await getResearchQueueCountsFn()) as { pending: number; unreadDone: number };
      setCounts(c);
    } catch {
      // Soft fail — the badge just stays stale. Don't toast users for a
      // background poll error.
    }
  }

  async function refreshTasks() {
    setLoading(true);
    try {
      const list = (await listResearchTasksFn({ data: { limit: 30 } })) as Task[];
      setTasks(list);
    } catch (e) {
      console.warn("listResearchTasks failed:", e);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshCounts();
    const t = setInterval(refreshCounts, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (open) refreshTasks();
  }, [open]);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function runNow() {
    if (running) return;
    setRunning(true);
    try {
      await runResearchBatchFn({ data: { limit: 10 } });
      await Promise.all([refreshCounts(), refreshTasks()]);
    } catch (e) {
      console.warn("runResearchBatch failed:", e);
    } finally {
      setRunning(false);
    }
  }

  async function dismissOne(taskId: string) {
    // Optimistic UI — the task is gone from the unread list immediately; the
    // server-side update is fire-and-forget for snappiness.
    setTasks((cur) => cur?.map((t) => (t.id === taskId ? { ...t, readAt: new Date().toISOString() } : t)) ?? null);
    setCounts((c) => ({ ...c, unreadDone: Math.max(0, c.unreadDone - 1) }));
    try {
      await markResearchTasksReadFn({ data: { taskIds: [taskId] } });
    } catch {
      // If it fails the next refresh will reconcile.
    }
  }

  async function cancelOne(taskId: string) {
    try {
      await cancelResearchTaskFn({ data: { taskId } });
      await Promise.all([refreshCounts(), refreshTasks()]);
    } catch (e) {
      console.warn("cancelResearchTask failed:", e);
    }
  }

  async function dismissAll() {
    const unread = (tasks ?? []).filter((t) => t.status === "done" && !t.readAt).map((t) => t.id);
    if (unread.length === 0) return;
    setTasks((cur) => cur?.map((t) => (unread.includes(t.id) ? { ...t, readAt: new Date().toISOString() } : t)) ?? null);
    setCounts((c) => ({ ...c, unreadDone: 0 }));
    try {
      await markResearchTasksReadFn({ data: { taskIds: unread } });
    } catch {
      /* reconcile on next refresh */
    }
  }

  const totalBadge = counts.unreadDone + counts.pending;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-[12.5px] font-medium border border-white/[0.1] text-muted-foreground hover:text-foreground hover:border-white/20 hover:bg-white/[0.05] transition-all flex-shrink-0"
        style={{ fontFamily: "'DM Sans',sans-serif" }}
        title="Overnight research queue"
      >
        <Library size={13}/>
        <span className="hidden sm:block">Briefings</span>
        {counts.unreadDone > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500/90 text-[10px] font-semibold text-background flex items-center justify-center">
            {counts.unreadDone}
          </span>
        )}
        {counts.unreadDone === 0 && counts.pending > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500/80 text-[10px] font-semibold text-background flex items-center justify-center">
            {counts.pending}
          </span>
        )}
      </button>

      {open && (
        <div ref={popRef}
          className="absolute right-0 top-[calc(100%+6px)] w-[360px] max-h-[70vh] rounded-xl border border-white/10 bg-background/95 backdrop-blur-md shadow-2xl z-40 flex flex-col">
          <div className="px-3 py-2.5 border-b border-white/[0.06] flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-[12px] font-semibold tracking-tight">Overnight briefings</span>
              <span className="text-[10.5px] text-muted-foreground/70">
                {counts.unreadDone} ready · {counts.pending} pending
              </span>
            </div>
            <div className="flex items-center gap-1">
              {counts.unreadDone > 0 && (
                <button onClick={dismissAll}
                  className="text-[10.5px] px-2 py-1 rounded-md text-muted-foreground/80 hover:bg-white/5 hover:text-foreground">
                  Mark all read
                </button>
              )}
              <button onClick={runNow} disabled={running || counts.pending === 0}
                className="text-[10.5px] px-2 py-1 rounded-md inline-flex items-center gap-1 text-primary/85 hover:bg-primary/10 ring-1 ring-primary/25 disabled:opacity-40 disabled:cursor-not-allowed"
                title={counts.pending === 0 ? "No pending tasks" : "Run pending tasks now (skip the wait)"}>
                {running ? <Loader2 size={11} className="animate-spin"/> : <Play size={11}/>}
                Run now
              </button>
            </div>
          </div>
          <div className="overflow-y-auto flex-1 px-1 py-1">
            {loading && tasks === null && (
              <div className="px-3 py-6 text-center text-[11px] text-muted-foreground/60">Loading…</div>
            )}
            {!loading && tasks !== null && tasks.length === 0 && (
              <div className="px-3 py-8 text-center text-[11px] text-muted-foreground/60 inline-flex flex-col items-center gap-2 w-full">
                <Inbox size={18} className="opacity-50"/>
                <span>No research yet. Use the "Research overnight" chip on a draft.</span>
              </div>
            )}
            {tasks?.map((t) => <TaskRow key={t.id} task={t} onDismiss={dismissOne} onCancel={cancelOne}/>)}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskRow({
  task, onDismiss, onCancel,
}: {
  task: Task;
  onDismiss: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const isUnread = task.status === "done" && !task.readAt;
  // Result is `unknown` at the API boundary; narrow only for tools whose
  // shape we know. Other tools render a generic "Done" pill.
  const brief = (() => {
    if (task.status !== "done" || !task.result || typeof task.result !== "object") return null;
    const r = task.result as { status?: string; brief?: string; sender?: string; sourceCount?: number };
    if (r.status === "ok" && typeof r.brief === "string") {
      return { kind: "ok" as const, brief: r.brief, sender: r.sender ?? "", sourceCount: r.sourceCount ?? 0 };
    }
    if (r.status === "no_history") return { kind: "no_history" as const, sender: r.sender ?? "" };
    return null;
  })();

  return (
    <div className={`px-3 py-2 rounded-lg ${isUnread ? "bg-emerald-500/[0.04] ring-1 ring-emerald-500/15" : ""}`}>
      <div className="flex items-start gap-2">
        <StatusIcon status={task.status}/>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-medium text-foreground/85">{prettyToolId(task.toolId)}</span>
            <span className="text-[10px] text-muted-foreground/60 font-mono">· {task.source}</span>
            {task.status === "pending" && (
              <span className="text-[10px] text-amber-300/70 font-mono">· runs {timeUntil(task.scheduledFor)}</span>
            )}
          </div>
          {task.sourceContext && (
            <div className="text-[10.5px] text-muted-foreground/65 truncate mt-0.5">{task.sourceContext}</div>
          )}
          {brief?.kind === "ok" && (
            <p className="text-[11px] leading-relaxed text-foreground/80 italic mt-1.5 border-l-2 border-primary/30 pl-2">
              {brief.brief}
              {brief.sender && (
                <span className="not-italic block text-[10px] text-muted-foreground/55 mt-0.5">
                  {brief.sender} · {brief.sourceCount} prior thread{brief.sourceCount === 1 ? "" : "s"}
                </span>
              )}
            </p>
          )}
          {brief?.kind === "no_history" && (
            <div className="text-[10.5px] text-muted-foreground/65 mt-1">No prior history with {brief.sender}.</div>
          )}
          {task.status === "error" && task.error && (
            <div className="text-[10.5px] text-rose-300/75 mt-1">{task.error}</div>
          )}
        </div>
        <div className="flex flex-col gap-1">
          {isUnread && (
            <button onClick={() => onDismiss(task.id)}
              className="p-1 rounded text-muted-foreground/60 hover:text-foreground hover:bg-white/5"
              title="Mark read">
              <Check size={11}/>
            </button>
          )}
          {task.status === "pending" && (
            <button onClick={() => onCancel(task.id)}
              className="p-1 rounded text-muted-foreground/60 hover:text-rose-300 hover:bg-white/5"
              title="Cancel">
              <X size={11}/>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: Task["status"] }) {
  if (status === "done") return <Check size={12} className="text-emerald-400/80 mt-0.5 flex-shrink-0"/>;
  if (status === "error") return <AlertCircle size={12} className="text-rose-400/80 mt-0.5 flex-shrink-0"/>;
  if (status === "running") return <Loader2 size={12} className="text-primary/80 animate-spin mt-0.5 flex-shrink-0"/>;
  if (status === "cancelled") return <X size={12} className="text-muted-foreground/50 mt-0.5 flex-shrink-0"/>;
  return <Clock size={12} className="text-amber-300/70 mt-0.5 flex-shrink-0"/>;
}

const TOOL_LABELS: Record<string, string> = {
  research_thread_context: "Sender context brief",
  block_prep_time: "Prep time block",
  set_followup_reminder: "Follow-up reminder",
  suggest_availability: "Availability check",
};
function prettyToolId(id: string): string {
  return TOOL_LABELS[id] ?? id;
}

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return "now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}

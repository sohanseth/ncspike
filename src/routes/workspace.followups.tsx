import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { useState } from "react";
import {
  Check,
  X,
  Mail,
  Calendar as CalendarIcon,
  Sparkles,
  User,
  Plus,
  PenLine,
  CalendarPlus,
  Undo2,
} from "lucide-react";

export const Route = createFileRoute("/workspace/followups")({
  head: () => ({
    meta: [
      { title: "Follow-ups — NeuralConnexions" },
      { name: "description", content: "Track promises, pending actions, and open loops." },
    ],
  }),
  component: FollowupsPage,
});

type Priority = "high" | "medium" | "low";
type Action = "compose" | "schedule";

type Followup = {
  id: string;
  icon: typeof Mail;
  title: string;
  body: string;
  who: string;
  due: string;
  priority: Priority;
  suggestion: string;
  action: Action;
  draft?: string;
};

const seed: Followup[] = [
  {
    id: "sarah",
    icon: Mail,
    title: "Reply to Sarah Chen on partnership proposal",
    body: "Sarah sent updated terms (70/30 revenue share, 12-month exclusivity, co-marketing). Needs response by Friday May 9.",
    who: "Sarah Chen",
    due: "May 9",
    priority: "high",
    suggestion: "Review proposal during focus block today (10–11:30am), then send approval or counter-proposal.",
    action: "schedule",
    draft:
      "Hi Sarah,\n\nThanks for the updated terms — the 70/30 split and 12-month exclusivity work for us. I'd like to align on co-marketing scope before signing. Free at 1:30 PM today to walk through it?\n\n— Jamie",
  },
  {
    id: "alex",
    icon: Mail,
    title: "Confirm coffee meetup with Alex",
    body: "Alex suggested Tuesday 10am at Market Street cafe. Needs confirmation.",
    who: "Alex Rivera",
    due: "May 5",
    priority: "medium",
    suggestion: "Send quick confirmation and add calendar event for Tuesday 10am.",
    action: "schedule",
    draft: "Hey Alex — Tuesday 10am at Market Street works. See you then!\n\n— Jamie",
  },
  {
    id: "jamie",
    icon: CalendarIcon,
    title: "Send Q2 roadmap to Jamie",
    body: "Promised Jamie the finalized Q2 roadmap after last Thursday's planning session.",
    who: "Jamie Park",
    due: "May 7",
    priority: "high",
    suggestion: "Open Composer with the Q2 roadmap context already loaded.",
    action: "compose",
    draft:
      "Hi Jamie,\n\nSharing the finalized Q2 roadmap — highlights: pricing rollout, EU launch, mid-market motion.\n\n— You",
  },
];

const priorityClass: Record<Priority, string> = {
  high: "bg-destructive/10 text-destructive ring-1 ring-destructive/20",
  medium: "bg-warning/15 text-warning-foreground ring-1 ring-warning/30",
  low: "bg-secondary text-muted-foreground ring-1 ring-border",
};

const dotClass: Record<Priority, string> = {
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-muted-foreground",
};

function FollowupsPage() {
  const [tab, setTab] = useState<"pending" | "completed" | "all">("pending");
  const [statusMap, setStatusMap] = useState<Record<string, "open" | "done" | "skipped">>({});

  const items = seed.map((s) => ({ ...s, status: statusMap[s.id] ?? "open" }));
  const filtered = items.filter((i) => {
    if (tab === "pending") return i.status === "open";
    if (tab === "completed") return i.status === "done";
    return true;
  });
  const pendingCount = items.filter((i) => i.status === "open").length;
  const completedCount = items.filter((i) => i.status === "done").length;

  return (
    <>
      <Topbar title="Follow-ups" subtitle="Track promises, pending actions, and open loops" />
      <div className="flex-1 px-6 lg:px-10 py-8 max-w-5xl w-full mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-muted">
            {(
              [
                ["pending", `Pending (${pendingCount})`],
                ["completed", `Completed (${completedCount})`],
                ["all", "All"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-3 h-8 rounded-md text-xs font-semibold transition-colors ${
                  tab === k
                    ? "bg-surface text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg ring-1 ring-border bg-surface text-sm font-medium hover:bg-muted">
            <Plus className="size-4" />
            Add follow-up
          </button>
        </div>

        <div className="space-y-3">
          {filtered.length === 0 && (
            <div className="rounded-2xl bg-surface ring-1 ring-border p-10 text-center text-sm text-muted-foreground">
              Nothing here. NeuralConnexions will surface new follow-ups as they appear.
            </div>
          )}
          {filtered.map((f) => (
            <FollowupCard
              key={f.id}
              item={f}
              onDone={() => setStatusMap((m) => ({ ...m, [f.id]: "done" }))}
              onSkip={() => setStatusMap((m) => ({ ...m, [f.id]: "skipped" }))}
              onUndo={() => setStatusMap((m) => ({ ...m, [f.id]: "open" }))}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function FollowupCard({
  item,
  onDone,
  onSkip,
  onUndo,
}: {
  item: Followup & { status: "open" | "done" | "skipped" };
  onDone: () => void;
  onSkip: () => void;
  onUndo: () => void;
}) {
  const Icon = item.icon;
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.draft ?? "");

  if (item.status !== "open") {
    return (
      <div
        className={`flex items-center gap-3 rounded-2xl px-5 py-4 ring-1 shadow-soft ${
          item.status === "done"
            ? "bg-success/5 ring-success/30"
            : "bg-muted/40 ring-border"
        }`}
      >
        <div
          className={`size-8 rounded-full flex items-center justify-center ${
            item.status === "done"
              ? "bg-success/15 text-success"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {item.status === "done" ? <Check className="size-4" /> : <X className="size-4" />}
        </div>
        <p className="text-sm flex-1 truncate">
          <span className="font-medium">{item.title}</span>{" "}
          <span className="text-muted-foreground">
            · {item.status === "done" ? "completed" : "skipped"}
          </span>
        </p>
        <button
          onClick={onUndo}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <Undo2 className="size-3.5" /> Undo
        </button>
      </div>
    );
  }

  function runAction() {
    if (item.action === "compose") {
      navigate({ to: "/workspace/compose" });
    } else {
      navigate({ to: "/workspace/calendar" });
    }
  }

  return (
    <div className="rounded-2xl bg-surface ring-1 ring-border shadow-soft overflow-hidden">
      <div className="flex items-start gap-4 px-5 py-4">
        <div className="size-10 rounded-xl bg-secondary text-muted-foreground flex items-center justify-center shrink-0">
          <Icon className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`size-1.5 rounded-full ${dotClass[item.priority]}`} />
            <p className="text-sm font-semibold">{item.title}</p>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{item.body}</p>
          <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] ring-1 ring-border bg-surface text-foreground/80">
              <User className="size-3" />
              {item.who}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] ring-1 ring-border bg-surface text-foreground/80">
              <CalendarIcon className="size-3" />
              {item.due}
            </span>
            <span className={`px-2 py-0.5 rounded-md text-[11px] font-medium ${priorityClass[item.priority]}`}>
              {item.priority}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onSkip}
            title="Skip"
            className="size-8 rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center justify-center"
          >
            <X className="size-4" />
          </button>
          <button
            onClick={onDone}
            title="Mark done"
            className="size-8 rounded-lg text-success hover:bg-success/10 inline-flex items-center justify-center"
          >
            <Check className="size-4" />
          </button>
        </div>
      </div>

      {/* Actionable AI suggestion */}
      <div className="mx-5 mb-4 rounded-xl bg-primary/8 ring-1 ring-primary/20 p-3.5">
        <div className="flex items-start gap-2.5">
          <Sparkles className="size-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary leading-relaxed">{item.suggestion}</p>
            {editing && (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.max(4, draft.split("\n").length)}
                className="mt-3 w-full rounded-lg bg-surface ring-1 ring-border p-3 text-sm text-foreground leading-relaxed focus:outline-none focus:ring-primary/40"
              />
            )}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                onClick={runAction}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
              >
                {item.action === "compose" ? (
                  <>
                    <PenLine className="size-3.5" /> Open in Composer
                  </>
                ) : (
                  <>
                    <CalendarPlus className="size-3.5" /> Add to schedule
                  </>
                )}
              </button>
              {item.draft && (
                <button
                  onClick={() => setEditing((e) => !e)}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg ring-1 ring-border bg-surface text-xs font-medium hover:bg-muted"
                >
                  <PenLine className="size-3.5" />
                  {editing ? "Hide draft" : "Edit draft"}
                </button>
              )}
              <button
                onClick={onDone}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg ring-1 ring-border bg-surface text-xs font-medium hover:bg-muted"
              >
                <Check className="size-3.5" /> Mark done
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

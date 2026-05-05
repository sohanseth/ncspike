import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { SectionHeader } from "@/components/workspace/SectionHeader";
import { useState } from "react";
import { CheckCircle2, Circle, Clock } from "lucide-react";

export const Route = createFileRoute("/workspace/followups")({
  head: () => ({
    meta: [
      { title: "Follow-ups — Operand" },
      { name: "description", content: "Open promises and unanswered messages." },
    ],
  }),
  component: FollowupsPage,
});

const seed = [
  {
    title: "Send onboarding pack to Marcus",
    from: "You promised in email · yesterday",
    age: "1d overdue",
    overdue: true,
  },
  {
    title: "Reply to Anna about Q4 planning doc",
    from: "Slack DM · 2 days ago",
    age: "2d waiting",
    overdue: true,
  },
  {
    title: "Confirm dinner Friday with Lin",
    from: "WhatsApp · today",
    age: "today",
    overdue: false,
  },
  {
    title: "Review David's PR draft",
    from: "Email · today",
    age: "today",
    overdue: false,
  },
];

function FollowupsPage() {
  const [done, setDone] = useState<Set<number>>(new Set());

  return (
    <>
      <Topbar title="Follow-ups" subtitle="4 open · 2 overdue" />
      <div className="flex-1 px-6 lg:px-8 py-8 max-w-3xl w-full mx-auto">
        <SectionHeader
          eyebrow="Tracker"
          title="Open loops Operand spotted"
          description="Promises you made and messages waiting on your reply."
        />
        <ul className="rounded-xl bg-surface ring-1 ring-border shadow-soft divide-y divide-border overflow-hidden">
          {seed.map((item, i) => {
            const isDone = done.has(i);
            return (
              <li
                key={i}
                className="flex items-start gap-3 px-5 py-4 hover:bg-muted/40 transition-colors"
              >
                <button
                  onClick={() =>
                    setDone((s) => {
                      const n = new Set(s);
                      n.has(i) ? n.delete(i) : n.add(i);
                      return n;
                    })
                  }
                  className="mt-0.5 text-muted-foreground hover:text-foreground"
                >
                  {isDone ? (
                    <CheckCircle2 className="size-5 text-success" />
                  ) : (
                    <Circle className="size-5" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-sm font-medium ${isDone ? "line-through text-muted-foreground" : ""}`}
                  >
                    {item.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.from}</p>
                </div>
                <span
                  className={`text-[11px] px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                    item.overdue
                      ? "bg-warning/15 text-warning-foreground"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  <Clock className="size-3" />
                  {item.age}
                </span>
                <button className="text-xs font-medium px-2.5 py-1 rounded-md ring-1 ring-border hover:bg-secondary">
                  Draft
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

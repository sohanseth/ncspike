import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Topbar } from "@/components/workspace/Topbar";
import {
  Mail,
  Calendar as CalendarIcon,
  Bell,
  Clock,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  Sparkles,
  Check,
  Pencil,
  X,
  Undo2,
  Send,
} from "lucide-react";

export const Route = createFileRoute("/workspace/")({
  head: () => ({
    meta: [
      { title: "Today — NeuralConnexions" },
      {
        name: "description",
        content:
          "Your morning briefing: suggested actions, today's schedule, and open follow-ups.",
      },
    ],
  }),
  component: TodayPage,
});

const stats = [
  {
    label: "Unread emails",
    value: "3",
    icon: Mail,
    tile: "bg-tile-lavender text-primary",
  },
  {
    label: "Meetings today",
    value: "1",
    icon: CalendarIcon,
    tile: "bg-tile-mint text-success",
  },
  {
    label: "Follow-ups due",
    value: "3",
    icon: Bell,
    tile: "bg-tile-peach text-warning-foreground",
  },
  {
    label: "Focus time",
    value: "1.5hrs",
    icon: Clock,
    tile: "bg-tile-lilac text-accent",
  },
];

type Suggestion = {
  id: string;
  icon: typeof Mail;
  title: string;
  body: string;
  draft: string;
  sources: string[];
  primaryLabel: string;
};

const suggestions: Suggestion[] = [
  {
    id: "sarah-reply",
    icon: Mail,
    title: "Reply to Sarah Chen",
    body: "Sarah is following up on a partnership proposal with updated terms (70/30 revenue share, 12-month exclusivity, co-marketing).",
    draft:
      "Hi Sarah,\n\nThanks for the updated terms — the 70/30 split and 12-month exclusivity work for us. I'd like to align on co-marketing scope before signing. Free at 1:30 PM today to walk through it?\n\n— Jamie",
    sources: ["Pricing v3 (Docs)", "Partnership thread", "Tone profile"],
    primaryLabel: "Approve & Send",
  },
  {
    id: "sarah-review",
    icon: Bell,
    title: "Reply to Sarah Chen on partnership proposal",
    body: "Review proposal during focus block today (10–11:30am), then send approval or counter-proposal.",
    draft:
      "Block 10:00–11:30 AM as focused review of the partnership proposal. At 11:30, draft an approval or counter-proposal reply to Sarah.",
    sources: ["Calendar · 10–11:30 focus", "Partnership v2 (Docs)"],
    primaryLabel: "Add to schedule",
  },
  {
    id: "q2-roadmap",
    icon: Bell,
    title: "Send Q2 roadmap to Jamie",
    body: "Finalize roadmap document and share before the Wednesday deadline.",
    draft:
      "Hi Jamie,\n\nSharing the finalized Q2 roadmap ahead of Wednesday. Highlights: pricing rollout, EU launch, mid-market motion. Happy to walk through anything that needs more context.\n\n— You",
    sources: ["Q2 Roadmap (Docs)", "Wednesday deadline"],
    primaryLabel: "Approve & Send",
  },
];

const schedule = [
  {
    title: "Team Standup",
    time: "10:00 AM – 10:15 AM",
    attendees: ["J", "P", "T"],
    kind: "meeting",
  },
  {
    title: "Focus Time — Partnership",
    time: "11:00 AM – 12:30 PM",
    attendees: [],
    kind: "focus",
  },
  {
    title: "1:1 with Marcus",
    time: "2:00 PM – 2:30 PM",
    attendees: ["M", "J"],
    kind: "meeting",
  },
];

const followups = [
  { title: "Reply to Sarah Chen on partnership proposal", who: "Sarah Chen", due: "Due May 9", overdue: true },
  { title: "Confirm coffee meetup with Alex", who: "Alex Rivera", due: "Due May 5", overdue: true },
  { title: "Send Q2 roadmap document", who: "Jamie Park", due: "Due May 7", overdue: false },
];

function TodayPage() {
  return (
    <>
      <Topbar
        title="Today"
        subtitle={new Date().toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
      />

      <div className="flex-1 px-6 lg:px-10 py-8 max-w-6xl w-full mx-auto">
        {/* Greeting */}
        <header className="mb-8">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent inline-flex items-center gap-1.5 mb-2">
            <Sparkles className="size-3" />
            Morning briefing
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            Good morning, Jamie.
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Here's what your cognitive companion lined up for the day.
          </p>
        </header>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.label}
                className="rounded-2xl bg-surface ring-1 ring-border p-5 shadow-soft flex items-center gap-4"
              >
                <div className={`size-12 rounded-xl flex items-center justify-center ${s.tile}`}>
                  <Icon className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-2xl font-bold tracking-tight leading-none">{s.value}</p>
                  <p className="text-xs text-muted-foreground mt-1.5">{s.label}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Suggested actions */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Suggested actions
            </h2>
            <span className="text-xs text-muted-foreground">{suggestions.length} items</span>
          </div>
          <div className="space-y-2.5">
            {suggestions.map((s) => (
              <SuggestionRow key={s.id} suggestion={s} />
            ))}
          </div>
        </section>

        {/* Two-column: Schedule + Follow-ups */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Today's schedule
              </h2>
              <Link
                to="/workspace/calendar"
                className="text-xs font-medium text-primary inline-flex items-center gap-1 hover:underline"
              >
                Full calendar <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="space-y-2.5">
              {schedule.map((item) => (
                <div
                  key={item.title}
                  className={`relative rounded-xl bg-surface ring-1 ring-border pl-4 pr-4 py-3.5 shadow-soft overflow-hidden ${
                    item.kind === "focus" ? "bg-tile-mint/40" : "bg-tile-lavender/40"
                  }`}
                >
                  <span
                    className={`absolute left-0 top-2 bottom-2 w-1 rounded-r ${
                      item.kind === "focus" ? "bg-success" : "bg-primary"
                    }`}
                  />
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold">{item.title}</p>
                    <p className="text-[11px] font-mono text-muted-foreground whitespace-nowrap">
                      {item.time}
                    </p>
                  </div>
                  {item.attendees.length > 0 && (
                    <div className="flex items-center gap-1 mt-2">
                      {item.attendees.map((a) => (
                        <span
                          key={a}
                          className="size-6 rounded-full bg-surface ring-1 ring-border text-[10px] font-semibold text-muted-foreground inline-flex items-center justify-center"
                        >
                          {a}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Open follow-ups
              </h2>
              <Link
                to="/workspace/followups"
                className="text-xs font-medium text-primary inline-flex items-center gap-1 hover:underline"
              >
                View all <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="rounded-2xl bg-surface ring-1 ring-border shadow-soft divide-y divide-border overflow-hidden">
              {followups.map((f) => (
                <div key={f.title} className="px-5 py-4 hover:bg-muted/40 transition-colors">
                  <div className="flex items-start gap-2.5">
                    <span
                      className={`mt-1.5 size-1.5 rounded-full shrink-0 ${
                        f.overdue ? "bg-destructive" : "bg-warning"
                      }`}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{f.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {f.who} <span className="opacity-50">·</span> {f.due}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

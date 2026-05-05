import { createFileRoute, Link } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { ApprovalCard } from "@/components/workspace/ApprovalCard";
import { SectionHeader } from "@/components/workspace/SectionHeader";
import {
  Inbox,
  Calendar,
  Clock,
  ArrowRight,
  Sparkles,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

export const Route = createFileRoute("/workspace/")({
  head: () => ({
    meta: [
      { title: "Today — Operand" },
      {
        name: "description",
        content:
          "Your morning briefing: replies that need attention, today's meetings, follow-ups, and a suggested plan.",
      },
    ],
  }),
  component: TodayPage,
});

const stats = [
  { label: "Replies needed", value: 3, icon: Inbox, accent: "text-accent" },
  { label: "Meetings today", value: 2, icon: Calendar, accent: "text-foreground" },
  { label: "Open promises", value: 1, icon: AlertCircle, accent: "text-warning-foreground" },
  { label: "Free focus block", value: "90m", icon: Clock, accent: "text-foreground" },
];

const schedule = [
  { time: "9:30", title: "Deep work — Alpha launch brief", kind: "focus" },
  { time: "11:00", title: "Q3 strategy with Mark & Priya", kind: "meeting", prep: true },
  { time: "13:00", title: "Lunch", kind: "break" },
  { time: "14:00", title: "Pricing review with Sarah", kind: "meeting", prep: true },
  { time: "15:30", title: "Suggested: send onboarding to Marcus", kind: "suggested" },
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

      <div className="flex-1 px-6 lg:px-8 py-8 max-w-6xl w-full mx-auto">
        {/* Greeting */}
        <header className="mb-10">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-accent mb-2 inline-flex items-center gap-1.5">
            <Sparkles className="size-3" />
            Morning briefing
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">
            Good morning, Jamie.
          </h1>
          <p className="text-base text-muted-foreground mt-2 text-pretty max-w-2xl">
            You have <span className="text-foreground font-medium">3 messages</span>{" "}
            that need replies, <span className="text-foreground font-medium">2 meetings</span>,
            one promise to keep, and a free{" "}
            <span className="text-foreground font-medium">90-minute block</span> this
            afternoon. Here's a suggested plan.
          </p>
        </header>

        {/* Stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.label}
                className="rounded-xl bg-surface ring-1 ring-border p-4 shadow-soft"
              >
                <div className="flex items-center justify-between mb-2">
                  <Icon className={`size-4 ${s.accent}`} />
                </div>
                <p className="text-2xl font-semibold tracking-tight">{s.value}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{s.label}</p>
              </div>
            );
          })}
        </div>

        {/* Two-column workflow + plan */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-8">
            <section>
              <SectionHeader
                eyebrow="Reply Zero"
                title="Replies waiting on you"
                description="Drafts ready for review. Approve, edit, or skip."
                action={
                  <Link
                    to="/workspace/inbox"
                    className="text-xs font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                  >
                    Open inbox <ArrowRight className="size-3" />
                  </Link>
                }
              />
              <div className="space-y-4">
                <ApprovalCard
                  badge="High priority"
                  badgeTone="accent"
                  from="Sarah Chen"
                  fromMeta="Gmail · 8:42 AM"
                  context={`"Checking in on the pricing proposal — can we review it before the 2 PM call?"`}
                  draft={`Hi Sarah,

Just finished the latest draft — attaching it now. I've adjusted Tier 2 based on the Notion thread from Tuesday. Free at 1:30 PM if you'd like to sync before the call.

— Jamie`}
                  sources={[
                    { label: "Pricing v3 (Docs)", kind: "doc" },
                    { label: "2 PM call", kind: "calendar" },
                  ]}
                />
                <ApprovalCard
                  badge="Follow-up"
                  from="Marcus Lee"
                  fromMeta="Gmail · yesterday"
                  context={`You promised to send the onboarding pack by EOD. Haven't sent it yet.`}
                  draft={`Hey Marcus,

Sending the onboarding pack now — let me know once you've had a look and I'll set up time to walk through anything that's unclear.

— Jamie`}
                  sources={[{ label: "Onboarding v2 (Docs)", kind: "doc" }]}
                  primaryLabel="Send & close loop"
                />
              </div>
            </section>

            <section>
              <SectionHeader
                eyebrow="Meeting prep"
                title="Q3 Strategy · 11:00 AM"
                description="No prep notes yet. Operand drafted a brief from your last sync and the strategy doc."
              />
              <div className="rounded-xl bg-surface ring-1 ring-border p-5 shadow-soft space-y-4">
                <div className="grid sm:grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Attendees
                    </p>
                    <p>Mark, Priya, Jamie</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Last discussed
                    </p>
                    <p>Pricing tiers, EU launch</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Open from last time
                    </p>
                    <p>Headcount plan, GTM owner</p>
                  </div>
                </div>
                <div className="border-t border-border pt-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Suggested questions
                  </p>
                  <ul className="text-sm space-y-1.5">
                    <li className="flex gap-2">
                      <span className="text-muted-foreground">·</span>Are we still
                      committing to the Sept EU launch given pricing changes?
                    </li>
                    <li className="flex gap-2">
                      <span className="text-muted-foreground">·</span>Who owns GTM for
                      the new mid-market tier?
                    </li>
                    <li className="flex gap-2">
                      <span className="text-muted-foreground">·</span>Do we need
                      another design hire before Q4?
                    </li>
                  </ul>
                </div>
                <div className="flex gap-2 pt-1">
                  <button className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90">
                    Save brief to calendar
                  </button>
                  <button className="px-3 py-1.5 rounded-md text-xs font-medium ring-1 ring-border hover:bg-secondary">
                    Open full brief
                  </button>
                </div>
              </div>
            </section>
          </div>

          {/* Plan column */}
          <aside className="space-y-8">
            <section>
              <SectionHeader eyebrow="Plan" title="Today's schedule" />
              <ol className="rounded-xl bg-surface ring-1 ring-border overflow-hidden divide-y divide-border shadow-soft">
                {schedule.map((item) => (
                  <li
                    key={item.time}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
                  >
                    <span className="text-xs font-mono text-muted-foreground w-10 pt-0.5">
                      {item.time}
                    </span>
                    <span
                      className={[
                        "mt-1 size-1.5 rounded-full shrink-0",
                        item.kind === "meeting"
                          ? "bg-accent"
                          : item.kind === "suggested"
                            ? "bg-warning"
                            : item.kind === "focus"
                              ? "bg-primary"
                              : "bg-muted-foreground/40",
                      ].join(" ")}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-balance">{item.title}</p>
                      {item.prep && (
                        <p className="text-[11px] text-accent font-medium mt-0.5">
                          Prep brief ready
                        </p>
                      )}
                      {item.kind === "suggested" && (
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          From your open promises
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <SectionHeader eyebrow="Quick actions" title="Workflows" />
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: "Reply Zero", to: "/workspace/inbox" },
                  { label: "Plan my day", to: "/workspace/calendar" },
                  { label: "Follow-ups", to: "/workspace/followups" },
                  { label: "Write properly", to: "/workspace/compose" },
                ].map((q) => (
                  <Link
                    key={q.label}
                    to={q.to}
                    className="px-3 py-3 rounded-lg bg-surface ring-1 ring-border text-xs font-medium text-center hover:bg-secondary transition-colors"
                  >
                    {q.label}
                  </Link>
                ))}
              </div>
            </section>

            <section>
              <SectionHeader eyebrow="Trust" title="What Operand knows" />
              <div className="rounded-xl bg-surface ring-1 ring-border p-4 text-sm space-y-2 shadow-soft">
                <p className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="size-3.5 text-success" />
                  Indexed 187 emails, 12 docs, 14 events
                </p>
                <p className="flex items-center gap-2 text-muted-foreground">
                  <CheckCircle2 className="size-3.5 text-success" />
                  Tone profile: clear, warm, concise
                </p>
                <Link
                  to="/workspace/memory"
                  className="text-xs font-medium text-foreground hover:underline inline-flex items-center gap-1 pt-1"
                >
                  Review memory <ArrowRight className="size-3" />
                </Link>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

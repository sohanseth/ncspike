import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ArrowRight,
  Briefcase,
  CalendarDays,
  Check,
  Eye,
  GraduationCap,
  Heart,
  Inbox,
  PenLine,
  Sparkles,
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "Try the demo workspace — NeuralConnexions" },
      {
        name: "description",
        content:
          "Explore a NeuralConnexions workspace filled with sample tasks, emails and calendar events. No sign-in needed and no real data.",
      },
      { property: "og:title", content: "Try the demo workspace — NeuralConnexions" },
      {
        property: "og:description",
        content: "A no-sign-in tour of the cognitive companion, using sample data only.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DemoWorkspace,
});

// ─── Sample data (fictional — nothing here is real user data) ────────────────

type DomainId = "learning" | "professional" | "social" | "family" | "personal";

const DOMAINS: Record<DomainId, { label: string; Icon: LucideIcon }> = {
  professional: { label: "Professional", Icon: Briefcase },
  learning: { label: "Learning", Icon: GraduationCap },
  social: { label: "Social", Icon: Users },
  family: { label: "Family", Icon: Heart },
  personal: { label: "Personal", Icon: User },
};
const ORDER: DomainId[] = ["professional", "learning", "social", "family", "personal"];

type Task = { id: string; domain: DomainId; text: string; urgent?: boolean; meta: string };
const TASKS: Task[] = [
  { id: "t1", domain: "professional", text: "Reply to Priya about the Q4 roadmap review", urgent: true, meta: "Due today" },
  { id: "t2", domain: "professional", text: "Prepare slides for Thursday's design critique", meta: "Thu" },
  { id: "t3", domain: "professional", text: "Send invoice to Northwind Studio", meta: "Overdue 2 days", urgent: true },
  { id: "t4", domain: "learning", text: "Finish chapter 4 of 'Designing Data-Intensive Applications'", meta: "This week" },
  { id: "t5", domain: "learning", text: "Watch the overnight research digest on local LLMs", meta: "Ready" },
  { id: "t6", domain: "social", text: "Confirm Saturday brunch with Alex and Sam", meta: "Tomorrow" },
  { id: "t7", domain: "social", text: "Wish Maya happy birthday", urgent: true, meta: "Today" },
  { id: "t8", domain: "family", text: "Book Mum's eye appointment", meta: "This week" },
  { id: "t9", domain: "family", text: "Pick up school photos form", meta: "Fri" },
  { id: "t10", domain: "personal", text: "Renew gym membership", meta: "Next week" },
  { id: "t11", domain: "personal", text: "Buy running shoes", meta: "Whenever" },
];

type Email = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  category: "Needs reply" | "FYI" | "Newsletter";
  domain: DomainId;
  meeting?: { ask: string; free: string; conflict?: string };
  draft?: string;
};
const EMAILS: Email[] = [
  {
    id: "e1",
    from: "Priya Shah",
    subject: "Q4 roadmap review — can we meet Thursday?",
    preview: "Would Thursday at 3pm work for a 45-minute review of the roadmap draft?",
    category: "Needs reply",
    domain: "professional",
    meeting: { ask: "Thu 15:00–15:45", free: "Thu 16:00–16:45", conflict: "Design critique 14:30–15:30" },
    draft:
      "Hi Priya,\n\nThanks for setting this up. Thursday at 3pm overlaps with our design critique — could we do 4:00–4:45 instead? I'll bring my notes on the roadmap draft.\n\nBest,\nSnehal",
  },
  {
    id: "e2",
    from: "Alex Moreno",
    subject: "Brunch Saturday?",
    preview: "Sam and I are thinking 11am at the usual place. You in?",
    category: "Needs reply",
    domain: "social",
    meeting: { ask: "Sat 11:00–12:30", free: "Sat 11:00–12:30" },
    draft: "Hey Alex,\n\nCount me in — 11am Saturday works. See you both there!\n\nSnehal",
  },
  {
    id: "e3",
    from: "Northwind Studio",
    subject: "Invoice reminder",
    preview: "Just a gentle nudge that last month's invoice is still outstanding.",
    category: "Needs reply",
    domain: "professional",
    draft:
      "Hi team,\n\nApologies for the delay — the invoice is going out today. Thanks for the reminder.\n\nBest,\nSnehal",
  },
  {
    id: "e4",
    from: "Greenfield School",
    subject: "Photo day forms due Friday",
    preview: "Please return the signed photo-day form by Friday.",
    category: "FYI",
    domain: "family",
  },
  {
    id: "e5",
    from: "The Batch",
    subject: "This week in AI",
    preview: "On-device models get faster, plus new open-source releases.",
    category: "Newsletter",
    domain: "learning",
  },
];

const CALENDAR = [
  { time: "09:30", title: "Team stand-up", domain: "professional" as DomainId },
  { time: "12:30", title: "Lunch with Jordan", domain: "social" as DomainId },
  { time: "14:30", title: "Design critique", domain: "professional" as DomainId },
  { time: "18:00", title: "Swim class pick-up", domain: "family" as DomainId },
];

const tile = (id: DomainId) => ({ background: `var(--${id}-surface)`, color: `var(--${id})` });

// ─── Page ────────────────────────────────────────────────────────────────────

function DemoWorkspace() {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [domain, setDomain] = useState<DomainId | null>(null);
  const [emailId, setEmailId] = useState<string | null>(null);

  const openTasks = useMemo(() => TASKS.filter((t) => !done.has(t.id)), [done]);
  const email = EMAILS.find((e) => e.id === emailId) ?? null;
  const toggle = (id: string) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visibleTasks = domain ? TASKS.filter((t) => t.domain === domain) : TASKS;

  return (
    <div className="min-h-screen text-foreground">
      {/* Demo banner */}
      <div className="bg-primary/15 border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="inline-flex items-center gap-2">
            <Eye className="size-4 text-primary" />
            <span>
              <strong className="font-semibold">Demo workspace</strong>
              <span className="text-muted-foreground"> — sample data only. Nothing you do here is saved or sent.</span>
            </span>
          </span>
          <Link
            to="/auth"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-semibold hover:bg-primary/90"
          >
            Create your own workspace <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>

      <header className="mx-auto max-w-6xl px-4 pt-6 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <div className="size-8 rounded-xl bg-primary flex items-center justify-center">
            <Sparkles className="size-4 text-primary-foreground" />
          </div>
          <span className="font-display text-sm font-semibold tracking-tight">NeuralConnexions</span>
        </Link>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Find · Nurture · Sustain
        </span>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        <section>
          <h1 className="font-display text-3xl md:text-4xl font-semibold tracking-tight">Good morning, Snehal</h1>
          <p className="mt-1 text-muted-foreground">
            {openTasks.length} things on your plate, {EMAILS.filter((e) => e.category === "Needs reply").length} emails
            waiting on you, and {CALENDAR.length} events today.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => setDomain(null)}
              className={`rounded-lg px-3 py-2 text-xs font-medium border transition-colors ${
                domain === null ? "bg-foreground text-background border-foreground" : "bg-card border-border hover:bg-secondary"
              }`}
            >
              All areas
            </button>
            {ORDER.map((id) => {
              const { label, Icon } = DOMAINS[id];
              const count = openTasks.filter((t) => t.domain === id).length;
              const active = domain === id;
              return (
                <button
                  key={id}
                  onClick={() => setDomain(active ? null : id)}
                  className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium border transition-all ${
                    active ? "border-foreground/40 shadow-sm" : "border-border hover:scale-[1.02]"
                  }`}
                  style={tile(id)}
                >
                  <Icon className="size-4" />
                  <span className="text-foreground">{label}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
          {/* Tasks */}
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="font-display text-lg font-semibold flex items-center gap-2">
              <Check className="size-4 text-success" />
              {domain ? `${DOMAINS[domain].label} tasks` : "Today's priorities"}
            </h2>
            <ul className="mt-3 space-y-2">
              {visibleTasks.map((t) => {
                const isDone = done.has(t.id);
                return (
                  <li key={t.id} className="flex items-start gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5">
                    <button
                      onClick={() => toggle(t.id)}
                      aria-label={isDone ? "Mark as not done" : "Mark as done"}
                      className={`mt-0.5 size-5 shrink-0 rounded-md border flex items-center justify-center ${
                        isDone ? "bg-success border-success text-success-foreground" : "border-border hover:border-foreground/40"
                      }`}
                    >
                      {isDone && <Check className="size-3.5" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm ${isDone ? "line-through text-muted-foreground" : ""}`}>{t.text}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="inline-block size-1.5 rounded-full" style={{ background: `var(--${t.domain})` }} />
                        {DOMAINS[t.domain].label} · {t.meta}
                        {t.urgent && !isDone && <span className="text-destructive font-medium">Urgent</span>}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="space-y-6">
            {/* Calendar */}
            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="font-display text-lg font-semibold flex items-center gap-2">
                <CalendarDays className="size-4 text-primary" /> Today
              </h2>
              <ul className="mt-3 space-y-2">
                {CALENDAR.map((ev) => (
                  <li key={ev.time} className="flex items-center gap-3 text-sm">
                    <span className="font-mono text-xs text-muted-foreground w-12">{ev.time}</span>
                    <span className="h-6 w-1 rounded-full" style={{ background: `var(--${ev.domain})` }} />
                    <span>{ev.title}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Inbox */}
            <section className="rounded-xl border border-border bg-card p-4">
              <h2 className="font-display text-lg font-semibold flex items-center gap-2">
                <Inbox className="size-4 text-primary" /> Inbox, sorted for you
              </h2>
              <ul className="mt-3 space-y-2">
                {EMAILS.map((e) => (
                  <li key={e.id}>
                    <button
                      onClick={() => setEmailId(e.id)}
                      className="w-full text-left rounded-lg border border-border bg-background/60 px-3 py-2.5 hover:bg-secondary transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">{e.from}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            e.category === "Needs reply"
                              ? "bg-warning/20 text-foreground"
                              : e.category === "FYI"
                                ? "bg-primary/15 text-foreground"
                                : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {e.category}
                        </span>
                      </div>
                      <p className="text-sm truncate">{e.subject}</p>
                      <p className="text-xs text-muted-foreground truncate">{e.preview}</p>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          Like what you see?{" "}
          <Link to="/auth" className="text-primary font-medium hover:underline">
            Create your workspace
          </Link>{" "}
          to connect your own email and calendar.
        </p>
      </main>

      {/* Email detail with drafted reply + calendar check */}
      {email && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ background: "var(--scrim)" }}
          onClick={() => setEmailId(null)}
        >
          <div
            role="dialog"
            aria-label={email.subject}
            className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-lg max-h-[85vh] overflow-y-auto"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{email.from}</p>
                <h3 className="font-display text-lg font-semibold">{email.subject}</h3>
              </div>
              <button onClick={() => setEmailId(null)} aria-label="Close" className="rounded-md p-1 hover:bg-secondary">
                <X className="size-4" />
              </button>
            </div>
            <p className="mt-3 text-sm">{email.preview}</p>

            {email.meeting && (
              <div className="mt-4 rounded-lg border border-border bg-background/60 p-3 text-sm">
                <p className="font-medium flex items-center gap-2">
                  <CalendarDays className="size-4 text-primary" /> Calendar check
                </p>
                <p className="mt-1 text-muted-foreground">They asked for: {email.meeting.ask}</p>
                {email.meeting.conflict ? (
                  <>
                    <p className="text-destructive">Clashes with: {email.meeting.conflict}</p>
                    <p className="text-success font-medium">Suggested instead: {email.meeting.free}</p>
                  </>
                ) : (
                  <p className="text-success font-medium">You're free then ✓</p>
                )}
              </div>
            )}

            {email.draft ? (
              <div className="mt-4">
                <p className="text-sm font-medium flex items-center gap-2">
                  <PenLine className="size-4 text-primary" /> Drafted reply, in your voice
                </p>
                <pre className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-3 text-sm font-sans">
                  {email.draft}
                </pre>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  In your real workspace, nothing is ever sent without your tap.
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">No reply needed — filed as {email.category.toLowerCase()}.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

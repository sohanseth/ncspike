import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Sparkles,
  Inbox,
  Calendar,
  PenLine,
  Brain,
  CheckCircle2,
  ArrowRight,
  ShieldCheck,
  MessageCircle,
  Heart,
  Compass,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NeuralConnexions — The cognitive companion for everyday connection" },
      {
        name: "description",
        content:
          "NeuralConnexions is the AI workspace that helps you communicate, plan, and nurture every relationship — across email, calendar, and soon WhatsApp.",
      },
      {
        property: "og:title",
        content: "NeuralConnexions — Find · Nurture · Sustain",
      },
      {
        property: "og:description",
        content:
          "An AI Digital Twin that clears your inbox, plans your day, and protects the relationships that matter.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="size-7 rounded-lg bg-primary flex items-center justify-center">
              <Sparkles className="size-4 text-primary-foreground" />
            </div>
            <div className="leading-tight">
              <span className="text-sm font-semibold tracking-tight block">NeuralConnexions</span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Find · Nurture · Sustain
              </span>
            </div>
          </Link>
          <div className="hidden md:flex items-center gap-7 text-sm text-muted-foreground">
            <a href="#workflows" className="hover:text-foreground">Workflows</a>
            <a href="#twin" className="hover:text-foreground">Digital Twin</a>
            <a href="#trust" className="hover:text-foreground">Trust</a>
            <a href="#whatsapp" className="hover:text-foreground">WhatsApp</a>
          </div>
          <Link
            to="/workspace"
            className="text-sm font-medium bg-primary text-primary-foreground px-3.5 py-1.5 rounded-md inline-flex items-center gap-1.5 hover:bg-primary/90"
          >
            Open workspace
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <header className="relative px-6 pt-20 pb-16 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 opacity-70"
          style={{
            background:
              "radial-gradient(60% 60% at 80% 20%, oklch(0.92 0.05 25 / 0.45), transparent 60%), radial-gradient(50% 50% at 10% 30%, oklch(0.9 0.05 245 / 0.55), transparent 60%)",
          }}
        />
        <div className="mx-auto max-w-6xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 text-accent px-2.5 py-1 text-[11px] font-semibold ring-1 ring-accent/20">
            <Sparkles className="size-3" />
            The Cognitive Companion · Early access
          </span>
          <h1 className="mt-5 text-5xl md:text-6xl font-semibold tracking-tight text-balance max-w-[20ch] leading-[1.05]">
            AI that understands how you connect.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-[58ch] text-pretty">
            NeuralConnexions is your personal AI workspace for everyday communication —
            clearing your inbox, planning your day, and protecting the relationships that
            matter. From first contact to lifelong growth.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/workspace"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Open the workspace
              <ArrowRight className="size-4" />
            </Link>
            <a
              href="#workflows"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium ring-1 ring-border bg-surface hover:bg-secondary"
            >
              See how it works
            </a>
            <span className="text-xs text-muted-foreground">
              Gmail · Calendar · Docs · Slack · WhatsApp (soon)
            </span>
          </div>

          {/* Find / Nurture / Sustain */}
          <div className="mt-14 grid sm:grid-cols-3 gap-4">
            {[
              {
                icon: Compass,
                eyebrow: "Find",
                title: "Intentional discovery",
                body: "Surface the message, meeting, or person that needs you next.",
              },
              {
                icon: Heart,
                eyebrow: "Nurture",
                title: "Proactive growth",
                body: "Drafts in your tone, follow-ups before they slip, prep before every call.",
              },
              {
                icon: Sparkles,
                eyebrow: "Sustain",
                title: "Sustained harmony",
                body: "A digital twin that learns how you connect — and protects it.",
              },
            ].map((c) => (
              <div
                key={c.eyebrow}
                className="rounded-xl bg-surface ring-1 ring-border p-5 shadow-soft"
              >
                <div className="size-9 rounded-lg bg-accent/10 text-accent inline-flex items-center justify-center">
                  <c.icon className="size-4" />
                </div>
                <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
                  {c.eyebrow}
                </p>
                <h3 className="mt-1 text-base font-semibold">{c.title}</h3>
                <p className="text-sm text-muted-foreground mt-1 text-pretty">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* Product preview */}
      <section className="px-6 pb-20">
        <div className="mx-auto max-w-6xl">
          <div className="rounded-2xl ring-1 ring-border bg-surface shadow-elevated overflow-hidden">
            <div className="border-b border-border px-5 py-3 flex items-center justify-between bg-muted/30">
              <div className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-muted-foreground/20" />
                <span className="size-2.5 rounded-full bg-muted-foreground/20" />
                <span className="size-2.5 rounded-full bg-muted-foreground/20" />
              </div>
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                neuralconnexions.ai / today
              </span>
              <span className="w-12" />
            </div>

            <div className="p-6 md:p-8 grid md:grid-cols-5 gap-6">
              <div className="md:col-span-3 space-y-5">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-accent inline-flex items-center gap-1.5">
                    <Sparkles className="size-3" /> Morning briefing
                  </p>
                  <h3 className="mt-1 text-xl font-semibold">Good morning, Jamie.</h3>
                  <p className="text-sm text-muted-foreground mt-1 text-pretty">
                    3 messages need replies, 2 meetings today, 1 promise to keep,
                    and a free 90-minute block this afternoon.
                  </p>
                </div>

                <div className="rounded-xl ring-1 ring-border bg-background p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="size-9 rounded-full bg-secondary overflow-hidden">
                        <img
                          src="https://i.pravatar.cc/72?u=sarah"
                          alt=""
                          className="size-full object-cover"
                        />
                      </div>
                      <div>
                        <p className="text-sm font-medium">Sarah Chen</p>
                        <p className="text-xs text-muted-foreground">Re: Pricing proposal</p>
                      </div>
                    </div>
                    <span className="text-[10px] font-semibold uppercase text-accent bg-accent/10 ring-1 ring-accent/20 px-2 py-0.5 rounded">
                      Suggested
                    </span>
                  </div>
                  <div className="mt-3 rounded-lg bg-muted/50 border border-border p-3 text-sm">
                    Hi Sarah, finished the latest draft. Free at 1:30 PM if you'd
                    like to sync before the call.
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-[11px] text-muted-foreground">
                      Used: Pricing v3 · 2 PM call · tone profile
                    </p>
                    <div className="flex gap-2">
                      <button className="text-xs px-2.5 py-1 rounded ring-1 ring-border">
                        Edit
                      </button>
                      <button className="text-xs px-2.5 py-1 rounded bg-primary text-primary-foreground font-semibold">
                        Approve & Send
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="md:col-span-2 space-y-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Today
                </p>
                {[
                  { t: "9:30", l: "Deep work — Alpha brief", c: "bg-primary" },
                  { t: "11:00", l: "Q3 strategy", c: "bg-accent" },
                  { t: "14:00", l: "Pricing review w/ Sarah", c: "bg-accent" },
                  {
                    t: "15:30",
                    l: "Suggested: send onboarding to Marcus",
                    c: "bg-warning",
                  },
                ].map((s) => (
                  <div
                    key={s.t}
                    className="flex items-center gap-3 rounded-lg bg-background ring-1 ring-border px-3 py-2.5"
                  >
                    <span className="text-xs font-mono text-muted-foreground w-10">
                      {s.t}
                    </span>
                    <span className={`size-1.5 rounded-full ${s.c}`} />
                    <span className="text-sm text-balance">{s.l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Digital Twin */}
      <section id="twin" className="px-6 py-20 bg-muted/30 border-y border-border">
        <div className="mx-auto max-w-6xl grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
              The AI Digital Twin
            </p>
            <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight text-balance">
              A living model of how you connect.
            </h2>
            <p className="mt-4 text-base text-muted-foreground text-pretty max-w-[52ch]">
              Your twin learns your tone, your relationships, and your goals from the
              context you already produce — email, calendar, docs, conversations. It
              predicts friction before it lands and proposes the next right move.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "Mirrors your communication style",
                "Predicts emotional friction in drafts",
                "Tracks open promises across channels",
                "Guides micro-interventions in real time",
              ].map((p) => (
                <li key={p} className="flex items-center gap-2.5">
                  <CheckCircle2 className="size-4 text-success" />
                  {p}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl ring-1 ring-border bg-surface p-6 shadow-soft space-y-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Before / After
            </p>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg bg-muted/60 ring-1 ring-border p-3 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">Before</p>
                <p>"You never listen."</p>
                <p>"That's not what I meant!"</p>
                <p>"Why are you being defensive?"</p>
              </div>
              <div className="rounded-lg bg-accent/5 ring-1 ring-accent/20 p-3 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-accent">After · AI-guided</p>
                <p>"I feel heard when…"</p>
                <p>"Help me understand…"</p>
                <p>"What I appreciate is…"</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Workflows */}
      <section id="workflows" className="px-6 py-20">
        <div className="mx-auto max-w-6xl">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
            Workflows, not chat
          </p>
          <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight text-balance max-w-[24ch]">
            Less prompting. More finishing.
          </h2>
          <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: Inbox,
                title: "Reply Zero",
                body: "Triage your inbox in one pass with reviewable drafts in your tone.",
              },
              {
                icon: Calendar,
                title: "Plan My Day",
                body: "Turn calendar, messages, and tasks into a realistic, focused day.",
              },
              {
                icon: CheckCircle2,
                title: "Follow-Up Tracker",
                body: "Catch open promises and unanswered messages before they slip.",
              },
              {
                icon: PenLine,
                title: "Write This Properly",
                body: "Turn rough thoughts into polished emails, docs, and messages.",
              },
              {
                icon: Sparkles,
                title: "Meeting Prep",
                body: "Briefs with attendees, last discussion, related docs, and questions.",
              },
              {
                icon: Brain,
                title: "Weekly Review",
                body: "Summarize the week, surface unfinished work, set next priorities.",
              },
            ].map((w) => (
              <div
                key={w.title}
                className="rounded-xl bg-surface ring-1 ring-border p-5 shadow-soft"
              >
                <div className="size-9 rounded-lg bg-secondary inline-flex items-center justify-center">
                  <w.icon className="size-4" />
                </div>
                <h3 className="mt-4 text-base font-semibold">{w.title}</h3>
                <p className="text-sm text-muted-foreground mt-1 text-pretty">{w.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WhatsApp roadmap */}
      <section id="whatsapp" className="px-6 py-20 bg-muted/30 border-y border-border">
        <div className="mx-auto max-w-5xl rounded-2xl ring-1 ring-border bg-surface p-8 md:p-12 shadow-soft grid md:grid-cols-5 gap-8 items-center">
          <div className="md:col-span-3">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-success bg-success/10 ring-1 ring-success/20 px-2 py-0.5 rounded">
              <MessageCircle className="size-3" /> Coming next
            </span>
            <h2 className="mt-3 text-2xl md:text-3xl font-semibold tracking-tight text-balance">
              The same companion — now in your WhatsApp threads.
            </h2>
            <p className="mt-3 text-base text-muted-foreground text-pretty max-w-[52ch]">
              Drafts, follow-ups, and emotional clarity in the channel where most of
              life actually happens. Personal and group chats, with the same
              approval-first trust model.
            </p>
            <a
              href="mailto:hello@neuralconnexions.ai?subject=WhatsApp%20beta"
              className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Join the WhatsApp beta
              <ArrowRight className="size-4" />
            </a>
          </div>
          <div className="md:col-span-2">
            <div className="rounded-xl bg-background ring-1 ring-border p-4 space-y-3 text-sm">
              <div className="flex items-start gap-2">
                <div className="size-7 rounded-full bg-secondary shrink-0" />
                <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2">
                  Are we still on for Sunday?
                </div>
              </div>
              <div className="flex items-start gap-2 justify-end">
                <div className="rounded-2xl rounded-tr-sm bg-success/15 text-foreground px-3 py-2 max-w-[80%]">
                  Yes — 2pm at the same place. I'll bring the photos from last time.
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 pt-1">
                <Sparkles className="size-3 text-accent" />
                Suggested by your twin · used: calendar, last chat
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Trust */}
      <section id="trust" className="px-6 py-20">
        <div className="mx-auto max-w-6xl grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-accent">
              Trust is the product
            </p>
            <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight text-balance">
              Approval before autonomy. Show your work.
            </h2>
            <p className="mt-4 text-base text-muted-foreground text-pretty max-w-[52ch]">
              Every action shows what context was used, what will change, and where the
              output will go. You're always the last filter — and undo is one click.
            </p>
            <ul className="mt-6 space-y-3 text-sm">
              {[
                "Cited sources on every draft",
                "Editable, deletable memory",
                "Reviewable actions across your apps",
                "Modes: Fast, Smart, Careful, Private",
              ].map((p) => (
                <li key={p} className="flex items-center gap-2.5">
                  <ShieldCheck className="size-4 text-success" />
                  {p}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl ring-1 ring-border bg-surface p-6 shadow-soft">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Principles
            </p>
            <div className="mt-4 space-y-4">
              {[
                ["Workflow before chat", "Chat exists, but isn't the structure."],
                ["Context beats prompting", "The less you explain, the better it gets."],
                ["Approval before autonomy", "Earn trust through reviewable drafts."],
                ["Reduce app-switching", "Review, draft, plan, approve in one place."],
                ["Memory is controllable", "Visible, editable, deletable."],
              ].map(([t, b]) => (
                <div key={t} className="flex gap-3">
                  <div className="mt-1.5 size-1.5 rounded-full bg-accent shrink-0" />
                  <div>
                    <p className="text-sm font-medium">{t}</p>
                    <p className="text-sm text-muted-foreground">{b}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 pb-24">
        <div className="mx-auto max-w-4xl rounded-2xl bg-primary text-primary-foreground p-10 md:p-14 text-center shadow-elevated">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight text-balance">
            Find. Nurture. Sustain.
          </h2>
          <p className="mt-3 text-base opacity-80 max-w-[48ch] mx-auto text-pretty">
            Step into the workspace and meet your cognitive companion.
          </p>
          <Link
            to="/workspace"
            className="mt-7 inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-semibold bg-background text-foreground hover:bg-secondary"
          >
            Open the workspace
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-border px-6 py-8">
        <div className="mx-auto max-w-6xl flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <div className="size-5 rounded bg-primary" />
            <span>NeuralConnexions</span>
          </div>
          <p>© {new Date().getFullYear()} NeuralConnexions. Find · Nurture · Sustain.</p>
        </div>
      </footer>
    </div>
  );
}

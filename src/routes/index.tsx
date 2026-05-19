import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Brain,
  Inbox,
  Moon,
  PenLine,
  Lock,
  Cpu,
  Cloud,
  Network,
  Users,
  Briefcase,
  Heart,
  GraduationCap,
  User,
  CheckCircle2,
  Eye,
  Trash2,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NeuralConnexions — Your cognitive companion. Local-first by design." },
      {
        name: "description",
        content:
          "An AI that reduces mental overload across the parts of your life — without shipping your inbox to a third-party LLM. Local-first, deterministic before stochastic, calm by design.",
      },
      { property: "og:title", content: "NeuralConnexions — Cognitive companion, local-first" },
      {
        property: "og:description",
        content:
          "Triage, memory, overnight research, and drafts in your voice. Email bodies never leave your device by default.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="size-7 rounded-lg bg-gradient-to-br from-primary to-primary-glow flex items-center justify-center">
              <Sparkles className="size-4 text-primary-foreground" />
            </div>
            <div className="leading-tight">
              <span className="font-display text-sm font-semibold tracking-tight block">
                NeuralConnexions
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-muted-foreground">
                cognitive · companion
              </span>
            </div>
          </Link>
          <div className="hidden md:flex items-center gap-7 text-sm text-muted-foreground">
            <a href="#what" className="hover:text-foreground transition-colors">What it does</a>
            <a href="#privacy" className="hover:text-foreground transition-colors">Privacy</a>
            <a href="#graph" className="hover:text-foreground transition-colors">Interest graph</a>
            <a href="#roadmap" className="hover:text-foreground transition-colors">Roadmap</a>
          </div>
          <Link
            to="/workspace"
            className="text-sm font-medium bg-gradient-to-r from-primary to-primary-glow text-primary-foreground px-3.5 py-1.5 rounded-md inline-flex items-center gap-1.5 hover:opacity-90 transition-opacity"
          >
            Open workspace
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <header className="relative px-6 pt-24 pb-24 overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(50% 50% at 20% 10%, oklch(0.55 0.22 290 / 0.35), transparent 60%), radial-gradient(45% 45% at 85% 30%, oklch(0.6 0.2 220 / 0.3), transparent 60%)",
          }}
        />
        <div className="mx-auto max-w-6xl">
          <span className="inline-flex items-center gap-2 rounded-full glass px-3 py-1 text-[11px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-success animate-pulse" />
            Phase 1 · Rules-based triage live
          </span>
          <h1 className="mt-6 font-display text-5xl md:text-7xl font-semibold tracking-tight text-balance max-w-[18ch] leading-[1.02]">
            Your cognitive companion.{" "}
            <span className="text-gradient">Local-first by design.</span>
          </h1>
          <p className="mt-7 text-lg md:text-xl text-muted-foreground max-w-[62ch] text-pretty">
            An AI that reduces the mental overhead of running a modern life —
            email, calendar, research, the people you owe a reply to — without
            shipping your inbox to a third-party LLM.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              to="/workspace"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-semibold bg-gradient-to-r from-primary to-primary-glow text-primary-foreground hover:opacity-90 transition-opacity ring-glow"
            >
              Open the workspace
              <ArrowRight className="size-4" />
            </Link>
            <Link
              to="/workspace/privacy"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-medium glass hover:bg-secondary transition-colors"
            >
              <ShieldCheck className="size-4 text-success" />
              How privacy works
            </Link>
          </div>
          <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Augments human judgment · Never auto-sends · One-tap consent
          </p>
        </div>
      </header>

      {/* The overload problem */}
      <section className="px-6 py-20 border-t border-border">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            The problem
          </p>
          <h2 className="mt-3 font-display text-3xl md:text-5xl font-semibold tracking-tight text-balance max-w-[22ch]">
            Modern life leaks across <span className="text-gradient">a dozen apps.</span>
          </h2>
          <div className="mt-12 grid md:grid-cols-3 gap-5">
            {[
              {
                stat: "12+",
                title: "Apps per day",
                body: "Inbox, calendar, docs, chats, notes, reminders. The thread between them is you — and it breaks.",
              },
              {
                stat: "47%",
                title: "Working-memory overflow",
                body: "The promises, follow-ups, and small commitments you mean to keep but quietly drop.",
              },
              {
                stat: "0",
                title: "Assistants you actually trust",
                body: "Existing copilots either leak your data to someone else's model, or stay siloed inside one app.",
              },
            ].map((c) => (
              <div key={c.title} className="glass rounded-2xl p-6">
                <p className="font-display text-4xl font-semibold text-gradient">{c.stat}</p>
                <h3 className="mt-3 text-base font-semibold">{c.title}</h3>
                <p className="text-sm text-muted-foreground mt-2 text-pretty">{c.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What it does */}
      <section id="what" className="px-6 py-24 border-t border-border">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            What it does
          </p>
          <h2 className="mt-3 font-display text-3xl md:text-5xl font-semibold tracking-tight text-balance max-w-[24ch]">
            Four jobs. Done quietly, in the background.
          </h2>
          <div className="mt-14 grid md:grid-cols-2 gap-5">
            {[
              {
                icon: Inbox,
                eyebrow: "Triage",
                title: "5–10 things, not 500",
                body: "A morning shortlist of what actually needs you — drawn from email, calendar, and open promises. The rest stays out of the way.",
              },
              {
                icon: Network,
                eyebrow: "Memory graph",
                title: "Cross-domain context",
                body: "People, projects, commitments, preferences — connected as a graph you can see, edit, and forget. Not buried in a vector database.",
              },
              {
                icon: Moon,
                eyebrow: "Overnight agent",
                title: "Deep research while you sleep",
                body: "Long-running tasks — research a vendor, draft a brief, prep a meeting — finished by morning, ready for one-tap approval.",
              },
              {
                icon: PenLine,
                eyebrow: "Voice-aware drafts",
                title: "Drafts in your voice, not the model's",
                body: "Replies that sound like you, built from a local voice profile. You review, you send. Never auto-fired.",
              },
            ].map((c) => (
              <div key={c.title} className="glass-elevated rounded-2xl p-6 md:p-7 group hover:ring-1 hover:ring-primary/30 transition-all">
                <div className="flex items-start gap-4">
                  <div className="size-11 rounded-xl bg-gradient-to-br from-primary/20 to-primary-glow/20 ring-1 ring-primary/30 inline-flex items-center justify-center shrink-0">
                    <c.icon className="size-5 text-primary-glow" />
                  </div>
                  <div>
                    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                      {c.eyebrow}
                    </p>
                    <h3 className="mt-1 font-display text-lg font-semibold">{c.title}</h3>
                    <p className="text-sm text-muted-foreground mt-2 text-pretty">{c.body}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy — load-bearing */}
      <section id="privacy" className="relative px-6 py-24 border-t border-border overflow-hidden">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 opacity-60"
          style={{
            background:
              "radial-gradient(40% 60% at 50% 0%, oklch(0.55 0.22 290 / 0.25), transparent 70%)",
          }}
        />
        <div className="mx-auto max-w-6xl">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-success" />
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-success">
              Privacy & safety
            </p>
          </div>
          <h2 className="mt-3 font-display text-3xl md:text-5xl font-semibold tracking-tight text-balance max-w-[26ch]">
            Email bodies never leave your device. <span className="text-gradient">By default.</span>
          </h2>
          <p className="mt-5 text-lg text-muted-foreground max-w-[58ch] text-pretty">
            Every message gets classified through a four-layer pipeline. Stricter
            layers run first; the cloud is the last resort, not the default — and
            only with your explicit consent.
          </p>

          {/* Pipeline */}
          <div className="mt-12 grid md:grid-cols-3 gap-4">
            {[
              {
                tier: "Layer 1",
                icon: Lock,
                title: "Deterministic rules",
                body: "Sender, subject patterns, header signals. Fast, auditable, runs entirely on-device. Catches ~70% with zero ambiguity.",
                tone: "success",
              },
              {
                tier: "Layer 2",
                icon: Cpu,
                title: "On-device LLM",
                body: "Apple Foundation Models / Gemini Nano / WebLLM. Handles the ambiguous middle without ever opening a network connection.",
                tone: "primary",
              },
              {
                tier: "Layer 3 · opt-in",
                icon: Cloud,
                title: "Cloud LLM, on rails",
                body: "Only when you allow it, only what's needed. Identifiers are banned by schema. Every decision is logged with classified_by.",
                tone: "muted",
              },
            ].map((l) => (
              <div key={l.title} className="glass rounded-2xl p-6 relative">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  {l.tier}
                </p>
                <div className="mt-3 flex items-center gap-3">
                  <l.icon className={`size-5 ${l.tone === "success" ? "text-success" : l.tone === "primary" ? "text-primary-glow" : "text-muted-foreground"}`} />
                  <h3 className="font-display text-lg font-semibold">{l.title}</h3>
                </div>
                <p className="text-sm text-muted-foreground mt-3 text-pretty">{l.body}</p>
              </div>
            ))}
          </div>

          {/* Guarantees */}
          <div className="mt-8 glass-elevated rounded-2xl p-6 md:p-8">
            <div className="grid md:grid-cols-2 gap-x-8 gap-y-4 text-sm">
              {[
                { icon: Eye, label: "Audit trail", body: "Every personalization decision shows what data was used." },
                { icon: Trash2, label: "Right to forget", body: "One tap removes any trait, any memory, from any decision." },
                { icon: ShieldCheck, label: "Fail-closed", body: "Private mode has no silent fallback. If on-device fails, nothing leaks." },
                { icon: CheckCircle2, label: "Identifiers banned", body: "Names, emails, phone numbers can't enter the trait sheet — by schema, not by promise." },
              ].map((g) => (
                <div key={g.label} className="flex items-start gap-3">
                  <g.icon className="size-4 text-success mt-0.5 shrink-0" />
                  <div>
                    <span className="font-semibold">{g.label}.</span>{" "}
                    <span className="text-muted-foreground">{g.body}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Five domains */}
      <section className="px-6 py-24 border-t border-border">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            Where it helps
          </p>
          <h2 className="mt-3 font-display text-3xl md:text-5xl font-semibold tracking-tight text-balance max-w-[22ch]">
            One companion. <span className="text-gradient">Five domains of your life.</span>
          </h2>
          <div className="mt-12 grid md:grid-cols-3 gap-4">
            {[
              { icon: Briefcase, title: "Professional", body: "Inbox triage, meeting prep, follow-ups that don't slip.", span: "md:col-span-2" },
              { icon: Users, title: "Family", body: "Logistics, commitments, the small things that hold a household.", span: "" },
              { icon: Heart, title: "Social", body: "The friend you've been meaning to text for three weeks.", span: "" },
              { icon: GraduationCap, title: "Learning", body: "Capture-once notes that surface again when they're useful.", span: "" },
              { icon: User, title: "Personal", body: "Health appointments, renewals, the quiet maintenance of a life.", span: "" },
            ].map((d) => (
              <div key={d.title} className={`glass rounded-2xl p-6 ${d.span}`}>
                <d.icon className="size-5 text-primary-glow" />
                <h3 className="mt-4 font-display text-lg font-semibold">{d.title}</h3>
                <p className="text-sm text-muted-foreground mt-2 text-pretty">{d.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Personal interest graph */}
      <section id="graph" className="px-6 py-24 border-t border-border">
        <div className="mx-auto max-w-6xl grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
              On the horizon
            </p>
            <h2 className="mt-3 font-display text-3xl md:text-5xl font-semibold tracking-tight text-balance">
              A <span className="text-gradient">personal interest graph</span> that grows with you.
            </h2>
            <p className="mt-5 text-lg text-muted-foreground text-pretty">
              The memory graph already knows what matters to you — projects, topics,
              the threads you keep returning to. It stays private on your device by default.
            </p>
            <p className="mt-4 text-base text-muted-foreground text-pretty">
              When it converges — and only if you opt in — you can publish a slice
              of it to find others whose graphs resonate with yours. An evolving,
              interest-based network that grows from real signal, not from
              follower counts.
            </p>
            <ul className="mt-7 space-y-3 text-sm">
              {[
                "Opt-in per slice — share research interests, keep family private.",
                "Matches on signal, not bios — what you actually engage with.",
                "Forget any node, any match, any time. The graph is yours.",
                "No public-by-default. Ever.",
              ].map((p) => (
                <li key={p} className="flex items-start gap-2.5">
                  <CheckCircle2 className="size-4 text-success mt-0.5 shrink-0" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="glass-elevated rounded-2xl p-8 relative overflow-hidden">
            <div
              aria-hidden
              className="absolute inset-0 opacity-50"
              style={{
                background:
                  "radial-gradient(40% 50% at 50% 50%, oklch(0.7 0.2 290 / 0.25), transparent 70%)",
              }}
            />
            <div className="relative">
              <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                Your graph · preview
              </p>
              <div className="mt-6 relative h-64">
                {/* Simple graph viz */}
                <svg viewBox="0 0 300 240" className="absolute inset-0 size-full">
                  <defs>
                    <radialGradient id="node" cx="50%" cy="50%">
                      <stop offset="0%" stopColor="oklch(0.78 0.18 220)" stopOpacity="0.9" />
                      <stop offset="100%" stopColor="oklch(0.55 0.22 290)" stopOpacity="0.4" />
                    </radialGradient>
                  </defs>
                  <g stroke="oklch(0.7 0.2 290 / 0.3)" strokeWidth="1">
                    <line x1="150" y1="120" x2="60" y2="50" />
                    <line x1="150" y1="120" x2="240" y2="60" />
                    <line x1="150" y1="120" x2="80" y2="200" />
                    <line x1="150" y1="120" x2="230" y2="190" />
                    <line x1="150" y1="120" x2="40" y2="140" />
                    <line x1="60" y1="50" x2="240" y2="60" strokeDasharray="2 3" opacity="0.5" />
                    <line x1="80" y1="200" x2="230" y2="190" strokeDasharray="2 3" opacity="0.5" />
                  </g>
                  <g>
                    {[
                      { cx: 150, cy: 120, r: 18, label: "you" },
                      { cx: 60, cy: 50, r: 10, label: "ml" },
                      { cx: 240, cy: 60, r: 12, label: "design" },
                      { cx: 80, cy: 200, r: 9, label: "cycling" },
                      { cx: 230, cy: 190, r: 11, label: "privacy" },
                      { cx: 40, cy: 140, r: 8, label: "jazz" },
                    ].map((n) => (
                      <g key={n.label}>
                        <circle cx={n.cx} cy={n.cy} r={n.r} fill="url(#node)" />
                        <text
                          x={n.cx}
                          y={n.cy + n.r + 12}
                          textAnchor="middle"
                          className="fill-muted-foreground"
                          style={{ font: '500 9px ui-monospace, monospace', letterSpacing: '0.1em', textTransform: 'uppercase' }}
                        >
                          {n.label}
                        </text>
                      </g>
                    ))}
                  </g>
                </svg>
              </div>
              <div className="mt-4 flex items-center justify-between rounded-lg glass px-3 py-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  Public slice
                </span>
                <span className="text-xs font-semibold text-muted-foreground">Off</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Principles */}
      <section className="px-6 py-20 border-t border-border">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            Principles
          </p>
          <div className="mt-8 grid md:grid-cols-5 gap-3">
            {[
              "Local-first",
              "Deterministic before stochastic",
              "Calm interface",
              "One-tap consent",
              "Cross-domain memory",
            ].map((p) => (
              <div key={p} className="glass rounded-xl p-4">
                <p className="font-display text-sm font-semibold text-balance">{p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Roadmap */}
      <section id="roadmap" className="px-6 py-24 border-t border-border">
        <div className="mx-auto max-w-6xl">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">
            Roadmap
          </p>
          <h2 className="mt-3 font-display text-3xl md:text-5xl font-semibold tracking-tight text-balance max-w-[20ch]">
            Shipped, then promised. <span className="text-gradient">No vapor.</span>
          </h2>
          <div className="mt-12 space-y-3">
            {[
              { phase: "Phase 1", status: "Live", title: "Rules-based triage", body: "Deterministic categorizer, on-device. No external LLM in the loop.", done: true },
              { phase: "Phase 2", status: "In build", title: "On-device LLM", body: "Apple Foundation Models, Gemini Nano, WebLLM — selected per device.", done: false },
              { phase: "Phase 3", status: "Next", title: "Overnight research agent", body: "Long-running tasks, finished by morning, one-tap approval.", done: false },
              { phase: "Phase 4", status: "Later", title: "Native shell", body: "Capacitor wrapper for iOS + Android with share extensions and push.", done: false },
              { phase: "Phase 5", status: "Later", title: "Public interest graph (opt-in)", body: "Match on signal, not bios. Slice-by-slice consent.", done: false },
            ].map((r) => (
              <div key={r.phase} className="glass rounded-xl p-5 flex items-start gap-5">
                <div className="shrink-0 w-24">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {r.phase}
                  </p>
                  <p className={`font-mono text-[10px] uppercase tracking-[0.2em] mt-1 ${r.done ? "text-success" : "text-muted-foreground"}`}>
                    {r.status}
                  </p>
                </div>
                <div className="flex-1">
                  <h3 className="font-display text-base font-semibold flex items-center gap-2">
                    {r.done && <CheckCircle2 className="size-4 text-success" />}
                    {r.title}
                  </h3>
                  <p className="text-sm text-muted-foreground mt-1 text-pretty">{r.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA + footer */}
      <section className="px-6 py-24 border-t border-border">
        <div className="mx-auto max-w-4xl text-center">
          <Brain className="size-8 text-primary-glow mx-auto" />
          <h2 className="mt-6 font-display text-3xl md:text-5xl font-semibold tracking-tight text-balance">
            Less in your head. <span className="text-gradient">More in your life.</span>
          </h2>
          <p className="mt-5 text-lg text-muted-foreground max-w-[52ch] mx-auto text-pretty">
            Open the workspace and start with one of your inboxes. Nothing leaves
            your device until you say so.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/workspace"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-semibold bg-gradient-to-r from-primary to-primary-glow text-primary-foreground hover:opacity-90 transition-opacity ring-glow"
            >
              Open the workspace
              <ArrowRight className="size-4" />
            </Link>
            <Link
              to="/workspace/personalization"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-medium glass hover:bg-secondary transition-colors"
            >
              Personalization controls
            </Link>
          </div>
        </div>
      </section>

      <footer className="px-6 py-10 border-t border-border">
        <div className="mx-auto max-w-6xl flex flex-wrap items-center justify-between gap-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            NeuralConnexions · cognitive companion
          </p>
          <div className="flex items-center gap-6 text-xs text-muted-foreground">
            <Link to="/workspace/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link to="/workspace/personalization" className="hover:text-foreground transition-colors">
              Personalization
            </Link>
            <Link to="/workspace" className="hover:text-foreground transition-colors">
              Workspace
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

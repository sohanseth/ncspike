import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  Handle,
  Position,
  BackgroundVariant,
} from "@xyflow/react";
import {
  Trash2,
  Pencil,
  AlertTriangle,
  Network,
  List as ListIcon,
  Users,
  Briefcase,
  Settings2,
  CalendarClock,
  PenLine,
  Repeat,
  Ban,
  X,
  ShieldCheck,
  Search,
  Sparkles,
  TrendingUp,
  Lightbulb,
  ArrowUpRight,
  Plus,
  Clock,
  Eye,
  EyeOff,
} from "lucide-react";

export const Route = createFileRoute("/workspace/memory")({
  head: () => ({
    meta: [
      { title: "Memory — NeuralConnexions" },
      {
        name: "description",
        content:
          "Memory, connections, signals and insights — see the patterns becoming meaningful before you fully notice them.",
      },
    ],
  }),
  component: MemoryPage,
});

/* ─────────────── Types & data ─────────────── */

type Category =
  | "people"
  | "projects"
  | "preferences"
  | "deadlines"
  | "writing"
  | "recurring"
  | "ignored";

type Confidence = "high" | "medium" | "low";

type Relation = { id: string; label: string };

type MemItem = {
  id: string;
  category: Category;
  short: string;        // short label for graph nodes
  belief: string;       // full sentence for list & panel
  source: string;
  usedIn: number;
  lastUsed: string;
  confidence: Confidence;
  inferred?: boolean;   // AI-inferred vs user-confirmed
  recent?: boolean;     // used in today's brief
  rejected?: boolean;   // user-corrected
  relations?: Relation[];
};

type Branch = {
  id: string;
  title: string;
  summary: string;
  why: string;
  momentum: "rising" | "steady" | "consolidating";
  confidence: Confidence;
  weeks: number;
  evidence: { kind: string; count: number; label: string }[];
  related: string[]; // memItem ids
  domains: string[]; // e.g. work, hobby, research
  suggestion: string;
};

type Insight = {
  id: string;
  title: string;
  body: string;
  branches: string[]; // branch ids
  confidence: Confidence;
  rationale: string[];
};

const CATEGORIES: {
  id: Category;
  label: string;
  icon: typeof Users;
}[] = [
  { id: "people", label: "People", icon: Users },
  { id: "projects", label: "Projects", icon: Briefcase },
  { id: "preferences", label: "Preferences", icon: Settings2 },
  { id: "deadlines", label: "Deadlines", icon: CalendarClock },
  { id: "writing", label: "Writing style", icon: PenLine },
  { id: "recurring", label: "Recurring", icon: Repeat },
  { id: "ignored", label: "Ignored", icon: Ban },
];

const items: MemItem[] = [
  { id: "m1", category: "people", short: "Sarah Chen", belief: "Sarah Chen is your biology project partner.", source: "Shared WhatsApp · Mar 2", usedIn: 2, lastUsed: "Used 2 days ago", confidence: "high", recent: true, relations: [{ id: "m4", label: "works on" }, { id: "m8", label: "due for" }] },
  { id: "m2", category: "people", short: "Marcus Lee", belief: "Marcus Lee is an onboarding client (active).", source: "Gmail thread · Apr 18", usedIn: 5, lastUsed: "Used yesterday", confidence: "high", relations: [{ id: "m10", label: "meets with" }, { id: "m4", label: "related to" }] },
  { id: "m3", category: "people", short: "Mark & Priya", belief: "Mark and Priya are leadership; recurring 1:1s.", source: "Calendar pattern (8w)", usedIn: 11, lastUsed: "Used today", confidence: "medium", inferred: true, recent: true },
  { id: "m4", category: "projects", short: "Q3 Launch", belief: "Q3 Launch (Alpha) is your top-priority project.", source: "Pinned · 12 docs · 47 emails", usedIn: 14, lastUsed: "Used today", confidence: "high", recent: true, relations: [{ id: "m1", label: "works on" }, { id: "m8", label: "due for" }] },
  { id: "m5", category: "projects", short: "EU Expansion", belief: "EU Expansion is in early planning.", source: "Notion · updated Mon", usedIn: 3, lastUsed: "Used 4 days ago", confidence: "medium", inferred: true },
  { id: "m6", category: "preferences", short: "No meetings before 10am", belief: "Mornings reserved for deep work (no meetings before 10am).", source: "Calendar + your rule", usedIn: 22, lastUsed: "Used today", confidence: "high", recent: true },
  { id: "m7", category: "preferences", short: "No Friday afternoons", belief: "No Friday afternoon meetings.", source: "You set this · Apr 1", usedIn: 6, lastUsed: "Used last Fri", confidence: "high" },
  { id: "m8", category: "deadlines", short: "Roadmap due Wed", belief: "Q2 roadmap due to Jamie by Wednesday.", source: "Email from Jamie · Apr 30", usedIn: 4, lastUsed: "Used today", confidence: "high", recent: true },
  { id: "m9", category: "writing", short: "Warm reply tone", belief: "You write replies in a clear, warm tone — short paragraphs.", source: "Learned from 240 sent emails", usedIn: 38, lastUsed: "Used today", confidence: "high", inferred: true, recent: true },
  { id: "m10", category: "recurring", short: "1:1 Marcus · Tue 2pm", belief: "Weekly 1:1 with Marcus, Tuesdays 2pm.", source: "Calendar series", usedIn: 9, lastUsed: "Used last Tue", confidence: "high" },
  { id: "m11", category: "ignored", short: "No auto-send to Sarah", belief: "(Rejected) Auto-send replies to Sarah.", source: "You corrected · Apr 22", usedIn: 0, lastUsed: "Never re-applied", confidence: "high", rejected: true, relations: [{ id: "m1", label: "corrected by user" }] },
];

const branches: Branch[] = [
  {
    id: "b1",
    title: "AI travel coordination",
    summary:
      "Repeated interest in AI-assisted itinerary tools, group travel pain, and workflow automation.",
    why: "Has appeared across 9 searches, 3 notes, and 2 conversations over 5 weeks. Now connecting your hobby and work domains.",
    momentum: "consolidating",
    confidence: "high",
    weeks: 5,
    evidence: [
      { kind: "search", count: 9, label: "Search items about itinerary tools" },
      { kind: "note", count: 3, label: "Notes about product ideas" },
      { kind: "message", count: 2, label: "Messages about coordinating with friends" },
      { kind: "bookmark", count: 4, label: "Saved articles" },
    ],
    related: ["m4", "m6"],
    domains: ["hobby", "work", "research"],
    suggestion: "Promote to a project branch and draft a one-page concept note.",
  },
  {
    id: "b2",
    title: "Mid-market sales motion",
    summary:
      "Conversations and docs increasingly mention mid-market positioning, pricing tiers and onboarding.",
    why: "Connects Q3 Launch, Marcus's onboarding work, and recent EU planning notes.",
    momentum: "rising",
    confidence: "medium",
    weeks: 3,
    evidence: [
      { kind: "doc", count: 6, label: "Docs referencing mid-market" },
      { kind: "message", count: 11, label: "Slack threads with leadership" },
      { kind: "calendar", count: 4, label: "Meetings with Marcus" },
    ],
    related: ["m2", "m4", "m5"],
    domains: ["work"],
    suggestion: "Bundle into a 'Mid-market' workstream under Q3 Launch.",
  },
  {
    id: "b3",
    title: "Design systems × AI workflows",
    summary:
      "Hobby reading on design systems is increasingly intersecting with your work on AI workflow tools.",
    why: "Crosses personal hobby and professional domains — a frequent precursor to durable interests.",
    momentum: "steady",
    confidence: "medium",
    weeks: 8,
    evidence: [
      { kind: "bookmark", count: 12, label: "Design system articles" },
      { kind: "note", count: 4, label: "Notes mixing both topics" },
    ],
    related: ["m9"],
    domains: ["hobby", "work"],
    suggestion: "Watch this branch — open a scratch note to capture future links.",
  },
];

const insights: Insight[] = [
  {
    id: "i1",
    title: "You may be converging on an AI travel-planning interest.",
    body: "Three independent threads — searches, notes, and friend conversations — are pointing at the same unresolved problem. This pattern has persisted for over a month and is expanding.",
    branches: ["b1"],
    confidence: "high",
    rationale: [
      "9 search items about itinerary tools",
      "3 notes about product ideas",
      "2 conversations about group-travel friction",
      "Topic recurred over 28 days",
    ],
  },
  {
    id: "i2",
    title: "Your hobby and work may be combining into a product direction.",
    body: "Reading on design systems and your work on AI workflows are starting to overlap. Cross-domain branches like this often grow into durable projects.",
    branches: ["b3"],
    confidence: "medium",
    rationale: [
      "Hobby + work domains overlap",
      "12 bookmarks + 4 cross-topic notes",
      "8 weeks of steady recurrence",
    ],
  },
];

const confidenceStyle: Record<Confidence, { label: string; cls: string }> = {
  high: { label: "High", cls: "bg-success/15 text-success ring-success/30" },
  medium: { label: "Medium", cls: "bg-warning/15 text-warning ring-warning/30" },
  low: { label: "Low", cls: "bg-destructive/15 text-destructive ring-destructive/30" },
};

const categoryStyle: Record<Category, string> = {
  people: "from-warning to-accent",
  projects: "from-primary to-primary-glow",
  preferences: "from-success to-accent",
  deadlines: "from-destructive to-warning",
  writing: "from-accent to-primary-glow",
  recurring: "from-primary to-accent",
  ignored: "from-muted-foreground to-muted-foreground",
};

const momentumStyle: Record<Branch["momentum"], { label: string; cls: string }> = {
  rising: { label: "Rising", cls: "text-accent" },
  steady: { label: "Steady", cls: "text-muted-foreground" },
  consolidating: { label: "Consolidating", cls: "text-primary" },
};

/* ─────────────── Page ─────────────── */

type Tab = "list" | "graph" | "signals" | "insights";

function MemoryPage() {
  const [tab, setTab] = useState<Tab>("list");
  const [activeCat, setActiveCat] = useState<Category | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const cat of CATEGORIES) c[cat.id] = items.filter((i) => i.category === cat.id).length;
    return c;
  }, []);

  const filtered = items.filter(
    (i) =>
      (activeCat === "all" || i.category === activeCat) &&
      (query === "" || i.belief.toLowerCase().includes(query.toLowerCase())),
  );

  const selected = items.find((i) => i.id === selectedId);
  const branch = branches.find((b) => b.id === selectedBranch);

  return (
    <div className="flex-1 flex min-h-0">
      {/* Category rail (only shown for List/Graph) */}
      {(tab === "list" || tab === "graph") && (
        <aside className="w-[240px] shrink-0 border-r border-border flex flex-col">
          <div className="px-5 pt-6 pb-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
              Trust layer
            </p>
            <h1 className="text-lg font-display font-semibold tracking-tight mt-0.5">Memory</h1>
            <p className="text-[11px] text-muted-foreground mt-1">
              Editable beliefs, sources, confidence.
            </p>
          </div>
          <nav className="px-2 pb-3 space-y-0.5">
            <CatRow
              active={activeCat === "all"}
              label="All memories"
              count={counts.all}
              onClick={() => setActiveCat("all")}
              icon={ShieldCheck}
            />
            {CATEGORIES.map((c) => (
              <CatRow
                key={c.id}
                active={activeCat === c.id}
                label={c.label}
                count={counts[c.id] ?? 0}
                onClick={() => setActiveCat(c.id)}
                icon={c.icon}
              />
            ))}
          </nav>
        </aside>
      )}

      {/* Main pane */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Tabs + toolbar */}
        <div className="px-8 pt-6 pb-4 flex items-center gap-3 flex-wrap">
          {tab === "signals" || tab === "insights" ? (
            <div className="mr-auto">
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
                {tab === "signals" ? "Pattern detection" : "AI interpretation"}
              </p>
              <h1 className="text-lg font-display font-semibold tracking-tight mt-0.5">
                {tab === "signals" ? "Emerging branches" : "Insights you may be missing"}
              </h1>
            </div>
          ) : (
            <div className="flex-1 max-w-md flex items-center gap-2 px-3 h-9 rounded-lg glass">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search memories…"
                className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}

          <div className="inline-flex items-center gap-0.5 glass rounded-lg p-1">
            <TabBtn id="list" tab={tab} setTab={setTab} icon={ListIcon} label="List" />
            <TabBtn id="graph" tab={tab} setTab={setTab} icon={Network} label="Graph" />
            <TabBtn id="signals" tab={tab} setTab={setTab} icon={TrendingUp} label="Signals" badge={branches.length} />
            <TabBtn id="insights" tab={tab} setTab={setTab} icon={Lightbulb} label="Insights" badge={insights.length} />
          </div>
        </div>

        {tab === "list" && (
          <div className="flex-1 overflow-y-auto px-8 pb-10">
            <div className="max-w-3xl mx-auto space-y-2.5">
              {filtered.length === 0 && (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No memories in this category yet.
                </p>
              )}
              {filtered.map((it) => (
                <MemoryCard
                  key={it.id}
                  item={it}
                  onSelect={() => setSelectedId(it.id)}
                  selected={selectedId === it.id}
                />
              ))}
            </div>
          </div>
        )}

        {tab === "graph" && (
          <GraphView
            filterCat={activeCat}
            onSelect={(id) => setSelectedId(id)}
            selectedId={selectedId}
            onJumpToList={() => setTab("list")}
          />
        )}

        {tab === "signals" && (
          <div className="flex-1 overflow-y-auto px-8 pb-10">
            <div className="max-w-3xl mx-auto space-y-3">
              <p className="text-xs text-muted-foreground mb-2">
                Themes recurring across your searches, notes, messages and calendar — surfaced before they're obvious.
              </p>
              {branches.map((b) => (
                <BranchCard key={b.id} branch={b} onOpen={() => setSelectedBranch(b.id)} selected={selectedBranch === b.id} />
              ))}
            </div>
          </div>
        )}

        {tab === "insights" && (
          <div className="flex-1 overflow-y-auto px-8 pb-10">
            <div className="max-w-3xl mx-auto space-y-3">
              <p className="text-xs text-muted-foreground mb-2">
                Higher-order suggestions drawn from how branches are connecting. Every insight is traceable.
              </p>
              {insights.map((ins) => (
                <InsightCard
                  key={ins.id}
                  insight={ins}
                  onOpenBranch={(id) => {
                    setTab("signals");
                    setSelectedBranch(id);
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Side panels */}
      {selected && tab !== "signals" && tab !== "insights" && (
        <SidePanel item={selected} onClose={() => setSelectedId(null)} />
      )}
      {branch && (tab === "signals" || tab === "insights") && (
        <BranchPanel branch={branch} onClose={() => setSelectedBranch(null)} />
      )}
    </div>
  );
}

/* ─────────────── Shared bits ─────────────── */

function TabBtn({
  id,
  tab,
  setTab,
  icon: Icon,
  label,
  badge,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  icon: typeof ListIcon;
  label: string;
  badge?: number;
}) {
  const active = tab === id;
  return (
    <button
      onClick={() => setTab(id)}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
        active
          ? "bg-primary/15 text-primary ring-1 ring-primary/25"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="size-3.5" /> {label}
      {badge !== undefined && (
        <span className={`text-[10px] font-mono px-1 rounded ${active ? "bg-primary/20" : "bg-white/5"}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

function CatRow({
  active,
  label,
  count,
  onClick,
  icon: Icon,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  icon: typeof Users;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
        active
          ? "bg-primary/10 text-foreground ring-1 ring-primary/25"
          : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
      }`}
    >
      <Icon className={`size-4 ${active ? "text-primary" : ""}`} />
      <span className="flex-1 text-left">{label}</span>
      <span className="text-[10px] font-mono tabular-nums text-muted-foreground">{count}</span>
    </button>
  );
}

function MemoryCard({
  item,
  onSelect,
  selected,
}: {
  item: MemItem;
  onSelect: () => void;
  selected: boolean;
}) {
  const conf = confidenceStyle[item.confidence];
  return (
    <div
      onClick={onSelect}
      className={`rounded-xl glass p-4 cursor-pointer transition-all ${
        selected ? "ring-2 ring-primary/40" : "hover:ring-1 hover:ring-primary/20"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`size-8 rounded-lg bg-gradient-to-br ${categoryStyle[item.category]} ring-1 ring-white/10 shrink-0 mt-0.5`} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-pretty">{item.belief}</p>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            <span className="font-mono">Source:</span> {item.source}
            {item.usedIn > 0 && (
              <>
                <span className="opacity-50 mx-1">·</span>
                Used in {item.usedIn} brief{item.usedIn === 1 ? "" : "s"}
              </>
            )}
          </p>
          <div className="flex items-center gap-2 mt-2.5">
            <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${conf.cls}`}>
              Confidence: {conf.label}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">{item.lastUsed}</span>
          </div>
          <div className="flex items-center gap-1 mt-3 -ml-1">
            <ActionBtn icon={Pencil} label="Edit" />
            <ActionBtn icon={AlertTriangle} label="Mark wrong" tone="warning" />
            <ActionBtn icon={Trash2} label="Delete" tone="destructive" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionBtn({
  icon: Icon,
  label,
  tone,
}: {
  icon: typeof Pencil;
  label: string;
  tone?: "warning" | "destructive";
}) {
  const cls =
    tone === "destructive"
      ? "hover:bg-destructive/15 hover:text-destructive"
      : tone === "warning"
        ? "hover:bg-warning/15 hover:text-warning"
        : "hover:bg-white/5 hover:text-foreground";
  return (
    <button
      onClick={(e) => e.stopPropagation()}
      className={`inline-flex items-center gap-1 px-2 h-7 rounded-md text-[11px] font-medium text-muted-foreground transition-colors ${cls}`}
    >
      <Icon className="size-3" /> {label}
    </button>
  );
}

/* ─────────────── Branch (Signals) ─────────────── */

function BranchCard({
  branch,
  onOpen,
  selected,
}: {
  branch: Branch;
  onOpen: () => void;
  selected: boolean;
}) {
  const m = momentumStyle[branch.momentum];
  const conf = confidenceStyle[branch.confidence];
  return (
    <div
      onClick={onOpen}
      className={`rounded-2xl glass-elevated p-5 cursor-pointer transition-all ${
        selected ? "ring-2 ring-primary/40" : "hover:ring-1 hover:ring-primary/20"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-xl bg-gradient-to-br from-primary to-accent ring-1 ring-white/10 shrink-0 inline-flex items-center justify-center">
          <Sparkles className="size-4 text-primary-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-display font-semibold tracking-tight">{branch.title}</h3>
            <span className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider ${m.cls}`}>
              <TrendingUp className="size-3" /> {m.label}
            </span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ring-1 ${conf.cls}`}>
              {conf.label} confidence
            </span>
          </div>
          <p className="text-sm text-foreground/85 mt-1.5 leading-snug text-pretty">{branch.summary}</p>

          <div className="flex flex-wrap gap-1.5 mt-3">
            {branch.evidence.map((e) => (
              <span
                key={e.kind}
                className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 ring-1 ring-white/10 text-muted-foreground"
              >
                {e.count} {e.kind}
              </span>
            ))}
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 ring-1 ring-white/10 text-muted-foreground inline-flex items-center gap-1">
              <Clock className="size-3" /> {branch.weeks}w
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5 mt-2">
            {branch.domains.map((d) => (
              <span key={d} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent ring-1 ring-accent/20">
                {d}
              </span>
            ))}
          </div>
        </div>
        <ArrowUpRight className="size-4 text-muted-foreground shrink-0" />
      </div>
    </div>
  );
}

function BranchPanel({ branch, onClose }: { branch: Branch; onClose: () => void }) {
  const conf = confidenceStyle[branch.confidence];
  const m = momentumStyle[branch.momentum];
  const related = branch.related
    .map((id) => items.find((i) => i.id === id))
    .filter(Boolean) as MemItem[];
  return (
    <aside className="w-[360px] shrink-0 border-l border-border bg-background/40 backdrop-blur-xl flex flex-col overflow-y-auto">
      <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            Emerging branch
          </p>
          <h3 className="text-base font-display font-semibold mt-1 leading-snug">{branch.title}</h3>
        </div>
        <button
          onClick={onClose}
          className="size-7 rounded-md hover:bg-white/5 inline-flex items-center justify-center text-muted-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="px-5 space-y-4 text-sm pb-4">
        <p className="text-foreground/85 leading-relaxed text-pretty">{branch.summary}</p>

        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider ${m.cls}`}>
            <TrendingUp className="size-3" /> {m.label}
          </span>
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ring-1 ${conf.cls}`}>
            {conf.label} confidence
          </span>
          <span className="text-[10px] font-mono text-muted-foreground inline-flex items-center gap-1">
            <Clock className="size-3" /> {branch.weeks} weeks
          </span>
        </div>

        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
            Why this matters
          </p>
          <p className="text-xs text-foreground/80 leading-relaxed">{branch.why}</p>
        </div>

        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
            Evidence
          </p>
          <ul className="space-y-1.5">
            {branch.evidence.map((e) => (
              <li key={e.kind} className="text-xs text-foreground/85 rounded-md glass px-2.5 py-1.5 flex items-center justify-between">
                <span>{e.label}</span>
                <span className="font-mono text-muted-foreground">{e.count}</span>
              </li>
            ))}
          </ul>
        </div>

        {related.length > 0 && (
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Related memories
            </p>
            <ul className="space-y-1.5">
              {related.map((r) => (
                <li key={r.id} className="text-xs text-muted-foreground rounded-md glass px-2.5 py-1.5">
                  {r.belief}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
            Suggested next step
          </p>
          <p className="text-xs text-foreground/85 leading-relaxed">{branch.suggestion}</p>
        </div>
      </div>

      <div className="mt-auto p-4 border-t border-border space-y-2">
        <button className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-gradient-to-r from-primary to-primary-glow text-primary-foreground text-xs font-semibold ring-1 ring-white/10">
          <Plus className="size-3.5" /> Save as project
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button className="inline-flex items-center justify-center gap-1.5 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium ring-1 ring-white/10">
            <Eye className="size-3.5" /> Watch
          </button>
          <button className="inline-flex items-center justify-center gap-1.5 h-8 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium ring-1 ring-white/10 text-muted-foreground">
            <EyeOff className="size-3.5" /> Dismiss
          </button>
        </div>
        <button className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-lg bg-warning/10 hover:bg-warning/20 text-warning text-xs font-medium ring-1 ring-warning/20">
          <AlertTriangle className="size-3.5" /> Wrong pattern
        </button>
      </div>
    </aside>
  );
}

/* ─────────────── Insights ─────────────── */

function InsightCard({
  insight,
  onOpenBranch,
}: {
  insight: Insight;
  onOpenBranch: (id: string) => void;
}) {
  const conf = confidenceStyle[insight.confidence];
  const linked = insight.branches
    .map((id) => branches.find((b) => b.id === id))
    .filter(Boolean) as Branch[];
  return (
    <div className="rounded-2xl glass-elevated p-5">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-xl bg-gradient-to-br from-accent to-primary-glow ring-1 ring-white/10 shrink-0 inline-flex items-center justify-center">
          <Lightbulb className="size-4 text-primary-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-display font-semibold tracking-tight text-pretty">
              {insight.title}
            </h3>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ring-1 ${conf.cls}`}>
              {conf.label}
            </span>
          </div>
          <p className="text-sm text-foreground/85 mt-2 leading-relaxed text-pretty">{insight.body}</p>

          <div className="mt-4">
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Why this was generated
            </p>
            <ul className="space-y-1">
              {insight.rationale.map((r) => (
                <li key={r} className="text-xs text-foreground/75 flex gap-2">
                  <span className="text-primary">·</span> {r}
                </li>
              ))}
            </ul>
          </div>

          {linked.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {linked.map((b) => (
                <button
                  key={b.id}
                  onClick={() => onOpenBranch(b.id)}
                  className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 text-primary ring-1 ring-primary/20 hover:bg-primary/20"
                >
                  <Sparkles className="size-3" /> {b.title}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mt-4">
            <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-gradient-to-r from-primary to-primary-glow text-primary-foreground text-xs font-semibold">
              <Plus className="size-3.5" /> Save as project
            </button>
            <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium text-muted-foreground hover:bg-white/5 hover:text-foreground">
              <Eye className="size-3.5" /> Watch
            </button>
            <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium text-muted-foreground hover:bg-white/5 hover:text-foreground">
              <X className="size-3.5" /> Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Side panel (memory item) ─────────────── */

function SidePanel({ item, onClose }: { item: MemItem; onClose: () => void }) {
  const conf = confidenceStyle[item.confidence];
  const related = (item.relations ?? [])
    .map((r) => ({ rel: r.label, item: items.find((i) => i.id === r.id) }))
    .filter((x) => Boolean(x.item)) as { rel: string; item: MemItem }[];
  return (
    <aside className="w-[340px] shrink-0 border-l border-border bg-background/40 backdrop-blur-xl flex flex-col">
      <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            {item.category}
          </p>
          <h3 className="text-base font-display font-semibold mt-1 leading-snug">{item.belief}</h3>
        </div>
        <button
          onClick={onClose}
          className="size-7 rounded-md hover:bg-white/5 inline-flex items-center justify-center text-muted-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="px-5 space-y-4 text-sm">
        <Field label="Source" value={item.source} />
        <Field label="Used in" value={`${item.usedIn} brief${item.usedIn === 1 ? "" : "s"}`} />
        <Field label="Last used" value={item.lastUsed} />
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
            Confidence
          </p>
          <span className={`inline-flex text-[11px] font-medium px-2 py-0.5 rounded ring-1 ${conf.cls}`}>
            {conf.label}
          </span>
        </div>
        {related.length > 0 && (
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Connected to
            </p>
            <ul className="space-y-1.5">
              {related.map(({ rel, item: r }) => (
                <li key={r.id} className="text-xs rounded-md glass px-2.5 py-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-primary mr-2">{rel}</span>
                  <span className="text-foreground/85">{r.short}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1">
            Origin
          </p>
          <span className={`inline-flex text-[11px] font-medium px-2 py-0.5 rounded ring-1 ${item.inferred ? "bg-accent/10 text-accent ring-accent/20" : "bg-success/10 text-success ring-success/20"}`}>
            {item.inferred ? "AI inferred" : "User confirmed"}
          </span>
        </div>
      </div>
      <div className="mt-auto p-4 border-t border-border space-y-2">
        <button className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium ring-1 ring-white/10">
          <Pencil className="size-3.5" /> Edit
        </button>
        <button className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-warning/10 hover:bg-warning/20 text-warning text-xs font-medium ring-1 ring-warning/20">
          <AlertTriangle className="size-3.5" /> Mark wrong
        </button>
        <button className="w-full inline-flex items-center justify-center gap-1.5 h-9 rounded-lg bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-medium ring-1 ring-destructive/20">
          <Trash2 className="size-3.5" /> Delete
        </button>
      </div>
    </aside>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">
        {label}
      </p>
      <p className="text-sm">{value}</p>
    </div>
  );
}

/* ─────────────── Graph view ─────────────── */

const CATEGORY_LABELS: Record<Category, string> = {
  people: "People",
  projects: "Projects",
  preferences: "Preferences",
  deadlines: "Deadlines",
  writing: "Writing style",
  recurring: "Recurring",
  ignored: "Corrections",
};

type GraphMode = "all" | "people" | "projects" | "preferences" | "recent" | "review";

const GRAPH_MODES: { id: GraphMode; label: string }[] = [
  { id: "all", label: "All" },
  { id: "people", label: "People" },
  { id: "projects", label: "Projects" },
  { id: "preferences", label: "Preferences" },
  { id: "recent", label: "Recently used" },
  { id: "review", label: "Needs review" },
];

function GraphNode({
  data,
}: {
  data: MemItem & { onClick: () => void; selected: boolean; dimmed: boolean };
}) {
  const ringCls = data.rejected
    ? "ring-2 ring-destructive/60"
    : data.selected
      ? "ring-2 ring-primary"
      : data.inferred
        ? "ring-1 ring-dashed ring-accent/50"
        : "ring-1 ring-success/40";
  const glow = data.recent && !data.rejected ? "shadow-[0_0_24px_-6px_var(--primary)]" : "";
  return (
    <div
      onClick={data.onClick}
      className={`cursor-pointer rounded-xl px-2.5 py-1.5 backdrop-blur-xl bg-surface-elevated transition-all ${ringCls} ${glow} ${data.dimmed ? "opacity-30" : ""}`}
      style={{ minWidth: 120 }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <div className={`size-4 rounded-md bg-gradient-to-br ${categoryStyle[data.category]} ring-1 ring-white/10 shrink-0 ${data.rejected ? "grayscale" : ""}`} />
        <p className={`text-[11px] font-medium leading-tight whitespace-nowrap ${data.rejected ? "line-through text-muted-foreground" : ""}`}>
          {data.short}
        </p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function ClusterNode({ data }: { data: { label: string; w: number; h: number } }) {
  return (
    <div
      className="rounded-3xl ring-1 ring-white/5 bg-white/[0.015] backdrop-blur-sm pointer-events-none"
      style={{ width: data.w, height: data.h }}
    >
      <p className="px-3 pt-2 text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground/70">
        {data.label}
      </p>
    </div>
  );
}

const nodeTypes = { mem: GraphNode, cluster: ClusterNode };

function GraphView({
  filterCat,
  onSelect,
  selectedId,
  onJumpToList,
}: {
  filterCat: Category | "all";
  onSelect: (id: string) => void;
  selectedId: string | null;
  onJumpToList: () => void;
}) {
  const [mode, setMode] = useState<GraphMode>("all");

  const visible = useMemo(() => {
    return items.filter((i) => {
      if (filterCat !== "all" && i.category !== filterCat) return false;
      if (mode === "all") return true;
      if (mode === "recent") return i.recent;
      if (mode === "review") return i.inferred || i.rejected || i.confidence !== "high";
      // category-style modes
      if (mode === "people") return i.category === "people";
      if (mode === "projects") return i.category === "projects";
      if (mode === "preferences") return i.category === "preferences";
      return true;
    });
  }, [filterCat, mode]);

  // Cluster layout: arrange categories on a grid
  const layout = useMemo(() => {
    const byCat = new Map<Category, MemItem[]>();
    visible.forEach((it) => {
      const arr = byCat.get(it.category) ?? [];
      arr.push(it);
      byCat.set(it.category, arr);
    });
    const cats = Array.from(byCat.keys());
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(cats.length))));
    const colW = 320;
    const rowH = 240;
    const padX = 24;
    const padY = 36;
    const nodes: Node[] = [];

    cats.forEach((cat, ci) => {
      const list = byCat.get(cat)!;
      const col = ci % cols;
      const row = Math.floor(ci / cols);
      const cx = col * colW;
      const cy = row * rowH;
      // cluster halo node
      nodes.push({
        id: `cluster-${cat}`,
        type: "cluster",
        position: { x: cx, y: cy },
        data: { label: CATEGORY_LABELS[cat], w: colW - 24, h: rowH - 24 },
        draggable: false,
        selectable: false,
        zIndex: -1,
      });
      // arrange items in a soft grid inside the cluster
      const innerCols = Math.min(2, list.length);
      list.forEach((it, i) => {
        const ic = i % innerCols;
        const ir = Math.floor(i / innerCols);
        nodes.push({
          id: it.id,
          type: "mem",
          position: { x: cx + padX + ic * 140, y: cy + padY + ir * 52 },
          draggable: false,
          data: {
            ...it,
            onClick: () => onSelect(it.id),
            selected: selectedId === it.id,
            dimmed: selectedId !== null && selectedId !== it.id && !((items.find(x => x.id === selectedId)?.relations ?? []).some(r => r.id === it.id)),
          },
        });
      });
    });
    return nodes;
  }, [visible, selectedId]);

  const edges: Edge[] = useMemo(() => {
    const visibleIds = new Set(visible.map((v) => v.id));
    const out: Edge[] = [];
    visible.forEach((it) => {
      it.relations?.forEach((rel) => {
        if (!visibleIds.has(rel.id)) return;
        const isSelected = selectedId === it.id || selectedId === rel.id;
        const isCorrection = it.rejected || rel.label === "corrected by user";
        out.push({
          id: `${it.id}-${rel.id}`,
          source: it.id,
          target: rel.id,
          label: isSelected ? rel.label : "",
          labelStyle: { fill: "oklch(0.85 0 0)", fontSize: 10, fontFamily: "var(--font-mono)" },
          labelBgStyle: { fill: "oklch(0.18 0.02 280)" },
          labelBgPadding: [4, 2],
          labelBgBorderRadius: 4,
          style: {
            stroke: isCorrection
              ? "oklch(0.65 0.2 25 / 0.5)"
              : isSelected
                ? "oklch(0.75 0.2 290 / 0.9)"
                : "oklch(0.7 0.18 290 / 0.25)",
            strokeWidth: isSelected ? 1.5 : 1,
            strokeDasharray: isCorrection ? "4 3" : undefined,
          },
        });
      });
    });
    return out;
  }, [visible, selectedId]);

  const recentCount = items.filter((i) => i.recent).length;
  const correctionCount = items.filter((i) => i.rejected).length;
  const deadlineLinked = items.filter((i) => i.category === "projects" && (i.relations ?? []).some((r) => items.find((x) => x.id === r.id)?.category === "deadlines")).length;

  return (
    <div className="flex-1 mx-8 mb-8 flex flex-col min-h-[520px]">
      {/* Insight chips */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Chip>{recentCount} memories used in today's brief</Chip>
        <Chip>{correctionCount} correction changed future drafts</Chip>
        <Chip>{deadlineLinked} project memories connected to deadlines</Chip>
      </div>

      {/* Graph mode filters */}
      <div className="flex flex-wrap items-center gap-1 mb-3">
        {GRAPH_MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`px-2.5 h-7 rounded-md text-[11px] font-medium transition-colors ${
              mode === m.id
                ? "bg-primary/15 text-primary ring-1 ring-primary/25"
                : "text-muted-foreground hover:text-foreground hover:bg-white/5"
            }`}
          >
            {m.label}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <LegendDot cls="ring-success/60" label="Confirmed" />
          <LegendDot cls="ring-accent/60 ring-dashed" label="Inferred" />
          <LegendDot cls="ring-destructive/60" label="Corrected" />
          <LegendDot cls="ring-primary shadow-[0_0_8px_-2px_var(--primary)]" label="Recent" />
        </span>
      </div>

      <div className="flex-1 rounded-2xl glass-elevated overflow-hidden relative min-h-[440px]">
        <ReactFlow
          nodes={layout}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          zoomOnScroll
          minZoom={0.4}
          maxZoom={1.6}
          onPaneClick={() => onSelect("")}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="oklch(1 0 0 / 0.05)" />
          <Controls
            showInteractive={false}
            className="!bg-surface-elevated !border-border !rounded-lg overflow-hidden [&_button]:!bg-transparent [&_button]:!border-border [&_button]:!text-foreground"
          />
        </ReactFlow>
        <button
          onClick={onJumpToList}
          className="absolute top-4 left-4 inline-flex items-center gap-1.5 px-3 h-8 rounded-lg glass-elevated text-xs font-medium hover:ring-1 hover:ring-primary/30"
        >
          <ListIcon className="size-3.5" /> Back to editable list
        </button>
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full glass text-[11px] text-foreground/85">
      <Sparkles className="size-3 text-primary" />
      {children}
    </span>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2.5 rounded-full bg-surface-elevated ring-2 ${cls}`} />
      {label}
    </span>
  );
}


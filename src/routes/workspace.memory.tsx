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
} from "lucide-react";

export const Route = createFileRoute("/workspace/memory")({
  head: () => ({
    meta: [
      { title: "Memory — NeuralConnexions" },
      {
        name: "description",
        content:
          "Everything your assistant believes about you — with source, confidence, and full edit control.",
      },
    ],
  }),
  component: MemoryPage,
});

type Category =
  | "people"
  | "projects"
  | "preferences"
  | "deadlines"
  | "writing"
  | "recurring"
  | "ignored";

type Confidence = "high" | "medium" | "low";

type MemItem = {
  id: string;
  category: Category;
  belief: string;
  source: string;
  usedIn: number;
  lastUsed: string;
  confidence: Confidence;
  related?: string[]; // ids
};

const CATEGORIES: {
  id: Category;
  label: string;
  icon: typeof Users;
  blurb: string;
}[] = [
  { id: "people", label: "People", icon: Users, blurb: "Who matters and how" },
  { id: "projects", label: "Projects", icon: Briefcase, blurb: "What you're working on" },
  { id: "preferences", label: "Preferences", icon: Settings2, blurb: "How you like to work" },
  { id: "deadlines", label: "Deadlines", icon: CalendarClock, blurb: "What's due and when" },
  { id: "writing", label: "Writing style", icon: PenLine, blurb: "Tone and voice" },
  { id: "recurring", label: "Recurring commitments", icon: Repeat, blurb: "Repeating obligations" },
  { id: "ignored", label: "Ignored / corrected", icon: Ban, blurb: "Assumptions you've rejected" },
];

const items: MemItem[] = [
  {
    id: "m1",
    category: "people",
    belief: "Sarah Chen is your biology project partner.",
    source: "Shared WhatsApp message · Mar 2",
    usedIn: 2,
    lastUsed: "Used 2 days ago",
    confidence: "high",
    related: ["m4"],
  },
  {
    id: "m2",
    category: "people",
    belief: "Marcus Lee is an onboarding client (active).",
    source: "Gmail thread · Apr 18",
    usedIn: 5,
    lastUsed: "Used yesterday",
    confidence: "high",
  },
  {
    id: "m3",
    category: "people",
    belief: "Mark and Priya are part of leadership; recurring 1:1s.",
    source: "Calendar pattern (last 8 weeks)",
    usedIn: 11,
    lastUsed: "Used today",
    confidence: "medium",
  },
  {
    id: "m4",
    category: "projects",
    belief: "Q3 Launch (Alpha) is your top-priority project.",
    source: "Pinned by you · 12 docs · 47 emails",
    usedIn: 14,
    lastUsed: "Used today",
    confidence: "high",
    related: ["m1"],
  },
  {
    id: "m5",
    category: "projects",
    belief: "EU Expansion is in early planning.",
    source: "Notion page · updated Mon",
    usedIn: 3,
    lastUsed: "Used 4 days ago",
    confidence: "medium",
  },
  {
    id: "m6",
    category: "preferences",
    belief: "Mornings are reserved for deep work (no meetings before 10am).",
    source: "Calendar patterns + your rule",
    usedIn: 22,
    lastUsed: "Used today",
    confidence: "high",
  },
  {
    id: "m7",
    category: "preferences",
    belief: "No Friday afternoon meetings.",
    source: "You set this · Apr 1",
    usedIn: 6,
    lastUsed: "Used last Fri",
    confidence: "high",
  },
  {
    id: "m8",
    category: "deadlines",
    belief: "Q2 roadmap due to Jamie by Wednesday.",
    source: "Email from Jamie · Apr 30",
    usedIn: 4,
    lastUsed: "Used today",
    confidence: "high",
  },
  {
    id: "m9",
    category: "writing",
    belief: "You write replies in a clear, warm tone — short paragraphs, first-name greeting.",
    source: "Learned from 240 sent emails",
    usedIn: 38,
    lastUsed: "Used today",
    confidence: "high",
  },
  {
    id: "m10",
    category: "recurring",
    belief: "Weekly 1:1 with Marcus every Tuesday 2pm.",
    source: "Calendar series",
    usedIn: 9,
    lastUsed: "Used last Tue",
    confidence: "high",
  },
  {
    id: "m11",
    category: "ignored",
    belief: "(Rejected) You wanted me to auto-send replies to Sarah.",
    source: "You corrected this · Apr 22",
    usedIn: 0,
    lastUsed: "Never re-applied",
    confidence: "high",
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

function MemoryPage() {
  const [view, setView] = useState<"list" | "graph">("list");
  const [activeCat, setActiveCat] = useState<Category | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  return (
    <div className="flex-1 flex min-h-0">
      {/* Category rail */}
      <aside className="w-[260px] shrink-0 border-r border-border flex flex-col">
        <div className="px-5 pt-6 pb-3">
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            Trust layer
          </p>
          <h1 className="text-lg font-display font-semibold tracking-tight mt-0.5">Memory</h1>
          <p className="text-[11px] text-muted-foreground mt-1">
            Everything I believe — editable, with sources.
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

      {/* Main pane */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Toolbar */}
        <div className="px-8 pt-6 pb-4 flex items-center gap-3">
          <div className="flex-1 max-w-md flex items-center gap-2 px-3 h-9 rounded-lg glass">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search memories…"
              className="flex-1 bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="inline-flex items-center gap-1 glass rounded-lg p-1">
            <button
              onClick={() => setView("list")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === "list"
                  ? "bg-primary/15 text-primary ring-1 ring-primary/25"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ListIcon className="size-3.5" /> List
            </button>
            <button
              onClick={() => setView("graph")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === "graph"
                  ? "bg-primary/15 text-primary ring-1 ring-primary/25"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Network className="size-3.5" /> Graph
            </button>
          </div>
        </div>

        {view === "list" ? (
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
        ) : (
          <GraphView
            filterCat={activeCat}
            onSelect={(id) => setSelectedId(id)}
            selectedId={selectedId}
            onJumpToList={() => setView("list")}
          />
        )}
      </div>

      {/* Side panel */}
      {selected && (
        <SidePanel item={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
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
      <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
        {count}
      </span>
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
        <div
          className={`size-8 rounded-lg bg-gradient-to-br ${categoryStyle[item.category]} ring-1 ring-white/10 shrink-0 mt-0.5`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-pretty">{item.belief}</p>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            <span className="font-mono">Source:</span> {item.source}{" "}
            {item.usedIn > 0 && (
              <>
                <span className="opacity-50 mx-1">·</span>
                Used in {item.usedIn} brief{item.usedIn === 1 ? "" : "s"}
              </>
            )}
          </p>
          <div className="flex items-center gap-2 mt-2.5">
            <span
              className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ring-1 ${conf.cls}`}
            >
              Confidence: {conf.label}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">
              {item.lastUsed}
            </span>
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

function SidePanel({ item, onClose }: { item: MemItem; onClose: () => void }) {
  const conf = confidenceStyle[item.confidence];
  const related = item.related
    ?.map((id) => items.find((i) => i.id === id))
    .filter(Boolean) as MemItem[] | undefined;
  return (
    <aside className="w-[340px] shrink-0 border-l border-border bg-background/40 backdrop-blur-xl flex flex-col">
      <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            {item.category}
          </p>
          <h3 className="text-base font-display font-semibold mt-1 leading-snug">
            {item.belief}
          </h3>
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
        {related && related.length > 0 && (
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
              Related
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

/* ───────────────────── Graph view (secondary) ───────────────────── */

function GraphNode({
  data,
}: {
  data: MemItem & { onClick: () => void; selected: boolean };
}) {
  return (
    <div
      onClick={data.onClick}
      className={`cursor-pointer rounded-xl px-3 py-2 backdrop-blur-xl ring-1 transition-all bg-surface-elevated max-w-[180px] ${
        data.selected ? "ring-primary/60 ring-2" : "ring-white/10 hover:ring-primary/30"
      }`}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <div
          className={`size-5 rounded-md bg-gradient-to-br ${categoryStyle[data.category]} ring-1 ring-white/10 shrink-0`}
        />
        <p className="text-[11px] font-medium leading-tight line-clamp-2">{data.belief}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { mem: GraphNode };

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
  const visible = items.filter((i) => filterCat === "all" || i.category === filterCat);

  const nodes: Node[] = useMemo(() => {
    const byCat: Record<string, MemItem[]> = {};
    visible.forEach((it) => {
      byCat[it.category] = byCat[it.category] || [];
      byCat[it.category].push(it);
    });
    const cats = Object.keys(byCat);
    const out: Node[] = [];
    cats.forEach((cat, ci) => {
      const list = byCat[cat];
      const angle0 = (ci / Math.max(cats.length, 1)) * Math.PI * 2 - Math.PI / 2;
      const cx = 420 + Math.cos(angle0) * 280;
      const cy = 320 + Math.sin(angle0) * 220;
      list.forEach((it, i) => {
        const a = (i / Math.max(list.length, 1)) * Math.PI * 1.4 - Math.PI * 0.7;
        out.push({
          id: it.id,
          type: "mem",
          position: { x: cx + Math.cos(a) * 90, y: cy + Math.sin(a) * 70 },
          draggable: false,
          data: { ...it, onClick: () => onSelect(it.id), selected: selectedId === it.id },
        });
      });
    });
    return out;
  }, [filterCat, selectedId]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    visible.forEach((it) => {
      it.related?.forEach((rid) => {
        if (visible.find((v) => v.id === rid)) {
          out.push({
            id: `${it.id}-${rid}`,
            source: it.id,
            target: rid,
            style: { stroke: "oklch(0.7 0.18 290 / 0.4)", strokeWidth: 1 },
          });
        }
      });
    });
    return out;
  }, [filterCat]);

  return (
    <div className="flex-1 mx-8 mb-8 rounded-2xl glass-elevated overflow-hidden relative min-h-[480px]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnDrag
        zoomOnScroll
        minZoom={0.5}
        maxZoom={1.6}
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
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Handle,
  Position,
  BackgroundVariant,
} from "@xyflow/react";
import { Topbar } from "@/components/workspace/Topbar";
import { Trash2, Pencil, Network, List, User, Briefcase, Sparkles, X } from "lucide-react";

export const Route = createFileRoute("/workspace/memory")({
  head: () => ({
    meta: [
      { title: "Memory — NeuralConnexions" },
      { name: "description", content: "Interactive memory graph: every connection your assistant remembers, visible and editable." },
    ],
  }),
  component: MemoryPage,
});

type MemNode = {
  id: string;
  label: string;
  kind: "you" | "project" | "person" | "preference";
  detail: string;
};

const data: { nodes: MemNode[]; edges: { from: string; to: string; rel: string }[] } = {
  nodes: [
    { id: "you", label: "You", kind: "you", detail: "Center of your memory graph." },
    { id: "p1", label: "Q3 Launch — Alpha", kind: "project", detail: "Pinned · 12 docs · 47 emails" },
    { id: "p2", label: "EU Expansion", kind: "project", detail: "From Notion · updated Mon" },
    { id: "c1", label: "Sarah Chen", kind: "person", detail: "Product partner · Gmail freq." },
    { id: "c2", label: "Marcus Lee", kind: "person", detail: "Onboarding client" },
    { id: "c3", label: "Mark & Priya", kind: "person", detail: "Leadership · recurring 1:1s" },
    { id: "pr1", label: "Tone: clear, warm", kind: "preference", detail: "Learned from sent mail" },
    { id: "pr2", label: "Mornings = deep work", kind: "preference", detail: "From calendar patterns" },
    { id: "pr3", label: "No Friday PM meetings", kind: "preference", detail: "You set this" },
  ],
  edges: [
    { from: "you", to: "p1", rel: "owns" },
    { from: "you", to: "p2", rel: "owns" },
    { from: "you", to: "c1", rel: "works with" },
    { from: "you", to: "c2", rel: "supports" },
    { from: "you", to: "c3", rel: "reports to" },
    { from: "you", to: "pr1", rel: "prefers" },
    { from: "you", to: "pr2", rel: "prefers" },
    { from: "you", to: "pr3", rel: "prefers" },
    { from: "c1", to: "p1", rel: "on" },
    { from: "c2", to: "p2", rel: "on" },
  ],
};

const kindStyle: Record<MemNode["kind"], { ring: string; glow: string; icon: typeof User }> = {
  you: { ring: "ring-primary/60", glow: "from-primary to-primary-glow", icon: Sparkles },
  project: { ring: "ring-accent/50", glow: "from-accent to-primary-glow", icon: Briefcase },
  person: { ring: "ring-warning/40", glow: "from-warning to-accent", icon: User },
  preference: { ring: "ring-success/40", glow: "from-success to-accent", icon: Sparkles },
};

function GraphNode({ data }: { data: MemNode & { onClick: () => void; selected: boolean } }) {
  const s = kindStyle[data.kind];
  const Icon = s.icon;
  const center = data.kind === "you";
  return (
    <div
      onClick={data.onClick}
      className={[
        "group relative cursor-pointer rounded-2xl px-3 py-2 backdrop-blur-xl ring-1 transition-all",
        "bg-surface-elevated",
        data.selected ? `${s.ring} ring-2 scale-105` : `${s.ring} hover:scale-105`,
        center ? "px-4 py-3" : "",
      ].join(" ")}
      style={{ boxShadow: data.selected ? "0 8px 32px -8px var(--primary)" : undefined }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex items-center gap-2">
        <div className={`size-7 rounded-lg bg-gradient-to-br ${s.glow} flex items-center justify-center ring-1 ring-white/10`}>
          <Icon className="size-3.5 text-primary-foreground" />
        </div>
        <div className="leading-tight">
          <p className={`text-xs font-semibold ${center ? "text-sm" : ""}`}>{data.label}</p>
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
            {data.kind}
          </p>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { mem: GraphNode };

function radial(i: number, total: number, r: number) {
  const a = (i / total) * Math.PI * 2 - Math.PI / 2;
  return { x: 400 + Math.cos(a) * r, y: 300 + Math.sin(a) * r };
}

function MemoryPage() {
  const [view, setView] = useState<"graph" | "list">("graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    const others = data.nodes.filter((n) => n.id !== "you");
    const flowNodes: Node[] = [
      {
        id: "you",
        type: "mem",
        position: { x: 380, y: 280 },
        data: { ...data.nodes.find((n) => n.id === "you")!, onClick: () => setSelectedId("you"), selected: selectedId === "you" },
      },
      ...others.map((n, i) => {
        const ringR = n.kind === "preference" ? 230 : 170;
        const inGroup = others.filter((o) => o.kind === n.kind);
        const idx = inGroup.indexOf(n);
        const total = inGroup.length;
        const groupOffset = n.kind === "project" ? 0 : n.kind === "person" ? Math.PI * 0.7 : Math.PI * 1.4;
        const a = groupOffset + (idx / Math.max(total, 1)) * Math.PI * 0.6;
        return {
          id: n.id,
          type: "mem",
          position: { x: 380 + Math.cos(a) * ringR, y: 280 + Math.sin(a) * ringR },
          data: { ...n, onClick: () => setSelectedId(n.id), selected: selectedId === n.id },
        } as Node;
      }),
    ];
    void radial;
    const flowEdges: Edge[] = data.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from,
      target: e.to,
      label: e.rel,
      animated: e.from === "you",
      style: { stroke: "oklch(0.7 0.18 290 / 0.5)", strokeWidth: 1.2 },
      labelStyle: { fill: "oklch(0.75 0.02 270)", fontSize: 10, fontFamily: "JetBrains Mono" },
      labelBgStyle: { fill: "oklch(0.18 0.02 270 / 0.8)" },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [selectedId]);

  const selected = data.nodes.find((n) => n.id === selectedId);

  const grouped = useMemo(() => {
    const g: Record<string, MemNode[]> = {};
    data.nodes.filter(n => n.id !== "you").forEach((n) => {
      g[n.kind] = g[n.kind] || [];
      g[n.kind].push(n);
    });
    return g;
  }, []);

  return (
    <>
      <Topbar title="Memory" subtitle="Visible · editable · deletable" />
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-6 lg:px-8 pt-6 pb-4 flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-1">
              Trust layer
            </p>
            <h2 className="text-2xl font-display font-semibold tracking-tight">
              Your <span className="text-gradient">mind map</span>
            </h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-xl">
              Every entity, relationship, and preference your assistant remembers. Click a node to inspect or remove.
            </p>
          </div>
          <div className="inline-flex items-center gap-1 glass rounded-lg p-1">
            <button
              onClick={() => setView("graph")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === "graph" ? "bg-primary/20 text-foreground ring-1 ring-primary/30" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Network className="size-3.5" /> Graph
            </button>
            <button
              onClick={() => setView("list")}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                view === "list" ? "bg-primary/20 text-foreground ring-1 ring-primary/30" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <List className="size-3.5" /> List
            </button>
          </div>
        </div>

        {view === "graph" ? (
          <div className="flex-1 mx-6 lg:mx-8 mb-6 rounded-2xl glass-elevated overflow-hidden relative min-h-[500px]">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              proOptions={{ hideAttribution: true }}
              nodesDraggable
              panOnDrag
              zoomOnScroll
              minZoom={0.4}
              maxZoom={1.8}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="oklch(1 0 0 / 0.05)" />
              <Controls className="!bg-surface-elevated !border-border !rounded-lg overflow-hidden [&_button]:!bg-transparent [&_button]:!border-border [&_button]:!text-foreground" />
              <MiniMap
                className="!bg-surface-elevated !border !border-border !rounded-lg"
                nodeColor={() => "oklch(0.7 0.18 290 / 0.6)"}
                maskColor="oklch(0.16 0.018 270 / 0.7)"
              />
            </ReactFlow>

            {selected && (
              <div className="absolute top-4 right-4 w-72 glass-elevated rounded-xl p-4 animate-in fade-in slide-in-from-right-4">
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{selected.kind}</p>
                    <h3 className="text-sm font-semibold font-display mt-0.5">{selected.label}</h3>
                  </div>
                  <button onClick={() => setSelectedId(null)} className="size-7 rounded-md hover:bg-white/5 inline-flex items-center justify-center text-muted-foreground">
                    <X className="size-3.5" />
                  </button>
                </div>
                <p className="text-xs text-muted-foreground mb-4">{selected.detail}</p>
                <div className="flex gap-2">
                  <button className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-white/5 hover:bg-white/10 px-3 py-1.5 text-xs font-medium ring-1 ring-white/10">
                    <Pencil className="size-3" /> Edit
                  </button>
                  <button className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-destructive/15 hover:bg-destructive/25 text-destructive px-3 py-1.5 text-xs font-medium ring-1 ring-destructive/30">
                    <Trash2 className="size-3" /> Forget
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 px-6 lg:px-8 pb-8 max-w-3xl w-full mx-auto space-y-6 overflow-y-auto">
            {Object.entries(grouped).map(([kind, items]) => (
              <section key={kind}>
                <h3 className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-2">
                  {kind}s
                </h3>
                <ul className="rounded-xl glass divide-y divide-border overflow-hidden">
                  {items.map((it) => (
                    <li key={it.id} className="flex items-center gap-3 px-5 py-3 hover:bg-white/5 transition-colors">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{it.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{it.detail}</p>
                      </div>
                      <button className="size-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-white/5 hover:text-foreground">
                        <Pencil className="size-3.5" />
                      </button>
                      <button className="size-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-destructive/15 hover:text-destructive">
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

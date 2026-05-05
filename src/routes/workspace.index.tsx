import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Mail,
  Bell,
  Sparkles,
  Check,
  X,
  Pencil,
  Send,
  Calendar as CalendarIcon,
} from "lucide-react";

export const Route = createFileRoute("/workspace/")({
  head: () => ({
    meta: [
      { title: "Today — NeuralConnexions" },
      { name: "description", content: "Your morning briefing." },
    ],
  }),
  component: TodayPage,
});

type Item = {
  id: string;
  kind: "action" | "event" | "followup";
  icon: typeof Mail;
  title: string;
  meta: string;
  body: string;
  draft?: string;
  sources?: string[];
  urgent?: boolean;
};

const items: Item[] = [
  {
    id: "sarah",
    kind: "action",
    icon: Mail,
    title: "Reply to Sarah Chen",
    meta: "Partnership · 2m read",
    body: "Sarah is following up on a partnership proposal with updated terms (70/30 revenue share, 12-month exclusivity, co-marketing).",
    draft:
      "Hi Sarah,\n\nThanks for the updated terms — the 70/30 split and 12-month exclusivity work for us. I'd like to align on co-marketing scope before signing. Free at 1:30 PM today to walk through it?\n\n— Jamie",
    sources: ["Pricing v3", "Partnership thread", "Tone profile"],
    urgent: true,
  },
  {
    id: "q2",
    kind: "action",
    icon: Mail,
    title: "Send Q2 roadmap to Jamie",
    meta: "Due Wed",
    body: "Finalize roadmap document and share before the Wednesday deadline.",
    draft:
      "Hi Jamie,\n\nSharing the finalized Q2 roadmap ahead of Wednesday. Highlights: pricing rollout, EU launch, mid-market motion.\n\n— You",
    sources: ["Q2 Roadmap"],
  },
  {
    id: "standup",
    kind: "event",
    icon: CalendarIcon,
    title: "Team Standup",
    meta: "10:00 – 10:15 AM",
    body: "Daily sync with Priya and Theo.",
  },
  {
    id: "marcus",
    kind: "event",
    icon: CalendarIcon,
    title: "1:1 with Marcus",
    meta: "2:00 – 2:30 PM",
    body: "Onboarding check-in.",
  },
  {
    id: "alex",
    kind: "followup",
    icon: Bell,
    title: "Confirm coffee with Alex",
    meta: "Overdue · May 5",
    body: "You promised to confirm by Monday.",
    urgent: true,
  },
];

const filters = [
  { id: "all", label: "All" },
  { id: "action", label: "Actions" },
  { id: "event", label: "Schedule" },
  { id: "followup", label: "Follow-ups" },
] as const;

function TodayPage() {
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("all");
  const [selectedId, setSelectedId] = useState<string>(items[0].id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(items[0].draft ?? "");

  const filtered = items.filter((i) => filter === "all" || i.kind === filter);
  const selected = items.find((i) => i.id === selectedId) ?? filtered[0];

  const select = (it: Item) => {
    setSelectedId(it.id);
    setDraft(it.draft ?? "");
    setEditing(false);
  };

  return (
    <div className="flex-1 flex min-h-0">
      {/* List pane */}
      <div className="w-[340px] shrink-0 border-r border-border flex flex-col">
        <div className="px-5 pt-6 pb-3">
          <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
            Tuesday
          </p>
          <h1 className="text-xl font-display font-semibold tracking-tight mt-0.5">
            Good morning, Jamie.
          </h1>
        </div>
        <div className="px-3 pb-2 flex gap-1">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-2.5 h-7 rounded-md text-[11px] font-medium transition-colors ${
                filter === f.id
                  ? "bg-primary/15 text-primary ring-1 ring-primary/25"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {filtered.map((it) => {
            const Icon = it.icon;
            const active = it.id === selected?.id;
            return (
              <button
                key={it.id}
                onClick={() => select(it)}
                className={`w-full text-left px-3 py-3 rounded-lg flex gap-3 items-start transition-colors ${
                  active
                    ? "bg-white/5 ring-1 ring-primary/25"
                    : "hover:bg-white/5"
                }`}
              >
                <div className="size-8 rounded-lg bg-white/5 ring-1 ring-white/10 inline-flex items-center justify-center text-muted-foreground shrink-0 mt-0.5">
                  <Icon className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {it.urgent && (
                      <span className="size-1.5 rounded-full bg-destructive shrink-0" />
                    )}
                    <p className="text-sm font-medium truncate">{it.title}</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {it.meta}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        {selected ? (
          <article className="max-w-2xl mx-auto px-10 py-12">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-accent inline-flex items-center gap-1.5">
              <Sparkles className="size-3" /> {selected.kind}
            </p>
            <h2 className="text-3xl font-display font-semibold tracking-tight mt-2 text-balance">
              {selected.title}
            </h2>
            <p className="text-sm text-muted-foreground mt-2">{selected.meta}</p>
            <p className="text-base text-foreground/85 mt-8 leading-relaxed text-pretty">
              {selected.body}
            </p>

            {selected.draft && (
              <div className="mt-10">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
                    Suggested draft
                  </p>
                  <button
                    onClick={() => setEditing((e) => !e)}
                    className="text-[11px] inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3" /> {editing ? "Done" : "Edit"}
                  </button>
                </div>
                {editing ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={Math.max(6, draft.split("\n").length)}
                    className="w-full rounded-xl glass p-4 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                ) : (
                  <div className="rounded-xl glass p-5 text-sm leading-relaxed whitespace-pre-line text-pretty">
                    {draft}
                  </div>
                )}

                {selected.sources && (
                  <div className="flex flex-wrap gap-1.5 mt-4">
                    {selected.sources.map((s) => (
                      <span
                        key={s}
                        className="text-[10px] font-mono px-2 py-0.5 rounded bg-white/5 ring-1 ring-white/10 text-muted-foreground"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2 mt-6">
                  <button className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-gradient-to-r from-primary to-primary-glow text-primary-foreground text-xs font-semibold ring-1 ring-white/10 shadow-[0_4px_16px_-4px_var(--primary)] hover:opacity-95">
                    <Send className="size-3.5" /> Approve & Send
                  </button>
                  <button className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium text-muted-foreground hover:bg-white/5 hover:text-foreground">
                    <Check className="size-3.5" /> Mark done
                  </button>
                  <button className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-medium text-muted-foreground hover:bg-white/5 hover:text-foreground">
                    <X className="size-3.5" /> Skip
                  </button>
                </div>
              </div>
            )}
          </article>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Nothing to show.
          </div>
        )}
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { SectionHeader } from "@/components/workspace/SectionHeader";
import { Trash2, Pencil } from "lucide-react";

export const Route = createFileRoute("/workspace/memory")({
  head: () => ({
    meta: [
      { title: "Memory — Operand" },
      {
        name: "description",
        content: "Visible, editable, deletable context that powers your AI workspace.",
      },
    ],
  }),
  component: MemoryPage,
});

const groups: { title: string; items: { label: string; source: string }[] }[] = [
  {
    title: "Active projects",
    items: [
      { label: "Q3 launch — Alpha", source: "Pinned · 12 docs · 47 emails" },
      { label: "EU expansion plan", source: "From Notion · last updated Mon" },
    ],
  },
  {
    title: "Important contacts",
    items: [
      { label: "Sarah Chen — Product partner", source: "From Gmail frequency" },
      { label: "Marcus Lee — Onboarding client", source: "From recent threads" },
      { label: "Mark & Priya — Leadership", source: "From recurring meetings" },
    ],
  },
  {
    title: "Preferences & tone",
    items: [
      { label: "Writing tone: clear, warm, concise", source: "Learned from sent mail" },
      { label: "Prefer mornings for deep work", source: "From calendar patterns" },
      { label: "Avoid Friday afternoon meetings", source: "You set this" },
    ],
  },
];

function MemoryPage() {
  return (
    <>
      <Topbar title="Memory" subtitle="Everything Operand knows about your world" />
      <div className="flex-1 px-6 lg:px-8 py-8 max-w-3xl w-full mx-auto space-y-8">
        <SectionHeader
          eyebrow="Trust layer"
          title="Visible. Editable. Deletable."
          description="Memory is the product. You should always know what Operand knows and what it used."
        />

        {groups.map((g) => (
          <section key={g.title}>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              {g.title}
            </h3>
            <ul className="rounded-xl bg-surface ring-1 ring-border shadow-soft divide-y divide-border overflow-hidden">
              {g.items.map((it) => (
                <li
                  key={it.label}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{it.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{it.source}</p>
                  </div>
                  <button className="size-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground">
                    <Pencil className="size-3.5" />
                  </button>
                  <button className="size-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

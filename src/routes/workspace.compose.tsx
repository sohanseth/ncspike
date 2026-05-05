import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { SectionHeader } from "@/components/workspace/SectionHeader";
import { useState } from "react";
import { Sparkles, Wand2 } from "lucide-react";

export const Route = createFileRoute("/workspace/compose")({
  head: () => ({
    meta: [
      { title: "Composer — Operand" },
      {
        name: "description",
        content: "Turn rough thoughts into polished writing in your tone.",
      },
    ],
  }),
  component: ComposePage,
});

const tones = ["Clear", "Warm", "Concise", "Persuasive", "Casual"] as const;
const formats = ["Email", "Slack message", "Doc", "LinkedIn post"] as const;

function ComposePage() {
  const [input, setInput] = useState(
    "tell sarah pricing is ready, push call to 2:30 if she can, also mention we updated tier 2"
  );
  const [tone, setTone] = useState<(typeof tones)[number]>("Clear");
  const [format, setFormat] = useState<(typeof formats)[number]>("Email");
  const [output, setOutput] = useState<string>("");
  const [loading, setLoading] = useState(false);

  function generate() {
    setLoading(true);
    setOutput("");
    setTimeout(() => {
      setOutput(
        `Hi Sarah,\n\nQuick update — the pricing draft is ready. I've revised Tier 2 based on the Notion thread, so it should address the questions from Tuesday.\n\nIf 2:30 works on your end, I'd love to push our call back 30 minutes so we can walk through it together. Otherwise, happy to keep 2 PM and follow up async.\n\n— Jamie`
      );
      setLoading(false);
    }, 700);
  }

  return (
    <>
      <Topbar title="Composer" subtitle="Write This Properly" />
      <div className="flex-1 px-6 lg:px-8 py-8 max-w-4xl w-full mx-auto">
        <SectionHeader
          eyebrow="Workflow"
          title="From rough thought to polished message"
          description="Operand uses your tone profile and recent context."
        />

        <div className="rounded-xl bg-surface ring-1 ring-border shadow-soft p-5 space-y-4">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              What do you want to say?
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={4}
              className="mt-2 w-full resize-none rounded-lg border border-border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Selector label="Format" value={format} options={formats} onChange={setFormat} />
            <Selector label="Tone" value={tone} options={tones} onChange={setTone} />
            <button
              onClick={generate}
              disabled={loading}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              <Wand2 className="size-4" />
              {loading ? "Writing…" : "Generate"}
            </button>
          </div>

          {output && (
            <div className="rounded-lg bg-muted/50 border border-border p-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 inline-flex items-center gap-1.5">
                <Sparkles className="size-3 text-accent" />
                Draft · {format} · {tone}
              </p>
              <p className="text-sm leading-relaxed whitespace-pre-line text-pretty">
                {output}
              </p>
              <div className="mt-4 flex gap-2">
                <button className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90">
                  Copy
                </button>
                <button className="px-3 py-1.5 rounded-md text-xs ring-1 ring-border hover:bg-secondary">
                  Send to Gmail
                </button>
                <button className="px-3 py-1.5 rounded-md text-xs ring-1 ring-border hover:bg-secondary">
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Selector<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      <div className="flex gap-1 p-0.5 rounded-md bg-muted">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={[
              "px-2.5 py-1 rounded text-xs font-medium transition-colors",
              value === opt
                ? "bg-surface text-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { Topbar } from "@/components/workspace/Topbar";
import { useState } from "react";
import { Sparkles, Wand2, Copy, Send, RefreshCw, FileText, Check } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { sendWhatsApp } from "@/server/whatsapp.functions";

export const Route = createFileRoute("/workspace/compose")({
  head: () => ({
    meta: [
      { title: "Composer — NeuralConnexions" },
      { name: "description", content: "Turn rough thoughts into polished writing." },
    ],
  }),
  component: ComposePage,
});

const channels = ["Email", "Slack", "WhatsApp", "Doc", "LinkedIn"] as const;
const tones = ["Professional", "Warm", "Concise", "Persuasive", "Casual"] as const;
const contextChips = ["Tone profile", "Recent thread", "Memory: Sarah Chen"];

type Draft = { id: string; title: string; preview: string; when: string };
const recentDrafts: Draft[] = [
  { id: "1", title: "Pricing follow-up · Sarah", preview: "Hi Sarah, quick update on the pricing draft…", when: "Today" },
  { id: "2", title: "Q2 roadmap intro · Jamie", preview: "Sharing the finalized Q2 roadmap ahead of…", when: "Yesterday" },
];

function ComposePage() {
  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState<(typeof channels)[number]>("Email");
  const [tone, setTone] = useState<(typeof tones)[number]>("Professional");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  function polish() {
    if (!input.trim()) return;
    setLoading(true);
    setOutput("");
    setTimeout(() => {
      setOutput(
        `Hi Sarah,\n\nQuick update — the pricing draft is ready. I've revised Tier 2 based on the Notion thread, so it should address the questions from Tuesday.\n\nIf 2:30 works on your end, I'd love to push our call back 30 minutes so we can walk through it together. Otherwise, happy to keep 2 PM and follow up async.\n\n— Jamie`
      );
      setLoading(false);
    }, 700);
  }

  function copyOutput() {
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <>
      <Topbar title="Composer" subtitle="Turn rough thoughts into polished writing" />
      <div className="flex-1 px-6 lg:px-10 py-8 max-w-7xl w-full mx-auto">
        {/* Top controls */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (optional)"
            className="flex-1 min-w-[200px] h-10 px-4 rounded-xl ring-1 ring-border bg-surface text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-primary/40"
          />
          <Segmented label="Channel" value={channel} options={channels} onChange={setChannel} />
          <Segmented label="Tone" value={tone} options={tones} onChange={setTone} />
        </div>

        {/* Context chips */}
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Context
          </span>
          {contextChips.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] ring-1 ring-border bg-surface text-foreground/80"
            >
              <Sparkles className="size-3 text-primary" />
              {c}
            </span>
          ))}
        </div>

        {/* Split-pane: input | output */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_280px] gap-5">
          {/* Input */}
          <div className="rounded-2xl bg-surface ring-1 ring-border shadow-soft flex flex-col min-h-[440px]">
            <div className="px-5 pt-4 pb-2 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Your rough input
              </p>
              <span className="text-[11px] text-muted-foreground">{input.length} chars</span>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type or paste your rough thoughts, notes, bullet points, or messy draft here…"
              className="flex-1 resize-none px-5 pb-4 pt-1 text-sm leading-relaxed bg-transparent focus:outline-none placeholder:text-muted-foreground"
            />
            <div className="border-t border-border px-5 py-3 flex justify-end">
              <button
                onClick={polish}
                disabled={loading || !input.trim()}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
              >
                <Wand2 className="size-4" />
                {loading ? "Polishing…" : "Polish with AI"}
              </button>
            </div>
          </div>

          {/* Output */}
          <div className="rounded-2xl bg-surface ring-1 ring-border shadow-soft flex flex-col min-h-[440px]">
            <div className="px-5 pt-4 pb-2 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
                <Sparkles className="size-3 text-primary" />
                Polished · {channel} · {tone}
              </p>
              {output && (
                <button
                  onClick={polish}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <RefreshCw className="size-3" /> Regenerate
                </button>
              )}
            </div>
            <div className="flex-1 px-5 pb-4 overflow-auto">
              {loading ? (
                <div className="space-y-2 animate-pulse">
                  <div className="h-3 rounded bg-muted w-3/4" />
                  <div className="h-3 rounded bg-muted w-full" />
                  <div className="h-3 rounded bg-muted w-5/6" />
                  <div className="h-3 rounded bg-muted w-2/3" />
                </div>
              ) : output ? (
                <p className="text-sm leading-relaxed whitespace-pre-line text-pretty">
                  {output}
                </p>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
                  <div className="size-10 rounded-xl bg-tile-lavender text-primary flex items-center justify-center">
                    <Sparkles className="size-5" />
                  </div>
                  <p className="text-sm">Polished output appears here.</p>
                  <p className="text-xs">Write on the left, then press Polish with AI.</p>
                </div>
              )}
            </div>
            {output && (
              <div className="border-t border-border px-5 py-3 flex items-center justify-end gap-2">
                <button
                  onClick={copyOutput}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg ring-1 ring-border bg-surface text-xs font-medium hover:bg-muted"
                >
                  {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90">
                  <Send className="size-3.5" />
                  Send to {channel}
                </button>
              </div>
            )}
          </div>

          {/* Recent drafts */}
          <aside className="rounded-2xl bg-surface ring-1 ring-border shadow-soft p-4 lg:max-h-[440px] overflow-auto">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Recent drafts
            </p>
            {recentDrafts.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center text-muted-foreground py-10 gap-2">
                <FileText className="size-6" />
                <p className="text-xs">No drafts yet</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {recentDrafts.map((d) => (
                  <li key={d.id}>
                    <button className="w-full text-left rounded-lg p-3 ring-1 ring-border hover:bg-muted transition-colors">
                      <p className="text-xs font-semibold truncate">{d.title}</p>
                      <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                        {d.preview}
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-1.5">{d.when}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      </div>
    </>
  );
}

function Segmented<T extends string>({
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
      <div className="inline-flex p-0.5 rounded-lg bg-muted">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onChange(opt)}
            className={`px-2.5 h-8 rounded-md text-xs font-medium transition-colors ${
              value === opt
                ? "bg-surface text-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

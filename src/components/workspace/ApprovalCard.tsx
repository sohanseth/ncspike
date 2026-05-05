import { useState } from "react";
import { Check, Pencil, X, FileText, Calendar as CalIcon } from "lucide-react";

type Source = { label: string; kind?: "doc" | "email" | "calendar" };

export function ApprovalCard({
  badge,
  badgeTone = "default",
  from,
  fromMeta,
  context,
  draft,
  sources = [],
  primaryLabel = "Approve & Send",
}: {
  badge: string;
  badgeTone?: "default" | "accent" | "warning";
  from: string;
  fromMeta?: string;
  context: string;
  draft: string;
  sources?: Source[];
  primaryLabel?: string;
}) {
  const [state, setState] = useState<"idle" | "approved" | "dismissed">("idle");

  const toneClass =
    badgeTone === "accent"
      ? "bg-accent/10 text-accent ring-accent/20"
      : badgeTone === "warning"
        ? "bg-warning/15 text-warning-foreground ring-warning/30"
        : "bg-secondary text-secondary-foreground ring-border";

  if (state !== "idle") {
    return (
      <div className="rounded-xl border border-border bg-surface p-4 flex items-center gap-3 text-sm">
        <div
          className={`size-7 rounded-full flex items-center justify-center ${state === "approved" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}
        >
          {state === "approved" ? <Check className="size-4" /> : <X className="size-4" />}
        </div>
        <p className="text-muted-foreground">
          {state === "approved" ? "Sent." : "Dismissed."}{" "}
          <button
            onClick={() => setState("idle")}
            className="text-foreground font-medium hover:underline"
          >
            Undo
          </button>
        </p>
      </div>
    );
  }

  return (
    <article className="rounded-xl bg-surface ring-1 ring-border shadow-soft overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 border-b border-border">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ring-1 ${toneClass}`}
        >
          {badge}
        </span>
        <span className="text-xs text-muted-foreground">{fromMeta}</span>
      </header>

      <div className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-full bg-secondary overflow-hidden ring-1 ring-border shrink-0">
            <img
              src={`https://i.pravatar.cc/72?u=${encodeURIComponent(from)}`}
              alt={from}
              className="size-full object-cover"
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{from}</p>
            <p className="text-sm text-muted-foreground text-pretty">{context}</p>
          </div>
        </div>

        <div className="rounded-lg bg-muted/60 border border-border p-4">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Suggested draft
          </p>
          <p className="text-sm leading-relaxed text-pretty whitespace-pre-line">
            {draft}
          </p>
        </div>

        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Used context:</span>
            {sources.map((s) => (
              <span
                key={s.label}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-secondary text-foreground/80 ring-1 ring-border"
              >
                {s.kind === "calendar" ? (
                  <CalIcon className="size-3" />
                ) : (
                  <FileText className="size-3" />
                )}
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <footer className="px-5 py-3 border-t border-border bg-muted/30 flex items-center justify-end gap-2">
        <button
          onClick={() => setState("dismissed")}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-secondary"
        >
          <X className="size-3.5" />
          Dismiss
        </button>
        <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium ring-1 ring-border bg-surface hover:bg-secondary">
          <Pencil className="size-3.5" />
          Edit
        </button>
        <button
          onClick={() => setState("approved")}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Check className="size-3.5" />
          {primaryLabel}
        </button>
      </footer>
    </article>
  );
}

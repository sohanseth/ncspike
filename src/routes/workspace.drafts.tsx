import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  listDrafts,
  dismissDraft,
  markDraftSent,
  type DraftPayload,
} from "@/lib/voice-drafts.functions";
import { Inbox, Send, Trash2, Check } from "lucide-react";

export const Route = createFileRoute("/workspace/drafts")({
  component: DraftsPage,
});

type Tab = "pending" | "sent" | "dismissed";

const TAB_QUERY: Record<Tab, string | undefined> = {
  pending: "pending",
  sent: undefined, // we'll filter client-side for sent + edited_then_sent
  dismissed: "dismissed",
};

function DraftsPage() {
  const [tab, setTab] = useState<Tab>("pending");
  const [drafts, setDrafts] = useState<DraftPayload[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function reload(t: Tab = tab) {
    setError(null);
    setDrafts(null);
    try {
      const filter = TAB_QUERY[t];
      const all = await listDrafts({ data: filter ? { status: filter } : {} });
      const filtered =
        t === "sent"
          ? all.filter((d) => d.status === "sent" || d.status === "edited_then_sent")
          : all;
      setDrafts(filtered);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load drafts");
    }
  }

  useEffect(() => {
    reload(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function onDismiss(id: string) {
    setBusy(id);
    try {
      await dismissDraft({ data: { draftId: id } });
      await reload(tab);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dismiss failed");
    } finally {
      setBusy(null);
    }
  }

  async function onMarkSent(d: DraftPayload) {
    setBusy(d.id);
    try {
      await markDraftSent({ data: { draftId: d.id, finalBody: d.body } });
      await reload(tab);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mark sent failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col p-4 lg:p-6 gap-4 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold tracking-tight font-display">Drafts</h1>
        <p className="text-[12px] text-muted-foreground/70 mt-0.5">
          AI-drafted replies in your voice. Review before sending — nothing leaves your
          mailbox automatically.
        </p>
      </div>

      <div className="flex gap-1 border-b border-white/[0.06]">
        {(["pending", "sent", "dismissed"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "px-3 py-2 text-[12px] font-mono uppercase tracking-wider transition-colors -mb-px border-b-2",
              tab === t
                ? "text-primary border-primary"
                : "text-muted-foreground/60 border-transparent hover:text-foreground",
            ].join(" ")}
          >
            {t}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-400/20 bg-rose-500/[0.04] px-4 py-3 text-[12px] text-rose-300/80">
          {error}
        </div>
      )}

      {!drafts && !error && (
        <p className="text-[12px] text-muted-foreground/50">Loading…</p>
      )}

      {drafts && drafts.length === 0 && (
        <div className="rounded-2xl border border-white/[0.06] px-5 py-8 flex flex-col items-center gap-2 text-center">
          <Inbox size={18} className="text-muted-foreground/40" />
          <p className="text-[12.5px] text-muted-foreground/70">
            {tab === "pending"
              ? "No pending drafts. Draft a reply from your inbox to see it here."
              : tab === "sent"
                ? "No sent drafts yet."
                : "Nothing dismissed."}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {drafts?.map((d) => {
          const editPct =
            d.charsEdited != null && d.charsInDraft > 0
              ? Math.round((d.charsEdited / d.charsInDraft) * 100)
              : null;
          return (
            <div
              key={d.id}
              className="rounded-2xl border border-white/[0.06] px-4 py-3 bg-white/[0.015]"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/55">
                  {d.template}
                </span>
                <span className="text-[9px] text-muted-foreground/40">·</span>
                <span className="text-[9px] font-mono text-muted-foreground/55">
                  {new Date(d.createdAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="ml-auto text-[9px] font-mono uppercase tracking-wider text-muted-foreground/45">
                  {d.status}
                  {editPct != null && ` · edited ${editPct}%`}
                </span>
              </div>
              <pre className="text-[12.5px] text-foreground/85 whitespace-pre-wrap font-sans leading-relaxed">
                {d.body}
              </pre>
              {tab === "pending" && (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-white/[0.04]">
                  <button
                    onClick={() => onMarkSent(d)}
                    disabled={busy === d.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20 hover:bg-emerald-400/15 disabled:opacity-50"
                  >
                    <Check size={12} /> Mark sent
                  </button>
                  <button
                    onClick={() => onDismiss(d.id)}
                    disabled={busy === d.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-muted-foreground/70 hover:bg-white/5 hover:text-foreground disabled:opacity-50"
                  >
                    <Trash2 size={12} /> Dismiss
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Avoid unused-import warning if tree-shaking gets quirky
void Send;

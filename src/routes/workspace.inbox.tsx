/**
 * Inbox → Agent List (docs/25 §3.1 + §10).
 *
 * The inbox is no longer a flat list of finding cards. It's a list of
 * AGENT ROWS — one per non-archived agent — each row showing a glanceable
 * status line. Clicking a row navigates to the agent's home page at
 * `/workspace/agents/$agentId`.
 *
 * The URL `/workspace/inbox` stays as a bookmark-compat alias; the
 * canonical URL going forward is `/workspace/agents` which renders the
 * same agent-list content (see workspace.agents.tsx).
 *
 * This file is a substantial rewrite from PR #26's findings-rendering
 * inbox. The v3 briefing render lives in src/components/agent-home/,
 * mounted on the per-agent home page, NOT here.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { WorkspaceLocalNav } from "@/components/workspace/WorkspaceLocalNav";
import { listAgentRows, type AgentRow } from "@/lib/agent-home.functions";

export const Route = createFileRoute("/workspace/inbox")({
  component: InboxPage,
  head: () => ({
    meta: [
      { title: "Inbox — NeuralConnexions" },
      {
        name: "description",
        content:
          "Your watching agents at a glance — open one to see its latest briefing and activity.",
      },
    ],
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never run";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const deltaMs = Date.now() - ts;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Updated ${days}d ago`;
  const months = Math.floor(days / 30);
  return `Updated ${months}mo ago`;
}

function statusDotClass(status: string | undefined): string {
  switch (status) {
    case "ok":
    case "partial_success":
      return "bg-emerald-500";
    case "failed":
    case "timeout":
      return "bg-red-500";
    case "skipped_budget_exceeded":
      return "bg-amber-500";
    case "running":
      return "bg-sky-500 animate-pulse";
    default:
      return "bg-muted";
  }
}

function statusWord(status: string | undefined): string {
  switch (status) {
    case "ok":
      return "ok";
    case "partial_success":
      return "partial";
    case "failed":
      return "failed";
    case "timeout":
      return "timed out";
    case "skipped_budget_exceeded":
      return "skipped";
    case "running":
      return "running";
    default:
      return "no runs";
  }
}

/** Brief signal sentence for the right side of each row.
 *  Docs/25 §10 examples:
 *    "Updated today · ok · 2 new findings"
 *    "Updated 2h ago · ok · no briefing yet"
 *    "Updated yesterday · failed"
 *    "No runs yet"  */
function signalSentence(row: AgentRow): string {
  const lr = row.latest_run;
  if (!lr) return "No runs yet";
  if (lr.status === "failed" || lr.status === "timeout") {
    return "Last attempt didn't complete";
  }
  if (lr.status === "skipped_budget_exceeded") {
    return "Last cycle skipped (budget)";
  }
  if (!lr.has_briefing) {
    return "Latest run produced no briefing";
  }
  if (lr.items_kept === 0) {
    return "Nothing kept in latest run";
  }
  if (lr.items_kept === 1) return "1 kept finding";
  return `${lr.items_kept} kept findings`;
}

// ─── Page ────────────────────────────────────────────────────────────────

function InboxPage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/auth" });
  }, [user, authLoading, navigate]);

  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setError(null);
    setRefreshing(true);
    try {
      const result = await listAgentRows();
      setRows(result);
    } catch (e) {
      setError((e as Error).message ?? "Failed to load inbox");
      setRows([]);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!authLoading && user) void load();
  }, [authLoading, user]);

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <WorkspaceLocalNav />

      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-2 text-muted-foreground">
            Your watching agents. Open one to see its latest briefing and
            recent activity.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          aria-label="Refresh"
          className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      </header>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading agents…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground space-y-2">
          <p>No agents yet.</p>
          <p>
            Head to{" "}
            <Link
              to="/workspace/agents"
              className="text-foreground underline underline-offset-4 hover:no-underline"
            >
              Agents
            </Link>{" "}
            to create one.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                to="/workspace/agents/$agentId"
                params={{ agentId: row.id }}
                className="block rounded-xl border bg-card/40 px-4 py-3 hover:bg-card/60 transition-colors"
                aria-label={`Open agent: ${row.display_name}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-0.5 min-w-0">
                    <p className="font-medium truncate">{row.display_name}</p>
                    {row.topics_label && (
                      <p className="text-xs text-muted-foreground truncate">
                        {row.topics_label}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0 space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      {formatRelative(row.latest_run?.started_at)}
                    </p>
                    <p className="text-xs flex items-center justify-end gap-1.5">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${statusDotClass(row.latest_run?.status)}`}
                        aria-hidden="true"
                      />
                      <span className="text-muted-foreground">
                        {statusWord(row.latest_run?.status)}
                      </span>
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {signalSentence(row)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

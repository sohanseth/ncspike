/**
 * Agent Home page — docs/25 §1 + §4.
 *
 * Per-agent persistent surface. Reads getAgentHome(agentId), renders:
 *   - Header (alive signals: name, topics, cadence, status, rel-time)
 *   - Latest briefing (v3 component for v3; v2 component for v2 in
 *     the inbox file; degraded copy for v1/NULL/failed runs)
 *   - Activity timeline (latest 10 runs, newest first; latest expanded)
 *
 * No reply input, no Generate-X buttons, no Run-Now — all deferred per
 * docs/25 §2 + §10. The scope-drift checklist in the spec is the
 * authoritative non-goals list.
 */
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronLeft, ExternalLink, Loader } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { WorkspaceLocalNav } from "@/components/workspace/WorkspaceLocalNav";
import { getAgentHome, type AgentHome } from "@/lib/agent-home.functions";
import {
  AgentHomeBriefing,
  AgentHomeEmptyState,
  safeBriefingV3,
} from "@/components/agent-home/AgentHomeBriefing";

export const Route = createFileRoute("/workspace/agents/$agentId")({
  component: AgentHomePage,
  head: ({ params }) => ({
    meta: [
      { title: `Agent — NeuralConnexions` },
      {
        name: "description",
        content: `Persistent home page for one of your watching agents.`,
      },
      { property: "og:title", content: `Agent — NeuralConnexions` },
      { property: "og:description", content: `Persistent home page for one of your watching agents.` },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

// ─── Formatters ──────────────────────────────────────────────────────────

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const deltaMs = Date.now() - ts;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function statusDotClass(status: string): string {
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

function statusWord(status: string): string {
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
      return status;
  }
}

// ─── Page ────────────────────────────────────────────────────────────────

function AgentHomePage() {
  const { agentId } = Route.useParams();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!authLoading && !user) navigate({ to: "/auth" });
  }, [user, authLoading, navigate]);

  const [home, setHome] = useState<AgentHome | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    setLoading(true);
    setError(null);
    getAgentHome({ data: { agentId } })
      .then((result) => {
        if (!active) return;
        setHome(result);
        // Auto-expand the latest run in the timeline.
        if (result?.recent_runs?.[0]) {
          setExpandedRunId(result.recent_runs[0].id);
        }
      })
      .catch((e) => {
        if (!active) return;
        setError((e as Error).message ?? "Failed to load agent home");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentId, user, authLoading]);

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

      <Link
        to="/workspace/agents"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        All agents
      </Link>

      {loading ? (
        <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading agent home…
        </div>
      ) : error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {error}
        </div>
      ) : !home ? (
        <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground">
          Agent not found, or it's not yours.
        </div>
      ) : (
        <AgentHomeView home={home} expandedRunId={expandedRunId} setExpandedRunId={setExpandedRunId} />
      )}
    </div>
  );
}

// ─── Inner view ──────────────────────────────────────────────────────────

function AgentHomeView({
  home,
  expandedRunId,
  setExpandedRunId,
}: {
  home: AgentHome;
  expandedRunId: string | null;
  setExpandedRunId: (id: string | null) => void;
}) {
  const { agent, latest_briefing_run, latest_run, recent_runs } = home;

  // The top "Latest briefing" surface uses latest_briefing_run when
  // available (so failed/skipped runs don't blank out the surface).
  // The header reflects the most-recent run regardless.
  const briefingRaw = latest_briefing_run?.briefing ?? null;
  const v3 = briefingRaw ? safeBriefingV3(briefingRaw) : null;

  // Header status — reflects latest_run, not latest_briefing_run.
  const headerStatus = latest_run?.status ?? "never";
  const headerTimestamp = latest_run?.started_at ?? null;

  return (
    <div className="space-y-6">
      {/* HEADER */}
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {agent.display_name}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {agent.topics_label && <span>{agent.topics_label}</span>}
          {agent.topics_label && <span aria-hidden="true">·</span>}
          <span>{agent.cadence_hours}h cadence</span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 rounded-full ${statusDotClass(headerStatus)}`}
              aria-hidden="true"
            />
            <span>{statusWord(headerStatus)}</span>
          </span>
          {headerTimestamp && (
            <>
              <span aria-hidden="true">·</span>
              <span>Updated {formatRelative(headerTimestamp)}</span>
            </>
          )}
        </div>
      </header>

      {/* LATEST BRIEFING SURFACE */}
      {(() => {
        // No runs at all
        if (!latest_run) {
          return (
            <AgentHomeEmptyState
              reason="No runs yet."
              detail="This agent has been created but hasn't completed an observation cycle. Once it runs, its briefing and activity will appear here."
              iconHint="no-runs"
            />
          );
        }

        // We have a v3 briefing — render it (covers ok + failure-briefing cases)
        if (v3) {
          return <AgentHomeBriefing briefing={v3} />;
        }

        // We have SOME briefing but it isn't v3 (legacy v2 / v1)
        if (briefingRaw) {
          return (
            <AgentHomeEmptyState
              reason="Latest briefing is in the legacy format."
              detail={`Briefing produced ${formatRelative(latest_briefing_run!.started_at)} uses an older shape; expand the run below to see its details. New runs will use the current format.`}
              iconHint="no-briefing"
            />
          );
        }

        // No briefing in any version
        if (latest_run.status === "failed" || latest_run.status === "timeout") {
          return (
            <AgentHomeEmptyState
              reason="Latest run did not complete."
              detail={`Run ${statusWord(latest_run.status)} ${formatRelative(latest_run.started_at)}. The agent will try again on its next scheduled cycle. Expand the timeline below to inspect.`}
              iconHint="failed"
            />
          );
        }
        if (latest_run.status === "skipped_budget_exceeded") {
          return (
            <AgentHomeEmptyState
              reason="Latest cycle was skipped (budget cap)."
              detail={`The daily run budget had already been used. The next cycle will run on schedule.`}
            />
          );
        }
        // status='ok' or 'partial_success' but briefing is NULL
        return (
          <AgentHomeEmptyState
            reason="No briefing available for the latest run."
            detail={`Latest run completed ${formatRelative(latest_run.started_at)} but produced no briefing. ${latest_run.items_kept} findings persisted; expand the run below to scan them.`}
            iconHint="no-briefing"
          />
        );
      })()}

      {/* ACTIVITY TIMELINE */}
      <section aria-label="Activity timeline" className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Activity timeline
        </p>
        {recent_runs.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No runs to display.
          </p>
        ) : (
          <ol className="space-y-2">
            {recent_runs.map((r) => {
              const expanded = expandedRunId === r.id;
              const rv3 = r.briefing ? safeBriefingV3(r.briefing) : null;
              return (
                <li
                  key={r.id}
                  className="rounded-md border bg-card/30 overflow-hidden"
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedRunId(expanded ? null : r.id)}
                    className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-card/50"
                  >
                    <span
                      className={`inline-block h-2 w-2 rounded-full shrink-0 ${statusDotClass(r.status)}`}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-medium shrink-0">
                      {statusWord(r.status)}
                    </span>
                    <span className="text-sm text-muted-foreground shrink-0">
                      {formatRelative(r.started_at)}
                    </span>
                    <span className="text-xs text-muted-foreground/70 ml-auto shrink-0">
                      {r.has_briefing
                        ? `${r.items_kept} kept`
                        : "no briefing"}
                    </span>
                  </button>
                  {expanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-border/40">
                      {rv3 ? (
                        <AgentHomeBriefing briefing={rv3} />
                      ) : r.briefing ? (
                        <p className="text-sm text-muted-foreground italic">
                          Legacy-format briefing — not displayed in detail here.
                          The v3 prose-shaped briefing wasn't available for this run.
                        </p>
                      ) : (
                        <p className="text-sm text-muted-foreground italic">
                          No briefing produced for this run.
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { listFindings, type FindingItem } from "@/lib/findings.functions";

export const Route = createFileRoute("/workspace/inbox")({
  component: InboxPage,
  head: () => ({
    meta: [
      { title: "Inbox — NeuralConnexions" },
      {
        name: "description",
        content:
          "Latest findings from your research-digest agents — articles your agents flagged as relevant, grouped by agent.",
      },
    ],
  }),
});

/** Same date formatter as workspace.agents.tsx — kept inline so this
 *  route stays dependency-free. The two will converge into a shared
 *  helper when a third caller wants it. */
function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function scoreBadgeClass(score: number): string {
  if (score >= 0.8) return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (score >= 0.6) return "border-sky-500/40 bg-sky-500/10 text-sky-200";
  return "border-muted/40 bg-muted/10 text-muted-foreground";
}

function urgencyBadgeClass(urgency: string): string {
  return urgency === "urgent"
    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
    : "border-muted/40 bg-muted/10 text-muted-foreground";
}

/** Group findings by agent. Preserves the input's overall newest-first
 *  ordering: groups appear in the order each agent's most-recent finding
 *  showed up in the flat list. */
function groupByAgent(findings: FindingItem[]): Array<{
  agentId: string;
  agentName: string;
  items: FindingItem[];
}> {
  const order: string[] = [];
  const buckets = new Map<
    string,
    { agentId: string; agentName: string; items: FindingItem[] }
  >();
  for (const f of findings) {
    if (!buckets.has(f.agent_id)) {
      order.push(f.agent_id);
      buckets.set(f.agent_id, {
        agentId: f.agent_id,
        agentName: f.agent_display_name,
        items: [],
      });
    }
    buckets.get(f.agent_id)!.items.push(f);
  }
  return order.map((id) => buckets.get(id)!);
}

function InboxPage() {
  // Auth gate — same pattern as workspace.agents.tsx + workspace.connections.tsx.
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  const [findings, setFindings] = useState<FindingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setError(null);
    setRefreshing(true);
    try {
      const rows = await listFindings({ data: {} });
      setFindings(rows);
    } catch (err) {
      setError((err as Error).message ?? "Failed to load findings");
      setFindings([]);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!loading && user) void load();
  }, [loading, user]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const groups = findings ? groupByAgent(findings) : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm uppercase tracking-wider text-muted-foreground">
            Workspace
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-2 text-muted-foreground">
            Latest findings from your agents. Read-only for now — dismiss /
            snooze ships with the notification surface in 3.1.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          aria-label="Refresh"
          className="inline-flex items-center gap-1 rounded-md border bg-background px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
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

      {findings === null ? (
        <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground">
          Loading findings…
        </div>
      ) : findings.length === 0 ? (
        <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground">
          No findings yet. Once your agents run, articles they flag will appear
          here.
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((g) => (
            <section key={g.agentId}>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                {g.agentName}{" "}
                <span className="text-xs">
                  · {g.items.length} {g.items.length === 1 ? "finding" : "findings"}
                </span>
              </h2>
              <ul className="space-y-3">
                {g.items.map((f) => (
                  <li
                    key={f.id}
                    className="rounded-xl border bg-card/40 p-4 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {f.source_url ? (
                            <a
                              href={f.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-4"
                            >
                              {f.title}
                              <ExternalLink className="h-3 w-3 opacity-60" />
                            </a>
                          ) : (
                            <span className="font-medium">{f.title}</span>
                          )}
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${scoreBadgeClass(f.score)}`}
                            title="Relevance score (0–1)"
                          >
                            {f.score.toFixed(2)}
                          </span>
                          {f.urgency !== "normal" && (
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${urgencyBadgeClass(f.urgency)}`}
                            >
                              {f.urgency}
                            </span>
                          )}
                        </div>
                        {f.summary && (
                          <p className="text-sm text-muted-foreground">
                            {f.summary}
                          </p>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatTs(f.created_at)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

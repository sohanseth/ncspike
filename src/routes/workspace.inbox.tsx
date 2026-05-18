import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Star } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { WorkspaceLocalNav } from "@/components/workspace/WorkspaceLocalNav";
import {
  listFindings,
  listBriefings,
  type FindingItem,
  type AgentBriefing,
} from "@/lib/findings.functions";

export const Route = createFileRoute("/workspace/inbox")({
  component: InboxPage,
  head: () => ({
    meta: [
      { title: "Inbox — NeuralConnexions" },
      {
        name: "description",
        content:
          "Briefings + findings from your research-digest agents — what to read first, grouped by relevance and source type.",
      },
    ],
  }),
});

// ─── Formatters + visual helpers ─────────────────────────────────────────

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

/** PR #14 hardening: only render as link if URL parses + is http(s). */
function isSafeHttpUrl(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const PRIORITY_LABELS: Record<string, string> = {
  read_first: "Read first",
  useful: "Useful",
  background: "Background",
  low_priority: "Low priority",
};
const PRIORITY_ORDER = ["read_first", "useful", "background", "low_priority"];

function priorityBadgeClass(p: string): string {
  switch (p) {
    case "read_first":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    case "useful":
      return "border-sky-500/40 bg-sky-500/10 text-sky-200";
    case "background":
      return "border-muted/40 bg-muted/10 text-muted-foreground";
    case "low_priority":
    default:
      return "border-muted/30 bg-muted/5 text-muted-foreground/70";
  }
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  expert: "Expert",
  company: "Company",
  directory: "Directory",
  opinion: "Opinion",
  encyclopedia: "Reference",
  other: "Source",
};
function sourceBadgeClass(t: string): string {
  switch (t) {
    case "expert":
      return "border-violet-500/40 bg-violet-500/10 text-violet-200";
    case "company":
      return "border-amber-500/40 bg-amber-500/10 text-amber-200";
    case "directory":
      return "border-blue-500/40 bg-blue-500/10 text-blue-200";
    case "opinion":
      return "border-pink-500/40 bg-pink-500/10 text-pink-200";
    case "encyclopedia":
      return "border-teal-500/40 bg-teal-500/10 text-teal-200";
    case "other":
    default:
      return "border-muted/40 bg-muted/10 text-muted-foreground";
  }
}

function urgencyBadgeClass(urgency: string): string {
  return urgency === "urgent"
    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
    : "border-muted/40 bg-muted/10 text-muted-foreground";
}

// ─── Briefing shape (mirrors ResearchDigestBriefingSchema, client-side) ──
//
// We trust the server's Zod validation but still defensively narrow
// before rendering — a briefing missing a field should degrade
// gracefully (no rendered field) rather than throwing.

type BriefingTopPick = { findingId: string; title: string; reason: string };
type BriefingLabel = {
  priority: string;
  sourceType: string;
  reason?: string;
};

function safeBriefing(raw: unknown): {
  headline: string | null;
  synthesis: string | null;
  topPicks: BriefingTopPick[];
  findingLabels: Record<string, BriefingLabel>;
  qualityNote: string | null;
} {
  if (!raw || typeof raw !== "object") {
    return {
      headline: null,
      synthesis: null,
      topPicks: [],
      findingLabels: {},
      qualityNote: null,
    };
  }
  const r = raw as Record<string, unknown>;
  const topPicks: BriefingTopPick[] = Array.isArray(r.topPicks)
    ? (r.topPicks as unknown[])
        .filter(
          (p): p is BriefingTopPick =>
            !!p &&
            typeof p === "object" &&
            typeof (p as { findingId?: unknown }).findingId === "string" &&
            typeof (p as { title?: unknown }).title === "string" &&
            typeof (p as { reason?: unknown }).reason === "string",
        )
        .slice(0, 5)
    : [];
  const findingLabels: Record<string, BriefingLabel> = {};
  if (r.findingLabels && typeof r.findingLabels === "object") {
    for (const [k, v] of Object.entries(r.findingLabels as Record<string, unknown>)) {
      if (
        v &&
        typeof v === "object" &&
        typeof (v as { priority?: unknown }).priority === "string" &&
        typeof (v as { sourceType?: unknown }).sourceType === "string"
      ) {
        const lab = v as { priority: string; sourceType: string; reason?: unknown };
        findingLabels[k] = {
          priority: lab.priority,
          sourceType: lab.sourceType,
          reason: typeof lab.reason === "string" ? lab.reason : undefined,
        };
      }
    }
  }
  return {
    headline: typeof r.headline === "string" ? r.headline : null,
    synthesis: typeof r.synthesis === "string" ? r.synthesis : null,
    topPicks,
    findingLabels,
    qualityNote: typeof r.qualityNote === "string" ? r.qualityNote : null,
  };
}

// ─── Grouping ────────────────────────────────────────────────────────────

type Group = {
  agentId: string;
  agentName: string;
  items: FindingItem[];
  briefing: AgentBriefing | null;
};

function groupByAgent(
  findings: FindingItem[],
  briefingsByAgent: Map<string, AgentBriefing>,
): Group[] {
  const order: string[] = [];
  const buckets = new Map<string, Group>();
  for (const f of findings) {
    if (!buckets.has(f.agent_id)) {
      order.push(f.agent_id);
      buckets.set(f.agent_id, {
        agentId: f.agent_id,
        agentName: f.agent_display_name,
        items: [],
        briefing: briefingsByAgent.get(f.agent_id) ?? null,
      });
    }
    buckets.get(f.agent_id)!.items.push(f);
  }
  return order.map((id) => buckets.get(id)!);
}

function partitionByPriority(
  items: FindingItem[],
  labels: Record<string, BriefingLabel>,
): Array<{ priority: string; items: FindingItem[] }> {
  // Bucket by label.priority — default to 'useful' for any finding
  // whose dedupe_key isn't in labels (back-compat for pre-briefing runs).
  const buckets = new Map<string, FindingItem[]>();
  for (const p of PRIORITY_ORDER) buckets.set(p, []);
  for (const f of items) {
    const p = labels[f.dedupe_key]?.priority ?? "useful";
    if (!buckets.has(p)) buckets.set(p, []);
    buckets.get(p)!.push(f);
  }
  return PRIORITY_ORDER.map((priority) => ({
    priority,
    items: buckets.get(priority) ?? [],
  })).filter((g) => g.items.length > 0);
}

// ─── Component ───────────────────────────────────────────────────────────

function InboxPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  const [findings, setFindings] = useState<FindingItem[] | null>(null);
  const [briefings, setBriefings] = useState<AgentBriefing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setError(null);
    setRefreshing(true);
    try {
      // Parallel + INDEPENDENT — briefings is an enhancement layer over
      // findings, not a prerequisite. If briefings fails (e.g. migration
      // not yet applied in a staged env, transient SQL hiccup, schema
      // skew) findings MUST still render. The earlier Promise.all
      // fail-fast hid the entire findings view behind a briefings
      // failure — surfaced during the 2026-05-18 deploy verification of
      // PR #22 against a pre-migration DB. allSettled lets each query
      // degrade independently.
      const [findingsResult, briefingsResult] = await Promise.allSettled([
        listFindings({ data: {} }),
        listBriefings(),
      ]);

      if (findingsResult.status === "fulfilled") {
        setFindings(findingsResult.value);
      } else {
        // Findings is primary content — its failure IS the inbox error.
        setError(
          (findingsResult.reason as Error)?.message ?? "Failed to load inbox",
        );
        setFindings([]);
      }

      if (briefingsResult.status === "fulfilled") {
        setBriefings(briefingsResult.value);
      } else {
        // Briefings is best-effort enhancement. Log to console for the
        // operator; do NOT surface as a banner that hides findings, do
        // NOT clear findings. The agent sections just render without
        // their briefing blocks — same back-compat path as agents that
        // ran before the briefing layer existed.
        console.warn(
          "[inbox] listBriefings failed — rendering findings without briefing blocks:",
          briefingsResult.reason,
        );
        setBriefings([]);
      }
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

  const briefingsByAgent = new Map<string, AgentBriefing>();
  for (const b of briefings) briefingsByAgent.set(b.agent_id, b);
  const groups = findings ? groupByAgent(findings, briefingsByAgent) : [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <WorkspaceLocalNav />
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-2 text-muted-foreground">
            What your agents found, and what to read first. Read-only for now —
            dismiss / snooze ships with the notification surface in 3.1.
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
          Loading inbox…
        </div>
      ) : findings.length === 0 ? (
        <div className="rounded-xl border bg-card/40 p-6 text-sm text-muted-foreground">
          No findings yet. Once your agents run, articles they flag will appear
          here.
        </div>
      ) : (
        <div className="space-y-10">
          {groups.map((g) => {
            const b = g.briefing ? safeBriefing(g.briefing.briefing) : null;
            const groupedItems = partitionByPriority(
              g.items,
              b?.findingLabels ?? {},
            );
            return (
              <section key={g.agentId} className="space-y-4">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {g.agentName}{" "}
                  <span className="text-xs">
                    · {g.items.length} {g.items.length === 1 ? "finding" : "findings"}
                  </span>
                </h2>

                {/* ─── Briefing block ──────────────────────────────── */}
                {b && (b.headline || b.synthesis || b.topPicks.length > 0) && (
                  <div className="rounded-xl border bg-card/60 p-5 space-y-3">
                    {b.headline && (
                      <p className="text-base font-medium leading-snug">
                        {b.headline}
                      </p>
                    )}
                    {b.synthesis && (
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {b.synthesis}
                      </p>
                    )}
                    {b.topPicks.length > 0 && (
                      <div className="pt-1 space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          Read first
                        </p>
                        <ul className="space-y-2">
                          {b.topPicks.map((p) => (
                            <li
                              key={p.findingId}
                              className="flex items-start gap-2 text-sm"
                            >
                              <Star className="h-3.5 w-3.5 mt-0.5 text-emerald-300 shrink-0" />
                              <div>
                                <span className="font-medium">{p.title}</span>
                                {p.reason && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    — {p.reason}
                                  </span>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {b.qualityNote && (
                      <p className="text-xs text-muted-foreground italic pt-1">
                        {b.qualityNote}
                      </p>
                    )}
                  </div>
                )}

                {/* ─── Findings grouped by priority ────────────────── */}
                {groupedItems.map((bucket) => (
                  <div key={bucket.priority} className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {PRIORITY_LABELS[bucket.priority] ?? bucket.priority}{" "}
                      <span className="text-muted-foreground/60">
                        · {bucket.items.length}
                      </span>
                    </p>
                    <ul className="space-y-3">
                      {bucket.items.map((f) => {
                        const label = b?.findingLabels[f.dedupe_key];
                        const sourceType = label?.sourceType ?? "other";
                        const priority = label?.priority ?? "useful";
                        return (
                          <li
                            key={f.id}
                            className="rounded-xl border bg-card/40 p-4 space-y-2"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="space-y-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  {isSafeHttpUrl(f.source_url) ? (
                                    <a
                                      href={f.source_url!}
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
                                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${priorityBadgeClass(priority)}`}
                                  >
                                    {PRIORITY_LABELS[priority] ?? priority}
                                  </span>
                                  <span
                                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${sourceBadgeClass(sourceType)}`}
                                  >
                                    {SOURCE_TYPE_LABELS[sourceType] ?? sourceType}
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
                                {label?.reason && (
                                  <p className="text-xs text-muted-foreground/80 italic">
                                    {label.reason}
                                  </p>
                                )}
                              </div>
                            </div>
                            <p className="text-xs text-muted-foreground/70 flex items-center gap-3">
                              <span>{formatTs(f.created_at)}</span>
                              <span
                                title="Relevance score (0–1) — internal, ranked by agent"
                                className="font-mono"
                              >
                                score {f.score.toFixed(2)}
                              </span>
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

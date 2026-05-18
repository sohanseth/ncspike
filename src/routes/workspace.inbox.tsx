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

// Source-type labels — only the MEANINGFUL ones get rendered. 'other' is
// the runner's default-when-unclassified value; surfacing it as a badge
// labelled "Source" is pure noise (every link has a source). We
// deliberately omit 'other' from this map so the render guard
// `SOURCE_TYPE_LABELS[t]` falsy-checks for us.
const SOURCE_TYPE_LABELS: Record<string, string> = {
  expert: "Expert",
  company: "Company",
  directory: "Directory",
  opinion: "Opinion",
  encyclopedia: "Reference",
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
    default:
      return "border-muted/40 bg-muted/10 text-muted-foreground";
  }
}

function urgencyBadgeClass(urgency: string): string {
  return urgency === "urgent"
    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
    : "border-muted/40 bg-muted/10 text-muted-foreground";
}

// ─── v2 briefing shape + narrowing (mirrors ResearchDigestBriefingV2Schema) ─
//
// Docs/19+20 (2026-05-18). Client-side defensive narrowing — if the
// JSONB doesn't conform (e.g. a future-version row arrives mid-deploy),
// we render gracefully rather than throwing.

type BriefingProvenanceV2 = "new" | "continuing" | "recurring";
type BriefingTakeawayV2 = {
  text: string;
  supportSourceKeys: string[];
  provenance: BriefingProvenanceV2;
};
type BriefingReadFirstV2 = {
  sourceKey: string;
  reason: string;
  provenance: BriefingProvenanceV2;
};
type BriefingSkipGroupV2 = { reason: string; sourceKeys: string[] };
type BriefingIdeaV2 = { label: string; summary: string; sourceKeys: string[] };
type BriefingDeltaV2 = {
  whatsNew: string;
  whatsContinuing: string | null;
  whatsChanged: string | null;
};

type SafeBriefingV2 = {
  kind: "research";
  headline: string;
  synthesis: string;
  delta: BriefingDeltaV2 | null;
  qualityNote: string | null;
  memorableTakeaways: BriefingTakeawayV2[];
  readFirst: BriefingReadFirstV2[];
  skipOrCollapse: BriefingSkipGroupV2[];
  distinctIdeas: BriefingIdeaV2[];
  nextSearchSuggestions: string[];
};

function isV2Briefing(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return r.version === 2 && r.kind === "research";
}

function asString(v: unknown, max = 1000): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function asProvenance(v: unknown): BriefingProvenanceV2 {
  return v === "continuing" || v === "recurring" ? v : "new";
}

function safeBriefingV2(raw: unknown): SafeBriefingV2 | null {
  if (!isV2Briefing(raw)) return null;
  const r = raw as Record<string, unknown>;
  const headline = asString(r.headline, 400);
  const synthesis = asString(r.synthesis, 800);
  if (!headline || !synthesis) return null;

  const memorableTakeaways: BriefingTakeawayV2[] = Array.isArray(r.memorableTakeaways)
    ? (r.memorableTakeaways as unknown[])
        .map((t) => {
          if (!t || typeof t !== "object") return null;
          const obj = t as Record<string, unknown>;
          const text = asString(obj.text, 400);
          if (!text) return null;
          const supportSourceKeys = Array.isArray(obj.supportSourceKeys)
            ? (obj.supportSourceKeys as unknown[]).filter(
                (k): k is string => typeof k === "string",
              )
            : [];
          return {
            text,
            supportSourceKeys,
            provenance: asProvenance(obj.provenance),
          };
        })
        .filter((t): t is BriefingTakeawayV2 => t !== null)
        .slice(0, 8)
    : [];

  const readFirst: BriefingReadFirstV2[] = Array.isArray(r.readFirst)
    ? (r.readFirst as unknown[])
        .map((p) => {
          if (!p || typeof p !== "object") return null;
          const obj = p as Record<string, unknown>;
          const sourceKey = asString(obj.sourceKey, 1000);
          const reason = asString(obj.reason, 600);
          if (!sourceKey || !reason) return null;
          return {
            sourceKey,
            reason,
            provenance: asProvenance(obj.provenance),
          };
        })
        .filter((p): p is BriefingReadFirstV2 => p !== null)
        .slice(0, 5)
    : [];

  const skipOrCollapse: BriefingSkipGroupV2[] = Array.isArray(r.skipOrCollapse)
    ? (r.skipOrCollapse as unknown[])
        .map((g) => {
          if (!g || typeof g !== "object") return null;
          const obj = g as Record<string, unknown>;
          const reason = asString(obj.reason, 600);
          if (!reason) return null;
          const sourceKeys = Array.isArray(obj.sourceKeys)
            ? (obj.sourceKeys as unknown[]).filter(
                (k): k is string => typeof k === "string",
              )
            : [];
          return { reason, sourceKeys };
        })
        .filter((g): g is BriefingSkipGroupV2 => g !== null)
    : [];

  const distinctIdeas: BriefingIdeaV2[] = Array.isArray(r.distinctIdeas)
    ? (r.distinctIdeas as unknown[])
        .map((i) => {
          if (!i || typeof i !== "object") return null;
          const obj = i as Record<string, unknown>;
          const label = asString(obj.label, 200);
          const summary = asString(obj.summary, 600);
          if (!label || !summary) return null;
          const sourceKeys = Array.isArray(obj.sourceKeys)
            ? (obj.sourceKeys as unknown[]).filter(
                (k): k is string => typeof k === "string",
              )
            : [];
          return { label, summary, sourceKeys };
        })
        .filter((i): i is BriefingIdeaV2 => i !== null)
        .slice(0, 8)
    : [];

  const nextSearchSuggestions: string[] = Array.isArray(r.nextSearchSuggestions)
    ? (r.nextSearchSuggestions as unknown[])
        .filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 240)
        .slice(0, 5)
    : [];

  let delta: BriefingDeltaV2 | null = null;
  if (r.delta && typeof r.delta === "object") {
    const d = r.delta as Record<string, unknown>;
    const whatsNew = asString(d.whatsNew, 800);
    if (whatsNew) {
      delta = {
        whatsNew,
        whatsContinuing: asString(d.whatsContinuing, 600),
        whatsChanged: asString(d.whatsChanged, 600),
      };
    }
  }

  return {
    kind: "research",
    headline,
    synthesis,
    delta,
    qualityNote: asString(r.qualityNote, 600),
    memorableTakeaways,
    readFirst,
    skipOrCollapse,
    distinctIdeas,
    nextSearchSuggestions,
  };
}

/** Heuristic: detect a failure briefing (docs/20 §6 copy). v2 failure
 *  briefings have empty content arrays AND a headline matching the
 *  "I couldn't complete" prefix. The inbox renders these with the
 *  sources `<details>` open by default. */
function isFailureBriefingV2(b: SafeBriefingV2): boolean {
  const noContent =
    b.memorableTakeaways.length === 0 &&
    b.readFirst.length === 0 &&
    b.distinctIdeas.length === 0;
  return noContent && /couldn'?t complete this check/i.test(b.headline);
}

// ─── v1 briefing shape + narrowing (legacy, kept for back-compat) ─────────
//
// PR #22-era briefings. v2 dispatch happens first in the render loop;
// this path only fires when version !== 2 (incl. null).

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

/**
 * Detects the deterministic-fallback briefing that ResearchDigest produces
 * when LLM synthesis fails. We treat fallback briefings the same as
 * no-briefing-at-all (Sneha UX review, 2026-05-18): the fallback's
 * "headline = N items found for M topics" + score-derived priority labels
 * are scaffolding-grade text, not real synthesis. Rendering them as if
 * they were real briefings is the worst case — fake authority + visual
 * noise + no actual information.
 *
 * Signature comes from `deterministicBriefing()` in
 * src/server/agents/templates/research-digest.ts — the qualityNote is the
 * stable marker (the headline + synthesis vary by item count).
 */
function isFallbackBriefing(b: {
  qualityNote: string | null;
}): boolean {
  return (
    b.qualityNote !== null &&
    /fallback briefing/i.test(b.qualityNote)
  );
}

/**
 * Bucket findings by their briefing-assigned priority. Only called when
 * a REAL briefing exists (caller filters fallback). Items without a label
 * fall into a separate 'unlabeled' bucket rendered without a priority
 * header — we don't fabricate a 'useful' default any more (Sneha UX
 * review, 2026-05-18: faking a label users can't distinguish from a real
 * one is dishonest UX).
 */
function partitionByPriority(
  items: FindingItem[],
  labels: Record<string, BriefingLabel>,
): Array<{ priority: string; items: FindingItem[] }> {
  const buckets = new Map<string, FindingItem[]>();
  for (const p of PRIORITY_ORDER) buckets.set(p, []);
  const unlabeled: FindingItem[] = [];
  for (const f of items) {
    const p = labels[f.dedupe_key]?.priority;
    if (p && buckets.has(p)) {
      buckets.get(p)!.push(f);
    } else if (p) {
      // Real briefing assigned a priority we don't recognise — keep
      // it bucketed by that exact string so the render path uses
      // the raw label rather than silently dropping the item.
      if (!buckets.has(p)) buckets.set(p, []);
      buckets.get(p)!.push(f);
    } else {
      unlabeled.push(f);
    }
  }
  const ordered = PRIORITY_ORDER.map((priority) => ({
    priority,
    items: buckets.get(priority) ?? [],
  })).filter((g) => g.items.length > 0);
  // Any extra priorities the LLM invented (not in PRIORITY_ORDER) get
  // appended after the canonical ones, in insertion order.
  for (const [priority, items] of buckets) {
    if (PRIORITY_ORDER.includes(priority)) continue;
    if (items.length === 0) continue;
    ordered.push({ priority, items });
  }
  if (unlabeled.length > 0) {
    ordered.push({ priority: "__unlabeled", items: unlabeled });
  }
  return ordered;
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
            // v2 dispatch (docs/19+20, 2026-05-18). When briefing payload
            // is `version: 2`, render the briefing-first layout — the
            // briefing IS the page; findings collapse to a <details> at
            // the bottom. For v1 / NULL briefings, fall through to the
            // PR #24 flat-findings legacy path below.
            const b2 = g.briefing ? safeBriefingV2(g.briefing.briefing) : null;
            if (b2) {
              return (
                <BriefingV2Section
                  key={g.agentId}
                  agentName={g.agentName}
                  briefing={b2}
                  items={g.items}
                />
              );
            }

            // ─── Legacy (v1 / NULL) render path ─────────────────────
            // Three render states (PR #24, Sneha UX review 2026-05-18):
            //   1. realBriefing  — v1 LLM-synthesized briefing JSON.
            //                      Renders briefing block + grouped findings
            //                      with priority/source badges + star on
            //                      items the LLM marked as top picks.
            //   2. fallback      — v1 deterministic fallback briefing.
            //                      Treated identically to (3): no
            //                      briefing block, flat findings, no
            //                      fabricated labels.
            //   3. no-briefing   — column IS NULL. Flat findings render.
            // This path stays indefinitely per docs/19 §6 (sunset
            // condition: 2 consecutive weeks with no v1 briefings).
            const rawB = g.briefing ? safeBriefing(g.briefing.briefing) : null;
            const realBriefing = rawB && !isFallbackBriefing(rawB) ? rawB : null;
            const topPickIds = realBriefing
              ? new Set(realBriefing.topPicks.map((p) => p.findingId))
              : null;
            // Only bucket when we have real labels; otherwise render flat
            // (no priority headers, no fake "Useful" bucket).
            const grouped = realBriefing
              ? partitionByPriority(g.items, realBriefing.findingLabels)
              : [{ priority: "__flat", items: g.items }];

            return (
              <section key={g.agentId} className="space-y-4">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {g.agentName}{" "}
                  <span className="text-xs">
                    · {g.items.length} {g.items.length === 1 ? "finding" : "findings"}
                  </span>
                </h2>

                {/* ─── Briefing block (real briefings only) ────────── */}
                {realBriefing &&
                  (realBriefing.headline ||
                    realBriefing.synthesis ||
                    (realBriefing.qualityNote &&
                      !/fallback/i.test(realBriefing.qualityNote))) && (
                    <div className="rounded-xl border bg-card/60 p-5 space-y-3">
                      {realBriefing.headline && (
                        <p className="text-base font-medium leading-snug">
                          {realBriefing.headline}
                        </p>
                      )}
                      {realBriefing.synthesis && (
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          {realBriefing.synthesis}
                        </p>
                      )}
                      {/* Top picks are marked inline on the cards below
                          (star icon) — no duplicated list here. */}
                      {realBriefing.qualityNote &&
                        !/fallback/i.test(realBriefing.qualityNote) && (
                          <p className="text-xs text-muted-foreground italic pt-1">
                            {realBriefing.qualityNote}
                          </p>
                        )}
                    </div>
                  )}

                {/* ─── Findings ────────────────────────────────────── */}
                {grouped.map((bucket) => {
                  const showBucketHeader =
                    bucket.priority !== "__flat" &&
                    bucket.priority !== "__unlabeled";
                  return (
                    <div key={bucket.priority} className="space-y-2">
                      {showBucketHeader && (
                        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                          {PRIORITY_LABELS[bucket.priority] ?? bucket.priority}{" "}
                          <span className="text-muted-foreground/60">
                            · {bucket.items.length}
                          </span>
                        </p>
                      )}
                      <ul className="space-y-3">
                        {bucket.items.map((f) => {
                          const label = realBriefing?.findingLabels[f.dedupe_key];
                          const priority = label?.priority;
                          const sourceType = label?.sourceType;
                          // Only show source badge when sourceType is
                          // MEANINGFUL — i.e. one of the known categories.
                          // "other" / missing → no badge (a tautological
                          // "Source" badge is noise).
                          const sourceLabel = sourceType
                            ? SOURCE_TYPE_LABELS[sourceType]
                            : undefined;
                          const isTopPick = topPickIds?.has(f.dedupe_key) ?? false;
                          return (
                            <li
                              key={f.id}
                              className="rounded-xl border bg-card/40 p-4 space-y-2"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="space-y-1 min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    {isTopPick && (
                                      <Star
                                        className="h-3.5 w-3.5 text-emerald-300 shrink-0"
                                        aria-label="Top pick"
                                      />
                                    )}
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
                                    {/* Priority badge only when real-briefing labelled this item. */}
                                    {priority && PRIORITY_LABELS[priority] && (
                                      <span
                                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${priorityBadgeClass(priority)}`}
                                      >
                                        {PRIORITY_LABELS[priority]}
                                      </span>
                                    )}
                                    {/* Source badge only when meaningful (not 'other'/missing). */}
                                    {sourceLabel && (
                                      <span
                                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${sourceBadgeClass(sourceType!)}`}
                                      >
                                        {sourceLabel}
                                      </span>
                                    )}
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
                              {/* Footer: just the timestamp. The numeric
                                  relevance score (0–1) is internal
                                  ranking data — not user-facing. */}
                              <p className="text-xs text-muted-foreground/70">
                                {formatTs(f.created_at)}
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── v2 briefing-first render component ─────────────────────────────────
//
// Docs/19+20 (2026-05-18). The briefing IS the page. Findings are
// evidence, collapsed to a <details> block at the bottom. No per-source
// cards. No fake badges. Load-bearing principle: reduce repeated
// cognition across runs, don't summarise every source.

const PROVENANCE_BADGE: Record<BriefingProvenanceV2, { label: string; cls: string }> = {
  new: {
    label: "NEW",
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  },
  continuing: {
    label: "",
    cls: "",
  },
  recurring: {
    label: "RESURFACED",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  },
};

function ProvenanceBadge({ p }: { p: BriefingProvenanceV2 }) {
  const cfg = PROVENANCE_BADGE[p];
  if (!cfg.label) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wider ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

function BriefingV2Section({
  agentName,
  briefing,
  items,
}: {
  agentName: string;
  briefing: SafeBriefingV2;
  items: FindingItem[];
}) {
  const isFailure = isFailureBriefingV2(briefing);
  // dedupe_key → FindingItem map for resolving sourceKeys → titles + links.
  const itemByKey = new Map<string, FindingItem>();
  for (const f of items) itemByKey.set(f.dedupe_key, f);
  const titleForKey = (k: string): string =>
    itemByKey.get(k)?.title ?? k.slice(0, 80);
  const urlForKey = (k: string): string | null =>
    itemByKey.get(k)?.source_url ?? null;

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        {agentName}{" "}
        <span className="text-xs">
          · {items.length} {items.length === 1 ? "finding" : "findings"}
        </span>
      </h2>

      <div
        className={`rounded-xl border p-5 space-y-4 ${
          isFailure ? "border-muted/30 bg-card/30" : "bg-card/60"
        }`}
      >
        {/* Headline + synthesis */}
        <div className="space-y-2">
          <p className="text-base font-medium leading-snug">
            {briefing.headline}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {briefing.synthesis}
          </p>
        </div>

        {/* Delta block (cross-run continuity) */}
        {briefing.delta && (
          <div className="border-l-2 border-emerald-500/40 pl-3 space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-emerald-300/80">
              What's new this run
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {briefing.delta.whatsNew}
            </p>
            {briefing.delta.whatsContinuing && (
              <p className="text-xs text-muted-foreground/80">
                <span className="font-medium">Still true: </span>
                {briefing.delta.whatsContinuing}
              </p>
            )}
            {briefing.delta.whatsChanged && (
              <p className="text-xs text-muted-foreground/80">
                <span className="font-medium">Changed: </span>
                {briefing.delta.whatsChanged}
              </p>
            )}
          </div>
        )}

        {/* Memorable takeaways */}
        {briefing.memorableTakeaways.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              What to remember
            </p>
            <ul className="space-y-2">
              {briefing.memorableTakeaways.map((t, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-sm leading-relaxed"
                >
                  <span className="text-muted-foreground/60 shrink-0">•</span>
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span>{t.text}</span>
                      <ProvenanceBadge p={t.provenance} />
                      {t.supportSourceKeys.length > 0 && (
                        <span className="text-xs text-muted-foreground/60 shrink-0">
                          ({t.supportSourceKeys.length}{" "}
                          {t.supportSourceKeys.length === 1 ? "source" : "sources"})
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Read first */}
        {briefing.readFirst.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Read first
            </p>
            <ul className="space-y-2">
              {briefing.readFirst.map((p) => {
                const title = titleForKey(p.sourceKey);
                const url = urlForKey(p.sourceKey);
                return (
                  <li key={p.sourceKey} className="flex items-start gap-2 text-sm">
                    <Star className="h-3.5 w-3.5 mt-1 text-emerald-300 shrink-0" />
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        {isSafeHttpUrl(url) ? (
                          <a
                            href={url!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium hover:underline underline-offset-4"
                          >
                            {title}
                            <ExternalLink className="h-3 w-3 opacity-60" />
                          </a>
                        ) : (
                          <span className="font-medium">{title}</span>
                        )}
                        <ProvenanceBadge p={p.provenance} />
                      </div>
                      <p className="text-xs text-muted-foreground/80">{p.reason}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Distinct ideas — only when no memorableTakeaways (taxonomic fallback) */}
        {briefing.memorableTakeaways.length === 0 &&
          briefing.distinctIdeas.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Themes in this batch
              </p>
              <ul className="space-y-2">
                {briefing.distinctIdeas.map((idea, i) => (
                  <li key={i} className="text-sm space-y-0.5">
                    <p className="font-medium">{idea.label}</p>
                    <p className="text-xs text-muted-foreground">{idea.summary}</p>
                    {idea.sourceKeys.length > 0 && (
                      <p className="text-xs text-muted-foreground/60">
                        ({idea.sourceKeys.length}{" "}
                        {idea.sourceKeys.length === 1 ? "source" : "sources"})
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

        {/* Skip / collapse */}
        {briefing.skipOrCollapse.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
              Skip
            </p>
            <ul className="space-y-1">
              {briefing.skipOrCollapse.map((g, i) => (
                <li key={i} className="text-xs text-muted-foreground/80">
                  • {g.reason}{" "}
                  {g.sourceKeys.length > 0 && (
                    <span className="text-muted-foreground/60">
                      ({g.sourceKeys.length}{" "}
                      {g.sourceKeys.length === 1 ? "source" : "sources"})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Next-run suggestions */}
        {briefing.nextSearchSuggestions.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
              Next run could check
            </p>
            <ul className="space-y-1">
              {briefing.nextSearchSuggestions.map((s, i) => (
                <li key={i} className="text-xs text-muted-foreground/80">
                  • {s}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* qualityNote */}
        {briefing.qualityNote && (
          <p className="text-xs text-muted-foreground italic">
            {briefing.qualityNote}
          </p>
        )}
      </div>

      {/* Sources <details> — closed by default on success, open on failure
          so the user can still scan titles when synthesis didn't complete. */}
      <details open={isFailure} className="group">
        <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground/80 list-none flex items-center gap-1.5">
          <span className="transition-transform group-open:rotate-90">▸</span>
          Sources checked: {items.length}
        </summary>
        <ul className="mt-3 space-y-1.5 pl-4">
          {items.map((f) => (
            <li key={f.id} className="text-sm text-muted-foreground">
              {isSafeHttpUrl(f.source_url) ? (
                <a
                  href={f.source_url!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:underline underline-offset-4 hover:text-foreground/80"
                >
                  {f.title}
                  <ExternalLink className="h-3 w-3 opacity-60" />
                </a>
              ) : (
                <span>{f.title}</span>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

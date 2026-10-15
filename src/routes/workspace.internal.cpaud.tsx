/**
 * Internal CPAUD viewer.
 *
 * Route: `/workspace/internal/cpaud`
 *
 * Read-only admin surface gated by the `CPAUD_VIEWER_USER_IDS` env
 * allowlist (see `src/lib/cpaud.functions.ts`). Renders rolling 14-day
 * cost-per-active-user-per-day, OSS-tier share, and per-badge cost — never
 * any prompt or response text.
 *
 * Spec: docs/05-spec-phase-2.6-chat-providers.md §2.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import {
  getCpaudReport,
  CPAUD_TARGET_USD,
  CPAUD_CEILING_USD,
  OSS_SHARE_TARGET_PCT,
  type CpaudReport,
  type DayBucket,
} from "@/lib/cpaud.functions";

export const Route = createFileRoute("/workspace/internal/cpaud")({
  component: CpaudPage,
  head: () => ({
    meta: [
      { title: "Internal usage costs — NeuralConnexions" },
      { name: "description", content: "Internal NeuralConnexions inference cost and usage reporting." },
      { property: "og:title", content: "Internal usage costs — NeuralConnexions" },
      { property: "og:description", content: "Internal NeuralConnexions inference cost and usage reporting." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

const BADGES = ["flash", "pro", "genius", "private"] as const;
const BADGE_COLOR: Record<(typeof BADGES)[number], string> = {
  flash: "bg-cyan-400",
  pro: "bg-violet-400",
  genius: "bg-amber-400",
  private: "bg-emerald-400",
};

function fmtUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `$${n.toFixed(3)}`;
}

function CpaudPage() {
  const { user, loading } = useAuth();
  const [report, setReport] = useState<CpaudReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      setFetching(true);
      setError(null);
      try {
        const r = await getCpaudReport();
        setReport(r);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(/Not authorized/i.test(msg) ? "not_authorized" : "load_failed");
      } finally {
        setFetching(false);
      }
    })();
  }, [user]);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (error === "not_authorized") {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="font-display text-xl mb-2">Not authorized</h1>
          <p className="text-sm text-muted-foreground">
            This page is restricted to operators on the CPAUD allowlist.
          </p>
          <Link to="/workspace" className="mt-4 inline-block text-sm text-primary hover:underline">
            ← Back to workspace
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl">CPAUD — internal</h1>
            <p className="text-sm text-muted-foreground">
              Cost-per-active-user-per-day across all chat providers, rolling
              {report ? ` ${report.windowDays}` : ""}-day window. No
              prompt/response content shown.
            </p>
          </div>
          <Link to="/workspace" className="text-sm text-primary hover:underline">
            ← Back
          </Link>
        </header>

        {fetching && (
          <p className="text-sm text-muted-foreground">Loading report…</p>
        )}

        {error === "load_failed" && (
          <p className="text-sm text-amber-300">
            Failed to load CPAUD report. Check server logs.
          </p>
        )}

        {report && <ReportBody report={report} />}
      </div>
    </div>
  );
}

function ReportBody({ report }: { report: CpaudReport }) {
  const { totals, thresholds, buckets } = report;
  const cpaudPctOfCeiling = Math.min(
    100,
    (totals.avgCpaudUsd / thresholds.ceilingUsd) * 100,
  );
  const overTarget = totals.avgCpaudUsd > thresholds.targetUsd;
  const overCeiling = totals.avgCpaudUsd > thresholds.ceilingUsd;
  const ossOk = totals.ossSharePct >= thresholds.ossSharePct;
  const maxBucketCpaud = buckets.reduce((m, b) => (b.cpaudUsd > m ? b.cpaudUsd : m), 0);
  // Sparkline ceiling = max(observed, ceiling threshold) so the threshold
  // line stays visible even on quiet windows.
  const sparkMax = Math.max(maxBucketCpaud, thresholds.ceilingUsd);

  return (
    <>
      <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <div className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              Avg CPAUD ({report.windowDays}d)
            </div>
            <div className="font-display text-3xl">
              {fmtUsd(totals.avgCpaudUsd)}
              <span className="text-base text-muted-foreground">
                {" "}
                / target {fmtUsd(thresholds.targetUsd)} · ceiling{" "}
                {fmtUsd(thresholds.ceilingUsd)}
              </span>
            </div>
          </div>
          <div className="text-right text-xs text-muted-foreground space-y-1">
            <div>{totals.okRequests.toLocaleString()} ok requests</div>
            <div>{totals.distinctUsers.toLocaleString()} distinct users</div>
            <div>Total spend {fmtUsd(totals.totalUsd)}</div>
          </div>
        </div>
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full transition-all",
              overCeiling
                ? "bg-rose-500"
                : overTarget
                ? "bg-amber-400"
                : "bg-gradient-to-r from-emerald-400 to-cyan-400",
            )}
            style={{ width: `${cpaudPctOfCeiling}%` }}
          />
          {/* Target threshold marker */}
          <div
            className="absolute top-0 h-full w-px bg-foreground/40"
            style={{ left: `${(thresholds.targetUsd / thresholds.ceilingUsd) * 100}%` }}
            title={`target ${fmtUsd(thresholds.targetUsd)}`}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>$0</span>
          <span>target</span>
          <span>ceiling</span>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <div className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
              OSS-tier cost share (T0 + T1)
            </div>
            <div className="font-display text-3xl">
              {totals.ossSharePct.toFixed(1)}%
              <span className="text-base text-muted-foreground">
                {" "}
                / target ≥ {thresholds.ossSharePct}%
              </span>
            </div>
          </div>
          <div className={cn("text-sm", ossOk ? "text-emerald-400" : "text-amber-300")}>
            {ossOk ? "ON TARGET" : "BELOW TARGET"}
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full transition-all",
              ossOk ? "bg-emerald-400" : "bg-amber-400",
            )}
            style={{ width: `${Math.min(100, totals.ossSharePct)}%` }}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
        <h2 className="mb-3 font-display text-lg">CPAUD by day</h2>
        <Sparkline
          buckets={buckets}
          max={sparkMax}
          target={thresholds.targetUsd}
          ceiling={thresholds.ceilingUsd}
        />
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>{buckets[0]?.day}</span>
          <span>{buckets[buckets.length - 1]?.day}</span>
        </div>
      </section>

      <ImageBlockedSection report={report} />

      <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
        <h2 className="mb-3 font-display text-lg">Daily breakdown</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-mono">Day</th>
                <th className="py-1 pr-3 font-mono">DAU</th>
                <th className="py-1 pr-3 font-mono">Total</th>
                <th className="py-1 pr-3 font-mono">CPAUD</th>
                <th className="py-1 pr-3 font-mono">OSS%</th>
                {BADGES.map((b) => (
                  <th key={b} className="py-1 pr-3 font-mono">
                    {b}
                  </th>
                ))}
                <th
                  className="py-1 pr-3 font-mono"
                  title="On-device image turns refused by the safety classifier"
                >
                  img⊘
                </th>
              </tr>
            </thead>
            <tbody>
              {[...buckets].reverse().map((b) => (
                <tr key={b.day} className="border-t border-border/50">
                  <td className="py-1 pr-3 text-muted-foreground">{b.day}</td>
                  <td className="py-1 pr-3">{b.dau}</td>
                  <td className="py-1 pr-3">{fmtUsd(b.totalUsd)}</td>
                  <td
                    className={cn(
                      "py-1 pr-3",
                      b.cpaudUsd > thresholds.ceilingUsd
                        ? "text-rose-400"
                        : b.cpaudUsd > thresholds.targetUsd
                        ? "text-amber-300"
                        : "",
                    )}
                  >
                    {fmtUsd(b.cpaudUsd)}
                  </td>
                  <td className="py-1 pr-3">
                    {b.totalUsd === 0 ? "—" : `${b.ossSharePct.toFixed(0)}%`}
                  </td>
                  {BADGES.map((badge) => (
                    <td key={badge} className="py-1 pr-3 text-muted-foreground">
                      {b.costByBadge[badge] === 0
                        ? "—"
                        : fmtUsd(b.costByBadge[badge])}
                    </td>
                  ))}
                  <td
                    className={cn(
                      "py-1 pr-3 tabular-nums",
                      b.imageBlockedCount === 0
                        ? "text-muted-foreground"
                        : "text-rose-300",
                    )}
                    title={
                      b.imageBlockedCount === 0
                        ? "no on-device images blocked"
                        : Object.entries(b.imageBlockedByAdapter)
                            .map(([a, n]) => `${a}: ${n}`)
                            .join("\n")
                    }
                  >
                    {b.imageBlockedCount === 0 ? "—" : b.imageBlockedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Generated {new Date(report.generatedAt).toLocaleString()}. Source:
        inference_usage (status=ok). No prompt or response content is fetched
        client-side.
      </p>
    </>
  );
}

function ImageBlockedSection({ report }: { report: CpaudReport }) {
  const { imageBlocked, windowDays } = report;
  const adapters = Object.entries(imageBlocked.byAdapter).sort(
    (a, b) => b[1] - a[1],
  );
  // Task #51: classifier-verdict breakdown alongside the per-adapter
  // breakdown so ops can see whether refusals are coming from the NSFW
  // gate, the structural pre-checks, or a degraded classifier — which
  // is what's actually needed to tune the threshold. Rows from before
  // the dispatcher started writing the reason fall under `unknown`.
  const reasons = Object.entries(imageBlocked.byReason).sort(
    (a, b) => b[1] - a[1],
  );
  return (
    <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <div className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            On-device images blocked ({windowDays}d)
          </div>
          <div className="font-display text-3xl">
            {imageBlocked.windowTotal.toLocaleString()}
            <span className="text-base text-muted-foreground">
              {" "}
              turn{imageBlocked.windowTotal === 1 ? "" : "s"} refused by the
              safety classifier
            </span>
          </div>
        </div>
      </div>
      {imageBlocked.windowTotal === 0 ? (
        <p className="text-sm text-muted-foreground">
          No on-device image turns have been blocked in this window.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="overflow-x-auto">
            <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              By verdict reason
            </h3>
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-mono">Reason</th>
                  <th className="py-1 pr-3 font-mono">Blocked turns</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map(([reason, count]) => (
                  <tr key={reason} className="border-t border-border/50">
                    <td className="py-1 pr-3 text-muted-foreground">
                      {reason}
                    </td>
                    <td className="py-1 pr-3">{count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <h3 className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
              By adapter
            </h3>
            <table className="w-full text-sm tabular-nums">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-mono">Adapter (model_used)</th>
                  <th className="py-1 pr-3 font-mono">Blocked turns</th>
                </tr>
              </thead>
              <tbody>
                {adapters.map(([adapter, count]) => (
                  <tr key={adapter} className="border-t border-border/50">
                    <td className="py-1 pr-3 text-muted-foreground">
                      {adapter}
                    </td>
                    <td className="py-1 pr-3">{count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Source: <code>inference_usage</code> rows with{" "}
        <code>status = 'error'</code> and{" "}
        <code>metadata-&gt;&gt;'image_blocked' = 'true'</code>. Verdict
        reason comes from <code>metadata-&gt;&gt;'image_blocked_reason'</code>;
        rows from before that field was being recorded count as{" "}
        <code>unknown</code>. Blocked turns don't debit caps or count toward
        CPAUD; this surface is just for tuning the classifier threshold and
        spotting prompt-abuse spikes.
      </p>
    </section>
  );
}

function Sparkline({
  buckets,
  max,
  target,
  ceiling,
}: {
  buckets: DayBucket[];
  max: number;
  target: number;
  ceiling: number;
}) {
  if (buckets.length === 0 || max === 0) {
    return (
      <p className="text-sm text-muted-foreground">No usage in the window yet.</p>
    );
  }
  const W = 600;
  const H = 120;
  const stepX = buckets.length > 1 ? W / (buckets.length - 1) : 0;
  const yOf = (v: number) => H - (v / max) * H;
  const points = buckets
    .map((b, i) => `${(i * stepX).toFixed(2)},${yOf(b.cpaudUsd).toFixed(2)}`)
    .join(" ");
  const targetY = yOf(target);
  const ceilingY = yOf(ceiling);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-32 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="CPAUD by day"
    >
      <line
        x1="0"
        x2={W}
        y1={ceilingY}
        y2={ceilingY}
        stroke="currentColor"
        className="text-rose-500/40"
        strokeDasharray="4 4"
      />
      <line
        x1="0"
        x2={W}
        y1={targetY}
        y2={targetY}
        stroke="currentColor"
        className="text-amber-300/40"
        strokeDasharray="4 4"
      />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-cyan-400"
      />
      {buckets.map((b, i) => (
        <circle
          key={b.day}
          cx={(i * stepX).toFixed(2)}
          cy={yOf(b.cpaudUsd).toFixed(2)}
          r="2.5"
          className={cn(
            b.cpaudUsd > ceiling
              ? "fill-rose-500"
              : b.cpaudUsd > target
              ? "fill-amber-300"
              : "fill-cyan-400",
          )}
        >
          <title>{`${b.day}: ${fmtUsd(b.cpaudUsd)} (DAU ${b.dau})`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Suppress unused-var warning for badge-color map (kept for future per-badge
// stacked spark; the table above uses inline conditional class).
void BADGE_COLOR;

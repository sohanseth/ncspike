import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/workspace/usage")({
  component: UsagePage,
  head: () => ({
    meta: [
      { title: "Usage — Settings" },
      { name: "description", content: "Monthly inference and audio usage with soft cap." },
    ],
  }),
});

const SOFT_CAP_USD = 30;
const MICRO = 1_000_000;

interface UsageRow {
  cost_micro_usd: number | null;
  audio_micro_usd: number | null;
  badge: string;
  started_at: string;
}

function UsagePage() {
  const { user, loading } = useAuth();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    if (!user) return;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    void (async () => {
      setFetching(true);
      const { data } = await supabase
        .from("inference_usage")
        .select("cost_micro_usd, audio_micro_usd, badge, started_at")
        .gte("started_at", monthStart.toISOString())
        .order("started_at", { ascending: false })
        .limit(1000);
      setRows((data ?? []) as UsageRow[]);
      setFetching(false);
    })();
  }, [user]);

  const { llmUsd, audioUsd, totalUsd, byBadge } = useMemo(() => {
    let llm = 0;
    let audio = 0;
    const badges: Record<string, number> = {};
    for (const r of rows) {
      const l = (r.cost_micro_usd ?? 0) / MICRO;
      const a = (r.audio_micro_usd ?? 0) / MICRO;
      llm += l;
      audio += a;
      badges[r.badge] = (badges[r.badge] ?? 0) + l + a;
    }
    return { llmUsd: llm, audioUsd: audio, totalUsd: llm + audio, byBadge: badges };
  }, [rows]);

  const pct = Math.min(100, (totalUsd / SOFT_CAP_USD) * 100);
  const overCap = totalUsd > SOFT_CAP_USD;

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl">Usage</h1>
            <p className="text-sm text-muted-foreground">
              Month-to-date inference and audio spend across all providers.
            </p>
          </div>
          <Link to="/workspace" className="text-sm text-primary hover:underline">
            ← Back
          </Link>
        </header>

        <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <div className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                Monthly soft cap
              </div>
              <div className="font-display text-3xl">
                ${totalUsd.toFixed(2)}
                <span className="text-base text-muted-foreground"> / ${SOFT_CAP_USD}</span>
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>LLM ${llmUsd.toFixed(2)}</div>
              <div>Audio ${audioUsd.toFixed(2)}</div>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full transition-all",
                overCap ? "bg-amber-400" : "bg-gradient-to-r from-primary to-cyan-400",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          {overCap && (
            <p className="mt-3 text-xs text-amber-300">
              You've passed your soft cap. Premium tiers continue to work — raise the cap in
              settings if you'd like to silence this notice.
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
          <h2 className="mb-3 font-display text-lg">By badge</h2>
          {fetching ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : Object.keys(byBadge).length === 0 ? (
            <p className="text-sm text-muted-foreground">No usage yet this month.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {Object.entries(byBadge)
                .sort((a, b) => b[1] - a[1])
                .map(([badge, usd]) => (
                  <li key={badge} className="flex items-center justify-between">
                    <span className="font-mono text-xs uppercase">{badge}</span>
                    <span className="tabular-nums">${usd.toFixed(2)}</span>
                  </li>
                ))}
            </ul>
          )}
        </section>

        <p className="text-xs text-muted-foreground">
          Soft cap is informational. Hard limits and per-tier daily caps continue to apply per
          Phase 2.6 policy.
        </p>
      </div>
    </div>
  );
}

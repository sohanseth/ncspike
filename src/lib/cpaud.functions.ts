/**
 * CPAUD viewer — internal cost-per-active-user-per-day surface.
 *
 * Spec docs/05-spec-phase-2.6-chat-providers.md §2:
 *   target ≤ $0.30 / user / day, hard ceiling $1.50 / user / day,
 *   OSS share (T0 + T1) ≥ 65 %.
 *
 * This is a READ-ONLY admin surface. It never returns prompt or response
 * text — only aggregate counts, token sums, latency, and cost in micro-USD.
 * Source data: `inference_usage` (raw, kept 30 days). 14-day window fits.
 *
 * Auth: standard Supabase auth middleware + a comma-separated env
 * allowlist `CPAUD_VIEWER_USER_IDS`. Unset → no one can view.
 * The allowlist is checked server-side; the route component only
 * surfaces the typed error.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PROVIDER_TIERS, type ProviderId } from "@/lib/provider-tiers";
import type { Badge } from "@/server/inference/router";

export const CPAUD_TARGET_USD = 0.3;
export const CPAUD_CEILING_USD = 1.5;
export const OSS_SHARE_TARGET_PCT = 65;
export const WINDOW_DAYS = 14;
const MICRO = 1_000_000;

export class NotAuthorizedError extends Error {
  constructor() {
    super("Not authorized to view CPAUD.");
    this.name = "NotAuthorizedError";
  }
}

/** T0 + T1 are considered OSS-friendly tiers for the §2 guardrail. */
function isOss(provider: string): boolean {
  const t = (PROVIDER_TIERS as Record<string, number | undefined>)[provider];
  return t === 0 || t === 1;
}

function isAllowed(userId: string): boolean {
  const raw = process.env.CPAUD_VIEWER_USER_IDS ?? "";
  const allow = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(userId);
}

export type DayBucket = {
  /** ISO date YYYY-MM-DD (UTC). */
  day: string;
  /** Distinct user_id count with at least one `ok` row that day. */
  dau: number;
  /** Total cost in USD across all `ok` rows that day. */
  totalUsd: number;
  /** totalUsd / dau, or 0 when dau === 0. */
  cpaudUsd: number;
  /** OSS-tier share of cost that day, 0..100 (or 0 when totalUsd === 0). */
  ossSharePct: number;
  /** Per-badge cost USD that day. */
  costByBadge: Record<Badge, number>;
  /** Per-badge ok-request count that day. */
  countByBadge: Record<Badge, number>;
  /** Total on-device image turns blocked by the safety classifier that day. */
  imageBlockedCount: number;
  /**
   * On-device image turns blocked by the safety classifier that day, split by
   * `inference_usage.model_used` (the adapter id, e.g. `webgpu-sd-turbo`).
   * `unknown` is used when the row's `model_used` is null.
   */
  imageBlockedByAdapter: Record<string, number>;
};

/**
 * Aggregate "image blocked by the on-device safety classifier" telemetry for
 * the same window the CPAUD report covers. Sourced from `inference_usage`
 * rows with `status='error'` and `metadata->>'image_blocked' = 'true'` —
 * Task #32 stamps the metadata; this surface just reads it.
 */
export type ImageBlockedSummary = {
  /** Window total across all adapters. */
  windowTotal: number;
  /** Window totals per `model_used` (adapter id), `unknown` for null. */
  byAdapter: Record<string, number>;
};

export type CpaudReport = {
  windowDays: number;
  generatedAt: string;
  thresholds: {
    targetUsd: number;
    ceilingUsd: number;
    ossSharePct: number;
  };
  totals: {
    totalUsd: number;
    okRequests: number;
    distinctUsers: number;
    avgCpaudUsd: number;
    ossSharePct: number;
  };
  buckets: DayBucket[];
  imageBlocked: ImageBlockedSummary;
};

const EMPTY_BADGE_COST: Record<Badge, number> = {
  flash: 0,
  pro: 0,
  genius: 0,
  private: 0,
};
const EMPTY_BADGE_COUNT: Record<Badge, number> = {
  flash: 0,
  pro: 0,
  genius: 0,
  private: 0,
};

/**
 * Pure handler — exported for testability. The server-fn just resolves
 * the caller's userId, runs the allowlist check, and forwards.
 */
export async function buildCpaudReportFor(callerUserId: string): Promise<CpaudReport> {
  if (!isAllowed(callerUserId)) throw new NotAuthorizedError();

  const now = new Date();
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - WINDOW_DAYS);
  since.setUTCHours(0, 0, 0, 0);

  // Page through rows so a busy 14-day window doesn't get truncated by the
  // default 1k limit. Cost & badge & provider only — never prompt/response.
  const PAGE = 1000;
  type Row = {
    user_id: string;
    badge: Badge;
    provider_used: string;
    cost_micro_usd: number | null;
    started_at: string;
  };
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("inference_usage")
      .select("user_id, badge, provider_used, cost_micro_usd, started_at")
      .eq("status", "ok")
      .gte("started_at", since.toISOString())
      .order("started_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Bucket by UTC date. Pre-seed the 14 buckets so the sparkline has a flat
  // baseline on idle days.
  const buckets = new Map<string, DayBucket>();
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(since);
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, {
      day: key,
      dau: 0,
      totalUsd: 0,
      cpaudUsd: 0,
      ossSharePct: 0,
      costByBadge: { ...EMPTY_BADGE_COST },
      countByBadge: { ...EMPTY_BADGE_COUNT },
      imageBlockedCount: 0,
      imageBlockedByAdapter: {},
    });
  }
  const dauPerDay = new Map<string, Set<string>>();
  const ossUsdPerDay = new Map<string, number>();

  for (const r of rows) {
    const day = r.started_at.slice(0, 10);
    let b = buckets.get(day);
    if (!b) {
      // Drift safety: if a row's UTC date falls outside the seeded 14-day
      // range (clock skew, DST edge), append a fresh bucket so it isn't lost.
      b = {
        day,
        dau: 0,
        totalUsd: 0,
        cpaudUsd: 0,
        ossSharePct: 0,
        costByBadge: { ...EMPTY_BADGE_COST },
        countByBadge: { ...EMPTY_BADGE_COUNT },
        imageBlockedCount: 0,
        imageBlockedByAdapter: {},
      };
      buckets.set(day, b);
    }
    const usd = (r.cost_micro_usd ?? 0) / MICRO;
    b.totalUsd += usd;
    b.costByBadge[r.badge] = (b.costByBadge[r.badge] ?? 0) + usd;
    b.countByBadge[r.badge] = (b.countByBadge[r.badge] ?? 0) + 1;

    if (!dauPerDay.has(day)) dauPerDay.set(day, new Set());
    dauPerDay.get(day)!.add(r.user_id);

    if (isOss(r.provider_used)) {
      ossUsdPerDay.set(day, (ossUsdPerDay.get(day) ?? 0) + usd);
    }
  }

  // Finalize per-day derived fields.
  for (const [day, b] of buckets) {
    b.dau = dauPerDay.get(day)?.size ?? 0;
    b.cpaudUsd = b.dau === 0 ? 0 : b.totalUsd / b.dau;
    const oss = ossUsdPerDay.get(day) ?? 0;
    b.ossSharePct = b.totalUsd === 0 ? 0 : (oss / b.totalUsd) * 100;
  }

  // Image-blocked telemetry. Same window, but pulls from the
  // `metadata.image_blocked = true` rows that the on-device dispatcher
  // stamps when the safety classifier refuses a generated image. These
  // rows have `status='error'` so they're excluded from the cost-bucket
  // pass above by design (`error` rows don't debit caps and don't count
  // toward CPAUD). We aggregate them as a separate pass keyed by
  // `model_used` (adapter id) so ops can spot which adapter is producing
  // the most refusals.
  type BlockedRow = {
    model_used: string | null;
    started_at: string;
  };
  const blockedRows: BlockedRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("inference_usage")
      .select("model_used, started_at")
      .eq("status", "error")
      .eq("metadata->>image_blocked", "true")
      .gte("started_at", since.toISOString())
      .order("started_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as BlockedRow[];
    blockedRows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const imageBlocked: ImageBlockedSummary = {
    windowTotal: blockedRows.length,
    byAdapter: {},
  };
  for (const r of blockedRows) {
    const adapter = r.model_used ?? "unknown";
    imageBlocked.byAdapter[adapter] = (imageBlocked.byAdapter[adapter] ?? 0) + 1;
    const day = r.started_at.slice(0, 10);
    let b = buckets.get(day);
    if (!b) {
      b = {
        day,
        dau: 0,
        totalUsd: 0,
        cpaudUsd: 0,
        ossSharePct: 0,
        costByBadge: { ...EMPTY_BADGE_COST },
        countByBadge: { ...EMPTY_BADGE_COUNT },
        imageBlockedCount: 0,
        imageBlockedByAdapter: {},
      };
      buckets.set(day, b);
    }
    b.imageBlockedCount += 1;
    b.imageBlockedByAdapter[adapter] =
      (b.imageBlockedByAdapter[adapter] ?? 0) + 1;
  }

  const orderedBuckets = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));

  // Window totals.
  const totalUsd = orderedBuckets.reduce((s, b) => s + b.totalUsd, 0);
  const okRequests = rows.length;
  const distinctUsers = new Set(rows.map((r) => r.user_id)).size;
  const ossUsd = [...ossUsdPerDay.values()].reduce((s, v) => s + v, 0);
  const sumCpaud = orderedBuckets.reduce((s, b) => s + b.cpaudUsd, 0);
  // Average across days that had any DAU (avoids dragging the mean toward 0
  // on idle days, which would mask a bad day).
  const activeDays = orderedBuckets.filter((b) => b.dau > 0).length;
  const avgCpaudUsd = activeDays === 0 ? 0 : sumCpaud / activeDays;

  return {
    windowDays: WINDOW_DAYS,
    generatedAt: now.toISOString(),
    thresholds: {
      targetUsd: CPAUD_TARGET_USD,
      ceilingUsd: CPAUD_CEILING_USD,
      ossSharePct: OSS_SHARE_TARGET_PCT,
    },
    totals: {
      totalUsd,
      okRequests,
      distinctUsers,
      avgCpaudUsd,
      ossSharePct: totalUsd === 0 ? 0 : (ossUsd / totalUsd) * 100,
    },
    buckets: orderedBuckets,
    imageBlocked,
  };
}

export const getCpaudReport = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(({ context }): Promise<CpaudReport> => buildCpaudReportFor(context.userId));

/**
 * Task #50 — ops alert when on-device image refusals spike unexpectedly.
 *
 * Task #48 added a passive 14-day view of safety-classifier refusals on
 * the internal CPAUD page. That's polling. This module adds a push:
 * the nightly research cron (src/server/research-cron.ts → sweepRetention's
 * sibling) calls `runImageBlockedAlertCheck()` and, when the rolling 24h
 * count of `metadata.image_blocked = true` rows for any adapter exceeds
 * a configurable per-adapter threshold, posts a Slack-compatible
 * incoming-webhook notification to `OPS_ALERT_WEBHOOK_URL`.
 *
 * Configuration (all env, no hardcoded thresholds per replit.md):
 *
 *   IMAGE_BLOCKED_ALERT_THRESHOLDS
 *     Per-adapter threshold map, e.g.
 *       webgpu-sd-turbo=20,coreml-sd=10,mediapipe-img=10
 *     Adapter ids match `inference_usage.model_used`. The literal
 *     `unknown` key applies to rows whose `model_used` is null.
 *
 *   IMAGE_BLOCKED_ALERT_DEFAULT_THRESHOLD
 *     Optional fallback threshold for adapters not listed above. If unset,
 *     unlisted adapters never alert (fail-quiet on config gap, since this
 *     is an alerting surface, not a security boundary).
 *
 *   OPS_ALERT_WEBHOOK_URL
 *     Slack-compatible incoming webhook. If unset, the check still runs
 *     and logs would-be alerts but performs no network call. This keeps
 *     the cron loop honest in environments without webhook plumbing.
 *
 * Window is the rolling 24h prior to "now" — matches the spec language
 * ("more than N blocked turns from one adapter in 24h") and means a spike
 * is caught the next time the cron runs after it crosses the threshold.
 *
 * Never throws to the cron caller. All Supabase / fetch failures are
 * logged and swallowed; alerting must not be able to take down the
 * retention sweep.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { scrubErrorMessage } from "@/server/agents/error-scrub";

export type AdapterAlert = {
  adapter: string;
  count: number;
  threshold: number;
};

export type ImageBlockedAlertResult = {
  windowHours: number;
  /** Counts for every adapter seen in the window, including under-threshold. */
  countsByAdapter: Record<string, number>;
  /** Adapters whose count exceeded their threshold. */
  alerts: AdapterAlert[];
  /** True when a webhook POST was attempted (regardless of HTTP status). */
  webhookAttempted: boolean;
  /** True when the webhook returned a 2xx. */
  webhookDelivered: boolean;
};

const WINDOW_HOURS = 24;

function parseThresholds(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = Number.parseInt(pair.slice(eq + 1).trim(), 10);
    if (!key || !Number.isFinite(val) || val < 0) continue;
    out[key] = val;
  }
  return out;
}

function parseDefaultThreshold(raw: string | undefined): number | null {
  if (!raw) return null;
  const v = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * Pure decision step — exported for testability. Given counts and config,
 * return the alert list. No I/O.
 */
export function decideImageBlockedAlerts(
  counts: Record<string, number>,
  perAdapter: Record<string, number>,
  defaultThreshold: number | null,
): AdapterAlert[] {
  const alerts: AdapterAlert[] = [];
  for (const [adapter, count] of Object.entries(counts)) {
    const t =
      adapter in perAdapter ? perAdapter[adapter] : defaultThreshold;
    if (t === null || t === undefined) continue;
    if (count > t) alerts.push({ adapter, count, threshold: t });
  }
  // Stable order so the webhook payload (and tests) are deterministic.
  alerts.sort((a, b) => a.adapter.localeCompare(b.adapter));
  return alerts;
}

function formatSlackPayload(
  alerts: AdapterAlert[],
  windowHours: number,
): { text: string } {
  const lines = alerts
    .map(
      (a) =>
        `• \`${a.adapter}\`: ${a.count} blocked in last ${windowHours}h (threshold ${a.threshold})`,
    )
    .join("\n");
  return {
    text: `:rotating_light: On-device image refusals spiked\n${lines}`,
  };
}

async function postWebhook(url: string, body: unknown): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch (e) {
    console.warn("[cpaud-alerts] webhook POST threw:", scrubErrorMessage(e));
    return false;
  }
}

/**
 * Query the rolling-24h image-blocked counts per adapter. Pulled out so
 * tests can stub a tiny in-memory implementation without touching the
 * supabase client.
 */
export async function fetchRecentBlockedCounts(
  windowHours: number = WINDOW_HOURS,
): Promise<Record<string, number>> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const PAGE = 1000;
  const counts: Record<string, number> = {};
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("inference_usage")
      .select("model_used")
      .eq("status", "error")
      .eq("metadata->>image_blocked", "true")
      .gte("started_at", since)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as Array<{ model_used: string | null }>;
    for (const r of batch) {
      const adapter = r.model_used ?? "unknown";
      counts[adapter] = (counts[adapter] ?? 0) + 1;
    }
    if (batch.length < PAGE) break;
  }
  return counts;
}

/**
 * Cron-callable entry point. Best-effort: never throws.
 *
 * `opts.fetchCounts` is a seam for tests — the cron always calls with no
 * arguments and uses the real supabase-backed fetcher.
 */
export async function runImageBlockedAlertCheck(
  opts: { fetchCounts?: (windowHours: number) => Promise<Record<string, number>> } = {},
): Promise<ImageBlockedAlertResult> {
  const fetchCounts = opts.fetchCounts ?? fetchRecentBlockedCounts;
  const empty: ImageBlockedAlertResult = {
    windowHours: WINDOW_HOURS,
    countsByAdapter: {},
    alerts: [],
    webhookAttempted: false,
    webhookDelivered: false,
  };

  let counts: Record<string, number>;
  try {
    counts = await fetchCounts(WINDOW_HOURS);
  } catch (e) {
    console.warn("[cpaud-alerts] count query failed:", scrubErrorMessage(e));
    return empty;
  }

  const perAdapter = parseThresholds(
    process.env.IMAGE_BLOCKED_ALERT_THRESHOLDS,
  );
  const defaultThreshold = parseDefaultThreshold(
    process.env.IMAGE_BLOCKED_ALERT_DEFAULT_THRESHOLD,
  );
  const alerts = decideImageBlockedAlerts(counts, perAdapter, defaultThreshold);

  if (alerts.length === 0) {
    return { ...empty, countsByAdapter: counts };
  }

  const webhook = process.env.OPS_ALERT_WEBHOOK_URL;
  let attempted = false;
  let delivered = false;
  if (webhook) {
    attempted = true;
    delivered = await postWebhook(webhook, formatSlackPayload(alerts, WINDOW_HOURS));
    if (!delivered) {
      console.warn(
        `[cpaud-alerts] webhook returned non-2xx for ${alerts.length} adapter(s)`,
      );
    }
  } else {
    console.log(
      `[cpaud-alerts] would alert (no OPS_ALERT_WEBHOOK_URL): ${alerts
        .map((a) => `${a.adapter}=${a.count}/${a.threshold}`)
        .join(" ")}`,
    );
  }

  return {
    windowHours: WINDOW_HOURS,
    countsByAdapter: counts,
    alerts,
    webhookAttempted: attempted,
    webhookDelivered: delivered,
  };
}

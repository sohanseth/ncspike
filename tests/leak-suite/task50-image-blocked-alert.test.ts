/**
 * Task #50 — pin the on-device image-refusal spike alert.
 *
 * Three invariants:
 *   1. Pure decision: counts > per-adapter threshold trigger; counts ≤
 *      threshold do not; adapters with no configured threshold (and no
 *      default) never trigger.
 *   2. Threshold parsing tolerates whitespace and rejects malformed pairs.
 *   3. End-to-end runImageBlockedAlertCheck POSTs to OPS_ALERT_WEBHOOK_URL
 *      only when at least one adapter exceeds threshold, and the payload
 *      mentions every alerting adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {},
}));

import {
  decideImageBlockedAlerts,
  runImageBlockedAlertCheck,
} from "@/server/cpaud-alerts";

const counts = { __value: {} as Record<string, number> };
const fetchCounts = async () => counts.__value;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  counts.__value = {};
  delete process.env.IMAGE_BLOCKED_ALERT_THRESHOLDS;
  delete process.env.IMAGE_BLOCKED_ALERT_DEFAULT_THRESHOLD;
  delete process.env.OPS_ALERT_WEBHOOK_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("decideImageBlockedAlerts", () => {
  it("alerts only when count strictly exceeds the per-adapter threshold", () => {
    const out = decideImageBlockedAlerts(
      { "webgpu-sd-turbo": 21, "coreml-sd": 10, "mediapipe-img": 3 },
      { "webgpu-sd-turbo": 20, "coreml-sd": 10, "mediapipe-img": 5 },
      null,
    );
    expect(out).toEqual([
      { adapter: "webgpu-sd-turbo", count: 21, threshold: 20 },
    ]);
  });

  it("falls back to the default threshold for unlisted adapters", () => {
    const out = decideImageBlockedAlerts(
      { "new-adapter": 8, "configured": 1 },
      { "configured": 100 },
      5,
    );
    expect(out).toEqual([
      { adapter: "new-adapter", count: 8, threshold: 5 },
    ]);
  });

  it("never alerts when no per-adapter or default threshold applies", () => {
    const out = decideImageBlockedAlerts(
      { "stranger": 9999 },
      { "other": 1 },
      null,
    );
    expect(out).toEqual([]);
  });

  it("treats threshold=0 as 'any nonzero count alerts' (not 'never')", () => {
    const out = decideImageBlockedAlerts(
      { "a": 1, "b": 0 },
      { "a": 0, "b": 0 },
      null,
    );
    expect(out).toEqual([{ adapter: "a", count: 1, threshold: 0 }]);
  });
});

describe("runImageBlockedAlertCheck", () => {
  it("does not POST when no adapter exceeds threshold", async () => {
    counts.__value = { "webgpu-sd-turbo": 5 };
    process.env.IMAGE_BLOCKED_ALERT_THRESHOLDS = "webgpu-sd-turbo=20";
    process.env.OPS_ALERT_WEBHOOK_URL = "https://hooks.example/abc";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const r = await runImageBlockedAlertCheck({ fetchCounts });
    expect(r.alerts).toEqual([]);
    expect(r.webhookAttempted).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs a Slack-shaped payload when an adapter exceeds threshold", async () => {
    counts.__value = { "webgpu-sd-turbo": 50, "coreml-sd": 2 };
    process.env.IMAGE_BLOCKED_ALERT_THRESHOLDS =
      " webgpu-sd-turbo = 20 , coreml-sd=10 ";
    process.env.OPS_ALERT_WEBHOOK_URL = "https://hooks.example/abc";

    let captured: { url: string; body: string } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      captured = { url: String(url), body: String(init?.body ?? "") };
      return new Response("ok", { status: 200 });
    });

    const r = await runImageBlockedAlertCheck({ fetchCounts });
    expect(r.alerts.map((a) => a.adapter)).toEqual(["webgpu-sd-turbo"]);
    expect(r.webhookAttempted).toBe(true);
    expect(r.webhookDelivered).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://hooks.example/abc");
    const body = JSON.parse(captured!.body) as { text: string };
    expect(body.text).toContain("webgpu-sd-turbo");
    expect(body.text).toContain("50");
    expect(body.text).toContain("20");
    expect(body.text).not.toContain("coreml-sd"); // under threshold
  });

  it("uses the default threshold for unlisted adapters", async () => {
    counts.__value = { "brand-new-adapter": 12 };
    process.env.IMAGE_BLOCKED_ALERT_DEFAULT_THRESHOLD = "5";
    process.env.OPS_ALERT_WEBHOOK_URL = "https://hooks.example/abc";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const r = await runImageBlockedAlertCheck({ fetchCounts });
    expect(r.alerts).toEqual([
      { adapter: "brand-new-adapter", count: 12, threshold: 5 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("computes alerts but skips POST when OPS_ALERT_WEBHOOK_URL is unset", async () => {
    counts.__value = { "webgpu-sd-turbo": 99 };
    process.env.IMAGE_BLOCKED_ALERT_THRESHOLDS = "webgpu-sd-turbo=10";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const r = await runImageBlockedAlertCheck({ fetchCounts });
    expect(r.alerts).toHaveLength(1);
    expect(r.webhookAttempted).toBe(false);
    expect(r.webhookDelivered).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never throws when the webhook fetch rejects", async () => {
    counts.__value = { "webgpu-sd-turbo": 99 };
    process.env.IMAGE_BLOCKED_ALERT_THRESHOLDS = "webgpu-sd-turbo=10";
    process.env.OPS_ALERT_WEBHOOK_URL = "https://hooks.example/abc";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));

    const r = await runImageBlockedAlertCheck({ fetchCounts });
    expect(r.alerts).toHaveLength(1);
    expect(r.webhookAttempted).toBe(true);
    expect(r.webhookDelivered).toBe(false);
  });
});

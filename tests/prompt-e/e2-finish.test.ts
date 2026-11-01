import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { voiceDraftsNeedsConsent } from "@/lib/voice-drafts-consent";
import { withEmailAiConsent } from "@/lib/email-ai-consent";

// ── Voice Drafts dialog: tied to email_ai, not only voice_drafts_consent_at ──

describe("Voice Drafts consent dialog", () => {
  it("shows when email_ai is off even though voice_drafts_consent_at is set", () => {
    expect(voiceDraftsNeedsConsent({ consented: true, emailAiOn: false })).toBe(true);
  });
  it("stays hidden when both the old consent and email_ai are in place", () => {
    expect(voiceDraftsNeedsConsent({ consented: true, emailAiOn: true })).toBe(false);
  });
  it("shows when neither is in place, and while the status is still loading", () => {
    expect(voiceDraftsNeedsConsent({ consented: false, emailAiOn: true })).toBe(true);
    expect(voiceDraftsNeedsConsent(null)).toBe(true);
  });
});

// ── Context on this sender / Research overnight: email_ai consent card ──

describe("email_ai consent gate for Context on this sender and Research overnight", () => {
  it("does nothing when the person chooses Not now", async () => {
    let ran = false;
    const ok = await withEmailAiConsent(async () => false, () => { ran = true; });
    expect(ok).toBe(false);
    expect(ran).toBe(false);
  });
  it("carries on with the action after Turn on", async () => {
    let ran = false;
    const ok = await withEmailAiConsent(async () => true, () => { ran = true; });
    expect(ok).toBe(true);
    expect(ran).toBe(true);
  });
  it("runs at once when the feature is already on (ensure resolves true)", async () => {
    let asked = 0;
    let ran = false;
    await withEmailAiConsent(async () => { asked++; return true; }, () => { ran = true; });
    expect(asked).toBe(1);
    expect(ran).toBe(true);
  });
});

// ── One-time notice: dismissed on the account, across devices ──

let settingsRow: Record<string, unknown> | null = null;
let upserts: Array<Record<string, unknown>> = [];

vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "order", "limit"]) chain[k] = () => chain;
  chain.maybeSingle = async () => ({ data: settingsRow, error: null });
  chain.upsert = async (patch: Record<string, unknown>) => {
    upserts.push(patch);
    settingsRow = { ...(settingsRow ?? {}), ...patch };
    return { error: null };
  };
  return { supabaseAdmin: chain };
});

describe("private-by-default notice dismissal", () => {
  beforeEach(() => {
    settingsRow = null;
    upserts = [];
  });

  it("shows for an existing user who has not dismissed it", async () => {
    settingsRow = {
      created_at: "2026-01-01T00:00:00Z",
      private_default_applied_at: "2026-10-17T00:00:00Z",
      private_notice_dismissed_at: null,
    };
    const m = await import("@/server/cloud-features.server");
    expect((await m.getPrivateDefaultNoticeFor("u1")).show).toBe(true);
  });

  it("stays dismissed on a second browser once dismissed on the account", async () => {
    settingsRow = {
      created_at: "2026-01-01T00:00:00Z",
      private_default_applied_at: "2026-10-17T00:00:00Z",
      private_notice_dismissed_at: null,
    };
    const m = await import("@/server/cloud-features.server");
    expect((await m.getPrivateDefaultNoticeFor("u1")).show).toBe(true);
    await m.dismissPrivateDefaultNoticeFor("u1");
    expect(upserts).toHaveLength(1);
    expect(typeof upserts[0].private_notice_dismissed_at).toBe("string");
    // Second browser: no localStorage copy, server says dismissed.
    expect((await m.getPrivateDefaultNoticeFor("u1")).show).toBe(false);
  });

  it("never shows for accounts created after the switch", async () => {
    settingsRow = {
      created_at: "2026-10-17T00:00:00Z",
      private_default_applied_at: "2026-10-17T00:00:00Z",
      private_notice_dismissed_at: null,
    };
    const m = await import("@/server/cloud-features.server");
    expect((await m.getPrivateDefaultNoticeFor("u1")).show).toBe(false);
  });
});

// ── Consent card contrast: body text >= 4.5:1 against its surface ──

type Rgb = { r: number; g: number; b: number };

function oklchToLinearSrgb(L: number, C: number, H: number): Rgb {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return {
    r: alpha * fg.r + (1 - alpha) * bg.r,
    g: alpha * fg.g + (1 - alpha) * bg.g,
    b: alpha * fg.b + (1 - alpha) * bg.b,
  };
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function parseOklch(block: string, name: string): Rgb {
  const m = block.match(new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`));
  if (!m) throw new Error(`--${name} not found as oklch()`);
  return oklchToLinearSrgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
}

describe("consent card theme and contrast", () => {
  const css = readFileSync(resolve(__dirname, "../../src/styles.css"), "utf8");
  const sheetSrc = readFileSync(
    resolve(__dirname, "../../src/components/workspace/CloudFeatureSheet.tsx"),
    "utf8",
  );
  const sectionSrc = readFileSync(
    resolve(__dirname, "../../src/components/workspace/CloudFeaturesSection.tsx"),
    "utf8",
  );

  it("uses the app's glass-elevated dialog surface with foreground body text", () => {
    expect(sheetSrc).toContain("glass-elevated");
    expect(sheetSrc).toContain("text-foreground/90");
    // The turn-off confirmation on the Privacy page matches.
    expect(sectionSrc).toContain("glass-elevated");
    expect(sectionSrc).toContain("text-foreground/90");
  });

  it("body text (foreground at 90%) has contrast >= 4.5:1 on the elevated surface", () => {
    const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
    expect(root).toBeTruthy();
    const fg = parseOklch(root![1], "foreground");
    const surface = parseOklch(root![1], "surface-elevated");
    expect(contrast(blend(fg, surface, 0.9), surface)).toBeGreaterThanOrEqual(4.5);
    // Full-strength foreground (titles, strong lines) is even safer.
    expect(contrast(fg, surface)).toBeGreaterThanOrEqual(4.5);

    // If a dark theme is ever added, the same rule must hold there.
    const dark = css.match(/\.dark\s*\{([\s\S]*?)\n\}/);
    if (dark) {
      const dfg = parseOklch(dark[1], "foreground");
      const dsurface = parseOklch(dark[1], "surface-elevated");
      expect(contrast(blend(dfg, dsurface, 0.9), dsurface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

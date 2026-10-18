import { describe, it, expect, vi, beforeEach } from "vitest";

let row: unknown = null;
let fail = false;
vi.mock("@/integrations/supabase/client.server", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "select", "eq", "order", "limit"]) chain[k] = () => chain;
  chain.maybeSingle = async () => (fail ? { data: null, error: { message: "x" } } : { data: row, error: null });
  return { supabaseAdmin: chain };
});

describe("cloud feature guard", () => {
  beforeEach(() => { row = null; fail = false; });
  it("is off when there is no consent (private by default)", async () => {
    const m = await import("@/server/cloud-features.server");
    expect(await m.isCloudFeatureOn("u1", "cloud_chat")).toBe(false);
    await expect(m.requireCloudFeature("u1", "web_search")).rejects.toThrow("cloud_feature_off:web_search");
  });
  it("is off when the check itself fails (fail closed)", async () => {
    fail = true;
    const m = await import("@/server/cloud-features.server");
    expect(await m.isCloudFeatureOn("u1", "email_ai")).toBe(false);
  });
  it("is on only for the current wording", async () => {
    const { CLOUD_FEATURES } = await import("@/lib/cloud-features");
    const m = await import("@/server/cloud-features.server");
    row = { granted: true, wording_version: CLOUD_FEATURES.voice_replies.version };
    expect(await m.isCloudFeatureOn("u1", "voice_replies")).toBe(true);
    row = { granted: false, wording_version: CLOUD_FEATURES.voice_replies.version };
    expect(await m.isCloudFeatureOn("u1", "voice_replies")).toBe(false);
  });
  it("answers 403 cloud_feature_off for routes", async () => {
    const m = await import("@/server/cloud-features.server");
    const r = m.cloudFeatureOffResponse("voice_input");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: "cloud_feature_off", feature: "voice_input" });
  });
});

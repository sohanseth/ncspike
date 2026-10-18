// Cloud-feature RPCs. All logic lives in src/server/cloud-features.server.ts,
// loaded inside handlers so it never reaches the browser bundle.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { isCloudFeature, type CloudFeature } from "@/lib/cloud-features";

export type CloudFeatureState = {
  feature: CloudFeature;
  on: boolean;
  changedAt: string | null;
  agreedVersion: string | null;
  currentVersion: string;
};

export const getCloudFeatures = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ features: CloudFeatureState[] }> => {
    const { getCloudFeaturesFor } = await import("@/server/cloud-features.server");
    return { features: await getCloudFeaturesFor(context.userId) };
  });

export const setCloudFeature = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: { feature: string; granted: boolean; source: string; deleteCloudChats?: boolean }) => {
      if (!isCloudFeature(d.feature)) throw new Error("Invalid feature");
      if (typeof d.granted !== "boolean") throw new Error("Invalid granted");
      if (d.source !== "settings" && d.source !== "prompt" && d.source !== "preset") {
        throw new Error("Invalid source");
      }
      return {
        feature: d.feature as CloudFeature,
        granted: d.granted,
        source: d.source as "settings" | "prompt" | "preset",
        deleteCloudChats: d.deleteCloudChats === true,
      };
    },
  )
  .handler(async ({ data, context }): Promise<{ features: CloudFeatureState[] }> => {
    const { setCloudFeatureFor } = await import("@/server/cloud-features.server");
    const features = await setCloudFeatureFor(
      context.userId,
      data.feature,
      data.granted,
      data.source,
      { deleteCloudChats: data.deleteCloudChats },
    );
    return { features };
  });

export type CloudActivityDay = {
  day: string;
  entries: Array<{ feature: string; provider: string; count: number }>;
};

export const getCloudActivity = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const [act, usage, consents] = await Promise.all([
      db.from("cloud_activity").select("feature, provider, created_at").eq("user_id", context.userId).gte("created_at", since).limit(5000),
      db.from("inference_usage").select("badge, provider_used, started_at").eq("user_id", context.userId).gte("started_at", since).limit(5000),
      db.from("cloud_consents").select("feature, granted, wording_version, source, created_at").eq("user_id", context.userId).order("id", { ascending: false }).limit(500),
    ]);
    const buckets = new Map<string, Map<string, number>>();
    const add = (ts: string, feature: string, provider: string) => {
      const day = ts.slice(0, 10);
      const m = buckets.get(day) ?? new Map<string, number>();
      const k = `${feature}\u0000${provider}`;
      m.set(k, (m.get(k) ?? 0) + 1);
      buckets.set(day, m);
    };
    for (const r of (act.data ?? []) as Array<{ feature: string; provider: string; created_at: string }>) {
      add(r.created_at, r.feature, r.provider);
    }
    for (const r of (usage.data ?? []) as Array<{ badge: string | null; provider_used: string | null; started_at: string }>) {
      const p = r.provider_used ?? "";
      if (!p || r.badge === "private" || p.startsWith("on-device") || p === "device") continue;
      add(r.started_at, "cloud_chat", p);
    }
    const days: CloudActivityDay[] = [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([day, m]) => ({
        day,
        entries: [...m.entries()].map(([k, count]) => {
          const [feature, provider] = k.split("\u0000");
          return { feature, provider, count };
        }),
      }));
    return {
      days,
      consents: (consents.data ?? []) as Array<{
        feature: string;
        granted: boolean;
        wording_version: string;
        source: string;
        created_at: string;
      }>,
    };
  });

export const countPrivateServerChats = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const m = await import("@/server/cloud-features.server");
    return m.countPrivateServerChats(context.userId);
  });

export const deletePrivateServerChats = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const m = await import("@/server/cloud-features.server");
    return m.deletePrivateServerChats(context.userId);
  });

/** Has this person seen the one-time "private by default" notice? */
export const getPrivateDefaultNotice = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ show: boolean }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabaseAdmin as any)
      .from("user_settings")
      .select("private_default_applied_at, created_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!data?.private_default_applied_at || !data?.created_at) return { show: false };
    // Existing users: their row predates the switch to private-by-default.
    return { show: new Date(data.created_at).getTime() < new Date(data.private_default_applied_at).getTime() - 60_000 };
  });

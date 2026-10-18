import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { proposeFreeSlots } from "@/server/calendar.server";

export const testProposeSlots = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "calendar_on_server");
      void noteCloudActivity(context.userId, "calendar_on_server", "google-calendar");
    }
    const userId = (context as { userId: string }).userId;
    const slots = await proposeFreeSlots(userId);
    return { slots };
  });

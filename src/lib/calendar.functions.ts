import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { proposeFreeSlots } from "@/server/calendar.server";

export const testProposeSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const userId = (context as { userId: string }).userId;
    const slots = await proposeFreeSlots(userId);
    return { slots };
  });

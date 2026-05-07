import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { proposeFreeSlots } from "@/server/calendar.server";

<<<<<<< HEAD
export const testProposeSlots = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
=======
export const testProposeSlots = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
>>>>>>> c896469f48fc2604f7ea4fe774f3336d216bfad5
  .handler(async ({ context }) => {
    const userId = (context as { userId: string }).userId;
    const slots = await proposeFreeSlots(userId);
    return { slots };
  });

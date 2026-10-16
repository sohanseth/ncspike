import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";

export const createRelayPairingCode = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createPairingCodeFor } = await import("@/server/relay.server");
    return createPairingCodeFor(supabaseAdmin, context.userId);
  });
export const listRelayDevices = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listDevicesFor } = await import("@/server/relay.server");
    return listDevicesFor(supabaseAdmin, context.userId);
  });
export const revokeRelayDevice = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((id: string) => z.string().uuid().parse(id))
  .handler(async ({ context, data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { revokeDeviceFor } = await import("@/server/relay.server");
    return revokeDeviceFor(supabaseAdmin, context.userId, data);
  });
export const listRelayCards = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listCardsFor } = await import("@/server/relay.server");
    return listCardsFor(supabaseAdmin, context.userId);
  });
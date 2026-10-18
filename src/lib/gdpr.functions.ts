// Account export/delete RPCs. All logic lives in gdpr.server.ts, loaded inside handlers.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import type { AccountExport, AccountDeleteResult } from "./gdpr.server";
export type { AccountExport, AccountDeleteResult };

export const exportAccountData = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<AccountExport> => {
    const { exportAccountDataFor } = await import("./gdpr.server");
    return exportAccountDataFor(context.userId);
  });

export const deleteAccount = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<AccountDeleteResult> => {
    const authHeader = getRequest()?.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const { deleteAccountFor } = await import("./gdpr.server");
    return deleteAccountFor(context.userId, token);
  });

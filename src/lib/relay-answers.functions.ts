import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { relayAnswerSchema, type RelayAnswerInput } from "@/lib/relay-answer-schema";

export const sendRelayAnswer = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((input: RelayAnswerInput) => {
    const parsed = relayAnswerSchema.safeParse(input);
    if (!parsed.success) throw new Error("bad_answer");
    return parsed.data;
  })
  .handler(async ({ context, data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { sendRelayAnswerFor } = await import("@/server/relay-answers.server");
    return sendRelayAnswerFor(supabaseAdmin, context.userId, data);
  });
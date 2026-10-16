import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Only called after authenticated handlers verify the signed-in user. */
export async function macAgentIdsFor(userId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin.from("relay_missions").select("agent_id").eq("user_id", userId);
  if (error) throw new Error("Could not check Mac research ownership");
  return new Set((data ?? []).map((row) => row.agent_id));
}
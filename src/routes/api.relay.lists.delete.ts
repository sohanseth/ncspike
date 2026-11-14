import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/relay/lists/delete")({
  server: { handlers: { POST: async ({ request }) => {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return Response.json({ error: "Expected application/json" }, { status: 415 });
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { handleRelayLists } = await import("@/server/relay-lists.server");
      return handleRelayLists(request, supabaseAdmin, true);
    } catch { return Response.json({ error: "Connection temporarily unavailable" }, { status: 503 }); }
  } } },
});

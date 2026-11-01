import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/relay/answers")({
  server: { handlers: { POST: async ({ request }) => {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return Response.json({ error: "Expected application/json" }, { status: 415 });
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { handleRelayAnswers } = await import("@/server/relay-answers.server");
      return handleRelayAnswers(request, supabaseAdmin);
    } catch { return Response.json({ error: "Connection temporarily unavailable" }, { status: 503 }); }
  } } },
});
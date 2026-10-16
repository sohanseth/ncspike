import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/relay/claim")({
  server: { handlers: { POST: async ({ request }) => {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return Response.json({ error: "Expected application/json" }, { status: 415 });
    }
    try {
      const secret = process.env['SUPABASE_SERVICE_ROLE_KEY'];
      if (!secret) return Response.json({ error: "Connection temporarily unavailable" }, { status: 429 });
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { handleRelay } = await import("@/server/relay.server");
      return handleRelay(request, "claim", supabaseAdmin, secret);
    } catch {
      return Response.json({ error: "Connection temporarily unavailable" }, { status: 429 });
    }
  } } },
});

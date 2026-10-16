import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/relay/missions/delete")({
  server: { handlers: { POST: async ({ request }) => {
    const headers = { "Cache-Control": "no-store" };
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return Response.json({ error: "Expected application/json" }, { status: 415, headers });
    if (Number(request.headers.get("content-length")) > 16384) return Response.json({ error: "Body too large" }, { status: 413, headers });
    if (!/^Bearer [A-Za-z0-9_-]{32,512}$/.test(request.headers.get("authorization") ?? "")) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { handleRelayMission } = await import("@/server/relay-missions.server");
      return handleRelayMission(request, "delete", supabaseAdmin);
    } catch {
      return Response.json({ error: "Connection temporarily unavailable" }, { status: 503, headers });
    }
  } } },
});

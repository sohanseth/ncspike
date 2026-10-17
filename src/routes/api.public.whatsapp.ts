import { createFileRoute } from "@tanstack/react-router";

// WhatsApp inbound webhook — retired. The app sends through Lovable's
// connector, so this endpoint cannot verify that a request really came from
// Twilio. Rather than accept unverifiable webhooks, it answers 410 Gone to
// every request, calls nothing and logs nothing.
export const Route = createFileRoute("/api/public/whatsapp")({
  server: {
    handlers: {
      POST: async () =>
        new Response(JSON.stringify({ error: "gone" }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        }),
      GET: async () =>
        new Response(JSON.stringify({ error: "gone" }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        }),
    },
  },
});

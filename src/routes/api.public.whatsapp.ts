import { createFileRoute } from "@tanstack/react-router";

// Twilio inbound WhatsApp webhook.
// Configure this URL in Twilio Console (Messaging → Sandbox / Sender → "When a message comes in"):
//   POST https://<your-app>.lovable.app/api/public/whatsapp
// Twilio posts application/x-www-form-urlencoded.
export const Route = createFileRoute("/api/public/whatsapp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const form = await request.formData();
        const payload = {
          from: form.get("From")?.toString() ?? "",
          to: form.get("To")?.toString() ?? "",
          body: form.get("Body")?.toString() ?? "",
          messageSid: form.get("MessageSid")?.toString() ?? "",
          profileName: form.get("ProfileName")?.toString() ?? "",
        };
        console.log("[whatsapp:inbound]", payload);

        // TODO: persist to Inbox / Follow-ups once a database table exists.

        // Respond with empty TwiML so Twilio doesn't auto-reply.
        return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        });
      },
      GET: async () => new Response("WhatsApp webhook ready", { status: 200 }),
    },
  },
});

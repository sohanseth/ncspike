import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/twilio";

const SendSchema = z.object({
  to: z.string().min(5).max(20).regex(/^\+[0-9]+$/, "Use E.164 format, e.g. +15551234567"),
  body: z.string().min(1).max(1600),
});

export const sendWhatsApp = createServerFn({ method: "POST" })
  .inputValidator((input) => SendSchema.parse(input))
  .handler(async ({ data }) => {
    const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");
    const TWILIO_API_KEY = process.env.TWILIO_API_KEY;
    if (!TWILIO_API_KEY) throw new Error("TWILIO_API_KEY is not configured");

    const from = process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886"; // Twilio sandbox default

    const res = await fetch(`${GATEWAY_URL}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": TWILIO_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: `whatsapp:${data.to}`,
        From: from,
        Body: data.body,
      }),
    });

    const json = await res.json();
    if (!res.ok) {
      console.error("Twilio send failed", res.status, json);
      return { success: false as const, error: json?.message ?? `Twilio error ${res.status}` };
    }
    return { success: true as const, sid: json.sid as string };
  });

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * WhatsApp sending is retired. The app never shipped a WhatsApp feature that
 * uses this, and this function did not verify its caller — so instead of
 * leaving an unauthenticated sender lying around, it answers 410 Gone.
 * It calls nothing (no Twilio, no gateway) and logs nothing.
 */
const SendSchema = z.object({
  to: z.string().min(5).max(20).regex(/^\+[0-9]+$/, "Use E.164 format, e.g. +15551234567"),
  body: z.string().min(1).max(1600),
});

export const sendWhatsApp = createServerFn({ method: "POST" })
  .inputValidator((input) => SendSchema.parse(input))
  .handler(async () => {
    throw new Response(JSON.stringify({ error: "gone" }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  });

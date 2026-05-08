import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  authenticateAudioRequest,
  enforceAudioRateLimit,
  rateLimitResponse,
} from "@/server/audio-auth.server";

const Body = z.object({
  text: z.string().min(1).max(5000),
  voiceId: z.string().min(1).max(128),
  modelId: z.enum(["eleven_turbo_v2_5", "eleven_multilingual_v2"]).default("eleven_turbo_v2_5"),
});

/**
 * POST /api/tts/elevenlabs — proxies text to ElevenLabs and streams MP3 back.
 *
 * Auth: requires a Supabase Bearer token. Per-user rate limited via
 * `enforceAudioRateLimit('tts-elevenlabs')`. Closes P0 from handoff §10b.
 *
 * Privacy: audio bytes are never persisted server-side. The client wraps the
 * response in a Blob URL that lives only in memory.
 */
export const Route = createFileRoute("/api/tts/elevenlabs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAudioRequest(request);
        if (!auth.ok) return auth.response;

        const rl = await enforceAudioRateLimit(auth.userId, "tts-elevenlabs");
        if (!rl.ok) return rateLimitResponse(rl);

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: "ELEVENLABS_API_KEY not configured" }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }

        let body: z.infer<typeof Body>;
        try {
          body = Body.parse(await request.json());
        } catch (e) {
          return new Response(
            JSON.stringify({ error: "invalid body", detail: String(e).slice(0, 200) }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const url = `https://api.elevenlabs.io/v1/text-to-speech/${body.voiceId}/stream?output_format=mp3_44100_128`;
        const upstream = await fetch(url, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: body.text,
            model_id: body.modelId,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          const detail = await upstream.text().catch(() => "");
          return new Response(
            JSON.stringify({ error: `elevenlabs ${upstream.status}`, detail: detail.slice(0, 500) }),
            { status: 502, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "content-type": "audio/mpeg",
            "cache-control": "no-store",
          },
        });
      },
    },
  },
});

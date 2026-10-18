import { createFileRoute } from "@tanstack/react-router";
import {
  authenticateAudioRequest,
  enforceAudioRateLimit,
  rateLimitResponse,
} from "@/server/audio-auth.server";

/**
 * POST /api/stt/groq — proxies an audio blob to Groq Whisper.
 *
 * Auth: requires a Supabase Bearer token. Per-user rate limited via
 * `enforceAudioRateLimit('stt-groq')`. Closes P0 from handoff §10b.
 *
 * Privacy: the request body is forwarded to Groq verbatim and the response
 * is returned to the client. NOTHING is written to the database, storage, or
 * disk on this hop. If you change that, update
 * scripts/stt-no-persistence-guard.ts and the spec §V1.
 */
export const Route = createFileRoute("/api/stt/groq")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateAudioRequest(request);
        if (!auth.ok) return auth.response;

        {
          const cf = await import("@/server/cloud-features.server");
          if (!(await cf.isCloudFeatureOn(auth.userId, "voice_input"))) {
            return cf.cloudFeatureOffResponse("voice_input");
          }
          void cf.noteCloudActivity(auth.userId, "voice_input", "groq");
        }

        const rl = await enforceAudioRateLimit(auth.userId, "stt-groq");
        if (!rl.ok) return rateLimitResponse(rl);

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
          return new Response(
            JSON.stringify({ error: "GROQ_API_KEY not configured" }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }

        let incoming: FormData;
        try {
          incoming = await request.formData();
        } catch {
          return new Response(
            JSON.stringify({ error: "expected multipart/form-data" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }

        const audio = incoming.get("audio");
        if (!(audio instanceof Blob)) {
          return new Response(
            JSON.stringify({ error: "missing 'audio' file part" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        const language = incoming.get("language");

        const upstream = new FormData();
        upstream.append("file", audio, "utt.webm");
        upstream.append("model", "whisper-large-v3-turbo");
        upstream.append("response_format", "json");
        if (typeof language === "string" && language) {
          upstream.append("language", language.slice(0, 2));
        }

        const res = await fetch(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}` },
            body: upstream,
          },
        );

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          return new Response(
            JSON.stringify({ error: `groq ${res.status}`, detail: detail.slice(0, 500) }),
            { status: 502, headers: { "content-type": "application/json" } },
          );
        }
        const data = (await res.json()) as { text?: string };
        return new Response(
          JSON.stringify({ text: data.text ?? "", model: "whisper-large-v3-turbo" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

/**
 * POST /api/stt/groq — proxies an audio blob to Groq Whisper.
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
          // Groq expects ISO 639-1; clients pass ISO 639-3, so strip to first 2 chars best-effort.
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

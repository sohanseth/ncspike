/**
 * Shared bearer-token verifier + lightweight rate limit for the audio proxy
 * routes (`/api/stt/groq`, `/api/tts/elevenlabs`).
 *
 * These routes are server routes (`createFileRoute` with `server.handlers`),
 * so they can't use the function-style `requireSupabaseAuth` middleware. We
 * verify the Supabase JWT inline with the publishable key, then enforce a
 * per-user sliding-window cap via the existing `tool_invocations` table so a
 * compromised session can't burn the live Groq / ElevenLabs key.
 *
 * Closes P0 from docs/08-lovable-handoff-2.8.md §10b.
 */
import { createClient } from "@supabase/supabase-js";
import { enforceToolRateLimit, type RateLimitDecision } from "./rate-limit.server";

export type AudioAuthOk = { ok: true; userId: string };
export type AudioAuthErr = { ok: false; response: Response };

function jsonError(status: number, error: string, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function authenticateAudioRequest(
  request: Request,
): Promise<AudioAuthOk | AudioAuthErr> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    return { ok: false, response: jsonError(500, "auth not configured") };
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: jsonError(401, "missing bearer token") };
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) return { ok: false, response: jsonError(401, "empty bearer token") };

  const sb = createClient(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await sb.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return { ok: false, response: jsonError(401, "invalid token") };
  }
  return { ok: true, userId: data.claims.sub as string };
}

export async function enforceAudioRateLimit(
  userId: string,
  toolId: "stt-groq" | "tts-elevenlabs",
): Promise<RateLimitDecision> {
  return enforceToolRateLimit(userId, toolId);
}

export function rateLimitResponse(decision: Extract<RateLimitDecision, { ok: false }>): Response {
  return new Response(
    JSON.stringify({
      error: "rate limited",
      limit: decision.limit,
      windowSeconds: decision.windowSeconds,
      retryAfterSeconds: decision.retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(decision.retryAfterSeconds),
      },
    },
  );
}

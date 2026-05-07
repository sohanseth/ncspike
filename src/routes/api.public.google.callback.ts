import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { encryptToken, verifyState } from "@/server/crypto.server";

async function exchangeCode(code: string, redirectUri: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    id_token?: string;
  }>;
}

function decodeIdTokenEmail(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = idToken.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.email === "string" ? json.email : null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/public/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        const back = (status: "ok" | "error", msg?: string) =>
          new Response(null, {
            status: 302,
            headers: {
              Location: `/workspace/connections?connect=${status}${msg ? `&msg=${encodeURIComponent(msg)}` : ""}`,
            },
          });

        if (error) return back("error", error);
        if (!code || !state) return back("error", "Missing code or state");

        let userId: string;
        let provider: "gmail" | "google_calendar";
        try {
          const verified = verifyState(state);
          userId = verified.userId;
          provider = verified.provider as "gmail" | "google_calendar";
        } catch (e) {
          return back("error", e instanceof Error ? e.message : "Invalid state");
        }

        const redirectUri = `${url.origin}/api/public/google/callback`;
        try {
          const tokens = await exchangeCode(code, redirectUri);
          const accountLabel = decodeIdTokenEmail(tokens.id_token);
          const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
          const scopes = tokens.scope.split(" ");

          const { data: existing } = await supabaseAdmin
            .from("connections")
            .select("id, refresh_token_encrypted")
            .eq("user_id", userId)
            .eq("provider", provider)
            .maybeSingle();

          const refreshToken = tokens.refresh_token
            ? encryptToken(tokens.refresh_token)
            : existing?.refresh_token_encrypted ?? null;

          const row = {
            user_id: userId,
            provider,
            account_label: accountLabel,
            access_token_encrypted: encryptToken(tokens.access_token),
            refresh_token_encrypted: refreshToken,
            expires_at: expiresAt,
            scopes,
            metadata: {},
          };

          if (existing) {
            const { error: upErr } = await supabaseAdmin
              .from("connections")
              .update(row)
              .eq("id", existing.id);
            if (upErr) throw upErr;
          } else {
            const { error: insErr } = await supabaseAdmin.from("connections").insert(row);
            if (insErr) throw insErr;
          }

          return back("ok");
        } catch (e) {
          console.error("OAuth callback error:", e);
          return back("error", e instanceof Error ? e.message : "Unknown error");
        }
      },
    },
  },
});

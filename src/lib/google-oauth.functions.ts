import { createServerFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { signState } from "@/server/crypto.server";

const GMAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
];

const CALENDAR_SCOPES = [
  "openid",
  "email",
  "profile",
  // readonly covers freeBusy + reading existing events (used by proposeFreeSlots)
  "https://www.googleapis.com/auth/calendar.readonly",
  // events lets us create the "Prep: <subject>" hold after sending an interview reply
  "https://www.googleapis.com/auth/calendar.events",
];

function scopesFor(provider: "gmail" | "google_calendar"): string[] {
  return provider === "gmail" ? GMAIL_SCOPES : CALENDAR_SCOPES;
}

export const startGoogleOAuth = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { provider: "gmail" | "google_calendar" }) => d)
  .handler(async ({ data, context }) => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, (data.provider === "gmail" ? "email_on_server" : "calendar_on_server"));
      void noteCloudActivity;
    }
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!clientId) throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID");

    const host = getRequestHost();
    const redirectUri = `https://${host}/api/public/google/callback`;
    const state = signState(context.userId, data.provider);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopesFor(data.provider).join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });

    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
  });

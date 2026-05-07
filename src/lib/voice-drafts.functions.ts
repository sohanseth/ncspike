import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { encryptToken, decryptToken } from "@/server/crypto.server";
import { getValidGmailAccessToken } from "@/server/gmail-auth.server";
import {
  extractVoiceProfile,
  type SentMessage,
  type VoiceProfile,
} from "@/server/voice-profile.server";

const SENT_SAMPLE_SIZE = 200;

// ---------------------------------------------------------------------------
// Gmail body parsing
// ---------------------------------------------------------------------------

type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

type GmailMessage = {
  id: string;
  payload?: GmailPart;
  internalDate?: string;
};

function decodeBase64Url(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  // Buffer is available in Node/Workers runtimes used by TanStack Start.
  return Buffer.from(padded, "base64").toString("utf8");
}

/** Walk the MIME tree and return the best plain-text body we can find. */
function extractPlainText(part?: GmailPart): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    // Prefer text/plain over text/html.
    for (const p of part.parts) {
      if (p.mimeType === "text/plain") {
        const t = extractPlainText(p);
        if (t) return t;
      }
    }
    for (const p of part.parts) {
      const t = extractPlainText(p);
      if (t) return t;
    }
  }
  // Fallback: strip HTML tags from a text/html part.
  if (part.mimeType === "text/html" && part.body?.data) {
    const html = decodeBase64Url(part.body.data);
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// Sent-folder ingestion (in-memory; raw bodies are NEVER persisted)
// ---------------------------------------------------------------------------

async function fetchSentMessages(token: string, limit: number): Promise<SentMessage[]> {
  const messages: SentMessage[] = [];
  let pageToken: string | undefined;
  const target = Math.min(limit, 500);

  while (messages.length < target) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", "in:sent");
    url.searchParams.set("maxResults", String(Math.min(100, target - messages.length)));
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const listRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!listRes.ok) {
      throw new Error(`Gmail sent list failed: ${listRes.status} ${await listRes.text()}`);
    }
    const list = (await listRes.json()) as {
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    };
    const ids = (list.messages ?? []).map((m) => m.id);
    if (!ids.length) break;

    // Fetch bodies. Gmail rate limits aggressive parallelism — keep it modest.
    const batchSize = 8;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const fetched = await Promise.all(
        batch.map(async (id) => {
          const r = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!r.ok) return null;
          const m = (await r.json()) as GmailMessage;
          const body = extractPlainText(m.payload);
          if (!body) return null;
          return {
            id: m.id,
            body,
            date: m.internalDate
              ? new Date(Number(m.internalDate)).toISOString()
              : new Date().toISOString(),
          } satisfies SentMessage;
        }),
      );
      for (const m of fetched) if (m) messages.push(m);
      if (messages.length >= target) break;
    }

    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------

export type VoiceProfileSummary = {
  hasProfile: boolean;
  sampleCount: number;
  builtAt: string | null;
  expiresAt: string | null;
  profile: VoiceProfile | null;
};

async function loadProfile(userId: string): Promise<VoiceProfileSummary> {
  const { data, error } = await supabaseAdmin
    .from("voice_profiles")
    .select("sample_count, built_at, expires_at, profile_encrypted")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return {
      hasProfile: false,
      sampleCount: 0,
      builtAt: null,
      expiresAt: null,
      profile: null,
    };
  }
  let profile: VoiceProfile | null = null;
  if (data.profile_encrypted) {
    try {
      profile = JSON.parse(decryptToken(data.profile_encrypted)) as VoiceProfile;
    } catch (e) {
      console.error("voice profile decrypt failed:", e);
    }
  }
  return {
    hasProfile: true,
    sampleCount: data.sample_count ?? 0,
    builtAt: data.built_at,
    expiresAt: data.expires_at,
    profile,
  };
}

export const getVoiceProfile = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => loadProfile(context.userId));

export const buildVoiceProfile = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { token } = await getValidGmailAccessToken(context.userId);

    // Fetch sent messages — these are held in memory only and never persisted.
    const messages = await fetchSentMessages(token, SENT_SAMPLE_SIZE);
    const profile = extractVoiceProfile(messages);

    const encrypted = encryptToken(JSON.stringify(profile));
    const builtAt = new Date();
    const expiresAt = new Date(builtAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    const { error } = await supabaseAdmin
      .from("voice_profiles")
      .upsert(
        {
          user_id: context.userId,
          sample_count: profile.sample_count,
          built_at: builtAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          profile_encrypted: encrypted,
        },
        { onConflict: "user_id" },
      );
    if (error) throw error;

    return loadProfile(context.userId);
  });

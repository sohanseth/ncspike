import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { encryptToken, decryptToken } from "@/server/crypto.server";
import { getValidGmailAccessToken, getValidGoogleAccessToken } from "@/server/gmail-auth.server";
import {
  proposeFreeSlots,
  createCalendarEvent,
  computePrepBlockSlot,
  getUserCalendarTimezone,
  CalendarScopeError,
  type ProposedSlot,
} from "@/server/calendar.server";
import {
  analyzeEmailForDraft,
  parsePrepTimeToHours,
  type EmailAnalysis,
} from "@/server/email-intent.server";
import {
  extractVoiceProfile,
  parseForwardedSender,
  renderDraftPrompt,
  selectTemplate,
  TEMPLATE_IDS,
  type IncomingEmail,
  type SentMessage,
  type TemplateId,
  type VoiceProfile,
} from "@/server/voice-profile.server";
import { generate, InferenceError } from "@/server/inference";

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

// ---------------------------------------------------------------------------
// Drafts (Week 2 + Week 3 consent gating)
// ---------------------------------------------------------------------------

/**
 * Week 3 gating: voice drafts must be globally enabled (env flag) AND the
 * user must have explicitly accepted the in-app consent screen. The screen
 * sets `user_settings.voice_drafts_consent_at` to NOW(); a NULL value means
 * "not consented yet" and any attempt to call the LLM is rejected.
 */
function isFeatureEnabled(): boolean {
  const v = (process.env.ENABLE_VOICE_DRAFTS ?? "true").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function assertCanDraft(userId: string): Promise<void> {
  if (!isFeatureEnabled()) {
    throw new Error("Voice drafts are disabled on this server.");
  }
  const { data, error } = await supabaseAdmin
    .from("user_settings")
    .select("voice_drafts_consent_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.voice_drafts_consent_at) {
    throw new Error("Voice drafts require consent. Open the consent screen and accept first.");
  }
}

export const getVoiceDraftsStatus = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<{
    featureEnabled: boolean;
    consented: boolean;
    consentedAt: string | null;
  }> => {
    const featureEnabled = isFeatureEnabled();
    const { data } = await supabaseAdmin
      .from("user_settings")
      .select("voice_drafts_consent_at")
      .eq("user_id", context.userId)
      .maybeSingle();
    const consentedAt = data?.voice_drafts_consent_at ?? null;
    return { featureEnabled, consented: !!consentedAt, consentedAt };
  });

export const setVoiceDraftsConsent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { accept: boolean }) => d)
  .handler(async ({ data, context }): Promise<{ consentedAt: string | null }> => {
    const consentedAt = data.accept ? new Date().toISOString() : null;
    // Upsert so a brand-new user (no settings row yet) still works.
    const { error } = await supabaseAdmin
      .from("user_settings")
      .upsert(
        { user_id: context.userId, voice_drafts_consent_at: consentedAt },
        { onConflict: "user_id" },
      );
    if (error) throw error;
    return { consentedAt };
  });

export type DraftPayload = {
  id: string;
  template: TemplateId;
  body: string;
  status: string;
  charsInDraft: number;
  charsEdited: number | null;
  createdAt: string;
  resolvedAt: string | null;
  sourceNodeId: string | null;
  /**
   * Transient assistant note generated alongside the draft (not persisted).
   * Surfaces "what I noticed and why I drafted it this way" to the user.
   */
  assistantNote?: string;
  /**
   * Concrete free-slot proposals computed for "schedule"-template drafts.
   * Transient: not persisted, surfaced so the UI can offer follow-on actions
   * like "block prep time before the earliest slot".
   */
  proposedSlots?: ProposedSlot[];
};

const DEFAULT_PROFILE: VoiceProfile = {
  sign_off: "Thanks",
  opener_phrases: [],
  avg_sentence_length: 0,
  formality_score: 0.5,
  characteristic_phrases: [],
  sample_count: 0,
};

async function loadVoiceProfileForUser(userId: string): Promise<VoiceProfile> {
  const { data } = await supabaseAdmin
    .from("voice_profiles")
    .select("profile_encrypted")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data?.profile_encrypted) return DEFAULT_PROFILE;
  try {
    return JSON.parse(decryptToken(data.profile_encrypted)) as VoiceProfile;
  } catch (e) {
    console.error("voice profile decrypt failed:", e);
    return DEFAULT_PROFILE;
  }
}

async function loadIncomingEmail(
  userId: string,
  memoryNodeId: string,
): Promise<IncomingEmail> {
  const { data, error } = await supabaseAdmin
    .from("memory_nodes")
    .select("label, data")
    .eq("user_id", userId)
    .eq("id", memoryNodeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Email not found");
  const meta = (data.data ?? {}) as { from?: string; snippet?: string; gmail_id?: string };
  const subject = data.label || "(no subject)";
  const from = meta.from || "";
  const snippet = meta.snippet || "";

  // Fetch the full message body so the LLM can reply to actual content,
  // not just the snippet. Best-effort — if the token is missing, expired,
  // or the message was deleted from Gmail, we silently fall back to snippet.
  let body: string | undefined;
  let originalSender: string | undefined;
  if (meta.gmail_id) {
    try {
      const { token } = await getValidGmailAccessToken(userId);
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${meta.gmail_id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (r.ok) {
        const m = (await r.json()) as GmailMessage;
        const text = extractPlainText(m.payload);
        if (text) body = text.trim();
      }
    } catch (e) {
      console.warn("loadIncomingEmail: full body fetch failed, using snippet:", e);
    }
  }

  // Detect forwards via subject prefix or in-body markers, parse the real sender.
  const looksForwarded =
    /^\s*(fwd?|fw):/i.test(subject) ||
    (!!body && /-+\s*Forwarded message\s*-+|Begin forwarded message/i.test(body));
  if (looksForwarded && body) {
    const parsed = parseForwardedSender(body);
    if (parsed) originalSender = parsed;
  }

  return { subject, from, snippet, body, originalSender };
}

async function generateDraftBody(
  profile: VoiceProfile,
  template: TemplateId,
  email: IncomingEmail,
): Promise<string> {
  const { system, user } = renderDraftPrompt(profile, template, email);
  const result = await generate({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens: 350,
    temperature: 0.4,
  });
  return result.text.trim();
}

function rowToPayload(
  row: {
    id: string;
    template: string;
    body_encrypted: string;
    status: string;
    chars_in_draft: number;
    chars_edited: number | null;
    created_at: string;
    resolved_at: string | null;
    source_node_id: string | null;
  },
): DraftPayload {
  return {
    id: row.id,
    template: row.template as TemplateId,
    body: decryptToken(row.body_encrypted),
    status: row.status,
    charsInDraft: row.chars_in_draft,
    charsEdited: row.chars_edited,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    sourceNodeId: row.source_node_id,
  };
}

/**
 * Pre-draft analyze step. Returns the assistant's read of the email and
 * any clarifying questions to ask the user before drafting.
 *
 * Stateless — does not persist anything. The UI calls this first; if
 * `questions` is empty, it can call `draftReply` immediately. Otherwise
 * it shows the questions, collects answers, and passes them as
 * `clarifications` into `draftReply`.
 */
export type AnalyzeResult = EmailAnalysis & { source: { from: string; subject: string } };

export const analyzeDraft = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { memoryNodeId: string }) => d)
  .handler(async ({ data, context }): Promise<AnalyzeResult> => {
    await assertCanDraft(context.userId);
    const email = await loadIncomingEmail(context.userId, data.memoryNodeId);
    const analysis = await analyzeEmailForDraft(email);
    return {
      ...analysis,
      source: {
        from: email.originalSender || email.from,
        subject: email.subject,
      },
    };
  });

/** Convert clarifications.prep_time → bufferHours for proposeFreeSlots. */
function bufferHoursFromClarifications(c?: Record<string, string>): number {
  const prep = c?.prep_time?.trim();
  return prep ? parsePrepTimeToHours(prep) : 2;
}

export const draftReply = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: {
    memoryNodeId: string;
    clarifications?: Record<string, string>;
    assistantNote?: string;
  }) => d)
  .handler(async ({ data, context }): Promise<DraftPayload> => {
    await assertCanDraft(context.userId);
    const [profile, email] = await Promise.all([
      loadVoiceProfileForUser(context.userId),
      loadIncomingEmail(context.userId, data.memoryNodeId),
    ]);

    if (data.clarifications) email.clarifications = data.clarifications;

    const template = selectTemplate(email);

    // For schedule asks, try to surface concrete free slots from the user's
    // calendar so the draft proposes real times instead of "let me know what works".
    // The buffer comes from the user's prep_time answer when present (e.g.
    // "2 days" → 48h), so interview replies don't propose tomorrow.
    let proposedSlots: ProposedSlot[] = [];
    if (template === "schedule") {
      try {
        const bufferHours = bufferHoursFromClarifications(data.clarifications);
        proposedSlots = await proposeFreeSlots(context.userId, { bufferHours });
        if (proposedSlots.length > 0) email.proposedSlots = proposedSlots.map((s) => s.human);
      } catch (e) {
        console.warn("proposeFreeSlots failed, drafting without slots:", e);
      }
    }

    let body: string;
    try {
      body = await generateDraftBody(profile, template, email);
    } catch (e) {
      if (e instanceof InferenceError) throw new Error(`Draft generation failed: ${e.message}`);
      throw e;
    }

    const enc = encryptToken(body);
    const { data: inserted, error } = await supabaseAdmin
      .from("drafts")
      .insert({
        user_id: context.userId,
        source_node_id: data.memoryNodeId,
        template,
        body_encrypted: enc,
        chars_in_draft: body.length,
        status: "pending",
        templates_tried: [template],
      })
      .select("id, template, body_encrypted, status, chars_in_draft, chars_edited, created_at, resolved_at, source_node_id")
      .single();
    if (error) throw error;
    const payload = rowToPayload(inserted);
    if (data.assistantNote) payload.assistantNote = data.assistantNote;
    if (proposedSlots.length > 0) payload.proposedSlots = proposedSlots;
    return payload;
  });

export const regenerateDraft = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { draftId: string; clarifications?: Record<string, string> }) => d)
  .handler(async ({ data, context }): Promise<DraftPayload> => {
    await assertCanDraft(context.userId);
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("drafts")
      .select("id, source_node_id, templates_tried, status")
      .eq("user_id", context.userId)
      .eq("id", data.draftId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) throw new Error("Draft not found");
    if (existing.status !== "pending") throw new Error("Only pending drafts can be regenerated");
    if (!existing.source_node_id) throw new Error("Original email no longer available");

    const [profile, email] = await Promise.all([
      loadVoiceProfileForUser(context.userId),
      loadIncomingEmail(context.userId, existing.source_node_id),
    ]);

    if (data.clarifications) email.clarifications = data.clarifications;

    const tried = (existing.templates_tried ?? []) as TemplateId[];
    // Rotate to a template not yet used. If all 5 used, rotate from the start again.
    const exclude = tried.length >= TEMPLATE_IDS.length ? [tried[tried.length - 1]] : tried;
    const template = selectTemplate(email, exclude);

    let proposedSlots: ProposedSlot[] = [];
    if (template === "schedule") {
      try {
        const bufferHours = bufferHoursFromClarifications(data.clarifications);
        proposedSlots = await proposeFreeSlots(context.userId, { bufferHours });
        if (proposedSlots.length > 0) email.proposedSlots = proposedSlots.map((s) => s.human);
      } catch (e) {
        console.warn("proposeFreeSlots failed (regenerate), drafting without slots:", e);
      }
    }

    const body = await generateDraftBody(profile, template, email);
    const enc = encryptToken(body);

    const { data: updated, error: updErr } = await supabaseAdmin
      .from("drafts")
      .update({
        template,
        body_encrypted: enc,
        chars_in_draft: body.length,
        templates_tried: [...tried, template],
      })
      .eq("id", data.draftId)
      .eq("user_id", context.userId)
      .select("id, template, body_encrypted, status, chars_in_draft, chars_edited, created_at, resolved_at, source_node_id")
      .single();
    if (updErr) throw updErr;
    const payload = rowToPayload(updated);
    if (proposedSlots.length > 0) payload.proposedSlots = proposedSlots;
    return payload;
  });

/**
 * Place a "Prep: <subject>" hold on the user's primary calendar before the
 * earliest proposed meeting slot. Used right after the user copies & sends
 * an interview reply, so prep time is actually defended on the calendar.
 *
 * Failure modes surfaced to the UI:
 *   - "scope": old token doesn't have calendar.events → user must reconnect
 *   - "no_calendar": user never connected Google Calendar
 *   - "create_failed": Google API returned an error
 */
export type PrepBlockResult =
  | { ok: true; eventId: string; htmlLink: string; startIso: string; endIso: string; human: string }
  | { ok: false; reason: "scope" | "no_calendar" | "create_failed"; message: string };

export const createPrepBlock = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: {
    draftId: string;
    /** ISO 8601 of the earliest proposed meeting slot — the prep block is placed before this. */
    beforeIso: string;
    /** Raw user answer to the prep_time question, e.g. "2 days". Parsed server-side. */
    prepTimeText: string;
  }) => d)
  .handler(async ({ data, context }): Promise<PrepBlockResult> => {
    // Verify the draft belongs to this user and resolve the email subject for the title.
    const { data: draftRow, error: draftErr } = await supabaseAdmin
      .from("drafts")
      .select("id, source_node_id")
      .eq("user_id", context.userId)
      .eq("id", data.draftId)
      .maybeSingle();
    if (draftErr) throw draftErr;
    if (!draftRow?.source_node_id) {
      return { ok: false, reason: "create_failed", message: "Draft not found." };
    }

    let subject = "interview";
    try {
      const email = await loadIncomingEmail(context.userId, draftRow.source_node_id);
      if (email.subject) subject = email.subject.replace(/^(re:|fwd:|fw:)\s*/gi, "").trim() || subject;
    } catch {
      /* keep default subject */
    }

    const timezone = await getUserCalendarTimezone(context.userId);
    const prepHours = parsePrepTimeToHours(data.prepTimeText || "");
    const slot = computePrepBlockSlot(data.beforeIso, timezone, prepHours);

    try {
      const created = await createCalendarEvent(context.userId, {
        summary: `Prep: ${subject}`,
        description:
          "Auto-blocked by NeuralConnexions before your interview slot. " +
          "Adjust or delete if your plans change.",
        startIso: slot.startIso,
        endIso: slot.endIso,
        timezone,
      });
      return {
        ok: true,
        eventId: created.eventId,
        htmlLink: created.htmlLink,
        startIso: created.startIso,
        endIso: created.endIso,
        human: created.human,
      };
    } catch (e) {
      if (e instanceof CalendarScopeError) {
        return { ok: false, reason: "scope", message: e.message };
      }
      // getValidGoogleAccessToken throws "<provider> not connected" when no
      // row exists, and "No refresh token; please reconnect <provider>" when
      // the row exists but is unusable. Both mean the user needs to (re)connect.
      const msg = e instanceof Error ? e.message : String(e);
      if (/not\s+connected|reconnect/i.test(msg)) {
        return { ok: false, reason: "no_calendar", message: "Connect Google Calendar first." };
      }
      console.warn("createPrepBlock failed:", e);
      return { ok: false, reason: "create_failed", message: msg.slice(0, 200) };
    }
  });

/**
 * Pre-compute calendar-based availability suggestions for the asking-panel
 * "What times work for you?" question. Lets the user one-click fill the answer
 * with real free slots that respect their prep_time, instead of typing
 * placeholder text. Returns [] when no calendar / no free slots.
 */
export type SuggestAvailabilityResult =
  | { status: "ok"; slots: ProposedSlot[]; answer: string }
  | { status: "empty" }
  | { status: "no_calendar" }
  | { status: "error"; message: string };

export const suggestAvailability = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { prepTimeText?: string }) => d)
  .handler(async ({ data, context }): Promise<SuggestAvailabilityResult> => {
    // Probe for a usable calendar token first so we can distinguish
    // "not connected" from "no free slots in the next week" — both are
    // valid outcomes but require very different UX nudges.
    try {
      await getValidGoogleAccessToken(context.userId, "google_calendar");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not\s+connected|reconnect/i.test(msg)) {
        return { status: "no_calendar" };
      }
      return { status: "error", message: msg.slice(0, 200) };
    }

    const bufferHours = data.prepTimeText
      ? parsePrepTimeToHours(data.prepTimeText)
      : 2;
    let slots: ProposedSlot[] = [];
    try {
      slots = await proposeFreeSlots(context.userId, { bufferHours });
    } catch (e) {
      console.warn("suggestAvailability: proposeFreeSlots failed:", e);
      return { status: "error", message: e instanceof Error ? e.message.slice(0, 200) : "calendar lookup failed" };
    }
    if (slots.length === 0) return { status: "empty" };
    return { status: "ok", slots, answer: slots.map((s) => s.human).join("; ") };
  });

/** Cheap edit-distance proxy: char-level Levenshtein, capped for perf. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Cap to keep this O(n*m) bounded — drafts are short (<2KB) so this is fine.
  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

export const markDraftSent = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { draftId: string; finalBody: string }) => d)
  .handler(async ({ data, context }): Promise<DraftPayload> => {
    const { data: existing, error } = await supabaseAdmin
      .from("drafts")
      .select("id, body_encrypted, status, chars_in_draft")
      .eq("user_id", context.userId)
      .eq("id", data.draftId)
      .maybeSingle();
    if (error) throw error;
    if (!existing) throw new Error("Draft not found");
    if (existing.status !== "pending") throw new Error("Draft already resolved");

    const original = decryptToken(existing.body_encrypted);
    const editChars = editDistance(original, data.finalBody);
    const newStatus = editChars === 0 ? "sent" : "edited_then_sent";

    // NOTE: chars_in_draft is the *original* generated length and must NOT
    // be overwritten — it's the denominator for the EDTS metric.
    const { data: updated, error: updErr } = await supabaseAdmin
      .from("drafts")
      .update({
        status: newStatus,
        chars_edited: editChars,
        body_encrypted: encryptToken(data.finalBody),
        resolved_at: new Date().toISOString(),
      })
      .eq("id", data.draftId)
      .eq("user_id", context.userId)
      .select("id, template, body_encrypted, status, chars_in_draft, chars_edited, created_at, resolved_at, source_node_id")
      .single();
    if (updErr) throw updErr;
    return rowToPayload(updated);
  });

export const dismissDraft = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { draftId: string }) => d)
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { error } = await supabaseAdmin
      .from("drafts")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() })
      .eq("id", data.draftId)
      .eq("user_id", context.userId)
      .eq("status", "pending");
    if (error) throw error;
    return { ok: true };
  });

export const listDrafts = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { status?: string; limit?: number } | undefined) => d ?? {})
  .handler(async ({ data, context }): Promise<DraftPayload[]> => {
    const limit = Math.min(Math.max(data.limit ?? 50, 1), 200);
    let q = supabaseAdmin
      .from("drafts")
      .select("id, template, body_encrypted, status, chars_in_draft, chars_edited, created_at, resolved_at, source_node_id")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw error;
    return (rows ?? []).map(rowToPayload);
  });

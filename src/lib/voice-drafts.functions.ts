import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { encryptToken, decryptToken } from "@/server/crypto.server";
import { getValidGmailAccessToken } from "@/server/gmail-auth.server";
import {
  proposeFreeSlots,
  type ProposedSlot,
} from "@/server/calendar.server";
import {
  AGENT_TOOLS,
  blockPrepTimeTool,
  setFollowUpReminderTool,
  suggestAvailabilityTool,
  dispatchAgentTool,
  type BlockPrepTimeOutput,
  type SetFollowUpReminderOutput,
  type SuggestAvailabilityOutput,
} from "@/server/agent-tools";
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
import { scrubErrorMessage } from "@/lib/error-scrub";

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
      console.error("voice profile decrypt failed:", e instanceof Error ? e.name : "Error");
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

export const getVoiceProfile = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => loadProfile(context.userId));

export const buildVoiceProfile = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "email_on_server");
      void noteCloudActivity(context.userId, "email_on_server", "gmail");
    }
    // Building the profile reads the sent folder, so it needs the same
    // informed consent as drafting.
    await assertCanDraft(context.userId);
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

export const getVoiceDraftsStatus = createServerFn({ method: "POST" })
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
    // "I understand, enable" is also the email_ai consent (prompt E).
    if (data.accept) {
      const { recordConsent } = await import("@/server/cloud-features.server");
      await recordConsent(context.userId, "email_ai", true, "prompt");
    }
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
  /**
   * Optional follow-up reminder proposal carried through from analyzeDraft.
   * UI renders a one-click "Remind me in N days" chip in the draft panel.
   */
  followUp?: { afterDays: number; summary: string };
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
    console.error("voice profile decrypt failed:", e instanceof Error ? e.name : "Error");
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
      console.warn("loadIncomingEmail: full body fetch failed, using snippet:", e instanceof Error ? e.name : "Error");
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
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "email_ai");
      void noteCloudActivity(context.userId, "email_ai", "lovable-gemini");
    }
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
    followUp?: { afterDays: number; summary: string };
  }) => d)
  .handler(async ({ data, context }): Promise<DraftPayload> => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "email_ai");
      void noteCloudActivity(context.userId, "email_ai", "lovable-gemini");
    }
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
        console.warn("proposeFreeSlots failed, drafting without slots:", e instanceof Error ? e.name : "Error");
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
    if (data.followUp) payload.followUp = data.followUp;
    return payload;
  });

export const regenerateDraft = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { draftId: string; clarifications?: Record<string, string> }) => d)
  .handler(async ({ data, context }): Promise<DraftPayload> => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "email_ai");
      void noteCloudActivity(context.userId, "email_ai", "lovable-gemini");
    }
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
        console.warn("proposeFreeSlots failed (regenerate), drafting without slots:", e instanceof Error ? e.name : "Error");
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
// Re-exported result type — thin wrapper around the agent-tool's output shape
// so existing callers (UI, tests) keep working unchanged.
export type PrepBlockResult = BlockPrepTimeOutput;

/**
 * Thin server-fn wrapper around `blockPrepTimeTool`. The actual logic lives in
 * `src/server/agent-tools.ts` so it can be invoked from any agentic surface
 * (chat, deep-research, command palette) via `dispatchAgentTool` or
 * `runAgentTool`.
 */
export const createPrepBlock = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: {
    draftId: string;
    beforeIso: string;
    prepTimeText: string;
  }) => d)
  .handler(({ data, context }): Promise<PrepBlockResult> =>
    blockPrepTimeTool.execute(context.userId, data),
  );

/**
 * Pre-compute calendar-based availability suggestions for the asking-panel
 * "What times work for you?" question. Lets the user one-click fill the answer
 * with real free slots that respect their prep_time, instead of typing
 * placeholder text. Returns [] when no calendar / no free slots.
 */
export type SuggestAvailabilityResult = SuggestAvailabilityOutput;

/** Thin wrapper around `suggestAvailabilityTool`. See agent-tools.ts. */
export const suggestAvailability = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { prepTimeText?: string }) => d)
  .handler(({ data, context }): Promise<SuggestAvailabilityResult> =>
    suggestAvailabilityTool.execute(context.userId, data),
  );

/**
 * Create a 30-minute reminder event N days from now at 09:00 in the user's TZ.
 * Mirrors the createPrepBlock result shape so the UI can reuse the same
 * success/error-state rendering. `afterDays` is bounded server-side (1-60).
 */
export type FollowUpReminderResult = SetFollowUpReminderOutput;

/** Thin wrapper around `setFollowUpReminderTool`. See agent-tools.ts. */
export const createFollowUpReminder = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { afterDays: number; summary: string }) => d)
  .handler(({ data, context }): Promise<FollowUpReminderResult> =>
    setFollowUpReminderTool.execute(context.userId, data),
  );

/**
 * Generic agent-tool dispatcher. Any feature (chat, deep-research, future
 * "/run X" palette) can call this with a tool id + raw input; the registry
 * handles validation and execution. The 3 thin wrappers above remain for
 * back-compat with existing UI imports, but new callers should prefer this.
 *
 * Rate-limited per (userId, toolId) via tool_invocations table — see
 * src/server/rate-limit.server.ts. Limits are conservative and tunable.
 */
export const runAgentTool = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { toolId: string; input: unknown }) => d)
  // Result is typed `any` because each tool returns its own typed payload —
  // callers should cast to the specific tool's `*Output` type. We also can't
  // express `unknown` here (TanStack Start's serialization type-guard rejects
  // it), so `any` is correct at the framework boundary.
  .handler(async ({ data, context }): Promise<{ ok: true; result: any } | { ok: false; error: string }> => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "calendar_on_server");
      void noteCloudActivity(context.userId, "calendar_on_server", "google-calendar");
    }
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "calendar_on_server");
      void noteCloudActivity(context.userId, "calendar_on_server", "google-calendar");
    }
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "calendar_on_server");
      void noteCloudActivity(context.userId, "calendar_on_server", "google-calendar");
    }
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      const feature = data.toolId === "research_thread_context" ? "email_ai" : "calendar_on_server";
      await requireCloudFeature(context.userId, feature);
      void noteCloudActivity(context.userId, feature, feature === "email_ai" ? "lovable-gemini" : "google-calendar");
    }
    try {
      const { enforceToolRateLimit } = await import("@/server/rate-limit.server");
      const decision = await enforceToolRateLimit(context.userId, data.toolId);
      if (!decision.ok) {
        return {
          ok: false,
          error: `Rate limit hit for ${data.toolId} (${decision.limit}/hour). Try again in ~${Math.ceil(decision.retryAfterSeconds / 60)} min.`,
        };
      }
      const result = await dispatchAgentTool(context.userId, data.toolId, data.input);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

/** List the agent tools available to LLM-driven callers. Cheap; no auth needed. */
export const listAgentTools = createServerFn({ method: "POST" })
  .handler(async () =>
    Object.values(AGENT_TOOLS).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      inputShape: t.inputShape,
    })),
  );

// ---------------------------------------------------------------------------
// Overnight research queue server fns. Thin wrappers around research-queue.ts;
// every handler is auth-gated so a user can only touch their own queue.
// ---------------------------------------------------------------------------

export const enqueueResearchTaskFn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      toolId: string;
      input: Record<string, unknown>;
      source?: "auto" | "manual" | "system";
      sourceContext?: string;
      priority?: number;
      scheduledFor?: string;
    }) => d,
  )
  .handler(async ({ data, context }) => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "email_ai");
      void noteCloudActivity;
    }
    const { enqueueResearchTask } = await import("@/server/research-queue");
    return enqueueResearchTask(context.userId, data);
  });

export const listResearchTasksFn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d?: {
      status?: ("pending" | "running" | "done" | "error" | "cancelled")[];
      limit?: number;
      unreadOnly?: boolean;
    }) => d ?? {},
  )
  .handler(async ({ data, context }) => {
    const { listResearchTasks } = await import("@/server/research-queue");
    return listResearchTasks(context.userId, data);
  });

export const runResearchBatchFn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d?: { limit?: number }) => d ?? {})
  .handler(async ({ data, context }) => {
    {
      const { requireCloudFeature, noteCloudActivity } = await import("@/server/cloud-features.server");
      await requireCloudFeature(context.userId, "email_ai");
      void noteCloudActivity;
    }
    const { runResearchBatch } = await import("@/server/research-queue");
    return runResearchBatch(context.userId, data);
  });

export const markResearchTasksReadFn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { taskIds: string[] }) => d)
  .handler(async ({ data, context }) => {
    const { markResearchTasksRead } = await import("@/server/research-queue");
    return markResearchTasksRead(context.userId, data.taskIds);
  });

export const cancelResearchTaskFn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { taskId: string }) => d)
  .handler(async ({ data, context }) => {
    const { cancelResearchTask } = await import("@/server/research-queue");
    return cancelResearchTask(context.userId, data.taskId);
  });

export const getResearchQueueCountsFn = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getResearchQueueCounts } = await import("@/server/research-queue");
    return getResearchQueueCounts(context.userId);
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

/**
 * Send a pending draft via the Gmail API as a real reply, threaded under the
 * source email. Builds a minimal RFC 2822 message, base64url-encodes it, and
 * POSTs to gmail.users.messages.send with the original threadId so it lands
 * in the same conversation. On success, marks the draft as sent (reusing the
 * same status/edit-distance bookkeeping as markDraftSent).
 *
 * Requires the source email's gmail_id (stored on the memory_node) to fetch
 * Message-ID, References, From, Subject for proper threading. Without it we
 * can't produce a real reply, so we fail fast — caller can fall back to
 * "Mark sent" (the manual copy-paste path).
 */
export const sendDraftViaGmail = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { draftId: string; finalBody: string }) => d)
  .handler(async ({ data, context }): Promise<DraftPayload> => {
    const { data: draft, error: dErr } = await supabaseAdmin
      .from("drafts")
      .select("id, body_encrypted, status, chars_in_draft, source_node_id")
      .eq("user_id", context.userId)
      .eq("id", data.draftId)
      .maybeSingle();
    if (dErr) throw dErr;
    if (!draft) throw new Error("Draft not found");
    if (draft.status !== "pending") throw new Error("Draft already resolved");
    if (!draft.source_node_id) throw new Error("Draft has no source email; use Mark sent instead");

    const { data: node, error: nErr } = await supabaseAdmin
      .from("memory_nodes")
      .select("label, data")
      .eq("user_id", context.userId)
      .eq("id", draft.source_node_id)
      .maybeSingle();
    if (nErr) throw nErr;
    if (!node) throw new Error("Source email not found");
    const meta = (node.data ?? {}) as { from?: string; gmail_id?: string };
    if (!meta.gmail_id) throw new Error("Source email missing gmail_id; use Mark sent instead");

    // Atomic claim: pending → sending. If another caller (double-click, retry)
    // beat us here, the predicate misses and `claimed` is null → we fail fast
    // instead of double-sending a real email. We revert to 'pending' on any
    // downstream failure so the user can try again.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("drafts")
      .update({ status: "sending" })
      .eq("id", data.draftId)
      .eq("user_id", context.userId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) throw new Error("Draft is already being sent or resolved");

    const revert = async () => {
      try {
        await supabaseAdmin
          .from("drafts")
          .update({ status: "pending" })
          .eq("id", data.draftId)
          .eq("user_id", context.userId)
          .eq("status", "sending");
      } catch (e) {
        console.error("[sendDraftViaGmail] revert to pending failed:", e instanceof Error ? e.name : "Error");
      }
    };

    let token: string;
    let fromAddress: string | null;
    try {
      const auth = await getValidGmailAccessToken(context.userId);
      token = auth.token;
      fromAddress = auth.label;
    } catch (e) {
      await revert();
      throw e;
    }
    if (!fromAddress) {
      await revert();
      throw new Error("Gmail account label missing; reconnect Gmail");
    }

    // Pull headers + threadId from the original message so the reply threads.
    const origRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${meta.gmail_id}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Reply-To`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!origRes.ok) {
      const txt = await origRes.text();
      await revert();
      throw new Error(`Failed to fetch original message: ${origRes.status} ${txt}`);
    }
    const orig = (await origRes.json()) as {
      threadId?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const headers = orig.payload?.headers ?? [];
    const h = (name: string) =>
      headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";

    const replyTo = h("Reply-To") || h("From") || meta.from || "";
    if (!replyTo) {
      await revert();
      throw new Error("Could not determine recipient address");
    }
    const origSubject = h("Subject") || node.label || "(no subject)";
    const subject = /^re:\s/i.test(origSubject) ? origSubject : `Re: ${origSubject}`;
    const messageId = h("Message-Id");
    const origReferences = h("References");
    const references = [origReferences, messageId].filter(Boolean).join(" ").trim();

    const headerLines = [
      `From: ${fromAddress}`,
      `To: ${replyTo}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 7bit",
    ];
    if (messageId) headerLines.push(`In-Reply-To: ${messageId}`);
    if (references) headerLines.push(`References: ${references}`);

    const mime = `${headerLines.join("\r\n")}\r\n\r\n${data.finalBody}`;
    const raw = Buffer.from(mime, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sendRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw, ...(orig.threadId ? { threadId: orig.threadId } : {}) }),
      },
    );
    if (!sendRes.ok) {
      const txt = await sendRes.text();
      await revert();
      throw new Error(`Gmail send failed: ${sendRes.status} ${txt}`);
    }

    // From this point the email has been sent. We must finalise the row
    // (sending → sent|edited_then_sent) and never revert; if the DB write
    // fails we log loudly because the draft will look "stuck in sending"
    // until the user manually reconciles.
    const original = decryptToken(draft.body_encrypted);
    const editChars = editDistance(original, data.finalBody);
    const newStatus = editChars === 0 ? "sent" : "edited_then_sent";

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
      .eq("status", "sending")
      .select("id, template, body_encrypted, status, chars_in_draft, chars_edited, created_at, resolved_at, source_node_id")
      .single();
    if (updErr) {
      console.error(
        "[sendDraftViaGmail] CRITICAL: Gmail send succeeded but DB finalise failed:",
        scrubErrorMessage(updErr.message),
      );
      throw new Error(`Email sent but draft status update failed: ${updErr.message}`);
    }
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

export const listDrafts = createServerFn({ method: "POST" })
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

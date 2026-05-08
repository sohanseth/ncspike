/**
 * SSE endpoint for streaming chat replies. POST-only.
 *
 * Wire protocol:
 *   event: meta   data: {"provider":"groq","fallbackDepth":0,"threadId":"…","userMessageId":"…"}
 *   event: delta  data: {"text":"Hello"}              (0..N times)
 *   event: done   data: {"messageId":"…","provider":"groq","model":"…","fallbackDepth":0,
 *                        "inputTokens":12,"outputTokens":34}
 *   event: error  data: {"kind":"cap_exceeded"|"chain_exhausted"|"validation"|"internal",
 *                        "message":"…","badge":"flash","used":20,"cap":20}
 *
 * Auth: bearer token in `Authorization` header (same pattern as the server-fn
 * middleware). The Supabase access token is verified inline because TanStack
 * Start server functions don't support streaming responses — we need a raw
 * Response with a ReadableStream body, hence a file route.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  runChainStream,
  CapExceededError,
  ChainExhaustedError,
  UserAbortError,
  assertCap,
  type ChainStreamEvent,
} from "@/server/inference/chat";
import { chainFor, type Badge } from "@/server/inference/router";
import { resolveBadgeForUser } from "@/server/personalization-routing";
import type { InferenceMessage } from "@/server/inference";
import { strictestTierInChain, type ProviderId } from "@/lib/provider-tiers";
import {
  assembleSystemPrompt,
  logContextDecision,
  type AssembleResult,
} from "@/server/context-broker";
import { runVisionTurn, type VisionAttachment } from "@/server/inference/vision";

const HISTORY_WINDOW = 20;
const VALID_BADGES: readonly Badge[] = ["flash", "pro", "genius", "private"] as const;

function isBadge(x: unknown): x is Badge {
  return typeof x === "string" && (VALID_BADGES as readonly string[]).includes(x);
}

async function getPaidTier(_userId: string): Promise<boolean> {
  return false;
}

async function authenticate(request: Request): Promise<{ userId: string } | Response> {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    return new Response("Server misconfigured: missing Supabase env vars", { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = auth.slice(7);
  if (!token) return new Response("Unauthorized", { status: 401 });
  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    return new Response("Unauthorized", { status: 401 });
  }
  return { userId: data.claims.sub };
}

type RequestBody = {
  threadId: string | null;
  content: string;
  badge: Badge;
  /** Storage paths in the chat-attachments bucket. May be empty. */
  attachments: string[];
};

const MAX_ATTACHMENTS = 10;
const ALLOWED_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function validateBody(raw: unknown): RequestBody | string {
  if (!raw || typeof raw !== "object") return "Invalid body";
  const r = raw as Record<string, unknown>;
  // Allow empty content when attachments are present (e.g. pure image turn).
  const text = typeof r.content === "string" ? r.content : "";
  const atts = Array.isArray(r.attachments) ? r.attachments : [];
  if (text.trim().length === 0 && atts.length === 0) return "Message content is required";
  if (text.length > 8000) return "Message too long (max 8000 chars)";
  if (!isBadge(r.badge)) return "Invalid badge";
  if (r.threadId !== null && typeof r.threadId !== "string") return "Invalid threadId";
  if (atts.length > MAX_ATTACHMENTS) return `Too many attachments (max ${MAX_ATTACHMENTS})`;
  for (const a of atts) {
    if (typeof a !== "string" || a.length === 0 || a.length > 512) return "Invalid attachment path";
  }
  return {
    threadId: r.threadId,
    content: text.trim(),
    badge: r.badge,
    attachments: atts as string[],
  };
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const Route = createFileRoute("/api/chat/stream")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticate(request);
        if (auth instanceof Response) return auth;
        const userId = auth.userId;

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return new Response("Invalid JSON body", { status: 400 });
        }
        const v = validateBody(raw);
        if (typeof v === "string") return new Response(v, { status: 400 });

        // Resolve thread up-front so we can include the id in the meta event.
        let threadId = v.threadId;
        if (threadId) {
          const { data: existing, error: oErr } = await supabaseAdmin
            .from("chat_threads")
            .select("id")
            .eq("id", threadId)
            .eq("user_id", userId)
            .maybeSingle();
          if (oErr) return new Response("Thread lookup failed", { status: 500 });
          if (!existing) return new Response("Thread not found", { status: 404 });
        } else {
          const title = v.content.slice(0, 60).replace(/\s+/g, " ").trim() || "New chat";
          const { data: t, error: tErr } = await supabaseAdmin
            .from("chat_threads")
            .insert({ user_id: userId, title })
            .select("id")
            .single();
          if (tErr) return new Response("Thread create failed", { status: 500 });
          threadId = t.id;
        }

        // Load history.
        const { data: history } = await supabaseAdmin
          .from("chat_messages")
          .select("role, content, created_at")
          .eq("user_id", userId)
          .eq("thread_id", threadId)
          .order("created_at", { ascending: false })
          .limit(HISTORY_WINDOW - 1);

        const historyMessages: InferenceMessage[] = (history ?? [])
          .reverse()
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        // D8 Day 5 + B10/B11: honour the user's PRIVATE-only routing mode
        // (set by the Strict preset) BEFORE persisting anything badge-tagged.
        // When on, every badge collapses to 'private' so the chain only
        // reaches T0 — even if the UI sent FLASH/PRO/GENIUS. Both the broker
        // tier and the runtime chain see the coerced badge so they agree on
        // what the strictest tier is, and the persisted audit trail records
        // what actually ran rather than what the UI clicked.
        const { badge: effectiveBadge } = await resolveBadgeForUser(userId, v.badge);

        // Pre-flight cap + paidOnly check (spec §C6 ordering). Must happen
        // BEFORE the user-row insert — otherwise a cap-blocked send leaves
        // an orphan user bubble in the thread on next page load. On block
        // we return a one-shot SSE stream carrying the same `cap_exceeded`
        // error event the in-stream catch would have emitted, so the
        // client's existing handler treats it identically.
        const paidTier = await getPaidTier(userId);
        try {
          await assertCap({
            userId,
            threadId,
            badge: effectiveBadge,
            paidTier,
          });
        } catch (e) {
          if (e instanceof CapExceededError) {
            const frame = sseEvent("error", {
              kind: "cap_exceeded",
              message: e.message,
              badge: e.badge,
              used: e.used,
              cap: e.cap,
            });
            return new Response(frame, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache, no-transform",
                connection: "keep-alive",
              },
            });
          }
          throw e;
        }

        // Persist user message immediately so it survives chain failures.
        // For pure-image turns (no text) save a placeholder so the NOT NULL
        // content constraint holds; the UI renders thumbnails regardless.
        const persistedUserContent = v.content || (v.attachments.length > 0 ? "[image]" : v.content);
        const { data: userRow, error: uErr } = await supabaseAdmin
          .from("chat_messages")
          .insert({
            user_id: userId,
            thread_id: threadId,
            role: "user",
            content: persistedUserContent,
            badge: effectiveBadge,
          })
          .select("id")
          .single();
        if (uErr) return new Response("Failed to persist user message", { status: 500 });
<<<<<<< HEAD
=======

        // ─────────────────────────────────────────────────────────────
        // Vision branch: when the turn has image attachments, persist
        // attachment rows and bypass the chain runner. PRIVATE keeps
        // its fail-closed contract because runVisionTurn routes PRIVATE
        // exclusively to Cloudflare. Other badges go through the
        // Lovable AI Gateway directly with a vision-capable model.
        // ─────────────────────────────────────────────────────────────
        if (v.attachments.length > 0) {
          // Validate all attachment paths belong to this user (path prefix
          // = userId), then download each blob from the private bucket.
          const visionAttachments: VisionAttachment[] = [];
          const persistRows: Array<{ storage_path: string; mime: string; bytes: number }> = [];
          for (const path of v.attachments) {
            if (!path.startsWith(`${userId}/`)) {
              return new Response("Attachment path not owned by user", { status: 403 });
            }
            const dl = await supabaseAdmin.storage
              .from("chat-attachments")
              .download(path);
            if (dl.error || !dl.data) {
              return new Response(`Attachment download failed: ${path}`, { status: 400 });
            }
            const blob = dl.data;
            const mime = blob.type || "application/octet-stream";
            if (!ALLOWED_MIMES.has(mime)) {
              return new Response(`Unsupported attachment mime: ${mime}`, { status: 400 });
            }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            // Sign a URL for the client renderer (24h). Optional — model uses bytes.
            const sign = await supabaseAdmin.storage
              .from("chat-attachments")
              .createSignedUrl(path, 60 * 60 * 24);
            visionAttachments.push({
              url: sign.data?.signedUrl ?? "",
              bytes,
              mime,
            });
            persistRows.push({ storage_path: path, mime, bytes: bytes.length });
          }

          // Link attachments to the just-persisted user message.
          if (persistRows.length > 0) {
            const { error: aErr } = await supabaseAdmin
              .from("chat_message_attachments")
              .insert(
                persistRows.map((r) => ({
                  message_id: userRow.id,
                  user_id: userId,
                  storage_path: r.storage_path,
                  mime: r.mime,
                  bytes: r.bytes,
                })),
              );
            if (aErr) console.warn("[api.chat.stream] attachment persist failed:", aErr.message);
          }

          // Build text history (vision turn does not see prior images).
          const visionHistory = historyMessages.filter(
            (m): m is { role: "user" | "assistant"; content: string } =>
              m.role === "user" || m.role === "assistant",
          );

          const encoderV = new TextEncoder();
          const visionBody = new ReadableStream<Uint8Array>({
            async start(controller) {
              const send = (name: string, data: unknown) => {
                try {
                  controller.enqueue(encoderV.encode(sseEvent(name, data)));
                } catch {
                  /* closed */
                }
              };
              send("init", { threadId, userMessageId: userRow.id });
              const t0 = Date.now();
              try {
                const result = await runVisionTurn({
                  badge: effectiveBadge,
                  history: visionHistory,
                  userText: v.content,
                  attachments: visionAttachments,
                  signal: request.signal ?? undefined,
                });
                send("meta", { provider: result.provider, fallbackDepth: 0 });
                send("delta", { text: result.text });
                const { data: aRow } = await supabaseAdmin
                  .from("chat_messages")
                  .insert({
                    user_id: userId,
                    thread_id: threadId,
                    role: "assistant",
                    content: result.text,
                    badge: effectiveBadge,
                    provider: result.provider,
                    model: result.model,
                    fallback_depth: 0,
                  } as never)
                  .select("id")
                  .single();
                await supabaseAdmin.from("inference_usage").insert({
                  user_id: userId,
                  thread_id: threadId,
                  badge: effectiveBadge,
                  provider_chain: [result.provider],
                  provider_used: result.provider,
                  model_used: result.model,
                  fallback_depth: 0,
                  latency_ms: Date.now() - t0,
                  status: "ok",
                });
                await supabaseAdmin
                  .from("chat_threads")
                  .update({ updated_at: new Date().toISOString() })
                  .eq("id", threadId)
                  .eq("user_id", userId);
                send("done", {
                  messageId: aRow?.id ?? null,
                  provider: result.provider,
                  model: result.model,
                  fallbackDepth: 0,
                  inputTokens: null,
                  outputTokens: null,
                  contextUsed: null,
                  traitSheetVersion: null,
                });
              } catch (e) {
                const msg = e instanceof Error ? e.message : "Vision turn failed";
                send("error", { kind: "internal", message: msg });
              } finally {
                try { controller.close(); } catch { /* already */ }
              }
            },
          });
          return new Response(visionBody, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              Connection: "keep-alive",
            },
          });
        }

        const paidTier = await getPaidTier(userId);
>>>>>>> bfc3542f0f2d2c455c0cef4bb48ea78590ab12a9
        const cfg = chainFor(effectiveBadge);
        const tier = strictestTierInChain(cfg.chain);
        let broker: AssembleResult = {
          fragment: "",
          contextUsed: { categories: [], trait_paths: [] },
          scrubBlocked: false,
          traitSheetVersion: null,
        };
        try {
          broker = await assembleSystemPrompt({
            userId,
            query: v.content,
            badge: effectiveBadge,
            strictestTierInChain: tier,
          });
        } catch (e) {
          console.warn(`[api.chat.stream] broker failed, proceeding with default prompt:`, e);
        }

        const encoder = new TextEncoder();

        // userAbort fires when the consumer (the client) cancels the
        // ReadableStream OR the inbound request itself is aborted. Both
        // routes converge here so the upstream provider fetch is cancelled
        // and we get one clean place to write the user_abort telemetry.
        const userAbort = new AbortController();
        let aborted = false;
        const onAbort = () => {
          if (aborted) return;
          aborted = true;
          userAbort.abort();
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });

        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (name: string, data: unknown) => {
              if (aborted) return;
              try {
                controller.enqueue(encoder.encode(sseEvent(name, data)));
              } catch {
                // Controller may already be closed if the consumer cancelled.
              }
            };
            // Track partials so we can persist on user_abort per spec C6 step 8.
            let assistantText = "";
            let lastProvider: ProviderId | null = null;
            let lastModel = "";
            let lastFallbackDepth = 0;
            let inputTokens: number | undefined;
            let outputTokens: number | undefined;
            let metaSeen = false;

            // Hoisted so both the catch block and finalizeAbort can inspect
            // it. Once non-null, runChainStream has already written
            // status='ok' usage and we must take the normal completion path
            // even if a disconnect happens after this point.
            let finalEvt: Extract<ChainStreamEvent, { kind: "done" }> | null = null;

            // Single source of truth for both abort code paths:
            //  (a) post-loop, when "if (aborted) break" exits the for-await
            //  (b) catch block, when runChainStream throws UserAbortError
            //      because the upstream fetch was aborted mid-await.
            // Idempotent — we only insert when there's something worth saving.
            let finalized = false;
            const finalizeAbort = async () => {
              if (finalized) return;
              // Never re-classify a completed generation: if the chain
              // succeeded (finalEvt captured), runChainStream already wrote
              // status='ok'. Bail out instead of writing a contradictory
              // user_abort row + bogus [interrupted] assistant copy.
              if (finalEvt) {
                try { controller.close(); } catch { /* already closed */ }
                return;
              }
              finalized = true;
              if (assistantText && metaSeen && lastProvider) {
                // Architect Day-4 LOW fix: include context_used + trait_sheet_version
                // on the aborted-message row so audit metadata isn't lost when a
                // user disconnects mid-stream after the broker has already run.
                const { data: abortRow } = await supabaseAdmin
                  .from("chat_messages")
                  .insert({
                    user_id: userId,
                    thread_id: threadId,
                    role: "assistant",
                    content: `${assistantText} [interrupted]`,
                    badge: effectiveBadge,
                    provider: lastProvider,
                    model: lastModel || null,
                    fallback_depth: lastFallbackDepth,
                    context_used:
                      broker.contextUsed.categories.length > 0 ? broker.contextUsed : null,
                    trait_sheet_version: broker.traitSheetVersion,
                  } as never)
                  .select("id")
                  .single();
                if (abortRow?.id) {
                  await logContextDecision({
                    userId,
                    messageId: abortRow.id,
                    badge: effectiveBadge,
                    strictestTier: tier,
                    contextUsed: broker.contextUsed,
                    fragmentLength: broker.fragment.length,
                    scrubBlocked: broker.scrubBlocked,
                    traitSheetVersion: broker.traitSheetVersion,
                  });
                }
                await supabaseAdmin
                  .from("inference_usage")
                  .insert({
                    user_id: userId,
                    thread_id: threadId,
                    badge: effectiveBadge,
                    provider_chain: [lastProvider],
                    provider_used: lastProvider,
                    model_used: lastModel || lastProvider,
                    fallback_depth: lastFallbackDepth,
                    input_tokens: inputTokens ?? null,
                    output_tokens: outputTokens ?? null,
                    latency_ms: 0,
                    status: "user_abort",
                  });
              }
              try { controller.close(); } catch { /* already closed */ }
            };

            try {
              send("init", { threadId, userMessageId: userRow.id });

              for await (const evt of runChainStream(
                {
                  userId,
                  threadId,
                  badge: effectiveBadge,
                  messages: [...historyMessages, { role: "user", content: v.content }],
                  paidTier,
                  systemPrompt: broker.fragment || undefined,
                  // Pre-flight assertCap() ran BEFORE the user-row insert
                  // above. Skip the inner re-check so a TOCTOU race cannot
                  // throw cap_exceeded here and orphan the user row.
                  assumeCapChecked: true,
                },
                { signal: userAbort.signal },
              )) {
                // Always inspect the event first — a 'done' that arrives in
                // the same tick as the abort flip must still be honored so
                // we don't drop a successful completion into the abort path.
                if (evt.kind === "done") {
                  finalEvt = evt;
                  lastProvider = evt.provider;
                  lastModel = evt.model;
                  lastFallbackDepth = evt.fallbackDepth;
                  inputTokens = evt.inputTokens;
                  outputTokens = evt.outputTokens;
                  break;
                }
                if (aborted) break;
                if (evt.kind === "meta") {
                  metaSeen = true;
                  lastProvider = evt.provider;
                  lastFallbackDepth = evt.fallbackDepth;
                  send("meta", {
                    provider: evt.provider,
                    fallbackDepth: evt.fallbackDepth,
                  });
                } else if (evt.kind === "delta") {
                  assistantText += evt.text;
                  send("delta", { text: evt.text });
                }
              }

              // No done event reached + we know we aborted → user disconnect
              // mid-stream. (finalizeAbort itself also no-ops if finalEvt was
              // captured, as a defense-in-depth check.)
              if (!finalEvt && aborted) {
                await finalizeAbort();
                return;
              }

              if (!finalEvt) {
                send("error", { kind: "internal", message: "Stream ended without done event" });
                controller.close();
                return;
              }

              // Persist assistant reply with routing breadcrumb + context audit.
              const { data: aRow } = await supabaseAdmin
                .from("chat_messages")
                .insert({
                  user_id: userId,
                  thread_id: threadId,
                  role: "assistant",
                  content: assistantText,
                  badge: effectiveBadge,
                  provider: finalEvt.provider,
                  model: finalEvt.model,
                  fallback_depth: finalEvt.fallbackDepth,
                  context_used:
                    broker.contextUsed.categories.length > 0 ? broker.contextUsed : null,
                  trait_sheet_version: broker.traitSheetVersion,
                } as never)
                .select("id")
                .single();

              // Step 8a — chat_context_log AFTER assistant persistence so the
              // FK target exists. Best-effort, non-blocking.
              if (aRow?.id) {
                await logContextDecision({
                  userId,
                  messageId: aRow.id,
                  badge: effectiveBadge,
                  strictestTier: tier,
                  contextUsed: broker.contextUsed,
                  fragmentLength: broker.fragment.length,
                  scrubBlocked: broker.scrubBlocked,
                  traitSheetVersion: broker.traitSheetVersion,
                });
              }

              await supabaseAdmin
                .from("chat_threads")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", threadId)
                .eq("user_id", userId);

              send("done", {
                messageId: aRow?.id ?? null,
                provider: finalEvt.provider,
                model: finalEvt.model,
                fallbackDepth: finalEvt.fallbackDepth,
                inputTokens: finalEvt.inputTokens ?? null,
                outputTokens: finalEvt.outputTokens ?? null,
                // D8 Day 5: ContextFooter needs the same payload that landed
                // on chat_messages.context_used. Sent here (rather than via a
                // round-trip query) so the UI can render the footer the
                // moment streaming completes, without an extra fetch.
                contextUsed:
                  broker.contextUsed.categories.length > 0 ? broker.contextUsed : null,
                traitSheetVersion: broker.traitSheetVersion,
              });
              controller.close();
            } catch (e) {
              // Same invariant as the post-loop branch: only treat as
              // user_abort if we never reached a successful done event.
              if ((aborted || e instanceof UserAbortError) && !finalized) {
                await finalizeAbort();
                return;
              }
              if (e instanceof CapExceededError) {
                send("error", {
                  kind: "cap_exceeded",
                  message: e.message,
                  badge: e.badge,
                  used: e.used,
                  cap: e.cap,
                });
              } else if (e instanceof ChainExhaustedError) {
                send("error", {
                  kind: "chain_exhausted",
                  message: e.message,
                  badge: e.badge,
                  lastErrorClass: e.lastErrorClass,
                });
              } else {
                const message = e instanceof Error ? e.message : "Internal error";
                send("error", { kind: "internal", message });
              }
              controller.close();
            }
          },
          cancel() {
            // Consumer (client fetch) cancelled the stream. Trip the same
            // abort path as request.signal so the upstream provider fetch is
            // cancelled and partial-state persistence runs in start()'s loop
            // exit branch above.
            onAbort();
          },
        });

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            Connection: "keep-alive",
          },
        });
      },
    },
  },
});

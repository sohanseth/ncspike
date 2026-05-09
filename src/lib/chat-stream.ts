/**
 * Client-side SSE consumer for the chat stream endpoint.
 *
 * Native EventSource doesn't support POST or custom headers, so we use
 * fetch() + ReadableStream and parse SSE manually.
 *
 * Usage:
 *   const stream = streamChatMessage({ threadId, content, badge, accessToken });
 *   for await (const evt of stream) {
 *     if (evt.kind === "delta") setText(t => t + evt.text);
 *     ...
 *   }
 *
 * Cancellation: pass an AbortSignal. Aborting closes the upstream connection
 * and the generator returns. The server will see a disconnect and (per spec)
 * write the partial assistant row with `inference_usage.status='user_abort'`
 * — TODO: wire user_abort handling on the server in a follow-up.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Badge } from "@/server/inference/router";

export type ChatStreamEvent =
  | { kind: "init"; threadId: string; userMessageId: string }
  | { kind: "meta"; provider: string; fallbackDepth: number }
  | { kind: "delta"; text: string }
  /** On-device PRIVATE only: WebLLM weights downloading on first run.
   *  pct in [0,100]. Consumers should render a loading indicator and
   *  NEVER append this to the assistant message text. */
  | { kind: "load_progress"; pct: number }
  | {
      kind: "done";
      messageId: string | null;
      provider: string;
      model: string;
      fallbackDepth: number;
      inputTokens: number | null;
      outputTokens: number | null;
      /** Personalization context the broker injected for this turn (D8). */
      contextUsed: { categories: string[]; trait_paths: string[] } | null;
      traitSheetVersion: number | null;
      /** Signed URLs for any images the assistant generated this turn. */
      assistantImages?: string[];
    }
  | {
      kind: "error";
      type: "cap_exceeded" | "chain_exhausted" | "validation" | "internal";
      message: string;
      badge?: Badge;
      used?: number;
      cap?: number;
      lastErrorClass?: string;
    };

export type StreamChatInput = {
  threadId: string | null;
  content: string;
  badge: Badge;
  /** Storage paths in the chat-attachments bucket. Optional. */
  attachments?: string[];
  signal?: AbortSignal;
};

export async function* streamChatMessage(
  input: StreamChatInput,
): AsyncGenerator<ChatStreamEvent, void, void> {
  // PRIVATE badge runs entirely on-device — never POST to /api/chat/stream.
  // The on-device runner emits the same ChatStreamEvent shape so the UI
  // consumer in MainApp.tsx is unchanged. See docs/11.
  //
  // Phase 2.9b: PRIVATE + image-intent forks to the on-device image-gen
  // runner BEFORE the text path so a "draw a cat" prompt under the
  // PRIVATE badge doesn't get answered with a textual hallucination
  // about a cat (the WebLLM text model has no image-out capability).
  // img2img is deferred per docs/12 §15.5 — attachments still hit the
  // text dispatcher, which has its own fail-closed for them.
  if (input.badge === "private") {
    const hasAttachments = (input.attachments?.length ?? 0) > 0;
    if (!hasAttachments) {
      const { detectImageIntent } = await import("./image-intent");
      if (
        detectImageIntent({ text: input.content, hasAttachments: false })
      ) {
        const { streamOnDevicePrivateImage } = await import(
          "./on-device-private-image"
        );
        yield* streamOnDevicePrivateImage(input);
        return;
      }
    }
    const { streamOnDeviceChat } = await import("./on-device-chat");
    yield* streamOnDeviceChat(input);
    return;
  }

  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    yield { kind: "error", type: "internal", message: "Not signed in" };
    return;
  }

  let res: Response;
  try {
    res = await fetch("/api/chat/stream", {
      method: "POST",
      signal: input.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        threadId: input.threadId,
        content: input.content,
        badge: input.badge,
        attachments: input.attachments ?? [],
      }),
    });
  } catch (e) {
    yield {
      kind: "error",
      type: "internal",
      message: e instanceof Error ? e.message : "Network error",
    };
    return;
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    yield {
      kind: "error",
      type: "internal",
      message: text || `HTTP ${res.status}`,
    };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE events are separated by "\n\n". Parse each complete event.
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const rawEvent = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const parsed = parseSseBlock(rawEvent);
        if (parsed) yield parsed;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

function parseSseBlock(block: string): ChatStreamEvent | null {
  let eventName = "message";
  let dataStr = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataStr += line.slice(5).replace(/^ /, "");
    }
  }
  if (!dataStr) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (eventName) {
    case "init":
      return {
        kind: "init",
        threadId: String(data.threadId ?? ""),
        userMessageId: String(data.userMessageId ?? ""),
      };
    case "meta":
      return {
        kind: "meta",
        provider: String(data.provider ?? ""),
        fallbackDepth: Number(data.fallbackDepth ?? 0),
      };
    case "delta":
      return { kind: "delta", text: String(data.text ?? "") };
    case "done": {
      const cu = data.contextUsed as { categories?: unknown; trait_paths?: unknown } | null;
      const contextUsed =
        cu && Array.isArray(cu.categories) && Array.isArray(cu.trait_paths)
          ? {
              categories: cu.categories.filter((c): c is string => typeof c === "string"),
              trait_paths: cu.trait_paths.filter((p): p is string => typeof p === "string"),
            }
          : null;
      const assistantImagesRaw = Array.isArray(data.assistantImages)
        ? data.assistantImages.filter((u): u is string => typeof u === "string" && u.length > 0)
        : undefined;
      return {
        kind: "done",
        messageId: data.messageId ? String(data.messageId) : null,
        provider: String(data.provider ?? ""),
        model: String(data.model ?? ""),
        fallbackDepth: Number(data.fallbackDepth ?? 0),
        inputTokens: data.inputTokens === null ? null : Number(data.inputTokens),
        outputTokens: data.outputTokens === null ? null : Number(data.outputTokens),
        contextUsed,
        traitSheetVersion:
          data.traitSheetVersion == null ? null : Number(data.traitSheetVersion),
        ...(assistantImagesRaw && assistantImagesRaw.length > 0
          ? { assistantImages: assistantImagesRaw }
          : {}),
      };
    }
    case "error": {
      const validTypes = ["cap_exceeded", "chain_exhausted", "validation", "internal"] as const;
      type ErrType = (typeof validTypes)[number];
      const rawKind = typeof data.kind === "string" ? data.kind : "internal";
      const errType: ErrType = (validTypes as readonly string[]).includes(rawKind)
        ? (rawKind as ErrType)
        : "internal";
      return {
        kind: "error",
        type: errType,
        message: String(data.message ?? "Unknown error"),
        ...(data.badge ? { badge: data.badge as Badge } : {}),
        ...(typeof data.used === "number" ? { used: data.used } : {}),
        ...(typeof data.cap === "number" ? { cap: data.cap } : {}),
        ...(data.lastErrorClass ? { lastErrorClass: String(data.lastErrorClass) } : {}),
      };
    }
    default:
      return null;
  }
}

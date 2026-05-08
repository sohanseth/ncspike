/**
 * Anthropic (Claude) provider. Default model: claude-haiku-4-5.
 * Model id verified live 2026-05-08. The 3.5-haiku family was retired in
 * Anthropic's 2025 model refresh; the 4.5 series is the current Haiku.
 *
 * Required env: ANTHROPIC_API_KEY
 * Optional env: ANTHROPIC_MODEL (override default)
 *
 * Anthropic's Messages API requires `max_tokens` to be set (no default), and
 * "system" messages are passed as a top-level `system` field, not in messages[].
 */
import {
  InferenceError,
  type InferenceChunk,
  type InferenceMessage,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";
import { parseSseEvents, httpErrorToInferenceError } from "./sse-helpers";

const DEFAULT_MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

function splitSystem(messages: InferenceMessage[]): {
  system?: string;
  msgs: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemTexts: string[] = [];
  const msgs: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") systemTexts.push(m.content);
    else msgs.push({ role: m.role, content: m.content });
  }
  return {
    msgs,
    ...(systemTexts.length > 0 ? { system: systemTexts.join("\n\n") } : {}),
  };
}

export const anthropicProvider: InferenceProvider = {
  id: "anthropic",
  privacyTier: 3,

  async generate(req: InferenceRequest): Promise<InferenceResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
      throw new InferenceError("Missing ANTHROPIC_API_KEY", "anthropic", {
        errorClass: "missing_credentials",
      });
    }

    const { system, msgs } = splitSystem(req.messages);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: msgs,
          ...(system ? { system } : {}),
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.4,
        }),
      });
    } catch (e) {
      const isAbort = (e as { name?: string })?.name === "AbortError";
      throw new InferenceError(
        isAbort ? "Anthropic request timed out" : "Anthropic fetch failed",
        "anthropic",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new InferenceError("Anthropic HTTP 429", "anthropic", {
        retriable: true,
        errorClass: "provider_429",
      });
    }
    if (res.status >= 500) {
      throw new InferenceError(`Anthropic HTTP ${res.status}`, "anthropic", {
        retriable: true,
        errorClass: "provider_5xx",
      });
    }
    if (!res.ok) {
      throw new InferenceError(`Anthropic HTTP ${res.status}`, "anthropic", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = json.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();
    if (!text) {
      throw new InferenceError("Anthropic returned empty response", "anthropic", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    return {
      text,
      provider: "anthropic",
      model,
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
  },

  async *generateStream(
    req: InferenceRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<InferenceChunk, void, void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    if (!apiKey) {
      throw new InferenceError("Missing ANTHROPIC_API_KEY", "anthropic", { errorClass: "missing_credentials" });
    }
    const { system, msgs } = splitSystem(req.messages);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: msgs,
          ...(system ? { system } : {}),
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.4,
          stream: true,
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      const isAbort = (e as { name?: string })?.name === "AbortError";
      throw new InferenceError(
        isAbort ? "Anthropic stream timed out" : "Anthropic stream fetch failed",
        "anthropic",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw httpErrorToInferenceError(res.status, "anthropic");
    }
    // Anthropic SSE: each event is type-tagged; we care about
    //   message_start  → carries usage.input_tokens
    //   content_block_delta → delta.type=text_delta with .text
    //   message_delta  → carries usage.output_tokens (final)
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const payload of parseSseEvents(res, "anthropic")) {
        try {
          const obj = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string };
            message?: { usage?: { input_tokens?: number } };
            usage?: { output_tokens?: number };
          };
          if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
            const text = obj.delta.text;
            if (text) yield { type: "delta", text };
          } else if (obj.type === "message_start" && obj.message?.usage?.input_tokens) {
            inputTokens = obj.message.usage.input_tokens;
          } else if (obj.type === "message_delta" && obj.usage?.output_tokens) {
            outputTokens = obj.usage.output_tokens;
          }
        } catch {
          // ignore
        }
      }
    } finally {
      clearTimeout(timer);
    }
    yield { type: "done", model, inputTokens, outputTokens };
  },
};

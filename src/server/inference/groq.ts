/**
 * Groq provider. OpenAI-compatible chat completions API on llama-3.3-70b-versatile.
 * Free tier: 30 RPM, 14.4K req/day shared. OSS weights, ZDR by default.
 *
 * Required env: GROQ_API_KEY
 * Optional env: GROQ_MODEL (override default)
 *
 * Model id verified live 2026-05-08. The previous llama-3.1-70b-versatile was
 * decommissioned by Groq; ListModels confirms 3.3-70b-versatile is current.
 */
import {
  InferenceError,
  type InferenceChunk,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";
import { parseSseEvents, httpErrorToInferenceError } from "./sse-helpers";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 60_000; // Streams can run longer than the request itself.

export const groqProvider: InferenceProvider = {
  id: "groq",
  privacyTier: 1,

  async generate(req: InferenceRequest): Promise<InferenceResult> {
    const apiKey = process.env.GROQ_API_KEY;
    const model = process.env.GROQ_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
      throw new InferenceError("Missing GROQ_API_KEY", "groq", {
        errorClass: "missing_credentials",
      });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: req.messages,
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.4,
        }),
      });
    } catch (e) {
      const isAbort = (e as { name?: string })?.name === "AbortError";
      throw new InferenceError(
        isAbort ? "Groq request timed out" : "Groq fetch failed",
        "groq",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new InferenceError(`Groq HTTP 429`, "groq", {
        retriable: true,
        errorClass: "provider_429",
      });
    }
    if (res.status >= 500) {
      throw new InferenceError(`Groq HTTP ${res.status}`, "groq", {
        retriable: true,
        errorClass: "provider_5xx",
      });
    }
    if (!res.ok) {
      throw new InferenceError(`Groq HTTP ${res.status}`, "groq", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new InferenceError("Groq returned empty response", "groq", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    return {
      text,
      provider: "groq",
      model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
  },

  async *generateStream(
    req: InferenceRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<InferenceChunk, void, void> {
    const apiKey = process.env.GROQ_API_KEY;
    const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
    if (!apiKey) {
      throw new InferenceError("Missing GROQ_API_KEY", "groq", { errorClass: "missing_credentials" });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    let res: Response;
    try {
      res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: req.messages,
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.4,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      const isAbort = (e as { name?: string })?.name === "AbortError";
      throw new InferenceError(
        isAbort ? "Groq stream timed out" : "Groq stream fetch failed",
        "groq",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw httpErrorToInferenceError(res.status, "groq");
    }
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const payload of parseSseEvents(res, "groq")) {
        if (payload === "[DONE]") break;
        try {
          const obj = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const text = obj.choices?.[0]?.delta?.content;
          if (text) yield { type: "delta", text };
          if (obj.usage) {
            inputTokens = obj.usage.prompt_tokens;
            outputTokens = obj.usage.completion_tokens;
          }
        } catch {
          // Ignore malformed JSON lines — Groq occasionally sends keep-alives.
        }
      }
    } finally {
      clearTimeout(timer);
    }
    yield { type: "done", model, inputTokens, outputTokens };
  },
};

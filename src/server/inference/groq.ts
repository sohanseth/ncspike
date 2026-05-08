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
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const TIMEOUT_MS = 15_000;

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
};

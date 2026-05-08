/**
 * OpenAI provider. Default model: gpt-4o-mini.
 * Note: when "gpt-5" model id becomes available, the GENIUS badge auto-uses
 * it via OPENAI_MODEL env override. Adapter is model-agnostic.
 *
 * Required env: OPENAI_API_KEY
 * Optional env: OPENAI_MODEL (override default)
 */
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

const DEFAULT_MODEL = "gpt-4o-mini";
const TIMEOUT_MS = 15_000;

export const openaiProvider: InferenceProvider = {
  id: "openai",
  privacyTier: 3,

  async generate(req: InferenceRequest): Promise<InferenceResult> {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
      throw new InferenceError("Missing OPENAI_API_KEY", "openai", {
        errorClass: "missing_credentials",
      });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
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
        isAbort ? "OpenAI request timed out" : "OpenAI fetch failed",
        "openai",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new InferenceError("OpenAI HTTP 429", "openai", {
        retriable: true,
        errorClass: "provider_429",
      });
    }
    if (res.status >= 500) {
      throw new InferenceError(`OpenAI HTTP ${res.status}`, "openai", {
        retriable: true,
        errorClass: "provider_5xx",
      });
    }
    if (!res.ok) {
      throw new InferenceError(`OpenAI HTTP ${res.status}`, "openai", {
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
      throw new InferenceError("OpenAI returned empty response", "openai", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    return {
      text,
      provider: "openai",
      model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
  },
};

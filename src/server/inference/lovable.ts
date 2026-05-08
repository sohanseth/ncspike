/**
 * Lovable AI Gateway provider. Uses the project's built-in LOVABLE_API_KEY,
 * so no extra setup required. Default model: google/gemini-3-flash-preview.
 *
 * Tier 2 (hosted closed, ZDR). Used as a tail fallback in flash/pro chains.
 * Hardened in D7 Day 1 to match the new adapter pattern: 15s timeout,
 * retriable flag on 429/5xx, and error messages that never embed provider
 * response bodies (which can echo prompt fragments).
 */
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

const DEFAULT_MODEL = "google/gemini-3-flash-preview";
const TIMEOUT_MS = 15_000;

export const lovableProvider: InferenceProvider = {
  id: "lovable",
  privacyTier: 2,

  async generate(req: InferenceRequest): Promise<InferenceResult> {
    const apiKey = process.env.LOVABLE_API_KEY;
    const model = process.env.LOVABLE_AI_MODEL || DEFAULT_MODEL;

    if (!apiKey) {
      throw new InferenceError("Missing LOVABLE_API_KEY", "lovable", {
        errorClass: "missing_credentials",
      });
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
        isAbort ? "Lovable AI request timed out" : "Lovable AI fetch failed",
        "lovable",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new InferenceError("Lovable AI HTTP 429", "lovable", {
        retriable: true,
        errorClass: "provider_429",
      });
    }
    if (res.status >= 500) {
      throw new InferenceError(`Lovable AI HTTP ${res.status}`, "lovable", {
        retriable: true,
        errorClass: "provider_5xx",
      });
    }
    if (!res.ok) {
      throw new InferenceError(`Lovable AI HTTP ${res.status}`, "lovable", {
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
      throw new InferenceError("Lovable AI returned empty response", "lovable", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    return {
      text,
      provider: "lovable",
      model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
  },
};

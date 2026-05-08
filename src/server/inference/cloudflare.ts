/**
 * Cloudflare Workers AI provider.
 * Default model: @cf/meta/llama-3.1-8b-instruct.
 *
 * Required env vars:
 *   CLOUDFLARE_ACCOUNT_ID — found in your Cloudflare dashboard URL.
 *   CLOUDFLARE_API_TOKEN  — token with "Workers AI: Read" permission.
 *
 * Optional:
 *   CLOUDFLARE_AI_MODEL — override the default model id.
 *
 * Tier 0 (on-platform). Used as the PRIVATE-badge primary and FLASH-badge tail
 * fallback. Hardened in D7 Day 1 to match the new adapter pattern: 15s
 * AbortController timeout, retriable flag on 429/5xx, and error messages that
 * never embed provider response bodies (which can echo prompt fragments).
 */
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const TIMEOUT_MS = 15_000;

export const cloudflareProvider: InferenceProvider = {
  id: "cloudflare",
  privacyTier: 0,

  async generate(req: InferenceRequest): Promise<InferenceResult> {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const model = process.env.CLOUDFLARE_AI_MODEL || DEFAULT_MODEL;

    if (!accountId || !apiToken) {
      const missing = [
        ...(!accountId ? ["CLOUDFLARE_ACCOUNT_ID"] : []),
        ...(!apiToken ? ["CLOUDFLARE_API_TOKEN"] : []),
      ];
      throw new InferenceError(
        `Missing Cloudflare env var(s): ${missing.join(", ")}`,
        "cloudflare",
        { errorClass: "missing_credentials" },
      );
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: req.messages,
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.4,
        }),
      });
    } catch (e) {
      const isAbort = (e as { name?: string })?.name === "AbortError";
      throw new InferenceError(
        isAbort ? "Cloudflare request timed out" : "Cloudflare fetch failed",
        "cloudflare",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new InferenceError("Cloudflare HTTP 429", "cloudflare", {
        retriable: true,
        errorClass: "provider_429",
      });
    }
    if (res.status >= 500) {
      throw new InferenceError(`Cloudflare HTTP ${res.status}`, "cloudflare", {
        retriable: true,
        errorClass: "provider_5xx",
      });
    }
    if (!res.ok) {
      throw new InferenceError(`Cloudflare HTTP ${res.status}`, "cloudflare", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    const json = (await res.json()) as {
      success?: boolean;
      result?: { response?: string };
    };

    if (!json.success || !json.result?.response) {
      throw new InferenceError("Cloudflare returned empty or unsuccessful response", "cloudflare", {
        retriable: false,
        errorClass: "bad_response_shape",
      });
    }

    return {
      text: json.result.response.trim(),
      provider: "cloudflare",
      model,
    };
  },
};

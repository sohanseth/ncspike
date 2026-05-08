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
  type InferenceChunk,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";
import { parseSseEvents, httpErrorToInferenceError } from "./sse-helpers";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";
const EMBEDDING_DIMENSIONS = 384;
const EMBEDDING_TIMEOUT_MS = 10_000;
const TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 60_000;

/**
 * Compute bge-small-en-v1.5 embeddings for one or more strings.
 *
 * Used by Phase 2.7's trait extractor to embed each top-level category at
 * extraction time, and by the per-request broker to embed the user's query
 * for cosine ranking.
 *
 * Shape: returns one 384-dim vector per input string, in the same order.
 * Throws `InferenceError` (with the same `errorClass` taxonomy as `generate`)
 * on missing creds / timeout / non-2xx / shape mismatch — callers can
 * `try/catch` and write `extraction_failures` rows on failure.
 */
export async function embedTexts(texts: readonly string[]): Promise<number[][]> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
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
  if (texts.length === 0) return [];

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${EMBEDDING_MODEL}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBEDDING_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: texts }),
    });
  } catch (e) {
    const isAbort = (e as { name?: string })?.name === "AbortError";
    throw new InferenceError(
      isAbort ? "Cloudflare embedding request timed out" : "Cloudflare embedding fetch failed",
      "cloudflare",
      { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) {
    throw new InferenceError("Cloudflare embedding HTTP 429", "cloudflare", {
      retriable: true,
      errorClass: "provider_429",
    });
  }
  if (res.status >= 500) {
    throw new InferenceError(`Cloudflare embedding HTTP ${res.status}`, "cloudflare", {
      retriable: true,
      errorClass: "provider_5xx",
    });
  }
  if (!res.ok) {
    throw new InferenceError(`Cloudflare embedding HTTP ${res.status}`, "cloudflare", {
      retriable: false,
      errorClass: "bad_response_shape",
    });
  }

  // Workers AI returns { result: { shape: [n, 384], data: number[][] } } for bge.
  const json = (await res.json()) as {
    success?: boolean;
    result?: { data?: number[][] };
  };
  const data = json.result?.data;
  if (!json.success || !Array.isArray(data) || data.length !== texts.length) {
    throw new InferenceError(
      "Cloudflare embedding returned unexpected shape",
      "cloudflare",
      { retriable: false, errorClass: "bad_response_shape" },
    );
  }
  for (const vec of data) {
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMENSIONS) {
      throw new InferenceError(
        `Cloudflare embedding wrong dimensions (expected ${EMBEDDING_DIMENSIONS})`,
        "cloudflare",
        { retriable: false, errorClass: "bad_response_shape" },
      );
    }
  }
  return data;
}

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

  async *generateStream(
    req: InferenceRequest,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<InferenceChunk, void, void> {
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
    // Cloudflare Workers AI streams as SSE (when stream:true), with payloads
    // shaped like {"response":"chunk"} per data line, terminated by "[DONE]".
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
    if (opts?.signal) {
      if (opts.signal.aborted) ctrl.abort();
      else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: req.messages,
          max_tokens: req.maxTokens ?? 512,
          temperature: req.temperature ?? 0.4,
          stream: true,
        }),
      });
    } catch (e) {
      clearTimeout(timer);
      const isAbort = (e as { name?: string })?.name === "AbortError";
      throw new InferenceError(
        isAbort ? "Cloudflare stream timed out" : "Cloudflare stream fetch failed",
        "cloudflare",
        { retriable: true, errorClass: isAbort ? "timeout" : "network", cause: e },
      );
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw httpErrorToInferenceError(res.status, "cloudflare");
    }
    try {
      for await (const payload of parseSseEvents(res, "cloudflare")) {
        if (payload === "[DONE]") break;
        try {
          const obj = JSON.parse(payload) as { response?: string };
          if (obj.response) yield { type: "delta", text: obj.response };
        } catch {
          // ignore
        }
      }
    } finally {
      clearTimeout(timer);
    }
    yield { type: "done", model };
  },
};

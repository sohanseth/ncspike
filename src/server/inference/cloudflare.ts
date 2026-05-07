/**
 * Cloudflare Workers AI provider.
 * Default model: @cf/meta/llama-3.1-8b-instruct.
 *
 * Requires env vars:
 *   CLOUDFLARE_ACCOUNT_ID — found in your Cloudflare dashboard URL.
 *   CLOUDFLARE_API_TOKEN  — token with "Workers AI: Read" permission.
 *
 * Optional:
 *   CLOUDFLARE_AI_MODEL — override the default model id.
 */
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
} from "./types";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export const cloudflareProvider: InferenceProvider = {
  id: "cloudflare",

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
      );
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
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
      throw new InferenceError("Cloudflare Workers AI fetch failed", "cloudflare", e);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new InferenceError(
        `Cloudflare Workers AI HTTP ${res.status}: ${body.slice(0, 500)}`,
        "cloudflare",
      );
    }

    const json = (await res.json()) as {
      success?: boolean;
      result?: { response?: string };
      errors?: Array<{ message: string }>;
    };

    if (!json.success || !json.result?.response) {
      const errMsg = json.errors?.map((e) => e.message).join("; ") || "unknown";
      throw new InferenceError(`Cloudflare Workers AI error: ${errMsg}`, "cloudflare");
    }

    return {
      text: json.result.response.trim(),
      provider: "cloudflare",
      model,
    };
  },
};

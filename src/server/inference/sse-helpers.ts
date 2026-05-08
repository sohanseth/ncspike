/**
 * Shared streaming helpers for inference adapters.
 *
 * Two parsers cover all six providers:
 *  - parseSseEvents() — OpenAI-compatible SSE (groq, openai, lovable, anthropic, google).
 *    Yields each `data:` payload as a string. Caller JSON-parses and extracts
 *    its provider-specific shape.
 *  - parseNdjson()    — newline-delimited JSON (cloudflare workers AI).
 *
 * Both parsers handle:
 *  - chunk boundaries falling mid-line (a "data: {..." can split across two
 *    network reads — we buffer until newline)
 *  - multi-byte UTF-8 character boundaries (TextDecoder with stream:true)
 *  - the "[DONE]" sentinel used by OpenAI-compat APIs (yielded as the literal
 *    string "[DONE]" so callers decide what to do — most break)
 */
import { InferenceError } from "./types";

/**
 * Read a Response.body and yield each event's reassembled `data:` payload.
 *
 * Per the SSE spec, events are separated by "\n\n" and an event may have
 * multiple `data:` lines whose payloads are joined with "\n". We honor that
 * even though no current provider produces multi-line data — keeping the
 * parser spec-compliant means a future provider switch won't silently drop
 * text. Comment lines (": …") and field lines other than `data:` (event:,
 * id:, retry:) are ignored — we only need the payload here.
 */
export async function* parseSseEvents(
  res: Response,
  provider: string,
): AsyncGenerator<string, void, void> {
  if (!res.body) {
    throw new InferenceError(`${provider} stream: empty body`, provider, {
      retriable: false,
      errorClass: "bad_response_shape",
    });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  const flushBlock = function* (block: string): Generator<string, void, void> {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // Other field lines (event:, id:, retry:) and comment (:) are ignored.
    }
    if (dataLines.length > 0) yield dataLines.join("\n");
  };
  // Find the next event boundary: SSE allows blank line as \n\n, \r\n\r\n,
  // or \r\r. We pre-normalize \r\n→\n on append so only \n\n / \r\n need
  // checking, and handle the rare bare-\r case with the broader regex.
  const NEXT_BOUNDARY = /\r?\n\r?\n|\r\r/;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
        if (buf.length > 0) {
          // Treat any trailing bytes as a final event block (servers don't
          // always emit the closing "\n\n").
          for (const payload of flushBlock(buf.replace(/\r\n?/g, "\n"))) yield payload;
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let m: RegExpExecArray | null;
      while ((m = NEXT_BOUNDARY.exec(buf)) !== null) {
        const block = buf.slice(0, m.index).replace(/\r\n?/g, "\n");
        buf = buf.slice(m.index + m[0].length);
        for (const payload of flushBlock(block)) yield payload;
      }
    }
  } finally {
    // Best-effort cancel on early return so the upstream connection closes.
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
}

/** Read a Response.body and yield each newline-delimited JSON object string. */
export async function* parseNdjson(
  res: Response,
  provider: string,
): AsyncGenerator<string, void, void> {
  if (!res.body) {
    throw new InferenceError(`${provider} stream: empty body`, provider, {
      retriable: false,
      errorClass: "bad_response_shape",
    });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buf += decoder.decode();
        const trimmed = buf.trim();
        if (trimmed.length > 0) yield trimmed;
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.length > 0) yield line;
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

/**
 * Map an HTTP error response (non-streaming, 4xx/5xx) into our InferenceError
 * taxonomy. Used by stream adapters before they start parsing the body.
 */
export function httpErrorToInferenceError(
  status: number,
  provider: string,
): InferenceError {
  if (status === 429) {
    return new InferenceError(`${provider} HTTP 429`, provider, {
      retriable: true,
      errorClass: "provider_429",
    });
  }
  if (status >= 500) {
    return new InferenceError(`${provider} HTTP ${status}`, provider, {
      retriable: true,
      errorClass: "provider_5xx",
    });
  }
  return new InferenceError(`${provider} HTTP ${status}`, provider, {
    retriable: false,
    errorClass: "bad_response_shape",
  });
}

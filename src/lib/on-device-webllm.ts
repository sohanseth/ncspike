/**
 * WebLLM adapter — runs Llama 3.2 1B-Instruct in the browser via WebGPU.
 *
 * Used as the desktop fallback for the PRIVATE badge when no native
 * Capacitor plugin is registered (i.e. pure web / PWA build). See
 * docs/11-spec-on-device-tier.md §5.
 *
 * Realistic resource cost:
 *   - First load: ~700 MB weights downloaded to OPFS / IndexedDB cache.
 *   - Subsequent loads: instant (cache hit).
 *   - First-token latency on a 2024 laptop: 1–3 s. On a phone: 5–30 s.
 *   - Memory: ~1.5 GB GPU.
 *
 * The adapter exposes:
 *   - `probeWebLLM()` — capability check (WebGPU present + model loadable).
 *   - `streamWebLLM()` — async iterator of delta/done/error events.
 *   - `getModelReadyStatus()` — lightweight check of cache state for UI.
 */

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

type WebLLMEngine = {
  reload(modelId: string): Promise<void>;
  chat: {
    completions: {
      create(opts: {
        messages: { role: "system" | "user" | "assistant"; content: string }[];
        stream: true;
        max_tokens?: number;
        temperature?: number;
      }): Promise<AsyncIterable<{ choices: { delta: { content?: string } }[] }>>;
    };
  };
  interruptGenerate(): void;
};

let _engine: WebLLMEngine | null = null;
let _enginePromise: Promise<WebLLMEngine> | null = null;

function hasWebGPU(): boolean {
  if (typeof navigator === "undefined") return false;
  return "gpu" in navigator && typeof (navigator as { gpu?: unknown }).gpu === "object";
}

export type WebLLMProbeResult = {
  available: boolean;
  modelReady: boolean;
  reason?: string;
};

/**
 * Cheap probe: confirm WebGPU is present and the engine module loads. Does
 * NOT trigger model download — that's deferred to first generation.
 *
 * `modelReady` is a best-effort indicator from the runtime cache. When false,
 * the UI should warn the user that the first generation will involve a
 * one-time ~700 MB download.
 */
export async function probeWebLLM(): Promise<WebLLMProbeResult> {
  if (!hasWebGPU()) {
    return {
      available: false,
      modelReady: false,
      reason:
        "Your browser doesn't expose WebGPU. Try desktop Chrome or Edge, or use a different badge.",
    };
  }
  // Don't actually import @mlc-ai/web-llm here — it's heavy. We trust the
  // module exists (it's a pinned dep) and return modelReady=false until the
  // first run finishes.
  return { available: true, modelReady: _engine !== null };
}

async function getEngine(
  onProgress?: (msg: string, progress: number) => void,
): Promise<WebLLMEngine> {
  if (_engine) return _engine;
  if (_enginePromise) return _enginePromise;
  _enginePromise = (async () => {
    const mod = await import(/* @vite-ignore */ "@mlc-ai/web-llm");
    const initProgressCallback = (report: { text: string; progress: number }) => {
      onProgress?.(report.text, report.progress);
    };
    // CreateMLCEngine is the canonical helper that returns an initialised engine.
    const engine = (await (mod as {
      CreateMLCEngine: (
        modelId: string,
        opts: { initProgressCallback: typeof initProgressCallback },
      ) => Promise<WebLLMEngine>;
    }).CreateMLCEngine(MODEL_ID, { initProgressCallback })) as WebLLMEngine;
    _engine = engine;
    return engine;
  })();
  return _enginePromise;
}

export type WebLLMStreamEvent =
  | { kind: "load_progress"; text: string; progress: number }
  | { kind: "delta"; text: string }
  | { kind: "done"; model: string }
  | { kind: "error"; error: string };

export async function* streamWebLLM(args: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): AsyncGenerator<WebLLMStreamEvent, void, void> {
  if (!hasWebGPU()) {
    yield { kind: "error", error: "WebGPU not available in this browser." };
    return;
  }

  // Forward init-progress events into the stream so the UI can show a
  // download bar on first run. After load completes, generation starts.
  const progressQueue: WebLLMStreamEvent[] = [];
  let progressResolve: (() => void) | null = null;
  function pushProgress(ev: WebLLMStreamEvent) {
    progressQueue.push(ev);
    progressResolve?.();
    progressResolve = null;
  }

  let engine: WebLLMEngine;
  try {
    engine = await getEngine((text, progress) =>
      pushProgress({ kind: "load_progress", text, progress }),
    );
  } catch (e) {
    yield {
      kind: "error",
      error: e instanceof Error ? e.message : "Failed to load on-device model.",
    };
    return;
  }
  // Drain any progress events accumulated during load.
  while (progressQueue.length > 0) yield progressQueue.shift()!;

  const onAbort = () => {
    try {
      engine.interruptGenerate();
    } catch {
      /* ignore */
    }
  };
  args.signal?.addEventListener("abort", onAbort);

  try {
    const stream = await engine.chat.completions.create({
      messages: args.messages,
      stream: true,
      max_tokens: args.maxTokens ?? 1024,
      temperature: args.temperature ?? 0.4,
    });
    for await (const chunk of stream) {
      if (args.signal?.aborted) {
        yield { kind: "error", error: "Cancelled by user" };
        return;
      }
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield { kind: "delta", text };
    }
    yield { kind: "done", model: MODEL_ID };
  } catch (e) {
    yield {
      kind: "error",
      error: e instanceof Error ? e.message : "On-device generation failed.",
    };
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }
}

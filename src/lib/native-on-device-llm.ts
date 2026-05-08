/**
 * JS-side bridge to the native `OnDeviceLLM` Capacitor plugin.
 *
 * The native Swift / Kotlin implementations live OUTSIDE this repo until
 * `npx cap add ios` / `npx cap add android` has been run on a Mac /
 * Android Studio. The Swift + Kotlin reference source is in
 * `docs/11-spec-on-device-tier.md` §3 and §4 — drop those files into the
 * generated native project and the bridge below activates automatically.
 *
 * Plugin contract (must be implemented identically on iOS and Android):
 *
 *   probe(): Promise<{
 *     available: boolean;
 *     platform: "ios" | "android";
 *     model: string;          // e.g. "apple-foundation-3b" or "gemini-nano"
 *     reason?: string;        // when available=false
 *   }>
 *
 *   generate({
 *     messages: Array<{ role: "system"|"user"|"assistant"; content: string }>;
 *     maxTokens?: number;
 *     temperature?: number;
 *     requestId: string;      // client-side uuid; used to address streaming events
 *   }): Promise<{ ok: true } | { ok: false; error: string }>
 *
 *   cancel({ requestId: string }): Promise<void>
 *
 *   addListener("onDeviceDelta",
 *     ({ requestId, text }: { requestId: string; text: string }) => void
 *   ): PluginListenerHandle
 *
 *   addListener("onDeviceDone",
 *     ({ requestId, model }: { requestId: string; model: string }) => void
 *   ): PluginListenerHandle
 *
 *   addListener("onDeviceError",
 *     ({ requestId, error }: { requestId: string; error: string }) => void
 *   ): PluginListenerHandle
 *
 * The bridge must NEVER ship raw conversation text to the host JS side
 * except via `delta` events — there is no return-the-whole-string mode.
 * Streaming-only keeps the memory footprint bounded and lets us cancel
 * cleanly mid-generation.
 */

export type NativeProbeResult = {
  available: boolean;
  platform: "ios" | "android";
  model?: string;
  reason?: string;
};

type PluginListenerHandle = { remove: () => Promise<void> };

type OnDeviceLLMPluginShape = {
  probe(): Promise<NativeProbeResult>;
  generate(opts: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    maxTokens?: number;
    temperature?: number;
    requestId: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  cancel(opts: { requestId: string }): Promise<void>;
  addListener(
    eventName: "onDeviceDelta" | "onDeviceDone" | "onDeviceError",
    handler: (ev: unknown) => void,
  ): Promise<PluginListenerHandle> | PluginListenerHandle;
};

async function loadPlugin(): Promise<OnDeviceLLMPluginShape | null> {
  if (typeof window === "undefined") return null;
  try {
    // @capacitor/core is only present in the native build. The dynamic import
    // is wrapped in try/catch so the pure web build doesn't break on a
    // missing module — Vite tree-shakes it out when not installed.
    const cap = await import(/* @vite-ignore */ "@capacitor/core");
    const plugin = (cap as { Capacitor?: { Plugins?: Record<string, unknown> } })
      .Capacitor?.Plugins?.OnDeviceLLM as OnDeviceLLMPluginShape | undefined;
    return plugin ?? null;
  } catch {
    return null;
  }
}

/** Capability probe. Resolves to `{available:false}` whenever the plugin is absent. */
export async function probeNativeOnDeviceLLM(): Promise<NativeProbeResult> {
  const plugin = await loadPlugin();
  if (!plugin) {
    return {
      available: false,
      platform: "ios", // unused when available=false
      reason: "Native on-device plugin not registered (web build).",
    };
  }
  try {
    return await plugin.probe();
  } catch (e) {
    return {
      available: false,
      platform: "ios",
      reason: e instanceof Error ? e.message : "probe failed",
    };
  }
}

export type NativeStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; model: string }
  | { kind: "error"; error: string };

/**
 * Run native on-device generation as an async iterator. Handles listener
 * lifecycle: subscribes on entry, removes on iterator return / throw / done.
 */
export async function* streamNativeOnDevice(args: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}): AsyncGenerator<NativeStreamEvent, void, void> {
  const plugin = await loadPlugin();
  if (!plugin) {
    yield { kind: "error", error: "Native on-device plugin not registered." };
    return;
  }

  const requestId = (typeof crypto !== "undefined" && "randomUUID" in crypto)
    ? crypto.randomUUID()
    : `od-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const queue: NativeStreamEvent[] = [];
  let resolveNext: ((v: void) => void) | null = null;
  let finished = false;

  function push(ev: NativeStreamEvent) {
    queue.push(ev);
    resolveNext?.();
    resolveNext = null;
    if (ev.kind === "done" || ev.kind === "error") finished = true;
  }

  const handleDelta = (ev: unknown) => {
    const e = ev as { requestId?: string; text?: string };
    if (e.requestId !== requestId) return;
    if (typeof e.text === "string" && e.text.length > 0) push({ kind: "delta", text: e.text });
  };
  const handleDone = (ev: unknown) => {
    const e = ev as { requestId?: string; model?: string };
    if (e.requestId !== requestId) return;
    push({ kind: "done", model: e.model ?? "unknown" });
  };
  const handleError = (ev: unknown) => {
    const e = ev as { requestId?: string; error?: string };
    if (e.requestId !== requestId) return;
    push({ kind: "error", error: e.error ?? "Unknown native error" });
  };

  const handles: PluginListenerHandle[] = [];
  const subscribe = async (
    name: "onDeviceDelta" | "onDeviceDone" | "onDeviceError",
    h: (ev: unknown) => void,
  ) => {
    const result = plugin.addListener(name, h);
    const handle = result instanceof Promise ? await result : result;
    handles.push(handle);
  };

  try {
    await subscribe("onDeviceDelta", handleDelta);
    await subscribe("onDeviceDone", handleDone);
    await subscribe("onDeviceError", handleError);

    const onAbort = () => {
      void plugin.cancel({ requestId }).catch(() => {});
      push({ kind: "error", error: "Cancelled by user" });
    };
    args.signal?.addEventListener("abort", onAbort);

    const start = await plugin.generate({
      messages: args.messages,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      requestId,
    });
    if (!start.ok) {
      yield { kind: "error", error: start.error };
      return;
    }

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      while (queue.length > 0) {
        const ev = queue.shift()!;
        yield ev;
      }
    }

    args.signal?.removeEventListener("abort", onAbort);
  } finally {
    await Promise.allSettled(handles.map((h) => h.remove()));
  }
}

/**
 * Phase 2.9b — WebGPU image-gen capability + dispatcher integration pin.
 *
 * Slice b ships ONLY the WebGPU SD-Turbo adapter. This test pins:
 *   1. A WebGPU adapter advertising ≥1 GB `maxBufferSize` resolves to
 *      `available: true, adapter: 'webgpu-sd-turbo'`. (Slice b mapping —
 *      both former SDXL/SD15 tiers collapse onto SD-Turbo for now.)
 *   2. The streamer's first `init` event after a successful capability
 *      probe carries that adapter id — proving the runner actually
 *      reaches the WebGPU SD-Turbo branch instead of any silent native
 *      fallback. PRIVATE is fail-closed (replit.md §"No silent fallbacks")
 *      so this branch identity matters.
 *
 * Pure-Node test — `navigator.gpu` is stubbed and the transformers.js
 * dynamic import is stubbed by a vi.mock so no real GPU or model weights
 * are touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const probeNativeMock = vi.fn();
vi.mock("@/lib/native-on-device-llm", () => ({
  probeNativeOnDeviceLLM: probeNativeMock,
}));

import {
  detectImageGenCapability,
  resetImageGenCapabilityCache,
} from "@/lib/image-gen-capability";
import { streamOnDeviceImageGen } from "@/lib/on-device-imagegen";
import {
  resetWebGpuSdTurboCache,
  webgpuSdTurboAdapter,
} from "@/lib/imagegen-adapters/webgpu-sd-turbo";

function setNavigatorGpu(maxBuffer: number): void {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      gpu: {
        requestAdapter: async () => ({ limits: { maxBufferSize: maxBuffer } }),
      },
    },
    configurable: true,
    writable: true,
  });
}

describe("Phase 2.9b — WebGPU image-gen capability + dispatcher", () => {
  beforeEach(() => {
    resetImageGenCapabilityCache();
    resetWebGpuSdTurboCache();
    probeNativeMock.mockReset();
    probeNativeMock.mockResolvedValue({ available: false });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: undefined },
      configurable: true,
      writable: true,
    });
  });

  it("WebGPU ≥1 GB → capability AVAILABLE + adapter='webgpu-sd-turbo'", async () => {
    setNavigatorGpu(1.5 * 1024 * 1024 * 1024);
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(true);
    if (cap.available) expect(cap.adapter).toBe("webgpu-sd-turbo");
  });

  it("WebGPU ≥2 GB (SDXL-class tier) still collapses onto webgpu-sd-turbo in slice b", async () => {
    setNavigatorGpu(4 * 1024 * 1024 * 1024);
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(true);
    if (cap.available) expect(cap.adapter).toBe("webgpu-sd-turbo");
  });

  it("dispatcher emits init{adapter:'webgpu-sd-turbo'} on a capable WebGPU device", async () => {
    setNavigatorGpu(2 * 1024 * 1024 * 1024);

    // Stub the adapter's stream so we don't actually touch transformers.js
    // — we only care the runner picked the right branch BEFORE any model
    // load. A minimal generator yields one error to terminate cleanly.
    const stubStream = vi.fn(async function* () {
      yield {
        kind: "error" as const,
        type: "internal" as const,
        message: "stub end",
      };
    });
    const original = webgpuSdTurboAdapter.stream;
    (
      webgpuSdTurboAdapter as unknown as { stream: typeof stubStream }
    ).stream = stubStream;

    const events: Array<{ kind: string; adapter?: string }> = [];
    try {
      for await (const ev of streamOnDeviceImageGen({ prompt: "draw a cat" })) {
        events.push(ev as { kind: string; adapter?: string });
      }
    } finally {
      (
        webgpuSdTurboAdapter as unknown as {
          stream: typeof original;
        }
      ).stream = original;
    }

    const init = events.find((e) => e.kind === "init");
    expect(init).toBeDefined();
    expect(init?.adapter).toBe("webgpu-sd-turbo");
  });
});

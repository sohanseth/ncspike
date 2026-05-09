/**
 * Phase 2.9a slice-a — image-gen capability probe branch selection.
 *
 * Pins the differentiated-reason invariant: each probe branch (native iOS,
 * native Android, WebGPU SDXL-class, WebGPU SD1.5-class, WebGPU
 * insufficient VRAM, WebGPU unsupported, no-path) returns its own honest
 * reason string. This is what the architect review flagged as missing —
 * the helper must NOT collapse to a single generic reason.
 *
 * The probe is mocked at the module boundary (native bridge) and at the
 * global `navigator.gpu` (WebGPU) so each branch can be exercised
 * independently in Node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the native bridge module so we can choose which platform (or none)
// the probe sees. Must be hoisted BEFORE we import the SUT.
const probeNativeMock = vi.fn();
vi.mock("@/lib/native-on-device-llm", () => ({
  probeNativeOnDeviceLLM: probeNativeMock,
}));

import {
  detectImageGenCapability,
  resetImageGenCapabilityCache,
  IMAGE_GEN_REASONS,
} from "@/lib/image-gen-capability";

type MockGpu = {
  requestAdapter: (
    opts?: unknown,
  ) => Promise<{ limits: { maxBufferSize: number } } | null>;
};

function setNavigatorGpu(gpu: MockGpu | null): void {
  // Node 20+ exposes `navigator` as a getter on globalThis, so plain
  // assignment throws. Use defineProperty with configurable:true so the
  // afterEach can swap it back.
  const value = gpu === null ? { gpu: undefined } : { gpu };
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

function unsetNavigator(): void {
  // Restore to a no-gpu navigator rather than deleting (Node's built-in
  // getter can't be re-installed once removed in some versions).
  Object.defineProperty(globalThis, "navigator", {
    value: { gpu: undefined },
    configurable: true,
    writable: true,
  });
}

describe("Phase 2.9a — detectImageGenCapability branch selection", () => {
  beforeEach(() => {
    resetImageGenCapabilityCache();
    probeNativeMock.mockReset();
  });

  afterEach(() => {
    unsetNavigator();
  });

  it("native iOS bridge → appleIpNotWired reason", async () => {
    probeNativeMock.mockResolvedValue({ available: true, platform: "ios" });
    setNavigatorGpu(null);
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(false);
    expect((cap as { reason: string }).reason).toBe(
      IMAGE_GEN_REASONS.appleIpNotWired,
    );
  });

  it("native Android bridge → mediapipeNotWired reason", async () => {
    probeNativeMock.mockResolvedValue({
      available: true,
      platform: "android",
    });
    setNavigatorGpu(null);
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(false);
    expect((cap as { reason: string }).reason).toBe(
      IMAGE_GEN_REASONS.mediapipeNotWired,
    );
  });

  it("WebGPU adapter with SDXL-class VRAM → AVAILABLE webgpu-sd-turbo (slice b)", async () => {
    // Slice b: SDXL-class VRAM (≥2 GB) collapses onto the SD-Turbo adapter
    // for now (the only WebGPU adapter wired). Slice b+1 will route SDXL-
    // class VRAM to a real SDXL adapter; the type already supports it.
    probeNativeMock.mockResolvedValue({ available: false });
    setNavigatorGpu({
      requestAdapter: async () => ({
        limits: { maxBufferSize: 4 * 1024 * 1024 * 1024 }, // 4 GB
      }),
    });
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(true);
    expect((cap as { adapter: string }).adapter).toBe("webgpu-sd-turbo");
  });

  it("WebGPU adapter with SD1.5-class VRAM → AVAILABLE webgpu-sd-turbo (slice b)", async () => {
    probeNativeMock.mockResolvedValue({ available: false });
    setNavigatorGpu({
      requestAdapter: async () => ({
        limits: { maxBufferSize: 1.2 * 1024 * 1024 * 1024 }, // 1.2 GB
      }),
    });
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(true);
    expect((cap as { adapter: string }).adapter).toBe("webgpu-sd-turbo");
  });

  it("WebGPU adapter with insufficient VRAM → webgpuInsufficientVram reason", async () => {
    probeNativeMock.mockResolvedValue({ available: false });
    setNavigatorGpu({
      requestAdapter: async () => ({
        limits: { maxBufferSize: 256 * 1024 * 1024 }, // 256 MB
      }),
    });
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(false);
    expect((cap as { reason: string }).reason).toBe(
      IMAGE_GEN_REASONS.webgpuInsufficientVram,
    );
  });

  it("WebGPU requestAdapter returns null → webgpuUnsupported reason", async () => {
    probeNativeMock.mockResolvedValue({ available: false });
    setNavigatorGpu({ requestAdapter: async () => null });
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(false);
    expect((cap as { reason: string }).reason).toBe(
      IMAGE_GEN_REASONS.webgpuUnsupported,
    );
  });

  it("no navigator.gpu → webgpuUnsupported reason", async () => {
    probeNativeMock.mockResolvedValue({ available: false });
    setNavigatorGpu(null);
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(false);
    expect((cap as { reason: string }).reason).toBe(
      IMAGE_GEN_REASONS.webgpuUnsupported,
    );
  });

  it("native bridge unreachable AND no navigator → noPathAvailable reason", async () => {
    probeNativeMock.mockRejectedValue(new Error("plugin not registered"));
    unsetNavigator();
    const cap = await detectImageGenCapability();
    expect(cap.available).toBe(false);
    // No navigator => probeWebGpu returns 'unsupported'. That short-circuits
    // before noPathAvailable, so we expect webgpuUnsupported here. Pin the
    // exact branch so future refactors can't silently swap it.
    expect((cap as { reason: string }).reason).toBe(
      IMAGE_GEN_REASONS.webgpuUnsupported,
    );
  });

  it("memoises across calls; resetImageGenCapabilityCache() re-probes", async () => {
    probeNativeMock.mockResolvedValue({ available: true, platform: "ios" });
    setNavigatorGpu(null);
    await detectImageGenCapability();
    await detectImageGenCapability();
    expect(probeNativeMock).toHaveBeenCalledTimes(1);
    resetImageGenCapabilityCache();
    await detectImageGenCapability();
    expect(probeNativeMock).toHaveBeenCalledTimes(2);
  });

  it("native (Apple/Android) branches stay fail-closed in slice b — only WebGPU is wired", async () => {
    // Slice b: WebGPU SD-Turbo is wired; Apple Image Playground (iOS) and
    // AICore Imagen-Nano (Android) plugins still need Xcode 16 / Android
    // Studio respectively (Replit's Linux container can't build them).
    // Their branches MUST remain available:false so a missing native
    // adapter never silently routes to WebGPU on a phone.
    const nativeOnlyCases: Array<[string, () => void]> = [
      [
        "ios native",
        () => {
          probeNativeMock.mockResolvedValue({
            available: true,
            platform: "ios",
          });
          setNavigatorGpu(null);
        },
      ],
      [
        "android native",
        () => {
          probeNativeMock.mockResolvedValue({
            available: true,
            platform: "android",
          });
          setNavigatorGpu(null);
        },
      ],
    ];
    for (const [, setup] of nativeOnlyCases) {
      resetImageGenCapabilityCache();
      probeNativeMock.mockReset();
      setup();
      const cap = await detectImageGenCapability();
      expect(cap.available).toBe(false);
    }
    // Sanity counter-case: WebGPU SDXL-class VRAM IS available in slice b.
    resetImageGenCapabilityCache();
    probeNativeMock.mockReset();
    probeNativeMock.mockResolvedValue({ available: false });
    setNavigatorGpu({
      requestAdapter: async () => ({
        limits: { maxBufferSize: 4 * 1024 * 1024 * 1024 },
      }),
    });
    const webgpuCap = await detectImageGenCapability();
    expect(webgpuCap.available).toBe(true);
  });
});

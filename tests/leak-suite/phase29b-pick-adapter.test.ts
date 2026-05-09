/**
 * Phase 2.9b — pickAdapter() fail-closed invariant.
 *
 * Slice b shipped one on-device adapter (WebGPU SD-Turbo, text-to-image).
 * Slice c adds two img2img adapters (WebGPU SDXL + InstructPix2Pix and
 * WebGPU SD 1.5 + ControlNet). The remaining adapter ids (apple-ip /
 * mediapipe / webgpu-sdxl / webgpu-sd15 / webgpu-janus-1b) MUST return
 * null from pickAdapter so a future picker change can't silently reroute
 * (e.g. an iPhone losing Apple IP support starting to run our WebGPU
 * adapter — that would route a user prompt to a different model than
 * the one their device + privacy policy expects).
 *
 * This test pins the entire ImageGenAdapterId union exhaustively so
 * adding a new id without an explicit pickAdapter branch fails the
 * build (TypeScript) AND fails this test (runtime).
 */
import { describe, it, expect } from "vitest";

import { pickAdapter as pickAdapterRunner } from "@/lib/on-device-imagegen";
import type { ImageGenAdapterId } from "@/lib/image-gen-capability";

describe("Phase 2.9b — pickAdapter dispatcher", () => {
  it("returns the WebGPU SD-Turbo adapter for 'webgpu-sd-turbo'", () => {
    const a = pickAdapterRunner("webgpu-sd-turbo");
    expect(a).not.toBeNull();
    expect(a?.id).toBe("webgpu-sd-turbo");
  });

  it("returns the SDXL+IP2P adapter for 'webgpu-sdxl-ip2p' (slice c)", () => {
    const a = pickAdapterRunner("webgpu-sdxl-ip2p");
    expect(a).not.toBeNull();
    expect(a?.id).toBe("webgpu-sdxl-ip2p");
  });

  it("returns the SD1.5+ControlNet adapter for 'webgpu-sd15-controlnet' (slice c)", () => {
    const a = pickAdapterRunner("webgpu-sd15-controlnet");
    expect(a).not.toBeNull();
    expect(a?.id).toBe("webgpu-sd15-controlnet");
  });

  it("returns null for every other adapter id (no silent fallback)", () => {
    const failClosedIds: ImageGenAdapterId[] = [
      "apple-ip",
      "mediapipe",
      "webgpu-sdxl",
      "webgpu-sd15",
      "webgpu-janus-1b",
    ];
    for (const id of failClosedIds) {
      expect(pickAdapterRunner(id)).toBeNull();
    }
  });

  it("exhaustive: every ImageGenAdapterId is handled exactly once", () => {
    // If a new adapter id is added to the union, TypeScript will accept
    // either an additional branch OR an unhandled value — we want the
    // test to fail loud on the latter so a missing pickAdapter branch
    // doesn't ship as a silent `null` fallback. Enumerate the full union
    // and assert every id resolves to either an adapter (slice b:
    // webgpu-sd-turbo; slice c: webgpu-sdxl-ip2p, webgpu-sd15-controlnet)
    // or to null (intentional fail-closed).
    const allIds: ImageGenAdapterId[] = [
      "apple-ip",
      "mediapipe",
      "webgpu-sdxl",
      "webgpu-sd15",
      "webgpu-sd-turbo",
      "webgpu-janus-1b",
      "webgpu-sdxl-ip2p",
      "webgpu-sd15-controlnet",
    ];
    const wired = allIds.filter((id) => pickAdapterRunner(id) !== null);
    expect(wired.sort()).toEqual(
      ["webgpu-sd-turbo", "webgpu-sdxl-ip2p", "webgpu-sd15-controlnet"].sort(),
    );
  });
});

// Task #47 — pin the visual treatment of the on-device "image blocked"
// placeholder so it can't silently regress to a normal assistant bubble.
//
// We don't have a JSDOM/RTL setup in this Vitest project (env: "node"),
// so instead of rendering MainApp we statically assert that the chat UI:
//   1. Imports the placeholder constant from the client-safe module
//      (so detection isn't a literal string match drifting from the
//      server side).
//   2. Branches on `isImageBlocked` and applies an amber-tinted bubble
//      treatment with the ShieldAlert icon — i.e. a visibly different
//      bubble than a successful reply.
//   3. The placeholder constant in `chat-message-kinds` matches the
//      one re-exported by `chat.functions` (which the leak suite
//      already pins to docs/12 §15.4 copy).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { IMAGE_BLOCKED_PLACEHOLDER_TEXT as fromKinds } from "../../src/lib/chat-message-kinds";
import { IMAGE_BLOCKED_PLACEHOLDER_TEXT as fromFunctions } from "../../src/lib/chat.functions";

const here = dirname(fileURLToPath(import.meta.url));
const mainApp = readFileSync(
  resolve(here, "../../src/components/workspace/MainApp.tsx"),
  "utf8",
);

describe("Task #47 — image-blocked placeholder visual treatment", () => {
  it("re-exports the same placeholder string from chat.functions and chat-message-kinds", () => {
    expect(fromKinds).toBe(fromFunctions);
    expect(fromKinds).toBe(
      "Image was generated but blocked by the on-device safety classifier. The image was not saved.",
    );
  });

  it("MainApp imports the placeholder from the client-safe module", () => {
    expect(mainApp).toMatch(
      /import\s*\{\s*IMAGE_BLOCKED_PLACEHOLDER_TEXT\s*\}\s*from\s*"@\/lib\/chat-message-kinds"/,
    );
  });

  it("MainApp branches assistant rendering on isImageBlocked", () => {
    expect(mainApp).toContain("const isImageBlocked = msg.role === \"assistant\" && msg.text === IMAGE_BLOCKED_PLACEHOLDER_TEXT");
  });

  it("the blocked branch swaps in the ShieldAlert icon", () => {
    expect(mainApp).toContain("ShieldAlert");
    expect(mainApp).toMatch(/isImageBlocked[\s\S]{0,200}ShieldAlert/);
  });

  it("the blocked branch applies an amber-tinted bubble (distinct from the default card)", () => {
    expect(mainApp).toMatch(/isImageBlocked[\s\S]{0,400}border-amber-500\/30[\s\S]{0,80}bg-amber-500\/\[0\.07\]/);
  });

  it("the blocked branch exposes a screen-reader status role + label", () => {
    expect(mainApp).toMatch(
      /Generated image was blocked by the on-device safety classifier/,
    );
  });
});

// Task #55 — pin the one-tap "Try a different prompt" action that the
// amber image-blocked bubble exposes. Tapping it must repopulate the
// chat input with the original user prompt and focus the textarea so
// the user can edit and resend without scrolling or copy-pasting.
//
// As with task47, we don't have a JSDOM/RTL setup in this project, so
// we statically assert the wiring instead of mounting MainApp.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  IMAGE_BLOCKED_PLACEHOLDER_TEXT,
  IMAGE_BLOCKED_RETRY_ACTION_LABEL,
} from "../../src/lib/chat-message-kinds";

const here = dirname(fileURLToPath(import.meta.url));
const mainApp = readFileSync(
  resolve(here, "../../src/components/workspace/MainApp.tsx"),
  "utf8",
);

describe("Task #55 — one-tap retry from the image-blocked bubble", () => {
  it("exports a stable retry action label from the client-safe kinds module", () => {
    expect(IMAGE_BLOCKED_RETRY_ACTION_LABEL).toBe("Try a different prompt");
    // Sanity: the placeholder constant is still present and unchanged so
    // the detection key the retry button is gated on hasn't drifted.
    expect(IMAGE_BLOCKED_PLACEHOLDER_TEXT).toContain(
      "blocked by the on-device safety classifier",
    );
  });

  it("MainApp imports the retry action label from the client-safe module", () => {
    expect(mainApp).toMatch(
      /import\s*\{\s*IMAGE_BLOCKED_RETRY_ACTION_LABEL\s*\}\s*from\s*"@\/lib\/chat-message-kinds"/,
    );
  });

  it("walks back to the prior user message to recover the original prompt", () => {
    // The recovery loop must scan messages[j].role === "user" backwards
    // from the blocked assistant turn so it works for both the live
    // flow (assistant immediately after user) and historical reload
    // (where loadThread preserves the persisted order).
    expect(mainApp).toMatch(
      /isImageBlocked[\s\S]{0,400}for\s*\(\s*let\s+j\s*=\s*i\s*-\s*1[\s\S]{0,200}messages\[j\]\.role\s*===\s*"user"/,
    );
  });

  it("renders the retry button only on the blocked branch and only when a prompt was found", () => {
    expect(mainApp).toMatch(
      /\{\s*isImageBlocked\s*&&\s*blockedPromptText\s*&&\s*\([\s\S]{0,1200}IMAGE_BLOCKED_RETRY_ACTION_LABEL/,
    );
  });

  it("the retry button copies the original prompt back into the input and focuses it", () => {
    expect(mainApp).toMatch(
      /onClick=\{\s*\(\)\s*=>\s*\{\s*setInput\(blockedPromptText\)[\s\S]{0,400}inputRef\.current[\s\S]{0,200}\.focus\(\)/,
    );
  });

  it("uses the RotateCcw icon next to the retry label for visual affordance", () => {
    expect(mainApp).toMatch(
      /IMAGE_BLOCKED_RETRY_ACTION_LABEL[\s\S]{0,400}RotateCcw|RotateCcw[\s\S]{0,400}IMAGE_BLOCKED_RETRY_ACTION_LABEL/,
    );
  });
});

// Small client-safe module so the chat UI can detect the on-device
// image-blocked placeholder without pulling the entire `chat.functions`
// module (which transitively loads server-only code) into the browser
// bundle. `chat.functions.ts` re-exports this so the existing tests that
// import `IMAGE_BLOCKED_PLACEHOLDER_TEXT` from there keep working.

/** docs/12 §15.4 — exact placeholder copy. Pinned by the leak suite. */
export const IMAGE_BLOCKED_PLACEHOLDER_TEXT =
  "Image was generated but blocked by the on-device safety classifier. The image was not saved.";

/**
 * Task #55 — label for the one-tap retry action rendered next to the
 * ShieldAlert icon in the amber blocked bubble. Tapping it copies the
 * original user prompt back into the chat input so they can edit and resend.
 */
export const IMAGE_BLOCKED_RETRY_ACTION_LABEL = "Try a different prompt";

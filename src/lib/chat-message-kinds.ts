// Small client-safe module so the chat UI can detect the on-device
// image-blocked placeholder without pulling the entire `chat.functions`
// module (which transitively loads server-only code) into the browser
// bundle. `chat.functions.ts` re-exports this so the existing tests that
// import `IMAGE_BLOCKED_PLACEHOLDER_TEXT` from there keep working.

/** docs/12 §15.4 — exact placeholder copy. Pinned by the leak suite. */
export const IMAGE_BLOCKED_PLACEHOLDER_TEXT =
  "Image was generated but blocked by the on-device safety classifier. The image was not saved.";

import { describe, it, expect } from "vitest";
import { CLOUD_FEATURES, CLOUD_FEATURE_KEYS, isConsentCurrent } from "@/lib/cloud-features";

describe("Prompt E cloud features", () => {
  it("has exactly the nine features", () => {
    expect(CLOUD_FEATURE_KEYS).toHaveLength(9);
  });
  it("hides voice_input from the Privacy page only", () => {
    expect(CLOUD_FEATURE_KEYS.filter((k) => !CLOUD_FEATURES[k].showOnPrivacyPage)).toEqual(["voice_input"]);
  });
  it("treats consent to an older wording as not current", () => {
    expect(isConsentCurrent("cloud_chat", { granted: true, wording_version: "2020-01-01" } as never)).toBe(false);
    expect(isConsentCurrent("cloud_chat", { granted: true, wording_version: CLOUD_FEATURES.cloud_chat.version } as never)).toBe(true);
  });
});

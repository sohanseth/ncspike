import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hard contract: no STT adapter may write audio to storage or POST it to a
 * non-provider endpoint. We greppy-scan the adapter sources and fail the
 * build if any storage primitive shows up. See spec §3 V4.
 *
 * Run with `bun test src/server/inference/stt`.
 */
const STT_DIR = dirname(fileURLToPath(import.meta.url)).replace(/__tests__$/, "");
const FORBIDDEN = [
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bopenDatabase\b/,
  /createObjectStore/,
  /writeFile/,
  /\.put\s*\(\s*audio/i,
];

describe("stt no-persistence contract", () => {
  const files = readdirSync(STT_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts" && f !== "types.ts",
  );

  for (const file of files) {
    it(`${file} touches no storage primitives`, () => {
      const src = readFileSync(join(STT_DIR, file), "utf8");
      for (const pat of FORBIDDEN) {
        expect(src).not.toMatch(pat);
      }
    });
  }
});

/**
 * Hard contract: no STT adapter may write audio to storage or POST it to a
 * non-provider endpoint. See spec §3 V4.
 *
 * This module exposes `assertNoSttPersistence()` which scans the adapter
 * source files at build time. Importing it from a top-level dev module (or
 * running it from a CI script) fails the build if any forbidden primitive
 * appears in an adapter file.
 *
 * The project does not have vitest/bun:test installed — when a runner is
 * added, wrap each entry in a real `it()` block.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "inference", "stt");

const FORBIDDEN: RegExp[] = [
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bopenDatabase\b/,
  /createObjectStore/,
  /writeFile/,
  /\.put\s*\(\s*audio/i,
];

export function assertNoSttPersistence(): void {
  const files = readdirSync(STT_DIR).filter(
    (f) =>
      f.endsWith(".ts") &&
      !f.endsWith(".test.ts") &&
      f !== "index.ts" &&
      f !== "types.ts",
  );

  for (const file of files) {
    const src = readFileSync(join(STT_DIR, file), "utf8");
    for (const pat of FORBIDDEN) {
      if (pat.test(src)) {
        throw new Error(
          `[stt no-persistence] ${file} matches forbidden pattern ${pat}. ` +
            `STT adapters MUST NOT touch storage primitives. See spec §3 V4.`,
        );
      }
    }
  }
}

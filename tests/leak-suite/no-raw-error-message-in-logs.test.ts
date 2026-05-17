/**
 * Invariant: no raw `error.message` in server-side logs.
 *
 * The no-content-in-logs invariant (docs/16 §15.1, §22 #3): user-supplied
 * content must never appear in `agent_runs.error`, `inference_usage.*`, or
 * structured stdout/stderr logs. Supabase echoes the conflicting value back
 * on constraint violations — `agent_findings (agent_id, dedupe_key)` unique
 * collisions, for example, will include the conflicting `dedupe_key` (often
 * a URL — user content) in `error.message`.
 *
 * PR3a wrapped 4 sites in `src/server/agents/runner.ts` and `batch.ts`. The
 * follow-up swept the rest of `src/server/` and now this test stops the
 * pattern from coming back.
 *
 * Rule: inside any `console.error|warn|log|info|debug` call, an interpolated
 * `.message` must be wrapped in `scrubErrorMessage(...)`. The scrubber
 * (`src/server/agents/error-scrub.ts`) strips quoted spans, URLs, emails,
 * and long digit runs, then truncates to 500 chars.
 *
 * Allowlist (NOT flagged): `error.message` inside `throw new Error(...)`.
 * Thrown errors re-enter the caller's catch and the runner runs them
 * through scrubErrorMessage at the outer layer before persistence.
 *
 * Excluded files: the scrubber itself (`error-scrub.ts`) and tests.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..", "..");
const SERVER_DIR = join(REPO_ROOT, "src", "server");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (st.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract every `console.(error|warn|log|info|debug)( ... )` call body from
 * `src`, with balanced-paren matching. Tracks string state so log strings
 * containing literal `(` or `)` don't confuse the depth counter.
 */
function extractConsoleCalls(src: string): Array<{ offset: number; body: string }> {
  const out: Array<{ offset: number; body: string }> = [];
  const re = /console\.(?:error|warn|log|info|debug)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    let i = m.index + m[0].length; // first char after the opening (
    let depth = 1;
    let str: '"' | "'" | "`" | null = null;
    let escape = false;
    let inLineComment = false;
    let inBlockComment = false;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      const next = src[i + 1];
      if (inLineComment) {
        if (c === "\n") inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (c === "*" && next === "/") {
          inBlockComment = false;
          i++;
        }
        continue;
      }
      if (str) {
        if (escape) {
          escape = false;
        } else if (c === "\\") {
          escape = true;
        } else if (c === str) {
          str = null;
        } else if (str === "`" && c === "$" && next === "{") {
          // Template literal interpolation — track inner expression with
          // its own depth so a `)` inside ${...} doesn't close the call.
          i++;
          let braceDepth = 1;
          let innerStr: '"' | "'" | "`" | null = null;
          let innerEscape = false;
          for (i++; i < src.length && braceDepth > 0; i++) {
            const ic = src[i];
            if (innerStr) {
              if (innerEscape) innerEscape = false;
              else if (ic === "\\") innerEscape = true;
              else if (ic === innerStr) innerStr = null;
            } else if (ic === '"' || ic === "'" || ic === "`") {
              innerStr = ic;
            } else if (ic === "{") {
              braceDepth++;
            } else if (ic === "}") {
              braceDepth--;
            }
          }
          i--; // re-enter outer string loop on next iteration
        }
        continue;
      }
      if (c === "/" && next === "/") {
        inLineComment = true;
        i++;
        continue;
      }
      if (c === "/" && next === "*") {
        inBlockComment = true;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        str = c;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
    }
    out.push({ offset: start, body: src.slice(start, i) });
  }
  return out;
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === "\n") line++;
  }
  return line;
}

describe("Invariant: no raw error.message in server-side logs (docs/16 §15.1, §22 #3)", () => {
  const FILES = walk(SERVER_DIR).filter(
    (f) =>
      // The scrubber itself is the sink — it owns the regex constants.
      !f.endsWith("agents/error-scrub.ts") &&
      !f.endsWith("agents\\error-scrub.ts"),
  );

  it("collects at least one source file (sanity)", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it("no console.error|warn|log|info|debug call interpolates raw .message", () => {
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      const calls = extractConsoleCalls(src);
      for (const call of calls) {
        // The call body starts with `console.error(` (etc) and ends at the
        // matching `)`. If it mentions `.message` without scrubErrorMessage
        // wrapping it, that's a leak vector.
        if (!/\.message\b/.test(call.body)) continue;
        if (/scrubErrorMessage\s*\(/.test(call.body)) continue;
        offenders.push({
          file: relative(REPO_ROOT, file),
          line: lineOf(src, call.offset),
          snippet: call.body.replace(/\s+/g, " ").slice(0, 160),
        });
      }
    }
    if (offenders.length > 0) {
      const formatted = offenders
        .map((o) => `  ${o.file}:${o.line}\n    ${o.snippet}`)
        .join("\n");
      throw new Error(
        `Found ${offenders.length} console call(s) leaking raw .message into logs.\n` +
          `Wrap with scrubErrorMessage(...) from src/server/agents/error-scrub.ts:\n${formatted}`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("guard regex catches a positive fixture (meta-test)", () => {
    const fixture = `
      function bad() {
        console.error("[oops] failed:", error.message);
      }
    `;
    const calls = extractConsoleCalls(fixture);
    expect(calls.length).toBe(1);
    expect(/\.message\b/.test(calls[0].body)).toBe(true);
    expect(/scrubErrorMessage\s*\(/.test(calls[0].body)).toBe(false);
  });

  it("guard regex passes a scrubbed fixture (meta-test)", () => {
    const fixture = `
      function good() {
        console.error("[ok] failed:", scrubErrorMessage(error.message));
      }
    `;
    const calls = extractConsoleCalls(fixture);
    expect(calls.length).toBe(1);
    expect(/\.message\b/.test(calls[0].body)).toBe(true);
    expect(/scrubErrorMessage\s*\(/.test(calls[0].body)).toBe(true);
  });

  it("balanced-paren walker handles multi-line calls with template literals", () => {
    const fixture =
      "function f() {\n" +
      "  console.error(\n" +
      "    `[x] status=${args.status}:`,\n" +
      "    scrubErrorMessage(error.message),\n" +
      "  );\n" +
      "  const y = 1;\n" +
      "}\n";
    const calls = extractConsoleCalls(fixture);
    expect(calls.length).toBe(1);
    expect(calls[0].body.endsWith(")")).toBe(true);
    expect(calls[0].body).toContain("scrubErrorMessage(error.message)");
  });
});

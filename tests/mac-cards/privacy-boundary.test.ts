import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import ts from "typescript";

const root = resolve(".");
const macModule = "src/lib/mac-cards.ts";
const allowedConsumers = new Set([
  "src/components/workspace/MacCards.tsx",
  "src/components/workspace/MacLists.tsx",
  "src/components/workspace/MacFound.tsx",
  "src/routes/link.ts",
]);
const allowedNetwork = new Set([
  "src/lib/relay.functions.ts:listRelayCards",
  "src/lib/relay-lists.functions.ts:listRelayLists",
  "src/lib/relay.functions.ts:listRelayDevices",
  "src/lib/relay-answers.functions.ts:sendRelayAnswer",
]);
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
const parse = (file: string, source = readFileSync(file, "utf8")) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
function localModule(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@/") ? resolve(root, "src", specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : undefined;
  if (!base) return;
  return [base, ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"].map(ext => base + ext)].find(candidate => existsSync(candidate) && /\.[jt]sx?$/.test(candidate));
}
type Edge = { specifier: string; names: string[]; typeOnly: boolean };
function imports(source: ts.SourceFile): Edge[] {
  const edges: Edge[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(e => !e.isTypeOnly).map(e => (e.propertyName ?? e.name).text) : bindings ? ["*"] : [];
      if (clause?.name) names.push("default");
      edges.push({ specifier: node.moduleSpecifier.text, names, typeOnly: Boolean(clause?.isTypeOnly || (clause && !clause.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(e => e.isTypeOnly))) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, names: ["*"], typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      // Dynamic imports expose the module namespace; traverse it in full.
      edges.push({ specifier: node.arguments[0].text, names: ["*"], typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}
function unexpectedConsumers() {
  return walk("src").filter(file => !allowedConsumers.has(file) && imports(parse(file)).some(edge => localModule(file, edge.specifier) === resolve(macModule))).sort();
}
function forbiddenCalls(source: ts.SourceFile): string[] {
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression.getText(source);
      if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|postMessage|Worker|SharedWorker)\b/.test(expression) || /\b(console|Sentry|analytics)\b/.test(expression)) failures.push(expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}
function networkViolations(entries: string[]) {
  const seen = new Set<string>();
  const violations: string[] = [];
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = parse(file);
    const label = relative(root, file);
    violations.push(...forbiddenCalls(source).map(call => `${label}:${call}`));
    for (const edge of imports(source).filter(edge => !edge.typeOnly)) {
      const target = localModule(file, edge.specifier);
      if (!target) {
        // Display dependencies only; AI, SDK, telemetry and other external
        // imports must not enter this graph, including through helper modules.
        if (!["react", "@tanstack/react-router", "lucide-react", "class-variance-authority", "clsx", "tailwind-merge", "zod", "@radix-ui/react-slot", "@radix-ui/react-checkbox"].includes(edge.specifier)) violations.push(`${label}:${edge.specifier}`);
        continue;
      }
      const targetLabel = relative(root, target);
      if (targetLabel.endsWith(".functions.ts")) {
        violations.push(...edge.names.filter(name => !allowedNetwork.has(`${targetLabel}:${name}`)).map(name => `${label}->${targetLabel}:${name}`));
      } else visit(target);
    }
  }
  entries.forEach(entry => visit(resolve(entry)));
  return violations.sort();
}

describe("Mac display-only privacy boundary", () => {
  // The user explicitly forbids changing existing consumers. Keep the exact
  // requested invariant executable and visibly expected-failing until those
  // existing imports can be changed with permission. No broader allowlist.
  it.fails("only MacCards, MacLists, /link and tests import mac-cards (known existing exceptions)", () => {
    expect(unexpectedConsumers()).toEqual([]);
  });
  it("reports exactly the existing exceptions without permitting new consumers", () => {
    expect(unexpectedConsumers()).toEqual([
      "src/components/workspace/ConnectMacSection.tsx",
      "src/components/workspace/MacWorthKnowing.tsx",
      "src/lib/mac-answer-state.ts",
    ]);
  });
  it("MacCards and MacLists reach the network only through the four permitted relay functions, including helper imports", () => {
    expect(networkViolations([...allowedConsumers].filter(file => file.endsWith("tsx")))).toEqual([]);
  });
  it("detects static, type-only, dynamic, relative and re-export import paths", () => {
    const file = "src/components/workspace/Boundary.tsx";
    const source = parse(file, `import type { MacCard } from "@/lib/mac-cards";
      import { answerCard as send } from "../../lib/mac-cards";
      export * from "@/lib/mac-cards";
      async function load() { return import("@/lib/mac-cards"); }`);
    expect(imports(source).map(edge => localModule(file, edge.specifier))).toEqual(Array(4).fill(resolve(macModule)));
    expect(imports(source).map(edge => edge.typeOnly)).toEqual([true, false, false, false]);
  });
  it("detects direct network, cross-context, logging and reporting calls", () => {
    const source = parse("boundary.ts", `fetch(data); window.fetch(data); navigator.sendBeacon(data);
      new WebSocket(data); new XMLHttpRequest(); new EventSource(data); worker.postMessage(data);
      new Worker(data); console.error(data); Sentry.captureException(data); analytics.track(data);`);
    expect(forbiddenCalls(source)).toEqual(["fetch", "window.fetch", "navigator.sendBeacon", "WebSocket", "XMLHttpRequest", "EventSource", "worker.postMessage", "Worker", "console.error", "Sentry.captureException", "analytics.track"]);
  });
});
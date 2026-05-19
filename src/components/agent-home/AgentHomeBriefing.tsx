/**
 * AgentHomeBriefing — v3 briefing render component (docs/25).
 *
 * Renders the v3 briefing JSON (ResearchDigestBriefingV3) in the layout
 * locked by docs/25 §4:
 *
 *   - Three things to keep in mind (skim mode)
 *   - What's new callout (highlighted, hidden if null)
 *   - Prose body (the read — paragraphs with inline [n] anchors)
 *   - Why this matters to you (broker-driven, hidden if null)
 *   - Sources collapsed (<details>)
 *
 * Defensive narrowing via safeBriefingV3 so a malformed JSONB row
 * degrades gracefully rather than crashing the render.
 *
 * Failure briefings (failureClass set) render with muted styling and
 * the sources <details> defaults to open so the user can scan titles
 * when synthesis didn't complete.
 *
 * Voice / wording guidance lives in docs/25 §6 and in the prompt;
 * this component just renders the LLM's output faithfully.
 */
import { ExternalLink, Star } from "lucide-react";

// ─── Types (mirror src/server/agents/templates/research-digest.ts) ───────

type BriefingProvenanceV3 = "new" | "continuing" | "recurring";

type BriefingKeepItemV3 = {
  text: string;
  provenance: BriefingProvenanceV3;
};

type BriefingSourceV3 = {
  dedupeKey: string;
  title: string;
  url: string;
  domain: string;
};

export type SafeBriefingV3 = {
  kind: "research";
  keepInMind: BriefingKeepItemV3[];
  proseBody: string;
  personalRelevance: string | null;
  whatsNew: string | null;
  qualityNote: string | null;
  sources: BriefingSourceV3[];
  failureClass: string | null;
};

// ─── Defensive narrowing ─────────────────────────────────────────────────

export function isV3Briefing(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const r = raw as Record<string, unknown>;
  return r.version === 3 && r.kind === "research";
}

function asString(v: unknown, max = 1000): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

function asProvenance(v: unknown): BriefingProvenanceV3 {
  return v === "continuing" || v === "recurring" ? v : "new";
}

export function safeBriefingV3(raw: unknown): SafeBriefingV3 | null {
  if (!isV3Briefing(raw)) return null;
  const r = raw as Record<string, unknown>;

  const proseBody = asString(r.proseBody, 2000);
  if (!proseBody) return null;

  const keepInMind: BriefingKeepItemV3[] = Array.isArray(r.keepInMind)
    ? (r.keepInMind as unknown[])
        .map((k) => {
          if (!k || typeof k !== "object") return null;
          const obj = k as Record<string, unknown>;
          const text = asString(obj.text, 400);
          if (!text) return null;
          return { text, provenance: asProvenance(obj.provenance) };
        })
        .filter((k): k is BriefingKeepItemV3 => k !== null)
    : [];

  const sources: BriefingSourceV3[] = Array.isArray(r.sources)
    ? (r.sources as unknown[])
        .map((s) => {
          if (!s || typeof s !== "object") return null;
          const obj = s as Record<string, unknown>;
          const dedupeKey = asString(obj.dedupeKey, 2000);
          const title = asString(obj.title, 600);
          const url = asString(obj.url, 2000);
          const domain = asString(obj.domain, 300);
          if (!dedupeKey || !title || !url || !domain) return null;
          return { dedupeKey, title, url, domain };
        })
        .filter((s): s is BriefingSourceV3 => s !== null)
    : [];

  return {
    kind: "research",
    keepInMind,
    proseBody,
    personalRelevance: asString(r.personalRelevance, 600),
    whatsNew: asString(r.whatsNew, 400),
    qualityNote: asString(r.qualityNote, 400),
    sources,
    failureClass: asString(r.failureClass, 40),
  };
}

export function isFailureBriefingV3(b: SafeBriefingV3): boolean {
  return b.failureClass !== null;
}

// ─── URL safety guard (same posture as workspace.inbox.tsx) ──────────────

function isSafeHttpUrl(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Provenance badge ────────────────────────────────────────────────────

const PROVENANCE_LABEL: Record<BriefingProvenanceV3, { label: string; cls: string }> = {
  new: {
    label: "NEW THIS RUN",
    cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  },
  continuing: { label: "", cls: "" },
  recurring: {
    label: "RESURFACED",
    cls: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  },
};

function ProvenanceBadge({ p }: { p: BriefingProvenanceV3 }) {
  const cfg = PROVENANCE_LABEL[p];
  if (!cfg.label) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wider ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

// ─── Prose-with-inline-references renderer ───────────────────────────────
//
// Renders proseBody as text with [n] markers replaced by clickable
// superscripts that scroll to the matching source in the <details>
// block. If the index doesn't resolve to a source, render the marker
// as plain text rather than a broken link.

function renderProseWithReferences(
  prose: string,
  sources: BriefingSourceV3[],
): React.ReactNode[] {
  // Split on [n] markers, preserving the markers as separate tokens.
  // Regex captures groups so split returns alternating text and marker.
  const tokens = prose.split(/(\[\d+\])/g);
  return tokens.map((token, i) => {
    const match = token.match(/^\[(\d+)\]$/);
    if (!match) return token;
    const idx = parseInt(match[1], 10) - 1;
    const source = sources[idx];
    if (!source || !isSafeHttpUrl(source.url)) {
      return (
        <sup key={i} className="text-muted-foreground/60">
          [{match[1]}]
        </sup>
      );
    }
    return (
      <sup key={i}>
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-emerald-300 hover:underline"
          title={`${source.title} (${source.domain})`}
        >
          [{match[1]}]
        </a>
      </sup>
    );
  });
}

// ─── Component ───────────────────────────────────────────────────────────

export function AgentHomeBriefing({
  briefing,
}: {
  briefing: SafeBriefingV3;
}) {
  const failure = isFailureBriefingV3(briefing);

  // Split proseBody into paragraphs by blank lines (or single newlines if
  // the LLM didn't blank-line-separate). Filter empty.
  const paragraphs = briefing.proseBody
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return (
    <div
      className={`rounded-xl border p-5 sm:p-6 space-y-6 ${
        failure ? "border-muted/30 bg-card/30" : "bg-card/60"
      }`}
    >
      {/* Three things to keep in mind (skim mode, top of page) */}
      {briefing.keepInMind.length > 0 && (
        <section aria-label="Three things to keep in mind" className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Three things to keep in mind
          </p>
          <ol className="space-y-2">
            {briefing.keepInMind.map((k, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-sm leading-relaxed"
              >
                <span className="font-mono text-muted-foreground/70 shrink-0 mt-0.5">
                  {i + 1}.
                </span>
                <span className="flex flex-wrap items-baseline gap-2 min-w-0">
                  <span>{k.text}</span>
                  <ProvenanceBadge p={k.provenance} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* What's new — highlighted callout */}
      {briefing.whatsNew && (
        <section
          aria-label="What's new this run"
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 space-y-1"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
            <span aria-hidden="true">●</span>{" "}
            <span>What's new this run</span>
          </p>
          <p className="text-sm leading-relaxed text-emerald-100/90">
            {briefing.whatsNew}
          </p>
        </section>
      )}

      {/* The read — prose body */}
      {paragraphs.length > 0 && (
        <section aria-label="Briefing prose" className="space-y-3">
          {paragraphs.map((para, i) => (
            <p key={i} className="text-sm leading-relaxed">
              {renderProseWithReferences(para, briefing.sources)}
            </p>
          ))}
        </section>
      )}

      {/* Why this matters to you — broker-driven */}
      {briefing.personalRelevance && (
        <section
          aria-label="Why this matters to you"
          className="border-l-2 border-sky-500/40 pl-3 space-y-1.5"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300/80">
            Why this matters to you
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {briefing.personalRelevance}
          </p>
        </section>
      )}

      {/* Quality note — small italic */}
      {briefing.qualityNote && !failure && (
        <p className="text-xs text-muted-foreground italic">
          {briefing.qualityNote}
        </p>
      )}

      {/* Sources — collapsed by default on success, open on failure */}
      {briefing.sources.length > 0 && (
        <details open={failure} className="group">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground/80 list-none flex items-center gap-1.5">
            <span aria-hidden="true" className="transition-transform group-open:rotate-90">
              ▸
            </span>
            <span>Sources checked: {briefing.sources.length}</span>
          </summary>
          <ol className="mt-3 space-y-1.5 pl-5 list-decimal">
            {briefing.sources.map((s) => (
              <li key={s.dedupeKey} className="text-sm text-muted-foreground">
                {isSafeHttpUrl(s.url) ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:underline underline-offset-4 hover:text-foreground/80"
                  >
                    {s.title}
                    <ExternalLink className="h-3 w-3 opacity-60" aria-hidden="true" />
                  </a>
                ) : (
                  <span>{s.title}</span>
                )}{" "}
                <span className="text-xs text-muted-foreground/60">
                  · {s.domain}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

// ─── Empty-state helper (when there's no v3 briefing yet) ────────────────

export function AgentHomeEmptyState({
  reason,
  detail,
  iconHint,
}: {
  reason: string;
  detail?: string;
  iconHint?: "no-runs" | "no-briefing" | "failed";
}) {
  return (
    <div className="rounded-xl border bg-card/30 p-5 sm:p-6 space-y-2">
      <p className="text-sm font-medium">{reason}</p>
      {detail && (
        <p className="text-sm text-muted-foreground leading-relaxed">{detail}</p>
      )}
      {/* iconHint reserved for future visual elements — kept as a hook,
          rendered as a small marker only if a value is provided. */}
      {iconHint && (
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground/60">
          <Star className="inline h-3 w-3 mr-1" aria-hidden="true" />
          {iconHint}
        </p>
      )}
    </div>
  );
}

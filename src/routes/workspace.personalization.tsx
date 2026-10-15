import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useTraitSheet } from "@/lib/use-trait-sheet";
import {
  applyPersonalizationPreset,
  blockProviderCategory,
  unblockProviderCategory,
  forgetTrait,
  removeTraitBlock,
  exportTraitSheet,
  deleteTraitSheet,
  scheduleReextract,
  type PersonalizationPreset,
} from "@/lib/personalization.functions";
import { TRAIT_CATEGORIES, type TraitCategory } from "@/lib/trait-schema";
import { cn } from "@/lib/utils";
import { Loader, Download, Trash2, RefreshCw, ShieldOff, X } from "lucide-react";
import { PersonalizationDisclosure } from "@/components/workspace/PersonalizationDisclosure";

export const Route = createFileRoute("/workspace/personalization")({
  component: PersonalizationPage,
  head: () => ({
    meta: [
      { title: "Personalization — Settings" },
      {
        name: "description",
        content:
          "Control how NeuralConnexions personalizes responses across providers. Pick a preset or fine-tune which trait categories each privacy tier can see.",
      },
      { property: "og:title", content: "Personalization — Settings" },
      { property: "og:description", content: "Control how NeuralConnexions personalizes responses across providers. Pick a preset or fine-tune which trait categories each privacy tier can see." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

const PRESETS: { id: PersonalizationPreset; name: string; copy: string }[] = [
  {
    id: "simple",
    name: "Simple",
    copy: "Spec defaults. Personalization on for trusted providers; sensitive categories hidden from third-party closed models.",
  },
  {
    id: "strict",
    name: "Strict",
    copy: "Minimal personalization for any provider that isn't on-device or open-weights. OpenAI / Anthropic see nothing.",
  },
  {
    id: "open",
    name: "Open",
    copy: "Clear every block. Spec tier defaults still apply (e.g. household never goes to closed providers).",
  },
];

// ─── Freshness label helpers ───────────────────────────────────────────────
// Pure formatting — given a `last_seen_at` / `expires_at` ISO string from
// `trait_meta`, produce the small human labels rendered next to each leaf.
// Server-side fallback chain (trait_meta → category_meta → derived_at) lives
// in personalization.functions.ts; here we just render whatever it handed us.

function formatRelativeDays(iso: string | null): { days: number; label: string } | null {
  if (iso == null) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const days = Math.round((Date.now() - t) / (24 * 60 * 60 * 1000));
  if (days < 0) return { days, label: `in ${-days}d` };
  if (days === 0) return { days, label: "today" };
  if (days === 1) return { days, label: "1 day ago" };
  return { days, label: `${days} days ago` };
}

function formatLastSeen(iso: string | null): string {
  const rel = formatRelativeDays(iso);
  return rel == null ? "no timestamp" : `re-confirmed ${rel.label}`;
}

function formatExpiry(iso: string | null): string {
  if (iso == null) return "expiry unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "expiry unknown";
  const days = Math.round((t - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return "expires today";
  if (days === 1) return "expires in 1 day";
  return `expires in ${days} days`;
}

function expiryClass(iso: string | null): string {
  if (iso == null) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.round((t - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "text-red-400/80";
  if (days <= 14) return "text-amber-400/80";
  return "";
}

const TIERS: { tier: 0 | 1 | 2 | 3; label: string; sub: string }[] = [
  { tier: 0, label: "T0", sub: "On-device (Cloudflare)" },
  { tier: 1, label: "T1", sub: "Open weights, ZDR (Groq)" },
  { tier: 2, label: "T2", sub: "Hosted closed, ZDR (Google, Lovable)" },
  { tier: 3, label: "T3", sub: "Hosted closed, no ZDR (OpenAI, Anthropic)" },
];

function PersonalizationPage() {
  const { user, loading: authLoading } = useAuth();
  const state = useTraitSheet();
  const [presetBusy, setPresetBusy] = useState<PersonalizationPreset | null>(null);
  const [matrixBusy, setMatrixBusy] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [forgetBusy, setForgetBusy] = useState<string | null>(null);

  if (authLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const onPreset = async (preset: PersonalizationPreset) => {
    if (presetBusy) return;
    setPresetBusy(preset);
    try {
      await applyPersonalizationPreset({ data: { preset } });
      await state.refresh();
    } finally {
      setPresetBusy(null);
    }
  };

  const onMatrixToggle = async (tier: 0 | 1 | 2 | 3, category: TraitCategory) => {
    const key = `${tier}:${category}`;
    if (matrixBusy) return;
    const isBlocked = state.providerBlocks.some(
      (b) => b.providerTier === tier && b.category === category,
    );
    setMatrixBusy(key);
    try {
      if (isBlocked) {
        await unblockProviderCategory({ data: { tier, category } });
      } else {
        await blockProviderCategory({ data: { tier, category } });
      }
      await state.refresh();
    } finally {
      setMatrixBusy(null);
    }
  };

  const onUnforget = async (category: TraitCategory, traitPath: string) => {
    await removeTraitBlock({ data: { category, traitPath } });
    await state.refresh();
  };

  const onForgetLeaf = async (category: TraitCategory, traitPath: string) => {
    if (forgetBusy) return;
    const key = `${category}:${traitPath}`;
    setForgetBusy(key);
    try {
      await forgetTrait({ data: { category, traitPath } });
      await state.refresh();
    } finally {
      setForgetBusy(null);
    }
  };

  const onExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportTraitSheet();
      const sheet = result.sheet == null ? null : JSON.parse(result.sheet);
      const payload = { version: result.version, sheet };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nc-trait-sheet-v${result.version ?? "0"}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const onDelete = async () => {
    if (deleting) return;
    if (!window.confirm("Delete your trait sheet? This wipes the personalization data the extractor has derived. Past chat history is unaffected.")) {
      return;
    }
    setDeleting(true);
    try {
      await deleteTraitSheet();
      await state.refresh();
    } finally {
      setDeleting(false);
    }
  };

  const onReextract = async () => {
    if (reextracting) return;
    setReextracting(true);
    try {
      await scheduleReextract();
      await state.refresh();
    } finally {
      setReextracting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <PersonalizationDisclosure userId={user.id} />
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl">Personalization</h1>
            <p className="text-sm text-muted-foreground">
              Control how NC tailors replies — and which providers ever see your trait sheet.
            </p>
          </div>
          <Link to="/workspace" className="text-sm text-primary hover:underline">
            ← Back
          </Link>
        </header>

        {state.error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300/90">
            {state.error}
          </div>
        )}

        {/* Presets */}
        <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur space-y-4">
          <h2 className="font-display text-lg">Choose a preset</h2>
          <div className="grid sm:grid-cols-3 gap-3">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPreset(p.id)}
                disabled={presetBusy !== null}
                className={cn(
                  "rounded-xl border border-border bg-background/40 p-4 text-left transition-colors",
                  "hover:border-primary/40 disabled:opacity-60",
                  presetBusy === p.id && "border-primary/60",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-display text-base">{p.name}</span>
                  {presetBusy === p.id && <Loader size={12} className="animate-spin" />}
                </div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">{p.copy}</p>
              </button>
            ))}
          </div>
        </section>

        {/* Trait sheet viewer */}
        <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-display text-lg">Your trait sheet</h2>
              <p className="text-xs text-muted-foreground">
                {state.loading
                  ? "Loading…"
                  : state.sheet?.exists
                    ? `Version ${state.sheet.version} · derived from ${state.sheet.sourceCount} memories${state.sheet.derivedAt ? ` · ${new Date(state.sheet.derivedAt).toLocaleDateString()}` : ""}`
                    : "No sheet yet — the extractor runs nightly once you have enough chat history."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onReextract}
                disabled={reextracting || !state.sheet?.exists}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs hover:border-primary/40 disabled:opacity-50"
              >
                {reextracting ? (
                  <Loader size={11} className="animate-spin" />
                ) : (
                  <RefreshCw size={11} />
                )}
                Re-extract
              </button>
              <button
                type="button"
                onClick={onExport}
                disabled={exporting || !state.sheet?.exists}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs hover:border-primary/40 disabled:opacity-50"
              >
                {exporting ? (
                  <Loader size={11} className="animate-spin" />
                ) : (
                  <Download size={11} />
                )}
                Export
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting || !state.sheet?.exists}
                className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
              >
                {deleting ? (
                  <Loader size={11} className="animate-spin" />
                ) : (
                  <Trash2 size={11} />
                )}
                Delete
              </button>
            </div>
          </div>
          {state.sheet?.exists && state.sheet.categories.length > 0 && (
            <div className="space-y-3 pt-2">
              {state.sheet.categories.map(({ category, leaves }) => {
                // Hide leaves the user has just blocked via "Forget" so the row
                // disappears immediately on click — the actual removal from the
                // sheet only happens on the next extraction run, but the broker
                // is already honouring the block.
                const blockedPaths = new Set(
                  state.traitBlocks
                    .filter((b) => b.category === category)
                    .map((b) => b.traitPath),
                );
                const visibleLeaves = leaves.filter((l) => !blockedPaths.has(l.path));
                if (visibleLeaves.length === 0) return null;
                return (
                <div key={category} className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">
                    <span className="capitalize text-foreground/80">{category}</span>
                    <span className="opacity-60"> — {visibleLeaves.length} traits</span>
                  </div>
                  <ul className="space-y-1">
                    {visibleLeaves.map((leaf) => {
                      const key = `${category}:${leaf.path}`;
                      // The path includes the category prefix (e.g. "preferences.diet"
                      // or "household.child_1.interests"); strip it so the row is
                      // readable.
                      const display = leaf.path.startsWith(`${category}.`)
                        ? leaf.path.slice(category.length + 1)
                        : leaf.path;
                      return (
                        <li
                          key={key}
                          className="flex items-center justify-between gap-3 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
                        >
                          <span className="font-mono text-xs text-foreground/80 truncate">
                            {display}
                          </span>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span title={leaf.lastSeenAt ?? "no timestamp"}>
                              {formatLastSeen(leaf.lastSeenAt)}
                            </span>
                            <span className={cn("opacity-70", expiryClass(leaf.expiresAt))}>
                              · {formatExpiry(leaf.expiresAt)}
                            </span>
                            <button
                              type="button"
                              onClick={() => onForgetLeaf(category, leaf.path)}
                              disabled={forgetBusy === key}
                              className="ml-1 inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                              title={`Forget ${display}`}
                              aria-label={`Forget ${category} ${display}`}
                            >
                              {forgetBusy === key ? (
                                <Loader size={9} className="animate-spin" />
                              ) : (
                                <X size={9} />
                              )}
                              Forget
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Trait blocks (forgotten traits) */}
        {state.traitBlocks.length > 0 && (
          <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur space-y-2">
            <h2 className="font-display text-lg">Forgotten traits</h2>
            <p className="text-xs text-muted-foreground">
              The extractor will not recreate these until the block expires.
            </p>
            <ul className="text-xs space-y-1 pt-2">
              {state.traitBlocks.map((b) => (
                <li
                  key={`${b.category}:${b.traitPath}`}
                  className="flex items-center justify-between gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
                >
                  <span className="font-mono text-foreground/70">{b.traitPath}</span>
                  <button
                    type="button"
                    onClick={() => onUnforget(b.category, b.traitPath)}
                    className="text-xs text-primary hover:underline"
                  >
                    Unforget
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Advanced matrix */}
        <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="w-full text-left flex items-center justify-between"
          >
            <div>
              <h2 className="font-display text-lg">Advanced — provider × category matrix</h2>
              <p className="text-xs text-muted-foreground">
                Block specific trait categories on specific privacy tiers. Spec defaults
                always apply on top: e.g. household never reaches T2/T3 even if you enable it here.
              </p>
            </div>
            <ShieldOff size={14} className="text-muted-foreground" />
          </button>
          {advanced && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-mono uppercase tracking-wider text-[10px]">
                      Tier
                    </th>
                    {TRAIT_CATEGORIES.map((c) => (
                      <th
                        key={c}
                        className="py-1.5 px-2 font-mono uppercase tracking-wider text-[10px] capitalize"
                      >
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TIERS.map(({ tier, label, sub }) => (
                    <tr key={tier} className="border-t border-white/[0.06]">
                      <td className="py-2 pr-3">
                        <div className="font-mono text-[11px] text-foreground/80">{label}</div>
                        <div className="text-[10px] text-muted-foreground/70">{sub}</div>
                      </td>
                      {TRAIT_CATEGORIES.map((cat) => {
                        const blocked = state.providerBlocks.some(
                          (b) => b.providerTier === tier && b.category === cat,
                        );
                        const key = `${tier}:${cat}`;
                        return (
                          <td key={cat} className="py-2 px-2 align-middle text-center">
                            <button
                              type="button"
                              onClick={() => onMatrixToggle(tier, cat)}
                              disabled={matrixBusy === key}
                              className={cn(
                                "h-5 w-5 rounded border transition-colors",
                                blocked
                                  ? "border-red-400/50 bg-red-500/20"
                                  : "border-white/[0.1] bg-white/[0.03] hover:border-primary/40",
                                matrixBusy === key && "opacity-50",
                              )}
                              title={
                                blocked
                                  ? `Click to allow ${cat} on tier ${tier}`
                                  : `Click to block ${cat} on tier ${tier}`
                              }
                              aria-pressed={blocked}
                              aria-label={`${blocked ? "Blocked" : "Allowed"}: ${cat} on tier ${tier}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

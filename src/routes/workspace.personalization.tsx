import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useTraitSheet } from "@/lib/use-trait-sheet";
import {
  applyPersonalizationPreset,
  blockProviderCategory,
  unblockProviderCategory,
  removeTraitBlock,
  exportTraitSheet,
  deleteTraitSheet,
  scheduleReextract,
  type PersonalizationPreset,
} from "@/lib/personalization.functions";
import { TRAIT_CATEGORIES, type TraitCategory } from "@/lib/trait-schema";
import { cn } from "@/lib/utils";
import { Loader, Download, Trash2, RefreshCw, ShieldOff } from "lucide-react";
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
            <ul className="text-xs text-muted-foreground space-y-1.5 pt-2">
              {state.sheet.categories.map(({ category, paths }) => (
                <li key={category}>
                  <span className="capitalize text-foreground/80">{category}</span>
                  <span className="opacity-60"> — {paths.length} traits</span>
                </li>
              ))}
            </ul>
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

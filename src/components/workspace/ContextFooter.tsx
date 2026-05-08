/**
 * ContextFooter — shown under each assistant message in ChatPanel.
 *
 * Collapsed: "Used: physical (hair, scalp), preferences (tone)" + chevron.
 * Expanded:  per-trait list with "Forget this trait" buttons + a global
 *            "Always exclude from this provider" action targeting the
 *            current message's provider tier.
 *
 * Spec: docs/06-spec-phase-2.7-context-broker.md §B6 (UI surfaces).
 *
 * Inputs come from the SSE done event's contextUsed payload — the broker
 * already mapped categories + leaf trait paths at assembly time.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Eraser, ShieldOff, Loader } from "lucide-react";
import {
  forgetTrait,
  blockProviderCategory,
  removeTraitBlock,
  unblockProviderCategory,
} from "@/lib/personalization.functions";
import { PROVIDER_TIERS, type ProviderId } from "@/server/inference/tiers";
import type { TraitCategory } from "@/lib/trait-schema";

export type ContextUsed = {
  categories: TraitCategory[];
  trait_paths: string[];
};

export type ContextFooterProps = {
  contextUsed: ContextUsed;
  /** The provider that ultimately served this turn — used for the "Always
   *  exclude from this provider" action. */
  provider: string | null;
};

function summarise(contextUsed: ContextUsed): string {
  // Group leaf paths by category for the collapsed copy.
  const byCat = new Map<TraitCategory, string[]>();
  for (const path of contextUsed.trait_paths) {
    const [cat, ...rest] = path.split(".");
    if (!cat || !rest.length) continue;
    const tail = rest.join(".");
    if (!byCat.has(cat as TraitCategory)) byCat.set(cat as TraitCategory, []);
    const arr = byCat.get(cat as TraitCategory)!;
    if (!arr.includes(tail)) arr.push(tail);
  }
  const parts: string[] = [];
  for (const cat of contextUsed.categories) {
    const leaves = byCat.get(cat) ?? [];
    parts.push(leaves.length > 0 ? `${cat} (${leaves.slice(0, 3).join(", ")})` : cat);
  }
  return parts.join(" · ");
}

function tierForProvider(provider: string | null): 0 | 1 | 2 | 3 | null {
  if (!provider) return null;
  const t = (PROVIDER_TIERS as Record<string, number>)[provider as ProviderId];
  if (t === 0 || t === 1 || t === 2 || t === 3) return t;
  return null;
}

export function ContextFooter({ contextUsed, provider }: ContextFooterProps) {
  const [open, setOpen] = useState(false);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState<TraitCategory | null>(null);
  const [forgotten, setForgotten] = useState<Set<string>>(new Set());
  const [providerBlocked, setProviderBlocked] = useState<Set<TraitCategory>>(new Set());

  const tier = useMemo(() => tierForProvider(provider), [provider]);
  const summary = useMemo(() => summarise(contextUsed), [contextUsed]);

  if (contextUsed.categories.length === 0) return null;

  const onForget = async (category: TraitCategory, traitPath: string) => {
    if (busyPath) return;
    setBusyPath(traitPath);
    try {
      await forgetTrait({ data: { category, traitPath } });
      setForgotten((prev) => {
        const next = new Set(prev);
        next.add(traitPath);
        return next;
      });
      // 10s undo window via toast — the trait_blocks row is reversible by
      // calling removeTraitBlock; we expose that as a one-click action so
      // an accidental click doesn't feel like a 365-day commitment.
      void import("sonner").then(({ toast }) => {
        toast(`Forgot "${traitPath.split(".").pop()}"`, {
          description: "Blocked for 365 days. The extractor won't recreate it.",
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => {
              void removeTraitBlock({ data: { category, traitPath } }).then(() => {
                setForgotten((prev) => {
                  const next = new Set(prev);
                  next.delete(traitPath);
                  return next;
                });
              });
            },
          },
        });
      });
    } catch (e) {
      console.warn("[ContextFooter] forget failed:", e);
    } finally {
      setBusyPath(null);
    }
  };

  const onBlockProvider = async (category: TraitCategory) => {
    if (tier == null || providerBusy) return;
    setProviderBusy(category);
    try {
      await blockProviderCategory({ data: { tier, category } });
      setProviderBlocked((prev) => {
        const next = new Set(prev);
        next.add(category);
        return next;
      });
      void import("sonner").then(({ toast }) => {
        toast(`Blocked ${category} on tier ${tier}`, {
          description: `${provider ?? "This provider"} won't see this category again.`,
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => {
              void unblockProviderCategory({ data: { tier, category } }).then(() => {
                setProviderBlocked((prev) => {
                  const next = new Set(prev);
                  next.delete(category);
                  return next;
                });
              });
            },
          },
        });
      });
    } catch (e) {
      console.warn("[ContextFooter] provider-block failed:", e);
    } finally {
      setProviderBusy(null);
    }
  };

  return (
    <div className="ml-8 mt-1.5 text-[10.5px] font-mono text-muted-foreground/55">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 px-1.5 py-px rounded-md bg-white/[0.025] border border-white/[0.05] hover:border-white/15 hover:text-foreground/70 transition-colors"
        aria-expanded={open}
      >
        <span className="opacity-70">Used:</span>
        <span className="truncate max-w-[260px]">{summary}</span>
        {open ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
      </button>

      {open && (
        <div className="mt-1.5 rounded-md border border-white/[0.06] bg-white/[0.02] p-2 space-y-2">
          <div className="space-y-1">
            {contextUsed.categories.map((cat) => {
              const paths = contextUsed.trait_paths.filter((p) => p.startsWith(`${cat}.`));
              return (
                <div key={cat} className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground/65 capitalize">{cat}</span>
                    {tier != null && (
                      <button
                        type="button"
                        onClick={() => onBlockProvider(cat)}
                        disabled={providerBusy === cat || providerBlocked.has(cat)}
                        className="inline-flex items-center gap-1 px-1.5 py-px rounded text-[9.5px] hover:text-foreground/70 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={`Always exclude '${cat}' from tier-${tier} providers (${provider ?? "this provider"})`}
                      >
                        {providerBusy === cat ? (
                          <Loader size={9} className="animate-spin" />
                        ) : (
                          <ShieldOff size={9} />
                        )}
                        {providerBlocked.has(cat) ? "Provider blocked" : `Block on T${tier}`}
                      </button>
                    )}
                  </div>
                  {paths.map((p) => {
                    const tail = p.slice(cat.length + 1);
                    const isGone = forgotten.has(p);
                    return (
                      <div
                        key={p}
                        className="flex items-center justify-between gap-2 pl-2 text-foreground/45"
                      >
                        <span
                          className={isGone ? "line-through opacity-40" : ""}
                          title={p}
                        >
                          {tail}
                        </span>
                        <button
                          type="button"
                          onClick={() => onForget(cat, p)}
                          disabled={busyPath === p || isGone}
                          className="inline-flex items-center gap-1 px-1.5 py-px rounded hover:text-foreground/70 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Forget this trait (blocks for 365 days; the extractor won't recreate it)"
                        >
                          {busyPath === p ? (
                            <Loader size={9} className="animate-spin" />
                          ) : (
                            <Eraser size={9} />
                          )}
                          {isGone ? "Forgotten" : "Forget"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div className="text-[9.5px] text-muted-foreground/40 leading-relaxed pt-1 border-t border-white/[0.04]">
            Forgetting a trait blocks it for 365 days — the extractor won't recreate it from
            past memory. Provider blocks apply to every model in that privacy tier.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * useTraitSheet — client-side hook for the personalization settings page and
 * the ContextFooter forget-action callbacks. Thin wrapper over
 * `personalization.functions.ts` server fns with local re-fetch on mutate.
 */
import { useCallback, useEffect, useState } from "react";
import {
  getTraitSheet,
  listTraitBlocks,
  listProviderCategoryBlocks,
  type TraitSheetView,
  type TraitBlockRow,
  type ProviderCategoryBlockRow,
} from "./personalization.functions";

export type TraitSheetState = {
  loading: boolean;
  error: string | null;
  sheet: TraitSheetView | null;
  traitBlocks: TraitBlockRow[];
  providerBlocks: ProviderCategoryBlockRow[];
  refresh: () => Promise<void>;
};

export function useTraitSheet(): TraitSheetState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<TraitSheetView | null>(null);
  const [traitBlocks, setTraitBlocks] = useState<TraitBlockRow[]>([]);
  const [providerBlocks, setProviderBlocks] = useState<ProviderCategoryBlockRow[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, tb, pb] = await Promise.all([
        getTraitSheet(),
        listTraitBlocks(),
        listProviderCategoryBlocks(),
      ]);
      setSheet(s);
      setTraitBlocks(tb);
      setProviderBlocks(pb);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load personalization");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { loading, error, sheet, traitBlocks, providerBlocks, refresh };
}

import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Lightbulb } from "lucide-react";
import type { InsightCard } from "@/lib/insight-card";
import { InsightCardView } from "@/components/InsightCardView";
import { listRelayDevices } from "@/lib/relay.functions";

const HIDDEN_KEY = "nc.macCardsHidden.v1";
type State = { cards: InsightCard[]; missingKey: boolean; hasMac: boolean } | null;

export function MacWorthKnowing() {
  const [state, setState] = useState<State>(null);
  const [hidden, setHidden] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const { loadMacCards } = await import("@/lib/mac-cards");
      const [devices, result] = await Promise.all([listRelayDevices().catch(() => []), loadMacCards()]);
      setState({ ...result, hasMac: devices.length > 0 || result.cards.length > 0 || result.missingKey });
    } catch { /* keep the previous state */ }
  }, []);

  useEffect(() => {
    try { setHidden(JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]")); } catch { /* ignore */ }
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(load, 5 * 60 * 1000);
    return () => { window.removeEventListener("focus", onFocus); window.clearInterval(t); };
  }, [load]);

  const notNow = (c: InsightCard) => {
    const next = [...hidden, c.id];
    setHidden(next);
    try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  if (!state) return null;
  const cards = state.cards.filter((c) => !hidden.includes(c.id)).slice(0, 3);

  return (
    <section aria-labelledby="mac-worth-knowing" className="mx-4 mt-4 py-4">
      <h2 id="mac-worth-knowing" className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
        <Lightbulb className="size-4 text-primary" /> Worth knowing
      </h2>
      {!state.hasMac ? (
        <Link to="/workspace/privacy" hash="connect-mac" className="text-sm text-primary underline underline-offset-4">
          Connect your Mac to see what it noticed
        </Link>
      ) : cards.length > 0 ? (
        <ul className="grid gap-3 md:grid-cols-3">
          {cards.map((c) => (
            <InsightCardView key={c.id} card={{ ...c, actions: [] }} onNotNow={notNow}
              footnote="To act on it, open NeuralConnexions on your Mac." />
          ))}
        </ul>
      ) : state.missingKey ? (
        <p className="text-sm text-muted-foreground">
          This device can't read your Mac's cards yet. On your Mac: Settings → Your phone and the web → Open it on your phone.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing from your Mac right now.</p>
      )}
    </section>
  );
}
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InsightCardView, KIND_ICON } from "@/components/InsightCardView";
import { answerCard, type MacCard } from "@/lib/mac-cards";
import { answerableActions } from "@/lib/mac-answer-state";

export const MAC_SCAN_MESSAGE = "To answer from this device, scan your Mac's code again: on your Mac, Settings → Your phone and the web → Open it on your phone.";
export const MAC_SENT_MESSAGE = "Sent to your Mac. It's done there when your Mac next checks, usually within half an hour.";

export function MacCards({ card, onPrivateNotNow, onAnswered, onNotice }: {
  card: MacCard;
  onPrivateNotNow: () => void;
  onAnswered: () => void;
  onNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (card.private) return <InsightCardView card={card} onNotNow={onPrivateNotNow} />;
  const Icon = KIND_ICON[card.kind];
  const actions = answerableActions(card);
  async function send(action: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await answerCard(card.row, action);
      if ("needsScan" in result) {
        if (action === "not_now") { onAnswered(); onNotice(MAC_SCAN_MESSAGE); }
        else setError(MAC_SCAN_MESSAGE);
      } else { onAnswered(); onNotice(MAC_SENT_MESSAGE); }
    } catch (e) { setError(e instanceof Error ? e.message : "Connection temporarily unavailable"); }
    finally { setBusy(false); }
  }
  return (
    <li className="min-w-0 rounded-xl border p-4 flex flex-col gap-3 bg-card border-border">
      <div className="flex items-start gap-3">
        <Icon className="size-5 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{card.text}</p>
          <p className="mt-1 text-xs text-muted-foreground">{card.why}</p>
          {actions.length === 0 && <p className="mt-1 text-[11px] text-muted-foreground">To act on it, open NeuralConnexions on your Mac.</p>}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-3">
        {actions.map((action, index) => <Button key={`${action.ref}:${index}`} size="sm" disabled={busy} onClick={() => action.ref && void send(action.ref)}>{action.label}</Button>)}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send("not_now")} className="text-xs font-medium hover:underline text-muted-foreground">Not now</Button>
      </div>
      {error && <p role="alert" className="text-xs text-muted-foreground">{error}</p>}
    </li>
  );
}
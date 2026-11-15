import { useCallback, useEffect, useRef, useState } from "react";
import { SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MacFoundItem } from "@/lib/mac-cards";
import type { RelayListsRow } from "@/lib/relay-lists-schema";

type Choice = { action: "add" | "skip"; at: number };
type Choices = Record<string, Choice>;
type State = { items: MacFoundItem[]; more: number; row: RelayListsRow } | null;
const scan = "To answer from this device, scan your Mac's code again: on your Mac, Settings → Your phone and the web → Open it on your phone.";
const labels = { weekly: "Every week", event: "One-off", forward: "To do by", closure: "No school" };
export function pruneFound(value: unknown, refs: readonly string[], now = Date.now()): Choices {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Choice] => {
    const [ref, choice] = entry;
    if (!refs.includes(ref) || !choice || typeof choice !== "object" || !("action" in choice) || !("at" in choice)) return false;
    return (choice.action === "add" || choice.action === "skip") && typeof choice.at === "number" && choice.at > now - 4 * 86400000 && choice.at <= now;
  }));
}
function save(choices: Choices) {
  try { localStorage.setItem("nc-found", JSON.stringify(choices)); } catch { /* Keep the choice for this session. */ }
}
export function MacFound() {
  const [state, setState] = useState<State>(null);
  const [choices, setChoices] = useState<Choices>({});
  const pending = useRef(new Set<string>());
  const [busy, setBusy] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [when, setWhen] = useState<(item: MacFoundItem, today: string) => string>(() => () => "");
  const load = useCallback(async () => {
    try {
      const { loadMacLists, foundIn, foundWhen } = await import("@/lib/mac-cards");
      const result = await loadMacLists();
      const found = result && "doc" in result ? foundIn(result.doc) : null;
      if (!found || !result?.doc || !result.row) { setState(null); return; }
      setState({ ...found, row: result.row }); setWhen(() => foundWhen);
      const refs = found.items.flatMap(item => item.ref ? [item.ref] : []);
      let remembered: unknown = {};
      try { remembered = JSON.parse(localStorage.getItem("nc-found") || "{}"); } catch { /* Ignore invalid local entries. */ }
      const next = pruneFound(remembered, refs); setChoices(next); save(next);
    } catch { /* Keep the last browser-opened document. */ }
  }, []);
  useEffect(() => {
    void load(); const focus = () => void load();
    window.addEventListener("focus", focus); const timer = window.setInterval(focus, 5 * 60 * 1000);
    return () => { window.removeEventListener("focus", focus); window.clearInterval(timer); };
  }, [load]);
  async function answer(item: MacFoundItem, action: "add" | "skip") {
    const ref = item.ref;
    if (!state || !ref || item.private || (action === "add" && item.needsDate) || choices[ref] || pending.current.has(ref)) return;
    pending.current.add(ref); setBusy([...pending.current]); setErrors(previous => ({ ...previous, [ref]: "" }));
    try {
      const { answerFound } = await import("@/lib/mac-cards");
      const result = await answerFound(state.row, ref, action);
      if ("needsScan" in result) { setErrors(previous => ({ ...previous, [ref]: scan })); return; }
      setChoices(previous => { const next = { ...previous, [ref]: { action, at: Date.now() } }; save(next); return next; });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection temporarily unavailable";
      if (message.includes("This card has changed") || message.includes("not_found")) {
        setErrors(previous => ({ ...previous, [ref]: "This has changed on your Mac since the page loaded." })); await load();
      } else setErrors(previous => ({ ...previous, [ref]: message }));
    } finally { pending.current.delete(ref); setBusy([...pending.current]); }
  }
  if (!state) return null;
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return <section aria-labelledby="mac-found-heading" className="mx-4 my-4 min-w-0 border border-border bg-card p-4">
    <h2 id="mac-found-heading" className="flex items-center gap-2 font-display text-lg font-semibold"><SearchCheck className="size-4 text-primary" />Check what I found</h2>
    <p className="mt-2 text-xs text-muted-foreground">From what you shared and your email, waiting for you. Nothing goes in your family week until you add it.</p>
    <ul className="mt-3 space-y-2">{state.items.map((item, index) => {
      const remembered = item.ref ? choices[item.ref] : undefined;
      return <li key={item.ref ?? index} className={`min-w-0 rounded-lg border border-border bg-background/60 px-3 py-3 ${remembered ? "opacity-60" : ""}`}>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[11px] text-muted-foreground">{labels[item.type]}</p>
            <p className={`mt-1 break-words text-sm ${item.private ? "text-muted-foreground" : ""}`}>{item.title}{item.child && ` · ${item.child}`}</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">{when(item, today)} · {item.from === "email" ? "From an email" : "From something you shared"}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:max-w-80">
            {item.private ? <p className="text-xs text-muted-foreground">Check it on your Mac</p> : remembered ? <p role="status" className="text-xs text-muted-foreground">{remembered.action === "add" ? "Added. It goes in your family week when your Mac next checks, usually within half an hour." : "Skipped."}</p> : <>
              {item.needsDate ? <p className="text-xs text-muted-foreground">Needs a date: add it on your Mac</p> : item.ref && <Button size="sm" disabled={busy.includes(item.ref)} onClick={() => void answer(item, "add")}>Add</Button>}
              {item.ref && <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={busy.includes(item.ref)} onClick={() => void answer(item, "skip")}>Skip</Button>}
            </>}
          </div>
        </div>
        {item.ref && errors[item.ref] && <p role="alert" className="mt-2 text-xs text-muted-foreground">{errors[item.ref]}</p>}
      </li>;
    })}</ul>
    {state.more > 0 && <p className="mt-3 text-xs text-muted-foreground">And {state.more} more on your Mac.</p>}
    {state.items.length === 0 && state.more === 0 && <p className="mt-3 text-sm text-muted-foreground">Nothing waiting to be checked.</p>}
  </section>;
}
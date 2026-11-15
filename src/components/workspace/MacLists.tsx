import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Check, CalendarClock } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { listRelayDevices } from "@/lib/relay.functions";
import type { MacListsDocument, RelayListsRow } from "@/lib/relay-lists-schema";
import { readTicks, saveTicks } from "@/lib/mac-tick-state";

const scan = "To tick items off from this device, scan your Mac's code again: on your Mac, Settings → Your phone and the web → Open it on your phone.";
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const dateWords = (d: string, options: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00`).toLocaleDateString("en-GB", options);
type State = { doc: MacListsDocument; row: RelayListsRow } | { needsScan: true } | null;

export function MacLists() {
  const [state, setState] = useState<State>(null);
  const [hasMac, setHasMac] = useState(false);
  const [ticks, setTicks] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [words, setWords] = useState<(due: string, today: string) => string>(() => () => "");
  const load = useCallback(async () => {
    try {
      const { loadMacLists, dayWords } = await import("@/lib/mac-cards");
      const [result, devices] = await Promise.all([loadMacLists(), listRelayDevices()]);
      setWords(() => dayWords); setState(result?.doc ? { doc: result.doc, row: result.row } : result ? { needsScan: true } : null); setHasMac(devices.length > 0);
      if (result?.doc) {
        const next = readTicks(result.doc.list.flatMap(item => item.ref ? [item.ref] : []));
        setTicks(next); saveTicks(next);
      }
    } catch { /* Keep the last opened document if the connection fails. */ }
  }, []);
  useEffect(() => {
    void load(); const onFocus = () => void load();
    window.addEventListener("focus", onFocus); const timer = window.setInterval(onFocus, 5 * 60 * 1000);
    return () => { window.removeEventListener("focus", onFocus); window.clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  async function tick(ref: string) {
    if (!state || !("doc" in state) || ticks[ref] || pending.includes(ref)) return;
    setPending(p => [...p, ref]); setError("");
    try {
      const { tickMacItem } = await import("@/lib/mac-cards");
      const result = await tickMacItem(state.row, ref);
      if ("needsScan" in result) { setError(scan); return; }
      setTicks(previous => { const next = { ...previous, [ref]: Date.now() }; saveTicks(next); return next; });
      setNotice("Sent to your Mac. It's done there when your Mac next checks, usually within half an hour.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Connection temporarily unavailable";
      if (message.includes("This card has changed") || message.includes("not_found")) {
        setError("This has changed on your Mac since the page loaded."); await load();
      } else setError(message);
    } finally { setPending(p => p.filter(item => item !== ref)); }
  }
  if (state && "needsScan" in state) return <p className="mx-4 my-4 text-sm text-muted-foreground">Your list from your Mac is here, but this device can't open it yet. Scan your Mac's code again: on your Mac, Settings → Your phone and the web → Open it on your phone.</p>;
  if (!state) return hasMac ? <p className="mx-4 my-4 text-sm text-muted-foreground">To see Your list and Coming up here, turn them on on your Mac: Settings → Your phone and the web.</p> : null;
  const { doc } = state; const today = localDate();
  return <div className="mx-4 my-4 min-w-0">
    <p className="mb-3 text-xs text-muted-foreground">From your Mac, updated {new Date(doc.made).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true })}</p>
    {notice && <p role="status" className="mb-3 text-sm text-muted-foreground">{notice}</p>}
    {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
    <div className="grid min-w-0 gap-6 md:grid-cols-[1.2fr_1fr]">
      <section aria-labelledby="mac-your-list" className="min-w-0 border border-border bg-card p-4">
        <h2 id="mac-your-list" className="flex items-center gap-2 font-display text-lg font-semibold"><Check className="size-4 text-success" />Your list</h2>
        <ul className="mt-3 space-y-2">{doc.list.map((item, i) => {
          const done = Boolean(item.ref && ticks[item.ref]); const due = words(item.due, today);
          return <li key={item.ref ?? i} className="flex items-start gap-3 rounded-lg border border-border bg-background/60 px-3 py-2.5">
            {item.ref && <Checkbox className="mt-0.5 size-5" aria-label={`Tick ${item.private ? "Something private" : item.title}`} checked={done} disabled={pending.includes(item.ref) || done} onCheckedChange={() => { if (item.ref) void tick(item.ref); }} />}
            <div className="min-w-0 flex-1"><p className={`break-words text-sm ${done ? "line-through text-muted-foreground" : item.private ? "text-muted-foreground" : ""}`}>{item.title}</p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground"><span className={item.due && item.due < today ? "text-destructive" : due === "today" || due === "tomorrow" ? "text-warning" : ""}>{due}</span>{!item.private && <span>{item.from === "family" ? "From your family week" : item.from === "reminders" ? "Tick it off in Reminders" : ""}</span>}</p>
            </div>
          </li>;
        })}</ul>
        {!doc.list.length && <p className="mt-3 text-sm text-muted-foreground">Nothing on your list.</p>}
      </section>
      <div className="min-w-0 space-y-6">
        <section aria-labelledby="mac-today" className="min-w-0 border border-border bg-card p-4">
          <h2 id="mac-today" className="flex items-center gap-2 font-display text-lg font-semibold"><CalendarDays className="size-4 text-primary" />{doc.today === today ? "Today" : dateWords(doc.today, { weekday: "long", day: "numeric", month: "long" })}</h2>
          {!doc.calendar ? <p className="mt-3 text-sm text-muted-foreground">Your Mac doesn't read a calendar yet.</p> : !doc.schedule.length ? <p className="mt-3 text-sm text-muted-foreground">Nothing in your calendar.</p> : <ul className="mt-3 space-y-3">{doc.schedule.map((item, i) => <li key={i} className="flex items-start gap-3 text-sm"><span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{item.allDay ? "All day" : `${item.start}${item.end ? `–${item.end}` : ""}`}</span><span className={`min-w-0 break-words ${item.private ? "text-muted-foreground" : ""}`}>{item.title}</span></li>)}</ul>}
        </section>
        <section aria-labelledby="mac-coming" className="min-w-0 border border-border bg-card p-4">
          <h2 id="mac-coming" className="flex items-center gap-2 font-display text-lg font-semibold"><CalendarClock className="size-4 text-primary" />Coming up</h2>
          {!doc.coming.length ? <p className="mt-3 text-sm text-muted-foreground">{doc.calendar ? "Nothing in the next two weeks." : "Your Mac doesn't read a calendar yet."}</p> : [...new Set(doc.coming.map(item => item.date))].map(date => <div key={date} className="mt-3"><h3 className="font-mono text-xs text-muted-foreground">{dateWords(date, { weekday: "short", day: "numeric" })}</h3><ul className="mt-2 space-y-2">{doc.coming.filter(item => item.date === date).map((item, i) => <li key={i}><p className={`break-words text-sm ${item.private ? "text-muted-foreground" : ""}`}>{item.title}</p>{!item.private && item.note && <p className={`mt-1 break-words text-xs ${item.tone === "soon" ? "text-warning" : "text-muted-foreground"}`}>{item.note}</p>}</li>)}</ul></div>)}
        </section>
      </div>
    </div>
  </div>;
}
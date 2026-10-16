import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Moon, CalendarClock, Share2, Bell, Users, Loader, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkspaceLocalNav } from "@/components/workspace/WorkspaceLocalNav";
import { useAuth } from "@/lib/auth-context";
import { getInboxItems } from "@/lib/gmail.functions";
import { useManualTasks } from "@/lib/manual-tasks";
import { briefText, extractObligation, fmt, pseudonymise, useChildren, type Obligation } from "@/lib/obligations";

export const Route = createFileRoute("/workspace/brief")({
  head: () => ({
    meta: [
      { title: "Evening brief — NeuralConnexions" },
      { name: "description", content: "What to get ready tonight and what to plan ahead, pulled from your emails and tasks on your device." },
      { property: "og:title", content: "Evening brief — NeuralConnexions" },
      { property: "og:description", content: "What to get ready tonight and what to plan ahead, pulled from your emails and tasks on your device." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: BriefPage,
});

const REMIND_KEY = "nc.briefReminder.v1";

function BriefPage() {
  const { user } = useAuth();
  const { tasks } = useManualTasks();
  const { children, setChildren } = useChildren();
  const [emails, setEmails] = useState<Array<{ id: string; subject: string; snippet: string; from: string }> | null>(null);
  const [childDraft, setChildDraft] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [remind, setRemind] = useState(false);

  useEffect(() => {
    if (!user) return;
    getInboxItems()
      .then((r) => setEmails(r.items))
      .catch(() => setEmails([]));
  }, [user]);

  useEffect(() => { setChildDraft(children.join(", ")); }, [children]);
  useEffect(() => { setRemind(localStorage.getItem(REMIND_KEY) === "on"); }, []);

  // While the app is open, nudge at 7pm once a day.
  useEffect(() => {
    if (!remind || typeof Notification === "undefined") return;
    const t = setInterval(() => {
      const now = new Date();
      const key = `nc.briefShown.${now.toDateString()}`;
      if (now.getHours() >= 19 && !localStorage.getItem(key) && Notification.permission === "granted") {
        localStorage.setItem(key, "1");
        new Notification("Your evening brief is ready", { body: "Tap to see what to get ready for tomorrow." });
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [remind]);

  const items: Obligation[] = useMemo(() => {
    const out: Obligation[] = [];
    for (const e of emails ?? []) {
      const o = extractObligation({ id: `e-${e.id}`, text: `${e.subject} — ${e.snippet}`, source: "email", sourceLabel: e.from }, children);
      if (o) out.push(o);
    }
    for (const t of tasks.filter((t) => !t.done)) {
      const o = extractObligation({ id: `t-${t.id}`, text: t.text, source: "task", sourceLabel: "Your task" }, children);
      if (o) out.push(o);
    }
    return out
      .filter((o) => !hidden.has(o.id))
      .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  }, [emails, tasks, children, hidden]);

  const tonight = items.filter((o) => o.kind === "tonight");
  const ahead = items.filter((o) => o.kind === "ahead");

  async function toggleRemind() {
    if (!remind && typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const p = await Notification.requestPermission();
      if (p !== "granted") return;
    }
    const next = !remind;
    setRemind(next);
    localStorage.setItem(REMIND_KEY, next ? "on" : "off");
  }

  function share() {
    const url = `https://wa.me/?text=${encodeURIComponent(briefText(items))}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const sample = children.length ? pseudonymise(`${children[0]} needs her PE kit on Thursday`, children) : null;

  return (
    <main className="min-h-screen px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl">
        <WorkspaceLocalNav />
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Evening brief</p>
            <h1 className="font-display text-3xl font-semibold text-foreground">Tomorrow, sorted</h1>
            <p className="mt-1 text-sm text-muted-foreground">Picked out of your emails and tasks on this device. No AI, nothing sent anywhere.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={toggleRemind}>
              <Bell className="size-4" /> {remind ? "7pm reminder on" : "Remind me at 7pm"}
            </Button>
            <Button onClick={share} disabled={!items.length}>
              <Share2 className="size-4" /> Send on WhatsApp
            </Button>
          </div>
        </header>

        {emails === null && user ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader className="size-4 animate-spin" /> Reading your inbox…</p>
        ) : null}

        <Section icon={<Moon className="size-4" />} title="Tonight, get ready" tone="bg-family/10" items={tonight} empty="Nothing to prepare for tomorrow." onHide={(id) => setHidden(new Set(hidden).add(id))} />
        <Section icon={<CalendarClock className="size-4" />} title="Plan ahead" tone="bg-professional/10" items={ahead} empty="Nothing to book, buy or reply to yet." onHide={(id) => setHidden(new Set(hidden).add(id))} />

        <section className="mt-8 rounded-xl border border-border bg-card p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-foreground"><Users className="size-4" /> Your children</h2>
          <p className="mt-1 text-sm text-muted-foreground">Add names so items get tagged to the right child. Names stay on this device.</p>
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); setChildren(childDraft.split(",")); }}>
            <Input value={childDraft} onChange={(e) => setChildDraft(e.target.value)} placeholder="e.g. Maya, Leo" aria-label="Children's names" />
            <Button type="submit" variant="outline">Save</Button>
          </form>
          {sample ? (
            <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              If any text is ever sent to an AI, names are swapped first — for example: “{sample}”.
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function Section({ icon, title, tone, items, empty, onHide }: { icon: React.ReactNode; title: string; tone: string; items: Obligation[]; empty: string; onHide: (id: string) => void }) {
  return (
    <section className="mb-5">
      <h2 className="mb-2 flex items-center gap-2 font-display text-lg font-semibold text-foreground">{icon} {title} <span className="text-sm font-normal text-muted-foreground">{items.length}</span></h2>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((o) => (
            <li key={o.id} className={`flex items-start justify-between gap-3 rounded-xl border border-border p-4 ${tone}`}>
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {o.child ? <span className="mr-2 rounded-full bg-background px-2 py-0.5 text-xs">{o.child}</span> : null}
                  {o.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{o.due ? fmt(o.due) : "No date"} · {o.source === "email" ? `Email from ${o.sourceLabel}` : o.sourceLabel}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onHide(o.id)}>Done</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Message reader (week 2 of the phone-first MVP).
 *
 * Route: `/workspace/reader`
 *
 * Reads a message on this device (pasted, photographed, or shared to the app from another app on the iPhone) and
 * shows what it asks of a parent: dates, deadlines, days off, what to bring. Everything runs on the device
 * (src/lib/reader): nothing is sent to a server or any AI, and nothing is logged. "Check the message reader" reads
 * made-up messages with known answers and gives a score that's safe to share (numbers and made-up names only).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Found, ModelCall } from "@/lib/reader/family-engine";
import {
  appleModel,
  forgetShared,
  nativePlugins,
  readLetter,
  readShared,
  readText,
  todayHere,
  type NativePlugins,
  type ReadOne,
  type ReadShared,
} from "@/lib/reader/phone-reader";
import {
  checkSummary,
  runReaderCheck,
  type CheckResult,
  type Totals,
} from "@/lib/reader/reader-check";
import { CHECK_MESSAGES } from "@/lib/reader/reader-check-messages";

export const Route = createFileRoute("/workspace/reader")({
  component: ReaderPage,
  head: () => ({
    meta: [
      { title: "Message reader — NeuralConnexions" },
      {
        name: "description",
        content: "Reads a message on this device and finds its dates, deadlines and days off.",
      },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const FOUND_BY: Record<Found["foundBy"], string> = {
  model: "Found by Apple's model",
  rules: "Found by the reader's rules",
  "date check": "A date the message mentions",
};

function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function listDays(days: number[]): string {
  const names = days.map((d) => DAYS[d]).filter(Boolean);
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : names[0] || "";
}

/** When it is, in words: "On Thursday 3 December", "Every Monday and Friday", "By Friday 27 November". */
function whenText(f: Found): string {
  if (f.type === "weekly") return `Every ${listDays(f.weekdays)}`;
  if (!f.date) return "No date yet";
  if (f.endDate && f.endDate !== f.date)
    return `From ${longDate(f.date)} to ${longDate(f.endDate)}`;
  return `${f.type === "forward" ? "By" : "On"} ${longDate(f.date)}`;
}

function FoundList({ items }: { items: Found[] }) {
  if (!items.length)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing with a date or a deadline in this one.
      </p>
    );
  return (
    <ul className="space-y-3">
      {items.map((f) => (
        <li key={f.id} className="rounded-xl border border-border bg-background/40 p-3">
          <div className="font-medium">{f.title}</div>
          <div className="text-sm">
            {whenText(f)}
            {f.time ? `, ${f.time}` : ""}
          </div>
          {f.child && <div className="text-sm text-muted-foreground">For {f.child}</div>}
          {f.bring && <div className="text-sm text-muted-foreground">Bring {f.bring}</div>}
          <blockquote className="mt-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
            {f.quote}
          </blockquote>
          <div className="mt-1 text-[11px] text-muted-foreground">{FOUND_BY[f.foundBy]}</div>
        </li>
      ))}
    </ul>
  );
}

function ReadResult({ result }: { result: ReadOne }) {
  if (result.error) return <p className="text-sm text-amber-300">{result.error}</p>;
  return <FoundList items={result.items} />;
}

function capturedWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return todayHere(d) === todayHere()
    ? `today at ${time}`
    : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "long" })} at ${time}`;
}

function ScoreLine({ label, t }: { label: string; t: Totals }) {
  return (
    <div className="text-sm">
      <div className="font-medium">{label}</div>
      <div className="tabular-nums text-muted-foreground">
        {t.found} of {t.want} found, {t.named} well named, {t.unwanted} unwanted
      </div>
    </div>
  );
}

async function isNativeApp(): Promise<boolean> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

function ReaderPage() {
  const [plugins, setPlugins] = useState<NativePlugins>({});
  const [onPhone, setOnPhone] = useState(false);
  const [model, setModel] = useState<{ call: ModelCall | null; reason: string } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"" | "text" | "photo">("");
  const [result, setResult] = useState<ReadOne | null>(null);
  const [shared, setShared] = useState<ReadShared[]>([]);
  const [check, setCheck] = useState<{
    running: boolean;
    done: number;
    result: CheckResult | null;
  }>({ running: false, done: 0, result: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const native = await isNativeApp();
      const p = await nativePlugins();
      const m = await appleModel(p);
      if (!alive) return;
      setOnPhone(native);
      setPlugins(p);
      setModel({ call: m.model, reason: m.reason });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const ask = useCallback(() => ({ today: todayHere(), model: model?.call ?? null }), [model]);

  const loadShared = useCallback(async () => {
    if (!plugins.SharedInbox || !model) return;
    setShared(await readShared(plugins, ask()));
  }, [plugins, model, ask]);

  useEffect(() => {
    void loadShared();
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadShared();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadShared]);

  async function readPasted() {
    setBusy("text");
    try {
      setResult(await readText(text, ask()));
    } finally {
      setBusy("");
    }
  }

  async function readPhoto() {
    setBusy("photo");
    try {
      const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
      const photo = await Camera.getPhoto({
        resultType: CameraResultType.Uri,
        source: CameraSource.Prompt,
        quality: 90,
        correctOrientation: true,
      });
      setResult(
        photo.path
          ? await readLetter(plugins, photo.path, ask())
          : { text: "", items: [], usedModel: false, error: "Couldn't open that photo." },
      );
    } catch {
      // Closing the camera or the photo picker isn't an error.
    } finally {
      setBusy("");
    }
  }

  async function doneWith(ids: string[]) {
    await forgetShared(plugins, ids);
    setShared((s) => s.filter((x) => !ids.includes(x.id)));
  }

  async function runCheck() {
    setCopied(false);
    setCheck({ running: true, done: 0, result: null });
    const r = await runReaderCheck(model?.call ?? null, {
      modelReason: onPhone ? model?.reason : "Apple's model works only in the iPhone app.",
      onProgress: (done) => setCheck((c) => ({ ...c, done })),
    });
    setCheck({ running: false, done: CHECK_MESSAGES.length, result: r });
  }

  const summary = check.result ? checkSummary(check.result) : "";

  async function copySummary() {
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const modelLine = !model
    ? "Checking…"
    : model.call
      ? "Apple's model is ready on this iPhone."
      : !onPhone
        ? "Apple's model works only in the iPhone app. Here, the reader uses its rules."
        : `${model.reason} Until then, the reader uses its rules.`;

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl">Message reader</h1>
            <p className="text-sm text-muted-foreground">
              Reads a message on this phone and finds the dates, deadlines and days off in it.
              Nothing is sent anywhere.
            </p>
          </div>
          <Link to="/workspace" className="shrink-0 text-sm text-primary hover:underline">
            ← Back
          </Link>
        </header>

        <section
          className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur"
          aria-live="polite"
        >
          <h2 className="mb-1 font-display text-lg">Apple's model</h2>
          <p className="text-sm text-muted-foreground">{modelLine}</p>
        </section>

        <section className="space-y-3 rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
          <h2 className="font-display text-lg">Read a message</h2>
          <label htmlFor="reader-text" className="block text-sm text-muted-foreground">
            Paste a message
          </label>
          <Textarea
            id="reader-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder="A school email, a WhatsApp message or a club text"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void readPasted()} disabled={!text.trim() || busy !== ""}>
              {busy === "text" ? "Reading…" : "Read it"}
            </Button>
            {onPhone && (
              <Button variant="outline" onClick={() => void readPhoto()} disabled={busy !== ""}>
                {busy === "photo" ? "Reading the letter…" : "Photograph a letter"}
              </Button>
            )}
          </div>
          {result && (
            <div className="space-y-2 pt-2" aria-live="polite">
              <h3 className="text-sm font-medium">What it found</h3>
              <ReadResult result={result} />
            </div>
          )}
        </section>

        {onPhone && (
          <section className="space-y-3 rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
            <h2 className="font-display text-lg">Shared with the app</h2>
            {!plugins.SharedInbox ? (
              <p className="text-sm text-muted-foreground">
                This version of the app can't take shared messages yet.
              </p>
            ) : shared.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing shared yet. In WhatsApp, Mail or Photos, tap Share, then NeuralConnexions.
              </p>
            ) : (
              shared.map((s) => (
                <div key={s.id} className="space-y-2 rounded-xl border border-border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm">
                      {s.kind === "image" ? "A photo" : "A message"}, shared{" "}
                      {capturedWhen(s.capturedAt)}
                    </span>
                    <Button size="sm" variant="outline" onClick={() => void doneWith([s.id])}>
                      Done with it
                    </Button>
                  </div>
                  <ReadResult result={s} />
                </div>
              ))
            )}
          </section>
        )}

        <section className="space-y-3 rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
          <h2 className="font-display text-lg">Check the reader</h2>
          <p className="text-sm text-muted-foreground">
            Reads {CHECK_MESSAGES.length} made-up messages with known answers, with the rules alone
            and with Apple's model, and scores both. It takes a minute or two.
          </p>
          <Button onClick={() => void runCheck()} disabled={check.running || !model}>
            {check.running ? `Reading ${check.done} of ${CHECK_MESSAGES.length}…` : "Run the check"}
          </Button>
          {check.result && (
            <div className="space-y-3 pt-2" aria-live="polite">
              <ScoreLine label="Rules alone" t={check.result.rules} />
              {check.result.model && (
                <ScoreLine label="With Apple's model" t={check.result.model} />
              )}
              {check.result.modelOwn && (
                <ScoreLine label="Apple's model's own items" t={check.result.modelOwn} />
              )}
              {check.result.secondsPerMessage !== null && (
                <p className="text-sm text-muted-foreground">
                  {check.result.secondsPerMessage} seconds a message with Apple's model.
                </p>
              )}
              {!check.result.model && (
                <p className="text-sm text-muted-foreground">
                  Apple's model wasn't used: {check.result.modelReason}
                </p>
              )}
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-background/40 p-3 text-xs">
                {summary}
              </pre>
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={() => void copySummary()}>
                  Copy the result
                </Button>
                {copied && <span className="text-sm text-muted-foreground">Copied</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                The result has only numbers and the made-up messages' names, so it's safe to send.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

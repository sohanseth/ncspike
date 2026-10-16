import { useCallback, useEffect, useState } from "react";
import { Laptop, Loader } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createRelayPairingCode, listRelayDevices, revokeRelayDevice } from "@/lib/relay.functions";

type Device = { id: string; name: string | null; created_at: string; last_seen_at: string | null };

export function ConnectMacSection() {
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [link, setLink] = useState("");
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setDevices((await listRelayDevices()) as Device[]); } catch { setError("Couldn't load your connected Macs."); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [code]);

  const left = code ? Math.max(0, Math.floor((Date.parse(code.expiresAt) - now) / 1000)) : 0;

  async function showCode() {
    setBusy(true); setError(null);
    try { setCode(await createRelayPairingCode()); setNow(Date.now()); } catch { setError("Couldn't make a code. Try again."); }
    finally { setBusy(false); }
  }
  async function disconnect(id: string) {
    try { await revokeRelayDevice({ data: id }); await refresh(); } catch { setError("Couldn't disconnect that Mac."); }
  }
  async function save() {
    const { saveKeyFromLink } = await import("@/lib/mac-cards");
    const ok = await saveKeyFromLink(link);
    setLink("");
    setLinkMsg(ok ? "This device can now read the cards from your Mac." : "That link isn't complete.");
  }

  return (
    <section id="connect-mac" className="mb-8 scroll-mt-6 rounded-xl border bg-card/40 p-6">
      <div className="mb-2 flex items-center gap-2">
        <Laptop className="h-5 w-5 text-primary" />
        <h2 className="text-xl font-semibold">Connect your Mac</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Your Mac works things out and sends its cards here locked with a key only your devices have. This app stores them scrambled; they're unlocked only in your browser.
      </p>
      {code && left > 0 ? (
        <div className="mb-4 rounded-lg border bg-background p-4">
          <p className="font-mono text-4xl font-semibold tracking-widest">{code.code}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            On your Mac, open NeuralConnexions → Settings → Your phone and the web, and type this code. It works for 10 minutes.
          </p>
          <p className="mt-1 font-mono text-xs text-muted-foreground" aria-live="polite">
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
          </p>
        </div>
      ) : (
        <Button onClick={showCode} disabled={busy} className="mb-4">
          {busy && <Loader className="h-4 w-4 animate-spin" />} Show a code
        </Button>
      )}
      {devices.length > 0 && (
        <ul className="mb-4 divide-y rounded-lg border">
          {devices.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{d.name || "Mac"}</p>
                <p className="text-xs text-muted-foreground">
                  {d.last_seen_at ? `Last sent cards ${new Date(d.last_seen_at).toLocaleString()}` : "Hasn't sent cards yet"}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => disconnect(d.id)}>Disconnect</Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mb-2 text-sm text-muted-foreground">
        Using this app from your home screen? It keeps its own storage, so paste the link from your Mac here.
      </p>
      <div className="flex gap-2">
        <Input value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link from your Mac" autoComplete="off" />
        <Button onClick={save} disabled={!link}>Save</Button>
      </div>
      {linkMsg && <p className="mt-2 text-sm" aria-live="polite">{linkMsg}</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  );
}
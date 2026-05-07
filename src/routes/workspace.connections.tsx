import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Mail, Calendar, Loader2, CheckCircle2, AlertCircle, Plug, Inbox, Mic, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { startGoogleOAuth } from "@/lib/google-oauth.functions";
import {
  getConnections,
  disconnectProvider,
  pullRecentEmails,
} from "@/lib/gmail.functions";
import {
  getVoiceProfile,
  buildVoiceProfile,
  type VoiceProfileSummary,
} from "@/lib/voice-drafts.functions";
import { testProposeSlots } from "@/lib/calendar.functions";

type ConnectStatus = "ok" | "error" | undefined;

export const Route = createFileRoute("/workspace/connections")({
  validateSearch: (s: Record<string, unknown>) => ({
    connect: s.connect as ConnectStatus,
    msg: s.msg as string | undefined,
  }),
  head: () => ({
    meta: [{ title: "Connections — NeuralConnexions" }],
  }),
  component: ConnectionsPage,
});

type Conn = {
  provider: "gmail" | "google_calendar";
  account_label: string | null;
  expires_at: string | null;
  scopes: string[] | null;
  created_at: string;
};

const PROVIDER_META = {
  gmail: { label: "Gmail", Icon: Mail, blurb: "Read your inbox to surface what matters." },
  google_calendar: { label: "Google Calendar", Icon: Calendar, blurb: "Understand your week and free time." },
} as const;

function ConnectionsPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const search = useSearch({ from: "/workspace/connections" });

  const [conns, setConns] = useState<Conn[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pullResult, setPullResult] = useState<{
    count: number;
    account: string | null;
    summaries: Array<{ id: string; subject: string; from: string; snippet: string; date: string }>;
  } | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceProfileSummary | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [calSlots, setCalSlots] = useState<Array<{ human: string; startIso: string }> | null>(null);
  const [calError, setCalError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  const refresh = async () => {
    const res = await getConnections();
    setConns(res.connections as Conn[]);
  };

  const refreshVoice = async () => {
    try {
      const v = await getVoiceProfile();
      setVoice(v);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (user) {
      void refresh();
      void refreshVoice();
    }
  }, [user]);

  const onConnect = async (provider: "gmail" | "google_calendar") => {
    setBusy(provider);
    try {
      const { url } = await startGoogleOAuth({ data: { provider } });
      window.location.href = url;
    } catch (e) {
      console.error(e);
      setBusy(null);
    }
  };

  const onDisconnect = async (provider: "gmail" | "google_calendar") => {
    setBusy(provider);
    try {
      await disconnectProvider({ data: { provider } });
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const onBuildVoice = async () => {
    setBusy("voice");
    setVoiceError(null);
    try {
      const v = await buildVoiceProfile();
      setVoice(v);
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const onTestCalendar = async () => {
    setBusy("calendar-test");
    setCalError(null);
    setCalSlots(null);
    try {
      const { slots } = await testProposeSlots();
      setCalSlots(slots);
    } catch (e) {
      setCalError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const onPull = async () => {
    setBusy("pull");
    setPullError(null);
    setPullResult(null);
    try {
      const res = await pullRecentEmails();
      setPullResult(res);
    } catch (e) {
      setPullError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  const byProvider = (p: string) => conns?.find((c) => c.provider === p);

  return (
    <div className="min-h-screen bg-background text-foreground px-6 py-10">
      <div className="max-w-3xl mx-auto space-y-8">
        <header>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Workspace · Connections
          </p>
          <h1 className="font-display text-3xl font-semibold mt-1">Connect your sources</h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-xl">
            NC reads your email and calendar (read-only) to learn context. Tokens are encrypted and
            scoped to your account. Disconnect any time.
          </p>
        </header>

        {search.connect === "ok" && (
          <div className="glass rounded-xl px-4 py-3 flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-emerald-400" />
            Connection successful.
          </div>
        )}
        {search.connect === "error" && (
          <div className="glass rounded-xl px-4 py-3 flex items-center gap-2 text-sm">
            <AlertCircle className="size-4 text-rose-400" />
            Connection failed{search.msg ? `: ${search.msg}` : ""}.
          </div>
        )}

        <section className="space-y-3">
          {(["gmail", "google_calendar"] as const).map((p) => {
            const meta = PROVIDER_META[p];
            const conn = byProvider(p);
            const Icon = meta.Icon;
            return (
              <article key={p} className="glass rounded-2xl p-5 flex items-start gap-4">
                <div className="size-11 rounded-xl bg-primary/15 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
                  <Icon className="size-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="font-display font-semibold">{meta.label}</h2>
                    {conn && (
                      <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-400">
                        Connected
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">{meta.blurb}</p>
                  {conn?.account_label && (
                    <p className="text-xs text-muted-foreground mt-2 font-mono">{conn.account_label}</p>
                  )}
                </div>
                <div className="shrink-0">
                  {conn ? (
                    <button
                      onClick={() => onDisconnect(p)}
                      disabled={busy === p}
                      className="px-3 py-1.5 rounded-md text-xs font-medium ring-1 ring-border hover:bg-secondary disabled:opacity-50"
                    >
                      {busy === p ? <Loader2 className="size-3.5 animate-spin" /> : "Disconnect"}
                    </button>
                  ) : (
                    <button
                      onClick={() => onConnect(p)}
                      disabled={busy === p}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {busy === p ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Plug className="size-3.5" />
                      )}
                      Connect
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        {byProvider("gmail") && (
          <section className="glass-elevated rounded-2xl p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="font-display font-semibold">Test: pull last 10 emails</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Fetches metadata from your inbox and stores summary nodes in Memory.
                </p>
              </div>
              <button
                onClick={onPull}
                disabled={busy === "pull"}
                className="px-3 py-2 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {busy === "pull" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Inbox className="size-3.5" />
                )}
                Pull emails
              </button>
            </div>

            {pullError && (
              <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 ring-1 ring-rose-500/20 rounded px-3 py-2">
                {pullError}
              </p>
            )}

            {pullResult && (
              <div className="mt-4 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Pulled <span className="text-foreground font-medium">{pullResult.count}</span> emails
                  {pullResult.account ? ` from ${pullResult.account}` : ""}.
                </p>
                <ul className="space-y-2">
                  {pullResult.summaries.map((s) => (
                    <li key={s.id} className="rounded-lg ring-1 ring-border p-3 bg-surface/40">
                      <p className="text-sm font-medium truncate">{s.subject || "(no subject)"}</p>
                      <p className="text-xs text-muted-foreground truncate">{s.from}</p>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{s.snippet}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {byProvider("google_calendar") && (
          <section className="glass-elevated rounded-2xl p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="size-10 rounded-xl bg-primary/15 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
                  <Calendar className="size-4 text-primary" />
                </div>
                <div>
                  <h3 className="font-display font-semibold">Test calendar</h3>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md">
                    Calls Google Free/Busy and proposes the next 3 open slots in your working hours.
                  </p>
                </div>
              </div>
              <button
                onClick={onTestCalendar}
                disabled={busy === "calendar-test"}
                className="px-3 py-2 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5 shrink-0"
              >
                {busy === "calendar-test" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Find free slots
              </button>
            </div>

            {calError && (
              <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 ring-1 ring-rose-500/20 rounded px-3 py-2">
                {calError}
              </p>
            )}

            {calSlots && (
              <div className="mt-4 space-y-2">
                {calSlots.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No free slots returned. Calendar may be fully booked or the lookahead window had nothing.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {calSlots.map((s) => (
                      <li
                        key={s.startIso}
                        className="rounded-lg ring-1 ring-border p-3 bg-surface/40 text-sm"
                      >
                        {s.human}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        )}

        {byProvider("gmail") && (
          <section className="glass-elevated rounded-2xl p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="size-10 rounded-xl bg-primary/15 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
                  <Mic className="size-4 text-primary" />
                </div>
                <div>
                  <h3 className="font-display font-semibold">Voice profile</h3>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md">
                    NC reads up to {200} of your sent emails to learn how you
                    write. Only the derived profile is stored — never the raw messages.
                  </p>
                </div>
              </div>
              <button
                onClick={onBuildVoice}
                disabled={busy === "voice"}
                className="px-3 py-2 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5 shrink-0"
              >
                {busy === "voice" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {voice?.hasProfile ? "Rebuild" : "Build profile"}
              </button>
            </div>

            {voiceError && (
              <p className="mt-3 text-xs text-rose-400 bg-rose-500/10 ring-1 ring-rose-500/20 rounded px-3 py-2">
                {voiceError}
              </p>
            )}

            {voice?.hasProfile && voice.profile && (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Samples:{" "}
                    <span className="text-foreground font-medium">{voice.sampleCount}</span>
                  </span>
                  <span>
                    Built:{" "}
                    <span className="text-foreground font-medium">
                      {voice.builtAt ? new Date(voice.builtAt).toLocaleString() : "—"}
                    </span>
                  </span>
                  <span>
                    Avg sentence:{" "}
                    <span className="text-foreground font-medium">
                      {voice.profile.avg_sentence_length} words
                    </span>
                  </span>
                  <span>
                    Formality:{" "}
                    <span className="text-foreground font-medium">
                      {Math.round(voice.profile.formality_score * 100)}%
                    </span>
                  </span>
                </div>

                {voice.profile.sign_off && (
                  <div className="rounded-lg ring-1 ring-border p-3 bg-surface/40">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                      Sign-off
                    </p>
                    <pre className="mt-1 text-sm whitespace-pre-wrap font-sans">
                      {voice.profile.sign_off}
                    </pre>
                  </div>
                )}

                {voice.profile.opener_phrases.length > 0 && (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                      Common openers
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {voice.profile.opener_phrases.map((p) => (
                        <span
                          key={p}
                          className="text-xs px-2 py-1 rounded bg-secondary/60 ring-1 ring-border"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {voice.profile.characteristic_phrases.length > 0 && (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-1.5">
                      Characteristic phrases
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {voice.profile.characteristic_phrases.map((p) => (
                        <span
                          key={p}
                          className="text-xs px-2 py-1 rounded bg-secondary/60 ring-1 ring-border"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {voice && !voice.hasProfile && !voiceError && (
              <p className="mt-3 text-xs text-muted-foreground">
                No profile yet. Build one to enable voice-matched drafts.
              </p>
            )}
          </section>
        )}

        <button
          onClick={() => navigate({ to: "/workspace" })}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to workspace
        </button>
      </div>
    </div>
  );
}

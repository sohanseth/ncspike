import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Mail, Calendar, Loader2, CheckCircle2, AlertCircle, Plug, Inbox, Mic, RefreshCw,
  MessageSquare, Send, Phone, Video, Users, Hash, MessageCircle, AtSign, Sparkles, Check,
  Briefcase, FileText, Github, Trello, Cloud, CreditCard, ShoppingCart, Database,
  Headphones, Music, Bell, BookOpen, ClipboardList, Megaphone, FileSpreadsheet,
  Figma, Youtube, Instagram, Facebook, Twitter, Globe, Zap, GitBranch, Box,
} from "lucide-react";
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
  validateSearch: (s: Record<string, unknown>) => {
    // Both fields are genuinely optional — emitting them as keyed-undefined
    // forces every <Link to="/workspace/connections"> to pass `search={...}`.
    // Omit the keys entirely when absent so callers can link with no search.
    const out: { connect?: ConnectStatus; msg?: string } = {};
    if (s.connect) out.connect = s.connect as ConnectStatus;
    if (typeof s.msg === "string") out.msg = s.msg;
    return out;
  },
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
      try {
        (window.top ?? window).location.href = url;
      } catch {
        window.open(url, "_blank", "noopener,noreferrer");
      }
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

        <MoreIntegrations />

        <RequestConnection />

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

const POPULAR_TOOLS: Array<{ id: string; label: string; blurb: string; category: string; Icon: typeof MessageSquare }> = [
  // Communication & messaging
  { id: "slack", label: "Slack", category: "Communication", Icon: Hash, blurb: "Channels, DMs, and threads." },
  { id: "ms_teams", label: "Microsoft Teams", category: "Communication", Icon: Users, blurb: "Chats, meetings, channels." },
  { id: "outlook", label: "Outlook", category: "Communication", Icon: Mail, blurb: "Email + calendar from Microsoft 365." },
  { id: "whatsapp", label: "WhatsApp", category: "Communication", Icon: MessageCircle, blurb: "Via Twilio Business API." },
  { id: "telegram", label: "Telegram", category: "Communication", Icon: Send, blurb: "Bot API for chats & channels." },
  { id: "discord", label: "Discord", category: "Communication", Icon: MessageSquare, blurb: "Servers, channels, DMs." },
  { id: "zoom", label: "Zoom", category: "Communication", Icon: Video, blurb: "Meetings, recordings, transcripts." },
  { id: "twilio_sms", label: "SMS (Twilio)", category: "Communication", Icon: Phone, blurb: "Send & receive text messages." },
  { id: "signal", label: "Signal", category: "Communication", Icon: MessageCircle, blurb: "End-to-end encrypted messaging." },
  { id: "messenger", label: "Messenger", category: "Communication", Icon: MessageCircle, blurb: "Meta Business Messaging." },
  { id: "linkedin", label: "LinkedIn", category: "Communication", Icon: AtSign, blurb: "Messages & InMail." },
  { id: "x_dm", label: "X (Twitter) DMs", category: "Communication", Icon: AtSign, blurb: "Direct messages on X." },

  // Productivity & docs
  { id: "notion", label: "Notion", category: "Productivity", Icon: BookOpen, blurb: "Pages, databases, blocks." },
  { id: "google_drive", label: "Google Drive", category: "Productivity", Icon: Cloud, blurb: "Files, folders, sharing." },
  { id: "google_docs", label: "Google Docs", category: "Productivity", Icon: FileText, blurb: "Create & edit docs." },
  { id: "google_sheets", label: "Google Sheets", category: "Productivity", Icon: FileSpreadsheet, blurb: "Read & write spreadsheets." },
  { id: "ms_onedrive", label: "OneDrive", category: "Productivity", Icon: Cloud, blurb: "Microsoft cloud files." },
  { id: "ms_excel", label: "Excel", category: "Productivity", Icon: FileSpreadsheet, blurb: "Workbooks & sheets." },
  { id: "ms_word", label: "Word", category: "Productivity", Icon: FileText, blurb: "Documents on Microsoft 365." },
  { id: "dropbox", label: "Dropbox", category: "Productivity", Icon: Box, blurb: "File storage & sharing." },
  { id: "evernote", label: "Evernote", category: "Productivity", Icon: BookOpen, blurb: "Notes & web clips." },
  { id: "airtable", label: "Airtable", category: "Productivity", Icon: Database, blurb: "Spreadsheet-database hybrid." },

  // Calendar & scheduling
  { id: "calendly", label: "Calendly", category: "Calendar", Icon: Calendar, blurb: "Scheduling links & invitees." },
  { id: "cal_com", label: "Cal.com", category: "Calendar", Icon: Calendar, blurb: "Open-source scheduling." },
  { id: "ms_calendar", label: "Outlook Calendar", category: "Calendar", Icon: Calendar, blurb: "Microsoft 365 calendar." },

  // Project mgmt & dev
  { id: "linear", label: "Linear", category: "Project mgmt", Icon: ClipboardList, blurb: "Issues, projects, cycles." },
  { id: "jira", label: "Jira", category: "Project mgmt", Icon: ClipboardList, blurb: "Atlassian issue tracking." },
  { id: "asana", label: "Asana", category: "Project mgmt", Icon: ClipboardList, blurb: "Tasks, projects, portfolios." },
  { id: "trello", label: "Trello", category: "Project mgmt", Icon: Trello, blurb: "Boards, lists, cards." },
  { id: "clickup", label: "ClickUp", category: "Project mgmt", Icon: ClipboardList, blurb: "Docs, tasks, goals." },
  { id: "monday", label: "Monday.com", category: "Project mgmt", Icon: ClipboardList, blurb: "Work OS for teams." },
  { id: "github", label: "GitHub", category: "Developer", Icon: Github, blurb: "Repos, issues, PRs." },
  { id: "gitlab", label: "GitLab", category: "Developer", Icon: GitBranch, blurb: "Repos, MRs, CI/CD." },
  { id: "bitbucket", label: "Bitbucket", category: "Developer", Icon: GitBranch, blurb: "Atlassian git hosting." },
  { id: "vercel", label: "Vercel", category: "Developer", Icon: Zap, blurb: "Deployments & projects." },

  // CRM & sales
  { id: "salesforce", label: "Salesforce", category: "CRM", Icon: Briefcase, blurb: "Leads, contacts, opps." },
  { id: "hubspot", label: "HubSpot", category: "CRM", Icon: Briefcase, blurb: "Marketing, sales, service." },
  { id: "pipedrive", label: "Pipedrive", category: "CRM", Icon: Briefcase, blurb: "Sales pipeline mgmt." },
  { id: "attio", label: "Attio", category: "CRM", Icon: Briefcase, blurb: "Modern relational CRM." },
  { id: "zoho_crm", label: "Zoho CRM", category: "CRM", Icon: Briefcase, blurb: "Customer relationship suite." },

  // Marketing & email
  { id: "mailchimp", label: "Mailchimp", category: "Marketing", Icon: Megaphone, blurb: "Email campaigns & lists." },
  { id: "sendgrid", label: "SendGrid", category: "Marketing", Icon: Mail, blurb: "Transactional email API." },
  { id: "resend", label: "Resend", category: "Marketing", Icon: Mail, blurb: "Email for developers." },
  { id: "klaviyo", label: "Klaviyo", category: "Marketing", Icon: Megaphone, blurb: "Ecommerce email & SMS." },
  { id: "brevo", label: "Brevo", category: "Marketing", Icon: Mail, blurb: "Email, SMS, CRM." },

  // Support
  { id: "zendesk", label: "Zendesk", category: "Support", Icon: Headphones, blurb: "Tickets & help center." },
  { id: "intercom", label: "Intercom", category: "Support", Icon: MessageSquare, blurb: "Customer messaging." },
  { id: "freshdesk", label: "Freshdesk", category: "Support", Icon: Headphones, blurb: "Helpdesk & ticketing." },

  // Payments & commerce
  { id: "stripe", label: "Stripe", category: "Payments", Icon: CreditCard, blurb: "Payments, billing, invoices." },
  { id: "paypal", label: "PayPal", category: "Payments", Icon: CreditCard, blurb: "Payments & payouts." },
  { id: "square", label: "Square", category: "Payments", Icon: CreditCard, blurb: "POS & online payments." },
  { id: "shopify", label: "Shopify", category: "Commerce", Icon: ShoppingCart, blurb: "Stores, orders, products." },
  { id: "woocommerce", label: "WooCommerce", category: "Commerce", Icon: ShoppingCart, blurb: "WordPress commerce." },
  { id: "quickbooks", label: "QuickBooks", category: "Finance", Icon: FileSpreadsheet, blurb: "Accounting & invoicing." },
  { id: "xero", label: "Xero", category: "Finance", Icon: FileSpreadsheet, blurb: "Cloud accounting." },

  // Storage & data
  { id: "aws_s3", label: "AWS S3", category: "Storage", Icon: Cloud, blurb: "Object storage buckets." },
  { id: "snowflake", label: "Snowflake", category: "Data", Icon: Database, blurb: "Cloud data warehouse." },
  { id: "bigquery", label: "BigQuery", category: "Data", Icon: Database, blurb: "Google data warehouse." },

  // Meetings & content
  { id: "google_meet", label: "Google Meet", category: "Meetings", Icon: Video, blurb: "Video meetings." },
  { id: "fireflies", label: "Fireflies", category: "Meetings", Icon: Mic, blurb: "Meeting transcripts & notes." },
  { id: "granola", label: "Granola", category: "Meetings", Icon: Mic, blurb: "AI meeting notes." },
  { id: "otter", label: "Otter.ai", category: "Meetings", Icon: Mic, blurb: "Live transcription." },
  { id: "loom", label: "Loom", category: "Meetings", Icon: Video, blurb: "Async video messages." },

  // Design
  { id: "figma", label: "Figma", category: "Design", Icon: Figma, blurb: "Files, comments, variables." },

  // Social & content
  { id: "youtube", label: "YouTube", category: "Social", Icon: Youtube, blurb: "Videos, channels, analytics." },
  { id: "instagram", label: "Instagram", category: "Social", Icon: Instagram, blurb: "Graph API for posts & DMs." },
  { id: "facebook", label: "Facebook Pages", category: "Social", Icon: Facebook, blurb: "Pages & messaging." },
  { id: "x_api", label: "X API", category: "Social", Icon: Twitter, blurb: "Tweets, timelines, mentions." },
  { id: "tiktok", label: "TikTok", category: "Social", Icon: Music, blurb: "Business & content API." },
  { id: "reddit", label: "Reddit", category: "Social", Icon: Globe, blurb: "Posts, comments, DMs." },

  // Automation
  { id: "zapier", label: "Zapier", category: "Automation", Icon: Zap, blurb: "Connect 6000+ apps." },
  { id: "make", label: "Make", category: "Automation", Icon: Zap, blurb: "Visual automation flows." },
  { id: "n8n", label: "n8n", category: "Automation", Icon: Zap, blurb: "Open-source workflows." },
  { id: "ifttt", label: "IFTTT", category: "Automation", Icon: Bell, blurb: "Applets across services." },
];

const REQUEST_KEY = "nc:connection-requests";

function loadRequests(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(REQUEST_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRequests(list: string[]) {
  if (typeof window !== "undefined") localStorage.setItem(REQUEST_KEY, JSON.stringify(list));
}

function MoreIntegrations() {
  const [requested, setRequested] = useState<Set<string>>(() => new Set(loadRequests()));

  const onRequest = (id: string, label: string) => {
    const next = new Set(requested);
    next.add(id);
    setRequested(next);
    const list = loadRequests();
    if (!list.includes(label)) {
      list.push(label);
      saveRequests(list);
    }
  };

  // Group by category, preserving insertion order
  const grouped = POPULAR_TOOLS.reduce<Record<string, typeof POPULAR_TOOLS>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="font-display text-xl font-semibold">More integrations</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Popular tools with public APIs. Request the ones you'd like next — we prioritize by demand.
          </p>
        </div>
        <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
          Coming soon
        </span>
      </div>
      <div className="space-y-6">
        {Object.entries(grouped).map(([category, tools]) => (
          <div key={category}>
            <h3 className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground mb-2">
              {category}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {tools.map(({ id, label, blurb, Icon }) => {
                const isRequested = requested.has(id);
                return (
                  <article key={id} className="glass rounded-2xl p-4 flex items-start gap-3">
                    <div className="size-10 rounded-xl bg-secondary/60 ring-1 ring-border flex items-center justify-center shrink-0">
                      <Icon className="size-4 text-foreground/80" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-display font-semibold text-sm">{label}</h4>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{blurb}</p>
                    </div>
                    <button
                      onClick={() => onRequest(id, label)}
                      disabled={isRequested}
                      className={`shrink-0 px-2.5 py-1.5 rounded-md text-[11px] font-medium ring-1 transition ${
                        isRequested
                          ? "ring-emerald-500/30 bg-emerald-500/10 text-emerald-400 cursor-default"
                          : "ring-border hover:bg-secondary text-foreground"
                      }`}
                    >
                      {isRequested ? (
                        <span className="inline-flex items-center gap-1">
                          <Check className="size-3" /> Requested
                        </span>
                      ) : (
                        "Request"
                      )}
                    </button>
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RequestConnection() {
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const list = loadRequests();
    const entry = reason.trim() ? `${name.trim()} — ${reason.trim()}` : name.trim();
    list.push(entry);
    saveRequests(list);
    setSubmitted(true);
    setName("");
    setReason("");
    setTimeout(() => setSubmitted(false), 2500);
  };

  return (
    <section className="glass-elevated rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <div className="size-10 rounded-xl bg-primary/15 ring-1 ring-primary/20 flex items-center justify-center shrink-0">
          <Sparkles className="size-4 text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="font-display font-semibold">Don't see your tool?</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Tell us what you'd like to connect. Requests feed our roadmap.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tool name (e.g. Notion, Front, Intercom)"
          maxLength={80}
          className="w-full bg-surface/40 ring-1 ring-border rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-primary"
        />
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="What would you use it for? (optional)"
          maxLength={300}
          rows={3}
          className="w-full bg-surface/40 ring-1 ring-border rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-primary resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          {submitted ? (
            <span className="text-xs text-emerald-400 inline-flex items-center gap-1">
              <CheckCircle2 className="size-3.5" /> Thanks — request logged.
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Stored locally for now.</span>
          )}
          <button
            type="submit"
            disabled={!name.trim()}
            className="px-3 py-2 rounded-md text-xs font-semibold bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Submit request
          </button>
        </div>
      </form>
    </section>
  );
}

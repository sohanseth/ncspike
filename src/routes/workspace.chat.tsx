import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send, Sparkles, Shield, Zap, Brain, Plus, MessageSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/workspace/chat")({
  component: ChatPage,
});

type Msg = { role: "user" | "assistant"; content: string };

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Flash", icon: Zap },
  { id: "google/gemini-2.5-pro", label: "Pro", icon: Brain },
  { id: "openai/gpt-5", label: "GPT-5", icon: Sparkles },
  { id: "google/gemini-2.5-flash-lite", label: "Private", icon: Shield },
] as const;

type Thread = { id: string; title: string; preview: string; when: string };

const recentThreads: Thread[] = [
  { id: "t1", title: "Partnership terms with Sarah", preview: "Let's restructure the 70/30…", when: "2h" },
  { id: "t2", title: "Q2 roadmap draft", preview: "Pull mid-market goals first…", when: "Yesterday" },
  { id: "t3", title: "Onboarding revamp", preview: "Marcus mentioned…", when: "Mon" },
];

function ChatPage() {
  const { session } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string>(MODELS[0].id);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const newChat = () => {
    setMessages([]);
    setThreadId(null);
    setErr(null);
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    if (!session) { setErr("Please sign in to chat."); return; }
    setInput("");
    setErr(null);
    const userMsg: Msg = { role: "user", content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setBusy(true);

    let assistantSoFar = "";
    const upsert = (chunk: string) => {
      assistantSoFar += chunk;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant") {
          return prev.map((m, i) => (i === prev.length - 1 ? { ...m, content: assistantSoFar } : m));
        }
        return [...prev, { role: "assistant", content: assistantSoFar }];
      });
    };

    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ messages: next, model, threadId }),
      });

      if (resp.status === 429) { setErr("Rate limit reached."); setBusy(false); return; }
      if (resp.status === 402) { setErr("AI credits exhausted."); setBusy(false); return; }
      if (!resp.ok || !resp.body) {
        const t = await resp.text().catch(() => "");
        setErr(`Chat failed (${resp.status}). ${t.slice(0, 140)}`);
        setBusy(false);
        return;
      }
      const tid = resp.headers.get("X-Thread-Id");
      if (tid && !threadId) setThreadId(tid);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let done = false;
      while (!done) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          let line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "" || !line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") { done = true; break; }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === "string") upsert(delta);
          } catch {
            buf = line + "\n" + buf;
            break;
          }
        }
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Chat failed");
    } finally {
      setBusy(false);
    }
  };

  const empty = messages.length === 0;

  return (
    <div className="flex-1 flex min-h-0">
      {/* Threads list */}
      <div className="w-[300px] shrink-0 border-r border-border flex flex-col">
        <div className="px-5 pt-6 pb-3 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
              Conversations
            </p>
            <h1 className="text-lg font-display font-semibold tracking-tight mt-0.5">Chat</h1>
          </div>
          <button
            onClick={newChat}
            title="New chat"
            className="size-8 rounded-lg bg-primary/15 text-primary ring-1 ring-primary/25 inline-flex items-center justify-center hover:bg-primary/25"
          >
            <Plus className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {recentThreads.map((t) => (
            <button
              key={t.id}
              className="w-full text-left px-3 py-3 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="flex items-center gap-2">
                <MessageSquare className="size-3.5 text-muted-foreground shrink-0" />
                <p className="text-sm font-medium truncate flex-1">{t.title}</p>
                <span className="text-[10px] font-mono text-muted-foreground">{t.when}</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1 truncate pl-5">
                {t.preview}
              </p>
            </button>
          ))}
        </div>
      </div>

      {/* Conversation pane */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {empty ? (
            <div className="h-full flex flex-col items-center justify-center px-6 max-w-2xl mx-auto text-center">
              <div className="size-14 rounded-2xl bg-gradient-to-br from-primary to-primary-glow inline-flex items-center justify-center ring-1 ring-white/10 shadow-[0_8px_32px_-8px_var(--primary)]">
                <Sparkles className="size-7 text-primary-foreground" />
              </div>
              <h2 className="mt-6 text-3xl font-display font-semibold tracking-tight">
                Ask <span className="text-gradient">anything</span>.
              </h2>
              <p className="text-sm text-muted-foreground mt-3 max-w-md">
                Grounded in your inbox, calendar, and memory graph.
              </p>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-8 py-10 space-y-6">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                      m.role === "user"
                        ? "bg-gradient-to-br from-primary to-primary-glow text-primary-foreground rounded-br-sm whitespace-pre-wrap ring-1 ring-white/10"
                        : "glass rounded-bl-sm prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-pre:my-2"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      m.content ? <ReactMarkdown>{m.content}</ReactMarkdown> : <span className="text-muted-foreground">…</span>
                    ) : (
                      m.content
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Composer (always visible) */}
        <form onSubmit={send} className="px-6 pb-6 pt-2">
          <div className="max-w-3xl mx-auto">
            {err && (
              <p className="mb-2 text-xs text-destructive bg-destructive/10 ring-1 ring-destructive/20 rounded px-3 py-2">
                {err}
              </p>
            )}
            <div className="rounded-2xl glass-elevated p-2 focus-within:ring-2 focus-within:ring-primary/40 transition-all">
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Message your assistant…"
                  className="flex-1 bg-transparent px-3 py-2.5 text-sm focus:outline-none"
                  autoFocus
                />
                <button
                  disabled={busy || !input.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-primary to-primary-glow text-primary-foreground px-4 py-2.5 text-sm font-semibold ring-1 ring-white/10 shadow-[0_4px_16px_-4px_var(--primary)] hover:opacity-95 disabled:opacity-50"
                >
                  <Send className="size-4" />
                </button>
              </div>
              <div className="flex items-center gap-1 px-1 pt-2 pb-1">
                {MODELS.map((m) => {
                  const Icon = m.icon;
                  const active = model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModel(m.id)}
                      className={`inline-flex items-center gap-1 px-2 h-6 rounded-md text-[10px] font-mono uppercase tracking-wider transition-colors ${
                        active
                          ? "bg-primary/15 text-primary ring-1 ring-primary/25"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Icon className="size-3" />
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

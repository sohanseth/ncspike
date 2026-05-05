import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send, Sparkles, Shield, Zap, Brain } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/workspace/chat")({
  component: ChatPage,
});

type Msg = { role: "user" | "assistant"; content: string };

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Flash", sub: "Fast", icon: Zap },
  { id: "google/gemini-2.5-pro", label: "Gemini Pro", sub: "Smart", icon: Brain },
  { id: "openai/gpt-5", label: "GPT-5", sub: "Powerful", icon: Sparkles },
  { id: "google/gemini-2.5-flash-lite", label: "Private", sub: "Lightweight", icon: Shield },
] as const;

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

      if (resp.status === 429) { setErr("Rate limit reached. Try again in a moment."); setBusy(false); return; }
      if (resp.status === 402) { setErr("AI credits exhausted. Add credits in Workspace settings."); setBusy(false); return; }
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
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-6 py-4 bg-background/80 backdrop-blur">
        <div className="max-w-3xl mx-auto flex flex-col items-center gap-3 text-center">
          <div>
            <h1 className="text-base font-semibold">Universal Chat</h1>
            <p className="text-xs text-muted-foreground">Grounded in your memory graph.</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Choose a model</p>
            <div className="inline-flex items-center gap-1 bg-secondary rounded-lg p-1 ring-1 ring-border">
              {MODELS.map((m) => {
                const Icon = m.icon;
                const active = model === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModel(m.id)}
                    title={m.sub}
                    className={[
                      "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                      active
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    <Icon className="size-3.5" />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </header>

      {/* Messages or empty state */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {empty ? (
          <div className="h-full flex flex-col items-center justify-center px-6">
            <div className="size-14 rounded-2xl bg-primary/10 text-primary inline-flex items-center justify-center">
              <Sparkles className="size-7" />
            </div>
            <h2 className="mt-5 text-2xl font-semibold tracking-tight">Ask anything.</h2>
            <p className="text-sm text-muted-foreground mt-2 max-w-md text-center">
              Once you connect Gmail and Calendar, every answer will be grounded in your real context.
            </p>
            <form onSubmit={send} className="mt-8 w-full max-w-2xl">
              <div className="flex gap-2 rounded-2xl ring-1 ring-border bg-surface p-2 shadow-soft focus-within:ring-2 focus-within:ring-primary">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Message your assistant…"
                  className="flex-1 bg-transparent px-3 py-2.5 text-sm focus:outline-none"
                  autoFocus
                />
                <button
                  disabled={busy || !input.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
                >
                  <Send className="size-4" />
                  Send
                </button>
              </div>
              {err && (
                <p className="mt-3 text-xs text-destructive bg-destructive/10 ring-1 ring-destructive/20 rounded px-3 py-2">
                  {err}
                </p>
              )}
            </form>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                    m.role === "user"
                      ? "bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap"
                      : "bg-surface ring-1 ring-border rounded-bl-sm prose prose-sm dark:prose-invert max-w-none prose-p:my-2 prose-pre:my-2"
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
            {err && (
              <p className="text-xs text-destructive bg-destructive/10 ring-1 ring-destructive/20 rounded px-3 py-2">
                {err}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Composer (only when messages exist) */}
      {!empty && (
        <form onSubmit={send} className="border-t border-border p-4 bg-background">
          <div className="max-w-3xl mx-auto flex gap-2 rounded-2xl ring-1 ring-border bg-surface p-2 focus-within:ring-2 focus-within:ring-primary">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message your assistant…"
              className="flex-1 bg-transparent px-3 py-2.5 text-sm focus:outline-none"
            />
            <button
              disabled={busy || !input.trim()}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
            >
              <Send className="size-4" />
              Send
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

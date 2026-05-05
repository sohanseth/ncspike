import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send, Sparkles, Shield, Zap } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/workspace/chat")({
  component: ChatPage,
});

type Msg = { role: "user" | "assistant"; content: string };

const MODELS = [
  { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash", tier: "fast", icon: Zap },
  { id: "openai/gpt-5", label: "GPT-5", tier: "smart", icon: Sparkles },
  { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "smart", icon: Sparkles },
  { id: "google/gemini-2.5-flash-lite", label: "Gemini Lite (private)", tier: "private", icon: Shield },
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
    if (!text || busy || !session) return;
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
      if (!resp.ok || !resp.body) { setErr("Chat failed. Please try again."); setBusy(false); return; }

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

  return (
    <div className="flex flex-col h-screen">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between bg-background/80 backdrop-blur">
        <div>
          <h1 className="text-base font-semibold">Universal Chat</h1>
          <p className="text-xs text-muted-foreground">
            Grounded in your memory graph. Switch models at any time.
          </p>
        </div>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="text-xs rounded-md ring-1 ring-border bg-surface px-2.5 py-1.5"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
        {messages.length === 0 && (
          <div className="max-w-md mx-auto text-center mt-12">
            <div className="size-10 rounded-xl bg-primary/10 text-primary inline-flex items-center justify-center">
              <Sparkles className="size-5" />
            </div>
            <h2 className="mt-3 text-lg font-semibold">Ask anything.</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Once you connect Gmail and Calendar, every answer will be grounded in your real context.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground rounded-br-sm"
                  : "bg-surface ring-1 ring-border rounded-bl-sm"
              }`}
            >
              {m.content || (busy && i === messages.length - 1 ? "…" : "")}
            </div>
          </div>
        ))}
        {err && (
          <p className="text-xs text-destructive bg-destructive/10 ring-1 ring-destructive/20 rounded px-3 py-2 max-w-md mx-auto">
            {err}
          </p>
        )}
      </div>

      <form onSubmit={send} className="border-t border-border p-4 flex gap-2 bg-background">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message your assistant…"
          className="flex-1 rounded-md ring-1 ring-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          disabled={busy || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60"
        >
          <Send className="size-4" />
          Send
        </button>
      </form>
    </div>
  );
}

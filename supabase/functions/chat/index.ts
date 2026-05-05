// Universal AI chat — proxies to Lovable AI Gateway with model selection.
// Supports Gemini, GPT, and (via OSS models) privacy-tier conversations.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `You are NeuralConnexions — a personal Chief of Staff and cognitive companion.
Your job is to absorb the noise (email, tasks, calendar, conversations) and surface only what matters.
You build a memory graph of the user's people, projects, preferences, and priorities, and use it to act on their behalf.
Be concise, calm, and proactive. Never lecture. When you don't know, say so and ask the smallest useful question.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const { messages, model, threadId } = await req.json();
    if (!Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "messages array required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const chosenModel = typeof model === "string" && model.length > 0
      ? model
      : "google/gemini-3-flash-preview";

    // Persist the user's latest message (and create thread if needed)
    let activeThreadId: string | null = threadId ?? null;
    const lastUser = [...messages].reverse().find((m: { role: string }) => m.role === "user");

    if (!activeThreadId && lastUser) {
      const title = String(lastUser.content || "New chat").slice(0, 60);
      const { data: t, error: tErr } = await supabase
        .from("chat_threads")
        .insert({ user_id: userId, title, model: chosenModel })
        .select("id")
        .single();
      if (tErr) console.error("thread create error", tErr);
      activeThreadId = t?.id ?? null;
    }

    if (activeThreadId && lastUser) {
      await supabase.from("chat_messages").insert({
        thread_id: activeThreadId,
        user_id: userId,
        role: "user",
        content: String(lastUser.content || ""),
      });
    }

    const upstream = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: chosenModel,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
          stream: true,
        }),
      },
    );

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit reached. Try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (upstream.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Add credits in Workspace settings." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const t = await upstream.text();
      console.error("AI gateway error", upstream.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Tee the upstream stream: forward to client AND collect for DB persistence
    const [clientStream, captureStream] = upstream.body!.tee();

    // Background: read captureStream, parse SSE deltas, save final assistant message
    (async () => {
      try {
        const reader = captureStream.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let assistantText = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            let line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta === "string") assistantText += delta;
            } catch {
              // partial json; ignore
            }
          }
        }
        if (activeThreadId && assistantText.length > 0) {
          await supabase.from("chat_messages").insert({
            thread_id: activeThreadId,
            user_id: userId,
            role: "assistant",
            content: assistantText,
            metadata: { model: chosenModel },
          });
          await supabase
            .from("chat_threads")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", activeThreadId);
        }
      } catch (e) {
        console.error("capture stream error", e);
      }
    })();

    const headers = new Headers({
      ...corsHeaders,
      "Content-Type": "text/event-stream",
    });
    if (activeThreadId) headers.set("X-Thread-Id", activeThreadId);
    headers.set("Access-Control-Expose-Headers", "X-Thread-Id");

    return new Response(clientStream, { headers });
  } catch (e) {
    console.error("chat error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

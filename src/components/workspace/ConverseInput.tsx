import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusPill } from "./StatusPill";
import { SpeakingOrb } from "./SpeakingOrb";
import { buildTriple } from "@/lib/voice-resolver";
import { readPreferLocalAudio } from "@/lib/voice-preferences";
import type { Badge } from "@/lib/voice-types";

export interface SendVoiceMessageResult {
  text: string;
  audioUrl?: string;
  /** Provider actually used by the chat chain, e.g. "anthropic" or "groq". */
  llmProvider?: string;
  /** Optional "anthropic→openai" annotation when the chain fell through. */
  llmFallback?: string;
}

export type SendVoiceMessage = (
  text: string,
  badge: Badge,
) => Promise<SendVoiceMessageResult>;

interface Props {
  badge: Badge;
  /**
   * Integration seam — wired to the real chat path at Phase 2.8 merge time.
   * Until then, this component runs against a stub.
   */
  sendVoiceMessage: SendVoiceMessage;
  className?: string;
}

/**
 * Standalone Converse input. Holds a mic button (push-to-talk), a text
 * field, and the per-turn status pill. Renders the live partial caption
 * strip above the input — never in the thread itself.
 *
 * IMPORTANT: this component does NOT touch MainApp.tsx or chat.functions.ts.
 * It is integrated by passing `sendVoiceMessage` from the parent panel.
 */
export function ConverseInput({ badge, sendVoiceMessage, className }: Props) {
  const [text, setText] = useState("");
  const [partial, setPartial] = useState("");
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [llmProvider, setLlmProvider] = useState<string | null>(null);
  const [llmFallback, setLlmFallback] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const preferLocal = readPreferLocalAudio();
  const triple = useMemo(
    () => buildTriple(badge, preferLocal, llmProvider),
    [badge, preferLocal, llmProvider],
  );

  // Push-to-talk on Space when the input is focused.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        setHolding(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setHolding(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const handleSubmit = useCallback(
    async (raw: string) => {
      const t = raw.trim();
      if (!t || busy) return;
      setBusy(true);
      setText("");
      setPartial("");
      try {
        const r = await sendVoiceMessage(t, badge);
        setLlmProvider(r.llmProvider ?? null);
        setLlmFallback(r.llmFallback ?? null);
        if (r.audioUrl) {
          const a = new Audio(r.audioUrl);
          audioRef.current = a;
          setSpeaking(true);
          a.onended = () => setSpeaking(false);
          void a.play().catch(() => setSpeaking(false));
        }
      } finally {
        setBusy(false);
      }
    },
    [badge, busy, sendVoiceMessage],
  );

  const handleInterrupt = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setSpeaking(false);
  }, []);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {partial && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm italic text-primary/80">
          {partial}
        </div>
      )}

      <div className="flex items-end gap-2">
        <SpeakingOrb speaking={speaking} onInterrupt={handleInterrupt} />

        <Button
          type="button"
          size="icon"
          variant={holding ? "default" : "outline"}
          aria-label={holding ? "Listening — release to send" : "Hold to talk"}
          aria-pressed={holding}
          onPointerDown={() => setHolding(true)}
          onPointerUp={() => setHolding(false)}
          onPointerLeave={() => holding && setHolding(false)}
          disabled={speaking || busy}
          className={cn(
            "shrink-0 transition",
            holding && "ring-2 ring-primary ring-offset-2 ring-offset-background",
          )}
        >
          <Mic className={cn("h-4 w-4", holding && "animate-pulse")} />
        </Button>

        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit(text);
            }
          }}
          placeholder={holding ? "Listening…" : "Message or hold mic to talk"}
          disabled={busy}
          className="flex-1 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/40"
        />

        <Button
          type="button"
          size="icon"
          onClick={() => void handleSubmit(text)}
          disabled={!text.trim() || busy}
          aria-label="Send"
          className="shrink-0"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <StatusPill triple={triple} llmFallback={llmFallback} />
        {preferLocal && (
          <span className="font-mono text-[10px] text-muted-foreground">prefer-local: ON</span>
        )}
      </div>
    </div>
  );
}

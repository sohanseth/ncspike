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
  llmProvider?: string;
  llmFallback?: string;
}

export type SendVoiceMessage = (
  text: string,
  badge: Badge,
) => Promise<SendVoiceMessageResult>;

interface Props {
  badge: Badge;
  sendVoiceMessage: SendVoiceMessage;
  className?: string;
}

// ---------- Web Speech API typings (minimal) ----------
type SRAlt = { transcript: string };
type SRRes = { isFinal: boolean; 0: SRAlt };
interface SREv extends Event {
  results: { length: number; [i: number]: SRRes };
  resultIndex: number;
}
interface SRLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREv) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}
type SRCtor = new () => SRLike;

function getSRCtor(): SRCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Standalone Converse input with live push-to-talk via the Web Speech API.
 * On Firefox / browsers without SpeechRecognition, the mic button is disabled
 * and a hint is shown — user can still type.
 */
export function ConverseInput({ badge, sendVoiceMessage, className }: Props) {
  const [text, setText] = useState("");
  const [partial, setPartial] = useState("");
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [llmProvider, setLlmProvider] = useState<string | null>(null);
  const [llmFallback, setLlmFallback] = useState<string | null>(null);
  const [srError, setSrError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<SRLike | null>(null);
  const finalTextRef = useRef<string>("");

  const srAvailable = useMemo(() => getSRCtor() !== null, []);
  const preferLocal = readPreferLocalAudio();
  const triple = useMemo(
    () => buildTriple(badge, preferLocal, llmProvider),
    [badge, preferLocal, llmProvider],
  );

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

  // Start/stop live SpeechRecognition based on `holding`.
  useEffect(() => {
    const Ctor = getSRCtor();
    if (!Ctor) return;

    if (holding && !recRef.current) {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      finalTextRef.current = "";
      setPartial("");
      setSrError(null);

      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalTextRef.current += r[0].transcript;
          else interim += r[0].transcript;
        }
        setPartial((finalTextRef.current + " " + interim).trim());
      };
      rec.onerror = (ev) => {
        const msg = (ev as unknown as { error?: string }).error ?? "speech error";
        setSrError(msg);
      };
      rec.onend = () => {
        recRef.current = null;
        const finalT = finalTextRef.current.trim();
        finalTextRef.current = "";
        if (finalT) void handleSubmit(finalT);
        else setPartial("");
      };

      try {
        rec.start();
        recRef.current = rec;
      } catch (err) {
        setSrError(String(err));
        recRef.current = null;
      }
    } else if (!holding && recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        /* ignore */
      }
    }
  }, [holding, handleSubmit]);

  // Push-to-talk on Space when not typing in the text field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        if (srAvailable) setHolding(true);
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
  }, [srAvailable]);

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
      {srError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          mic error: {srError}
        </div>
      )}

      <div className="flex items-end gap-2">
        <SpeakingOrb speaking={speaking} onInterrupt={handleInterrupt} />

        <Button
          type="button"
          size="icon"
          variant={holding ? "default" : "outline"}
          aria-label={
            !srAvailable
              ? "Voice input unavailable in this browser"
              : holding
                ? "Listening — release to send"
                : "Hold to talk"
          }
          aria-pressed={holding}
          onPointerDown={() => srAvailable && setHolding(true)}
          onPointerUp={() => setHolding(false)}
          onPointerLeave={() => holding && setHolding(false)}
          disabled={speaking || busy || !srAvailable}
          title={!srAvailable ? "Try Chrome or Safari for voice input" : undefined}
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
          placeholder={
            holding
              ? "Listening…"
              : srAvailable
                ? "Message or hold mic to talk"
                : "Message (voice input unavailable in this browser)"
          }
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

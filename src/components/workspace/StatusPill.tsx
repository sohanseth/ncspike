import { cn } from "@/lib/utils";
import type { ResolvedTriple } from "@/lib/voice-types";

interface Props {
  triple: ResolvedTriple;
  /** Optional fallback annotation, e.g. "anthropic→openai". */
  llmFallback?: string | null;
  className?: string;
}

const colorClass: Record<ResolvedTriple["privacyColor"], string> = {
  green: "text-emerald-300 border-emerald-400/30 bg-emerald-400/5",
  violet: "text-primary border-primary/30 bg-primary/5",
  amber: "text-amber-300 border-amber-400/30 bg-amber-400/5",
};

/**
 * Honest, per-turn (STT · LLM · TTS) provider pill. No marketing labels.
 * See spec §3 V3.
 */
export function StatusPill({ triple, llmFallback, className }: Props) {
  const llm = llmFallback ?? triple.llm;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] tracking-tight",
        colorClass[triple.privacyColor],
        className,
      )}
      aria-label={`Active providers: STT ${triple.stt}, LLM ${llm}, TTS ${triple.tts}`}
    >
      <span aria-hidden>🎙</span>
      <span>{triple.stt}</span>
      <span className="opacity-50">·</span>
      <span aria-hidden>🧠</span>
      <span>{llm}</span>
      <span className="opacity-50">·</span>
      <span aria-hidden>🔊</span>
      <span>{triple.tts}</span>
    </div>
  );
}

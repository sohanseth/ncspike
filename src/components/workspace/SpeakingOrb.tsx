import { cn } from "@/lib/utils";

interface Props {
  /** True while TTS audio is playing. */
  speaking: boolean;
  /** Tap-to-interrupt: stop TTS, unmute mic, start listening. */
  onInterrupt: () => void;
  className?: string;
}

/**
 * Animated waveform-y orb. Tap interrupts TTS. v1 = mic-muted-during-TTS;
 * this is the single affordance to break out of playback.
 */
export function SpeakingOrb({ speaking, onInterrupt, className }: Props) {
  return (
    <button
      type="button"
      onClick={speaking ? onInterrupt : undefined}
      aria-label={speaking ? "Tap to interrupt assistant" : "Assistant idle"}
      disabled={!speaking}
      className={cn(
        "relative h-8 w-8 rounded-full border border-primary/30 bg-primary/10 transition",
        speaking && "cursor-pointer hover:bg-primary/20",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-full bg-gradient-to-br from-primary/40 to-cyan-400/30",
          speaking ? "animate-pulse" : "opacity-30",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "absolute inset-1 rounded-full bg-background/40 backdrop-blur",
          speaking && "animate-[ping_1.4s_ease-out_infinite]",
        )}
      />
    </button>
  );
}

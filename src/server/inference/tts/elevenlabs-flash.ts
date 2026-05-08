import type { TtsAdapter } from "./types";

const DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"; // George — neutral, low-latency

/**
 * ElevenLabs Flash v2.5 — low-latency (~75ms TTFB) TTS. T2-ish (cloud).
 *
 * Used ONLY when the user has explicitly turned OFF "Prefer on-device audio".
 * Default is ON, so this adapter is opt-in. The audio Blob URL we return is
 * an in-memory ObjectURL — never uploaded, never persisted.
 */
export const elevenlabsFlash: TtsAdapter = {
  id: "elevenlabs-flash",
  privacyTier: "T2",
  requiresNetwork: true,
  async speak(text, opts) {
    const t0 = performance.now();
    const res = await fetch("/api/tts/elevenlabs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        voiceId: opts.voiceId ?? DEFAULT_VOICE,
        modelId: "eleven_turbo_v2_5",
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const blob = await res.blob();
    const audioUrl = URL.createObjectURL(blob);
    return {
      audioUrl,
      model: "eleven_turbo_v2_5",
      latencyMs: Math.round(performance.now() - t0),
      chars: text.length,
    };
  },
};

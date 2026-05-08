import type { SttAdapter } from "./types";

/**
 * Groq Whisper-large-v3-turbo. T2 (ZDR), ~$0.04/hr.
 *
 * Posts raw audio bytes to our own /api/stt/groq route, which proxies to
 * Groq. Bytes are NEVER persisted (no Supabase storage upload, no
 * chat_messages.audio_url, no localStorage/IndexedDB) — see
 * scripts/stt-no-persistence-guard.ts which fails CI if that changes.
 */
export const groqWhisper: SttAdapter = {
  id: "groq-whisper",
  privacyTier: "T2",
  requiresNetwork: true,
  async transcribe(audioBytes, opts) {
    const t0 = performance.now();
    const blob = new Blob([audioBytes as BlobPart], { type: "audio/webm" });
    const fd = new FormData();
    fd.append("audio", blob, "utt.webm");
    if (opts.languageCode) fd.append("language", opts.languageCode);

    const res = await fetch("/api/stt/groq", { method: "POST", body: fd });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Groq STT failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const json = (await res.json()) as { text?: string; model?: string };
    return {
      text: (json.text ?? "").trim(),
      model: json.model ?? "whisper-large-v3-turbo",
      latencyMs: Math.round(performance.now() - t0),
    };
  },
};

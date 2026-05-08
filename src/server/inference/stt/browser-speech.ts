import type { SttAdapter } from "./types";

/**
 * Safari/Chromium `SpeechRecognition` — on-device on Apple platforms. T0.
 *
 * Implementation note: the Web Speech API is *streaming-only* — it can't
 * accept a Uint8Array of pre-recorded audio. Our SttAdapter contract is
 * "bytes in, text out", so this adapter spins up a fresh `SpeechRecognition`
 * instance, plays the supplied audio bytes back through a hidden `<audio>`
 * captured into the recognizer's input, and resolves on `end`.
 *
 * In practice the live-mic path (V1 in the spec) bypasses this adapter and
 * subscribes to recognizer events directly for partials. This adapter is the
 * fallback wrapper when something upstream insists on the bytes-in shape.
 */
type SpeechRecognitionAlt = { transcript: string };
type SpeechRecognitionRes = {
  isFinal: boolean;
  0: SpeechRecognitionAlt;
};
interface SpeechRecognitionEv extends Event {
  results: { length: number; [i: number]: SpeechRecognitionRes };
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEv) => void) | null;
  onerror: ((e: Event) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isBrowserSpeechAvailable(): boolean {
  return getCtor() !== null;
}

export const browserSpeech: SttAdapter = {
  id: "browser-speech-recognition",
  privacyTier: "T0",
  requiresNetwork: false,
  async transcribe(audioBytes, opts) {
    const t0 = performance.now();
    const Ctor = getCtor();
    if (!Ctor) {
      throw new Error("SpeechRecognition unavailable in this browser");
    }

    // Best-effort bytes-in-text-out: play the audio through the page so the
    // recognizer's mic input picks it up. Requires a user gesture to have
    // already unlocked playback. The live-mic path is preferred — see V1.
    const blob = new Blob([audioBytes as BlobPart], { type: "audio/webm" });
    const url = URL.createObjectURL(blob);

    try {
      return await new Promise<{ text: string; model: string; latencyMs: number }>((resolve, reject) => {
        const rec = new Ctor();
        rec.lang = (opts.languageCode ?? "en").slice(0, 2);
        rec.interimResults = false;
        rec.continuous = false;

        const transcript: string[] = [];
        rec.onresult = (e) => {
          for (let i = 0; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) transcript.push(r[0].transcript);
          }
        };
        rec.onerror = (e) => reject(new Error((e as ErrorEvent).message ?? "speech recognition error"));
        rec.onend = () =>
          resolve({
            text: transcript.join(" ").trim(),
            model: "webkit-speech-recognition",
            latencyMs: Math.round(performance.now() - t0),
          });

        const audio = new Audio(url);
        audio.onended = () => rec.stop();
        rec.start();
        void audio.play().catch((err) => reject(err));
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  },
};

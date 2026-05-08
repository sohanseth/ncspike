import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  readPreferLocalAudio,
  setPreferLocalAudio,
  syncPreferLocalAudio,
} from "@/lib/voice-preferences";
import {
  probeLocalAudioCapability,
  isLocalAudioToggleAvailable,
  type ExtendedLocalAudioCapability,
} from "@/lib/voice-capability";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/workspace/voice-settings")({
  component: VoiceSettingsPage,
  head: () => ({
    meta: [
      { title: "Voice — Settings" },
      {
        name: "description",
        content:
          "Choose how voice transcription and speech synthesis run — on-device when possible, or cloud for premium quality.",
      },
    ],
  }),
});

function VoiceSettingsPage() {
  const { user, loading } = useAuth();
  const [preferLocal, setPreferLocal] = useState<boolean>(true);
  const [syncing, setSyncing] = useState(true);
  const [saving, setSaving] = useState(false);
  const [capability, setCapability] = useState<ExtendedLocalAudioCapability | null>(null);

  useEffect(() => {
    setPreferLocal(readPreferLocalAudio());
    void probeLocalAudioCapability().then(setCapability);
    if (!user) return;
    void (async () => {
      setSyncing(true);
      const v = await syncPreferLocalAudio(user.id);
      setPreferLocal(v);
      setSyncing(false);
    })();
  }, [user]);

  const toggleAvailable = isLocalAudioToggleAvailable(capability);

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    const next = !preferLocal;
    setPreferLocal(next);
    try {
      await setPreferLocalAudio(user.id, next);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl">Voice</h1>
            <p className="text-sm text-muted-foreground">
              Control where your voice is processed.
            </p>
          </div>
          <Link to="/workspace" className="text-sm text-primary hover:underline">
            ← Back
          </Link>
        </header>

        <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="font-display text-lg">Prefer on-device audio</div>
              <p className="text-sm text-muted-foreground">
                When on, transcription and speech synthesis use models running
                locally in your browser (Whisper + Piper, WASM). Slower on
                first load, but your voice never leaves the device. When off,
                we use cloud providers (Groq, ElevenLabs) — faster and
                higher-fidelity, but your audio is sent to a third party for
                processing. PRIVATE-tier turns always stay local regardless.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={preferLocal}
              onClick={toggle}
              disabled={syncing || saving}
              className={cn(
                "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border border-border transition-colors",
                preferLocal ? "bg-primary/80" : "bg-muted",
                (syncing || saving) && "opacity-60",
              )}
            >
              <span
                className={cn(
                  "inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform",
                  preferLocal ? "translate-x-6" : "translate-x-1",
                )}
              />
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card/40 p-5 backdrop-blur space-y-3">
          <h2 className="font-display text-lg">What this changes</h2>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              <span className="font-mono text-xs text-foreground">FLASH · PRO</span> —
              {" "}
              {preferLocal
                ? "Groq Whisper for STT, Piper WASM for TTS."
                : "Groq Whisper for STT, ElevenLabs Flash for TTS."}
            </li>
            <li>
              <span className="font-mono text-xs text-foreground">Genius</span> —
              {" "}
              {preferLocal
                ? "Groq Whisper for STT, Piper WASM for TTS."
                : "ElevenLabs Scribe for STT, ElevenLabs Multilingual for TTS."}
            </li>
            <li>
              <span className="font-mono text-xs text-foreground">PRIVATE</span> — Always Whisper.cpp + Piper, both running on-device.
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/**
 * Single source of truth for the "Prefer on-device audio" toggle.
 * Mirrors `user_settings.prefer_local_audio` to localStorage so the Converse
 * surface can read synchronously on mount.
 */
import { supabase } from "@/integrations/supabase/client";

const LS_KEY = "nc.preferLocalAudio.v1";

export function readPreferLocalAudio(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LS_KEY) === "1";
}

export function writePreferLocalAudioLocal(value: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LS_KEY, value ? "1" : "0");
}

export async function syncPreferLocalAudio(userId: string): Promise<boolean> {
  // @ts-expect-error — `prefer_local_audio` is added by the 2.8 migration but
  // not yet in the regenerated supabase types (per integration guardrail).
  const { data } = await supabase
    .from("user_settings")
    .select("prefer_local_audio")
    .eq("user_id", userId)
    .maybeSingle();
  const value = Boolean(data?.prefer_local_audio);
  writePreferLocalAudioLocal(value);
  return value;
}

export async function setPreferLocalAudio(userId: string, value: boolean): Promise<void> {
  writePreferLocalAudioLocal(value);
  // @ts-expect-error — see above.
  await supabase
    .from("user_settings")
    .update({ prefer_local_audio: value })
    .eq("user_id", userId);
}

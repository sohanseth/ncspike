// Reading messages and letters on the iPhone, with the app's native plugins (phone/ios): FoundItems (Apple's
// model), LetterText (a photo's words) and SharedInbox (what other apps shared to the app). It all runs on the
// phone and sends nothing anywhere. On the web, or in a build without the plugins, the reader uses its rules and
// there's nothing shared to read.
import { findInMessage, type Found, type ModelCall, type Raw } from "./family-engine";

export interface FoundItemsPlugin {
  status(): Promise<{ available: boolean; reason: string }>;
  find(o: { instructions: string; text: string }): Promise<{ items: Raw[] }>;
}
export interface LetterTextPlugin {
  read(o: { path: string }): Promise<{ text: string; lines: number }>;
}
export interface SharedItem {
  id: string;
  capturedAt: string;
  kind: "text" | "image";
  text?: string;
  path?: string;
}
export interface SharedInboxPlugin {
  list(): Promise<{ items: SharedItem[] }>;
  remove(o: { ids: string[] }): Promise<{ removed: number }>;
}
export interface NativePlugins {
  FoundItems?: FoundItemsPlugin;
  LetterText?: LetterTextPlugin;
  SharedInbox?: SharedInboxPlugin;
}

/** The plugins this build has, when it runs in the iPhone app; none on the web. */
export async function nativePlugins(): Promise<NativePlugins> {
  try {
    const { Capacitor, registerPlugin } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return {};
    const get = <T>(name: string): T | undefined =>
      Capacitor.isPluginAvailable(name) ? registerPlugin<T>(name) : undefined;
    return {
      FoundItems: get<FoundItemsPlugin>("FoundItems"),
      LetterText: get<LetterTextPlugin>("LetterText"),
      SharedInbox: get<SharedInboxPlugin>("SharedInbox"),
    };
  } catch {
    return {};
  }
}

/** Apple's model for the reader, or null and why not, in words a parent can read. */
export async function appleModel(
  p: NativePlugins,
): Promise<{ model: ModelCall | null; reason: string }> {
  const plugin = p.FoundItems;
  if (!plugin)
    return { model: null, reason: "This version of the app doesn't have Apple's model yet." };
  try {
    const s = await plugin.status();
    if (!s.available)
      return { model: null, reason: s.reason || "Apple's model isn't available on this iPhone." };
  } catch {
    return { model: null, reason: "Apple's model didn't answer." };
  }
  return {
    model: async (text, instructions) => (await plugin.find({ instructions, text })).items || [],
    reason: "",
  };
}

/** Today on this phone, as the reader counts days (YYYY-MM-DD, local time, not UTC). */
export function todayHere(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface ReadOne {
  text: string;
  items: Found[];
  usedModel: boolean;
  error?: string;
}
export interface ReadShared extends ReadOne {
  id: string;
  kind: "text" | "image";
  capturedAt: string;
}
interface ReadOpts {
  today: string;
  children?: string[];
  model?: ModelCall | null;
}

/** A message the parent pasted or typed. */
export async function readText(text: string, o: ReadOpts): Promise<ReadOne> {
  const r = await findInMessage(text, {
    today: o.today,
    children: o.children || [],
    model: o.model || null,
  });
  return { text, items: r.items, usedModel: r.usedModel };
}

/** A photographed letter: its words first (on the phone), then what they ask. */
export async function readLetter(p: NativePlugins, path: string, o: ReadOpts): Promise<ReadOne> {
  if (!p.LetterText)
    return {
      text: "",
      items: [],
      usedModel: false,
      error: "This version of the app can't read photos yet.",
    };
  let text = "";
  try {
    text = (await p.LetterText.read({ path })).text || "";
  } catch {
    return {
      text: "",
      items: [],
      usedModel: false,
      error: "Couldn't read the words in that photo.",
    };
  }
  if (!text.trim())
    return { text, items: [], usedModel: false, error: "No words found in that photo." };
  return readText(text, o);
}

/** Everything shared to the app since it last looked, oldest first. Call forgetShared with the ids once what was
 *  found is kept, so the shared messages themselves don't stay on the phone. */
export async function readShared(p: NativePlugins, o: ReadOpts): Promise<ReadShared[]> {
  if (!p.SharedInbox) return [];
  let items: SharedItem[] = [];
  try {
    items = (await p.SharedInbox.list()).items || [];
  } catch {
    return [];
  }
  const out: ReadShared[] = [];
  for (const it of items) {
    const base = { id: it.id, kind: it.kind, capturedAt: it.capturedAt };
    const r =
      it.kind === "image"
        ? await readLetter(p, it.path || "", o)
        : await readText(it.text || "", o);
    out.push({ ...base, ...r });
  }
  return out;
}

export async function forgetShared(p: NativePlugins, ids: string[]): Promise<number> {
  if (!p.SharedInbox || !ids.length) return 0;
  try {
    return (await p.SharedInbox.remove({ ids })).removed;
  } catch {
    return 0;
  }
}

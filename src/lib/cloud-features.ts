/**
 * The single list of cloud features. The consent sheet, the Privacy page and
 * the Voice Drafts dialog show `words` exactly. Consent counts only for the
 * current `version`; bump it whenever the words change so people are asked
 * again. Browser-safe: no server imports.
 */
export const CLOUD_FEATURE_KEYS = [
  "cloud_chat",
  "voice_replies",
  "web_search",
  "email_on_server",
  "email_ai",
  "calendar_on_server",
  "nightly_traits",
  "overnight_research",
  "voice_input",
] as const;

export type CloudFeature = (typeof CLOUD_FEATURE_KEYS)[number];

export type CloudFeatureInfo = {
  title: string;
  words: string;
  version: string;
  showOnPrivacyPage: boolean;
};

export const CLOUD_FEATURES: Record<CloudFeature, CloudFeatureInfo> = {
  cloud_chat: {
    title: "Cloud chat (FLASH, PRO, Genius)",
    words:
      "Your message, the last 19 messages in the chat and a short personalization summary go to Groq, Google (Gemini), Cloudflare or Lovable's AI gateway for FLASH; to Anthropic, OpenAI, Groq or Lovable for PRO; and to OpenAI, Anthropic or Lovable for Genius. If one doesn't answer, the next gets the same text. Photos you attach, and pictures you ask for, go to Google's Gemini or to OpenAI through Lovable's AI gateway. If you have a trait sheet, Cloudflare also reads your message to pick matching personalization. These chats and photos are kept on our servers until you delete them or your account.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  voice_replies: {
    title: "Spoken replies by ElevenLabs",
    words:
      "The text of each reply (up to 5,000 characters) goes to ElevenLabs to be read aloud in a natural voice. Nothing is stored. Without this, your device's own voices read replies.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  web_search: {
    title: "Web search",
    words:
      "Your search words go to public SearXNG search servers (searx.be, search.inetol.net, priv.au), and the links you open are noted. Kept 30 days.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  email_on_server: {
    title: "Gmail on our server",
    words:
      "Your Google sign-in is stored encrypted on our servers. When you ask, we read the 10 newest emails in your inbox (sender, subject, date and a snippet) and store them. To learn your writing style we also read up to 200 sent emails and keep a short profile for 7 days; the emails aren't sent to any AI service.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  email_ai: {
    title: "AI help with email",
    words:
      "For a reply draft, the email's sender, subject and full text (up to 4,000 characters), your answers to the check-in questions, your free times when the email is about meeting up, and up to 8 phrases and 3 openers from your writing style go to Google's Gemini through Lovable's AI gateway, once to understand the email and once to write. For Context on this sender and Research overnight, up to 25 earlier subjects and snippets from that sender go there too. When the email sorter uses AI, the sender, subject and first 200 characters of each new email go there as well. Drafts are stored encrypted.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  calendar_on_server: {
    title: "Google Calendar on our server",
    words:
      "Your Google sign-in is stored encrypted on our servers. When you ask, we read your free and busy times, and we add events you choose, such as prep blocks.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  nightly_traits: {
    title: "Personalization from your email",
    words:
      "Each night, labels from up to 400 recent email subjects go to Cloudflare's AI to work out your interests and preferences, kept as your trait sheet.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  overnight_research: {
    title: "Research agents",
    words:
      "Each agent's topics, and a summary of your interests and preferences if you have a trait sheet, go to a search service (Tavily or public SearXNG servers) and to the FLASH AI services every time it runs. Findings are kept until you delete the agent.",
    version: "2026-10-17",
    showOnPrivacyPage: true,
  },
  voice_input: {
    title: "Speech to text by Groq",
    words: "Your recorded speech goes to Groq to be turned into text. Nothing is stored.",
    version: "2026-10-17",
    showOnPrivacyPage: false,
  },
};

export function isCloudFeature(v: unknown): v is CloudFeature {
  return typeof v === "string" && (CLOUD_FEATURE_KEYS as readonly string[]).includes(v);
}

/** What turning a feature off deletes (shown before confirming). */
export const CLOUD_FEATURE_OFF_DELETES: Record<CloudFeature, string> = {
  cloud_chat: "Private mode goes back on. Optionally, your cloud chats, their messages and photos are deleted.",
  voice_replies: "Nothing is stored, so nothing is deleted.",
  web_search: "Your saved search history.",
  email_on_server: "Your Gmail connection, the emails stored from Gmail, and your writing-style profile.",
  email_ai: "Your reply drafts and research tasks.",
  calendar_on_server: "Your Google Calendar connection.",
  nightly_traits: "Your trait sheet (your category blocks are kept).",
  overnight_research: "Your research agents are paused; their findings stay until you delete an agent.",
  voice_input: "Nothing is stored, so nothing is deleted.",
};

export const CLOUD_FEATURE_OFF_MESSAGE =
  "This uses a cloud service that's turned off. Turn it on in Privacy → Cloud features.";

/** Pure: is a feature on, given the person's newest consent row for it? */
export function isConsentCurrent(
  feature: CloudFeature,
  newest: { granted: boolean; wording_version: string } | null | undefined,
): boolean {
  return !!newest && newest.granted && newest.wording_version === CLOUD_FEATURES[feature].version;
}

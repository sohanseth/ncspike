/**
 * When does the Voice Drafts consent dialog show?
 *
 * Since private-by-default, the dialog is tied to the email_ai cloud
 * feature, not just to the older voice_drafts_consent_at timestamp: someone
 * who agreed to Voice Drafts before email_ai existed is asked once more,
 * because "I understand, enable" now also turns on AI help with email.
 */
export type VoiceDraftsConsentState = {
  /** voice_drafts_consent_at is set (the older Voice Drafts consent). */
  consented: boolean;
  /** The email_ai cloud feature is on (from getCloudFeatures). */
  emailAiOn: boolean;
};

export function voiceDraftsNeedsConsent(s: VoiceDraftsConsentState | null): boolean {
  // Unknown (still loading or unreachable) → ask, matching the previous
  // `status?.consented ?? false` behaviour.
  if (!s) return true;
  return !(s.consented && s.emailAiOn);
}

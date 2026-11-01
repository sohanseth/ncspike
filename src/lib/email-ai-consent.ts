/**
 * Gate an email-AI action (Context on this sender, Research overnight) on
 * the email_ai cloud feature. `ensure` opens the consent card when the
 * feature is off and resolves with the person's choice; the action only
 * runs after "Turn on".
 */
export async function withEmailAiConsent(
  ensure: () => Promise<boolean>,
  action: () => void | Promise<void>,
): Promise<boolean> {
  if (!(await ensure())) return false;
  await action();
  return true;
}

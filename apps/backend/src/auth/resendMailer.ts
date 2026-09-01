import { log, hashForLog } from '../logging.js';
import type { MailSender } from './magicLink.js';

/**
 * Production `MailSender` backed by [Resend](https://resend.com).
 *
 * Plain `fetch` against one REST endpoint rather than the `resend` SDK: the
 * whole integration is a POST with four fields, and a dependency that ships a
 * client, retry policy and type surface to save nine lines is a dependency to
 * patch forever. Same reasoning as the rest of this backend's HTTP calls.
 *
 * **Delivery is not confirmed by a 200 here.** Resend accepts the message and
 * delivers it asynchronously, so a success below means "handed over", not
 * "landed in the inbox". That is the honest boundary of what this function can
 * promise, and it is why the routes never tell a user their mail has arrived.
 */
const ENDPOINT = 'https://api.resend.com/emails';

/** Bounded so a hung provider cannot hold an auth request open indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000;

async function send(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // The body carries Resend's reason (unverified domain, invalid sender,
      // rate limit). Logged, never returned to the caller: the routes answer
      // identically whether or not an address exists, and a provider error
      // message would leak that distinction.
      const body = await res.text().catch(() => '');
      throw new Error(`resend rejected the message (HTTP ${res.status}): ${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A sender, or `null` when either half of the configuration is missing.
 *
 * Both values are required together on purpose. A key without a sender address
 * (or the reverse) is a half-configured deployment, and quietly sending from a
 * default address is worse than not sending: it fails Resend's domain check on
 * every message while looking configured.
 */
export function createResendMailSender(
  apiKey: string | undefined,
  from: string | undefined,
): MailSender | null {
  if (!apiKey || !from) return null;
  return {
    async sendMagicLink(to, token) {
      await send(
        apiKey,
        from,
        to,
        'Your Lilypad sign-in code',
        `Your Lilypad sign-in code is:\n\n${token}\n\n` +
          `Enter it in the app to finish signing in. It can be used once, and expires shortly.\n\n` +
          `If you did not ask to sign in, you can ignore this message — nothing has changed.`,
      );
      // Hashed rather than domain-only: a bare domain alone still names a
      // company outright for anyone off a shared provider (and this backend
      // has plenty of single-tenant domains), so it is not meaningfully
      // safer than the raw address for the person it identifies — it just
      // throws away the local part while keeping the part that most often
      // does the identifying. `to` itself is still used functionally above
      // (the actual send); only the LOGGING changes.
      log.server.info({ to: hashForLog(to) }, 'magic-link email handed to resend');
    },
    async sendPasswordReset(to, token) {
      await send(
        apiKey,
        from,
        to,
        'Reset your Lilypad password',
        `Your Lilypad password reset code is:\n\n${token}\n\n` +
          `Enter it in the app together with your new password. It can be used once, and expires shortly.\n\n` +
          `If you did not ask to reset your password, you can ignore this message — your password is unchanged.`,
      );
      // See the matching comment in `sendMagicLink` above for why this is
      // hashed rather than left raw or truncated to a domain.
      log.server.info({ to: hashForLog(to) }, 'password-reset email handed to resend');
    },
  };
}

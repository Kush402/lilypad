import { randomBytes } from 'node:crypto';
import { redisKeys } from '@lilypad/shared';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { log } from '../logging.js';

/**
 * Email magic link — the sign-in fallback for users who want neither Apple nor
 * Google, and the reason an outage at either provider is degraded service
 * rather than a total sign-in outage ([ADR-0001](../../../../docs/adr/0001-account-authentication.md)).
 *
 * The token is a single-use, 15-minute Redis entry, deliberately built on the
 * exact same primitive as a pairing token (`services/pairing.ts`): 24 bytes of
 * CSPRNG output, `GETDEL` on redemption so a replay finds nothing, and a TTL so
 * an unread email stops being a credential. It lives in Redis rather than
 * Postgres for that last reason — a sign-in token that survives a restart is a
 * longer window, not a feature.
 */

/** How long an emailed link stays usable. Long enough for an email to arrive
 * and be read on another device; short enough that a forwarded or archived
 * message is not a standing key. */
export const MAGIC_LINK_TTL_SECONDS = 15 * 60;

/** The slice of Redis this needs — injectable for tests, matching
 * `PairingRedis`. */
export interface MagicLinkRedis {
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/** Delivery seam. The production sender (SES/Resend/SMTP) is chosen with the
 * rest of the hosting in M13; until then only the dev sender exists, and
 * `createMailSender()` returns null in production so the route answers an
 * honest 503 instead of accepting sign-ins whose email never arrives. */
export interface MailSender {
  sendMagicLink(to: string, link: string, token: string): Promise<void>;
}

/** Dev sender: writes the link to the server log. Not a stub standing in for
 * a real sender — it is the intended developer experience, the same way the
 * QR pairing flow is driven from the terminal in headless runs. */
export const consoleMailSender: MailSender = {
  sendMagicLink(to, link, token) {
    log.server.info({ to, link, token }, 'magic-link sign-in (dev sender — no email was sent)');
    return Promise.resolve();
  },
};

export function createMailSender(): MailSender | null {
  return config.isDev ? consoleMailSender : null;
}

/** Mint a single-use sign-in token for an address. */
export async function createMagicLink(
  email: string,
  client: MagicLinkRedis = redis,
): Promise<{ token: string; link: string; expiresInSeconds: number }> {
  const token = randomBytes(24).toString('base64url');
  await client.set(
    redisKeys.magicLink(token),
    email.trim().toLowerCase(),
    'EX',
    MAGIC_LINK_TTL_SECONDS,
  );
  // Points at the API because there is no web dashboard or deep-link handler
  // yet; both land in M14, at which point only this line changes.
  const link = `${config.env.PUBLIC_BASE_URL}/auth/magic-link?token=${token}`;
  return { token, link, expiresInSeconds: MAGIC_LINK_TTL_SECONDS };
}

/** Burn a magic-link token and return the address it proves, or null if it is
 * unknown, already used, or expired. `GETDEL` makes single-use atomic — two
 * concurrent redemptions cannot both succeed. */
export async function redeemMagicLink(
  token: string,
  client: MagicLinkRedis = redis,
): Promise<string | null> {
  return client.getdel(redisKeys.magicLink(token));
}

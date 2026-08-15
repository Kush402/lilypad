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
  sendMagicLink(to: string, token: string): Promise<void>;
  /** Password recovery ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
   * Same delivery seam and the same production gap: until M13 provides a
   * sender, the route answers 503 rather than pretending. */
  sendPasswordReset(to: string, token: string): Promise<void>;
}

/** Dev sender: writes the sign-in code to the server log. Not a stub standing
 * in for a real sender — it is the intended developer experience, the same way
 * the QR pairing flow is driven from the terminal in headless runs. */
export const consoleMailSender: MailSender = {
  sendMagicLink(to, token) {
    log.server.info({ to, token }, 'magic-link sign-in (dev sender — no email was sent)');
    return Promise.resolve();
  },
  sendPasswordReset(to, token) {
    log.server.info({ to, token }, 'password reset (dev sender — no email was sent)');
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
): Promise<{ token: string; expiresInSeconds: number }> {
  const token = randomBytes(24).toString('base64url');
  await client.set(
    redisKeys.magicLink(token),
    email.trim().toLowerCase(),
    'EX',
    MAGIC_LINK_TTL_SECONDS,
  );
  // Deliberately a CODE and not a URL.
  //
  // This used to also build `${PUBLIC_BASE_URL}/auth/magic-link?token=…` and
  // hand it to the sender, deferring a landing page to M14. M14 was later split
  // into P1/P2/P4 and that page was never part of any of them, so the URL kept
  // being generated for a route that does not exist — following it returns a
  // raw Fastify 404, verified against the running server. Nothing could have
  // consumed it either: the app registers no URL scheme and no associated
  // domain, so there is no deep-link handler for it to reach.
  //
  // What the product actually asks for is the code: `SignInScreen` shows a
  // "Sign-in code" field and tells the user to paste it from the email. A
  // second, dead path next to the working one is worse than no second path.
  // If a landing page or deep link is ever built, a URL comes back here then.
  return { token, expiresInSeconds: MAGIC_LINK_TTL_SECONDS };
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

/**
 * Mint a single-use password-reset token
 * ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
 *
 * Identical machinery to a magic link — same entropy, same TTL, same `GETDEL`
 * single-use — under a **different Redis key**. That difference is the whole
 * point and not a naming preference: sharing one key space would make a reset
 * token redeemable at `/auth/magic-link/verify`, so a link mailed to prove
 * "you want a new password" would also silently be a full sign-in.
 */
export async function createPasswordReset(
  email: string,
  client: MagicLinkRedis = redis,
): Promise<{ token: string; expiresInSeconds: number }> {
  const token = randomBytes(24).toString('base64url');
  await client.set(
    redisKeys.passwordReset(token),
    email.trim().toLowerCase(),
    'EX',
    MAGIC_LINK_TTL_SECONDS,
  );
  return { token, expiresInSeconds: MAGIC_LINK_TTL_SECONDS };
}

/** Burn a password-reset token and return the address it authorizes a reset
 * for, or null if it is unknown, already used, or expired. */
export async function redeemPasswordReset(
  token: string,
  client: MagicLinkRedis = redis,
): Promise<string | null> {
  return client.getdel(redisKeys.passwordReset(token));
}

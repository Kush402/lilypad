/**
 * Who may reach a laptop from somewhere else (ADR-0016).
 *
 * Free is the laptop's own network, forever, and that half needs no code: a
 * LAN session's media never touches us, so there is nothing to meter and no
 * bill to avoid. This is the other half — the one thing a subscription buys,
 * checked in the one place a remote session is established.
 *
 * `users.tier` has existed since M8 and been read by nothing. It becomes
 * load-bearing here.
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { subscriptions, users } from '../db/schema.js';
import { config } from '../config.js';
import { entitlesRemoteAccess, type AppleEnvironment } from './subscription.js';

export type RemoteAccess =
  /** Reach it from anywhere. */
  | 'entitled'
  /** Free tier: the laptop's own network only. */
  | 'not_entitled'
  /** No such account. Distinct from `not_entitled` so a caller cannot answer
   * "upgrade to continue" to somebody whose account was deleted underneath
   * them, which is advice that cannot be followed. */
  | 'no_such_account';

/**
 * Whether this account may establish a remote session.
 *
 * Fails CLOSED on an unknown account and OPEN on nothing: an entitlement check
 * that guesses "yes" when it cannot answer is not a check. The caller decides
 * what to do with the answer, and today (see `ENFORCE_REMOTE_ENTITLEMENT`)
 * that is to record it and allow the session anyway.
 */
export async function remoteAccessFor(
  userId: string,
  database = defaultDb,
  now = Date.now(),
): Promise<RemoteAccess> {
  const rows = await database
    .select({ tier: users.tier, isBillingTester: users.isBillingTester })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const account = rows[0];
  if (account === undefined) return 'no_such_account';
  // The same evaluator the billing screen uses, so the two cannot disagree
  // about whether an account is entitled — and so that an expired
  // subscription stops entitling here too, notification or not (L-294).
  const [row] = await database
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.ownerUserId, userId))
    .limit(1);
  const entitled = entitlesRemoteAccess({
    manualTier: account.tier,
    subscription: row
      ? {
          environment: row.environment as AppleEnvironment,
          originalTransactionId: row.originalTransactionId,
          ownerUserId: row.ownerUserId,
          productId: row.productId,
          status: row.status as 'active' | 'grace' | 'expired' | 'revoked',
          expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
          graceExpiresAt: row.graceExpiresAt ? row.graceExpiresAt.getTime() : null,
          lastTransactionId: row.lastTransactionId,
          lastPurchaseDate: row.lastPurchaseDate ? row.lastPurchaseDate.getTime() : null,
          revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
        }
      : null,
    commercialEnvironment:
      config.env.APPLE_IAP_ENVIRONMENT === 'Production' ? 'Production' : 'Sandbox',
    isApprovedTester: account.isBillingTester,
    now,
  });
  return entitled ? 'entitled' : 'not_entitled';
}

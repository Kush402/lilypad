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
import { users } from '../db/schema.js';
import { subscriptionForOwner } from './subscriptionStore.js';
import { config } from '../config.js';
import {
  entitlesHostedAsk,
  entitlesRemoteAccess,
  type AppleEnvironment,
  type EntitlementInputs,
} from './subscription.js';

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
  const inputs = await entitlementInputsFor(userId, database, now);
  if (inputs === null) return 'no_such_account';
  return entitlesRemoteAccess(inputs) ? 'entitled' : 'not_entitled';
}

/**
 * Whether this account may run Ask on Lilypad's own System One account
 * (ADR-0020).
 *
 * Same shape, same failure mode, different product: fails CLOSED on an
 * unknown account, and — unlike remote access — the caller acts on the answer
 * today. There is no `ENFORCE_HOSTED_ASK` flag, because the architectural
 * reason remote entitlement cannot be enforced (every LAN session crosses
 * `/connect/request`) has no analogue here: nothing reaches this route unless
 * a person deliberately chose Lilypad's own account to run their task.
 */
export async function hostedAskAccessFor(
  userId: string,
  database = defaultDb,
  now = Date.now(),
): Promise<RemoteAccess> {
  const inputs = await entitlementInputsFor(userId, database, now);
  if (inputs === null) return 'no_such_account';
  return entitlesHostedAsk(inputs) ? 'entitled' : 'not_entitled';
}

/**
 * Everything the pure evaluator needs about one account, or null when there
 * is no such account.
 *
 * One reader, shared with the billing screen — including how it picks among
 * an account's subscriptions. A second hand-written copy of that mapping is
 * how the two answers start disagreeing (L-294, L-298, L-299).
 */
async function entitlementInputsFor(
  userId: string,
  database: typeof defaultDb,
  now: number,
): Promise<EntitlementInputs | null> {
  const rows = await database
    .select({
      tier: users.tier,
      tierExpiresAt: users.tierExpiresAt,
      isBillingTester: users.isBillingTester,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const account = rows[0];
  if (account === undefined) return null;
  const commercialEnvironment: AppleEnvironment =
    config.env.APPLE_IAP_ENVIRONMENT === 'Production' ? 'Production' : 'Sandbox';
  return {
    manualTier: account.tier,
    manualTierExpiresAt: account.tierExpiresAt?.getTime() ?? null,
    subscription: await subscriptionForOwner(database, userId, commercialEnvironment, now),
    commercialEnvironment,
    isApprovedTester: account.isBillingTester,
    now,
  };
}

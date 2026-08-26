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

/** Tiers that include reaching a laptop from another network. */
const REMOTE_TIERS = new Set(['pro', 'team']);

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
export async function remoteAccessFor(userId: string, database = defaultDb): Promise<RemoteAccess> {
  const rows = await database
    .select({ tier: users.tier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const tier = rows[0]?.tier;
  if (tier === undefined) return 'no_such_account';
  return REMOTE_TIERS.has(tier) ? 'entitled' : 'not_entitled';
}

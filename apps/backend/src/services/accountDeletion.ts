import { eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/client.js';
import { devices, users } from '../db/schema.js';

/**
 * Deleting an account, and everything the schema hangs off it.
 *
 * There is deliberately no soft-delete, no grace period and no tombstone row.
 * A user who asks to be deleted is asking for the data to stop existing, and
 * a `deleted_at` column would mean the opposite while looking like compliance.
 * What survives is the audit trail, anonymised by the schema's
 * `ON DELETE SET NULL` on `audit_logs.user_id` / `.device_id`, and it survives
 * only until the 2-day retention window closes it — see
 * `services/auditRetention.ts`. That is the whole retention story: nothing
 * else outlives the DELETE.
 *
 * The cascade does the work, and it is worth naming what it covers because
 * this function looks too small otherwise. `DELETE FROM users` removes:
 *
 *  - `oauth_identities` (CASCADE) — the Apple/Google links.
 *  - `refresh_tokens`   (CASCADE) — every account session, everywhere. This is
 *    what makes deletion take effect on other machines, not just this one.
 *  - `devices`          (CASCADE) — and with them:
 *      - `trusted_devices` (CASCADE from BOTH device columns) — every pair.
 *  - `sessions`         (SET NULL) — history rows keep their shape, lose the
 *    person.
 *  - `audit_logs`       (SET NULL) — as above.
 *
 * Access tokens are signed, not stored, so they cannot be deleted here. They
 * are closed by `auth/liveDevice.ts`, which refuses an actor whose account no
 * longer exists; that is what makes deletion immediate rather than
 * "immediate within ten minutes".
 */

/**
 * Whether the address a caller typed names the account they are signed in to.
 *
 * Compared case-insensitively and after trimming for the same reason
 * `AccountService` normalises on the way in: `users.email` is stored lowercase
 * and a keyboard that capitalises the first letter must not make an account
 * undeletable.
 */
export function confirmsDeletion(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/** The address on an account, or null if the id names nothing.
 *
 * Only the address, because only the address is needed before the delete:
 * `purgeAccount` returns the devices it actually removed, which is a better
 * list than one read a moment earlier could be. */
export async function accountEmail(userId: string, database = defaultDb): Promise<string | null> {
  const [account] = await database
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return account?.email ?? null;
}

/**
 * Delete the account. Returns the fingerprints of the devices that were
 * actually removed, or null if the account was already gone.
 *
 * Devices are deleted explicitly and first, inside the same transaction the
 * user row is deleted in, purely so the caller gets an authoritative list of
 * what to disconnect. The `ON DELETE CASCADE` would have removed them anyway;
 * what it would not have done is *tell us their fingerprints*, and a live
 * WebSocket room keyed on a fingerprint nobody can name any more would hang
 * around until the heartbeat reaper noticed.
 *
 * The transaction is what keeps "no orphans" structural rather than hopeful:
 * a failure between the two statements would otherwise leave an account with
 * its devices already gone.
 *
 * The already-deleted case needs no rollback, which is worth stating because
 * its absence looks like an omission: `devices.user_id` is a foreign key, so a
 * device cannot outlive its account. If the user row is missing, the device
 * delete above matched nothing, and there is nothing to undo.
 */
export async function purgeAccount(userId: string, database = defaultDb): Promise<string[] | null> {
  return database.transaction(async (tx) => {
    const removed = await tx
      .delete(devices)
      .where(eq(devices.userId, userId))
      .returning({ fingerprint: devices.fingerprint });
    const gone = await tx.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
    return gone.length > 0 ? removed.map((d) => d.fingerprint) : null;
  });
}

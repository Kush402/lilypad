/**
 * Persisting one verified subscription event (L-295).
 *
 * Separate from `appleBilling.ts` for one reason: the real-database ordering
 * test has to exercise *this*, not a copy of it. A concurrency fix that lives
 * in the service and a paraphrase of it that lives in the test would agree on
 * the day they were written and not afterwards.
 */
import { and, eq } from 'drizzle-orm';
import type { db as DefaultDb } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { reduce, type SubscriptionEvent, type SubscriptionState } from './subscription.js';

type Database = typeof DefaultDb;
type SubscriptionRow = typeof subscriptions.$inferSelect;

export function toState(row: SubscriptionRow): SubscriptionState {
  return {
    environment: row.environment as SubscriptionState['environment'],
    originalTransactionId: row.originalTransactionId,
    ownerUserId: row.ownerUserId,
    productId: row.productId,
    status: row.status as SubscriptionState['status'],
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    graceExpiresAt: row.graceExpiresAt ? row.graceExpiresAt.getTime() : null,
    lastTransactionId: row.lastTransactionId,
    lastPurchaseDate: row.lastPurchaseDate ? row.lastPurchaseDate.getTime() : null,
    revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
  };
}

export function toColumns(state: SubscriptionState) {
  return {
    environment: state.environment,
    originalTransactionId: state.originalTransactionId,
    ownerUserId: state.ownerUserId,
    productId: state.productId,
    status: state.status,
    expiresAt: state.expiresAt == null ? null : new Date(state.expiresAt),
    graceExpiresAt: state.graceExpiresAt == null ? null : new Date(state.graceExpiresAt),
    lastTransactionId: state.lastTransactionId,
    lastPurchaseDate: state.lastPurchaseDate == null ? null : new Date(state.lastPurchaseDate),
    revokedAt: state.revokedAt == null ? null : new Date(state.revokedAt),
    updatedAt: new Date(),
  };
}

/**
 * Read the subscription identity for update, apply one verified event, write
 * the result — inside one transaction.
 *
 * ### The lock, and the hole in the lock
 *
 * `SELECT … FOR UPDATE` serializes writers on a row that exists. It locks
 * nothing at all when the row does *not* exist yet, so several transactions
 * can each see "no subscription", each decide to insert, and all but one hit
 * the identity unique index. That is not hypothetical: a first purchase is
 * exactly when the phone's receipt and Apple's first notification arrive
 * together, and it is the moment this code is most likely to run twice at
 * once. **Found by the real-database test, not by reasoning** — eight
 * concurrent first-writes, seven unique violations.
 *
 * The unique index was doing its job; a duplicate row was never created. What
 * failed was the loser's request, which is a 500 on a purchase.
 *
 * So the insert tolerates the conflict and then re-reads. Under READ
 * COMMITTED, `ON CONFLICT DO NOTHING` waits for the other transaction to
 * commit, and the `SELECT … FOR UPDATE` that follows sees the row it wrote —
 * at which point this is the ordinary update path and the reducer's ordering
 * rules decide the outcome, exactly as they would have if the two had arrived
 * a second apart.
 */
export async function applySubscriptionEvent(
  database: Database,
  event: SubscriptionEvent,
  claimingUserId: string | null,
): Promise<{ state: SubscriptionState; conflict: boolean }> {
  return database.transaction(async (tx) => {
    const read = async () => {
      const [row] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.environment, event.environment),
            eq(subscriptions.originalTransactionId, event.originalTransactionId),
          ),
        )
        .limit(1)
        .for('update');
      return row;
    };

    let existing = await read();

    if (!existing) {
      const first = reduce(null, event, claimingUserId);
      await tx.insert(subscriptions).values(toColumns(first.state)).onConflictDoNothing();
      existing = await read();
      // Nobody raced us: the row we just wrote is the answer.
      if (!existing) return { state: first.state, conflict: false };
      // Somebody did. Fall through and treat their row as the previous state,
      // through the ordinary reducer path -- including when the winner wrote
      // the same transaction we are holding. That case is not a no-op: Apple's
      // notification and the phone's receipt name the SAME transaction, and
      // the notification creates the row unowned, so returning the winner's
      // row here dropped the buyer's claim and left them unentitled.
    }

    const previous = toState(existing);
    // One Apple subscription, one account. An attempt to claim a subscription
    // another account already owns is refused rather than reassigned.
    if (
      previous.ownerUserId != null &&
      claimingUserId != null &&
      previous.ownerUserId !== claimingUserId
    ) {
      return { state: previous, conflict: true };
    }

    const result = reduce(previous, event, claimingUserId);
    if (!result.changed) return { state: result.state, conflict: false };

    await tx
      .update(subscriptions)
      .set(toColumns(result.state))
      .where(eq(subscriptions.id, existing.id));
    return { state: result.state, conflict: false };
  });
}

/**
 * The subscription that decides what an account may do.
 *
 * `owner_user_id` is not unique and is not meant to be: a TestFlight tester who
 * later buys for real owns a Sandbox row and a Production row at once. Both
 * readers used to take `.limit(1)` with no ordering, which is a coin toss --
 * and losing it means the Sandbox row answers for the account, entitling
 * nothing, while the subscription they actually paid for sits unread.
 *
 * The rows per account are a handful, so they are ordered here rather than in
 * SQL: the environment this deployment sells in first, then the period that
 * ends last.
 */
export async function subscriptionForOwner(
  database: Database,
  userId: string,
  commercialEnvironment: SubscriptionState['environment'],
): Promise<SubscriptionState | null> {
  const rows = await database
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.ownerUserId, userId));
  if (rows.length === 0) return null;
  const states = rows.map(toState);
  if (states.length === 1) return states[0]!;
  return states.sort((a, b) => {
    const environment =
      Number(b.environment === commercialEnvironment) -
      Number(a.environment === commercialEnvironment);
    if (environment !== 0) return environment;
    return (b.expiresAt ?? -Infinity) - (a.expiresAt ?? -Infinity);
  })[0]!;
}

/**
 * What an Apple subscription *is*, kept apart from what an account may do
 * (L-294 – L-299).
 *
 * ### Why this file exists
 *
 * Everything Apple tells us used to be written straight onto `users.tier`,
 * and that one column was asked to be four different facts at once: who owns
 * a subscription, what period it is in, which environment it came from, and
 * what the account is entitled to right now. Collapsing them produced a set
 * of failures that all look different and are all the same mistake:
 *
 *   - an expired subscription stayed Pro forever if its EXPIRED notification
 *     never arrived, because entitlement was a stored word and not a
 *     question about the current period (L-294);
 *   - a verified *older* receipt, replayed after a renewal, set the account
 *     back to Free — nothing compared chronology (L-295);
 *   - expiry cleared `appleOriginalTransactionId`, which is the only way a
 *     later DID_RENEW can find the account, so renewing after an expiry
 *     silently went nowhere (L-296);
 *   - a Sandbox receipt granted exactly the same commercial tier as a
 *     production one, because the environment was verified and then thrown
 *     away (L-298);
 *   - an Apple purchase overwrote a manually-granted Team account with Pro,
 *     because one column cannot hold two grants (L-299).
 *
 * So: this module is a **pure reducer plus a pure evaluator**, with no
 * database and no clock of its own. Persistence and I/O live in
 * `appleBilling.ts`; what is decided is decided here, where it can be tested
 * exhaustively and where the ordering rules are written down once.
 *
 * ### The ordering rule, stated
 *
 * Events arrive out of order, duplicated, and occasionally about a
 * transaction that is not the newest one. Three rules, in this order:
 *
 *  1. **Identity.** A subscription is `(environment, originalTransactionId)`.
 *     Ownership of that identity belongs to an account and survives expiry —
 *     expiry changes access, not ownership.
 *  2. **Chronology.** State that describes the subscription *period* — which
 *     product, when it ends, whether it is active — is only advanced by an
 *     event at least as new as the last one applied. `purchaseDate` is the
 *     transaction's own clock; arrival time is not used, because arrival
 *     order is exactly what is unreliable.
 *  3. **Termination wins regardless of age.** A refund or a revocation
 *     concerns a specific transaction that may well be older than the newest
 *     one, and it is still true. So those are applied even when they arrive
 *     late — they are recorded against the transaction they name, and they
 *     end access without rewriting the period.
 *
 * Rule 3 is why "reject everything older" would be wrong, and rule 2 is why
 * "apply everything in arrival order" would be wrong. Both were tried by the
 * code this replaces, in different branches.
 */

/** Which Apple environment a receipt was verified against. Kept, not dropped:
 *  a Sandbox purchase is a test, and a test is not a commercial entitlement
 *  (L-298). */
export type AppleEnvironment = 'Production' | 'Sandbox';

/** Where a subscription is in its life. */
export type SubscriptionStatus =
  /** Inside a paid period that has not been revoked. */
  | 'active'
  /** Apple says billing failed and a grace period is running. Access is kept
   *  for exactly as long as Apple says, and no longer. */
  | 'grace'
  /** The period ended and no renewal has been seen. Ownership is retained. */
  | 'expired'
  /** The purchase was refunded or the entitlement revoked. Terminal until a
   *  genuinely newer transaction arrives. */
  | 'revoked';

/** The durable state of one subscription. Ownership included; entitlement
 *  deliberately not — that is derived, never stored. */
export interface SubscriptionState {
  environment: AppleEnvironment;
  originalTransactionId: string;
  /**
   * The Lilypad account this subscription belongs to. Survives expiry.
   *
   * `null` when Apple told us about a subscription before any client claimed
   * it — which happens, and used to be acknowledged and thrown away.
   */
  ownerUserId: string | null;
  productId: string;
  status: SubscriptionStatus;
  /** End of the current period, ms since epoch. `null` when Apple sent none. */
  expiresAt: number | null;
  /** End of an Apple-granted grace period, ms since epoch. */
  graceExpiresAt: number | null;
  /** The newest transaction applied to this subscription. */
  lastTransactionId: string | null;
  /** That transaction's own `purchaseDate`, which is the ordering clock. */
  lastPurchaseDate: number | null;
  /** When the subscription was refunded or revoked. */
  revokedAt: number | null;
}

/** One verified thing Apple told us, normalized away from the JWS shape. */
export interface SubscriptionEvent {
  environment: AppleEnvironment;
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  /** The transaction's own clock, ms since epoch. */
  purchaseDate: number;
  expiresAt: number | null;
  /** Set when this specific transaction was refunded or revoked. */
  revocationDate: number | null;
  /** What the notification said, when this came from one. A client-submitted
   *  receipt has no notification type, which is itself informative: it is a
   *  statement about a transaction, not about a lifecycle step. */
  notificationType?: string | null;
  /** Apple's grace-period expiry for a billing failure, ms since epoch. */
  graceExpiresAt?: number | null;
}

/** Notification types that end access for the transaction they name. */
const TERMINAL_TYPES = new Set(['EXPIRED', 'REVOKE', 'REFUND', 'GRACE_PERIOD_EXPIRED']);

/** Notification types that say billing failed but access continues for now. */
const GRACE_TYPES = new Set(['DID_FAIL_TO_RENEW']);

/** Why an event did not change anything. Returned rather than thrown: every
 *  one of these is a normal thing for Apple to send. */
export type IgnoredReason =
  /** Already applied — same transaction id as the last one. */
  | 'duplicate'
  /** An older transaction arriving after a newer one, with nothing terminal
   *  to say. Rule 2. */
  | 'stale'
  /** A different subscription identity. The caller looked up the wrong row. */
  | 'different_subscription';

export type ReduceResult =
  | { changed: true; state: SubscriptionState }
  | { changed: false; state: SubscriptionState; reason: IgnoredReason };

/** The state a first-ever event creates. */
function initial(event: SubscriptionEvent, ownerUserId: string | null): SubscriptionState {
  return {
    environment: event.environment,
    originalTransactionId: event.originalTransactionId,
    ownerUserId,
    productId: event.productId,
    status: statusFromEvent(event),
    expiresAt: event.expiresAt,
    graceExpiresAt: event.graceExpiresAt ?? null,
    lastTransactionId: event.transactionId,
    lastPurchaseDate: event.purchaseDate,
    revokedAt: event.revocationDate,
  };
}

function statusFromEvent(event: SubscriptionEvent): SubscriptionStatus {
  if (event.revocationDate != null) return 'revoked';
  const type = event.notificationType ?? null;
  if (type != null && TERMINAL_TYPES.has(type)) {
    return type === 'REFUND' || type === 'REVOKE' ? 'revoked' : 'expired';
  }
  if (type != null && GRACE_TYPES.has(type)) return 'grace';
  return 'active';
}

/**
 * Fold one verified event into the durable state.
 *
 * `previous` is `null` for a subscription identity never seen before, in
 * which case `ownerUserId` says whose it is — or `null`, for a notification
 * that arrived before any client claimed the purchase.
 *
 * For an existing *owned* subscription the owner is **not** taken from the
 * caller: ownership moves only through an explicit claim of an unowned row,
 * never as a side effect of a notification arriving while some other account
 * happens to be in scope.
 */
export function reduce(
  previous: SubscriptionState | null,
  event: SubscriptionEvent,
  ownerUserId: string | null,
): ReduceResult {
  if (previous == null) {
    return { changed: true, state: initial(event, ownerUserId) };
  }
  // An unowned row is claimed by the first account that presents a receipt
  // for it. An owned one is never reassigned here.
  const owner = previous.ownerUserId ?? ownerUserId;
  if (
    previous.originalTransactionId !== event.originalTransactionId ||
    previous.environment !== event.environment
  ) {
    return { changed: false, state: previous, reason: 'different_subscription' };
  }

  const terminal = event.revocationDate != null || TERMINAL_TYPES.has(event.notificationType ?? '');
  const sameTransaction = previous.lastTransactionId === event.transactionId;

  // Rule 3, checked before rule 2: a refund concerns the transaction it
  // names, and that transaction may legitimately be older than the newest one.
  if (terminal) {
    const next: SubscriptionState = {
      ...previous,
      ownerUserId: owner,
      status: statusFromEvent(event),
      // The period is not rewritten by a termination. Whatever Apple said
      // the period was, it still was; what changed is access.
      expiresAt: previous.expiresAt ?? event.expiresAt,
      graceExpiresAt: null,
      revokedAt: event.revocationDate ?? previous.revokedAt,
      // A late termination must not make an older transaction look newest,
      // or the next genuine renewal would be judged stale against it.
      lastTransactionId:
        event.purchaseDate >= (previous.lastPurchaseDate ?? -Infinity)
          ? event.transactionId
          : previous.lastTransactionId,
      lastPurchaseDate: Math.max(previous.lastPurchaseDate ?? -Infinity, event.purchaseDate),
    };
    return same(next, previous)
      ? { changed: false, state: previous, reason: 'duplicate' }
      : { changed: true, state: next };
  }

  // Rule 2. An older non-terminal event has nothing to add that the newer one
  // has not already said.
  if (previous.lastPurchaseDate != null && event.purchaseDate < previous.lastPurchaseDate) {
    return { changed: false, state: previous, reason: 'stale' };
  }

  // A transaction that has been refunded or has run out is not bought back by
  // restating it. Only a genuinely newer transaction revives a subscription,
  // which is the clause below that clears `revokedAt`.
  if (sameTransaction && previous.status !== 'active' && previous.status !== 'grace') {
    return { changed: false, state: previous, reason: 'duplicate' };
  }

  const next: SubscriptionState = {
    ...previous,
    ownerUserId: owner,
    productId: event.productId,
    status: statusFromEvent(event),
    expiresAt: event.expiresAt,
    graceExpiresAt: event.graceExpiresAt ?? null,
    lastTransactionId: event.transactionId,
    lastPurchaseDate: event.purchaseDate,
    // A genuinely newer paid transaction ends a revocation: the person bought
    // it again. Restating the terminated transaction itself does not, and does
    // not reach here.
    revokedAt: sameTransaction ? previous.revokedAt : null,
  };
  return same(next, previous)
    ? { changed: false, state: previous, reason: 'duplicate' }
    : { changed: true, state: next };
}

/**
 * Whether applying an event left the subscription exactly as it was.
 *
 * This is the duplicate test, and it is deliberately a comparison of outcomes
 * rather than a comparison of transaction ids. Keying on the id alone was
 * wrong in both directions, and both were shipped: it discarded a
 * `DID_FAIL_TO_RENEW` and a first client receipt because Apple names the
 * transaction already stored, and it accepted a refund as new because the
 * status happened to differ. What makes an event a duplicate is that it
 * changes nothing — so ask that.
 */
function same(a: SubscriptionState, b: SubscriptionState): boolean {
  return (
    a.ownerUserId === b.ownerUserId &&
    a.productId === b.productId &&
    a.status === b.status &&
    a.expiresAt === b.expiresAt &&
    a.graceExpiresAt === b.graceExpiresAt &&
    a.lastTransactionId === b.lastTransactionId &&
    a.lastPurchaseDate === b.lastPurchaseDate &&
    a.revokedAt === b.revokedAt
  );
}

// ── entitlement ──────────────────────────────────────────────────────────

/** The tiers Lilypad sells or grants. */
export type Tier = 'free' | 'pro' | 'team';

/** What a subscription grants right now, which is a question about the clock
 *  and never a stored word (L-294). */
export function subscriptionIsCurrent(state: SubscriptionState, now: number): boolean {
  if (state.status === 'revoked') return false;
  if (state.status === 'grace') {
    return state.graceExpiresAt != null && state.graceExpiresAt > now;
  }
  if (state.status === 'expired') return false;
  // 'active' still has to be inside its period. A missed EXPIRED notification
  // is the ordinary case, not an exotic one, and this is the line that stops
  // it from meaning forever.
  if (state.expiresAt == null) return false;
  return state.expiresAt > now;
}

export interface EntitlementInputs {
  /** The tier granted outside Apple — a Team plan, a manual comp. Apple
   *  lifecycle events never write this (L-299). */
  manualTier: Tier;
  /** The account's Apple subscription, if it has one. */
  subscription: SubscriptionState | null;
  /** Which environment counts as commercial here. A Sandbox subscription
   *  entitles nothing in Production unless this account is an approved
   *  tester (L-298). */
  commercialEnvironment: AppleEnvironment;
  /** Whether this account is allowed to be entitled by a test purchase. */
  isApprovedTester?: boolean;
  now: number;
}

/** Rank, so precedence is one comparison rather than a chain of ifs. */
const RANK: Record<Tier, number> = { free: 0, pro: 1, team: 2 };

/**
 * The tier this account actually has, from every source, with explicit
 * precedence: the highest grant wins.
 *
 * Team outranks Pro, so an Apple purchase on a Team account is recorded and
 * changes nothing about what they can do — and when the Team grant is later
 * removed, the Apple subscription is still there to fall back to, because it
 * was never overwritten.
 */
export function effectiveTier(inputs: EntitlementInputs): Tier {
  const { manualTier, subscription, commercialEnvironment, isApprovedTester, now } = inputs;
  let fromApple: Tier = 'free';
  if (subscription && subscriptionIsCurrent(subscription, now)) {
    const environmentCounts =
      subscription.environment === commercialEnvironment || isApprovedTester === true;
    if (environmentCounts) fromApple = 'pro';
  }
  return RANK[manualTier] >= RANK[fromApple] ? manualTier : fromApple;
}

/** Tiers that include reaching a laptop from another network. */
const REMOTE_TIERS = new Set<Tier>(['pro', 'team']);

/** One evaluator for both the billing screen and the remote-session check, so
 *  the two can never disagree (L-294). */
export function entitlesRemoteAccess(inputs: EntitlementInputs): boolean {
  return REMOTE_TIERS.has(effectiveTier(inputs));
}

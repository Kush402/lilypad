/**
 * The five wrong lifecycle outcomes the customer review reproduced, as
 * invariants (L-294 – L-299).
 *
 * Each `describe` below names the row it closes and states the behaviour the
 * shipped code had, so a future reader can tell what changed and why. These
 * are pure: no database, no clock, no Apple. The database ordering and the
 * signed-device recovery are separate gates and are not claimed here.
 */
import { describe, it, expect } from 'vitest';
import {
  reduce,
  effectiveTier,
  entitlesRemoteAccess,
  subscriptionIsCurrent,
  type SubscriptionEvent,
  type SubscriptionState,
} from './subscription.js';

const PRO = 'com.takedia.lilypad.pro.monthly';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00Z');

function event(over: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return {
    environment: 'Production',
    originalTransactionId: 'orig-1',
    transactionId: 'tx-1',
    productId: PRO,
    purchaseDate: T0,
    expiresAt: T0 + 30 * DAY,
    revocationDate: null,
    notificationType: null,
    ...over,
  };
}

/** The state after a first purchase, which is where every scenario starts. */
function purchased(owner = 'user-1'): SubscriptionState {
  const first = reduce(null, event(), owner);
  expect(first.changed).toBe(true);
  return first.state;
}

function inputs(over: Partial<Parameters<typeof effectiveTier>[0]> = {}) {
  return {
    manualTier: 'free' as const,
    subscription: null,
    commercialEnvironment: 'Production' as const,
    now: T0 + DAY,
    ...over,
  };
}

describe('an expired subscription stops entitling, notification or not (L-294)', () => {
  it('is not current once the period has passed', () => {
    const state = purchased();
    expect(subscriptionIsCurrent(state, T0 + DAY)).toBe(true);
    // The defect: `billingStatusFor` returned the stored tier and nothing
    // reconciled `subscriptionExpiresAt`, so an account whose EXPIRED
    // notification never arrived stayed Pro indefinitely.
    expect(subscriptionIsCurrent(state, T0 + 31 * DAY)).toBe(false);
    expect(effectiveTier(inputs({ subscription: state, now: T0 + 31 * DAY }))).toBe('free');
    expect(entitlesRemoteAccess(inputs({ subscription: state, now: T0 + 31 * DAY }))).toBe(false);
  });

  it('answers the billing screen and the session check identically', () => {
    const state = purchased();
    for (const now of [T0, T0 + 29 * DAY, T0 + 30 * DAY, T0 + 31 * DAY]) {
      const at = inputs({ subscription: state, now });
      expect(entitlesRemoteAccess(at)).toBe(effectiveTier(at) !== 'free');
    }
  });

  it('treats a subscription with no end date as not current rather than forever', () => {
    const odd = reduce(null, event({ expiresAt: null }), 'user-1').state;
    expect(subscriptionIsCurrent(odd, T0)).toBe(false);
  });

  it('keeps access for exactly as long as an Apple grace period says', () => {
    const state = purchased();
    const grace = reduce(
      state,
      event({
        transactionId: 'tx-2',
        purchaseDate: T0 + 30 * DAY,
        notificationType: 'DID_FAIL_TO_RENEW',
        expiresAt: T0 + 30 * DAY,
        graceExpiresAt: T0 + 36 * DAY,
      }),
      'user-1',
    );
    expect(grace.state.status).toBe('grace');
    expect(subscriptionIsCurrent(grace.state, T0 + 33 * DAY)).toBe(true);
    expect(subscriptionIsCurrent(grace.state, T0 + 37 * DAY)).toBe(false);
  });
});

describe('an older event cannot overwrite newer subscription truth (L-295)', () => {
  it('ignores a verified older receipt replayed after a renewal', () => {
    const first = purchased();
    const renewed = reduce(
      first,
      event({ transactionId: 'tx-2', purchaseDate: T0 + 30 * DAY, expiresAt: T0 + 60 * DAY }),
      'user-1',
    );
    expect(renewed.changed).toBe(true);

    // The defect: neither reducer compared chronology, so re-submitting the
    // first (now expired) receipt set a renewed subscription back to Free.
    const replay = reduce(renewed.state, event({ expiresAt: T0 + 30 * DAY }), 'user-1');
    expect(replay.changed).toBe(false);
    expect(replay.changed === false && replay.reason).toBe('stale');
    expect(replay.state.expiresAt).toBe(T0 + 60 * DAY);
    expect(subscriptionIsCurrent(replay.state, T0 + 45 * DAY)).toBe(true);
  });

  it('ignores an out-of-order EXPIRED for a period already renewed past', () => {
    const renewed = reduce(
      purchased(),
      event({ transactionId: 'tx-2', purchaseDate: T0 + 30 * DAY, expiresAt: T0 + 60 * DAY }),
      'user-1',
    ).state;
    // EXPIRED for the FIRST transaction, arriving late. It is terminal, so it
    // is recorded — but it must not make the account look unentitled during a
    // period that has since been paid for.
    const late = reduce(
      renewed,
      event({ transactionId: 'tx-1', purchaseDate: T0, notificationType: 'EXPIRED' }),
      'user-1',
    );
    expect(late.state.lastTransactionId).toBe('tx-2');
    expect(late.state.lastPurchaseDate).toBe(T0 + 30 * DAY);
    expect(late.state.expiresAt).toBe(T0 + 60 * DAY);
  });

  it('applies a refund that legitimately concerns an earlier transaction', () => {
    // The sibling risk the review names: "reject everything older" would be
    // wrong, because a refund is usually about a transaction that is not the
    // newest one, and it is still true.
    const renewed = reduce(
      purchased(),
      event({ transactionId: 'tx-2', purchaseDate: T0 + 30 * DAY, expiresAt: T0 + 60 * DAY }),
      'user-1',
    ).state;
    const refund = reduce(
      renewed,
      event({
        transactionId: 'tx-1',
        purchaseDate: T0,
        notificationType: 'REFUND',
        revocationDate: T0 + 40 * DAY,
      }),
      'user-1',
    );
    expect(refund.changed).toBe(true);
    expect(refund.state.status).toBe('revoked');
    expect(subscriptionIsCurrent(refund.state, T0 + 45 * DAY)).toBe(false);
  });

  it('applies the same event twice with no second effect', () => {
    const renewal = event({
      transactionId: 'tx-2',
      purchaseDate: T0 + 30 * DAY,
      expiresAt: T0 + 60 * DAY,
    });
    const once = reduce(purchased(), renewal, 'user-1').state;
    const twice = reduce(once, renewal, 'user-1');
    expect(twice.changed).toBe(false);
    expect(twice.changed === false && twice.reason).toBe('duplicate');
    expect(twice.state).toEqual(once);
  });

  it('refuses an event about a different subscription entirely', () => {
    const other = reduce(purchased(), event({ originalTransactionId: 'orig-2' }), 'user-1');
    expect(other.changed).toBe(false);
    expect(other.changed === false && other.reason).toBe('different_subscription');
  });
});

describe('expiry ends access, not ownership (L-296)', () => {
  it('keeps the account association through expiry so a renewal can find it', () => {
    const expired = reduce(
      purchased(),
      event({
        transactionId: 'tx-1',
        purchaseDate: T0,
        notificationType: 'EXPIRED',
        expiresAt: T0 + 30 * DAY,
      }),
      'user-1',
    ).state;
    expect(expired.status).toBe('expired');
    expect(subscriptionIsCurrent(expired, T0 + 31 * DAY)).toBe(false);
    // The defect: both terminal paths cleared `appleOriginalTransactionId`,
    // so the next DID_RENEW could not find the account and was acknowledged
    // as `unknown_account` — the renewal went nowhere.
    expect(expired.ownerUserId).toBe('user-1');
    expect(expired.originalTransactionId).toBe('orig-1');

    const renewed = reduce(
      expired,
      event({
        transactionId: 'tx-9',
        purchaseDate: T0 + 40 * DAY,
        expiresAt: T0 + 70 * DAY,
        notificationType: 'DID_RENEW',
      }),
      'user-1',
    );
    expect(renewed.changed).toBe(true);
    expect(renewed.state.status).toBe('active');
    expect(renewed.state.ownerUserId).toBe('user-1');
    expect(subscriptionIsCurrent(renewed.state, T0 + 45 * DAY)).toBe(true);
  });

  it('does not let a notification move a subscription to another account', () => {
    // Ownership changes by an explicit claim of an unowned row, never as a
    // side effect of an event arriving while some other account is in scope.
    const renewed = reduce(
      purchased('user-1'),
      event({ transactionId: 'tx-2', purchaseDate: T0 + 30 * DAY }),
      'user-2',
    );
    expect(renewed.state.ownerUserId).toBe('user-1');
  });

  it('keeps a notification that arrives before any client has claimed it', () => {
    // Observed in production: SUBSCRIBED arrived before association and was
    // acknowledged as `unknown_account` — and thrown away. The event is
    // authenticated; it is kept, unowned, and claimed by the first receipt.
    const orphan = reduce(null, event(), null);
    expect(orphan.changed).toBe(true);
    expect(orphan.state.ownerUserId).toBeNull();
    expect(subscriptionIsCurrent(orphan.state, T0 + DAY)).toBe(true);

    const claimed = reduce(
      orphan.state,
      event({ transactionId: 'tx-2', purchaseDate: T0 + DAY }),
      'user-1',
    );
    expect(claimed.state.ownerUserId).toBe('user-1');
  });

  it('buying again after a revocation restores access', () => {
    const revoked = reduce(
      purchased(),
      event({ notificationType: 'REVOKE', revocationDate: T0 + 5 * DAY }),
      'user-1',
    ).state;
    expect(subscriptionIsCurrent(revoked, T0 + 6 * DAY)).toBe(false);
    const again = reduce(
      revoked,
      event({ transactionId: 'tx-3', purchaseDate: T0 + 10 * DAY, expiresAt: T0 + 40 * DAY }),
      'user-1',
    );
    expect(again.state.status).toBe('active');
    expect(again.state.revokedAt).toBeNull();
    expect(subscriptionIsCurrent(again.state, T0 + 11 * DAY)).toBe(true);
  });
});

describe('a Sandbox purchase is a test, not a commercial entitlement (L-298)', () => {
  const sandbox = reduce(null, event({ environment: 'Sandbox' }), 'user-1').state;

  it('does not entitle an ordinary account on a Production server', () => {
    // The defect: the verifier fell back to Sandbox and then wrote the same
    // `users.tier`, so a Sandbox receipt bought ordinary production Pro.
    expect(effectiveTier(inputs({ subscription: sandbox }))).toBe('free');
    expect(entitlesRemoteAccess(inputs({ subscription: sandbox }))).toBe(false);
  });

  it('entitles an approved tester, so TestFlight stays usable', () => {
    expect(effectiveTier(inputs({ subscription: sandbox, isApprovedTester: true }))).toBe('pro');
  });

  it('entitles normally when the server itself is the Sandbox one', () => {
    expect(effectiveTier(inputs({ subscription: sandbox, commercialEnvironment: 'Sandbox' }))).toBe(
      'pro',
    );
  });

  it('keeps the environment on the state rather than discarding it', () => {
    expect(sandbox.environment).toBe('Sandbox');
    // And an event from the other environment is a different subscription,
    // even with the same original transaction id — identity is the pair.
    const collision = reduce(sandbox, event({ environment: 'Production' }), 'user-1');
    expect(collision.changed).toBe(false);
    expect(collision.changed === false && collision.reason).toBe('different_subscription');
  });
});

describe('an Apple subscription never overwrites a Team grant (L-299)', () => {
  it('leaves a Team account on Team through purchase and renewal', () => {
    const state = purchased();
    // The defect: the purchase and grant branches wrote `tier = 'pro'`
    // unconditionally, turning a Team account into a Pro one.
    expect(effectiveTier(inputs({ manualTier: 'team', subscription: state }))).toBe('team');
    const renewed = reduce(
      state,
      event({ transactionId: 'tx-2', purchaseDate: T0 + 30 * DAY, expiresAt: T0 + 60 * DAY }),
      'user-1',
    ).state;
    expect(effectiveTier(inputs({ manualTier: 'team', subscription: renewed }))).toBe('team');
  });

  it('leaves Team standing when the Apple subscription ends', () => {
    const revoked = reduce(
      purchased(),
      event({ notificationType: 'REFUND', revocationDate: T0 + 5 * DAY }),
      'user-1',
    ).state;
    expect(
      effectiveTier(inputs({ manualTier: 'team', subscription: revoked, now: T0 + 6 * DAY })),
    ).toBe('team');
  });

  it('falls back to the still-valid Apple subscription when Team is removed', () => {
    // The point of keeping the two apart: removing the Team grant must reveal
    // the subscription that was there all along, not leave the account free.
    const state = purchased();
    expect(effectiveTier(inputs({ manualTier: 'free', subscription: state }))).toBe('pro');
  });

  it('a manual Pro grant survives an expired Apple subscription', () => {
    const state = purchased();
    expect(
      effectiveTier(inputs({ manualTier: 'pro', subscription: state, now: T0 + 31 * DAY })),
    ).toBe('pro');
  });
});

describe('a termination is not a duplicate of the state it lands on', () => {
  /**
   * The duplicate guard on the terminal path asked "same transaction, and not
   * active?" — which is true of a refund that lands on a grace period for the
   * same transaction. Apple sends exactly that: DID_FAIL_TO_RENEW opens a
   * grace window on tx-1, and a refund of tx-1 follows. Treating the refund as
   * already-applied leaves paid access running for the rest of the window on a
   * purchase whose money has gone back.
   */
  it('applies a refund that lands on a grace period for the same transaction', () => {
    const grace = reduce(
      purchased(),
      event({ notificationType: 'DID_FAIL_TO_RENEW', graceExpiresAt: T0 + 45 * DAY }),
      'user-1',
    ).state;
    expect(grace.status).toBe('grace');
    expect(subscriptionIsCurrent(grace, T0 + 40 * DAY)).toBe(true);

    const refunded = reduce(
      grace,
      event({ notificationType: 'REFUND', revocationDate: T0 + 35 * DAY }),
      'user-1',
    );
    expect(refunded.changed).toBe(true);
    expect(refunded.state.status).toBe('revoked');
    expect(refunded.state.revokedAt).toBe(T0 + 35 * DAY);
    expect(subscriptionIsCurrent(refunded.state, T0 + 40 * DAY)).toBe(false);
  });

  /** Access was already gone, but whether the money came back is a different
   *  fact, and reconciliation reads it. */
  it('records a refund that follows an expiry of the same transaction', () => {
    const expired = reduce(purchased(), event({ notificationType: 'EXPIRED' }), 'user-1').state;
    expect(expired.status).toBe('expired');

    const refunded = reduce(
      expired,
      event({ notificationType: 'REFUND', revocationDate: T0 + 31 * DAY }),
      'user-1',
    );
    expect(refunded.state.status).toBe('revoked');
    expect(refunded.state.revokedAt).toBe(T0 + 31 * DAY);
  });

  /** The control: a genuine repeat of a termination still changes nothing, or
   *  the guard has simply been deleted rather than corrected. */
  it('still ignores the same termination delivered twice', () => {
    const revoke = event({ notificationType: 'REVOKE', revocationDate: T0 + 10 * DAY });
    const once = reduce(purchased(), revoke, 'user-1').state;
    const twice = reduce(once, revoke, 'user-1');
    expect(twice.changed).toBe(false);
    expect(twice.changed === false && twice.reason).toBe('duplicate');
    expect(twice.state).toEqual(once);
  });
});

describe('the claim happens on the transaction Apple actually names', () => {
  /**
   * The defect the first pass left behind, and the reason it survived: the
   * existing claim and grace tests both gave the second event a *different*
   * transaction id. Apple does not. `SUBSCRIBED` carries the transaction the
   * phone is holding a receipt for, so the client's submission names that same
   * transaction — and the duplicate guard keyed on transaction id alone threw
   * it away before the claim was applied. The subscription stayed unowned, so
   * the person who paid never became Pro. This is the ordinary path, not an
   * edge: it is what happens every time the notification wins the race.
   */
  it('claims an unowned subscription from a receipt for the same transaction', () => {
    const orphan = reduce(null, event(), null);
    expect(orphan.state.ownerUserId).toBeNull();

    const claimed = reduce(orphan.state, event(), 'user-1');
    expect(claimed.changed).toBe(true);
    expect(claimed.state.ownerUserId).toBe('user-1');
  });

  /** Apple sends DID_FAIL_TO_RENEW against the last successful transaction —
   *  the one already stored. Keyed on the id alone, grace was unreachable. */
  it('enters a grace period announced against the stored transaction', () => {
    const grace = reduce(
      purchased(),
      event({ notificationType: 'DID_FAIL_TO_RENEW', graceExpiresAt: T0 + 36 * DAY }),
      'user-1',
    );
    expect(grace.changed).toBe(true);
    expect(grace.state.status).toBe('grace');
    expect(subscriptionIsCurrent(grace.state, T0 + 33 * DAY)).toBe(true);
    expect(subscriptionIsCurrent(grace.state, T0 + 37 * DAY)).toBe(false);
  });

  /** The boundary this must not cross: a replayed receipt for a transaction
   *  that was refunded does not buy the subscription back. */
  it('does not let a replayed receipt undo a refund of that same transaction', () => {
    const revoked = reduce(
      purchased(),
      event({ notificationType: 'REVOKE', revocationDate: T0 + 5 * DAY }),
      'user-1',
    ).state;
    const replay = reduce(revoked, event(), 'user-1');
    expect(replay.changed).toBe(false);
    expect(replay.state.status).toBe('revoked');
    expect(subscriptionIsCurrent(replay.state, T0 + 6 * DAY)).toBe(false);
  });

  /** And an ordinary duplicate receipt is still a duplicate. */
  it('still ignores a receipt that repeats what is already stored', () => {
    const state = purchased();
    const again = reduce(state, event(), 'user-1');
    expect(again.changed).toBe(false);
    expect(again.changed === false && again.reason).toBe('duplicate');
    expect(again.state).toEqual(state);
  });
});
